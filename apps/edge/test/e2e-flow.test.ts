import { createHash } from 'node:crypto';
import { createMetaProvider } from '@amable/ads-providers';
import type { AttributionModelV2, FunnelGraph, FunnelGraphInput, PerformanceRow, TrafficSource } from '@amable/api-types';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLinkRoutes, directLinkViews } from '../src/analytics/link-routes';
import type { LinkSiteResolver } from '../src/analytics/links/site';
import { processOutboundBatch, type ProviderResolver } from '../src/analytics/outbound-worker';
import { clearSiteConfigCache } from '../src/analytics/pipeline';
import { analyticsRoutes } from '../src/analytics/routes';
import type { AnalyticsStore } from '../src/analytics/store/index';
import type { Env } from '../src/env';
import { edgeEnv, FakeAnalyticsNamespace, SITE_ID, siteInit, T0 } from './helpers';
import { CHROME_DESKTOP, IPHONE } from './link-fixtures';

/**
 * End-to-end funnel tracking: tracking link entrance → tracker pageview →
 * action link → conversion postback → attribution reports, outbound
 * conversion and visitor journey, through the real routes and store.
 */

const DAY = 86_400_000;
const TRACKING_HOST = 'go.shop.example.com';
const EDGE_HOST = 'edge.amable.test';
const SHARED = `/s/${SITE_ID}`;
const LANDER_ORIGIN = 'https://lp.example.com';

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

function funnelInput(): FunnelGraphInput {
  return {
    name: 'Autumn launch',
    nodes: [
      { id: 't', kind: 'traffic', config: {} },
      { id: 'rot', kind: 'rotator', config: { stickiness: 'sticky' } },
      {
        id: 'cond',
        kind: 'condition',
        config: {
          routes: [
            {
              id: 'r_mobile',
              label: 'Mobile',
              priority: 1,
              groups: [{ match: 'all', rules: [{ attr: 'device', op: 'is', values: ['mobile'] }] }],
            },
          ],
        },
      },
      {
        id: 'landerA',
        kind: 'page_group',
        config: {
          page_type: 'lander',
          pages: [{ id: 'la1', name: 'Lander A', url: `${LANDER_ORIGIN}/a`, weight: 1 }],
          data_params: { sub: '{campaign}' },
        },
      },
      {
        id: 'landerB',
        kind: 'page_group',
        config: { page_type: 'lander', pages: [{ id: 'lb1', name: 'Lander B', url: `${LANDER_ORIGIN}/b`, weight: 1 }] },
      },
      {
        id: 'offer',
        kind: 'page_group',
        config: {
          page_type: 'offer',
          pages: [{ id: 'o1', name: 'Offer', url: 'https://offer.example.net/o?aff=1', weight: 1 }],
          data_params: { s1: '{hit}' },
        },
      },
    ],
    edges: [
      { id: 'e_t', from: 't', to: 'rot', via: { type: 'default' } },
      { id: 'e_rot_cond', from: 'rot', to: 'cond', via: { type: 'weight', weight: 3 } },
      { id: 'e_rot_b', from: 'rot', to: 'landerB', via: { type: 'weight', weight: 1 } },
      { id: 'e_mobile', from: 'cond', to: 'landerB', via: { type: 'route', route_id: 'r_mobile' } },
      { id: 'e_cond_a', from: 'cond', to: 'landerA', via: { type: 'default' } },
      { id: 'e_a1', from: 'landerA', to: 'offer', via: { type: 'action', actions: [1] } },
      { id: 'e_a_fallback', from: 'landerA', to: 'offer', via: { type: 'default' } },
      { id: 'e_b1', from: 'landerB', to: 'offer', via: { type: 'action', actions: [1] } },
      { id: 'e_b_fallback', from: 'landerB', to: 'offer', via: { type: 'default' } },
    ],
  };
}

interface Flow {
  store: AnalyticsStore;
  graph: FunnelGraph;
  source: TrafficSource;
  get(path: string, init?: { headers?: Record<string, string>; cf?: Record<string, unknown> }, host?: string): Promise<Response>;
  /** Tracker `POST /e` from a page of the site. */
  track(body: Record<string, unknown>, origin?: string): Promise<Response>;
  at(ts: number): void;
  settle(): Promise<void>;
}

function setup(): Flow {
  clearSiteConfigCache();
  const ns = new FakeAnalyticsNamespace(() => Date.now());
  const env = edgeEnv(ns) as Env;
  const store = ns.store(`site:${SITE_ID}`);
  store.initSite(siteInit({ hostnames: ['example.com', 'example.net'] }));
  store.upsertAdConnection({ id: 'conn_meta', platform: 'meta', account_id: 'act_1', metadata: { pixel_id: 'px_42' } });
  const source = store.createTrafficSource({
    name: 'Social ads',
    template: 'meta',
    cost_type: 'cpc',
    default_cost_minor: 5,
    reserved_fields: {
      campaign: { url_param: 'cid', source_token: '{{campaign.id}}' },
      external: { url_param: 'fbclid', source_token: '', append: false },
    },
    fields: [{ slot: 'c1', name: 'adset', url_param: 'adset', source_token: '{{adset.id}}' }],
    conversion: { ad_connection_id: 'conn_meta', platform: 'meta', mapping: [{ event: 'sale', platform_event: 'Purchase' }] },
  });
  const graph = store.createFunnelGraph(funnelInput());
  if (!source.ok || !graph.ok) throw new Error('fixture');

  const resolver: LinkSiteResolver = (_env, host) =>
    Promise.resolve(host === TRACKING_HOST ? { siteId: SITE_ID, tenantId: null, basePath: '' } : null);
  const app = new Hono<{ Bindings: Env }>()
    .use('/e', directLinkViews)
    .route('/', analyticsRoutes)
    .route('/', createLinkRoutes({ resolvers: [resolver], rng: () => 0.1, now: () => Date.now(), hostedPages: () => () => Promise.resolve(null) }));
  const pending: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;

  return {
    store,
    graph: graph.value,
    source: source.value,
    get(path, init = {}, host = TRACKING_HOST) {
      const request = new Request(`https://${host}${path}`, { headers: { 'user-agent': CHROME_DESKTOP, ...init.headers } });
      if (init.cf !== undefined) Object.defineProperty(request, 'cf', { value: init.cf });
      return Promise.resolve(app.fetch(request, env, executionCtx));
    },
    track(body, origin = LANDER_ORIGIN) {
      const request = new Request(`https://${TRACKING_HOST}/e`, {
        method: 'POST',
        headers: { origin, 'user-agent': CHROME_DESKTOP, 'content-type': 'text/plain' },
        body: JSON.stringify({ site: SITE_ID, ...body }),
      });
      return Promise.resolve(app.fetch(request, env, executionCtx));
    },
    at(ts) {
      vi.setSystemTime(ts);
    },
    async settle() {
      while (pending.length > 0) await Promise.all(pending.splice(0));
    },
  };
}

const location = (res: Response): URL => new URL(res.headers.get('location') ?? '');


interface Visit {
  funnelVisitor: string;
  /** Tracker visitor of the lander pages. */
  trackerVisitor: string;
  /** Offer view of the converting visit. */
  hit: string;
}

const START = T0 - 14 * DAY;
const CLICK_DELAY_MS = 30_000;
/** The offer view of the last visit (its touch is 1 ms after the click); the postback comes right then. */
const CONVERSION_AT = T0 + CLICK_DELAY_MS + 1;
const CAMPAIGNS = [
  { cid: 'CA', adset: 'AS1', fbclid: 'FB-A', at: START },
  { cid: 'CB', adset: 'AS2', fbclid: 'FB-B', at: START + 7 * DAY },
  { cid: 'CC', adset: 'AS3', fbclid: 'FB-C', at: T0 },
] as const;

/**
 * Three ad clicks of the same browser a week apart (campaigns CA, CB, CC) on
 * the shared edge host; each time the lander loads the tracker and the
 * visitor clicks through to the offer (action link on the tracking host).
 */
async function visitThreeTimes(f: Flow): Promise<Visit> {
  const trackerVisitor = 'tracker-visitor-1';
  let funnelVisitor = '';
  let hit = '';
  for (const [i, c] of CAMPAIGNS.entries()) {
    f.at(c.at);
    const link = `${SHARED}/go/${f.graph.id}-${f.source.id}?cid=${c.cid}&adset=${c.adset}&fbclid=${c.fbclid}&extra=SECRET-${i}`;
    const entrance = await f.get(link, funnelVisitor === '' ? {} : { headers: { cookie: `amb_fvid=${funnelVisitor}` } }, EDGE_HOST);
    expect(entrance.status).toBe(302);
    const landing = location(entrance);
    funnelVisitor = landing.searchParams.get('vid') ?? '';
    expect(landing.toString()).toBe(`${LANDER_ORIGIN}/a?sub=${c.cid}&vid=${funnelVisitor}&n=landerA`);
    expect(entrance.headers.get('set-cookie')).toContain(`Path=${SHARED}`);

    // Tracker on the lander: pageview with the funnel context of the URL.
    const view = await f.track({
      type: 'pageview',
      url: landing.toString(),
      vid: trackerVisitor,
      sid: `tracker-session-${i}`,
      dl: { vid: funnelVisitor, n: 'landerA' },
    });
    expect(view.status).toBe(202);
    await f.settle();

    // Decorated action link (`vid` + `rn`), on the tracking host.
    f.at(c.at + CLICK_DELAY_MS);
    const click = await f.get(`/a/1?vid=${funnelVisitor}&rn=landerA`, { headers: { referer: landing.toString() } });
    expect(click.status).toBe(302);
    const offer = location(click);
    expect(offer.origin + offer.pathname).toBe('https://offer.example.net/o');
    hit = offer.searchParams.get('s1') ?? '';
    expect(offer.searchParams.get('vid')).toBe(funnelVisitor);
  }
  return { funnelVisitor, trackerVisitor, hit };
}

const REVENUE = 21_000;
const PB = `rev=210.00&tx=ORD-1001&pii_email=Ann.Doe%40Example.com&pii_phone=%2B39%20333%20123%204567`;

/**
 * Revenue per campaign (CA, CB, CC) of each model, by hand. The arrivals are
 * 14 days + δ, 7 days + δ and δ before the sale (δ = click delay + 1 ms): the
 * common δ cancels out of the normalized time-decay weights.
 */
const EXPECTED: Array<{ model: AttributionModelV2; window?: number; revenue: [number, number, number] }> = [
  { model: 'first_click', revenue: [21_000, 0, 0] },
  { model: 'last_click', revenue: [0, 0, 21_000] },
  { model: 'linear', revenue: [7_000, 7_000, 7_000] },
  // 40% first, 20% middle, 40% last.
  { model: 'u_shaped', revenue: [8_400, 4_200, 8_400] },
  // Half-life 7 days: weights 1/4, 1/2, 1 → 1/7, 2/7, 4/7.
  { model: 'time_decay', revenue: [3_000, 6_000, 12_000] },
  // First click 14 days old: outside a 7-day window (last click), inside a 30-day one (first click).
  { model: 'windowed_hybrid', window: 7, revenue: [0, 0, 21_000] },
  { model: 'windowed_hybrid', window: 30, revenue: [21_000, 0, 0] },
];

/** Synced spend of the three campaigns (fake ad platform data). */
function syncSpend(store: AnalyticsStore): void {
  expect(
    store.upsertAdEntities(
      [
        { platform: 'meta', level: 'campaign', external_id: 'CA', name: 'Autumn A', status: 'active' },
        { platform: 'meta', level: 'campaign', external_id: 'CB', name: 'Autumn B', status: 'active' },
        { platform: 'meta', level: 'campaign', external_id: 'CC', name: 'Autumn C', status: 'active' },
      ],
      'conn_meta',
    ).ok,
  ).toBe(true);
  expect(
    store.upsertAdSpend(
      [
        { platform: 'meta', entity_external_id: 'CA', day: '2026-10-01', spend_minor: 3_000 },
        { platform: 'meta', entity_external_id: 'CB', day: '2026-10-08', spend_minor: 2_000 },
        { platform: 'meta', entity_external_id: 'CC', day: '2026-10-15', spend_minor: 1_000 },
      ],
      'conn_meta',
    ).ok,
  ).toBe(true);
}

function campaignRows(store: AnalyticsStore, model: AttributionModelV2, windowDays = 7): Record<string, PerformanceRow> {
  const r = store.adsPerformanceReport({
    site_id: SITE_ID,
    from: '2026-10-01',
    to: '2026-10-31',
    model,
    window_days: windowDays,
    group_by: 'campaign',
  });
  if (!r.ok) throw new Error(r.error.message);
  return Object.fromEntries(r.value.rows.map((row) => [row.key ?? '', row]));
}

function expectAttribution(store: AnalyticsStore): void {
  for (const { model, window, revenue } of EXPECTED) {
    const rows = campaignRows(store, model, window);
    expect(
      ['CA', 'CB', 'CC'].map((k) => rows[k]?.revenue_minor),
      `${model}${window === undefined ? '' : ` ${window}d`}`,
    ).toEqual(revenue);
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('funnel tracking end to end', () => {
  it('tracks the clicks, attributes the postback, reports it with every model and forwards it to the ad platform', async () => {
    const f = setup();
    const { funnelVisitor, trackerVisitor, hit } = await visitThreeTimes(f);

    // An Italian mobile visitor goes through the condition to the other lander.
    f.at(START + 3_600_000);
    const mobile = await f.get(`${SHARED}/go/${f.graph.id}-${f.source.id}?cid=CA`, { headers: { 'user-agent': IPHONE }, cf: { country: 'IT' } }, EDGE_HOST);
    expect(location(mobile).toString()).toBe(`${LANDER_ORIGIN}/b?vid=${location(mobile).searchParams.get('vid')}&n=landerB`);

    // ---- touches: entrance + lander view + click + offer view per visit, fields only.
    const touches = f.store.listTouchesByVisitor(funnelVisitor);
    expect(touches.map((t) => [t.kind, t.node_id, t.campaign])).toEqual(
      CAMPAIGNS.flatMap((c) => [
        ['entrance', 't', c.cid],
        ['view', 'landerA', c.cid],
        ['click', 'landerA', c.cid],
        ['view', 'offer', c.cid],
      ]),
    );
    expect(touches[0]).toMatchObject({
      ts: START,
      funnel_id: f.graph.id,
      traffic_source_id: f.source.id,
      external_click_id: 'FB-A',
      fields: { c1: 'AS1' },
      cost_minor: 5,
    });
    expect(touches.at(-1)).toMatchObject({ id: hit, page_id: 'o1', ts: CONVERSION_AT, external_click_id: 'FB-C', fields: { c1: 'AS3' } });
    const db = (f.store as unknown as { db: { all: (q: string) => unknown[] } }).db;
    expect(JSON.stringify(db.all('SELECT * FROM touches'))).not.toContain('SECRET');

    // ---- the tracker visitor of the lander is the funnel visitor (one person).
    expect(f.store.resolveVisitorGroup(funnelVisitor).sort()).toEqual([funnelVisitor, trackerVisitor].sort());

    // ---- postback: attributed conversion, idempotent on hit + tx, on either host.
    f.at(CONVERSION_AT);
    expect((await f.get(`/pb?hit=${hit}&${PB}`)).status).toBe(200);
    expect((await f.get(`/pb?hit=${hit}&${PB}`)).status).toBe(200);
    expect((await f.get(`${SHARED}/pb?hit=${hit}&${PB}`, {}, EDGE_HOST)).status).toBe(200);
    const conversions = f.store.listConversions({ visitor_id: funnelVisitor });
    expect(conversions).toHaveLength(1);
    expect(conversions[0]).toMatchObject({
      hit,
      tx: 'ORD-1001',
      event: 'sale',
      status: 'approved',
      revenue_minor: REVENUE,
      currency: 'EUR',
      ts: CONVERSION_AT,
      funnel_id: f.graph.id,
      node_id: 'offer',
      page_id: 'o1',
      traffic_source_id: f.source.id,
    });
    for (const table of ['conversion_log', 'touches', 'identity_keys', 'visitors']) {
      const dump = JSON.stringify(db.all(`SELECT * FROM ${table}`)).toLowerCase();
      expect(dump).not.toContain('ann.doe');
      expect(dump).not.toContain('333 123');
    }

    // ---- reports: synced spend + attributed revenue, for every model.
    syncSpend(f.store);
    expectAttribution(f.store);
    const linear = campaignRows(f.store, 'linear');
    expect(linear['CA']).toMatchObject({ visits: 2, clicks: 1, cost_minor: 3_000, label: 'Autumn A', parent_key: 'meta' });
    expect(linear['CB']).toMatchObject({ visits: 1, clicks: 1, cost_minor: 2_000, revenue_minor: 7_000, roas: 3.5 });
    expect(linear['CC']).toMatchObject({ visits: 1, clicks: 1, cost_minor: 1_000, revenue_minor: 7_000, roas: 7 });
    const bySource = f.store.adsPerformanceReport({ site_id: SITE_ID, from: '2026-10-01', to: '2026-10-31', group_by: 'source' });
    expect(bySource.ok && bySource.value.totals).toMatchObject({ visits: 4, clicks: 3, cost_minor: 6_000, revenue_minor: REVENUE, roas: 3.5 });

    const journeys = f.store.adsJourneyReport({ site_id: SITE_ID, from: '2026-10-01', to: '2026-10-31', step: 'campaign', converted_only: true });
    expect(journeys.ok && journeys.value.rows).toEqual([
      // Steps are named after the synced campaigns.
      expect.objectContaining({ steps: ['Autumn A', 'Autumn B', 'Autumn C'], visitors: 1, conversions: 1, revenue_minor: REVENUE, avg_days_to_convert: 14 }),
    ]);
    const quality = f.store.trackingQuality({ site_id: SITE_ID, from: '2026-10-01', to: '2026-10-31' });
    expect(quality.ok && quality.value).toEqual({ conversions: 1, with_identity: 0, with_click_id: 1, with_touch: 1, score: 0.6667 });

    // ---- outbound: one job for the source connection, stable event id, PII while pending only.
    const eventId = sha256('conn_meta|tx:ORD-1001|purchase');
    const jobs = f.store.listOutbound();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      platform: 'meta',
      connection_id: 'conn_meta',
      kind: 'purchase',
      status: 'pending',
      event_id: eventId,
      payload: {
        event_name: 'Purchase',
        event_time: CONVERSION_AT,
        value_minor: REVENUE,
        currency: 'EUR',
        order_id: 'ORD-1001',
        click_ids: { fbclid: 'FB-C' },
        external_id: funnelVisitor,
        email: 'ann.doe@example.com',
        phone: '+39 333 123 4567',
      },
    });

    const requests: Request[] = [];
    const meta = createMetaProvider({
      clientId: 'app',
      clientSecret: 'secret',
      now: () => Date.now(),
      fetch: (input, init) => {
        requests.push(new Request(input, init));
        return Promise.resolve(Response.json({ events_received: 1, fbtrace_id: 'trace-1' }));
      },
    });
    const resolver: ProviderResolver = () => ({ provider: meta, token: 'tok' });
    expect(await processOutboundBatch(f.store, resolver, CONVERSION_AT)).toMatchObject({ claimed: 1, sent: 1 });
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!.url).pathname).toMatch(/\/px_42\/events$/);
    const raw = await requests[0]!.text();
    expect(raw).not.toContain('ann.doe');
    expect(raw).not.toContain('3331234567');
    const body = JSON.parse(raw) as { data: Array<Record<string, unknown>> };
    expect(body.data).toEqual([
      {
        event_name: 'Purchase',
        event_time: Math.floor(CONVERSION_AT / 1000),
        event_id: eventId,
        action_source: 'website',
        user_data: {
          em: [sha256('ann.doe@example.com')],
          ph: [sha256('393331234567')],
          external_id: [sha256(funnelVisitor)],
          fbc: `fb.1.${CONVERSION_AT}.FB-C`,
        },
        custom_data: { value: 210, currency: 'EUR', order_id: 'ORD-1001' },
      },
    ]);
    const sent = f.store.getOutbound(jobs[0]!.id);
    expect(sent?.status).toBe('sent');
    expect(sent?.payload).not.toHaveProperty('email');
    expect(sent?.payload).not.toHaveProperty('phone');
    // The repeated postback found the existing job.
    expect(f.store.listOutbound()).toHaveLength(1);

    // ---- journey of the visitor: every funnel touch of the person, chronological.
    const journey = f.store.listTouchesByVisitor(f.store.resolveVisitorGroup(trackerVisitor));
    expect(journey.map((t) => t.id)).toEqual(touches.map((t) => t.id));
    expect(f.store.visitorProfile(trackerVisitor)?.sessions).toHaveLength(3);
  });

  it('merges a phone-only identify after the click: same attribution, one journey', async () => {
    const f = setup();
    const { funnelVisitor, trackerVisitor, hit } = await visitThreeTimes(f);

    // The offer page has its own tracker visitor; its form captures a phone only.
    f.at(T0 + 60_000);
    const offerUrl = `https://offer.example.net/o?aff=1&s1=${hit}&vid=${funnelVisitor}&n=offer`;
    const offerVisitor = 'offer-visitor-1';
    expect((await f.track({ type: 'pageview', url: offerUrl, vid: offerVisitor, sid: 'offer-session-1', dl: { vid: funnelVisitor, n: 'offer' } }, 'https://offer.example.net')).status).toBe(202);
    expect((await f.track({ type: 'identify', url: offerUrl, vid: offerVisitor, sid: 'offer-session-1', data: { phone: '+39 333 123 4567' } }, 'https://offer.example.net')).status).toBe(202);
    await f.settle();
    expect((await f.get(`/pb?hit=${hit}&${PB}`)).status).toBe(200);

    // Days later, another device identifies with the same phone and becomes a CRM contact.
    f.at(T0 + 2 * DAY);
    const phoneVisitor = 'phone-visitor-1';
    await f.track({ type: 'pageview', url: `${LANDER_ORIGIN}/account`, vid: phoneVisitor, sid: 'phone-session-1' });
    await f.track({ type: 'identify', url: `${LANDER_ORIGIN}/account`, vid: phoneVisitor, sid: 'phone-session-1', data: { phone: '0039 333 1234567' } });
    await f.settle();
    f.store.applyCrmFacts([{ kind: 'link', id: 'link-1', contactId: 'ct_1', visitorId: phoneVisitor, source: 'identify', ts: T0 + 2 * DAY }]);

    const group = f.store.resolveVisitorGroup(phoneVisitor);
    expect([...group].sort()).toEqual([funnelVisitor, offerVisitor, phoneVisitor, trackerVisitor].sort());
    expect(f.store.visitorIdentityGraph(phoneVisitor)?.merges.map((m) => m.mechanism).sort()).toEqual(['phone', 'session', 'session']);

    // Attribution is unchanged by the merge.
    syncSpend(f.store);
    expectAttribution(f.store);
    const quality = f.store.trackingQuality({ site_id: SITE_ID, from: '2026-10-01', to: '2026-10-31' });
    expect(quality.ok && quality.value).toMatchObject({ conversions: 1, with_identity: 1, score: 1 });

    // The contact journey holds the ad touches of the funnel visitor and the sessions of its devices.
    const activity = f.store.contactActivity('ct_1', 100);
    expect(activity?.visitor_ids).toEqual([phoneVisitor]);
    expect([...(activity?.merged_visitor_ids ?? [])].sort()).toEqual([funnelVisitor, offerVisitor, trackerVisitor].sort());
    expect((activity?.funnel_touches ?? []).map((t) => [t.kind, t.campaign, t.campaign_name])).toEqual(
      CAMPAIGNS.flatMap((c) => {
        const name = `Autumn ${c.cid.slice(1)}`;
        return [
          ['entrance', c.cid, name],
          ['view', c.cid, name],
          ['click', c.cid, name],
          ['view', c.cid, name],
        ];
      }),
    );
    expect(activity?.funnel_touches?.[0]).toMatchObject({ funnel_name: 'Autumn launch', traffic_source_name: 'Social ads' });
    // Every touch of the person is identified now, so it outlives the anonymous retention.
    expect(
      (f.store as unknown as { db: { all: (q: string) => Array<{ n: number }> } }).db.all(
        'SELECT COUNT(*) AS n FROM touches WHERE identified = 0',
      )[0]?.n,
    ).toBe(0);
  });

  it('does not link visitors without the funnel vid in the landing URL, nor when session merges are off', async () => {
    const f = setup();
    f.at(START);
    const entrance = await f.get(`${SHARED}/go/${f.graph.id}-${f.source.id}?cid=CA`, {}, EDGE_HOST);
    const vid = location(entrance).searchParams.get('vid') ?? '';
    // Later pages resend the funnel context, without `vid` in their URL.
    await f.track({ type: 'pageview', url: `${LANDER_ORIGIN}/a/next`, vid: 'tracker-visitor-2', dl: { vid, n: 'landerA' } });
    await f.settle();
    expect(f.store.resolveVisitorGroup(vid)).toEqual([vid]);

    f.store.updateIdentitySettings({ session: false });
    await f.track({ type: 'pageview', url: location(entrance).toString(), vid: 'tracker-visitor-2', dl: { vid, n: 'landerA' } });
    await f.settle();
    expect(f.store.resolveVisitorGroup(vid)).toEqual([vid]);

    f.store.updateIdentitySettings({ session: true });
    await f.track({ type: 'pageview', url: location(entrance).toString(), vid: 'tracker-visitor-2', dl: { vid, n: 'landerA' } });
    await f.settle();
    expect([...f.store.resolveVisitorGroup(vid)].sort()).toEqual([vid, 'tracker-visitor-2'].sort());
  });
});
