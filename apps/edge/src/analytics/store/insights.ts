import type { AnalyticsInsights, InsightsSegmentRow, TimeToConversion } from '@amable/api-types';
import { first, type SqlDb, type SqlValue } from '../db/sql';
import { buckets, DAY_MS, HOUR_MS, localParts } from '../time';
import { conversionsIn, personKey, touchesOf, type PersonKey, type TouchRow } from './attribution';
import { filterSql, type ResolvedRange } from './query';

const ratio = (a: number, b: number): number =>
  b === 0 ? 0 : Math.round((a / b) * 10_000) / 10_000;

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 1
      ? (sorted[mid] ?? 0)
      : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  return Math.round(value * 100) / 100;
}

function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;
}

/** Histogram over labelled closed ranges (`max` inclusive, null = unbounded). */
export function histogram(
  values: readonly number[],
  ranges: ReadonlyArray<[label: string, max: number | null]>,
): Array<{ bucket: string; customers: number }> {
  const out = ranges.map(([bucket]) => ({ bucket, customers: 0 }));
  for (const v of values) {
    const i = ranges.findIndex(([, max]) => max === null || v <= max);
    const slot = out[i === -1 ? out.length - 1 : i];
    if (slot !== undefined) slot.customers += 1;
  }
  return out;
}

const VISIT_BUCKETS: ReadonlyArray<[string, number | null]> = [
  ['1', 1],
  ['2', 2],
  ['3', 3],
  ['4-5', 5],
  ['6-10', 10],
  ['11+', null],
];

const DAY_BUCKETS: ReadonlyArray<[string, number | null]> = [
  ['0', 0.999_999],
  ['1', 1.999_999],
  ['2-3', 3.999_999],
  ['4-7', 7.999_999],
  ['8-14', 14.999_999],
  ['15-30', 30.999_999],
  ['31+', null],
];

/** Monday = 0 … Sunday = 6, plus the local hour. */
export function localDayHour(ts: number, timeZone: string): { day: number; hour: number } {
  const p = localParts(ts, timeZone);
  const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  return { day: (dow + 6) % 7, hour: p.hour % 24 };
}

/** First revenue payment of each person (all time, site currency). */
function firstPurchases(db: SqlDb, currency: string, until: number): Map<PersonKey, number> {
  const out = new Map<PersonKey, number>();
  for (const row of db.all<{ contact_id: string | null; visitor_id: string | null; ts: number }>(
    `SELECT COALESCE(v.contact_id, t.contact_id) AS contact_id, t.visitor_id AS visitor_id, MIN(t.ts) AS ts
     FROM payments t LEFT JOIN visitors v ON v.id = t.visitor_id
     WHERE t.free_trial = 0 AND t.currency = ? AND t.ts < ?
     GROUP BY COALESCE(v.contact_id, t.contact_id), t.visitor_id`,
    currency,
    until,
  )) {
    const key = personKey(row.contact_id, row.visitor_id);
    if (key === null) continue;
    const prev = out.get(key);
    if (prev === undefined || row.ts < prev) out.set(key, row.ts);
  }
  return out;
}

/** Sessions before (and including) a purchase, days and hours from the first visit. */
export function timeToConversion(
  touches: readonly TouchRow[],
  firstSeen: number | null,
  firstPurchaseAt: number | null,
): TimeToConversion {
  const start = Math.min(firstSeen ?? Number.POSITIVE_INFINITY, touches[0]?.started_at ?? Number.POSITIVE_INFINITY);
  const startTs = Number.isFinite(start) ? start : null;
  if (firstPurchaseAt === null || startTs === null) {
    return {
      first_seen: startTs === null ? null : new Date(startTs).toISOString(),
      first_purchase_at: firstPurchaseAt === null ? null : new Date(firstPurchaseAt).toISOString(),
      sessions_before_purchase: null,
      days_to_purchase: null,
      hours_to_purchase: null,
    };
  }
  const elapsed = Math.max(0, firstPurchaseAt - startTs);
  return {
    first_seen: new Date(startTs).toISOString(),
    first_purchase_at: new Date(firstPurchaseAt).toISOString(),
    sessions_before_purchase: Math.max(1, touches.filter((t) => t.started_at <= firstPurchaseAt).length),
    days_to_purchase: Math.round((elapsed / DAY_MS) * 100) / 100,
    hours_to_purchase: Math.round((elapsed / HOUR_MS) * 100) / 100,
  };
}

type SegmentKey = 'device' | 'os' | 'browser' | 'country';

/**
 * Insights of a range: revenue and conversion per device / OS / browser /
 * country (the segment of the person's last session before each payment),
 * visits and time before the first purchase, most converting goals, the
 * weekday × hour heatmap of purchases and revenue per visitor over time.
 */
export function insights(
  db: SqlDb,
  r: ResolvedRange,
  currency: string,
  interval: 'week' | 'month',
): AnalyticsInsights {
  const params: SqlValue[] = [r.from, r.to];
  const where = filterSql(r.filters, 's', params);
  const visitors =
    first<{ n: number }>(
      db,
      `SELECT COUNT(DISTINCT s.visitor_id) AS n FROM sessions s WHERE s.started_at >= ? AND s.started_at < ? AND ${where}`,
      ...params,
    )?.n ?? 0;

  const conversions = conversionsIn(db, r.from, r.to, currency);
  const persons = [...new Set(conversions.map((c) => c.person).filter((p): p is string => p !== null))];
  const touches = touchesOf(db, persons, { until: r.to });
  const filteredTouches =
    r.filters.length === 0 ? touches : touchesOf(db, persons, { until: r.to, filters: r.filters });
  const inScope = (p: PersonKey | null): p is PersonKey =>
    p !== null && (r.filters.length === 0 || (filteredTouches.get(p)?.length ?? 0) > 0);
  const scoped = conversions.filter((c) => r.filters.length === 0 || inScope(c.person));
  const revenue = scoped.reduce((a, c) => a + c.amount, 0);

  // --- segments
  const segments: Record<SegmentKey, Map<string | null, { revenue: number; customers: Set<string> }>> = {
    device: new Map(),
    os: new Map(),
    browser: new Map(),
    country: new Map(),
  };
  for (const c of scoped) {
    const list = c.person === null ? [] : (touches.get(c.person) ?? []);
    const last = [...list].reverse().find((t) => t.started_at <= c.ts);
    for (const key of Object.keys(segments) as SegmentKey[]) {
      const value = last === undefined ? null : last[key];
      const map = segments[key];
      const cur = map.get(value) ?? { revenue: 0, customers: new Set<string>() };
      cur.revenue += c.amount;
      if (c.person !== null) cur.customers.add(c.person);
      map.set(value, cur);
    }
  }
  const visitorsBy = (column: SegmentKey): Map<string | null, number> => {
    const p: SqlValue[] = [r.from, r.to];
    const w = filterSql(r.filters, 's', p);
    return new Map(
      db
        .all<{ value: string | null; n: number }>(
          `SELECT s.${column} AS value, COUNT(DISTINCT s.visitor_id) AS n FROM sessions s
           WHERE s.started_at >= ? AND s.started_at < ? AND ${w} GROUP BY s.${column}`,
          ...p,
        )
        .map((row) => [row.value, row.n]),
    );
  };
  const segmentRows = (key: SegmentKey): InsightsSegmentRow[] => {
    const v = visitorsBy(key);
    const values = new Set<string | null>([...v.keys(), ...segments[key].keys()]);
    return [...values].map((value) => {
      const seg = segments[key].get(value);
      const vis = v.get(value) ?? 0;
      const customers = seg?.customers.size ?? 0;
      return {
        value,
        visitors: vis,
        customers,
        revenue_minor: seg?.revenue ?? 0,
        conversion_rate: ratio(customers, Math.max(vis, customers)),
      };
    });
  };
  const byRevenue = (rows: InsightsSegmentRow[]): InsightsSegmentRow[] =>
    rows
      .filter((row) => row.revenue_minor > 0 || row.visitors > 0)
      .sort((a, b) => b.revenue_minor - a.revenue_minor || b.visitors - a.visitors)
      .slice(0, 20);
  const countries = segmentRows('country');

  // --- first purchases in range: visits / days / hours before purchase
  const firstAll = firstPurchases(db, currency, r.to);
  const firstSeen = new Map<PersonKey, number>();
  for (const p of persons) {
    const ids = p.startsWith('c:')
      ? db.all<{ first_seen: number }>(`SELECT first_seen FROM visitors WHERE contact_id = ?`, p.slice(2))
      : db.all<{ first_seen: number }>(`SELECT first_seen FROM visitors WHERE id = ?`, p.slice(2));
    const min = Math.min(...ids.map((row) => row.first_seen));
    if (Number.isFinite(min)) firstSeen.set(p, min);
  }
  const visits: number[] = [];
  const days: number[] = [];
  const hours: number[] = [];
  let customers = 0;
  for (const p of new Set(scoped.map((c) => c.person).filter(inScope))) {
    const at = firstAll.get(p);
    if (at === undefined || at < r.from || at >= r.to) continue;
    customers += 1;
    const ttc = timeToConversion(touches.get(p) ?? [], firstSeen.get(p) ?? null, at);
    if (ttc.sessions_before_purchase !== null) visits.push(ttc.sessions_before_purchase);
    if (ttc.days_to_purchase !== null) days.push(ttc.days_to_purchase);
    if (ttc.hours_to_purchase !== null) hours.push(ttc.hours_to_purchase);
  }

  // --- most converting goals: completers in range who paid afterwards
  const gp: SqlValue[] = [];
  const join =
    r.filters.length === 0 ? '' : `JOIN sessions s ON s.id = g.session_id AND ${filterSql(r.filters, 's', gp)}`;
  const goalRows = db.all<{ name: string; contact_id: string | null; visitor_id: string; ts: number }>(
    `SELECT g.name AS name, v.contact_id AS contact_id, g.visitor_id AS visitor_id, MIN(g.ts) AS ts
     FROM goals g JOIN visitors v ON v.id = g.visitor_id ${join}
     WHERE g.ts >= ? AND g.ts < ? AND g.name NOT IN ('payment', 'free_trial')
     GROUP BY g.name, g.visitor_id`,
    ...gp,
    r.from,
    r.to,
  );
  const paymentsByPerson = new Map<PersonKey, Array<{ ts: number; amount: number }>>();
  for (const c of conversionsIn(db, r.from, Number.MAX_SAFE_INTEGER, currency)) {
    if (c.person === null) continue;
    const list = paymentsByPerson.get(c.person) ?? [];
    list.push({ ts: c.ts, amount: c.amount });
    paymentsByPerson.set(c.person, list);
  }
  const goals = new Map<string, { visitors: Set<string>; customers: Set<string>; revenue: number }>();
  for (const row of goalRows) {
    const p = personKey(row.contact_id, row.visitor_id);
    if (p === null) continue;
    const g = goals.get(row.name) ?? { visitors: new Set(), customers: new Set(), revenue: 0 };
    if (!g.visitors.has(p)) {
      g.visitors.add(p);
      const after = (paymentsByPerson.get(p) ?? []).filter((x) => x.ts >= row.ts && x.ts < r.to);
      if (after.length > 0) {
        g.customers.add(p);
        g.revenue += after.reduce((a, x) => a + x.amount, 0);
      }
    }
    goals.set(row.name, g);
  }

  // --- heatmap of purchases (local time)
  const cells = new Map<string, number>();
  for (const c of scoped) {
    const { day, hour } = localDayHour(c.ts, r.timeZone);
    const key = `${day}:${hour}`;
    cells.set(key, (cells.get(key) ?? 0) + 1);
  }

  // --- revenue per visitor over time
  const list = buckets(r.from, r.to, interval, r.timeZone);
  const rpv = list.map((b) => {
    const p: SqlValue[] = [b.start, b.end];
    const w = filterSql(r.filters, 's', p);
    const v =
      first<{ n: number }>(
        db,
        `SELECT COUNT(DISTINCT s.visitor_id) AS n FROM sessions s WHERE s.started_at >= ? AND s.started_at < ? AND ${w}`,
        ...p,
      )?.n ?? 0;
    const rev = scoped.filter((c) => c.ts >= b.start && c.ts < b.end).reduce((a, c) => a + c.amount, 0);
    return {
      t: new Date(b.start).toISOString(),
      label: b.label,
      visitors: v,
      revenue_minor: rev,
      revenue_per_visitor_minor: v === 0 ? 0 : Math.round(rev / v),
    };
  });

  return {
    from: new Date(r.from).toISOString(),
    to: new Date(r.to).toISOString(),
    timezone: r.timeZone,
    currency,
    visitors,
    customers,
    revenue_minor: revenue,
    revenue_by_device: byRevenue(segmentRows('device')),
    revenue_by_os: byRevenue(segmentRows('os')),
    revenue_by_browser: byRevenue(segmentRows('browser')),
    top_countries_by_revenue: byRevenue(countries),
    top_countries_by_conversion: countries
      .filter((row) => row.visitors >= 1)
      .sort((a, b) => b.conversion_rate - a.conversion_rate || b.visitors - a.visitors)
      .slice(0, 20),
    visits_before_purchase: {
      median: median(visits),
      average: average(visits),
      buckets: histogram(visits, VISIT_BUCKETS),
    },
    days_before_purchase: {
      median: median(days),
      average: average(days),
      buckets: histogram(days, DAY_BUCKETS),
    },
    median_hours_to_purchase: median(hours),
    converting_events: [...goals]
      .map(([goal, g]) => ({
        goal,
        visitors: g.visitors.size,
        customers: g.customers.size,
        conversion_rate: ratio(g.customers.size, g.visitors.size),
        revenue_minor: g.revenue,
      }))
      .sort((a, b) => b.conversion_rate - a.conversion_rate || b.visitors - a.visitors || a.goal.localeCompare(b.goal))
      .slice(0, 20),
    heatmap: [...cells]
      .map(([key, conversions]) => {
        const [day, hour] = key.split(':').map(Number);
        return { day: day ?? 0, hour: hour ?? 0, conversions };
      })
      .sort((a, b) => a.day - b.day || a.hour - b.hour),
    revenue_per_visitor: rpv,
  };
}
