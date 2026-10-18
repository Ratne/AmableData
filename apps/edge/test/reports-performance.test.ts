import type {
  AttributionModelV2,
  PerformanceQuery,
  PerformanceReport,
  PerformanceRow,
} from '@amable/api-types';
import { beforeAll, describe, expect, it } from 'vitest';
import { entitySlots, modelWeights } from '../src/analytics/store/reports-shared';
import { createStore, siteInit, SITE_ID } from './helpers';
import { createSources, D, DAY, insertPayment, seedPerformanceFixture, touch } from './reports-fixture';

type Store = ReturnType<typeof createStore>['store'];

function run(store: Store, q: Partial<PerformanceQuery> = {}): PerformanceReport {
  const r = store.adsPerformanceReport({
    site_id: SITE_ID,
    from: '2026-10-01',
    to: '2026-10-31',
    ...q,
  });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

const byKey = (report: PerformanceReport): Map<string | null, PerformanceRow> =>
  new Map(report.rows.map((r) => [r.key, r] as const));

/** `[revenue, sales]` per campaign key. */
const credit = (report: PerformanceReport): Record<string, [number, number]> =>
  Object.fromEntries(report.rows.map((r) => [String(r.key), [r.revenue_minor, r.sales]]));

describe('attribution weights', () => {
  const t = (...agesInDays: number[]): number[] => agesInDays.map((a) => D(20) - a * DAY);

  it('covers the one- and two-touch cases of u_shaped', () => {
    expect(modelWeights(t(3), D(20), 'u_shaped', 7)).toEqual([1]);
    expect(modelWeights(t(3, 1), D(20), 'u_shaped', 7)).toEqual([0.5, 0.5]);
    expect(modelWeights(t(9, 6, 3, 1), D(20), 'u_shaped', 7)).toEqual([0.4, 0.1, 0.1, 0.4]);
    expect(modelWeights([], D(20), 'u_shaped', 7)).toEqual([]);
  });

  it('halves the time_decay weight every 7 days', () => {
    const w = modelWeights(t(14, 7, 0), D(20), 'time_decay', 7);
    expect(w.map((x) => x * 7)).toEqual([
      expect.closeTo(1, 12),
      expect.closeTo(2, 12),
      expect.closeTo(4, 12),
    ]);
  });

  it('switches windowed_hybrid from first to last click past the window (inclusive bound)', () => {
    expect(modelWeights(t(7, 0), D(20), 'windowed_hybrid', 7)).toEqual([1, 0]);
    expect(modelWeights(t(8, 0), D(20), 'windowed_hybrid', 7)).toEqual([0, 1]);
    expect(modelWeights(t(8, 0), D(20), 'windowed_hybrid', 10)).toEqual([1, 0]);
  });

  it('maps adset / ad fields by name or URL parameter', () => {
    const field = (slot: `c${number}`, name: string, url_param: string) => ({
      slot,
      name,
      url_param,
      source_token: '',
      append: true,
    });
    expect(
      entitySlots({ fields: [field('c4', 'Ad Set', 'x'), field('c2', 'creative_id', 'y')] }),
    ).toEqual({ adset: 'c4', ad: 'c2' });
    expect(
      entitySlots({ fields: [field('c1', 'grp', 'adgroupid'), field('c3', 'keyword', 'kw')] }),
    ).toEqual({ adset: 'c1', ad: null });
  });
});

describe('ads performance report (fixture: 20 visitors, 2 sources)', () => {
  let store: Store;
  beforeAll(() => {
    const created = createStore();
    store = created.store;
    seedPerformanceFixture(store, created.db);
  });

  it.each<[AttributionModelV2, Record<string, [number, number]>]>([
    ['last_click', { m1: [7500, 4], m2: [7000, 1], g1: [9000, 2], null: [600, 1] }],
    ['first_click', { m1: [11500, 4], m2: [4000, 1], g1: [8000, 2], null: [600, 1] }],
    // v01 thirds: 7000 = 2334 + 2333 + 2333 (the leftover unit goes to the first touch)
    ['linear', { m1: [8334, 3.833], m2: [4333, 0.833], g1: [10833, 2.333], null: [600, 1] }],
    // v01 40/20/40 = 2800 / 1400 / 2800; v02 and v05 have two touches: 50/50
    ['u_shaped', { m1: [8800, 3.9], m2: [4800, 0.9], g1: [9900, 2.2], null: [600, 1] }],
    // ages 14/7/0 days → 1/7, 2/7, 4/7; ages 7/0 → 1/3, 2/3; v05 ages 14/7 → 1333 / 2667
    ['time_decay', { m1: [7500, 3.81], m2: [5333, 0.905], g1: [10667, 2.286], null: [600, 1] }],
    // first click only when the first touch is ≤ 7 days old (v02), else last click
    ['windowed_hybrid', { m1: [4500, 3], m2: [7000, 1], g1: [12000, 3], null: [600, 1] }],
  ])('credits campaigns with %s', (model, expected) => {
    const report = run(store, { model, group_by: 'campaign' });
    expect(credit(report)).toEqual(expected);
    expect(report.totals.revenue_minor).toBe(24_100);
    expect(report.totals.total_revenue_minor).toBe(24_100);
    expect(report.totals.sales).toBe(8);
    expect(report.totals.leads).toBe(1);
  });

  it('joins spend and derives the money columns (last click)', () => {
    const report = run(store, { group_by: 'campaign' });
    const rows = byKey(report);
    expect(rows.get('m1')).toEqual({
      key: 'm1',
      label: 'Meta Prospecting',
      parent_key: 'meta',
      visits: 10,
      clicks: 0,
      cost_minor: 3000,
      revenue_minor: 7500,
      total_revenue_minor: 7500,
      profit_minor: 4500,
      hard_costs_minor: 500,
      net_profit_minor: 4000,
      roas: 2.5,
      roi: 1.5,
      sales: 4,
      leads: 0,
      new_leads: 0,
      returning_customers: 1,
      aov_minor: 1875,
      cpa_minor: 750,
      cvr: 0.4,
      reported_conversions: 3,
      reported_revenue_minor: 12_000,
      reported_vs_revenue_minor: -4500,
    });
    expect(rows.get('m2')).toMatchObject({
      cost_minor: 500,
      roas: 14,
      reported_revenue_minor: null,
      reported_vs_revenue_minor: null,
    });
    // Google touches carry a cost of 50, ignored: the synced spend wins.
    expect(rows.get('g1')).toMatchObject({
      label: 'Google Brand',
      visits: 10,
      cost_minor: 4000,
      leads: 1,
      new_leads: 1,
      reported_conversions: 1,
      reported_revenue_minor: 2000,
      reported_vs_revenue_minor: 7000,
    });
    expect(rows.get(null)).toMatchObject({
      visits: 0,
      cost_minor: 0,
      revenue_minor: 600,
      roas: null,
    });
    expect(report.totals).toMatchObject({
      visits: 22,
      cost_minor: 7500,
      revenue_minor: 24_100,
      reported_revenue_minor: 14_000,
    });
    expect(report.rows.map((r) => r.key)).toEqual(['g1', 'm1', 'm2', null]);
  });

  it('counts the full revenue of credited conversions in total_revenue_minor', () => {
    const rows = byKey(run(store, { model: 'linear', group_by: 'campaign' }));
    expect(rows.get('m1')?.total_revenue_minor).toBe(14_500);
    expect(rows.get('m2')?.total_revenue_minor).toBe(11_000);
  });

  it('groups by platform and source with the spend split by entrances', () => {
    expect(credit(run(store, { group_by: 'platform' }))).toEqual({
      meta: [14_500, 5],
      google: [9000, 2],
      null: [600, 1],
    });
    const sources = run(store, { group_by: 'source' });
    expect(sources.rows.map((r) => [r.label, r.parent_key, r.cost_minor, r.revenue_minor])).toEqual(
      [
        ['Meta Ads', 'meta', 3500, 14_500],
        ['Google Ads', 'google', 4000, 9000],
        [null, null, 0, 600],
      ],
    );
  });

  it('splits campaign spend over its adsets and drills down', () => {
    const adsets = byKey(run(store, { group_by: 'adset' }));
    // m1: 10 entrances, 3 with adset s1, 3 with s2, 4 without → 30% / 30% / 40%
    expect(adsets.get('m1-s1')).toMatchObject({
      label: 'Lookalike',
      parent_key: 'm1',
      visits: 3,
      cost_minor: 900,
      revenue_minor: 0,
    });
    expect(adsets.get('m1-s2')).toMatchObject({ cost_minor: 900, visits: 3 });
    expect(adsets.get(null)).toMatchObject({
      cost_minor: 1200 + 500 + 4000,
      revenue_minor: 24_100,
    });
    const drill = run(store, {
      group_by: 'adset',
      filters: [{ dimension: 'campaign', value: 'm1' }],
    });
    expect(drill.rows.map((r) => [r.key, r.cost_minor, r.revenue_minor, r.visits])).toEqual([
      [null, 1200, 7500, 4],
      ['m1-s1', 900, 0, 3],
      ['m1-s2', 900, 0, 3],
    ]);
    expect(drill.totals).toMatchObject({ cost_minor: 3000, revenue_minor: 7500, visits: 10 });
    const ads = byKey(run(store, { group_by: 'ad', platform: 'meta' }));
    expect(ads.get('m1-s1-a1')).toMatchObject({ parent_key: 'm1-s1', visits: 3, cost_minor: 900 });
  });

  it('reports by sale date or by click date', () => {
    const range = { from: '2026-10-01', to: '2026-10-09', group_by: 'campaign' as const };
    // Sales of Oct 1–9: v07 1000 (D3), v08 600 (D7), v03 2000 (D8), v04 lead (D6).
    expect(credit(run(store, { ...range, basis: 'sale_date' }))).toEqual({
      m1: [3000, 2],
      g1: [0, 0],
      null: [600, 1],
      m2: [0, 0],
    });
    // Clicks of Oct 1–9, whenever the sale: + v07 second sale, v04 CRM payment, v05 via its D8 click.
    const byClick = run(store, { ...range, basis: 'click_date' });
    expect(credit(byClick)).toEqual({ g1: [9000, 2], m1: [4500, 3], null: [600, 1], m2: [0, 0] });
    expect(byKey(byClick).get('g1')?.cost_minor).toBe(4000);
    expect(byKey(byClick).get('m1')?.cost_minor).toBe(1000);
    const days = byKey(run(store, { group_by: 'day', basis: 'click_date' }));
    expect(days.get('2026-10-02')).toMatchObject({
      revenue_minor: 2500,
      cost_minor: 1000,
      visits: 2,
    });
    const saleDays = byKey(run(store, { group_by: 'day', basis: 'sale_date' }));
    expect(saleDays.get('2026-10-12')?.revenue_minor).toBe(1500);
    expect(saleDays.get('2026-10-20')?.revenue_minor).toBe(5000);
  });

  it('validates the query and the range', () => {
    expect(
      store.adsPerformanceReport({
        site_id: SITE_ID,
        from: '2026-10-01',
        to: '2026-10-31',
        model: 'bogus' as AttributionModelV2,
      }),
    ).toMatchObject({ ok: false, error: { code: 'validation_failed' } });
    expect(
      store.adsPerformanceReport({ site_id: SITE_ID, from: '2026-10-31', to: '2026-10-01' }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_range' } });
    expect(
      createStore().store.adsPerformanceReport({
        site_id: SITE_ID,
        from: '2026-10-01',
        to: '2026-10-31',
      }),
    ).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });
});

describe('ads performance report without synced spend', () => {
  it('uses the touch cost and groups by funnel node with all funnel hits', () => {
    const { store } = createStore();
    store.initSite(siteInit());
    const { meta } = createSources(store);
    store.recordTouches([
      touch('a', D(2), meta, 'm1', { cost_minor: 25 }),
      touch('a', D(2) + 60_000, meta, 'm1', { kind: 'view', node_id: 'lander' }),
      touch('a', D(2) + 120_000, meta, 'm1', {
        kind: 'click',
        node_id: 'lander',
        action_number: 1,
      }),
      touch('a', D(2) + 180_000, meta, 'm1', { kind: 'view', node_id: 'offer' }),
      touch('b', D(3), meta, 'm1', { cost_minor: 25 }),
    ]);
    const offerHit = store.listTouchesByVisitor('a').at(-1)?.id ?? '';
    store.recordConversionFromPostback({
      hit: offerHit,
      tx: 'o1',
      revenue_minor: 900,
      ts: D(2) + 240_000,
    });
    const sources = run(store, { group_by: 'source' });
    expect(sources.rows[0]).toMatchObject({
      cost_minor: 50,
      visits: 2,
      clicks: 1,
      revenue_minor: 900,
      roas: 18,
    });
    const nodes = byKey(run(store, { group_by: 'node' }));
    expect(nodes.get('offer')).toMatchObject({ revenue_minor: 900, visits: 1 });
    expect(nodes.get('lander')).toMatchObject({ revenue_minor: 0, visits: 1, clicks: 1 });
    expect(nodes.get('traffic')).toMatchObject({ visits: 2, cost_minor: 50 });
    const firstNode = byKey(run(store, { group_by: 'node', model: 'first_click' }));
    expect(firstNode.get('traffic')?.revenue_minor).toBe(900);
  });
});

describe('ads performance report with spend synced at several levels', () => {
  it('reads one level per platform: no double counting, finer rows used when grouping finer', () => {
    const { store, db } = createStore();
    seedPerformanceFixture(store, db);
    store.upsertAdSpend([
      { platform: 'meta', entity_external_id: 'm1-s1', day: '2026-10-02', spend_minor: 400 },
      { platform: 'meta', entity_external_id: 'm1-s2', day: '2026-10-02', spend_minor: 600 },
      { platform: 'meta', entity_external_id: 'm1-s1', day: '2026-10-10', spend_minor: 800 },
      { platform: 'meta', entity_external_id: 'm1-s2', day: '2026-10-10', spend_minor: 1200 },
    ]);
    expect(byKey(run(store, { group_by: 'platform' })).get('meta')?.cost_minor).toBe(3500);
    expect(byKey(run(store, { group_by: 'campaign' })).get('m1')?.cost_minor).toBe(3000);
    const adsets = run(store, { group_by: 'adset', filters: [{ dimension: 'campaign', value: 'm1' }] });
    expect(adsets.rows.map((r) => [r.key, r.cost_minor])).toEqual([
      [null, 0],
      ['m1-s2', 1800],
      ['m1-s1', 1200],
    ]);
    expect(adsets.totals.cost_minor).toBe(3000);
  });
});

function setModifiers(store: Store, id: string, cost: number | null, revenue: number | null): void {
  const source = store.getTrafficSource(id);
  if (source === null) throw new Error('missing source');
  const { id: _id, status: _status, created_at: _c, updated_at: _u, ...body } = source;
  const r = store.updateTrafficSource(id, { ...body, cost_modifier_pct: cost, revenue_modifier_pct: revenue });
  if (!r.ok) throw new Error(r.error.message);
}

describe('traffic source cost / revenue modifiers', () => {
  it('leave the reported revenue and the stored touch cost alone', () => {
    const { store, db } = createStore();
    store.initSite(siteInit());
    const { meta, google } = createSources(store);
    setModifiers(store, meta, 20, -10);
    // Touch costs are stored already scaled by the cost modifier (entranceCostMinor): 25 + 20%.
    const touches = [
      touch('a', D(2), meta, 'm1', { cost_minor: 30 }),
      touch('b', D(2), meta, 'm1', { cost_minor: 30 }),
      touch('c', D(3), google, 'g1', { cost_minor: 40 }),
    ];
    store.recordTouches(touches);
    store.recordConversionFromPostback({ hit: touches[0]?.id ?? '', tx: 'o1', revenue_minor: 900, ts: D(4) });
    store.recordConversionFromPostback({ hit: touches[2]?.id ?? '', tx: 'o2', revenue_minor: 500, ts: D(4) });
    insertPayment(db, { tx: 'crm_1', visitor: 'b', ts: D(5), amount: 300 });
    const rows = byKey(run(store, { group_by: 'source' }));
    expect(rows.get(meta)).toMatchObject({
      cost_minor: 60,
      revenue_minor: 1200,
      total_revenue_minor: 1200,
      profit_minor: 1200 - 60,
      hard_costs_minor: 0,
      net_profit_minor: 1140,
      roas: 20,
    });
    expect(rows.get(google)).toMatchObject({ cost_minor: 40, revenue_minor: 500, hard_costs_minor: 0 });

    setModifiers(store, meta, null, null);
    expect(byKey(run(store, { group_by: 'source' })).get(meta)).toMatchObject({ cost_minor: 60, revenue_minor: 1200 });
  });

  it('apply the cost modifier to the synced spend, split or not', () => {
    const { store, db } = createStore();
    const { meta } = seedPerformanceFixture(store, db);
    setModifiers(store, meta, 10, null);
    const campaigns = byKey(run(store, { group_by: 'campaign' }));
    expect(campaigns.get('m1')?.cost_minor).toBe(3300);
    expect(campaigns.get('m2')?.cost_minor).toBe(550);
    expect(campaigns.get('g1')?.cost_minor).toBe(4000);
    const sources = run(store, { group_by: 'source' });
    expect(sources.rows.map((r) => [r.label, r.cost_minor])).toEqual([
      ['Meta Ads', 3850],
      ['Google Ads', 4000],
      [null, 0],
    ]);
    // Postback hard costs stay unscaled.
    expect(campaigns.get('m1')?.hard_costs_minor).toBe(500);
  });
});

describe('click-log day rollup', () => {
  it('follows appended touches, deletes and slot mapping changes', () => {
    const { store, db } = createStore();
    store.initSite(siteInit());
    const { meta } = createSources(store);
    store.recordTouches([touch('a', D(2), meta, 'm1', { fields: { c1: 's1' } })]);
    const visits = (groupBy: 'source' | 'adset'): Array<[string | null, number]> =>
      run(store, { group_by: groupBy }).rows.map((r) => [r.key, r.visits]);
    expect(visits('source')).toEqual([[meta, 1]]);
    store.recordTouches([
      touch('b', D(3), meta, 'm1', { fields: { c1: 's1' } }),
      touch('c', D(40), meta, 'm1'),
    ]);
    expect(visits('source')).toEqual([[meta, 2]]);
    expect(visits('adset')).toEqual([['s1', 2]]);
    db.run(`DELETE FROM touches WHERE visitor_id = 'b'`);
    expect(visits('source')).toEqual([[meta, 1]]);
    const source = store.getTrafficSource(meta);
    if (source === null) throw new Error('missing source');
    const { id: _id, status: _status, created_at: _c, updated_at: _u, ...body } = source;
    store.updateTrafficSource(meta, {
      ...body,
      fields: [{ slot: 'c1', name: 'keyword', url_param: 'kw' }],
    });
    expect(visits('adset')).toEqual([[null, 1]]);
  });
});

describe('ads performance report on 100k touches', () => {
  it('stays fast with SQL aggregation', () => {
    const { store, db } = createStore();
    store.initSite(siteInit());
    const { meta, google } = createSources(store);
    const visitors = 10_000;
    const insert = db.raw.prepare(
      `INSERT INTO touches (id, ts, visitor_id, session_id, funnel_id, node_id, traffic_source_id, kind, campaign, fields, cost_minor, identified)
       VALUES (?, ?, ?, ?, 'fn_main', 'traffic', ?, 'entrance', ?, ?, ?, 0)`,
    );
    const conv = db.raw.prepare(
      `INSERT INTO conversion_log (id, hit, tx, event, status, revenue_minor, currency, ts, visitor_id, received_at, updated_at)
       VALUES (?, ?, ?, 'sale', 'approved', ?, 'EUR', ?, ?, 0, 0)`,
    );
    let rng = 42;
    const rand = (n: number): number => {
      rng = (rng * 1_103_515_245 + 12_345) % 2_147_483_648;
      return rng % n;
    };
    db.raw.exec('BEGIN');
    for (let v = 0; v < visitors; v += 1) {
      let last = '';
      let ts = D(1) + rand(10 * DAY);
      for (let k = 0; k < 10; k += 1) {
        const isMeta = rand(2) === 0;
        const campaign = `${isMeta ? 'm' : 'g'}${String(rand(10))}`;
        const adset = `${campaign}-s${String(rand(3))}`;
        last = `h${String(v)}-${String(k)}`;
        insert.run(
          last,
          ts,
          `pv${String(v)}`,
          `ps${String(v)}-${String(k)}`,
          isMeta ? meta : google,
          campaign,
          JSON.stringify(
            isMeta ? { c1: adset, c2: `${adset}-a${String(rand(2))}` } : { c3: adset },
          ),
          rand(40),
        );
        ts += rand(2 * DAY);
      }
      if (v % 5 === 0)
        conv.run(`cv${String(v)}`, last, `tx${String(v)}`, 1000 + rand(9000), ts, `pv${String(v)}`);
    }
    db.raw.exec('COMMIT');
    const spend = [];
    for (let d = 1; d <= 30; d += 1) {
      for (let c = 0; c < 10; c += 1) {
        const day = `2026-10-${String(d).padStart(2, '0')}`;
        spend.push({
          platform: 'meta' as const,
          entity_external_id: `m${String(c)}`,
          day,
          spend_minor: 1000 + c,
        });
        spend.push({
          platform: 'google' as const,
          entity_external_id: `g${String(c)}`,
          day,
          spend_minor: 800 + c,
        });
      }
    }
    store.upsertAdSpend(spend);
    const timings: Record<string, number> = {};
    for (const [name, q] of [
      ['source', { group_by: 'source' }],
      ['campaign', { group_by: 'campaign' }],
      ['ad', { group_by: 'ad', model: 'linear' }],
      ['day', { group_by: 'day', basis: 'click_date' }],
    ] as Array<[string, Partial<PerformanceQuery>]>) {
      run(store, q);
      const start = performance.now();
      const report = run(store, q);
      timings[name] = Math.round((performance.now() - start) * 10) / 10;
      expect(report.totals.visits).toBe(10 * visitors);
      expect(report.totals.sales).toBe(visitors / 5);
      expect(report.totals.cost_minor).toBe(30 * (10 * 1000 + 45 + 10 * 800 + 45));
    }
    console.log(`performance report on 100k touches (ms): ${JSON.stringify(timings)}`);
    for (const ms of Object.values(timings)) expect(ms).toBeLessThan(500);
  });
});
