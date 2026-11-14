import { first, type SqlDb } from '../db/sql';
import type { EnrichedEvent } from '../types';
import { utcDay } from '../wal';
import { getMergeSettings, resolveVisitorGroup } from './identity';

/**
 * Suppression of visitors (opt-out, erasure requests). A suppressed visitor id
 * is a tombstone: its events are never applied again (DO ingest, replay) and
 * the edge drops them before the archive. A suppressed identity (hashed email
 * or phone) suppresses every visitor carrying it, now and when it shows up.
 *
 * The purge erases the visitors here: rows that only describe the person
 * (identity keys, tags, queues, merges, outbound payloads) are deleted, the
 * traffic rows (sessions, pageviews, goals, payments, touches) move to a
 * random id linked to nothing, without contact fields and click ids, so the
 * rollups recomputed later still add up. A job then rewrites their R2 objects
 * (`purge.ts`) and rescans the recent days for a while (late batches).
 */

export type SuppressedKeyType = 'email' | 'phone';

export interface SuppressInput {
  visitorIds: readonly string[];
  keys: ReadonlyArray<{ type: SuppressedKeyType; hash: string }>;
  purge: boolean;
}

export interface SuppressResult {
  /** Visitors suppressed by this call (given ids, carriers of the keys, merged ids). */
  visitorIds: string[];
  purgedRows: number;
  jobId: string | null;
}

/** Newest tombstones carried by the edge config (the DO filter stays exact beyond). */
export const SUPPRESSED_CONFIG_MAX = 5000;
/** The edge config cache may still be stale this long after a suppression. */
const EDGE_CONFIG_SETTLE_MS = 3 * 60_000;

/** Rows that only describe the person: deleted. */
const IDENTITY_TABLES = [
  'identity_queue',
  'automation_queue',
  'alert_queue',
  'identity_keys',
  'visitor_tags',
  'conversion_log',
  'ip_ua_seen',
  'device_signals',
  'device_ip_seen',
] as const;
/** Traffic rows: moved to an anonymous id so aggregates stay consistent. */
const TRAFFIC_TABLES = [
  'pageviews',
  'goals',
  'exit_links',
  'touches',
  'funnel_sessions',
  'sessions',
  'payments',
] as const;
/** The recent days are rescanned this long after the first pass. */
const PURGE_TAIL_MS = 15 * 86_400_000;
const PURGE_TAIL_EVERY_MS = 86_400_000;

const json = (ids: readonly string[]) => JSON.stringify(ids);

/**
 * The given visitors plus every visitor merged with them, transitively. The
 * `ip_ua` and `device_ip` merges are a guess (same network and browser or device), so they never carry an
 * opt-out or an erasure to somebody else. Two visitors of one group that gave
 * the same email or phone are one person all the same: their own merge would
 * say so, had the guess not put them in one group first.
 */
function withMerged(db: SqlDb, ids: readonly string[]): string[] {
  const out = new Set(ids);
  const sameKey = sameKeyInGroup(db, out);
  let frontier = [...out];
  while (frontier.length > 0) {
    const next: string[] = [];
    const add = (v: string): void => {
      if (out.has(v)) return;
      out.add(v);
      next.push(v);
    };
    for (const r of db.all<{ a: string; b: string }>(
      `SELECT child_visitor_id AS a, origin_visitor_id AS b FROM visitor_merges
       WHERE active = 1 AND mechanism NOT IN ('ip_ua', 'device_ip')
         AND (child_visitor_id IN (SELECT value FROM json_each(?)) OR origin_visitor_id IN (SELECT value FROM json_each(?)))`,
      json(frontier),
      json(frontier),
    )) {
      add(r.a);
      add(r.b);
    }
    for (const v of sameKey(frontier)) add(v);
    frontier = next;
  }
  return [...out];
}

/**
 * Finds the visitors not yet in `out` that share a group and an email or phone
 * with one of the given ones. Only on a site where a guess merged visitors
 * (elsewhere their own merge links them already) and for the keys the site
 * merges by. One query per group, one row per visitor found, so a key held by
 * thousands of visitors costs no more than their group.
 */
function sameKeyInGroup(
  db: SqlDb,
  out: ReadonlySet<string>,
): (ids: readonly string[]) => string[] {
  const settings = getMergeSettings(db);
  const keyTypes = (['email', 'phone'] as const).filter((type) => settings[type]);
  const guesses =
    keyTypes.length > 0 &&
    first(
      db,
      `SELECT 1 AS x FROM visitor_merges WHERE active = 1 AND mechanism IN ('ip_ua', 'device_ip') LIMIT 1`,
    ) !== undefined;
  const groupOf = new Map<string, readonly string[]>();
  return (ids) => {
    if (!guesses) return [];
    const byGroup = new Map<readonly string[], string[]>();
    for (const id of ids) {
      let group = groupOf.get(id);
      if (group === undefined) {
        group = resolveVisitorGroup(db, id);
        for (const member of group) groupOf.set(member, group);
      }
      const members = byGroup.get(group);
      if (members === undefined) byGroup.set(group, [id]);
      else members.push(id);
    }
    const found: string[] = [];
    for (const [group, members] of byGroup) {
      const others = group.filter((v) => !out.has(v));
      if (others.length === 0) continue;
      for (const r of db.all<{ v: string }>(
        `SELECT DISTINCT o.visitor_id AS v FROM identity_keys o
         WHERE o.visitor_id IN (SELECT value FROM json_each(?))
           AND o.key_type IN (SELECT value FROM json_each(?))
           AND EXISTS (SELECT 1 FROM identity_keys k
             WHERE k.key_type = o.key_type AND k.key_value = o.key_value
               AND k.visitor_id IN (SELECT value FROM json_each(?)))`,
        json(others),
        json(keyTypes),
        json(members),
      ))
        found.push(r.v);
    }
    return found;
  };
}

function carriersOf(db: SqlDb, keys: SuppressInput['keys']): string[] {
  if (keys.length === 0) return [];
  return db
    .all<{ visitor_id: string }>(
      `SELECT DISTINCT k.visitor_id FROM identity_keys k
       JOIN json_each(?) j ON k.key_type = json_extract(j.value, '$.type') AND k.key_value = json_extract(j.value, '$.hash')`,
      JSON.stringify(keys),
    )
    .map((r) => r.visitor_id);
}

/**
 * Erases the visitors (see the module comment); returns the number of
 * visitors erased.
 */
export function purgeVisitorRows(db: SqlDb, ids: readonly string[]): number {
  if (ids.length === 0) return 0;
  const list = json(ids);
  const IN = `IN (SELECT value FROM json_each(?))`;
  for (const table of IDENTITY_TABLES) db.run(`DELETE FROM ${table} WHERE visitor_id ${IN}`, list);
  // Matches of the `device_ip` rule kept on other visitors for the measurements.
  db.run(`UPDATE device_signals SET candidate = NULL WHERE candidate ${IN}`, list);
  db.run(
    `DELETE FROM visitor_merges WHERE child_visitor_id ${IN} OR origin_visitor_id ${IN}`,
    list,
    list,
  );
  db.run(
    `DELETE FROM outbound_conversions WHERE json_extract(payload, '$.external_id') ${IN}`,
    list,
  );
  const map = JSON.stringify(Object.fromEntries(ids.map((id) => [id, `x${crypto.randomUUID()}`])));
  const anon = `json_extract(?, '$."' || visitor_id || '"')`;
  for (const table of TRAFFIC_TABLES) {
    db.run(`UPDATE ${table} SET visitor_id = ${anon} WHERE visitor_id ${IN}`, map, list);
  }
  const anonIds = `(SELECT value FROM json_each(?))`;
  const ANON = `IN ${anonIds}`;
  const anonList = JSON.stringify(Object.values(JSON.parse(map) as Record<string, string>));
  db.run(
    `UPDATE sessions SET click_ids = NULL, ad_keyword = NULL, city = NULL, latitude = NULL, longitude = NULL WHERE visitor_id ${ANON}`,
    anonList,
  );
  db.run(`UPDATE goals SET params = NULL WHERE visitor_id ${ANON}`, anonList);
  db.run(
    `UPDATE touches SET external_click_id = NULL, fields = NULL WHERE visitor_id ${ANON}`,
    anonList,
  );
  db.run(
    `UPDATE payments SET email = NULL, customer_id = NULL, contact_id = NULL, order_id = NULL WHERE visitor_id ${ANON}`,
    anonList,
  );
  const n =
    first<{ n: number }>(db, `SELECT COUNT(*) AS n FROM visitors WHERE id ${IN}`, list)?.n ?? 0;
  db.run(
    `UPDATE visitors SET id = json_extract(?, '$."' || id || '"'), user_id = NULL, email = NULL, name = NULL,
       traits = NULL, contact_id = NULL, linked_at = NULL, link_source = NULL, first_referrer_host = NULL
     WHERE id ${IN}`,
    map,
    list,
  );
  return n;
}

/** R2 rewrite of erased visitors: the whole archive first, then the recent days for a while. */
function createPurgeJob(db: SqlDb, ids: readonly string[], now: number): string {
  const jobId = crypto.randomUUID();
  db.run(
    `INSERT INTO purge_jobs (id, vids, from_day, to_day, not_before, created_at, tail_until)
     VALUES (?, ?, '0000-00-00', '9999-12-31', ?, ?, ?)`,
    jobId,
    json(ids),
    now + EDGE_CONFIG_SETTLE_MS,
    now,
    now + PURGE_TAIL_MS,
  );
  return jobId;
}

function tombstone(db: SqlDb, ids: readonly string[], now: number): void {
  db.run(
    `INSERT OR IGNORE INTO suppressed_visitors (vid, created_at) SELECT value, ? FROM json_each(?)`,
    now,
    json(ids),
  );
  // A guess that linked one of them to a visitor left out (`withMerged`) is cut:
  // that visitor goes on as its own person, not as the one that opted out.
  const IN = `IN (SELECT value FROM json_each(?))`;
  db.run(
    `UPDATE visitor_merges SET active = 0, updated_at = ?
     WHERE active = 1 AND mechanism IN ('ip_ua', 'device_ip')
       AND ((child_visitor_id ${IN} AND origin_visitor_id NOT ${IN})
         OR (origin_visitor_id ${IN} AND child_visitor_id NOT ${IN}))`,
    now,
    json(ids),
    json(ids),
    json(ids),
    json(ids),
  );
}

export function suppress(db: SqlDb, input: SuppressInput, now: number): SuppressResult {
  return db.transaction(() => {
    for (const k of input.keys) {
      db.run(
        `INSERT INTO suppressed_keys (key_type, key_value, created_at, purge) VALUES (?, ?, ?, ?)
         ON CONFLICT (key_type, key_value) DO UPDATE SET purge = MAX(purge, excluded.purge)`,
        k.type,
        k.hash,
        now,
        input.purge ? 1 : 0,
      );
    }
    const ids = withMerged(db, [...new Set([...input.visitorIds, ...carriersOf(db, input.keys)])]);
    tombstone(db, ids, now);
    if (!input.purge || ids.length === 0) return { visitorIds: ids, purgedRows: 0, jobId: null };
    const purgedRows = purgeVisitorRows(db, ids);
    return { visitorIds: ids, purgedRows, jobId: createPurgeJob(db, ids, now) };
  });
}

/** Tombstones for the edge config cache (newest first, capped). */
export function suppressedForConfig(db: SqlDb): { visitors: string[]; keys: string[] } {
  return {
    visitors: db
      .all<{ vid: string }>(
        `SELECT vid FROM suppressed_visitors ORDER BY created_at DESC LIMIT ?`,
        SUPPRESSED_CONFIG_MAX,
      )
      .map((r) => r.vid),
    keys: db
      .all<{ key_value: string }>(
        `SELECT key_value FROM suppressed_keys ORDER BY created_at DESC LIMIT ?`,
        SUPPRESSED_CONFIG_MAX,
      )
      .map((r) => r.key_value),
  };
}

function eventKeys(e: EnrichedEvent): Array<[SuppressedKeyType, string]> {
  const out: Array<[SuppressedKeyType, string]> = [];
  for (const email of [e.identity?.email, e.payment?.email]) {
    if (typeof email === 'string' && email !== '') out.push(['email', email]);
  }
  const phone = e.identity?.traits?.['phone'];
  if (typeof phone === 'string') out.push(['phone', phone]);
  return out;
}

/**
 * Drops the events of suppressed visitors. An event carrying a suppressed
 * identity suppresses its visitor too, and erases it when the key asks so.
 */
export function dropSuppressed(
  db: SqlDb,
  events: readonly EnrichedEvent[],
  now: number,
): EnrichedEvent[] {
  if (events.length === 0) return [];
  if (
    first(db, `SELECT 1 AS x FROM suppressed_visitors LIMIT 1`) === undefined &&
    first(db, `SELECT 1 AS x FROM suppressed_keys LIMIT 1`) === undefined
  ) {
    return [...events];
  }
  const vids = [...new Set(events.map((e) => e.vid))];
  const dead = new Set(
    db
      .all<{ vid: string }>(
        `SELECT vid FROM suppressed_visitors WHERE vid IN (SELECT value FROM json_each(?))`,
        json(vids),
      )
      .map((r) => r.vid),
  );
  const fresh = { purge: [] as string[], block: [] as string[] };
  for (const e of events) {
    if (dead.has(e.vid)) continue;
    for (const [type, hash] of eventKeys(e)) {
      const key = first<{ purge: number }>(
        db,
        `SELECT purge FROM suppressed_keys WHERE key_type = ? AND key_value = ?`,
        type,
        hash,
      );
      if (key !== undefined) {
        dead.add(e.vid);
        (key.purge === 1 ? fresh.purge : fresh.block).push(e.vid);
        break;
      }
    }
  }
  if (fresh.block.length > 0) {
    const ids = withMerged(db, fresh.block);
    tombstone(db, ids, now);
    for (const id of ids) dead.add(id);
  }
  if (fresh.purge.length > 0) {
    const ids = withMerged(db, fresh.purge);
    tombstone(db, ids, now);
    purgeVisitorRows(db, ids);
    createPurgeJob(db, ids, now);
    for (const id of ids) dead.add(id);
  }
  return events.filter((e) => !dead.has(e.vid));
}

export function isSuppressedVisitor(db: SqlDb, vid: string): boolean {
  return first(db, `SELECT 1 AS x FROM suppressed_visitors WHERE vid = ?`, vid) !== undefined;
}

export interface PurgeJob {
  id: string;
  vids: string[];
  from_day: string;
  to_day: string;
  not_before: number;
  phase: number;
  cursor: string | null;
  scanned: number;
  rewritten: number;
  status: 'running' | 'done';
  created_at: number;
  done_at: number | null;
  tail_until: number | null;
  /** 1 on the rescans of the recent days (day-ranged phases only). */
  tail: number;
  /** Objects that could not be read and were skipped. */
  failed: number;
}

export function duePurgeJob(db: SqlDb, now: number): PurgeJob | null {
  const row = first<Omit<PurgeJob, 'vids'> & { vids: string }>(
    db,
    `SELECT * FROM purge_jobs WHERE status = 'running' AND not_before <= ? ORDER BY created_at LIMIT 1`,
    now,
  );
  return row === undefined ? null : { ...row, vids: JSON.parse(row.vids) as string[] };
}

export function nextPurgeAt(db: SqlDb): number | null {
  return (
    first<{ t: number | null }>(
      db,
      `SELECT MIN(not_before) AS t FROM purge_jobs WHERE status = 'running'`,
    )?.t ?? null
  );
}

export function savePurgeJob(
  db: SqlDb,
  job: Pick<
    PurgeJob,
    'id' | 'phase' | 'cursor' | 'scanned' | 'rewritten' | 'status' | 'done_at' | 'failed'
  >,
): void {
  db.run(
    `UPDATE purge_jobs SET phase = ?, cursor = ?, scanned = ?, rewritten = ?, status = ?, done_at = ?, failed = ?
     WHERE id = ?`,
    job.phase,
    job.cursor,
    job.scanned,
    job.rewritten,
    job.status,
    job.done_at,
    job.failed,
    job.id,
  );
}

/**
 * End of a pass: a rescan of the days since the job was created is scheduled
 * while the tail lasts (batches retried or replayed after the first pass),
 * otherwise the job is done.
 */
export function finishPurgePass(db: SqlDb, job: PurgeJob, now: number): void {
  if (job.tail_until !== null && now + PURGE_TAIL_EVERY_MS <= job.tail_until) {
    db.run(
      `UPDATE purge_jobs SET phase = 0, cursor = NULL, tail = 1, from_day = ?, not_before = ? WHERE id = ?`,
      utcDay(job.created_at),
      now + PURGE_TAIL_EVERY_MS,
      job.id,
    );
    return;
  }
  db.run(
    `UPDATE purge_jobs SET status = 'done', done_at = ?, cursor = NULL WHERE id = ?`,
    now,
    job.id,
  );
}

export function listPurgeJobs(
  db: SqlDb,
  limit = 50,
): Array<Omit<PurgeJob, 'vids'> & { visitors: number }> {
  return db
    .all<Omit<PurgeJob, 'vids'> & { vids: string }>(
      `SELECT * FROM purge_jobs ORDER BY created_at DESC LIMIT ?`,
      limit,
    )
    .map(({ vids, ...rest }) => ({ ...rest, visitors: (JSON.parse(vids) as string[]).length }));
}
