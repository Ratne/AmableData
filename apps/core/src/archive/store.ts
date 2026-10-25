import type { SqlDb } from '../crm/db/sql';
import {
  monthKey,
  monthRange,
  MONTH_PATTERN,
  normalizeRetention,
  PAGE_MAX_CHARS,
  PAGE_MAX_ROWS,
  type ArchiveCatalogEntry,
  type ArchiveMonthSummary,
  type ArchivePlanStream,
  type ArchiveRowsPage,
  type ArchiveStream,
  type PendingPartition,
  type RetentionSettings,
} from './model';
import { purgeOutbox, STREAM_SQL } from './streams';

/**
 * Archive operations of a Durable Object (TenantDb or MailDb), reached only by
 * the core worker: the retention scheduler (plan → rows → record → prune) and
 * the archive read routes (catalog). Rows are deleted only for a month whose
 * every partition has its final part recorded in the catalog, i.e. after the
 * worker wrote all of them to R2.
 */
export interface ArchiveHost {
  db: SqlDb;
  streams: readonly ArchiveStream[];
  outbox: 'crm_outbox' | 'mail_outbox';
  /** Key/value table holding the retention settings (TenantDb only). */
  settingsTable: string | null;
  now(): number;
}

export class ArchiveOpError extends Error {
  constructor(
    readonly code: 'bad_request' | 'not_archived',
    message: string,
  ) {
    super(message);
  }
}

const SETTINGS_KEY = 'archive.retention';
const PRUNE_MAX = 2000;
const CATALOG_MAX = 1000;

interface CatalogRow extends Omit<ArchiveCatalogEntry, 'final'> {
  final: number;
}

function stream(host: ArchiveHost, value: unknown): ArchiveStream {
  if (typeof value !== 'string' || !(host.streams as readonly string[]).includes(value)) {
    throw new ArchiveOpError('bad_request', `stream ${String(value)} is not held by this database`);
  }
  return value as ArchiveStream;
}

function month(value: unknown): string {
  if (typeof value !== 'string' || !MONTH_PATTERN.test(value)) throw new ArchiveOpError('bad_request', 'month must be yyyy-mm');
  return value;
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '' || value.length > 200) throw new ArchiveOpError('bad_request', `${name} is required`);
  return value;
}

/** A cutoff is always the first instant of a month: a month is archived whole or not at all. */
function cutoff(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || monthRange(monthKey(value)).from !== value) {
    throw new ArchiveOpError('bad_request', 'cutoff must be the first instant of a month');
  }
  return value;
}

function toEntry(row: CatalogRow): ArchiveCatalogEntry {
  return { ...row, final: row.final === 1 };
}

function partsOf(db: SqlDb, s: ArchiveStream, m: string): Map<string, { part: number; final: boolean; last: string | null }> {
  const out = new Map<string, { part: number; final: boolean; last: string | null }>();
  for (const row of db.all<{ partition: string; part: number; final: number; last_cursor: string | null }>(
    `SELECT partition, part, final, last_cursor FROM archive_catalog WHERE stream = ? AND month = ? ORDER BY partition, part`,
    s,
    m,
  )) {
    out.set(row.partition, { part: row.part, final: row.final === 1, last: row.last_cursor });
  }
  return out;
}

function pendingOf(db: SqlDb, s: ArchiveStream, m: string): PendingPartition[] {
  const { from, to } = monthRange(m);
  const parts = partsOf(db, s, m);
  const pending: PendingPartition[] = [];
  for (const partition of STREAM_SQL[s].partitions(db, from, to)) {
    const done = parts.get(partition);
    // A row written into the month after its last part (ids are ULIDs: a late row sorts after the cursor) reopens it.
    if (done?.final === true && STREAM_SQL[s].rows(db, from, to, partition, done.last, 1).length === 0) continue;
    pending.push({ partition, part: done === undefined ? 0 : done.part + 1, after: done?.last ?? null });
  }
  return pending;
}

/** Oldest month past the cutoff of each stream, with its partitions not written yet. */
export function archivePlan(host: ArchiveHost, input: { cutoffs?: Record<string, unknown> }): ArchivePlanStream[] {
  const out: ArchivePlanStream[] = [];
  for (const [name, value] of Object.entries(input.cutoffs ?? {})) {
    const s = stream(host, name);
    const oldest = STREAM_SQL[s].oldest(host.db, cutoff(value));
    if (oldest === null) continue;
    const m = monthKey(oldest);
    out.push({ stream: s, month: m, pending: pendingOf(host.db, s, m) });
  }
  return out;
}

/** One page of a partition, in id order after `after`, bounded in rows and size. */
export function archiveRows(
  host: ArchiveHost,
  input: { stream?: unknown; month?: unknown; partition?: unknown; after?: unknown; limit?: unknown },
): ArchiveRowsPage {
  const s = stream(host, input.stream);
  const { from, to } = monthRange(month(input.month));
  const partition = text(input.partition, 'partition');
  const after = typeof input.after === 'string' ? input.after : null;
  const limit = typeof input.limit === 'number' ? Math.min(Math.max(Math.floor(input.limit), 1), PAGE_MAX_ROWS) : PAGE_MAX_ROWS;
  const fetched = STREAM_SQL[s].rows(host.db, from, to, partition, after, limit + 1);
  const rows: Record<string, unknown>[] = [];
  let chars = 0;
  for (const row of fetched.slice(0, limit)) {
    const size = JSON.stringify(row).length;
    if (rows.length > 0 && chars + size > PAGE_MAX_CHARS) break;
    rows.push(row);
    chars += size;
  }
  const lastRow = rows.at(-1);
  return {
    rows,
    last: lastRow === undefined ? after : String(lastRow['id']),
    more: rows.length < fetched.length,
  };
}

/** Records an object the worker finished writing to R2. */
export function archiveRecord(host: ArchiveHost, input: Partial<ArchiveCatalogEntry>): void {
  const s = stream(host, input.stream);
  const m = month(input.month);
  const partition = text(input.partition, 'partition');
  const key = text(input.object_key, 'object_key');
  if (typeof input.part !== 'number' || !Number.isInteger(input.part) || input.part < 0) {
    throw new ArchiveOpError('bad_request', 'part must be a non-negative integer');
  }
  host.db.run(
    `INSERT OR REPLACE INTO archive_catalog
       (stream, month, partition, part, object_key, rows, bytes, last_cursor, final, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    s,
    m,
    partition,
    input.part,
    key,
    Math.max(0, Math.floor(Number(input.rows ?? 0))),
    Math.max(0, Math.floor(Number(input.bytes ?? 0))),
    typeof input.last_cursor === 'string' ? input.last_cursor : null,
    input.final === true ? 1 : 0,
    host.now(),
  );
}

/**
 * Deletes up to `limit` rows of an archived month. Refuses while a partition of
 * the month is not fully written (`not_archived`) or when the month is not past
 * the cutoff. `done` once the month has no rows left.
 */
export function archivePrune(
  host: ArchiveHost,
  input: { stream?: unknown; month?: unknown; cutoff?: unknown; limit?: unknown },
): { deleted: number; done: boolean } {
  const s = stream(host, input.stream);
  const m = month(input.month);
  const { from, to } = monthRange(m);
  if (to > cutoff(input.cutoff)) throw new ArchiveOpError('bad_request', `${m} is not past the retention cutoff`);
  const limit = typeof input.limit === 'number' ? Math.min(Math.max(Math.floor(input.limit), 1), PRUNE_MAX) : PRUNE_MAX;
  return host.db.transaction(() => {
    const pending = pendingOf(host.db, s, m);
    if (pending.length > 0) {
      throw new ArchiveOpError('not_archived', `${pending.length} partition(s) of ${s} ${m} are not archived yet`);
    }
    const deleted = STREAM_SQL[s].prune(host.db, from, to, limit, host.now());
    return { deleted, done: deleted < limit };
  });
}

/** Deletes consumed outbox rows older than `before` (bounded batch). */
export function archivePurgeOutbox(host: ArchiveHost, input: { before?: unknown; limit?: unknown }): { deleted: number } {
  if (typeof input.before !== 'number' || !Number.isFinite(input.before)) throw new ArchiveOpError('bad_request', 'before is required');
  const limit = typeof input.limit === 'number' ? Math.min(Math.max(Math.floor(input.limit), 1), PRUNE_MAX) : PRUNE_MAX;
  return { deleted: host.db.transaction(() => purgeOutbox(host.db, host.outbox, input.before as number, limit)) };
}

/** Objects of a partition, newest month first (optionally one month, or months before `before`). */
export function archiveCatalog(
  host: ArchiveHost,
  input: { stream?: unknown; partition?: unknown; month?: unknown; before?: unknown; limit?: unknown },
): ArchiveCatalogEntry[] {
  const s = stream(host, input.stream);
  const partition = text(input.partition, 'partition');
  const limit = typeof input.limit === 'number' ? Math.min(Math.max(Math.floor(input.limit), 1), CATALOG_MAX) : CATALOG_MAX;
  const where = ['stream = ?', 'partition = ?'];
  const params: (string | number)[] = [s, partition];
  if (input.month !== undefined) {
    where.push('month = ?');
    params.push(month(input.month));
  }
  if (input.before !== undefined) {
    where.push('month < ?');
    params.push(month(input.before));
  }
  return host.db
    .all<CatalogRow>(
      `SELECT * FROM archive_catalog WHERE ${where.join(' AND ')} ORDER BY month DESC, part LIMIT ?`,
      ...params,
      limit,
    )
    .map(toEntry);
}

/** Archived months of a partition with their row counts, newest first. */
export function archiveMonths(host: ArchiveHost, input: { stream?: unknown; partition?: unknown }): ArchiveMonthSummary[] {
  const s = stream(host, input.stream);
  const partition = text(input.partition, 'partition');
  return host.db.all<ArchiveMonthSummary>(
    `SELECT month, SUM(rows) AS rows FROM archive_catalog WHERE stream = ? AND partition = ?
      GROUP BY month ORDER BY month DESC LIMIT ?`,
    s,
    partition,
    CATALOG_MAX,
  );
}

/** Totals of every stream of this database (settings page). */
export function archiveSummary(host: ArchiveHost): Array<{ stream: ArchiveStream; rows: number; bytes: number; oldest: string | null; newest: string | null }> {
  return host.streams.map((s) => {
    const row = host.db.all<{ rows: number | null; bytes: number | null; oldest: string | null; newest: string | null }>(
      `SELECT SUM(rows) AS rows, SUM(bytes) AS bytes, MIN(month) AS oldest, MAX(month) AS newest
         FROM archive_catalog WHERE stream = ?`,
      s,
    )[0];
    return { stream: s, rows: row?.rows ?? 0, bytes: row?.bytes ?? 0, oldest: row?.oldest ?? null, newest: row?.newest ?? null };
  });
}

export function readRetention(host: ArchiveHost): RetentionSettings {
  if (host.settingsTable === null) throw new ArchiveOpError('bad_request', 'retention settings live in the TenantDb');
  const raw = host.db.all<{ value: string }>(`SELECT value FROM ${host.settingsTable} WHERE key = ?`, SETTINGS_KEY)[0]?.value;
  let parsed: unknown = {};
  try {
    parsed = raw === undefined ? {} : JSON.parse(raw);
  } catch {
    parsed = {};
  }
  return normalizeRetention(parsed);
}

export function saveRetention(host: ArchiveHost, input: unknown): RetentionSettings {
  if (host.settingsTable === null) throw new ArchiveOpError('bad_request', 'retention settings live in the TenantDb');
  const settings = normalizeRetention({ ...readRetention(host), ...(typeof input === 'object' && input !== null ? input : {}) });
  host.db.run(
    `INSERT INTO ${host.settingsTable} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    SETTINGS_KEY,
    JSON.stringify(settings),
  );
  return settings;
}

export type ArchiveOpResult<T> = { ok: true; value: T } | { ok: false; error: { code: ArchiveOpError['code']; message: string } };

const OPS = {
  plan: archivePlan,
  rows: archiveRows,
  record: archiveRecord,
  prune: archivePrune,
  purgeOutbox: archivePurgeOutbox,
  catalog: archiveCatalog,
  months: archiveMonths,
  summary: archiveSummary,
  'settings.get': readRetention,
  'settings.save': saveRetention,
} as const;

export type ArchiveOpName = keyof typeof OPS;

/** Single RPC entry point of the archive in a Durable Object; errors become `{ ok: false }`. */
export function runArchiveOp(host: ArchiveHost, op: string, input: unknown): ArchiveOpResult<unknown> {
  if (!Object.hasOwn(OPS, op)) return { ok: false, error: { code: 'bad_request', message: `unknown archive operation ${op}` } };
  const fn = OPS[op as ArchiveOpName] as (host: ArchiveHost, input: unknown) => unknown;
  try {
    return { ok: true, value: fn(host, typeof input === 'object' && input !== null ? input : {}) };
  } catch (error) {
    if (error instanceof ArchiveOpError) return { ok: false, error: { code: error.code, message: error.message } };
    throw error;
  }
}
