import { first, type SqlDb } from '../db/sql';
import { dayKey, dayStart, HOUR_MS, nextDay } from '../time';

export interface RollupTotals {
  visitors: number;
  sessions: number;
  pageviews: number;
  bounces: number;
  duration_ms: number;
  goals: number;
  revenue_minor: number;
}

/**
 * Aggregates raw rows of [from, to). Session metrics (visitors, sessions, bounces,
 * duration) count sessions that *started* in the range; pageviews, goals and
 * revenue count rows whose timestamp falls in it.
 */
export function aggregateRange(
  db: SqlDb,
  from: number,
  to: number,
  currency: string,
): RollupTotals {
  const s = first<{
    visitors: number;
    sessions: number;
    bounces: number | null;
    duration_ms: number | null;
  }>(
    db,
    `SELECT COUNT(DISTINCT visitor_id) AS visitors, COUNT(*) AS sessions, SUM(bounce) AS bounces,
       SUM(duration_ms) AS duration_ms
     FROM sessions WHERE started_at >= ? AND started_at < ?`,
    from,
    to,
  );
  const count = (sql: string, ...params: number[]): number =>
    first<{ n: number | null }>(db, sql, ...params)?.n ?? 0;
  const pageviews = count(`SELECT COUNT(*) AS n FROM pageviews WHERE ts >= ? AND ts < ?`, from, to);
  const goals = count(`SELECT COUNT(*) AS n FROM goals WHERE ts >= ? AND ts < ?`, from, to);
  const revenue =
    first<{ n: number | null }>(
      db,
      `SELECT SUM(amount_minor - refunded_minor) AS n FROM payments WHERE ts >= ? AND ts < ? AND refunded = 0 AND currency = ?`,
      from,
      to,
      currency,
    )?.n ?? 0;
  return {
    visitors: s?.visitors ?? 0,
    sessions: s?.sessions ?? 0,
    pageviews,
    bounces: s?.bounces ?? 0,
    duration_ms: s?.duration_ms ?? 0,
    goals,
    revenue_minor: revenue,
  };
}

/**
 * Recomputes the hourly rollups of every dirty hour and the daily rollups (site
 * time zone) of the days touching them. Called after each ingest batch, so the
 * dashboard reads precomputed rows. Returns the number of hours refreshed.
 */
export function refreshRollups(db: SqlDb, timeZone: string, currency: string): number {
  return db.transaction(() => {
    const hours = db
      .all<{ key: string }>(`SELECT key FROM rollup_dirty WHERE grain = 'hour'`)
      .map((r) => Number(r.key))
      .filter((h) => Number.isFinite(h));
    const days = new Set<string>();
    for (const h of hours) {
      const t = aggregateRange(db, h, h + HOUR_MS, currency);
      db.run(
        `INSERT INTO rollup_hourly (bucket, visitors, sessions, pageviews, bounces, duration_ms, goals, revenue_minor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (bucket) DO UPDATE SET visitors = excluded.visitors, sessions = excluded.sessions,
           pageviews = excluded.pageviews, bounces = excluded.bounces, duration_ms = excluded.duration_ms,
           goals = excluded.goals, revenue_minor = excluded.revenue_minor`,
        h,
        t.visitors,
        t.sessions,
        t.pageviews,
        t.bounces,
        t.duration_ms,
        t.goals,
        t.revenue_minor,
      );
      days.add(dayKey(h, timeZone));
      days.add(dayKey(h + HOUR_MS - 1, timeZone));
    }
    for (const day of days) {
      const start = dayStart(day, timeZone);
      const t = aggregateRange(db, start, dayStart(nextDay(day), timeZone), currency);
      db.run(
        `INSERT INTO rollup_daily (day, start_ts, visitors, sessions, pageviews, bounces, duration_ms, goals, revenue_minor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (day) DO UPDATE SET start_ts = excluded.start_ts, visitors = excluded.visitors,
           sessions = excluded.sessions, pageviews = excluded.pageviews, bounces = excluded.bounces,
           duration_ms = excluded.duration_ms, goals = excluded.goals, revenue_minor = excluded.revenue_minor`,
        day,
        start,
        t.visitors,
        t.sessions,
        t.pageviews,
        t.bounces,
        t.duration_ms,
        t.goals,
        t.revenue_minor,
      );
    }
    db.run(`DELETE FROM rollup_dirty WHERE grain = 'hour'`);
    return hours.length;
  });
}
