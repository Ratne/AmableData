import type { JourneyQuery, PerformanceQuery } from '@amable/api-types';
import { describe, expect, it } from 'vitest';
import { createStore, siteInit, SITE_ID } from './helpers';
import { createSources, D, DAY } from './reports-fixture';

type Store = ReturnType<typeof createStore>['store'];

const RANGE = { site_id: SITE_ID, from: '2026-10-01', to: '2026-10-07' };
const COUNTRIES = ['IT', 'DE', 'FR', 'ES', 'US'];
const DEVICES = ['desktop', 'mobile', 'tablet'];

/** 100k touches over a year (5k visitors × 20 hits), one session per touch, sales on 1 visitor in 5. */
function seed(): { store: Store; db: ReturnType<typeof createStore>['db'] } {
  const { store, db } = createStore({ now: D(27) });
  store.initSite(siteInit());
  const { meta, google } = createSources(store);
  const touch = db.raw.prepare(
    `INSERT INTO touches (id, ts, visitor_id, session_id, funnel_id, node_id, traffic_source_id, kind, campaign, fields, cost_minor, identified)
     VALUES (?, ?, ?, ?, 'fn_main', ?, ?, ?, ?, ?, ?, 0)`,
  );
  const session = db.raw.prepare(
    `INSERT INTO sessions (id, visitor_id, session_number, started_at, last_seen, channel, country, device)
     VALUES (?, ?, 1, ?, ?, 'Paid social', ?, ?)`,
  );
  const conv = db.raw.prepare(
    `INSERT INTO conversion_log (id, hit, tx, event, status, revenue_minor, currency, ts, visitor_id, received_at, updated_at)
     VALUES (?, ?, ?, 'sale', 'approved', ?, 'EUR', ?, ?, 0, 0)`,
  );
  const entity = db.raw.prepare(
    `INSERT INTO ad_entities (platform, external_id, level, parent_external_id, name, status, updated_at)
     VALUES (?, ?, 'campaign', NULL, ?, 'active', 0)`,
  );
  // mulberry32: deterministic and evenly spread.
  let rng = 7;
  const rand = (n: number): number => {
    rng = (rng + 0x6d2b79f5) | 0;
    let x = Math.imul(rng ^ (rng >>> 15), 1 | rng);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return Math.floor((((x ^ (x >>> 14)) >>> 0) / 4_294_967_296) * n);
  };
  const start = D(28) - 365 * DAY;
  db.raw.exec('BEGIN');
  for (let c = 0; c < 200; c += 1) {
    entity.run('meta', `m${String(c)}`, `Meta ${String(c)}`);
    entity.run('google', `g${String(c)}`, `Google ${String(c)}`);
  }
  for (let v = 0; v < 5000; v += 1) {
    let ts = start + rand(358) * DAY + rand(DAY);
    let last = '';
    for (let k = 0; k < 20; k += 1) {
      const isMeta = rand(2) === 0;
      const campaign = `${isMeta ? 'm' : 'g'}${String(rand(200))}`;
      const adset = `${campaign}-s${String(rand(3))}`;
      const sid = `ps${String(v)}-${String(k)}`;
      last = `h${String(v)}-${String(k)}`;
      session.run(sid, `pv${String(v)}`, ts, ts, COUNTRIES[rand(5)] ?? 'IT', DEVICES[rand(3)] ?? 'desktop');
      touch.run(
        last,
        ts,
        `pv${String(v)}`,
        sid,
        k % 3 === 0 ? 'traffic' : 'lander',
        isMeta ? meta : google,
        k % 3 === 0 ? 'entrance' : 'view',
        campaign,
        JSON.stringify(isMeta ? { c1: adset, c2: `${adset}-a${String(rand(2))}` } : { c3: adset }),
        rand(40),
      );
      ts += rand(DAY / 2);
    }
    if (v % 5 === 0) conv.run(`cv${String(v)}`, last, `tx${String(v)}`, 1000 + rand(9000), ts, `pv${String(v)}`);
  }
  db.raw.exec('COMMIT');
  return { store, db };
}

const QUERIES: Array<[string, (s: Store) => unknown]> = [
  ['country_linear', (s) => s.adsPerformanceReport({ ...RANGE, group_by: 'country', model: 'linear' } satisfies PerformanceQuery)],
  ['device', (s) => s.adsPerformanceReport({ ...RANGE, group_by: 'device' } satisfies PerformanceQuery)],
  ['ad_linear', (s) => s.adsPerformanceReport({ ...RANGE, group_by: 'ad', model: 'linear' } satisfies PerformanceQuery)],
  ['journey_source', (s) => s.adsJourneyReport({ ...RANGE, step: 'source' } satisfies JourneyQuery)],
  ['journey_node', (s) => s.adsJourneyReport({ ...RANGE, step: 'node' } satisfies JourneyQuery)],
  ['touches_7d', (s) => s.listTouches({ from: D(1), to: D(8), limit: 10_000 })],
];

function time(store: Store): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, run] of QUERIES) {
    run(store);
    const samples: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const t0 = performance.now();
      const result = run(store) as { ok?: boolean };
      samples.push(performance.now() - t0);
      if (result.ok === false) throw new Error(`${name} failed`);
    }
    out[name] = Math.round(Math.min(...samples) * 10) / 10;
  }
  return out;
}

describe('report indexes (migration 5) on 100k touches', () => {
  it('serve the range scans and the journey from the indexes, and speed them up', () => {
    const { store, db } = seed();
    const plan = (sql: string, ...params: Array<string | number>) =>
      JSON.stringify(db.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params));
    expect(
      plan(`SELECT DISTINCT visitor_id FROM touches WHERE ts >= ? AND ts < ? AND kind = 'entrance'`, D(1), D(8)),
    ).toContain('COVERING INDEX touches_ts');
    expect(plan(`SELECT * FROM touches t WHERE t.ts >= ? AND t.ts < ?`, D(1), D(8))).toContain('touches_ts');
    expect(
      plan(`SELECT name FROM ad_entities ae WHERE ae.level = 'campaign' AND ae.external_id = ?`, 'm1'),
    ).toContain('ad_entities_external');

    const inRange = store.listTouches({ from: D(1), to: D(8), limit: 10_000 }).length;
    expect(inRange).toBeGreaterThan(1000);
    expect(inRange).toBeLessThan(5000);
    const withIndexes = time(store);
    const reports = {
      country: store.adsPerformanceReport({ ...RANGE, group_by: 'country', model: 'linear' }),
      journey: store.adsJourneyReport({ ...RANGE, step: 'source' }),
    };
    db.raw.exec(`DROP INDEX touches_ts`);
    db.raw.exec(`DROP INDEX ad_entities_external`);
    const without = time(store);
    // Same results, only the plan changes.
    expect(store.adsPerformanceReport({ ...RANGE, group_by: 'country', model: 'linear' })).toEqual(reports.country);
    expect(store.adsJourneyReport({ ...RANGE, step: 'source' })).toEqual(reports.journey);
    console.log(`report queries on 100k touches, 7-day range (ms): without=${JSON.stringify(without)} with=${JSON.stringify(withIndexes)}`);
    expect(withIndexes['touches_7d']).toBeLessThan(without['touches_7d'] ?? 0);
    expect(withIndexes['journey_source']).toBeLessThan(without['journey_source'] ?? 0);
    for (const ms of Object.values(withIndexes)) expect(ms).toBeLessThan(500);
  }, 60_000);
});
