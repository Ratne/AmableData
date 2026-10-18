import type { CohortQuery, CohortReport, LtvQuery, LtvReport } from '@amable/api-types';
import { beforeAll, describe, expect, it } from 'vitest';
import { createStore, siteInit, SITE_ID } from './helpers';
import { createSources, D, DAY, insertPayment, touch } from './reports-fixture';

type Store = ReturnType<typeof createStore>['store'];

/**
 * - a: Meta m1 D2, Google g1 D7 → CRM payments 1000 (+10 d), 2000 (+50 d), 3000 (+100 d)
 * - b: Meta m1 D5 → sale 500 (+20 d)
 * - c: Google g1 D3 (cost 70) → sales 100 (+2 h) and 4000 (+80 d)
 * - d: Meta m1 D4, never buys
 * - e: Meta m1 Sep 20 (joined before October) → sale 800 (+15 d)
 * Spend: m1 1000 on Oct 2, 300 on Sep 20.
 */
function seed(): Store {
  const { store, db } = createStore();
  store.initSite(siteInit());
  const { meta, google } = createSources(store);
  const touches = [
    touch('a', D(2), meta, 'm1'),
    touch('a', D(7), google, 'g1'),
    touch('b', D(5), meta, 'm1'),
    touch('c', D(3), google, 'g1', { cost_minor: 70 }),
    touch('d', D(4), meta, 'm1'),
    touch('e', D(-10), meta, 'm1'),
  ];
  store.recordTouches(touches);
  const hit = (v: string): string => touches.find((t) => t.visitor_id === v)?.id ?? '';
  insertPayment(db, { tx: 'pa1', visitor: 'a', ts: D(2) + 10 * DAY, amount: 1000 });
  insertPayment(db, { tx: 'pa2', visitor: 'a', ts: D(2) + 50 * DAY, amount: 2000 });
  insertPayment(db, { tx: 'pa3', visitor: 'a', ts: D(2) + 100 * DAY, amount: 3000 });
  store.recordConversionFromPostback({
    hit: hit('b'),
    tx: 'b1',
    revenue_minor: 500,
    ts: D(5) + 20 * DAY,
  });
  store.recordConversionFromPostback({
    hit: hit('c'),
    tx: 'c1',
    revenue_minor: 100,
    ts: D(3) + 2 * 3_600_000,
  });
  store.recordConversionFromPostback({
    hit: hit('c'),
    tx: 'c2',
    revenue_minor: 4000,
    ts: D(3) + 80 * DAY,
  });
  store.recordConversionFromPostback({
    hit: hit('e'),
    tx: 'e1',
    revenue_minor: 800,
    ts: D(-10) + 15 * DAY,
  });
  store.upsertAdSpend([
    { platform: 'meta', entity_external_id: 'm1', day: '2026-10-02', spend_minor: 1000 },
    { platform: 'meta', entity_external_id: 'm1', day: '2026-09-20', spend_minor: 300 },
  ]);
  return store;
}

const windows = (values: number[]): Record<string, number> =>
  Object.fromEntries([30, 60, 90, 180, 365].map((w, i) => [String(w), values[i] ?? 0]));

describe('LTV report', () => {
  let store: Store;
  beforeAll(() => {
    store = seed();
  });
  const ltv = (q: Partial<LtvQuery> = {}): LtvReport => {
    const r = store.adsLtvReport({ site_id: SITE_ID, from: '2026-10-01', to: '2026-10-31', ...q });
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  };

  it('accumulates revenue within 30…365 days of the join date (first click)', () => {
    const report = ltv();
    expect(report.windows).toEqual([30, 60, 90, 180, 365]);
    expect(
      report.rows.map((r) => ({
        label: r.label,
        customers: r.customers,
        cost: r.cost_minor,
        rev: r.revenue_minor,
        ltv: r.ltv_minor,
      })),
    ).toEqual([
      {
        label: 'Meta Ads',
        customers: 2,
        cost: 1000,
        // a: 1000 at 10 days, 2000 at 50, 3000 at 100; b: 500 at 20
        rev: windows([1500, 3500, 3500, 6500, 6500]),
        ltv: windows([750, 1750, 1750, 3250, 3250]),
      },
      {
        label: 'Google Ads',
        customers: 1,
        cost: 70,
        rev: windows([100, 100, 4100, 4100, 4100]),
        ltv: windows([100, 100, 4100, 4100, 4100]),
      },
    ]);
    const meta = report.rows[0];
    expect((meta?.ltv_minor['90'] ?? 0) - (meta?.ltv_minor['30'] ?? 0)).toBe(1000);
  });

  it('groups by the last touch before the first sale with last_click', () => {
    const report = ltv({ model: 'last_click' });
    expect(
      report.rows.map((r) => [r.label, r.customers, r.revenue_minor['30'], r.revenue_minor['90']]),
    ).toEqual([
      ['Google Ads', 2, 1100, 7100],
      ['Meta Ads', 1, 500, 500],
    ]);
  });

  it('groups by platform and campaign', () => {
    expect(ltv({ group_by: 'platform' }).rows.map((r) => [r.key, r.customers])).toEqual([
      ['meta', 2],
      ['google', 1],
    ]);
    expect(
      ltv({ group_by: 'campaign' }).rows.map((r) => [r.key, r.customers, r.cost_minor]),
    ).toEqual([
      ['m1', 2, 1000],
      ['g1', 1, 70],
    ]);
  });
});

describe('cohort report', () => {
  let store: Store;
  beforeAll(() => {
    store = seed();
  });
  const cohorts = (q: Partial<CohortQuery> = {}): CohortReport => {
    const r = store.adsCohortReport({
      site_id: SITE_ID,
      from: '2026-09-01',
      to: '2026-10-31',
      ...q,
    });
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  };
  const offsets = (values: Array<number | null>): Record<string, number | null> =>
    Object.fromEntries([0, 30, 60, 90].map((o, i) => [String(o), values[i] ?? null]));

  it('reports cumulative revenue and ROI per offset for monthly cohorts', () => {
    const report = cohorts();
    expect(report.offsets).toEqual([0, 30, 60, 90]);
    expect(report.rows).toEqual([
      {
        cohort: '2026-09-01',
        customers: 1,
        cost_minor: 300,
        revenue_minor: offsets([0, 800, 800, 800]),
        roi: offsets([-1, 1.6667, 1.6667, 1.6667]),
      },
      {
        cohort: '2026-10-01',
        customers: 3,
        cost_minor: 1070,
        // c's 100 within the first day; a's 3000 at 100 days falls outside 90
        revenue_minor: offsets([100, 1600, 3600, 7600]),
        roi: offsets([-0.9065, 0.4953, 2.3645, 6.1028]),
      },
    ]);
  });

  it('filters the cohorts by platform of the first touch', () => {
    const report = cohorts({ platform: 'meta' });
    expect(
      report.rows.map((r) => [r.cohort, r.customers, r.cost_minor, r.revenue_minor['30']]),
    ).toEqual([
      ['2026-09-01', 1, 300, 800],
      ['2026-10-01', 2, 1000, 1500],
    ]);
  });

  it('buckets weeks from Monday', () => {
    const report = cohorts({ granularity: 'week' });
    expect(report.rows.map((r) => r.cohort)).toEqual([
      '2026-08-31',
      '2026-09-07',
      '2026-09-14',
      '2026-09-21',
      '2026-09-28',
      '2026-10-05',
      '2026-10-12',
      '2026-10-19',
      '2026-10-26',
    ]);
    expect(report.rows.filter((r) => r.customers > 0).map((r) => [r.cohort, r.customers])).toEqual([
      ['2026-09-14', 1],
      ['2026-09-28', 2],
      ['2026-10-05', 1],
    ]);
  });
});
