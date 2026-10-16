import {
  ANALYTICS_SESSION_DIMENSIONS,
  type AnalyticsBreakdown,
  type AnalyticsBreakdownDimension,
  type AnalyticsBreakdownRow,
  type AnalyticsFilter,
  type AnalyticsInterval,
  type AnalyticsOverview,
  type AnalyticsPoint,
  type AnalyticsTimeseries,
} from '@amable/api-types';
import { first, type SqlDb, type SqlValue } from '../db/sql';
import { buckets, dayStart, HOUR_MS, nextDay, type Bucket } from '../time';

export type SessionDimension = (typeof ANALYTICS_SESSION_DIMENSIONS)[number];

/** Whitelisted column of each session dimension (never interpolate user input). */
export const SESSION_COLUMNS: Readonly<Record<SessionDimension, string>> = {
  channel: 'channel',
  referrer: 'referrer_host',
  source: 'source',
  campaign: 'utm_campaign',
  utm_source: 'utm_source',
  utm_medium: 'utm_medium',
  utm_term: 'utm_term',
  utm_content: 'utm_content',
  country: 'country',
  region: 'region',
  city: 'city',
  device: 'device',
  browser: 'browser',
  os: 'os',
  hostname: 'hostname',
  entry_page: 'entry_path',
  exit_page: 'exit_path',
};

const SESSION_DIMS = new Set<string>(ANALYTICS_SESSION_DIMENSIONS);

function isSessionDimension(d: string): d is SessionDimension {
  return SESSION_DIMS.has(d);
}

/** Resolved query range: [from, to) in epoch ms, plus the display time zone. */
export interface ResolvedRange {
  from: number;
  to: number;
  timeZone: string;
  filters: readonly AnalyticsFilter[];
}

export const MAX_RANGE_MS = 3 * 366 * 24 * HOUR_MS;

/** `YYYY-MM-DD` bounds are local days (inclusive `to`); date-times are instants. */
export function resolveRange(
  input: {
    from: string;
    to: string;
    timezone?: string | undefined;
    filters?: readonly AnalyticsFilter[] | undefined;
  },
  siteTimeZone: string,
): ResolvedRange {
  const timeZone = input.timezone ?? siteTimeZone;
  const isDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s);
  const from = isDate(input.from) ? dayStart(input.from, timeZone) : Date.parse(input.from);
  const to = isDate(input.to) ? dayStart(nextDay(input.to), timeZone) : Date.parse(input.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from)
    throw new RangeError('invalid range');
  if (to - from > MAX_RANGE_MS) throw new RangeError('range too large (max 3 years)');
  return { from, to, timeZone, filters: input.filters ?? [] };
}

function escapeLike(value: string): string {
  return `%${value.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

function condition(column: string, f: AnalyticsFilter, params: SqlValue[]): string {
  if (f.op === 'contains') {
    params.push(escapeLike(f.value));
    return `${column} LIKE ? ESCAPE '\\'`;
  }
  if (f.value === '') return f.op === 'is' ? `${column} IS NULL` : `${column} IS NOT NULL`;
  params.push(f.value);
  return f.op === 'is' ? `${column} = ?` : `(${column} IS NULL OR ${column} <> ?)`;
}

/** SQL predicate on sessions aliased `alias` (`1` when there are no filters). */
export function filterSql(
  filters: readonly AnalyticsFilter[],
  alias: string,
  params: SqlValue[],
): string {
  const parts: string[] = [];
  for (const f of filters) {
    if (isSessionDimension(f.dimension)) {
      parts.push(condition(`${alias}.${SESSION_COLUMNS[f.dimension]}`, f, params));
    } else {
      const [table, column] = f.dimension === 'page' ? ['pageviews', 'path'] : ['goals', 'name'];
      const positive: AnalyticsFilter = { ...f, op: f.op === 'is_not' ? 'is' : f.op };
      const inner = condition(`x.${column}`, positive, params);
      const exists = `EXISTS (SELECT 1 FROM ${table} x WHERE x.session_id = ${alias}.id AND ${inner})`;
      parts.push(f.op === 'is_not' ? `NOT ${exists}` : exists);
    }
  }
  return parts.length === 0 ? '1' : parts.join(' AND ');
}

/**
 * Purchase session of a payment aliased `t`: its own session or, for server-side and
 * CRM payments (often days after the visit), the visitor's last session before it.
 */
export const PURCHASE_SESSION_SQL = `COALESCE(t.session_id, (SELECT ps.id FROM sessions ps
  WHERE ps.visitor_id = t.visitor_id AND ps.started_at <= t.ts ORDER BY ps.started_at DESC LIMIT 1))`;

const ratio = (a: number, b: number): number =>
  b === 0 ? 0 : Math.round((a / b) * 10_000) / 10_000;

export const ONLINE_WINDOW_MS = 5 * 60_000;

export function overview(
  db: SqlDb,
  r: ResolvedRange,
  currency: string,
  now: number,
): AnalyticsOverview {
  const params: SqlValue[] = [r.from, r.to];
  const where = filterSql(r.filters, 's', params);
  const s = first<{
    visitors: number;
    sessions: number;
    bounces: number | null;
    duration: number | null;
  }>(
    db,
    `SELECT COUNT(DISTINCT s.visitor_id) AS visitors, COUNT(*) AS sessions, SUM(s.bounce) AS bounces,
       SUM(s.duration_ms) AS duration
     FROM sessions s WHERE s.started_at >= ? AND s.started_at < ? AND ${where}`,
    ...params,
  );
  const filtered = r.filters.length > 0;
  const joinParams: SqlValue[] = [];
  const join = filtered
    ? `JOIN sessions s ON s.id = t.session_id AND ${filterSql(r.filters, 's', joinParams)}`
    : '';
  const paymentParams: SqlValue[] = [];
  const paymentJoin = filtered
    ? `JOIN sessions s ON s.id = ${PURCHASE_SESSION_SQL} AND ${filterSql(r.filters, 's', paymentParams)}`
    : '';
  const pageviews =
    first<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM pageviews t ${join} WHERE t.ts >= ? AND t.ts < ?`,
      ...joinParams,
      r.from,
      r.to,
    )?.n ?? 0;
  const g = first<{ goals: number; conversions: number }>(
    db,
    `SELECT COUNT(*) AS goals, COUNT(DISTINCT t.visitor_id) AS conversions FROM goals t ${join}
     WHERE t.ts >= ? AND t.ts < ?`,
    ...joinParams,
    r.from,
    r.to,
  );
  const revenue =
    first<{ n: number | null }>(
      db,
      `SELECT SUM(t.amount_minor - t.refunded_minor) AS n FROM payments t ${paymentJoin}
       WHERE t.ts >= ? AND t.ts < ? AND t.refunded = 0 AND t.currency = ?`,
      ...paymentParams,
      r.from,
      r.to,
      currency,
    )?.n ?? 0;
  const customers =
    first<{ n: number }>(
      db,
      `SELECT COUNT(DISTINCT t.visitor_id) AS n FROM payments t ${paymentJoin}
       WHERE t.ts >= ? AND t.ts < ? AND t.refunded = 0 AND t.free_trial = 0 AND t.visitor_id IS NOT NULL`,
      ...paymentParams,
      r.from,
      r.to,
    )?.n ?? 0;
  const online =
    first<{ n: number }>(
      db,
      `SELECT COUNT(DISTINCT visitor_id) AS n FROM sessions WHERE last_seen >= ?`,
      now - ONLINE_WINDOW_MS,
    )?.n ?? 0;
  const visitors = s?.visitors ?? 0;
  const sessions = s?.sessions ?? 0;
  const conversions = g?.conversions ?? 0;
  return {
    from: new Date(r.from).toISOString(),
    to: new Date(r.to).toISOString(),
    timezone: r.timeZone,
    visitors,
    sessions,
    pageviews,
    views_per_session: ratio(pageviews, sessions),
    bounce_rate: ratio(s?.bounces ?? 0, sessions),
    avg_session_duration_ms: sessions === 0 ? 0 : Math.round((s?.duration ?? 0) / sessions),
    goals: g?.goals ?? 0,
    conversions,
    conversion_rate: ratio(conversions, visitors),
    customers,
    purchase_conversion_rate: ratio(customers, Math.max(visitors, customers)),
    revenue_minor: revenue,
    revenue_per_visitor_minor: visitors === 0 ? 0 : Math.round(revenue / visitors),
    currency,
    online,
  };
}

interface PointRow {
  i: number;
  visitors?: number;
  sessions?: number;
  bounces?: number | null;
  n?: number | null;
}

function valuesCte(list: readonly Bucket[]): string {
  // Integers computed here, never user input.
  return `WITH b(i, s, e) AS (VALUES ${list.map((b, i) => `(${i}, ${Math.trunc(b.start)}, ${Math.trunc(b.end)})`).join(', ')})`;
}

function emptyPoint(b: Bucket): AnalyticsPoint {
  return {
    t: new Date(b.start).toISOString(),
    label: b.label,
    visitors: 0,
    sessions: 0,
    pageviews: 0,
    bounce_rate: 0,
    goals: 0,
    revenue_minor: 0,
  };
}

interface RollupRow {
  key: number | string;
  visitors: number;
  sessions: number;
  pageviews: number;
  bounces: number;
  goals: number;
  revenue_minor: number;
}

function fromRollup(
  points: AnalyticsPoint[],
  index: Map<number | string, number>,
  rows: readonly RollupRow[],
): void {
  for (const row of rows) {
    const i = index.get(row.key);
    const p = i === undefined ? undefined : points[i];
    if (p === undefined) continue;
    p.visitors = row.visitors;
    p.sessions = row.sessions;
    p.pageviews = row.pageviews;
    p.bounce_rate = ratio(row.bounces, row.sessions);
    p.goals = row.goals;
    p.revenue_minor = row.revenue_minor;
  }
}

/**
 * Time series over [from, to). Without filters, hourly points come from the
 * hourly rollups and daily points in the site time zone from the daily rollups;
 * everything else is aggregated from raw rows per bucket.
 */
export function timeseries(
  db: SqlDb,
  r: ResolvedRange,
  interval: AnalyticsInterval,
  siteTimeZone: string,
  currency: string,
): AnalyticsTimeseries {
  const list = buckets(r.from, r.to, interval, r.timeZone);
  const points = list.map(emptyPoint);
  if (list.length === 0) return { interval, timezone: r.timeZone, source: 'raw', points };
  const noFilters = r.filters.length === 0;

  if (noFilters && interval === 'hour') {
    const index = new Map<number | string, number>(list.map((b, i) => [b.start, i]));
    const rows = db.all<RollupRow>(
      `SELECT bucket AS key, visitors, sessions, pageviews, bounces, goals, revenue_minor FROM rollup_hourly
       WHERE bucket >= ? AND bucket < ?`,
      list[0]?.start ?? 0,
      list.at(-1)?.end ?? 0,
    );
    fromRollup(points, index, rows);
    return { interval, timezone: r.timeZone, source: 'rollup', points };
  }
  if (noFilters && interval === 'day' && r.timeZone === siteTimeZone) {
    const index = new Map<number | string, number>(list.map((b, i) => [b.label, i]));
    const rows = db.all<RollupRow>(
      `SELECT day AS key, visitors, sessions, pageviews, bounces, goals, revenue_minor FROM rollup_daily
       WHERE day >= ? AND day <= ?`,
      list[0]?.label ?? '',
      list.at(-1)?.label ?? '',
    );
    fromRollup(points, index, rows);
    return { interval, timezone: r.timeZone, source: 'rollup', points };
  }

  const cte = valuesCte(list);
  const sp: SqlValue[] = [];
  const sessionWhere = filterSql(r.filters, 'x', sp);
  for (const row of db.all<PointRow>(
    `${cte} SELECT b.i AS i, COUNT(DISTINCT x.visitor_id) AS visitors, COUNT(x.id) AS sessions, SUM(x.bounce) AS bounces
     FROM b JOIN sessions x ON x.started_at >= b.s AND x.started_at < b.e AND ${sessionWhere} GROUP BY b.i`,
    ...sp,
  )) {
    const p = points[row.i];
    if (p === undefined) continue;
    p.visitors = row.visitors ?? 0;
    p.sessions = row.sessions ?? 0;
    p.bounce_rate = ratio(row.bounces ?? 0, p.sessions);
  }
  const jp: SqlValue[] = [];
  const join = noFilters
    ? ''
    : `JOIN sessions x ON x.id = t.session_id AND ${filterSql(r.filters, 'x', jp)}`;
  const fill = (
    sql: string,
    set: (p: AnalyticsPoint, n: number) => void,
    extra: SqlValue[] = [],
  ): void => {
    for (const row of db.all<PointRow>(sql, ...jp, ...extra)) {
      const p = points[row.i];
      if (p !== undefined) set(p, row.n ?? 0);
    }
  };
  fill(
    `${cte} SELECT b.i AS i, COUNT(*) AS n FROM b JOIN pageviews t ON t.ts >= b.s AND t.ts < b.e ${join} GROUP BY b.i`,
    (p, n) => (p.pageviews = n),
  );
  fill(
    `${cte} SELECT b.i AS i, COUNT(*) AS n FROM b JOIN goals t ON t.ts >= b.s AND t.ts < b.e ${join} GROUP BY b.i`,
    (p, n) => (p.goals = n),
  );
  fill(
    `${cte} SELECT b.i AS i, SUM(t.amount_minor - t.refunded_minor) AS n FROM b
     JOIN payments t ON t.ts >= b.s AND t.ts < b.e ${join}
     WHERE t.refunded = 0 AND t.currency = ? GROUP BY b.i`,
    (p, n) => (p.revenue_minor = n),
    [currency],
  );
  return { interval, timezone: r.timeZone, source: 'raw', points };
}

/** Top values of a dimension, ordered by visitors (or hits for bots). */
export function breakdown(
  db: SqlDb,
  r: ResolvedRange,
  dimension: AnalyticsBreakdownDimension,
  limit: number,
  currency?: string,
): AnalyticsBreakdown {
  const rows: AnalyticsBreakdownRow[] = [];
  if (isSessionDimension(dimension)) {
    const column = SESSION_COLUMNS[dimension];
    const params: SqlValue[] = [r.from, r.to];
    const where = filterSql(r.filters, 's', params);
    // Revenue of the period by the value of its purchase session (same total as the overview).
    const revenueParams: SqlValue[] = [];
    const revenueWhere = filterSql(r.filters, 's', revenueParams);
    const revenueByValue = new Map<string | null, number>();
    if (currency !== undefined) {
      for (const row of db.all<{ value: string | null; revenue: number }>(
        `SELECT s.${column} AS value, SUM(t.amount_minor - t.refunded_minor) AS revenue
         FROM payments t JOIN sessions s ON s.id = ${PURCHASE_SESSION_SQL}
         WHERE t.ts >= ? AND t.ts < ? AND t.refunded = 0 AND t.currency = ? AND ${revenueWhere}
         GROUP BY s.${column}`,
        r.from,
        r.to,
        currency,
        ...revenueParams,
      )) {
        revenueByValue.set(row.value, row.revenue);
      }
    }
    for (const row of db.all<{
      value: string | null;
      visitors: number;
      sessions: number;
      pageviews: number;
      bounces: number;
      duration: number;
      revenue: number;
    }>(
      `SELECT s.${column} AS value, COUNT(DISTINCT s.visitor_id) AS visitors, COUNT(*) AS sessions,
         SUM(s.pageviews) AS pageviews, SUM(s.bounce) AS bounces, SUM(s.duration_ms) AS duration,
         SUM(s.revenue_minor) AS revenue
       FROM sessions s WHERE s.started_at >= ? AND s.started_at < ? AND ${where}
       GROUP BY s.${column} ORDER BY visitors DESC, sessions DESC, value LIMIT ?`,
      ...params,
      limit,
    )) {
      if (currency !== undefined) row.revenue = revenueByValue.get(row.value) ?? 0;
      rows.push({
        value: row.value,
        visitors: row.visitors,
        sessions: row.sessions,
        pageviews: row.pageviews,
        bounce_rate: ratio(row.bounces, row.sessions),
        avg_session_duration_ms: row.sessions === 0 ? 0 : Math.round(row.duration / row.sessions),
        revenue_minor: row.revenue,
      });
    }
    return { dimension, rows };
  }

  if (dimension === 'bot' || dimension === 'bot_category') {
    const column = dimension === 'bot' ? 'bot' : 'category';
    const fromDay = new Date(r.from).toISOString().slice(0, 10);
    const toDay = new Date(r.to - 1).toISOString().slice(0, 10);
    for (const row of db.all<{ value: string; hits: number }>(
      `SELECT ${column} AS value, SUM(hits) AS hits FROM bot_hits WHERE day >= ? AND day <= ?
       GROUP BY ${column} ORDER BY hits DESC, value LIMIT ?`,
      fromDay,
      toDay,
      limit,
    )) {
      rows.push({ value: row.value, visitors: 0, hits: row.hits });
    }
    return { dimension, rows };
  }

  const [table, column, metric] =
    dimension === 'page'
      ? (['pageviews', 'path', 'pageviews'] as const)
      : dimension === 'goal'
        ? (['goals', 'name', 'completions'] as const)
        : (['exit_links', 'url', 'hits'] as const);
  const jp: SqlValue[] = [];
  const join =
    r.filters.length === 0
      ? ''
      : `JOIN sessions s ON s.id = t.session_id AND ${filterSql(r.filters, 's', jp)}`;
  for (const row of db.all<{ value: string; visitors: number; n: number }>(
    `SELECT t.${column} AS value, COUNT(DISTINCT t.visitor_id) AS visitors, COUNT(*) AS n FROM ${table} t ${join}
     WHERE t.ts >= ? AND t.ts < ? GROUP BY t.${column} ORDER BY visitors DESC, n DESC, value LIMIT ?`,
    ...jp,
    r.from,
    r.to,
    limit,
  )) {
    rows.push({ value: row.value, visitors: row.visitors, [metric]: row.n });
  }
  return { dimension, rows };
}
