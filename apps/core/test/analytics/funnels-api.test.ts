import { funnelHeatmapSchema, funnelLinksSchema, type FunnelGraphInput, type FunnelTouch } from '@amable/api-types';
import { beforeAll, describe, expect, it } from 'vitest';
import { FakeAnalyticsNamespace, T0 } from '../../../edge/test/helpers';
import { computeHeatmap } from '../../src/analytics/heatmap';
import { TRAFFIC_SOURCE_TEMPLATE_DEFS } from '../../src/analytics/traffic-source-templates';
import type { Env } from '../../src/env';
import {
  addMember,
  createHarness,
  login,
  seedTenant,
  seedUser,
  type Harness,
  type TestClient,
} from '../helpers/harness';

const BASE = '/api/v2/t/acme/analytics';
const OTHER = '/api/v2/t/other/analytics';

let h: Harness;
let ns: FakeAnalyticsNamespace;
let owner: TestClient;
let viewer: TestClient;
let stranger: TestClient;
let siteId = '';
let acmeId = '';

/** traffic → rotator → lander A (2 pages) / lander B → offer. */
const graphInput = (name = 'Main funnel'): FunnelGraphInput => ({
  name,
  nodes: [
    { id: 't', kind: 'traffic', config: {} },
    { id: 'r', kind: 'rotator', config: { stickiness: 'none' } },
    {
      id: 'la',
      kind: 'page_group',
      config: {
        page_type: 'lander',
        pages: [
          { id: 'la1', name: 'Lander A1', url: 'https://lander.test/a?ref=x', weight: 1 },
          { id: 'la2', name: 'Lander A2', url: 'https://lander.test/a2', weight: 1 },
        ],
      },
    },
    {
      id: 'lb',
      kind: 'page_group',
      config: { page_type: 'lander', pages: [{ id: 'lb1', name: 'Lander B', url: 'https://lander.test/b', weight: 1 }] },
    },
    {
      id: 'off',
      kind: 'page_group',
      config: { page_type: 'offer', pages: [{ id: 'o1', name: 'Offer', url: 'https://offer.test/buy', weight: 1 }] },
    },
  ],
  edges: [
    { id: 'e1', from: 't', to: 'r', via: { type: 'default' } },
    { id: 'e2', from: 'r', to: 'la', via: { type: 'weight', weight: 1 } },
    { id: 'e3', from: 'r', to: 'lb', via: { type: 'weight', weight: 1 } },
    { id: 'e4', from: 'la', to: 'off', via: { type: 'action', actions: [1, 2] } },
    { id: 'e5', from: 'la', to: 'off', via: { type: 'default' } },
    { id: 'e6', from: 'lb', to: 'off', via: { type: 'default' } },
  ],
});

const touch = (t: Partial<FunnelTouch> & Pick<FunnelTouch, 'id' | 'visitor_id' | 'node_id' | 'kind' | 'ts'>): FunnelTouch => ({
  session_id: `s-${t.visitor_id}`,
  funnel_id: 'F',
  ...t,
});

/** v1 converts through lander A, v2 bounces on lander B, v3 reloads lander A. */
function fixtureTouches(funnelId: string): FunnelTouch[] {
  return [
    touch({ id: 'h1', visitor_id: 'v1', node_id: 't', kind: 'entrance', ts: T0, cost_minor: 50 }),
    touch({ id: 'h2', visitor_id: 'v1', node_id: 'la', page_id: 'la1', kind: 'view', ts: T0 + 1000 }),
    touch({ id: 'h3', visitor_id: 'v1', node_id: 'la', page_id: 'la1', kind: 'click', action_number: 1, ts: T0 + 2000 }),
    touch({ id: 'h4', visitor_id: 'v1', node_id: 'off', page_id: 'o1', kind: 'view', ts: T0 + 3000 }),
    touch({ id: 'h5', visitor_id: 'v2', node_id: 't', kind: 'entrance', ts: T0 + 10_000, cost_minor: 50 }),
    touch({ id: 'h6', visitor_id: 'v2', node_id: 'lb', page_id: 'lb1', kind: 'view', ts: T0 + 11_000 }),
    touch({ id: 'h7', visitor_id: 'v3', node_id: 't', kind: 'entrance', ts: T0 + 20_000, cost_minor: 50 }),
    touch({ id: 'h8', visitor_id: 'v3', node_id: 'la', page_id: 'la2', kind: 'view', ts: T0 + 21_000 }),
    touch({ id: 'h9', visitor_id: 'v3', node_id: 'la', page_id: 'la2', kind: 'view', ts: T0 + 22_000 }),
  ].map((t) => ({ ...t, funnel_id: funnelId }));
}

beforeAll(async () => {
  h = await createHarness();
  ns = new FakeAnalyticsNamespace(() => h.clock.now);
  h.env.ANALYTICS = ns as unknown as Env['ANALYTICS'];
  h.env.EDGE_ORIGIN = 'https://t.acme.test';
  const acme = await seedTenant(h, 'acme');
  acmeId = acme.id;
  const other = await seedTenant(h, 'other');
  const o = await seedUser(h, { email: 'owner@example.com' });
  const v = await seedUser(h, { email: 'viewer@example.com' });
  const x = await seedUser(h, { email: 'stranger@example.com' });
  await addMember(h, o.id, acme.id, 'owner');
  await addMember(h, v.id, acme.id, 'viewer');
  await addMember(h, x.id, other.id, 'owner');
  owner = await login(h, 'owner@example.com');
  viewer = await login(h, 'viewer@example.com');
  stranger = await login(h, 'stranger@example.com');
  const created = await owner.post(`${BASE}/sites`, { name: 'Acme', hostnames: ['acme.test'], timezone: 'Europe/Rome' });
  siteId = String((created.body['site'] as Record<string, unknown>)['id']);
});

const sq = () => `site_id=${siteId}`;
/** Link base on the shared edge host: the site travels in the path. */
const edge = () => `https://t.acme.test/s/${siteId}`;
const put = (client: TestClient, path: string, body: unknown) => client.request('PUT', path, body);

describe('funnel graphs v2 API', () => {
  let funnelId = '';

  it('creates, lists and reads a funnel graph', async () => {
    const res = await owner.post(`${BASE}/funnels-v2?${sq()}`, graphInput());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Main funnel', version: 1, status: 'active' });
    funnelId = String(res.body['id']);
    const list = await viewer.get(`${BASE}/funnels-v2?${sq()}`);
    expect(list.status).toBe(200);
    expect(list.body['data']).toEqual([expect.objectContaining({ id: funnelId, node_count: 5, version: 1 })]);
    const got = await viewer.get(`${BASE}/funnels-v2/${funnelId}?${sq()}`);
    expect((got.body['nodes'] as unknown[]).length).toBe(5);
    expect((await viewer.get(`${BASE}/funnels-v2/missing?${sq()}`)).status).toBe(404);
  });

  it('rejects structurally invalid graphs with 422 invalid_graph and the error codes', async () => {
    const noTraffic = await owner.post(`${BASE}/funnels-v2?${sq()}`, {
      name: 'Broken',
      nodes: [graphInput().nodes[4]],
      edges: [],
    });
    expect(noTraffic.status).toBe(422);
    expect(noTraffic.body['error']).toBe('invalid_graph');
    expect((noTraffic.body['errors'] as Array<{ code: string }>).map((e) => e.code)).toEqual(['no_traffic_node']);

    const g = graphInput();
    const missingFallback = await owner.post(`${BASE}/funnels-v2?${sq()}`, {
      ...g,
      nodes: [
        ...g.nodes,
        {
          id: 'cond',
          kind: 'condition',
          config: { routes: [{ id: 'it', label: 'Italy', priority: 0, groups: [{ match: 'all', rules: [{ attr: 'country', op: 'is', values: ['IT'] }] }] }] },
        },
      ],
      edges: [...g.edges.filter((e) => e.id !== 'e1'), { id: 'e1', from: 't', to: 'cond', via: { type: 'default' } }, { id: 'e7', from: 'cond', to: 'r', via: { type: 'route', route_id: 'it' } }],
    });
    expect(missingFallback.status).toBe(422);
    expect(missingFallback.body['errors']).toEqual([
      expect.objectContaining({ code: 'missing_fallback', node_id: 'cond' }),
    ]);

    // Schema-level errors stay the standard validation_failed.
    const bad = await owner.post(`${BASE}/funnels-v2?${sq()}`, { name: '', nodes: [], edges: [] });
    expect(bad.status).toBe(422);
    expect(bad.body['error']).toBe('validation_failed');
    expect((await viewer.get(`${BASE}/funnels-v2?${sq()}`)).body['data']).toHaveLength(1);
  });

  it('saves with optimistic concurrency: a stale version is a 409', async () => {
    const saved = await put(owner, `${BASE}/funnels-v2/${funnelId}?${sq()}`, { ...graphInput('Renamed'), version: 1 });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ name: 'Renamed', version: 2 });
    const stale = await put(owner, `${BASE}/funnels-v2/${funnelId}?${sq()}`, { ...graphInput('Stale'), version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body['error']).toBe('conflict');
    const invalid = await put(owner, `${BASE}/funnels-v2/${funnelId}?${sq()}`, {
      ...graphInput(),
      edges: graphInput().edges.filter((e) => e.id !== 'e1'),
      version: 2,
    });
    expect(invalid.status).toBe(422);
    expect((invalid.body['errors'] as Array<{ code: string }>).map((e) => e.code)).toContain('missing_fallback');
    expect((await put(owner, `${BASE}/funnels-v2/nope?${sq()}`, { ...graphInput(), version: 1 })).status).toBe(404);
    const v1 = await viewer.get(`${BASE}/funnels-v2/${funnelId}?${sq()}&version=1`);
    expect(v1.body).toMatchObject({ name: 'Main funnel', version: 1 });
    expect((await viewer.get(`${BASE}/funnels-v2/${funnelId}?${sq()}`)).body['version']).toBe(2);
  });

  it('archives, restores and duplicates', async () => {
    const archived = await owner.post(`${BASE}/funnels-v2/${funnelId}/archive?${sq()}`);
    expect(archived.body['status']).toBe('archived');
    expect((await viewer.get(`${BASE}/funnels-v2?${sq()}&status=active`)).body['data']).toEqual([]);
    expect((await owner.post(`${BASE}/funnels-v2/${funnelId}/restore?${sq()}`)).body['status']).toBe('active');
    const copy = await owner.post(`${BASE}/funnels-v2/${funnelId}/duplicate?${sq()}`);
    expect(copy.status).toBe(201);
    expect(copy.body).toMatchObject({ name: 'Renamed (copy)', version: 1 });
    expect(copy.body['id']).not.toBe(funnelId);
    const named = await owner.post(`${BASE}/funnels-v2/${funnelId}/duplicate?${sq()}`, { name: 'Variant' });
    expect(named.body['name']).toBe('Variant');
    expect((await owner.post(`${BASE}/funnels-v2/nope/archive?${sq()}`)).status).toBe(404);
  });

  it('requires analytics:configure to write', async () => {
    expect((await viewer.post(`${BASE}/funnels-v2?${sq()}`, graphInput())).status).toBe(403);
    expect((await put(viewer, `${BASE}/funnels-v2/${funnelId}?${sq()}`, { ...graphInput(), version: 2 })).status).toBe(403);
    expect((await viewer.post(`${BASE}/funnels-v2/${funnelId}/archive?${sq()}`)).status).toBe(403);
  });

  describe('tracking links', () => {
    let metaId = '';
    let googleId = '';

    beforeAll(async () => {
      const domain = (id: string, hostname: string, status: string) =>
        h.env.DB.prepare(
          `INSERT INTO tracking_domains (id, tenant_id, site_id, hostname, status, cname_target, created_at)
           VALUES (?, ?, ?, ?, ?, 'cname.acme.test', 0)`,
        )
          .bind(id, acmeId, siteId, hostname, status)
          .run();
      await domain('td_1', 'go.acme.test', 'active');
      await domain('td_2', 'pending.acme.test', 'pending_ssl');
      const template = (name: string) => TRAFFIC_SOURCE_TEMPLATE_DEFS.find((t) => t.template === name)!.source;
      metaId = String((await owner.post(`${BASE}/traffic-sources?${sq()}`, template('meta'))).body['id']);
      googleId = String((await owner.post(`${BASE}/traffic-sources?${sq()}`, template('google'))).body['id']);
    });

    it('builds Meta links: macros appended, fbclid captured but never appended', async () => {
      const res = await viewer.get(`${BASE}/funnels-v2/${funnelId}/links?${sq()}&source=${metaId}`);
      expect(res.status).toBe(200);
      const fields =
        'campaign={{campaign.id}}&adset={{adset.id}}&ad={{ad.id}}&campaign_name={{campaign.name}}' +
        '&adset_name={{adset.name}}&ad_name={{ad.name}}&placement={{placement}}&site_source={{site_source_name}}';
      expect(res.body['entrance_url']).toBe(`${edge()}/go/${funnelId}-${metaId}?${fields}`);
      expect(String(res.body['entrance_url'])).not.toContain('fbclid');
      // Traffic → rotator: no page group reachable through single exits, no direct link.
      expect(res.body['direct_suffix']).toBe('');
      expect(res.body['direct_url']).toBeNull();
      expect(res.body['action_urls']).toEqual([]);
      expect(String(res.body['snippet'])).toContain(`data-site="${siteId}"`);
      expect(String(res.body['snippet'])).toContain('src="https://t.acme.test/s.js"');

      expect(res.body['base_url']).toBe(`https://t.acme.test/s/${siteId}`);

      const lander = await viewer.get(`${BASE}/funnels-v2/${funnelId}/links?${sq()}&source=${metaId}&node=la&cost=0.25`);
      expect(lander.body).toMatchObject({
        entrance_url: `${edge()}/go/${funnelId}-${metaId}/la?${fields}&c=0.25`,
        direct_suffix: `f=${funnelId}&ts=${metaId}&n=la&p=la1&${fields}`,
        direct_url: `https://lander.test/a?ref=x&f=${funnelId}&ts=${metaId}&n=la&p=la1&${fields}`,
        page_node_id: 'la',
        action_urls: [
          { action: 1, url: `${edge()}/a/1`, default_url: `${edge()}/go/${funnelId}/la/a/1` },
          { action: 2, url: `${edge()}/a/2`, default_url: `${edge()}/go/${funnelId}/la/a/2` },
        ],
      });
      // The response is exactly the shared contract (no fields outside it).
      expect(funnelLinksSchema.strict().parse(lander.body)).toEqual(lander.body);
      expect(funnelLinksSchema.strict().parse(res.body)).toEqual(res.body);
    });

    it('builds Google links with ValueTrack parameters and no gclid', async () => {
      const res = await viewer.get(
        `${BASE}/funnels-v2/${funnelId}/links?${sq()}&source=${googleId}&node=lb&domain=go.acme.test&wordpress=true`,
      );
      const fields =
        'campaign={campaignid}&adgroup={adgroupid}&creative={creative}&keyword={keyword}&matchtype={matchtype}' +
        '&device={device}&network={network}&placement={placement}';
      expect(res.body).toMatchObject({
        base_url: 'https://go.acme.test',
        entrance_url: `https://go.acme.test/go/${funnelId}-${googleId}/lb?${fields}`,
        direct_suffix: `f=${funnelId}&ts=${googleId}&n=lb&${fields}`,
        direct_url: `https://lander.test/b?f=${funnelId}&ts=${googleId}&n=lb&${fields}`,
        action_urls: [{ action: 1, url: 'https://go.acme.test/a/1', default_url: `https://go.acme.test/go/${funnelId}/lb/a/1` }],
      });
      expect(String(res.body['entrance_url'])).not.toMatch(/gclid|gbraid|wbraid/);
      expect(String(res.body['snippet'])).toContain('src="https://go.acme.test/s.js"');
      const page = await viewer.get(`${BASE}/funnels-v2/${funnelId}/links?${sq()}&source=${googleId}&node=la&page=la2`);
      expect(page.body['entrance_url']).toBe(`${edge()}/go/${funnelId}-${googleId}/la/la2?${fields}`);
      expect(page.body['direct_url']).toBe(`https://lander.test/a2?f=${funnelId}&ts=${googleId}&n=la&p=la2&${fields}`);
    });

    it('404s on unknown funnel, source, node or page and 422s on a bad domain', async () => {
      const base = `${BASE}/funnels-v2/${funnelId}/links?${sq()}`;
      expect((await viewer.get(`${BASE}/funnels-v2/nope/links?${sq()}&source=${metaId}`)).status).toBe(404);
      expect((await viewer.get(`${base}&source=nope`)).status).toBe(404);
      expect((await viewer.get(`${base}&source=${metaId}&node=zz`)).status).toBe(404);
      expect((await viewer.get(`${base}&source=${metaId}&node=la&page=zz`)).status).toBe(404);
      expect((await viewer.get(`${base}&source=${metaId}&domain=not a host`)).status).toBe(422);
      // Only active tracking domains of this site.
      const pending = await viewer.get(`${base}&source=${metaId}&domain=pending.acme.test`);
      expect(pending.status).toBe(422);
      expect(pending.body['error']).toBe('tracking_domain_not_active');
      expect((await viewer.get(`${base}&source=${metaId}&domain=unknown.acme.test`)).status).toBe(422);
    });
  });

  it('serves the heatmap from touches and conversions', async () => {
    const store = ns.store(`site:${siteId}`);
    expect(store.recordTouches(fixtureTouches(funnelId)).ok).toBe(true);
    expect(store.recordConversionFromPostback({ hit: 'h4', revenue_minor: 1000, funnel_id: funnelId, ts: T0 + 4000 }).ok).toBe(true);
    const res = await viewer.get(`${BASE}/funnels-v2/${funnelId}/heatmap?${sq()}&metric=roi&from=2026-10-15&to=2026-10-15`);
    expect(res.status).toBe(200);
    expect(res.body['metric']).toBe('roi');
    const nodes = res.body['nodes'] as Array<Record<string, unknown>>;
    expect(nodes.find((n) => n['node_id'] === 't')).toEqual({
      node_id: 't',
      visits: 3,
      clicks: 0,
      conversions: 1,
      revenue_minor: 1000,
      cost_minor: 150,
      value: 566.67,
    });
    expect(res.body['truncated']).toBe(false);
    expect(funnelHeatmapSchema.parse(res.body)).toEqual(res.body);
    const empty = await viewer.get(`${BASE}/funnels-v2/${funnelId}/heatmap?${sq()}&from=2026-10-16&to=2026-10-17`);
    expect((empty.body['nodes'] as Array<{ visits: number }>).every((n) => n.visits === 0)).toBe(true);
    expect((await viewer.get(`${BASE}/funnels-v2/${funnelId}/heatmap?${sq()}&from=2026-10-17&to=2026-10-16`)).status).toBe(422);
    expect((await viewer.get(`${BASE}/funnels-v2/${funnelId}/heatmap?${sq()}&metric=nope`)).status).toBe(422);
  });

  it('flags a heatmap built from a capped number of touches as truncated', async () => {
    const store = ns.store(`site:${siteId}`);
    const day = T0 + 5 * 86_400_000;
    const many = Array.from({ length: 10_000 }, (_, i) =>
      touch({ id: `bulk_${i}`, visitor_id: `bv${i}`, node_id: 't', kind: 'entrance', ts: day + i, funnel_id: funnelId }),
    );
    expect(store.recordTouches(many).ok).toBe(true);
    const res = await viewer.get(`${BASE}/funnels-v2/${funnelId}/heatmap?${sq()}&from=2026-10-20&to=2026-10-20`);
    expect(res.status).toBe(200);
    expect(res.body['truncated']).toBe(true);
    expect((res.body['nodes'] as Array<{ node_id: string; visits: number }>).find((n) => n.node_id === 't')?.visits).toBe(10_000);
  });

  it('suggests condition values of the site to readers', async () => {
    ns.store(`site:${siteId}`).applyVisitorTags('v1', ['vip']);
    const res = await viewer.get(`${BASE}/funnels-v2/condition-values?${sq()}&attr=tag`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ values: ['vip'] });
    expect((await viewer.get(`${BASE}/funnels-v2/condition-values?${sq()}&attr=city`)).body).toEqual({ values: [] });
    expect((await viewer.get(`${BASE}/funnels-v2/condition-values?${sq()}&attr=os`)).status).toBe(422);
    expect((await stranger.get(`${OTHER}/funnels-v2/condition-values?${sq()}&attr=tag`)).status).toBe(404);
  });

  it("isolates tenants: another tenant's site is a 404 on every endpoint", async () => {
    const q = `site_id=${siteId}`;
    const f = `${OTHER}/funnels-v2`;
    const statuses = [
      (await stranger.get(`${f}?${q}`)).status,
      (await stranger.post(`${f}?${q}`, graphInput())).status,
      (await stranger.get(`${f}/${funnelId}?${q}`)).status,
      (await put(stranger, `${f}/${funnelId}?${q}`, { ...graphInput(), version: 2 })).status,
      (await stranger.post(`${f}/${funnelId}/archive?${q}`)).status,
      (await stranger.post(`${f}/${funnelId}/restore?${q}`)).status,
      (await stranger.post(`${f}/${funnelId}/duplicate?${q}`)).status,
      (await stranger.get(`${f}/${funnelId}/links?${q}&source=x`)).status,
      (await stranger.get(`${f}/${funnelId}/heatmap?${q}`)).status,
    ];
    expect(statuses).toEqual(statuses.map(() => 404));
    // The acme URL itself is closed to non-members.
    expect((await stranger.get(`${BASE}/funnels-v2?${q}`)).status).toBe(404);
  });

  it('publishes the routes in the OpenAPI document', async () => {
    const res = await h.client().get('/api/v2/openapi/analytics.json');
    expect(res.status).toBe(200);
    expect(res.body['openapi']).toBe('3.1.0');
    const paths = res.body['paths'] as Record<string, Record<string, { responses: Record<string, unknown> }>>;
    for (const p of [
      '/funnels-v2',
      '/funnels-v2/condition-values',
      '/funnels-v2/{id}',
      '/funnels-v2/{id}/archive',
      '/funnels-v2/{id}/restore',
      '/funnels-v2/{id}/duplicate',
      '/funnels-v2/{id}/links',
      '/funnels-v2/{id}/heatmap',
      '/traffic-sources',
      '/traffic-sources/templates',
      '/traffic-sources/{id}',
      '/traffic-sources/{id}/archive',
      '/outbound',
      '/outbound/resend',
      '/outbound/{id}',
      '/outbound/{id}/resend',
    ]) {
      expect(paths, p).toHaveProperty([p]);
    }
    expect(Object.keys(paths['/funnels-v2/{id}']?.['put']?.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '409', '422']),
    );
    expect(JSON.parse(JSON.stringify(res.body))).toEqual(res.body);
  });
});

describe('computeHeatmap', () => {
  const graph = { nodes: graphInput().nodes, edges: graphInput().edges } as Parameters<typeof computeHeatmap>[0];
  const touches = fixtureTouches('F');
  const conversions = [
    { hit: 'h4', visitor_id: 'v1', ts: T0 + 4000, status: 'approved', revenue_minor: 1000 },
    // No touch with this hit: credited to the visitor's journey up to its last touch.
    { hit: 'unknown', visitor_id: 'v2', ts: T0 + 12_000, status: 'approved', revenue_minor: 500 },
    { hit: 'h8', visitor_id: 'v3', ts: T0 + 23_000, status: 'rejected', revenue_minor: 900 },
  ];

  it('replays journeys: visits, inferred server nodes, edge flow and clicks', () => {
    const map = computeHeatmap(graph, touches, conversions, 'visits');
    const byNode = Object.fromEntries(map.nodes.map((n) => [n.node_id, n]));
    expect(Object.fromEntries(map.nodes.map((n) => [n.node_id, n.visits]))).toEqual({ t: 3, r: 3, la: 2, lb: 1, off: 1 });
    expect(byNode['la']).toMatchObject({ clicks: 1, conversions: 1, revenue_minor: 1000, cost_minor: 100, value: 2 });
    expect(byNode['lb']).toMatchObject({ conversions: 1, revenue_minor: 500, cost_minor: 50 });
    expect(byNode['t']).toMatchObject({ conversions: 2, revenue_minor: 1500, cost_minor: 150 });
    expect(map.edges).toEqual([
      { edge_id: 'e1', count: 3, flow_pct: 100 },
      { edge_id: 'e2', count: 2, flow_pct: 66.67 },
      { edge_id: 'e3', count: 1, flow_pct: 33.33 },
      { edge_id: 'e4', count: 1, flow_pct: 33.33 },
      { edge_id: 'e5', count: 0, flow_pct: 0 },
      { edge_id: 'e6', count: 0, flow_pct: 0 },
    ]);
  });

  it('computes flow %, CVR and ROI values', () => {
    const value = (metric: 'flow_pct' | 'cvr' | 'roi', node: string) =>
      computeHeatmap(graph, touches, conversions, metric).nodes.find((n) => n.node_id === node)?.value;
    expect(value('flow_pct', 'la')).toBe(66.67);
    expect(value('flow_pct', 'off')).toBe(33.33);
    expect(value('cvr', 'la')).toBe(50);
    expect(value('cvr', 't')).toBe(66.67);
    expect(value('roi', 't')).toBe(900);
    expect(value('roi', 'off')).toBe(1900);
  });

  it('skips deleted nodes and touches of unknown nodes', () => {
    const withDeleted = {
      nodes: graph.nodes.map((n) => (n.id === 'lb' ? { ...n, deleted_at: T0 } : n)),
      edges: graph.edges,
    };
    const map = computeHeatmap(withDeleted, [...touches, touch({ id: 'x', visitor_id: 'v9', node_id: 'ghost', kind: 'view', ts: T0 })], [], 'visits');
    expect(map.nodes.map((n) => n.node_id)).toEqual(['t', 'r', 'la', 'off']);
    expect(map.edges.map((e) => e.edge_id)).toEqual(['e1', 'e2', 'e4', 'e5']);
    expect(map.nodes.find((n) => n.node_id === 't')?.visits).toBe(3);
  });
});
