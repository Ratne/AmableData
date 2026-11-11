import {
  normalizeEmailKey,
  normalizePhoneKey,
  sha256HexSync,
  siteStub,
  tenantSitesStub,
  type SuppressedKeyType,
} from '@amable/app-edge/analytics';
import type { SuppressionKind, SuppressionRow } from './suppression-ops';
import { emailHash, phoneHash } from '../crm/identity-hashes';
import type { SyncPorts } from './sync';

/**
 * Opt-out / erasure of a person from web tracking, across every site of the
 * workspace: the sites tombstone the visitors (given id, visitors linked to
 * the contact, carriers of the hashed identities) and, with `purge`, erase
 * their rows and rewrite their R2 objects. The workspace keeps the list so
 * sites created later and the registry honour it too.
 */

export interface SuppressRequest {
  visitorId?: string | undefined;
  contactId?: string | undefined;
  email?: string | undefined;
  phone?: string | undefined;
  purge: boolean;
  reason?: string | undefined;
  actorId: string | null;
}

export interface SuppressOutcome {
  sites: number;
  visitors: number;
  purge_jobs: number;
}

type Key = { type: SuppressedKeyType; hash: string };

const hashOf = (value: string | null) => (value === null ? null : sha256HexSync(value));

/**
 * Contacts the request designates: the given one, and those an email or
 * phone belongs to (registry hash index or the CRM's own fields).
 */
async function contactsOf(
  ports: SyncPorts,
  req: SuppressRequest,
  keys: readonly Key[],
): Promise<string[]> {
  const ids = new Set<string>(req.contactId === undefined ? [] : [req.contactId]);
  if (keys.length > 0) {
    for (const m of await ports.crm<Array<{ contactId: string }>>(
      'analytics.contactsByIdentityHash',
      {
        items: keys.map((k) => ({ kind: k.type, hash: k.hash })),
      },
    )) {
      ids.add(m.contactId);
    }
  }
  const email = req.email === undefined ? null : normalizeEmailKey(req.email);
  if (email !== null) {
    for (const m of await ports.crm<Array<{ contactId: string }>>('analytics.contactsByEmail', {
      emails: [email],
    })) {
      ids.add(m.contactId);
    }
  }
  return [...ids];
}

export async function suppressWorkspace(
  ports: SyncPorts,
  tenantId: string,
  req: SuppressRequest,
): Promise<SuppressOutcome> {
  const keys: Key[] = [];
  const add = (type: SuppressedKeyType, hash: string | null) => {
    if (hash !== null && !keys.some((k) => k.type === type && k.hash === hash))
      keys.push({ type, hash });
  };
  if (req.email !== undefined) add('email', hashOf(normalizeEmailKey(req.email)));
  if (req.phone !== undefined) add('phone', hashOf(normalizePhoneKey(req.phone)));

  const tenant = tenantSitesStub(ports.ns, tenantId);
  const bySite = new Map<string, Set<string>>();
  const contactIds = await contactsOf(ports, req, [...keys]);
  if (contactIds.length > 0) {
    // Every email and phone of the person, indexed or only on the contact (older data).
    for (const contactId of contactIds) {
      const hashes = await ports.crm<{ email: string[]; phone: string[] }>(
        'analytics.contactHashes',
        {
          contactId,
        },
      );
      for (const h of hashes.email) add('email', h);
      for (const h of hashes.phone) add('phone', h);
      for (const l of await tenant.visitorsOfContact(contactId)) {
        bySite.set(l.siteId, (bySite.get(l.siteId) ?? new Set()).add(l.visitorId));
      }
    }
    for (const c of await ports.crm<Array<{ emails: string[]; phones: string[] }>>(
      'analytics.contactIdentities',
      { ids: contactIds },
    )) {
      for (const e of c.emails) add('email', emailHash(e));
      for (const p of c.phones) add('phone', phoneHash(p));
    }
  }

  // The workspace list first: the registry stops linking the person even if a site fails below.
  const listed = (visitorIds: Iterable<string>) =>
    ports.crm('analytics.recordSuppressions', {
      entries: [
        ...keys.map((k) => ({ kind: k.type, value: k.hash })),
        ...[...visitorIds].map((v) => ({ kind: 'visitor' as const, value: v })),
      ] satisfies Array<{ kind: SuppressionKind; value: string }>,
      purge: req.purge,
      reason: req.reason ?? null,
      createdBy: req.actorId,
    });
  const known = new Set<string>(req.visitorId === undefined ? [] : [req.visitorId]);
  for (const ids of bySite.values()) for (const v of ids) known.add(v);
  await listed(known);

  const outcome: SuppressOutcome = { sites: 0, visitors: 0, purge_jobs: 0 };
  const visitors = new Set<string>();
  for (const siteId of await tenant.indexList()) {
    const ids = new Set(bySite.get(siteId) ?? []);
    if (req.visitorId !== undefined) ids.add(req.visitorId);
    const result = await siteStub(ports.ns, siteId).suppressVisitors({
      visitorIds: [...ids],
      keys,
      purge: req.purge,
    });
    if (result.visitorIds.length > 0) await tenant.unlinkVisitors(siteId, result.visitorIds);
    for (const v of result.visitorIds) visitors.add(v);
    outcome.sites += 1;
    if (result.jobId !== null) outcome.purge_jobs += 1;
  }
  outcome.visitors = visitors.size;
  // Carriers found by the sites (merged visitors, other devices) join the list.
  const found = [...visitors].filter((v) => !known.has(v));
  if (found.length > 0) await listed(found);
  return outcome;
}

/** Tombstones of the workspace for a site created after them (nothing to purge there). */
export async function seedSiteSuppressions(
  crm: <T>(op: string, input: unknown) => Promise<T>,
  ns: SyncPorts['ns'],
  siteId: string,
): Promise<void> {
  for (let offset = 0; ; offset += 1000) {
    const rows = await crm<SuppressionRow[]>('analytics.listSuppressions', { limit: 1000, offset });
    if (rows.length === 0) return;
    await siteStub(ns, siteId).suppressVisitors({
      visitorIds: rows.filter((r) => r.kind === 'visitor').map((r) => r.value),
      keys: rows
        .filter((r): r is SuppressionRow & { kind: SuppressedKeyType } => r.kind !== 'visitor')
        .map((r) => ({ type: r.kind, hash: r.value })),
      purge: false,
    });
    if (rows.length < 1000) return;
  }
}
