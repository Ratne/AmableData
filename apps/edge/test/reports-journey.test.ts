import type { JourneyQuery, JourneyReport } from '@amable/api-types';
import { describe, expect, it } from 'vitest';
import { createStore, siteInit, SITE_ID } from './helpers';
import { createSources, D, insertPayment, mergeVisitors, touch } from './reports-fixture';

const HOUR = 3_600_000;

/**
 * - p (origin, email known): Meta D2; q (merged into p): Google D5 → sale 2000 D6
 * - r: Meta D3, Meta D4, Google D6, no sale
 * - s: Meta D3 with a click id → sale 1000 D5
 * - t: Meta D3, no sale
 * - z: 35 touches alternating Meta / Google from D10
 * - a CRM payment of 300 (D7) with a contact and no visitor
 */
function seed() {
  const { store, db } = createStore();
  store.initSite(siteInit());
  const { meta, google } = createSources(store);
  const list = [
    touch('p', D(2), meta, 'm1'),
    touch('q', D(5), google, 'g1'),
    touch('r', D(3), meta, 'm1'),
    touch('r', D(4), meta, 'm1'),
    touch('r', D(6), google, 'g1'),
    touch('s', D(3), meta, 'm1', { external_click_id: 'fb.1.123' }),
    touch('t', D(3), meta, 'm1'),
  ];
  for (let k = 0; k < 35; k += 1)
    list.push(touch('z', D(10) + k * HOUR, k % 2 === 0 ? meta : google, k % 2 === 0 ? 'm1' : 'g1'));
  store.recordTouches(list);
  const hit = (v: string): string => list.find((x) => x.visitor_id === v)?.id ?? '';
  store.recordConversionFromPostback({ hit: hit('q'), tx: 'q1', revenue_minor: 2000, ts: D(6) });
  store.recordConversionFromPostback({ hit: hit('s'), tx: 's1', revenue_minor: 1000, ts: D(5) });
  insertPayment(db, { tx: 'px', visitor: null, contact: 'ct_9', ts: D(7), amount: 300 });
  store.upsertIdentityKeys([
    { key_type: 'email', key_value: 'p@example.com', visitor_id: 'p', first_seen: D(2) },
  ]);
  mergeVisitors(db, 'q', 'p');
  return { store, db };
}

type Store = ReturnType<typeof createStore>['store'];

function journeys(store: Store, q: Partial<JourneyQuery> = {}): JourneyReport {
  const r = store.adsJourneyReport({
    site_id: SITE_ID,
    from: '2026-10-01',
    to: '2026-10-31',
    ...q,
  });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

describe('journey report', () => {
  it('aggregates step sequences of merged visitors up to the first sale', () => {
    const { store } = seed();
    const report = journeys(store);
    expect(report.rows.slice(0, 2)).toEqual([
      {
        steps: ['Meta Ads', 'Google Ads'],
        visitors: 2,
        conversions: 1,
        revenue_minor: 2000,
        avg_days_to_convert: 4,
      },
      {
        steps: ['Meta Ads'],
        visitors: 2,
        conversions: 1,
        revenue_minor: 1000,
        avg_days_to_convert: 2,
      },
    ]);
    const long = report.rows[2];
    expect(long?.steps).toHaveLength(30);
    expect(long?.steps[0]).toBe('Google Ads');
    expect(long?.steps[29]).toBe('Meta Ads');
    expect(report.rows).toHaveLength(3);
    expect(
      journeys(store, { converted_only: true }).rows.map((r) => [r.steps, r.visitors]),
    ).toEqual([
      [['Meta Ads', 'Google Ads'], 1],
      [['Meta Ads'], 1],
    ]);
    expect(
      journeys(store, { step: 'campaign', converted_only: true }).rows.map((r) => r.steps),
    ).toEqual([['m1', 'g1'], ['m1']]);
    // Every touch hits the traffic node: both paths collapse into one step.
    expect(journeys(store, { step: 'node', converted_only: true }).rows).toEqual([
      {
        steps: ['traffic'],
        visitors: 2,
        conversions: 2,
        revenue_minor: 3000,
        avg_days_to_convert: 3,
      },
    ]);
  });

  it('splits the journeys again once the merge is disconnected', () => {
    const { store, db } = seed();
    mergeVisitors(db, 'q', 'p', false);
    const rows = journeys(store).rows;
    expect(rows[0]).toEqual({
      steps: ['Google Ads'],
      visitors: 1,
      conversions: 1,
      revenue_minor: 2000,
      avg_days_to_convert: 1,
    });
    expect(rows[1]).toEqual({
      steps: ['Meta Ads'],
      visitors: 3,
      conversions: 1,
      revenue_minor: 1000,
      avg_days_to_convert: 2,
    });
    expect(rows.find((r) => r.steps.join() === 'Meta Ads,Google Ads')?.visitors).toBe(1);
  });
});

describe('tracking quality', () => {
  it('counts conversions with identity, click id and touch', () => {
    const { store } = seed();
    expect(
      store.trackingQuality({ site_id: SITE_ID, from: '2026-10-01', to: '2026-10-31' }),
    ).toEqual({
      ok: true,
      value: { conversions: 3, with_identity: 2, with_click_id: 1, with_touch: 2, score: 0.5556 },
    });
    expect(store.trackingQuality({ from: '2026-11-01', to: '2026-11-30' })).toEqual({
      ok: true,
      value: { conversions: 0, with_identity: 0, with_click_id: 0, with_touch: 0, score: 0 },
    });
  });
});
