import type { Env } from '../env';
import { saltDay } from './cookieless';
import type { EdgeSiteConfig } from './enrich';
import { siteStub, SITE_ID_RE } from './rpc';
import type { AnalyticsMessage, BotHit, EnrichedEvent } from './types';

// ------------------------------------------------------------- site config cache

const CONFIG_TTL_MS = 60_000;
const CONFIG_CACHE_MAX = 1000;
const configCache = new Map<string, { config: EdgeSiteConfig | null; expires: number }>();

/**
 * Site config for ingest, cached per isolate for 60 s (also negative results).
 * A cached entry is dropped when the UTC day — hence the cookieless salt — changes.
 */
export async function loadSiteConfig(
  env: Env,
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
export function writeEventPoint(env: Env, e: EnrichedEvent): void {
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

export function writeBotPoint(env: Env, hit: BotHit): void {
  writePoint(
    env,
    hit.site,
    ['bot', hit.path, '', '', '', '', '', '', hit.category, hit.name],
    [1, 0],
  );
}

// ------------------------------------------------------------- delivery

/** Groups messages per site and applies them to each site's AnalyticsDO. */
export async function deliverToSites(
  env: Env,
  messages: readonly AnalyticsMessage[],
): Promise<Map<string, Error | null>> {
  const bySite = new Map<string, { events: EnrichedEvent[]; bots: BotHit[] }>();
  for (const m of messages) {
    const site = m.kind === 'event' ? m.event.site : m.hit.site;
    let group = bySite.get(site);
    if (group === undefined) {
      group = { events: [], bots: [] };
      bySite.set(site, group);
    }
    if (m.kind === 'event') group.events.push(m.event);
    else group.bots.push(m.hit);
  }
  const outcome = new Map<string, Error | null>();
  await Promise.all(
    [...bySite].map(async ([site, group]) => {
      try {
        await siteStub(env.ANALYTICS, site).ingest(group.events, group.bots);
        outcome.set(site, null);
      } catch (error) {
        outcome.set(site, error instanceof Error ? error : new Error(String(error)));
      }
    }),
  );
  return outcome;
}

/** Counts in Analytics Engine, then queues for the DO (or writes it directly without a queue). */
export async function dispatch(env: Env, messages: readonly AnalyticsMessage[]): Promise<void> {
  if (messages.length === 0) return;
  for (const m of messages) {
    if (m.kind === 'event') writeEventPoint(env, m.event);
    else writeBotPoint(env, m.hit);
  }
  if (env.ANALYTICS_QUEUE !== undefined) {
    await env.ANALYTICS_QUEUE.sendBatch(
      messages.map((body) => ({ body, contentType: 'json' as const })),
    );
    return;
  }
  const outcome = await deliverToSites(env, messages);
  for (const error of outcome.values()) if (error !== null) throw error;
}

/** Queue consumer of `analytics`: one DO call per site, retry only the failed sites. */
export async function consumeAnalyticsBatch(
  batch: MessageBatch<AnalyticsMessage>,
  env: Env,
): Promise<void> {
  const outcome = await deliverToSites(
    env,
    batch.messages.map((m) => m.body),
  );
  for (const message of batch.messages) {
    const site = message.body.kind === 'event' ? message.body.event.site : message.body.hit.site;
    if (outcome.get(site) === null) message.ack();
    else message.retry({ delaySeconds: 10 });
  }
}
