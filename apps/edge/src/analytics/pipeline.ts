import type { Env } from '../env';
import { saltDay } from './cookieless';
import type { EdgeSiteConfig } from './enrich';
import { siteStub, SITE_ID_RE } from './rpc';
import { reportEdgeError } from '../errors';
import { eventKey } from './store/dedupe';
import { DAY_MS } from './time';
import type { AnalyticsMessage, BotHit, EnrichedEvent } from './types';
import {
  batchKey,
  groupBySite,
  PENDING_PREFIX,
  readPending,
  REPLAY_HORIZON_MS,
  STALE_PREFIX,
  CORRECTIONS_PREFIX,
  POISON_PREFIX,
  writeLedger,
  writePending,
  writeWal,
} from './wal';
import { splitPii, suppressedAtEdge, type RegistryMessage } from './registry';

// ------------------------------------------------------------- site config cache

const CONFIG_TTL_MS = 60_000;
const CONFIG_CACHE_MAX = 1000;
const configCache = new Map<string, { config: EdgeSiteConfig | null; expires: number }>();

/**
 * Site config for ingest, cached per isolate for 60 s (also negative results).
 * A cached entry is dropped when the UTC day — hence the cookieless salt — changes.
 */
/** Bindings the direct ingest path needs (the core has them too). */
export type DirectIngestEnv = Pick<Env, 'ANALYTICS' | 'FILES'>;

export async function loadSiteConfig(
  env: DirectIngestEnv,
  siteId: string,
  now: number,
): Promise<EdgeSiteConfig | null> {
  if (!SITE_ID_RE.test(siteId)) return null;
  const hit = configCache.get(siteId);
  if (
    hit !== undefined &&
    hit.expires > now &&
    (hit.config === null || hit.config.salt.day === saltDay(now))
  ) {
    return hit.config;
  }
  const config = await siteStub(env.ANALYTICS, siteId).edgeConfig();
  if (configCache.size >= CONFIG_CACHE_MAX) {
    const oldest = configCache.keys().next();
    if (oldest.done !== true) configCache.delete(oldest.value);
  }
  configCache.set(siteId, { config, expires: now + CONFIG_TTL_MS });
  return config;
}

export function clearSiteConfigCache(): void {
  configCache.clear();
}

// ------------------------------------------------------------- Analytics Engine

/** In-memory counters used when the AE binding is absent (local dev, tests). */
export const localCounters = new Map<string, number>();

function writePoint(env: Env, siteId: string, blobs: string[], doubles: number[]): void {
  if (env.AE !== undefined) {
    env.AE.writeDataPoint({ indexes: [siteId], blobs, doubles });
    return;
  }
  const key = `${siteId}:${blobs[0] ?? ''}`;
  localCounters.set(key, (localCounters.get(key) ?? 0) + 1);
}

/**
 * Data point layout (dataset `amable_analytics`):
 * index = site id; blobs = type, path, channel, country, device, browser, os,
 * referrer host, goal name / bot category, visitor id; doubles = count, revenue (minor).
 */
function writeEventPoint(env: Env, e: EnrichedEvent): void {
  writePoint(
    env,
    e.site,
    [
      e.type,
      e.path ?? '',
      e.channel,
      e.geo.country ?? '',
      e.device ?? '',
      e.browser ?? '',
      e.os ?? '',
      e.referrerHost ?? '',
      e.name ?? '',
      e.vid,
    ],
    [1, e.payment !== null && !e.payment.refunded ? e.payment.amountMinor : 0],
  );
}

function writeBotPoint(env: Env, hit: BotHit): void {
  writePoint(
    env,
    hit.site,
    ['bot', hit.path, '', '', '', '', '', '', hit.category, hit.name],
    [1, 0],
  );
}

// ------------------------------------------------------------- delivery

/** Queue shards, chosen per site so one hot site never starves the others. */
function queueShards(env: Env): Queue<AnalyticsMessage>[] {
  return [
    env.ANALYTICS_QUEUE,
    env.ANALYTICS_QUEUE_1,
    env.ANALYTICS_QUEUE_2,
    env.ANALYTICS_QUEUE_3,
  ].filter((q): q is Queue<AnalyticsMessage> => q !== undefined);
}

export function shardIndex(siteId: string, shards: number): number {
  // Low bits: the high bits of FNV-1a barely depend on the trailing characters.
  return shards <= 1 ? 0 : Number.parseInt(eventKey(siteId).slice(-8), 16) % shards;
}

/**
 * Applies one site's messages in WAL order: archive on R2 first, then the age
 * barrier (events older than the hot window only go to the corrections
 * ledger), then the site DO (idempotent per event id). Throws when the DO
 * could not be reached; the caller retries or parks the segment.
 */
export async function applySite(
  env: DirectIngestEnv,
  siteId: string,
  messages: readonly AnalyticsMessage[],
  key: string,
  now: number,
): Promise<void> {
  let config: EdgeSiteConfig | null;
  try {
    config = await loadSiteConfig(env, siteId, now);
  } catch (error) {
    // The archive comes first: without the config (DO down) the batch is kept as is.
    if (env.FILES !== undefined) await writeWal(env.FILES, siteId, messages, key);
    throw error;
  }
  // Tombstoned visitors never reach the archive, even from queued or retried batches.
  const kept =
    config === null
      ? messages
      : messages.filter((m) => m.kind !== 'event' || !suppressedAtEdge(config, m.event));
  if (env.FILES !== undefined && kept.length > 0) await writeWal(env.FILES, siteId, kept, key);
  // Unknown or deleted site: archived, nothing to apply.
  if (config === null) return;
  // Cheap pre-filter; the DO applies the exact barrier (day-aligned, purge floor).
  const cutoff = config.retentionDays > 0 ? now - config.retentionDays * DAY_MS : -Infinity;
  const events: EnrichedEvent[] = [];
  const bots: BotHit[] = [];
  const late: AnalyticsMessage[] = [];
  for (const m of kept) {
    if (m.kind === 'bot') bots.push(m.hit);
    else if (m.event.ts < cutoff) late.push(m);
    else events.push(m.event);
  }
  let poison: AnalyticsMessage[] = [];
  if (events.length > 0 || bots.length > 0) {
    const result = await siteStub(env.ANALYTICS, siteId).ingest(events, bots);
    const lateIds = new Set(result.late);
    const poisonIds = new Set(result.poison);
    late.push(...kept.filter((m) => m.kind === 'event' && lateIds.has(m.event.eid)));
    poison = kept.filter((m) => m.kind === 'event' && poisonIds.has(m.event.eid));
  }
  if (env.FILES === undefined) return;
  if (late.length > 0) await writeLedger(env.FILES, CORRECTIONS_PREFIX, siteId, late, key);
  if (poison.length > 0) await writeLedger(env.FILES, POISON_PREFIX, siteId, poison, key);
}

/** Stable id of a message: the same events get the same WAL key in every path. */
export function eidOf(m: AnalyticsMessage): string {
  return m.kind === 'event'
    ? m.event.eid
    : `bot:${m.hit.id ?? `${m.hit.ts}:${m.hit.name}:${m.hit.path}`}`;
}

/**
 * Without a usable queue: WAL → DO directly; when the DO fails too the segment
 * is parked on R2 (`wal-pending/`) for the replay cron. Throws only when even
 * the WAL could not be written.
 */
export async function deliverDirect(
  env: DirectIngestEnv,
  messages: readonly AnalyticsMessage[],
  now: number,
): Promise<void> {
  for (const [siteId, list] of groupBySite(messages, (m) => m)) {
    const key = await batchKey(list.map(eidOf));
    try {
      await applySite(env, siteId, list, key, now);
    } catch (error) {
      if (env.FILES === undefined) throw error;
      await writePending(env.FILES, siteId, key, {
        parkedAt: now,
        reason: 'producer_fallback',
        messages: list,
      });
    }
  }
}

/**
 * Ingest of the events of one workspace's site: contact data is split off
 * first and sent to the registry queue (a failure there fails the request, the
 * client retries; the registry is idempotent per event id), then the hashed
 * events take the analytics path.
 */
export async function ingestMessages(
  env: Env,
  site: Pick<EdgeSiteConfig, 'tenantId' | 'suppressed'>,
  input: AnalyticsMessage[],
): Promise<void> {
  const registry: RegistryMessage[] = [];
  const messages: AnalyticsMessage[] = [];
  for (const m of input) {
    if (m.kind !== 'event') {
      messages.push(m);
      continue;
    }
    const r = splitPii(m.event, site.tenantId);
    // Tombstoned visitor or identity: neither archived nor registered.
    if (suppressedAtEdge(site, m.event)) continue;
    messages.push(m);
    if (r !== null) registry.push(r);
  }
  if (registry.length > 0) {
    if (env.REGISTRY_QUEUE === undefined)
      console.warn('analytics: no REGISTRY_QUEUE, contact data dropped');
    else
      await env.REGISTRY_QUEUE.sendBatch(
        registry.map((body) => ({ body, contentType: 'json' as const })),
      );
  }
  await dispatch(env, messages);
}

/** Counts in Analytics Engine, then queues for the DO (falls back to WAL → DO when the queue refuses). */
export async function dispatch(env: Env, messages: readonly AnalyticsMessage[]): Promise<void> {
  if (messages.length === 0) return;
  for (const m of messages) {
    if (m.kind === 'event') writeEventPoint(env, m.event);
    else writeBotPoint(env, m.hit);
  }
  const shards = queueShards(env);
  if (shards.length > 0) {
    const bySite = groupBySite(messages, (m) => m);
    const failed: AnalyticsMessage[] = [];
    for (const [siteId, list] of bySite) {
      const queue = shards[shardIndex(siteId, shards.length)];
      try {
        await queue?.sendBatch(list.map((body) => ({ body, contentType: 'json' as const })));
      } catch {
        failed.push(...list);
      }
    }
    if (failed.length === 0) return;
    await deliverDirect(env, failed, Date.now());
    return;
  }
  await deliverDirect(env, messages, Date.now());
}

/** Queue consumer of the `analytics` shards: WAL → DO per site, ack only what was applied. */
export async function consumeAnalyticsBatch(
  batch: MessageBatch<AnalyticsMessage>,
  env: Env,
): Promise<void> {
  const now = Date.now();
  await Promise.all(
    [...groupBySite(batch.messages, (m) => m.body)].map(async ([siteId, list]) => {
      try {
        const key = await batchKey(list.map((m) => eidOf(m.body)));
        await applySite(
          env,
          siteId,
          list.map((m) => m.body),
          key,
          now,
        );
        for (const m of list) m.ack();
      } catch {
        for (const m of list) m.retry({ delaySeconds: 10 });
      }
    }),
  );
}

/**
 * Consumer of `analytics-dlq` (messages that exhausted their retries): one more
 * WAL → DO attempt, else the segment is parked for the replay cron. Acked
 * either way once it is safe on R2.
 */
export async function consumeDeadLetters(
  batch: MessageBatch<AnalyticsMessage>,
  env: Env,
): Promise<void> {
  const now = Date.now();
  await Promise.all(
    [...groupBySite(batch.messages, (m) => m.body)].map(async ([siteId, list]) => {
      const bodies = list.map((m) => m.body);
      const key = await batchKey(bodies.map(eidOf));
      try {
        await applySite(env, siteId, bodies, key, now);
      } catch (applyError) {
        try {
          if (env.FILES === undefined) throw applyError;
          await writePending(env.FILES, siteId, key, {
            parkedAt: now,
            reason: 'dlq',
            messages: bodies,
          });
        } catch (error) {
          // Neither the DO nor R2: keep the messages in the DLQ (high max_retries) and alert.
          for (const m of list) m.retry({ delaySeconds: 300 });
          await reportEdgeError(env, error, { source: 'queue', module: 'analytics-dlq' });
          return;
        }
      }
      for (const m of list) m.ack();
    }),
  );
}

export interface ReplayResult {
  replayed: number;
  failed: number;
  stale: number;
}

/**
 * Replay cron: applies parked segments (`wal-pending/`) younger than the replay
 * horizon and deletes them; older ones move to `wal-stale/` for a manual
 * reconciliation decision, because the DO no longer remembers their ids.
 */
export async function replayPending(
  env: Env,
  now: number,
  opts: { pageSize?: number; budgetMs?: number; clock?: () => number } = {},
): Promise<ReplayResult> {
  const result: ReplayResult = { replayed: 0, failed: 0, stale: 0 };
  const bucket = env.FILES;
  if (bucket === undefined) return result;
  const clock = opts.clock ?? Date.now;
  const deadline = clock() + (opts.budgetMs ?? 20_000);
  // A site whose DO refuses once is skipped for the rest of the run, so its
  // backlog never starves the other sites.
  const failing = new Set<string>();
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({
      prefix: `${PENDING_PREFIX}/`,
      limit: opts.pageSize ?? 200,
      include: ['customMetadata'],
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const object of listed.objects) {
      if (clock() > deadline) return result;
      const [, siteId, file] = object.key.split('/');
      const key = file?.replace(/\.ndjson\.gz$/, '');
      if (siteId === undefined || key === undefined) continue;
      const parkedAt = Number(object.customMetadata?.['parkedAt'] ?? object.uploaded.getTime());
      if (now - parkedAt > REPLAY_HORIZON_MS) {
        const body = await bucket.get(object.key);
        if (body !== null) {
          await bucket.put(`${STALE_PREFIX}/${siteId}/${file}`, await body.arrayBuffer(), {
            httpMetadata: object.httpMetadata ?? {},
            customMetadata: object.customMetadata ?? {},
          });
        }
        await bucket.delete(object.key);
        result.stale += 1;
        continue;
      }
      if (failing.has(siteId)) continue;
      const segment = await readPending(bucket, object.key);
      if (segment === null) continue;
      try {
        await applySite(env, siteId, segment.messages, key, now);
        await bucket.delete(object.key);
        result.replayed += 1;
      } catch {
        failing.add(siteId);
        result.failed += 1;
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
  return result;
}
