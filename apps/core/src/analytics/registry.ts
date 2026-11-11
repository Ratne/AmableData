import { tenantSitesStub, type RegistryMessage } from '@amable/app-edge/analytics';
import type { Env } from '../env';
import { reportError } from '../platform/telemetry/reporter';
import type { RegistrationResult } from './registry-ops';
import { syncPorts } from './runtime';
import { applyBatch, FactBatch, type SyncPorts } from './sync';

const LINK_SOURCE = {
  identify: 'identify',
  payment: 'order',
  lead: 'api',
  sale: 'order',
} as const;

/**
 * Registers the contact data of one workspace's events (create/enrich
 * contacts, index their hashes), then links the visitors to the contacts on
 * their sites. A link that finds no visitor yet (registry ahead of the
 * analytics queue) is made later by the site's identity drain, which resolves
 * the same hashes through the index written here.
 */
export async function registerTenant(
  ports: SyncPorts,
  tenantId: string,
  entries: readonly RegistryMessage[],
): Promise<RegistrationResult[]> {
  const visitorIds = [
    ...new Set(entries.map((e) => e.visitorId).filter((v): v is string => v !== null)),
  ];
  const linked: Record<string, string> = {};
  if (visitorIds.length > 0) {
    for (const l of await tenantSitesStub(ports.ns, tenantId).contactsOfVisitors(visitorIds)) {
      linked[l.visitorId] = l.contactId;
    }
  }
  const results = await ports.crm<RegistrationResult[]>('analytics.registerIdentities', {
    entries,
    linked,
  });
  const byEid = new Map(results.map((r) => [r.eid, r]));
  const batch = new FactBatch();
  for (const e of entries) {
    const contactId = byEid.get(e.eid)?.contactId ?? null;
    if (contactId === null || e.visitorId === null) continue;
    batch.add(e.siteId, {
      kind: 'link',
      id: `reg:${e.eid}`,
      contactId,
      visitorId: e.visitorId,
      source: LINK_SOURCE[e.source],
      ts: e.ts,
    });
  }
  if (batch.size > 0) await applyBatch(ports, tenantId, batch);
  return results;
}

/** Consumer of the `registry` queue: one registration per workspace, retried as a whole. */
export async function consumeRegistry(
  batch: MessageBatch<RegistryMessage>,
  env: Env,
): Promise<void> {
  const ns = env.ANALYTICS;
  const byTenant = new Map<string, Array<Message<RegistryMessage>>>();
  for (const m of batch.messages) {
    if (m.body?.v !== 1 || typeof m.body.tenantId !== 'string') {
      m.ack();
      continue;
    }
    const list = byTenant.get(m.body.tenantId) ?? [];
    list.push(m);
    byTenant.set(m.body.tenantId, list);
  }
  for (const [tenantId, list] of byTenant) {
    try {
      if (ns === undefined) throw new Error('registry: no ANALYTICS binding');
      await registerTenant(
        syncPorts(env, ns, tenantId),
        tenantId,
        list.map((m) => m.body),
      );
      for (const m of list) m.ack();
    } catch (error) {
      for (const m of list) m.retry({ delaySeconds: 30 });
      await reportError(env, error, { source: 'queue', module: 'registry', route: null });
    }
  }
}
