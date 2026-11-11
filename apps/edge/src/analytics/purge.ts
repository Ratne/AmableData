import type { SqlDb } from './db/sql';
import { duePurgeJob, finishPurgePass, savePurgeJob, type PurgeJob } from './store/suppression';
import type { AnalyticsMessage } from './types';
import {
  CORRECTIONS_PREFIX,
  GZIP_META,
  gunzipLines,
  gzipLines,
  PENDING_PREFIX,
  POISON_PREFIX,
  STALE_PREFIX,
  WAL_PREFIX,
  type PendingSegment,
} from './wal';

/**
 * R2 side of a visitor purge: rewrites (or deletes) every object of the site
 * holding events or rows of the purged visitors. Day-partitioned prefixes are
 * scanned over the job's day range, the others whole; the tail rescans skip the
 * retention archive (its rows are written from the already erased DO). Progress (phase +
 * list cursor) is saved after every page, so the alarm resumes where it
 * stopped; a rewrite is idempotent, a page seen twice changes nothing.
 */

type Format = 'messages' | 'segment' | 'rows';
interface Phase {
  prefix: string;
  format: Format;
  dayRanged: boolean;
  /** Rescanned on the tail passes. */
  tail: boolean;
}

const PHASES: readonly Phase[] = [
  { prefix: WAL_PREFIX, format: 'messages', dayRanged: true, tail: true },
  { prefix: CORRECTIONS_PREFIX, format: 'messages', dayRanged: true, tail: true },
  { prefix: POISON_PREFIX, format: 'messages', dayRanged: true, tail: true },
  { prefix: PENDING_PREFIX, format: 'segment', dayRanged: false, tail: true },
  { prefix: STALE_PREFIX, format: 'segment', dayRanged: false, tail: true },
  { prefix: 'analytics-archive', format: 'rows', dayRanged: false, tail: false },
];

const PAGE = 100;

const hit = (m: AnalyticsMessage, vids: ReadonlySet<string>) =>
  m.kind === 'event' && vids.has(m.event.vid);

const ROW_VISITOR_FIELDS = ['visitor_id', 'child_visitor_id', 'origin_visitor_id'] as const;

type Rewritten = { body: string | Uint8Array; options: R2PutOptions } | 'delete' | null;

/** What the object becomes without the purged visitors; null when untouched. */
async function filtered(
  body: ArrayBuffer,
  key: string,
  format: Format,
  vids: ReadonlySet<string>,
): Promise<Rewritten> {
  if (format === 'messages') {
    const messages = await gunzipLines<AnalyticsMessage>(body);
    const kept = messages.filter((m) => !hit(m, vids));
    if (kept.length === messages.length) return null;
    return kept.length === 0 ? 'delete' : { body: await gzipLines(kept), options: GZIP_META };
  }
  if (format === 'segment') {
    const [segment] = await gunzipLines<PendingSegment>(body);
    if (segment === undefined) return null;
    const kept = segment.messages.filter((m) => !hit(m, vids));
    if (kept.length === segment.messages.length) return null;
    if (kept.length === 0) return 'delete';
    return {
      body: await gzipLines([{ ...segment, messages: kept }]),
      options: {
        ...GZIP_META,
        customMetadata: { parkedAt: String(segment.parkedAt), reason: segment.reason },
      },
    };
  }
  const visitorsTable = key.includes('/visitors/');
  const lines = new TextDecoder()
    .decode(body)
    .split('\n')
    .filter((l) => l !== '');
  const kept = lines.filter((line) => {
    const row = JSON.parse(line) as Record<string, unknown>;
    if (visitorsTable && typeof row['id'] === 'string' && vids.has(row['id'])) return false;
    return !ROW_VISITOR_FIELDS.some((f) => typeof row[f] === 'string' && vids.has(row[f]));
  });
  if (kept.length === lines.length) return null;
  if (kept.length === 0) return 'delete';
  return {
    body: `${kept.join('\n')}\n`,
    options: { httpMetadata: { contentType: 'application/x-ndjson' } },
  };
}

/**
 * Rewrites one object. An unreadable object is logged and skipped (it would
 * fail every retry and block the job); R2 errors propagate so the job retries.
 */
async function rewrite(
  bucket: R2Bucket,
  key: string,
  format: Format,
  vids: ReadonlySet<string>,
): Promise<'rewritten' | 'unchanged' | 'failed'> {
  const object = await bucket.get(key);
  if (object === null) return 'unchanged';
  const body = await object.arrayBuffer();
  let next: Rewritten;
  try {
    next = await filtered(body, key, format, vids);
  } catch (error) {
    console.error('purge: unreadable object skipped', key, error);
    return 'failed';
  }
  if (next === null) return 'unchanged';
  if (next === 'delete') await bucket.delete(key);
  else await bucket.put(key, next.body, next.options);
  return 'rewritten';
}

/** Day of a day-partitioned key `<prefix>/<site>/<YYYY-MM-DD>/…`. */
const dayOf = (key: string, base: string) => key.slice(base.length, base.length + 10);

/**
 * Runs the due purge job until done or out of budget. Returns true when work
 * is left (the caller re-arms its alarm).
 */
export async function runPurgeJob(
  db: SqlDb,
  bucket: R2Bucket,
  siteId: string,
  now: number,
  budgetMs = 15_000,
): Promise<boolean> {
  const job: PurgeJob | null = duePurgeJob(db, now);
  if (job === null) return false;
  const vids = new Set(job.vids);
  const deadline = Date.now() + budgetMs;
  let { phase, cursor, scanned, rewritten, failed } = job;
  const save = () => savePurgeJob(db, { ...job, phase, cursor, scanned, rewritten, failed });
  while (phase < PHASES.length) {
    if (Date.now() > deadline) {
      save();
      return true;
    }
    const p = PHASES[phase] as Phase;
    if (job.tail === 1 && !p.tail) {
      phase += 1;
      continue;
    }
    const base = `${p.prefix}/${siteId}/`;
    const page = await bucket.list({
      prefix: base,
      limit: PAGE,
      ...(cursor !== null
        ? { cursor }
        : p.dayRanged
          ? { startAfter: `${base}${job.from_day}` }
          : {}),
    });
    let pastRange = false;
    for (const o of page.objects) {
      if (p.dayRanged && dayOf(o.key, base) > job.to_day) {
        pastRange = true;
        break;
      }
      scanned += 1;
      const outcome = await rewrite(bucket, o.key, p.format, vids);
      if (outcome === 'rewritten') rewritten += 1;
      else if (outcome === 'failed') failed += 1;
    }
    if (pastRange || !page.truncated) {
      phase += 1;
      cursor = null;
    } else {
      cursor = page.cursor ?? null;
    }
    save();
  }
  finishPurgePass(db, { ...job, scanned, rewritten, failed }, now);
  return duePurgeJob(db, now) !== null;
}
