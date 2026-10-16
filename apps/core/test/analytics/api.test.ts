import { beforeAll, describe, expect, it } from 'vitest';
import { ev, FakeAnalyticsNamespace, T0 } from '../../../edge/test/helpers';
import type { Env } from '../../src/env';
import { parseFilters } from '../../src/analytics/service';
import {
  addMember,
  createHarness,
  login,
  seedTenant,
  seedUser,
  stepUp,
  type Harness,
  type TestClient,
} from '../helpers/harness';

const BASE = '/api/v2/t/acme/analytics';

let h: Harness;
let ns: FakeAnalyticsNamespace;
let owner: TestClient;
let viewer: TestClient;
let sales: TestClient;
let stranger: TestClient;

beforeAll(async () => {
  h = await createHarness();
  ns = new FakeAnalyticsNamespace(() => h.clock.now);
  h.env.ANALYTICS = ns as unknown as Env['ANALYTICS'];
  h.env.EDGE_ORIGIN = 'https://t.acme.test';
  const acme = await seedTenant(h, 'acme');
  const other = await seedTenant(h, 'other');
  const o = await seedUser(h, { email: 'owner@example.com' });
  const v = await seedUser(h, { email: 'viewer@example.com' });
  const s = await seedUser(h, { email: 'sales@example.com' });
  const x = await seedUser(h, { email: 'stranger@example.com' });
  await addMember(h, o.id, acme.id, 'owner');
  await addMember(h, v.id, acme.id, 'viewer');
  await addMember(h, s.id, acme.id, 'sales');
  await addMember(h, x.id, other.id, 'owner');
  owner = await login(h, 'owner@example.com');
  viewer = await login(h, 'viewer@example.com');
  sales = await login(h, 'sales@example.com');
  stranger = await login(h, 'stranger@example.com');
});

describe('analytics sites', () => {
  let siteId = '';

  it('creates a site with a one-time secret and a snippet', async () => {
    const res = await owner.post(`${BASE}/sites`, {
      name: 'Acme',
      hostnames: ['Acme.test', 'acme.test'],
      timezone: 'Europe/Rome',
    });
    expect(res.status).toBe(201);
    const site = res.body['site'] as Record<string, unknown>;
    siteId = String(site['id']);
    expect(siteId).toMatch(/^st_[a-z2-7]{20}$/);
    expect(site).toMatchObject({
      hostnames: ['acme.test'],
      timezone: 'Europe/Rome',
      cookieless: false,
      has_secret: true,
    });
    expect(String(res.body['secret'])).toMatch(new RegExp(`^amb_sk_${siteId}\\.`));
    const snippet = res.body['snippet'] as Record<string, string>;
    expect(snippet['html']).toContain(`data-site="${siteId}"`);
    expect(snippet['html']).toContain('src="https://t.acme.test/s.js"');
    expect(snippet['html']).toContain('window.amable');
    expect(snippet['server_endpoint']).toBe('https://t.acme.test/e/server');
  });

  it('validates input', async () => {
    expect((await owner.post(`${BASE}/sites`, { name: 'x', hostnames: [] })).status).toBe(422);
    expect(
      (
        await owner.post(`${BASE}/sites`, {
          name: 'x',
          hostnames: ['ok.test'],
          timezone: 'Mars/Base',
        })
      ).status,
    ).toBe(422);
    expect(
      (await owner.post(`${BASE}/sites`, { name: 'x', hostnames: ['ok.test'], extra: 1 })).status,
    ).toBe(422);
  });

  it('lists, reads, updates, rolls the secret and serves the snippet', async () => {
    const list = await viewer.get(`${BASE}/sites`);
    expect(list.status).toBe(200);
    expect((list.body['data'] as unknown[]).length).toBe(1);
    expect((await viewer.get(`${BASE}/sites/${siteId}`)).body['name']).toBe('Acme');
    const patched = await owner.patch(`${BASE}/sites/${siteId}`, {
      cookieless: true,
      retention_days: 90,
    });
    expect(patched.body).toMatchObject({ cookieless: true, retention_days: 90 });
    const snippet = await viewer.get(`${BASE}/sites/${siteId}/snippet`);
    expect(String(snippet.body['html'])).toContain('/s.cookieless.js');
    const noStepUp = await owner.post(`${BASE}/sites/${siteId}/secret`);
    expect(noStepUp.status).toBe(403);
    expect(noStepUp.body['error']).toBe('step_up_required');
    await stepUp(h, owner);
    const rolled = await owner.post(`${BASE}/sites/${siteId}/secret`);
    expect(String(rolled.body['secret'])).toMatch(/^amb_sk_/);
  });

  it('enforces permissions and tenant isolation', async () => {
    expect((await h.client().get(`${BASE}/sites`)).status).toBe(401);
    expect((await viewer.post(`${BASE}/sites`, { name: 'n', hostnames: ['n.test'] })).status).toBe(
      403,
    );
    expect((await viewer.patch(`${BASE}/sites/${siteId}`, { name: 'n' })).status).toBe(403);
    // Sales only has the contact journey, not site analytics.
    expect((await sales.get(`${BASE}/sites`)).status).toBe(403);
    // Another tenant's owner cannot see or query this site through their own tenant.
    expect((await stranger.get(`/api/v2/t/other/analytics/sites/${siteId}`)).status).toBe(404);
    expect(
      (await stranger.get(`/api/v2/t/other/analytics/overview?site_id=${siteId}`)).status,
    ).toBe(404);
    expect((await stranger.get(`/api/v2/t/other/analytics/sites`)).body['data']).toEqual([]);
    expect((await stranger.get(`${BASE}/sites`)).status).toBe(404);
  });

  it('answers overview, timeseries and breakdown queries', async () => {
    const store = ns.store(`site:${siteId}`);
    store.ingest(
      [
        ev({ site: siteId, ts: T0, path: '/', channel: 'Organic search', source: 'Google' }),
        ev({ site: siteId, ts: T0 + 60_000, path: '/pricing' }),
        ev({ site: siteId, vid: 'v2', sid: 's2', ts: T0 + 3_600_000, path: '/', device: 'mobile' }),
      ],
      [],
    );
    const q = `site_id=${siteId}&from=2026-10-15&to=2026-10-15`;
    const overview = await viewer.get(`${BASE}/overview?${q}`);
    expect(overview.status).toBe(200);
    expect(overview.body).toMatchObject({
      visitors: 2,
      sessions: 2,
      pageviews: 3,
      timezone: 'Europe/Rome',
      bounce_rate: 0.5,
    });
    const filtered = await viewer.get(`${BASE}/overview?${q}&filter_device=mobile`);
    expect(filtered.body).toMatchObject({ visitors: 1, pageviews: 1 });
    const excluded = await viewer.get(
      `${BASE}/overview?${q}&filter_device=!mobile&filter_page=~pric`,
    );
    expect(excluded.body).toMatchObject({ visitors: 1, pageviews: 2 });
    const ts = await viewer.get(`${BASE}/timeseries?${q}&interval=hour`);
    expect(ts.status).toBe(200);
    expect(ts.body['source']).toBe('rollup');
    expect((ts.body['points'] as unknown[]).length).toBe(24);
    const daily = await viewer.get(`${BASE}/timeseries?${q}`);
    expect(daily.body).toMatchObject({
      interval: 'day',
      points: [expect.objectContaining({ label: '2026-10-15', visitors: 2 })],
    });
    const pages = await viewer.get(`${BASE}/breakdown/page?${q}&limit=1`);
    expect(pages.body).toEqual({
      dimension: 'page',
      rows: [{ value: '/', visitors: 2, pageviews: 2 }],
    });
    expect((await viewer.get(`${BASE}/breakdown/nope?${q}`)).status).toBe(422);
    expect((await viewer.get(`${BASE}/overview?${q}&filter_bogus=1`)).status).toBe(422);
    expect(
      (await viewer.get(`${BASE}/overview?site_id=${siteId}&from=2026-10-16&to=2026-10-01`)).status,
    ).toBe(422);
    expect((await viewer.get(`${BASE}/overview`)).status).toBe(422);
  });

  it('defaults to the last 7 days', async () => {
    h.clock.now = T0 + 2 * 86_400_000;
    const res = await viewer.get(`${BASE}/overview?site_id=${siteId}`);
    expect(res.status).toBe(200);
    expect(res.body['visitors']).toBe(2);
  });

  it('deletes a site', async () => {
    expect((await owner.delete(`${BASE}/sites/${siteId}`)).status).toBe(200);
    expect((await viewer.get(`${BASE}/sites/${siteId}`)).status).toBe(404);
    expect((await viewer.get(`${BASE}/sites`)).body['data']).toEqual([]);
  });

  it('publishes an OpenAPI document', async () => {
    const res = await h.client().get('/api/v2/openapi/analytics.json');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body['paths'] as object)).toContain('/overview');
  });
});

describe('filter parsing', () => {
  it('maps prefixes to operators', () => {
    expect(
      parseFilters({ filter_country: 'IT', filter_page: ['~/blog', '!/'], site_id: 'x' }),
    ).toEqual([
      { dimension: 'country', op: 'is', value: 'IT' },
      { dimension: 'page', op: 'contains', value: '/blog' },
      { dimension: 'page', op: 'is_not', value: '/' },
    ]);
    expect(() => parseFilters({ filter_secret: 'x' })).toThrow();
  });
});

describe('without the binding', () => {
  it('answers 503', async () => {
    const saved = h.env.ANALYTICS;
    delete h.env.ANALYTICS;
    const res = await viewer.get(`${BASE}/sites`);
    h.env.ANALYTICS = saved;
    expect(res.status).toBe(503);
    expect(res.body['error']).toBe('analytics_unavailable');
  });

  it('answers 503 edge_unreachable when the edge worker behind the binding is not running', async () => {
    const saved = h.env.ANALYTICS;
    const down = {
      idFromName: (name: string) => ({ name }),
      get: () =>
        new Proxy(
          {},
          {
            get: () => async () => {
              throw new Error('Worker "amable-edge" not found. Make sure it is running locally.');
            },
          },
        ),
    };
    h.env.ANALYTICS = down as unknown as Env['ANALYTICS'];
    const sites = await viewer.get(`${BASE}/sites`);
    const overview = await viewer.get(`${BASE}/overview?site_id=st_aaaaaaaaaaaaaaaaaaaa`);
    const share = await viewer.get(`/api/public/analytics/not-a-token`);
    h.env.ANALYTICS = saved;
    expect(sites.status).toBe(503);
    expect(sites.body).toMatchObject({ error: 'analytics_unavailable', reason: 'edge_unreachable' });
    expect(overview.status).toBe(503);
    expect(share.status).not.toBe(500);
  });
});
