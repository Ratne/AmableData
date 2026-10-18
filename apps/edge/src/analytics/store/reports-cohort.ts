import {
  COHORT_OFFSETS,
  type CohortReport,
  type PerformanceFilter,
  type cohortQuerySchema,
} from '@amable/api-types';
import type { z } from 'zod';
import { buckets, DAY_MS, dayStart } from '../time';
import { costRows, type PerformanceContext } from './reports-performance';
import { customersJoinedIn, round4 } from './reports-shared';

/**
 * Acquisition cohorts: customers bucketed by the week (Monday) or month of
 * their first arrival touch, optionally from one source or platform. Revenue
 * at offset N is cumulative over the first N days of each customer (offset 0
 * = the first 24 hours); ROI compares it with the cost of the cohort period.
 */
export function cohortReport(
  ctx: PerformanceContext,
  q: z.output<typeof cohortQuerySchema>,
): CohortReport {
  const { window: w } = ctx;
  const periods = buckets(w.from, w.to, q.granularity, w.timeZone);
  const indexOf = (ts: number): number => periods.findIndex((p) => ts >= p.start && ts < p.end);
  const acc = periods.map(() => ({ customers: 0, cost: 0, revenue: COHORT_OFFSETS.map(() => 0) }));
  for (const c of customersJoinedIn(ctx.db, ctx.groups, w.from, w.to, ctx.currency)) {
    const source = c.join.source === null ? undefined : ctx.sources.get(c.join.source);
    if (q.traffic_source_id !== undefined && c.join.source !== q.traffic_source_id) continue;
    if (q.platform !== undefined && source?.platform !== q.platform) continue;
    const slot = acc[indexOf(c.join.ts)];
    if (slot === undefined) continue;
    slot.customers += 1;
    COHORT_OFFSETS.forEach((offset, i) => {
      const end = c.join.ts + Math.max(offset, 1) * DAY_MS;
      for (const s of c.sales) if (s.ts < end) slot.revenue[i] = (slot.revenue[i] ?? 0) + s.amount;
    });
  }
  const filters: PerformanceFilter[] = [];
  if (q.traffic_source_id !== undefined)
    filters.push({ dimension: 'source', value: q.traffic_source_id });
  if (q.platform !== undefined) filters.push({ dimension: 'platform', value: q.platform });
  for (const [day, row] of costRows(ctx, { groupBy: 'day', filters }).byKey) {
    if (day === null) continue;
    const slot = acc[indexOf(dayStart(day, w.timeZone))];
    if (slot !== undefined) slot.cost += row.cost;
  }
  return {
    currency: ctx.currency,
    granularity: q.granularity,
    offsets: [...COHORT_OFFSETS],
    rows: periods.map((p, i) => {
      const a = acc[i] ?? { customers: 0, cost: 0, revenue: [] };
      return {
        cohort: p.label,
        customers: a.customers,
        cost_minor: a.cost,
        revenue_minor: Object.fromEntries(
          COHORT_OFFSETS.map((o, k) => [String(o), a.revenue[k] ?? 0]),
        ),
        roi: Object.fromEntries(
          COHORT_OFFSETS.map((o, k) => [
            String(o),
            a.cost === 0 ? null : round4(((a.revenue[k] ?? 0) - a.cost) / a.cost),
          ]),
        ),
      };
    }),
  };
}
