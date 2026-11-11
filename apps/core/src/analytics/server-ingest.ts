import {
  deliverDirect,
  splitPii,
  suppressedAtEdge,
  type AnalyticsNamespace,
  type EdgeSiteConfig,
  type EnrichedEvent,
  type RegistryMessage,
} from '@amable/app-edge/analytics';
import type { Env } from '../env';
import { registerTenant } from './registry';
import { syncPorts } from './runtime';

/**
 * Server-side events ingested by the core (site-key API, `/v1`): the same
 * contract as the edge ingest — contact data split off to the registry, the
 * hashed events through the WAL (R2 archive → site DO, parked on R2 when the
 * DO fails). The events are applied first, so the registry links visitors the
 * site already knows.
 */
export async function ingestServerEvents(
  env: Env,
  ns: AnalyticsNamespace,
  config: EdgeSiteConfig,
  events: EnrichedEvent[],
): Promise<void> {
  const registry: RegistryMessage[] = [];
  const kept: EnrichedEvent[] = [];
  for (const e of events) {
    const r = splitPii(e, config.tenantId);
    if (suppressedAtEdge(config, e)) continue;
    kept.push(e);
    if (r !== null) registry.push(r);
  }
  if (kept.length === 0) return;
  await deliverDirect(
    { ANALYTICS: ns, FILES: env.FILES },
    kept.map((event) => ({ kind: 'event' as const, event })),
    Date.now(),
  );
  if (registry.length > 0)
    await registerTenant(syncPorts(env, ns, config.tenantId), config.tenantId, registry);
}
