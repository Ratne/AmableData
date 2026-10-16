import type { SqlDb } from '../db/sql';
import { DAY_MS } from '../time';

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

/** Raw tables and the column deciding their age. */
const RAW_TABLES: ReadonlyArray<[table: string, column: string]> = [
  ['pageviews', 'ts'],
  ['goals', 'ts'],
  ['payments', 'ts'],
  ['exit_links', 'ts'],
  ['sessions', 'last_seen'],
];

/** Dedupe keys only need to outlive queue redeliveries. */
export const INGESTED_EVENTS_TTL_MS = 3 * DAY_MS;

export interface RetentionResult {
  archived: Record<string, number>;
  cutoff: number | null;
}

/**
 * Archives raw rows older than `retentionDays` as NDJSON (one object per row,
 * chunks of `chunk` rows) and deletes them. Rollups, visitors and bot counters
 * are kept. `retentionDays = 0` keeps raw data forever.
 */
export async function runRetention(
  db: SqlDb,
  sink: ArchiveSink | null,
  siteId: string,
  retentionDays: number,
  now: number,
  chunk = 5000,
): Promise<RetentionResult> {
  db.run(`DELETE FROM ingested_events WHERE ts < ?`, now - INGESTED_EVENTS_TTL_MS);
  const archived: Record<string, number> = {};
  if (retentionDays <= 0) return { archived, cutoff: null };
  const cutoff = now - retentionDays * DAY_MS;
  for (const [table, column] of RAW_TABLES) {
    archived[table] = 0;
    for (;;) {
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
      if (rows.length < chunk) break;
    }
  }
  return { archived, cutoff };
}
