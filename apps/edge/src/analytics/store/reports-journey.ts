import {
  JOURNEY_MAX_STEPS,
  type JourneyReport,
  type JourneyRow,
  type TrackingQuality,
  type journeyQuerySchema,
} from '@amable/api-types';
import { z } from 'zod';
import { DAY_MS } from '../time';
import type { PerformanceContext } from './reports-performance';
import {
  pathsOf,
  revenueEvents,
  round4,
  type PersonKey,
  type RevenueEvent,
  type TouchPoint,
} from './reports-shared';

/**
 * Aggregated journeys: one path per person (merged visitors and CRM contact
 * together) with a touch in the range, from the first touch up to the first
 * sale (or every touch when the person never bought). Consecutive touches
 * with the same step collapse into one step; the 30 latest steps are kept.
 * Steps are labels (source name, campaign name / id, node id); `''` marks a
 * touch without a value.
 */
export function journeyReport(
  ctx: PerformanceContext,
  q: z.output<typeof journeyQuerySchema>,
): JourneyReport {
  const { window: w } = ctx;
  const kinds = q.step === 'node' ? 'all' : 'arrivals';
  const persons = new Set<PersonKey>();
  for (const r of ctx.db.all<{ visitor_id: string }>(
    `SELECT DISTINCT visitor_id FROM touches WHERE ts >= ? AND ts < ? ${kinds === 'arrivals' ? `AND kind = 'entrance'` : ''}`,
    w.from,
    w.to,
  )) {
    const p = ctx.groups.personOf(r.visitor_id);
    if (p !== null) persons.add(p);
  }
  const paths = pathsOf(ctx.db, ctx.groups, persons, {
    until: Number.MAX_SAFE_INTEGER,
    kinds,
    nodes: q.step === 'node',
  });
  let earliest = Number.MAX_SAFE_INTEGER;
  for (const path of paths.values()) earliest = Math.min(earliest, path[0]?.ts ?? earliest);
  const sales = new Map<PersonKey, RevenueEvent[]>();
  for (const e of revenueEvents(
    ctx.db,
    ctx.groups,
    earliest,
    Number.MAX_SAFE_INTEGER,
    ctx.currency,
  )) {
    if (e.kind !== 'sale' || e.person === null || !paths.has(e.person)) continue;
    const list = sales.get(e.person) ?? [];
    list.push(e);
    sales.set(e.person, list);
  }
  const stepOf = (t: TouchPoint): string => {
    if (q.step === 'node') return t.node ?? '';
    if (q.step === 'campaign')
      return t.campaign === null ? '' : (ctx.entities.name(t.campaign) ?? t.campaign);
    return t.source === null ? '' : (ctx.sources.get(t.source)?.name ?? t.source);
  };
  const rows = new Map<string, JourneyRow & { days: number[] }>();
  for (const [person, path] of paths) {
    const start = path[0];
    if (start === undefined) continue;
    const bought = (sales.get(person) ?? []).filter((s) => s.ts >= start.ts);
    const firstSale = bought[0];
    if (q.converted_only && firstSale === undefined) continue;
    const steps: string[] = [];
    for (const t of path) {
      if (firstSale !== undefined && t.ts > firstSale.ts) break;
      const step = stepOf(t);
      if (steps[steps.length - 1] !== step) steps.push(step);
    }
    const kept = steps.slice(-JOURNEY_MAX_STEPS);
    const id = JSON.stringify(kept);
    const row = rows.get(id) ?? {
      steps: kept,
      visitors: 0,
      conversions: 0,
      revenue_minor: 0,
      avg_days_to_convert: null,
      days: [],
    };
    row.visitors += 1;
    row.conversions += bought.length;
    row.revenue_minor += bought.reduce((a, s) => a + s.amount, 0);
    if (firstSale !== undefined) row.days.push((firstSale.ts - start.ts) / DAY_MS);
    rows.set(id, row);
  }
  const out = [...rows.entries()]
    .sort(
      ([ka, a], [kb, b]) =>
        b.revenue_minor - a.revenue_minor ||
        b.conversions - a.conversions ||
        b.visitors - a.visitors ||
        (ka < kb ? -1 : 1),
    )
    .slice(0, q.limit)
    .map(([, { days, ...r }]) => ({
      ...r,
      avg_days_to_convert:
        days.length === 0
          ? null
          : Math.round((days.reduce((a, b) => a + b, 0) / days.length) * 100) / 100,
    }));
  return { currency: ctx.currency, rows: out };
}

const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Range of {@link trackingQuality}; `site_id` is accepted and ignored (the DO is the site). */
export const trackingQualityQuerySchema = z.object({
  site_id: z.string().max(64).optional(),
  from: daySchema,
  to: daySchema,
  timezone: z.string().max(64).optional(),
});
export type TrackingQualityQuery = z.input<typeof trackingQualityQuerySchema>;

/**
 * Share of the conversions of the range (sales and leads, conversion log and
 * payments) whose person is identified (CRM contact, email or phone), has a
 * platform click id (funnel touch or tracked session) and has a funnel touch
 * before the conversion. `score` is the mean of the three shares.
 */
export function trackingQuality(ctx: PerformanceContext): TrackingQuality {
  const { window: w } = ctx;
  const events = revenueEvents(ctx.db, ctx.groups, w.from, w.to, ctx.currency);
  if (events.length === 0)
    return { conversions: 0, with_identity: 0, with_click_id: 0, with_touch: 0, score: 0 };
  const persons = new Set(events.map((e) => e.person).filter((p): p is PersonKey => p !== null));
  const until = events.reduce((m, e) => Math.max(m, e.ts), 0);
  const paths = pathsOf(ctx.db, ctx.groups, persons, { until, kinds: 'all', clickIds: true });
  const visitors = [...persons].flatMap((p) => ctx.groups.visitorsOf(p));
  const json = JSON.stringify(visitors);
  const identified = new Set(
    ctx.db
      .all<{ v: string }>(
        `SELECT visitor_id AS v FROM identity_keys WHERE key_type IN ('email', 'phone') AND visitor_id IN (SELECT value FROM json_each(?))
         UNION SELECT id FROM visitors WHERE id IN (SELECT value FROM json_each(?)) AND (email IS NOT NULL OR contact_id IS NOT NULL)`,
        json,
        json,
      )
      .map((r) => r.v),
  );
  const clickSince = new Map(
    ctx.db
      .all<{ v: string; ts: number }>(
        `SELECT visitor_id AS v, MIN(started_at) AS ts FROM sessions
         WHERE click_ids IS NOT NULL AND visitor_id IN (SELECT value FROM json_each(?)) GROUP BY visitor_id`,
        json,
      )
      .map((r) => [r.v, r.ts] as const),
  );
  let withIdentity = 0;
  let withClickId = 0;
  let withTouch = 0;
  for (const e of events) {
    const members = e.person === null ? [] : ctx.groups.visitorsOf(e.person);
    if (
      e.contactId !== null ||
      e.person?.startsWith('c:') === true ||
      members.some((v) => identified.has(v))
    ) {
      withIdentity += 1;
    }
    const before =
      (e.person === null ? undefined : paths.get(e.person))?.filter((t) => t.ts <= e.ts) ?? [];
    if (before.length > 0) withTouch += 1;
    if (
      before.some((t) => t.clickId !== null && t.clickId !== undefined) ||
      members.some((v) => (clickSince.get(v) ?? Infinity) <= e.ts)
    ) {
      withClickId += 1;
    }
  }
  const n = events.length;
  return {
    conversions: n,
    with_identity: withIdentity,
    with_click_id: withClickId,
    with_touch: withTouch,
    score: round4((withIdentity + withClickId + withTouch) / (3 * n)),
  };
}
