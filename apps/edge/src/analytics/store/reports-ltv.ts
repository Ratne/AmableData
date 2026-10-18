import { LTV_WINDOWS, type LtvReport, type LtvRow, type ltvQuerySchema } from '@amable/api-types';
import type { z } from 'zod';
import { DAY_MS } from '../time';
import { costRows, labelOf, type PerformanceContext } from './reports-performance';
import { customersJoinedIn, type TouchPoint } from './reports-shared';

/**
 * Lifetime value per source / campaign / platform: customers whose first
 * arrival touch (join date) falls in the range, grouped by that touch
 * (`first_click`) or by the last arrival before their first sale
 * (`last_click`); revenue of each window counts the sales made within N days
 * of the join. Cost is the cost of the group over the range.
 */
export function ltvReport(ctx: PerformanceContext, q: z.output<typeof ltvQuerySchema>): LtvReport {
  const { window: w } = ctx;
  const keyOf = (t: TouchPoint): string | null => {
    if (q.group_by === 'campaign') return t.campaign;
    if (q.group_by === 'platform')
      return t.source === null ? null : (ctx.sources.get(t.source)?.platform ?? null);
    return t.source;
  };
  const groups = new Map<string | null, { customers: number; revenue: number[] }>();
  for (const c of customersJoinedIn(ctx.db, ctx.groups, w.from, w.to, ctx.currency)) {
    const key = keyOf(q.model === 'first_click' ? c.join : c.lastBeforeSale);
    const g = groups.get(key) ?? { customers: 0, revenue: LTV_WINDOWS.map(() => 0) };
    g.customers += 1;
    LTV_WINDOWS.forEach((days, i) => {
      const end = c.join.ts + days * DAY_MS;
      for (const s of c.sales) if (s.ts < end) g.revenue[i] = (g.revenue[i] ?? 0) + s.amount;
    });
    groups.set(key, g);
  }
  const cost = costRows(ctx, { groupBy: q.group_by, filters: [] });
  for (const key of cost.byKey.keys()) {
    if (!groups.has(key)) groups.set(key, { customers: 0, revenue: LTV_WINDOWS.map(() => 0) });
  }
  const rows: LtvRow[] = [...groups.entries()].map(([key, g]) => ({
    key,
    label: labelOf(ctx, q.group_by, key, new Map()),
    customers: g.customers,
    cost_minor: cost.byKey.get(key)?.cost ?? 0,
    ltv_minor: Object.fromEntries(
      LTV_WINDOWS.map((days, i) => [
        String(days),
        g.customers === 0 ? 0 : Math.round((g.revenue[i] ?? 0) / g.customers),
      ]),
    ),
    revenue_minor: Object.fromEntries(
      LTV_WINDOWS.map((days, i) => [String(days), g.revenue[i] ?? 0]),
    ),
  }));
  const last = String(LTV_WINDOWS[LTV_WINDOWS.length - 1]);
  rows.sort(
    (a, b) =>
      b.customers - a.customers ||
      (b.revenue_minor[last] ?? 0) - (a.revenue_minor[last] ?? 0) ||
      (a.key === null ? 1 : b.key === null ? -1 : a.key < b.key ? -1 : 1),
  );
  return { currency: ctx.currency, windows: [...LTV_WINDOWS], rows };
}
