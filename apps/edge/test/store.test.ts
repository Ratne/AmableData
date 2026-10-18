import { describe, expect, it } from 'vitest';
import { analyticsMigrations } from '../src/analytics/migrations';
import type { ArchiveSink } from '../src/analytics/store/index';
import { createStore, ev, siteInit, T0 } from './helpers';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function setup(overrides: Parameters<typeof siteInit>[0] = {}) {
  const clock = { now: T0 + 2 * DAY };
  const { store, db } = createStore(clock);
  store.initSite(siteInit(overrides));
  return { store, db, clock };
}

const range = { from: '2026-10-15', to: '2026-10-15' };

function sessions(db: ReturnType<typeof setup>['db']) {
  return db.all<{
    id: string;
    visitor_id: string;
    session_number: number;
    pageviews: number;
    goals: number;
    bounce: number;
    duration_ms: number;
    entry_path: string;
    exit_path: string;
    channel: string;
    revenue_minor: number;
  }>(`SELECT * FROM sessions ORDER BY started_at, id`);
}

describe('migrations', () => {
  it('ids are positive and ordered', () => {
    expect(analyticsMigrations.map((m) => m.id)).toEqual([1, 2, 3]);
  });
});

describe('session aggregation', () => {
  it('builds sessions from cookie ids: entry/exit, duration, bounce, source', () => {
    const { store, db } = setup();
    store.ingest(
      [
        ev({
          path: '/',
          ts: T0,
          channel: 'Organic search',
          source: 'Google',
          referrerHost: 'www.google.com',
        }),
        ev({ path: '/pricing', ts: T0 + 2 * MIN, channel: 'Direct' }),
        ev({ path: '/signup', ts: T0 + 5 * MIN }),
        ev({ vid: 'visitor-2', sid: 'session-2', path: '/blog', ts: T0 + 10 * MIN }),
      ],
      [],
    );
    const rows = sessions(db);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: 'session-1',
      pageviews: 3,
      bounce: 0,
      duration_ms: 5 * MIN,
      entry_path: '/',
      exit_path: '/signup',
      channel: 'Organic search',
    });
    expect(rows[1]).toMatchObject({ id: 'session-2', pageviews: 1, bounce: 1, duration_ms: 0 });
  });

  it('handles out-of-order events and goals (a goal clears bounce)', () => {
    const { store, db } = setup();
    store.ingest([ev({ path: '/b', ts: T0 + MIN })], []);
    store.ingest([ev({ path: '/a', ts: T0 })], []);
    expect(sessions(db)[0]).toMatchObject({
      entry_path: '/a',
      exit_path: '/b',
      duration_ms: MIN,
      bounce: 0,
    });
    store.ingest([ev({ vid: 'v3', sid: 's3', path: '/x', ts: T0 + 2 * MIN })], []);
    expect(sessions(db).find((s) => s.id === 's3')?.bounce).toBe(1);
    store.ingest(
      [
        ev({
          vid: 'v3',
          sid: 's3',
          type: 'goal',
          name: 'signup',
          data: { plan: 'pro' },
          ts: T0 + 3 * MIN,
        }),
      ],
      [],
    );
    expect(sessions(db).find((s) => s.id === 's3')).toMatchObject({ bounce: 0, goals: 1 });
    const goals = db.all<{ name: string; params: string }>(`SELECT name, params FROM goals`);
    expect(goals).toEqual([{ name: 'signup', params: '{"plan":"pro"}' }]);
  });

  it('is idempotent per event id (queue redelivery)', () => {
    const { store, db } = setup();
    const e = ev({ path: '/' });
    expect(store.ingest([e], []).ingested).toBe(1);
    expect(store.ingest([e], [])).toMatchObject({ ingested: 0, duplicates: 1 });
    expect(db.all(`SELECT * FROM pageviews`)).toHaveLength(1);
  });

  it('sessionizes cookieless visitors by 30 minutes of inactivity', () => {
    const { store, db } = setup();
    const base = {
      vid: 'hcookieless',
      sid: null,
      sessionNumber: null,
      firstSeen: null,
      cookieless: true,
    };
    store.ingest(
      [
        ev({ ...base, path: '/', ts: T0 }),
        ev({ ...base, path: '/two', ts: T0 + 20 * MIN }),
        ev({ ...base, path: '/three', ts: T0 + 49 * MIN }),
        ev({ ...base, path: '/later', ts: T0 + 90 * MIN }),
      ],
      [],
    );
    const rows = sessions(db);
    expect(rows.map((r) => [r.pageviews, r.session_number])).toEqual([
      [3, 1],
      [1, 2],
    ]);
    expect(db.all<{ session_count: number }>(`SELECT session_count FROM visitors`)).toEqual([
      { session_count: 2 },
    ]);
  });

  it('attaches server goals to the active session and never opens one', () => {
    const { store, db } = setup();
    store.ingest(
      [
        ev({ path: '/', ts: T0 }),
        ev({
          type: 'goal',
          server: true,
          sid: null,
          name: 'subscribed',
          ts: T0 + 10 * MIN,
          path: null,
        }),
        ev({ type: 'goal', server: true, sid: null, name: 'late', ts: T0 + 3 * HOUR, path: null }),
      ],
      [],
    );
    expect(sessions(db)).toHaveLength(1);
    expect(
      db.all<{ name: string; session_id: string | null }>(
        `SELECT name, session_id FROM goals ORDER BY ts`,
      ),
    ).toEqual([
      { name: 'subscribed', session_id: 'session-1' },
      { name: 'late', session_id: null },
    ]);
  });

  it('records payments once, attributes revenue and handles refunds', () => {
    const { store, db } = setup();
    const pay = (
      eid: string,
      extra: Partial<NonNullable<ReturnType<typeof ev>['payment']>> = {},
      ts = T0 + MIN,
    ) =>
      ev({
        eid,
        type: 'payment',
        ts,
        payment: {
          amountMinor: 4900,
          currency: 'EUR',
          transactionId: 'tx-1',
          email: 'a@b.co',
          customerId: null,
          renewal: false,
          refunded: false,
          freeTrial: false,
          ...extra,
        },
      });
    store.ingest([ev({ path: '/', ts: T0 }), pay('p1')], []);
    store.ingest([pay('p1-retry')], []); // same transaction id, other event id
    expect(sessions(db)[0]).toMatchObject({ revenue_minor: 4900, goals: 1 });
    expect(store.overview(range)).toMatchObject({
      ok: true,
      value: { revenue_minor: 4900, conversions: 1 },
    });

    // Payment without visitor id is matched by the identified email.
    store.ingest(
      [
        ev({
          type: 'identify',
          identity: { userId: 'u1', email: 'a@b.co', name: 'Ann', traits: { plan: 'pro' } },
        }),
      ],
      [],
    );
    store.ingest(
      [
        ev({
          type: 'payment',
          vid: '',
          sid: null,
          server: true,
          payment: {
            amountMinor: 1000,
            currency: 'EUR',
            transactionId: 'tx-2',
            email: 'a@b.co',
            customerId: null,
            renewal: true,
            refunded: false,
            freeTrial: false,
          },
          ts: T0 + 2 * MIN,
        }),
      ],
      [],
    );
    expect(
      db.all(`SELECT transaction_id, visitor_id, session_id FROM payments ORDER BY ts`),
    ).toEqual([
      { transaction_id: 'tx-1', visitor_id: 'visitor-1', session_id: 'session-1' },
      { transaction_id: 'tx-2', visitor_id: 'visitor-1', session_id: 'session-1' },
    ]);
    store.ingest([pay('p1-refund', { refunded: true }, T0 + 3 * MIN)], []);
    expect(sessions(db)[0]?.revenue_minor).toBe(1000);
    expect(store.overview(range)).toMatchObject({ ok: true, value: { revenue_minor: 1000 } });
    // Other currencies are recorded but not summed as revenue.
    store.ingest([pay('p3', { transactionId: 'tx-3', currency: 'USD' }, T0 + 4 * MIN)], []);
    expect(store.overview(range)).toMatchObject({ ok: true, value: { revenue_minor: 1000 } });
    const visitor = db.all<{ user_id: string; email: string; traits: string }>(
      `SELECT user_id, email, traits FROM visitors`,
    );
    expect(visitor).toEqual([{ user_id: 'u1', email: 'a@b.co', traits: '{"plan":"pro"}' }]);
  });
});

describe('rollups and queries', () => {
  function seed() {
    const s = setup();
    const google = {
      channel: 'Organic search' as const,
      source: 'Google',
      referrerHost: 'www.google.com',
    };
    s.store.ingest(
      [
        // 10:00 — visitor 1, Google, 2 pages + goal
        ev({ ...google, path: '/', ts: T0 }),
        ev({ path: '/pricing', ts: T0 + MIN }),
        ev({ type: 'goal', name: 'signup', ts: T0 + 2 * MIN, path: '/pricing' }),
        // 10:30 — visitor 2, direct, bounce, mobile from US
        ev({
          vid: 'v2',
          sid: 's2',
          path: '/',
          ts: T0 + 30 * MIN,
          device: 'mobile',
          geo: {
            country: 'US',
            region: 'California',
            city: 'San Francisco',
            latitude: null,
            longitude: null,
          },
          browser: 'Safari',
          os: 'iOS',
        }),
        // 12:00 — visitor 3, campaign
        ev({
          vid: 'v3',
          sid: 's3',
          path: '/blog',
          ts: T0 + 2 * HOUR,
          channel: 'Email',
          source: 'crm',
          utm: { source: 'crm', medium: 'email', campaign: 'october', term: null, content: null },
        }),
        ev({ vid: 'v3', sid: 's3', path: '/pricing', ts: T0 + 2 * HOUR + MIN }),
        ev({
          vid: 'v3',
          sid: 's3',
          type: 'external_link',
          data: { url: 'https://docs.other.org/x', host: 'docs.other.org' },
          ts: T0 + 2 * HOUR + 2 * MIN,
          path: '/pricing',
        }),
      ],
      [
        {
          site: s.store.getSite()?.site.id ?? '',
          ts: T0,
          name: 'GPTBot',
          provider: 'OpenAI',
          category: 'training',
          path: '/',
        },
        {
          site: s.store.getSite()?.site.id ?? '',
          ts: T0,
          name: 'GPTBot',
          provider: 'OpenAI',
          category: 'training',
          path: '/',
        },
        {
          site: s.store.getSite()?.site.id ?? '',
          ts: T0,
          name: 'ChatGPT-User',
          provider: 'OpenAI',
          category: 'ai_answers',
          path: '/pricing',
        },
      ],
    );
    return s;
  }

  it('maintains hourly and daily rollups', () => {
    const { db } = seed();
    const hourly = db.all(
      `SELECT bucket, visitors, sessions, pageviews, bounces, goals FROM rollup_hourly ORDER BY bucket`,
    );
    expect(hourly).toEqual([
      { bucket: T0, visitors: 2, sessions: 2, pageviews: 3, bounces: 1, goals: 1 },
      { bucket: T0 + 2 * HOUR, visitors: 1, sessions: 1, pageviews: 2, bounces: 0, goals: 0 },
    ]);
    expect(db.all(`SELECT day, visitors, sessions, pageviews FROM rollup_daily`)).toEqual([
      { day: '2026-10-15', visitors: 3, sessions: 3, pageviews: 5 },
    ]);
    expect(db.all(`SELECT * FROM rollup_dirty`)).toEqual([]);
  });

  it('overview', () => {
    const { store } = seed();
    const r = store.overview(range);
    expect(r).toEqual({
      ok: true,
      value: expect.objectContaining({
        visitors: 3,
        sessions: 3,
        pageviews: 5,
        bounce_rate: 0.3333,
        goals: 1,
        conversions: 1,
        conversion_rate: 0.3333,
        currency: 'EUR',
        timezone: 'UTC',
      }),
    });
    const filtered = store.overview({
      ...range,
      filters: [{ dimension: 'channel', op: 'is', value: 'Email' }],
    });
    expect(filtered).toMatchObject({
      ok: true,
      value: { visitors: 1, sessions: 1, pageviews: 2, goals: 0 },
    });
    const byPage = store.overview({
      ...range,
      filters: [{ dimension: 'page', op: 'is', value: '/pricing' }],
    });
    expect(byPage).toMatchObject({ ok: true, value: { visitors: 2, sessions: 2 } });
    const notGoal = store.overview({
      ...range,
      filters: [{ dimension: 'goal', op: 'is_not', value: 'signup' }],
    });
    expect(notGoal).toMatchObject({ ok: true, value: { visitors: 2 } });
    expect(store.overview({ from: '2026-10-16', to: '2026-10-15' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_range' },
    });
  });

  it('timeseries from rollups and from raw rows (filters, other zones)', () => {
    const { store } = seed();
    const hourly = store.timeseries(
      { from: '2026-10-15T09:00:00Z', to: '2026-10-15T13:00:00Z' },
      'hour',
    );
    expect(hourly.ok && hourly.value.source).toBe('rollup');
    expect(hourly.ok && hourly.value.points.map((p) => p.pageviews)).toEqual([0, 3, 0, 2]);
    const daily = store.timeseries({ from: '2026-10-14', to: '2026-10-16' }, 'day');
    expect(daily.ok && daily.value.source).toBe('rollup');
    expect(daily.ok && daily.value.points.map((p) => [p.label, p.visitors])).toEqual([
      ['2026-10-14', 0],
      ['2026-10-15', 3],
      ['2026-10-16', 0],
    ]);
    const filtered = store.timeseries(
      {
        from: '2026-10-15T09:00:00Z',
        to: '2026-10-15T13:00:00Z',
        filters: [{ dimension: 'device', op: 'is', value: 'mobile' }],
      },
      'hour',
    );
    expect(filtered.ok && filtered.value.source).toBe('raw');
    expect(filtered.ok && filtered.value.points.map((p) => p.visitors)).toEqual([0, 1, 0, 0]);
    // In Tokyo (+9) 10:00 and 12:00 UTC are still the 15th; 2026-10-15 local = 15:00Z(14th) .. 15:00Z(15th).
    const tokyo = store.timeseries(
      { from: '2026-10-15', to: '2026-10-16', timezone: 'Asia/Tokyo' },
      'day',
    );
    expect(tokyo.ok && tokyo.value.source).toBe('raw');
    expect(tokyo.ok && tokyo.value.points.map((p) => [p.label, p.sessions, p.pageviews])).toEqual([
      ['2026-10-15', 3, 5],
      ['2026-10-16', 0, 0],
    ]);
    const weekly = store.timeseries({ from: '2026-10-01', to: '2026-10-31' }, 'week');
    expect(weekly.ok && weekly.value.points[0]?.label).toBe('2026-09-28');
    const monthly = store.timeseries({ from: '2026-09-01', to: '2026-10-31' }, 'month');
    expect(monthly.ok && monthly.value.points.map((p) => [p.label, p.visitors])).toEqual([
      ['2026-09-01', 0],
      ['2026-10-01', 3],
    ]);
  });

  it('breakdowns by session dimensions, pages, goals, exit links and bots', () => {
    const { store } = seed();
    const get = (
      dimension: Parameters<typeof store.breakdown>[1],
      filters: Parameters<typeof store.overview>[0]['filters'] = [],
    ) => {
      const r = store.breakdown({ ...range, filters }, dimension, 10);
      if (!r.ok) throw new Error(r.error.message);
      return r.value.rows;
    };
    expect(get('channel').map((r) => [r.value, r.visitors])).toEqual([
      ['Direct', 1],
      ['Email', 1],
      ['Organic search', 1],
    ]);
    expect(get('campaign').find((r) => r.value === 'october')).toMatchObject({
      visitors: 1,
      pageviews: 2,
      bounce_rate: 0,
    });
    expect(get('country').map((r) => [r.value, r.visitors])).toEqual([
      ['IT', 2],
      ['US', 1],
    ]);
    expect(get('city')[0]).toMatchObject({ value: 'Milan', visitors: 2 });
    expect(get('region').map((r) => r.value)).toEqual(['Lombardy', 'California']);
    expect(get('device').map((r) => r.value)).toEqual(['desktop', 'mobile']);
    expect(get('browser').map((r) => r.value)).toEqual(['Chrome', 'Safari']);
    expect(get('os').map((r) => r.value)).toEqual(['macOS', 'iOS']);
    expect(get('hostname')).toEqual([
      expect.objectContaining({ value: 'www.example.com', visitors: 3 }),
    ]);
    expect(get('referrer').find((r) => r.value === 'www.google.com')?.visitors).toBe(1);
    expect(get('entry_page').map((r) => [r.value, r.visitors])).toEqual([
      ['/', 2],
      ['/blog', 1],
    ]);
    expect(get('exit_page')[0]).toMatchObject({ value: '/pricing', visitors: 2 });
    expect(get('page')).toEqual([
      { value: '/', visitors: 2, pageviews: 2 },
      { value: '/pricing', visitors: 2, pageviews: 2 },
      { value: '/blog', visitors: 1, pageviews: 1 },
    ]);
    expect(get('page', [{ dimension: 'country', op: 'is', value: 'US' }])).toEqual([
      { value: '/', visitors: 1, pageviews: 1 },
    ]);
    expect(get('goal')).toEqual([{ value: 'signup', visitors: 1, completions: 1 }]);
    expect(get('exit_link')).toEqual([{ value: 'https://docs.other.org/x', visitors: 1, hits: 1 }]);
    expect(get('bot')).toEqual([
      { value: 'GPTBot', visitors: 0, hits: 2 },
      { value: 'ChatGPT-User', visitors: 0, hits: 1 },
    ]);
    expect(get('bot_category').map((r) => [r.value, r.hits])).toEqual([
      ['training', 2],
      ['ai_answers', 1],
    ]);
    expect(
      get('channel', [{ dimension: 'source', op: 'contains', value: 'goo' }]).map((r) => r.value),
    ).toEqual(['Organic search']);
  });

  it('daily rollups follow the site time zone', () => {
    const { store, db } = setup({ timezone: 'America/New_York' });
    // 02:00 UTC on the 15th is still the 14th in New York.
    store.ingest(
      [
        ev({ ts: Date.UTC(2026, 9, 15, 2, 0, 0) }),
        ev({ vid: 'v2', sid: 's2', ts: Date.UTC(2026, 9, 15, 14, 0, 0) }),
      ],
      [],
    );
    expect(db.all(`SELECT day, visitors FROM rollup_daily ORDER BY day`)).toEqual([
      { day: '2026-10-14', visitors: 1 },
      { day: '2026-10-15', visitors: 1 },
    ]);
  });
});

describe('retention', () => {
  it('archives raw rows older than the retention to the sink, then purges them', async () => {
    const clock = { now: T0 };
    const { store, db } = createStore(clock);
    store.initSite(siteInit({ retentionDays: 30 }));
    store.ingest(
      [
        ev({ ts: T0 - 40 * DAY, path: '/old' }),
        ev({ vid: 'v2', sid: 's2', ts: T0 - DAY, path: '/new' }),
      ],
      [],
    );
    const puts: Array<{ key: string; body: string }> = [];
    const sink: ArchiveSink = {
      put(key, body) {
        puts.push({ key, body });
        return Promise.resolve();
      },
    };
    const result = await store.retention(sink);
    expect(result?.archived).toMatchObject({ pageviews: 1, sessions: 1 });
    expect(db.all<{ path: string }>(`SELECT path FROM pageviews`)).toEqual([{ path: '/new' }]);
    const pv = puts.find((p) => p.key.includes('/pageviews/'));
    expect(pv?.key).toMatch(/^analytics-archive\/st_a+\/pageviews\/2026-09-05-\d+-\d+\.ndjson$/);
    expect(JSON.parse(pv?.body.trim() ?? '{}')).toMatchObject({
      path: '/old',
      visitor_id: 'visitor-1',
    });
    // Rollups survive the purge.
    expect(db.all(`SELECT day FROM rollup_daily ORDER BY day`)).toHaveLength(2);
    // retention 0 = keep forever
    store.updateSite({ retention_days: 0 });
    clock.now += 400 * DAY;
    expect((await store.retention(sink))?.cutoff).toBeNull();
    expect(db.all(`SELECT path FROM pageviews`)).toHaveLength(1);
  });
});

describe('site registry', () => {
  it('stores config, refuses id takeover, soft-deletes, keeps a tenant index', () => {
    const { store } = setup();
    expect(store.getSite()?.site).toMatchObject({
      id: 'st_aaaaaaaaaaaaaaaaaaaa',
      hostnames: ['example.com'],
      has_secret: false,
    });
    expect(() => store.initSite(siteInit({ tenantId: 'other' }))).toThrow();
    expect(store.updateSite({ name: 'Renamed', cookieless: true })?.site).toMatchObject({
      name: 'Renamed',
      cookieless: true,
    });
    expect(store.edgeConfig()).toMatchObject({
      cookieless: true,
      tenantId: 'tenant_1',
      salt: { day: '2026-10-17' },
    });
    expect(store.setSecretHash('abc')).toBe(true);
    expect(store.getSite()?.site.has_secret).toBe(true);
    expect(store.deleteSite()).toBe(true);
    expect(store.edgeConfig()).toBeNull();
    expect(store.overview(range)).toMatchObject({ ok: false, error: { code: 'not_found' } });

    const { store: index } = createStore();
    index.indexAdd('st_b');
    index.indexAdd('st_a');
    index.indexAdd('st_b');
    expect(index.indexList()).toEqual(['st_a', 'st_b']);
    index.indexRemove('st_b');
    expect(index.indexList()).toEqual(['st_a']);
  });
});
