import { describe, expect, it } from 'vitest';
import { inCidr, parseIp, verifyCrawlerIp } from '../src/analytics/crawler-ip';
import { creditTouches, splitMinor } from '../src/analytics/store/attribution';
import { computeFunnel, type StoredFunnelStep } from '../src/analytics/store/funnels';
import { featuresOf, scoreFacts, trainLogistic, type TrainingSample } from '../src/analytics/store/prediction';
import { RealtimeHub, type RealtimeSocket } from '../src/analytics/store/realtime';
import type { AnalyticsRealtime, RealtimeEvent } from '@amable/api-types';
import { createStore, ev, siteInit, T0 } from './helpers';

const MIN = 60_000;
const DAY = 86_400_000;
const range = { from: '2026-10-01', to: '2026-10-31' };

function seededStore() {
  const clock = { now: T0 + 20 * DAY };
  const { store, db } = createStore(clock);
  store.initSite(siteInit());
  return { store, db, clock };
}

describe('attribution models', () => {
  it('credits first touch, last non-direct touch and linear shares', () => {
    const channels = ['Organic search', 'Email', 'Direct', 'Direct'];
    expect(creditTouches(channels, 'first_touch')).toEqual([{ index: 0, weight: 1 }]);
    expect(creditTouches(channels, 'last_non_direct')).toEqual([{ index: 1, weight: 1 }]);
    expect(creditTouches(['Direct', 'Direct'], 'last_non_direct')).toEqual([{ index: 1, weight: 1 }]);
    const linear = creditTouches(channels, 'linear');
    expect(linear).toHaveLength(4);
    expect(linear.reduce((a, w) => a + w.weight, 0)).toBeCloseTo(1, 10);
    expect(creditTouches([], 'linear')).toEqual([]);
  });

  it('attributes revenue of a breakdown with the selected model', () => {
    const { store } = seededStore();
    store.ingest(
      [
        ev({ vid: 'v1', sid: 's1', ts: T0, channel: 'Organic search', source: 'Google' }),
        ev({ vid: 'v1', sid: 's2', ts: T0 + DAY, channel: 'Email', source: 'Newsletter' }),
        ev({ vid: 'v1', sid: 's3', ts: T0 + 2 * DAY, channel: 'Direct' }),
        ev({
          vid: 'v1',
          sid: 's3',
          ts: T0 + 2 * DAY + MIN,
          type: 'payment',
          payment: {
            amountMinor: 9000,
            currency: 'EUR',
            transactionId: 'tx1',
            email: null,
            customerId: null,
            renewal: false,
            refunded: false,
            freeTrial: false,
          },
        }),
      ],
      [],
    );
    const rows = (model: 'first_touch' | 'last_non_direct' | 'linear') => {
      const r = store.breakdown(range, 'channel', 10, model);
      if (!r.ok) throw new Error(r.error.message);
      expect(r.value.model).toBe(model);
      return Object.fromEntries(r.value.rows.map((row) => [row.value, row.revenue_minor]));
    };
    expect(rows('first_touch')).toMatchObject({ 'Organic search': 9000, Email: 0, Direct: 0 });
    expect(rows('last_non_direct')).toMatchObject({ 'Organic search': 0, Email: 9000, Direct: 0 });
    expect(rows('linear')).toMatchObject({ 'Organic search': 3000, Email: 3000, Direct: 3000 });
    // Non-source dimensions keep session revenue (the session of the purchase).
    const devices = store.breakdown(range, 'device', 10);
    expect(devices.ok && devices.value.rows[0]?.revenue_minor).toBe(9000);
  });

  it('credits last touch and position-based shares', () => {
    const channels = ['Organic search', 'Email', 'Referral', 'Direct'];
    expect(creditTouches(channels, 'last_touch')).toEqual([{ index: 3, weight: 1 }]);
    const pos = creditTouches(channels, 'position_based').map((c) => c.weight);
    expect(pos[0]).toBeCloseTo(0.4);
    expect(pos[1]).toBeCloseTo(0.1);
    expect(pos[2]).toBeCloseTo(0.1);
    expect(pos[3]).toBeCloseTo(0.4);
    expect(creditTouches(['Email', 'Direct'], 'position_based')).toEqual([
      { index: 0, weight: 0.5 },
      { index: 1, weight: 0.5 },
    ]);
    expect(creditTouches(['Email'], 'position_based')).toEqual([{ index: 0, weight: 1 }]);
  });

  it('splits integer minor units exactly', () => {
    expect(splitMinor(100, [1 / 3, 1 / 3, 1 / 3])).toEqual([34, 33, 33]);
    expect(splitMinor(999, [0.4, 0.1, 0.1, 0.4])).toEqual([400, 100, 100, 399]);
    expect(splitMinor(0, [0.5, 0.5])).toEqual([0, 0]);
    for (const amount of [1, 7, 12345]) {
      const parts = splitMinor(amount, [0.4, 0.2 / 3, 0.2 / 3, 0.2 / 3, 0.4]);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(amount);
      expect(parts.every((p) => Number.isInteger(p))).toBe(true);
    }
  });

  it('compares every model per channel, source, campaign and landing page', () => {
    const { store } = seededStore();
    const pay = (vid: string, sid: string, ts: number, tx: string, amountMinor: number) =>
      ev({
        vid,
        sid,
        ts,
        type: 'payment',
        payment: {
          amountMinor,
          currency: 'EUR',
          transactionId: tx,
          email: null,
          customerId: null,
          renewal: false,
          refunded: false,
          freeTrial: false,
        },
      });
    store.ingest(
      [
        ev({ vid: 'a', sid: 'a1', ts: T0, channel: 'Organic search', source: 'Google', path: '/blog' }),
        ev({ vid: 'a', sid: 'a2', ts: T0 + DAY, channel: 'Email', source: 'Newsletter', path: '/offer' }),
        ev({ vid: 'a', sid: 'a3', ts: T0 + 2 * DAY, channel: 'Direct', path: '/pricing' }),
        pay('a', 'a3', T0 + 2 * DAY + MIN, 'tx-a', 1001),
        ev({ vid: 'b', sid: 'b1', ts: T0 + DAY, channel: 'Paid social', source: 'Facebook', path: '/offer' }),
        pay('b', 'b1', T0 + DAY + MIN, 'tx-b', 500),
      ],
      [],
    );
    const report = store.attribution(range, 'channel');
    if (!report.ok) throw new Error(report.error.message);
    expect(report.value.models).toEqual(['first_touch', 'last_touch', 'last_non_direct', 'linear', 'position_based']);
    expect(report.value.total_revenue_minor).toBe(1501);
    expect(report.value.total_conversions).toBe(2);
    const credit = (value: string, model: string) =>
      report.value.rows.find((r) => r.value === value)?.credits.find((c) => c.model === model)?.revenue_minor ?? 0;
    expect(credit('Organic search', 'first_touch')).toBe(1001);
    expect(credit('Direct', 'last_touch')).toBe(1001);
    expect(credit('Email', 'last_non_direct')).toBe(1001);
    expect(credit('Paid social', 'position_based')).toBe(500);
    // Position based over three touches: 40 / 20 / 40, exact in minor units.
    expect(credit('Organic search', 'position_based') + credit('Email', 'position_based') + credit('Direct', 'position_based')).toBe(1001);
    expect(credit('Email', 'position_based')).toBe(200);
    // Each model hands out the whole revenue.
    for (const model of report.value.models) {
      const sum = report.value.rows.reduce(
        (a, r) => a + (r.credits.find((c) => c.model === model)?.revenue_minor ?? 0),
        0,
      );
      expect(sum).toBe(1501);
    }
    const pages = store.attribution(range, 'entry_page', ['first_touch', 'last_touch']);
    if (!pages.ok) throw new Error(pages.error.message);
    expect(pages.value.models).toEqual(['first_touch', 'last_touch']);
    const page = (value: string, model: string) =>
      pages.value.rows.find((r) => r.value === value)?.credits.find((c) => c.model === model)?.revenue_minor ?? 0;
    expect(page('/blog', 'first_touch')).toBe(1001);
    expect(page('/offer', 'first_touch')).toBe(500);
    expect(page('/pricing', 'last_touch')).toBe(1001);
    // The breakdown of the landing page carries the credited revenue too.
    const entry = store.breakdown(range, 'entry_page', 10, 'first_touch');
    expect(entry.ok && entry.value.rows.find((r) => r.value === '/blog')?.revenue_minor).toBe(1001);
  });
});

describe('identity: visitor ↔ contact', () => {
  it('merges the histories of every visitor of a contact (profile + attribution)', () => {
    const { store, db } = seededStore();
    store.ingest(
      [
        ev({ vid: 'laptop', sid: 'a1', ts: T0, channel: 'Paid social', source: 'Facebook', path: '/' }),
        ev({ vid: 'phone', sid: 'b1', ts: T0 + DAY, channel: 'Direct', path: '/pricing', device: 'mobile' }),
        ev({
          vid: 'phone',
          sid: 'b1',
          ts: T0 + DAY + MIN,
          type: 'identify',
          identity: { userId: 'u1', email: 'ANN@example.com', name: 'Ann', traits: null },
        }),
      ],
      [],
    );
    // identify queues the email for the core to resolve
    const work = store.pullCoreWork();
    expect(work.identities).toEqual([
      expect.objectContaining({ visitorId: 'phone', kind: 'email', value: 'ann@example.com' }),
    ]);
    store.ackCoreWork({ identities: work.identities.map((i) => i.id) });
    expect(store.hasCoreWork()).toBe(false);

    const linked = store.applyCrmFacts([
      { kind: 'link', id: 'l1', contactId: 'c_ann', visitorId: 'laptop', source: 'form', ts: T0 + 2 * DAY },
      { kind: 'link', id: 'l2', contactId: 'c_ann', visitorId: 'phone', source: 'identify', ts: T0 + 2 * DAY },
      { kind: 'link', id: 'l2', contactId: 'c_ann', visitorId: 'phone', source: 'identify', ts: T0 + 2 * DAY },
    ]);
    expect(linked).toMatchObject({ applied: 2, duplicates: 1 });
    expect(linked?.linked.map((l) => l.visitorId).sort()).toEqual(['laptop', 'phone']);

    // A CRM payment of the contact lands on its latest visitor; attribution sees both devices.
    store.applyCrmFacts([
      {
        kind: 'payment',
        id: 'p1',
        transactionId: 'crm_pay1',
        contactId: 'c_ann',
        visitorId: null,
        orderId: 'ord1',
        amountMinor: 5000,
        currency: 'EUR',
        renewal: false,
        ts: T0 + 3 * DAY,
      },
    ]);
    const profile = store.visitorProfile('laptop');
    expect(profile?.linked_visitor_ids).toEqual(['phone']);
    expect(profile?.sessions.map((s) => s.id).sort()).toEqual(['a1', 'b1']);
    expect(profile?.payments).toHaveLength(1);
    expect(profile?.first_touch?.channel).toBe('Paid social');
    expect(profile?.last_non_direct_touch?.channel).toBe('Paid social');
    expect(profile?.time_to_conversion).toMatchObject({ sessions_before_purchase: 2, days_to_purchase: 3 });
    const channels = store.breakdown(range, 'channel', 10, 'first_touch');
    expect(channels.ok && channels.value.rows.find((r) => r.value === 'Paid social')?.revenue_minor).toBe(5000);
    expect(db.all(`SELECT visitor_id FROM payments`)).toEqual([{ visitor_id: 'phone' }]);
  });

  it('queues the email-click contact token of a landing pageview', () => {
    const { store } = seededStore();
    store.ingest([ev({ vid: 'v9', sid: 's9', ts: T0, contactToken: 'abc.def' })], []);
    expect(store.pullCoreWork().identities).toEqual([
      expect.objectContaining({ visitorId: 'v9', kind: 'contact_token', value: 'abc.def' }),
    ]);
  });
});

describe('revenue from CRM orders', () => {
  const pay = (id: string, amount: number, ts: number, orderId = 'ord1') => ({
    kind: 'payment' as const,
    id,
    transactionId: `crm_${id}`,
    contactId: 'c1',
    visitorId: 'v1',
    orderId,
    amountMinor: amount,
    currency: 'EUR',
    renewal: false,
    ts,
  });

  it('is idempotent and handles partial, full and order-level refunds', () => {
    const { store, db } = seededStore();
    store.ingest([ev({ vid: 'v1', sid: 's1', ts: T0, channel: 'Email' })], []);
    store.applyCrmFacts([pay('pay1', 10_000, T0 + MIN)]);
    store.applyCrmFacts([pay('pay1', 10_000, T0 + MIN)]);
    const revenue = (): number => {
      const o = store.overview(range);
      return o.ok ? o.value.revenue_minor : -1;
    };
    expect(revenue()).toBe(10_000);
    expect(db.all(`SELECT revenue_minor FROM sessions WHERE id = 's1'`)).toEqual([{ revenue_minor: 10_000 }]);
    // The visitor id on the order is an identification too.
    expect(db.all(`SELECT contact_id, link_source FROM visitors WHERE id = 'v1'`)).toEqual([
      { contact_id: 'c1', link_source: 'order' },
    ]);
    const refund = { kind: 'refund' as const, id: 'r1', transactionId: 'crm_pay1', orderId: 'ord1', amountMinor: 2500, ts: T0 + 2 * MIN };
    store.applyCrmFacts([refund]);
    store.applyCrmFacts([refund]);
    expect(revenue()).toBe(7_500);
    // Order-level refund (no payment id): newest payments first.
    store.applyCrmFacts([pay('pay2', 4_000, T0 + 3 * MIN)]);
    store.applyCrmFacts([{ kind: 'refund', id: 'r2', transactionId: null, orderId: 'ord1', amountMinor: 6_000, ts: T0 + 4 * MIN }]);
    expect(revenue()).toBe(5_500);
    expect(db.all(`SELECT transaction_id, refunded, refunded_minor FROM payments ORDER BY transaction_id`)).toEqual([
      { transaction_id: 'crm_pay1', refunded: 0, refunded_minor: 4_500 },
      { transaction_id: 'crm_pay2', refunded: 1, refunded_minor: 4_000 },
    ]);
    // Rollups follow (daily timeseries reads them).
    const ts = store.timeseries(range, 'day');
    const total = ts.ok ? ts.value.points.reduce((a, p) => a + p.revenue_minor, 0) : -1;
    expect(total).toBe(5_500);
  });

  it('credits an order placed days after the visit to its last session in non-source breakdowns', () => {
    const { store } = seededStore();
    store.ingest(
      [
        ev({ vid: 'v1', sid: 's1', ts: T0, channel: 'Email', device: 'mobile' }),
        ev({ vid: 'v1', sid: 's2', ts: T0 + DAY, channel: 'Direct', device: 'desktop' }),
        ev({
          vid: 'v2',
          sid: 's3',
          ts: T0,
          device: 'mobile',
          geo: { country: 'FR', region: null, city: null, latitude: null, longitude: null },
        }),
      ],
      [],
    );
    store.applyCrmFacts([pay('late', 12_000, T0 + 5 * DAY)]);
    const revenueBy = (dimension: 'device' | 'country', filters?: { dimension: 'device'; op: 'is'; value: string }[]) => {
      const r = store.breakdown({ ...range, filters }, dimension, 10);
      if (!r.ok) throw new Error(r.error.message);
      return Object.fromEntries(r.value.rows.map((row) => [row.value, row.revenue_minor]));
    };
    expect(revenueBy('device')).toEqual({ desktop: 12_000, mobile: 0 });
    expect(revenueBy('country')).toEqual({ IT: 12_000, FR: 0 });
    const filtered = store.overview({ ...range, filters: [{ dimension: 'device', op: 'is', value: 'desktop' }] });
    expect(filtered.ok && filtered.value.revenue_minor).toBe(12_000);
    expect(filtered.ok && filtered.value.customers).toBe(1);
    const mobile = store.overview({ ...range, filters: [{ dimension: 'device', op: 'is', value: 'mobile' }] });
    expect(mobile.ok && mobile.value.revenue_minor).toBe(0);
  });

  it('records lifecycle goals on the visitor and fires matching alerts', () => {
    const { store, db } = seededStore();
    store.ingest([ev({ vid: 'v1', sid: 's1', ts: T0 })], []);
    const alert = store.createAlert(
      { name: 'Trials', goal: 'trial_started', enabled: true, email_recipients: [], webhook_url: null },
      null,
    );
    store.createAlert({ name: 'Off', goal: 'trial_started', enabled: false, email_recipients: [], webhook_url: null }, null);
    const r = store.applyCrmFacts([
      { kind: 'goal', id: 'g1', name: 'trial_started', contactId: 'c1', visitorId: 'v1', params: { planId: 'p1' }, ts: T0 + MIN },
    ]);
    expect(r?.pending).toBe(true);
    expect(db.all(`SELECT name, session_id FROM goals`)).toEqual([{ name: 'trial_started', session_id: 's1' }]);
    const work = store.pullCoreWork();
    expect(work.alerts).toEqual([expect.objectContaining({ alertId: alert.alert.id, goal: 'trial_started' })]);
    // Lifecycle goals reach automations through the CRM outbox, not twice.
    expect(work.automation).toEqual([]);
  });

  it('queues web goals and first page visits of identified visitors for automations', () => {
    const { store } = seededStore();
    store.ingest([ev({ vid: 'v1', sid: 's1', ts: T0 })], []);
    store.applyCrmFacts([{ kind: 'link', id: 'l', contactId: 'c1', visitorId: 'v1', source: 'form', ts: T0 }]);
    store.ingest(
      [
        ev({ vid: 'v1', sid: 's1', ts: T0 + MIN, path: '/pricing' }),
        ev({ vid: 'v1', sid: 's1', ts: T0 + 2 * MIN, path: '/pricing' }),
        ev({ vid: 'v1', sid: 's1', ts: T0 + 3 * MIN, type: 'goal', name: 'signup', path: '/pricing' }),
        ev({ vid: 'other', sid: 'x', ts: T0 + 3 * MIN, type: 'goal', name: 'signup' }),
      ],
      [],
    );
    const items = store.pullCoreWork().automation;
    expect(items.map((i) => [i.kind, i.contactId, i.name ?? i.path])).toEqual([
      ['pageview', 'c1', '/pricing'],
      ['goal', 'c1', 'signup'],
    ]);
  });
});

describe('funnels', () => {
  const steps: StoredFunnelStep[] = [
    { type: 'pageview', value: '/', match: 'exact' },
    { type: 'pageview', value: '/pricing', match: 'contains' },
    { type: 'goal', value: 'signup', match: 'exact' },
  ];

  it('counts ordered steps per visitor with median times', () => {
    const e = (visitor: string, ts: number, kind: 'pageview' | 'goal', value: string) => ({ visitor, ts, kind, value });
    const out = computeFunnel(
      steps,
      [
        e('a', 10, 'pageview', '/'),
        e('a', 20, 'pageview', '/pricing/annual'),
        e('a', 50, 'goal', 'signup'),
        e('b', 10, 'pageview', '/'),
        e('b', 40, 'pageview', '/pricing'),
        // goal before the pricing page does not count
        e('c', 5, 'goal', 'signup'),
        e('c', 10, 'pageview', '/'),
        e('c', 30, 'pageview', '/pricing'),
        // entering before the range is ignored
        e('d', 1, 'pageview', '/'),
      ],
      { from: 2, to: 100 },
    );
    expect(out.map((s) => s.visitors)).toEqual([3, 3, 1]);
    expect(out[1]?.elapsed.sort((x, y) => x - y)).toEqual([10, 20, 30]);
    expect(out[2]?.elapsed).toEqual([30]);
  });

  it('computes results through the store (CRUD + filters)', () => {
    const { store } = seededStore();
    store.ingest(
      [
        ev({ vid: 'a', sid: 'a1', ts: T0, path: '/' }),
        ev({ vid: 'a', sid: 'a1', ts: T0 + MIN, path: '/pricing' }),
        ev({ vid: 'a', sid: 'a1', ts: T0 + 2 * MIN, type: 'goal', name: 'signup', path: '/pricing' }),
        ev({ vid: 'b', sid: 'b1', ts: T0, path: '/', device: 'mobile' }),
      ],
      [],
    );
    const funnel = store.createFunnel({
      name: 'Signup',
      steps: [
        { type: 'pageview', value: '/', match: 'exact' },
        { type: 'pageview', value: '/pricing', match: 'exact' },
        { type: 'goal', value: 'signup', match: 'contains' },
      ],
    });
    expect(funnel.steps[2]?.match).toBe('exact');
    const result = store.funnelResult(funnel.id, range);
    expect(result.ok && result.value).toMatchObject({
      entered: 2,
      completed: 1,
      conversion_rate: 0.5,
      steps: [
        { visitors: 2, dropoff: 0 },
        { visitors: 1, dropoff: 1, step_conversion_rate: 0.5, median_ms_from_previous: MIN },
        { visitors: 1, dropoff: 0 },
      ],
    });
    const mobile = store.funnelResult(funnel.id, { ...range, filters: [{ dimension: 'device', op: 'is', value: 'mobile' }] });
    expect(mobile.ok && mobile.value.entered).toBe(1);
    expect(store.updateFunnel(funnel.id, { name: 'Renamed' })?.name).toBe('Renamed');
    expect(store.deleteFunnel(funnel.id)).toBe(true);
    expect(store.funnelResult(funnel.id, range).ok).toBe(false);
  });
});

describe('insights', () => {
  it('aggregates revenue by segment, time to purchase, converting goals and the heatmap', () => {
    const { store } = seededStore();
    const payment = (tx: string, amount: number) => ({
      amountMinor: amount,
      currency: 'EUR',
      transactionId: tx,
      email: null,
      customerId: null,
      renewal: false,
      refunded: false,
      freeTrial: false,
    });
    // Wednesday 2026-10-14 10:00 UTC; buyer 1 visits twice over two days.
    const wed = Date.UTC(2026, 9, 14, 10, 0, 0);
    store.ingest(
      [
        ev({ vid: 'b1', sid: 'b1a', ts: wed - 2 * DAY, device: 'desktop' }),
        ev({ vid: 'b1', sid: 'b1a', ts: wed - 2 * DAY + MIN, type: 'goal', name: 'demo' }),
        ev({ vid: 'b1', sid: 'b1b', ts: wed, device: 'desktop' }),
        ev({ vid: 'b1', sid: 'b1b', ts: wed + MIN, type: 'payment', payment: payment('t1', 12_000) }),
        ev({ vid: 'b2', sid: 'b2a', ts: wed, device: 'mobile', geo: { country: 'DE', region: null, city: null, latitude: null, longitude: null } }),
        ev({ vid: 'b2', sid: 'b2a', ts: wed + MIN, type: 'payment', payment: payment('t2', 3_000) }),
        ev({ vid: 'n1', sid: 'n1a', ts: wed, device: 'mobile' }),
        ev({ vid: 'n1', sid: 'n1a', ts: wed + MIN, type: 'goal', name: 'demo' }),
        ev({ vid: 'n2', sid: 'n2a', ts: wed, device: 'mobile' }),
      ],
      [],
    );
    const r = store.insights(range, 'week');
    if (!r.ok) throw new Error(r.error.message);
    const i = r.value;
    expect(i).toMatchObject({ visitors: 4, customers: 2, revenue_minor: 15_000, median_hours_to_purchase: 24.02 });
    expect(i.revenue_by_device).toEqual([
      { value: 'desktop', visitors: 1, customers: 1, revenue_minor: 12_000, conversion_rate: 1 },
      { value: 'mobile', visitors: 3, customers: 1, revenue_minor: 3_000, conversion_rate: 0.3333 },
    ]);
    expect(i.top_countries_by_revenue[0]).toMatchObject({ value: 'IT', revenue_minor: 12_000 });
    expect(i.visits_before_purchase).toMatchObject({ median: 1.5, average: 1.5 });
    expect(i.visits_before_purchase.buckets.slice(0, 2)).toEqual([
      { bucket: '1', customers: 1 },
      { bucket: '2', customers: 1 },
    ]);
    expect(i.converting_events).toEqual([
      { goal: 'demo', visitors: 2, customers: 1, conversion_rate: 0.5, revenue_minor: 12_000 },
    ]);
    expect(i.heatmap).toEqual([{ day: 2, hour: 10, conversions: 2 }]);
    expect(i.revenue_per_visitor.reduce((a, p) => a + p.revenue_minor, 0)).toBe(15_000);
  });
});

describe('conversion prediction', () => {
  const samples: TrainingSample[] = [];
  for (let i = 0; i < 60; i += 1) {
    const buyer = i % 5 === 0;
    samples.push({
      features: featuresOf(
        {
          first_channel: buyer ? 'Email' : 'Direct',
          device: i % 2 === 0 ? 'desktop' : 'mobile',
          country: 'IT',
          sessions: buyer ? 3 : 1,
          pageviews: buyer ? 6 : 1,
          duration: buyer ? 400_000 : 10_000,
          paid: 0,
          goals: buyer ? 1 : 0,
        },
        ['IT'],
      ),
      label: buyer ? 1 : 0,
    });
  }

  it('trains deterministically and ranks engaged visitors higher', () => {
    const a = trainLogistic(samples);
    const b = trainLogistic(samples);
    expect(a).toEqual(b);
    expect(a.accuracy).toBe(1);
    const model = {
      version: 1,
      trained_at: 0,
      currency: 'EUR',
      ...a,
      countries: ['IT'],
      samples: 60,
      positives: 12,
      base_rate: 0.2,
      aov_minor: 10_000,
    };
    const engaged = scoreFacts(model, { first_channel: 'Email', device: 'desktop', country: 'IT', sessions: 3, pageviews: 6, duration: 400_000, paid: 0, goals: 1 });
    const bounce = scoreFacts(model, { first_channel: 'Direct', device: 'mobile', country: 'FR', sessions: 1, pageviews: 1, duration: 1000, paid: 0, goals: 0 });
    expect(engaged.score).toBeGreaterThan(80);
    expect(bounce.score).toBeLessThan(20);
    expect(engaged.expected_value_minor).toBe(Math.round(engaged.conversion_rate * 10_000));
    expect(scoreFacts(model, { first_channel: 'Email', device: 'desktop', country: 'IT', sessions: 3, pageviews: 6, duration: 400_000, paid: 0, goals: 1 })).toEqual(engaged);
  });

  it('trains the site model from history and scores visitors in the list', () => {
    const { store } = seededStore();
    const events = [];
    for (let i = 0; i < 40; i += 1) {
      const buyer = i % 4 === 0;
      const vid = `vis-${String(i).padStart(3, '0')}`;
      events.push(ev({ vid, sid: `s-${i}`, ts: T0 + i * MIN, channel: buyer ? 'Email' : 'Direct', path: '/' }));
      if (buyer) {
        events.push(ev({ vid, sid: `s-${i}`, ts: T0 + i * MIN + 1000, path: '/pricing' }));
        events.push(
          ev({
            vid,
            sid: `s-${i}`,
            ts: T0 + i * MIN + 2000,
            type: 'payment',
            payment: { amountMinor: 5000, currency: 'EUR', transactionId: `t${i}`, email: null, customerId: null, renewal: false, refunded: false, freeTrial: false },
          }),
        );
      }
    }
    store.ingest(events, []);
    const first = store.trainPrediction();
    const second = store.trainPrediction();
    expect(first).toMatchObject({ samples: 40, positives: 10, base_rate: 0.25, average_order_value_minor: 5000 });
    expect(second?.top_features).toEqual(first?.top_features);
    const list = store.visitors(range, { sort: 'score', limit: 5 });
    expect(list.ok && list.value.data[0]?.prediction?.score).toBeGreaterThan(50);
    expect(list.ok && list.value.data[0]?.customer).toBe(true);
  });
});

describe('realtime hub (hibernatable sockets)', () => {
  class FakeSocket implements RealtimeSocket {
    sent: string[] = [];
    send(m: string): void {
      this.sent.push(m);
    }
  }
  const snapshot: AnalyticsRealtime = {
    site_id: 'st',
    currency: 'EUR',
    online: 1,
    window_minutes: 30,
    visitors: [
      {
        visitor_id: 'v',
        session_id: 's',
        country: 'IT',
        region: null,
        city: null,
        latitude: null,
        longitude: null,
        page: '/',
        hostname: null,
        referrer_host: null,
        channel: 'Direct',
        device: null,
        browser: null,
        os: null,
        started_at: '',
        last_seen: '',
        pageviews: 1,
        revenue_minor: 0,
        name: 'Ann',
        contact_id: 'c1',
      },
    ],
    events: [],
    countries: [],
    pages: [],
    referrers: [],
  };
  const event: RealtimeEvent = {
    type: 'goal',
    ts: '2026-10-15T10:00:00.000Z',
    visitor_id: 'v',
    path: '/',
    name: 'signup',
    country: 'IT',
    city: 'Milan',
    latitude: 45,
    longitude: 9,
    channel: 'Direct',
    device: 'desktop',
    amount_minor: null,
    currency: null,
    label: 'Ann',
  };

  it('greets, answers pings and fans out events (identities only to private viewers)', () => {
    const priv = new FakeSocket();
    const pub = new FakeSocket();
    const hub = new RealtimeHub((tag) => (tag === 'private' ? [priv] : [pub]), () => snapshot);
    hub.greet(priv, false);
    hub.greet(pub, true);
    expect(JSON.parse(priv.sent[0] ?? '{}')).toMatchObject({ type: 'snapshot', data: { visitors: [{ name: 'Ann' }] } });
    expect(JSON.parse(pub.sent[0] ?? '{}')).toMatchObject({ type: 'snapshot', data: { visitors: [{ name: null, contact_id: null }] } });
    hub.onMessage(priv, '{"type":"ping"}', false);
    expect(priv.sent.at(-1)).toBe('{"type":"pong"}');
    hub.onMessage(priv, 'garbage', false);
    hub.onMessage(priv, new ArrayBuffer(4), false);
    expect(priv.sent).toHaveLength(2);
    expect(hub.broadcast([event])).toBe(2);
    expect(JSON.parse(priv.sent.at(-1) ?? '{}')).toMatchObject({ type: 'event', data: { label: 'Ann', name: 'signup' } });
    expect(JSON.parse(pub.sent.at(-1) ?? '{}')).toMatchObject({ type: 'event', data: { label: null } });
    expect(hub.broadcast([])).toBe(0);
  });

  it('ingest returns live events for the socket fan-out', () => {
    const { store } = seededStore();
    const r = store.ingest([ev({ vid: 'v1', sid: 's1', ts: T0 })], []);
    expect(r.live).toEqual([expect.objectContaining({ type: 'pageview', visitor_id: 'v1', path: '/', country: 'IT' })]);
    expect(store.realtime()?.visitors).toHaveLength(0);
  });
});

describe('crawler IP verification', () => {
  it('matches IPv4 / IPv6 CIDRs', () => {
    expect(inCidr('66.249.66.1', '66.249.64.0/19')).toBe(true);
    expect(inCidr('66.249.96.1', '66.249.64.0/19')).toBe(false);
    expect(inCidr('2001:4860:4801:10::1', '2001:4860:4801::/48')).toBe(true);
    expect(inCidr('2001:4860:4802::1', '2001:4860:4801::/48')).toBe(false);
    expect(inCidr('::ffff:66.249.66.1', '66.249.64.0/19')).toBe(true);
    expect(parseIp('1.2.3')).toBeNull();
    expect(parseIp('1::2::3')).toBeNull();
  });

  it('verifies, flags spoofing and stays unknown without a published list', () => {
    expect(verifyCrawlerIp('Googlebot', '66.249.66.1')).toBe('verified');
    expect(verifyCrawlerIp('Googlebot', '203.0.113.9')).toBe('spoofed');
    expect(verifyCrawlerIp('GPTBot', '52.230.152.10')).toBe('verified');
    expect(verifyCrawlerIp('CCBot', '203.0.113.9')).toBe('unknown');
    expect(verifyCrawlerIp('Googlebot', null)).toBe('unknown');
  });

  it('counts verified and spoofed hits in the bots report', () => {
    const { store } = seededStore();
    const hit = (verification: 'verified' | 'spoofed' | 'unknown') => ({
      site: 'st_aaaaaaaaaaaaaaaaaaaa',
      ts: T0,
      name: 'Googlebot',
      provider: 'Google',
      category: 'indexing' as const,
      path: '/',
      verification,
    });
    store.ingest([], [hit('verified'), hit('verified'), hit('spoofed'), hit('unknown')]);
    const r = store.bots(range);
    expect(r.ok && r.value.bots).toEqual([
      { bot: 'Googlebot', provider: 'Google', category: 'indexing', hits: 4, verified_hits: 2, spoofed_hits: 1 },
    ]);
    expect(r.ok && r.value.categories).toEqual([{ value: 'indexing', hits: 4 }]);
  });
});
