import type { SqlDb } from '../db/sql';
import { DAY_MS } from '../time';
import { pruneEventKeys } from './dedupe';

/** Where raw rows go before being purged (R2 in production, an in-memory sink in tests). */
export interface ArchiveSink {
  put(key: string, body: string): Promise<void>;
}

/** R2-backed archive sink (`FILES` bucket, `analytics-archive/` prefix). */
export function r2ArchiveSink(bucket: R2Bucket): ArchiveSink {
  return {
    async put(key, body) {
      await bucket.put(key, body, { httpMetadata: { contentType: 'application/x-ndjson' } });
    },
  };
}

/** Writes rows to `analytics-archive/<site>/<table>/<day>-<label>.ndjson` (no-op without a sink). */
export async function archiveRows(
  sink: ArchiveSink | null,
  siteId: string,
  table: string,
  rows: readonly object[],
  ts: number,
  label: string,
): Promise<void> {
  if (sink === null || rows.length === 0) return;
  const day = new Date(ts).toISOString().slice(0, 10);
  await sink.put(
    `analytics-archive/${siteId}/${table}/${day}-${label}.ndjson`,
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
  );
}

/** Raw tables and the column deciding their age. */
const RAW_TABLES: ReadonlyArray<[table: string, column: string]> = [
  ['pageviews', 'ts'],
  ['goals', 'ts'],
  ['payments', 'ts'],
  ['exit_links', 'ts'],
  ['sessions', 'last_seen'],
];

export interface RetentionResult {
  archived: Record<string, number>;
  cutoff: number | null;
  /** The row budget ran out: run again soon (the alarm reschedules itself). */
  more: boolean;
}

/**
 * Archives raw rows older than `retentionDays` as NDJSON (one object per row,
 * chunks of `chunk` rows) and deletes them. Rollups, visitors and bot counters
 * are kept. `retentionDays = 0` keeps raw data forever. At most `budget`
 * rows per pass, so one alarm stays within the DO limits after a long pause or
 * an auto-shrink.
 */
export async function runRetention(
  db: SqlDb,
  sink: ArchiveSink | null,
  siteId: string,
  retentionDays: number,
  now: number,
  chunk = 5000,
  budget = 100_000,
): Promise<RetentionResult> {
  let more = pruneEventKeys(db, now);
  const archived: Record<string, number> = {};
  if (retentionDays <= 0) return { archived, cutoff: null, more };
  const cutoff = now - retentionDays * DAY_MS;
  let spent = 0;
  for (const [table, column] of RAW_TABLES) {
    archived[table] = 0;
    for (;;) {
      if (spent >= budget) {
        more = true;
        break;
      }
      const rows = db.all<Record<string, string | number | null> & { _rowid: number }>(
        `SELECT rowid AS _rowid, * FROM ${table} WHERE ${column} < ? ORDER BY rowid LIMIT ?`,
        cutoff,
        chunk,
      );
      if (rows.length === 0) break;
      const firstRow = rows[0];
      const lastRow = rows.at(-1);
      if (firstRow === undefined || lastRow === undefined) break;
      if (sink !== null) {
        const body = rows.map(({ _rowid: _ignored, ...rest }) => JSON.stringify(rest)).join('\n');
        const day = new Date(Number(firstRow[column])).toISOString().slice(0, 10);
        await sink.put(
          `analytics-archive/${siteId}/${table}/${day}-${firstRow._rowid}-${lastRow._rowid}.ndjson`,
          `${body}\n`,
        );
      }
      db.run(
        `DELETE FROM ${table} WHERE rowid >= ? AND rowid <= ? AND ${column} < ?`,
        firstRow._rowid,
        lastRow._rowid,
        cutoff,
      );
      archived[table] += rows.length;
      spent += rows.length;
      if (rows.length < chunk) break;
    }
  }
  return { archived, cutoff, more };
}
