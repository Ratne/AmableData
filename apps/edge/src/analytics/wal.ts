import { DEDUPE_HORIZON_MS } from './store/dedupe';
import { DAY_MS } from './time';
import type { AnalyticsMessage } from './types';

/**
 * Write-ahead log of the analytics pipeline on R2. Every batch is written here
 * BEFORE it is applied to the site DO and acked, so the archive is complete by
 * construction and doubles as the replay source.
 *
 * - `events/<siteId>/<YYYY-MM-DD>/<batchKey>.ndjson.gz`: the continuous cold
 *   archive (UTC day of the event). `batchKey` is derived from the queue
 *   message ids, so a retried batch rewrites the same object.
 * - `wal-pending/<siteId>/<batchKey>.ndjson.gz`: segments that could not be
 *   applied (producer fallback, DLQ); the replay cron applies and deletes them.
 * - `wal-stale/…`: pending segments older than {@link REPLAY_HORIZON_MS}. The DO
 *   no longer remembers their ids, so they are never replayed blindly: they
 *   wait for a reconciliation decision (DLQ page).
 * - `corrections/<siteId>/<YYYY-MM-DD>/<batchKey>.ndjson.gz`: events older than
 *   the hot window (age barrier): archived, never applied to DO or rollups.
 *
 * The archive prefixes (`events/`, `corrections/`, `poison/`) never hold clear
 * PII: emails become SHA-256 hashes (still joinable), names and PII-looking
 * traits/params are dropped, stray addresses in strings are masked. Only the
 * short-lived operational segments (`wal-pending/`, `wal-stale/`) keep the full
 * events, because the DO needs them to apply; the bucket lifecycle expires them.
 */
export const WAL_PREFIX = 'events';
export const PENDING_PREFIX = 'wal-pending';
export const STALE_PREFIX = 'wal-stale';
export const CORRECTIONS_PREFIX = 'corrections';
export const POISON_PREFIX = 'poison';

/** Pending segments younger than this are replayed; a day of margin under the dedupe horizon. */
export const REPLAY_HORIZON_MS = DEDUPE_HORIZON_MS - DAY_MS;

export function siteOf(message: AnalyticsMessage): string {
  return message.kind === 'event' ? message.event.site : message.hit.site;
}

function tsOf(message: AnalyticsMessage): number {
  return message.kind === 'event' ? message.event.ts : message.hit.ts;
}

export function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Deterministic key of a set of messages (order-independent). */
export async function batchKey(ids: readonly string[]): Promise<string> {
  const data = new TextEncoder().encode([...ids].sort().join('\n'));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(digest.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function gzipLines(items: readonly unknown[]): Promise<Uint8Array> {
  const text = items.map((item) => JSON.stringify(item)).join('\n') + '\n';
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzipLines<T>(body: ArrayBuffer | Uint8Array): Promise<T[]> {
  const stream = new Blob([body]).stream().pipeThrough(new DecompressionStream('gzip'));
  const text = await new Response(stream).text();
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as T);
}

const PII_KEY = /mail|phone|tel|mobile|name|nome|address|indirizzo|birth|nascita/i;
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

async function hashPii(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value.trim().toLowerCase()),
  );
  return `sha256:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function withoutPiiKeys<T>(record: Record<string, T> | null): Record<string, T> | null {
  if (record === null) return null;
  return Object.fromEntries(Object.entries(record).filter(([k]) => !PII_KEY.test(k)));
}

/** The archived form of a message (see the module comment). */
export async function redactForArchive(message: AnalyticsMessage): Promise<AnalyticsMessage> {
  if (message.kind !== 'event') return message;
  const e = message.event;
  const identity =
    e.identity === null
      ? null
      : {
          ...e.identity,
          email: e.identity.email === null ? null : await hashPii(e.identity.email),
          name: null,
          traits: withoutPiiKeys(e.identity.traits),
        };
  const payment =
    e.payment === null
      ? null
      : { ...e.payment, email: e.payment.email === null ? null : await hashPii(e.payment.email) };
  const event = { ...e, identity, payment, data: withoutPiiKeys(e.data), ipUa: null };
  return JSON.parse(
    JSON.stringify({ kind: 'event', event }).replace(EMAIL_IN_TEXT, '[email]'),
  ) as AnalyticsMessage;
}

export const GZIP_META = {
  httpMetadata: { contentType: 'application/x-ndjson', contentEncoding: 'gzip' },
} as const;

async function putDays(
  bucket: R2Bucket,
  prefix: string,
  siteId: string,
  messages: readonly AnalyticsMessage[],
  key: string,
): Promise<string[]> {
  const byDay = new Map<string, AnalyticsMessage[]>();
  for (const m of messages) {
    const day = utcDay(tsOf(m));
    const list = byDay.get(day);
    if (list === undefined) byDay.set(day, [m]);
    else list.push(m);
  }
  const keys: string[] = [];
  for (const [day, list] of byDay) {
    const objectKey = `${prefix}/${siteId}/${day}/${key}.ndjson.gz`;
    await bucket.put(
      objectKey,
      await gzipLines(await Promise.all(list.map(redactForArchive))),
      GZIP_META,
    );
    keys.push(objectKey);
  }
  return keys;
}

/** Archives one site's messages (one object per UTC day). Idempotent per `key`. */
export function writeWal(
  bucket: R2Bucket,
  siteId: string,
  messages: readonly AnalyticsMessage[],
  key: string,
): Promise<string[]> {
  return putDays(bucket, WAL_PREFIX, siteId, messages, key);
}

/** Ledgers: events refused by the age barrier (`corrections/`) or isolated because their apply threw (`poison/`). */
export function writeLedger(
  bucket: R2Bucket,
  prefix: typeof CORRECTIONS_PREFIX | typeof POISON_PREFIX,
  siteId: string,
  messages: readonly AnalyticsMessage[],
  key: string,
): Promise<string[]> {
  return putDays(bucket, prefix, siteId, messages, key);
}

export interface PendingSegment {
  /** When the segment was parked (replay horizon is measured from it). */
  parkedAt: number;
  reason: 'producer_fallback' | 'dlq';
  messages: AnalyticsMessage[];
}

/** Parks a site's messages for the replay cron (already archived by the caller). */
export async function writePending(
  bucket: R2Bucket,
  siteId: string,
  key: string,
  segment: PendingSegment,
): Promise<string> {
  const objectKey = `${PENDING_PREFIX}/${siteId}/${key}.ndjson.gz`;
  await bucket.put(objectKey, await gzipLines([segment]), {
    ...GZIP_META,
    customMetadata: { parkedAt: String(segment.parkedAt), reason: segment.reason },
  });
  return objectKey;
}

export async function readPending(
  bucket: R2Bucket,
  objectKey: string,
): Promise<PendingSegment | null> {
  const object = await bucket.get(objectKey);
  if (object === null) return null;
  const [segment] = await gunzipLines<PendingSegment>(await object.arrayBuffer());
  return segment ?? null;
}

/** Messages grouped per site, keeping the caller's handle on each (queue message, index). */
export function groupBySite<T>(
  items: readonly T[],
  body: (item: T) => AnalyticsMessage,
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const site = siteOf(body(item));
    const list = out.get(site);
    if (list === undefined) out.set(site, [item]);
    else list.push(item);
  }
  return out;
}
