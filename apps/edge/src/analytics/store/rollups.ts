import { first, type SqlDb, type SqlValue } from '../db/sql';
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

// ------------------------------------------------- funnel click-log by ad entity

/** Funnel hits of one local day per traffic source, ad entity, funnel and node. */
export interface TouchDayRollup {
  day: string;
  source: string | null;
  campaign: string | null;
  adset: string | null;
  ad: string | null;
  funnel: string;
  node: string;
  entrances: number;
  views: number;
  clicks: number;
  /** Cost carried by the entrances. */
  cost: number;
}

interface TouchRollupState {
  signature: string;
  lastRowid: number;
  lastId: string | null;
  count: number;
  rows: Map<string, TouchDayRollup>;
}

const touchRollups = new WeakMap<SqlDb, Map<string, TouchRollupState>>();

/**
 * Daily rollup of the click-log, kept in memory per database and time zone.
 * Touches are append-only, so later calls only aggregate the rows added since
 * (rowid watermark); any delete (retention), rowid reuse or change of the
 * adset / ad slot mapping (`slots.signature`) rebuilds it. Day-aligned report
 * ranges read it instead of scanning the touches.
 */
export function touchDayRollups(
  db: SqlDb,
  timeZone: string,
  slots: { signature: string; sql: (level: 'adset' | 'ad', params: SqlValue[]) => string },
): Iterable<TouchDayRollup> {
  let byZone = touchRollups.get(db);
  if (byZone === undefined) {
    byZone = new Map();
    touchRollups.set(db, byZone);
  }
  const head = first<{ n: number; max: number | null }>(db, `SELECT COUNT(*) AS n, MAX(rowid) AS max FROM touches`);
  const count = head?.n ?? 0;
  const maxRowid = head?.max ?? 0;
  const lastId = first<{ id: string }>(db, `SELECT id FROM touches WHERE rowid = ?`, maxRowid)?.id ?? null;
  let state = byZone.get(timeZone);
  const appendOnly =
    state !== undefined &&
    state.signature === slots.signature &&
    maxRowid >= state.lastRowid &&
    count - state.count === maxRowid - state.lastRowid &&
    (maxRowid > state.lastRowid || lastId === state.lastId);
  if (state === undefined || !appendOnly) {
    state = { signature: slots.signature, lastRowid: 0, lastId: null, count: 0, rows: new Map() };
    byZone.set(timeZone, state);
  }
  if (maxRowid > state.lastRowid || state.count !== count) {
    const params: SqlValue[] = [];
    const adset = slots.sql('adset', params);
    const ad = slots.sql('ad', params);
    params.push(state.lastRowid, maxRowid);
    const quarter = new Map<number, string>();
    for (const r of db.all<{
      source: string | null;
      campaign: string | null;
      adset: string | null;
      ad: string | null;
      funnel: string;
      node: string;
      qh: number;
      entrances: number;
      views: number;
      clicks: number;
      cost: number;
    }>(
      `SELECT t.traffic_source_id AS source, t.campaign AS campaign, ${adset} AS adset, ${ad} AS ad,
         t.funnel_id AS funnel, t.node_id AS node, t.ts / 900000 AS qh,
         SUM(t.kind = 'entrance') AS entrances, SUM(t.kind = 'view') AS views,
         SUM(t.kind IN ('click', 'action')) AS clicks,
         SUM(CASE WHEN t.kind = 'entrance' THEN COALESCE(t.cost_minor, 0) ELSE 0 END) AS cost
       FROM touches t WHERE t.rowid > ? AND t.rowid <= ?
       GROUP BY 1, 2, 3, 4, 5, 6, 7`,
      ...params,
    )) {
      let day = quarter.get(r.qh);
      if (day === undefined) {
        day = dayKey(r.qh * 900_000, timeZone);
        quarter.set(r.qh, day);
      }
      const key = JSON.stringify([day, r.source, r.campaign, r.adset, r.ad, r.funnel, r.node]);
      const cur = state.rows.get(key);
      if (cur === undefined) {
        state.rows.set(key, {
          day,
          source: r.source,
          campaign: r.campaign,
          adset: r.adset,
          ad: r.ad,
          funnel: r.funnel,
          node: r.node,
          entrances: r.entrances,
          views: r.views,
          clicks: r.clicks,
          cost: r.cost,
        });
      } else {
        cur.entrances += r.entrances;
        cur.views += r.views;
        cur.clicks += r.clicks;
        cur.cost += r.cost;
      }
    }
    state.lastRowid = maxRowid;
    state.lastId = lastId;
    state.count = count;
  }
  return state.rows.values();
}
