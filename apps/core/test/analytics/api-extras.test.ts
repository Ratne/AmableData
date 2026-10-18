import { beforeAll, describe, expect, it } from 'vitest';
import { ev, FakeAnalyticsNamespace, T0 } from '../../../edge/test/helpers';
import { signShareToken, verifyShareToken } from '../../src/analytics/share';
import type { Env } from '../../src/env';
import { fakeTenantDbNamespace } from '../crm/helpers';
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
const MIN = 60_000;

let h: Harness;
let ns: FakeAnalyticsNamespace;
let owner: TestClient;
let viewer: TestClient;
let analyst: TestClient;
let sales: TestClient;
let siteId = '';
let otherSiteId = '';
const q = () => `site_id=${siteId}&from=2026-10-01&to=2026-10-31`;

beforeAll(async () => {
  h = await createHarness();
  ns = new FakeAnalyticsNamespace(() => h.clock.now);
  h.env.ANALYTICS = ns as unknown as Env['ANALYTICS'];
  h.env.TENANT_DB = fakeTenantDbNamespace();
  h.env.EDGE_ORIGIN = 'https://t.acme.test';
  h.env.APP_ORIGIN = 'https://app.acme.test';
  const acme = await seedTenant(h, 'acme');
  await seedTenant(h, 'other');
  const o = await seedUser(h, { email: 'owner@example.com' });
  const v = await seedUser(h, { email: 'viewer@example.com' });
  const a = await seedUser(h, { email: 'analyst@example.com' });
  const s = await seedUser(h, { email: 'sales@example.com' });
  await addMember(h, o.id, acme.id, 'owner');
  await addMember(h, v.id, acme.id, 'viewer');
  await addMember(h, a.id, acme.id, 'analyst');
  await addMember(h, s.id, acme.id, 'sales');
  owner = await login(h, 'owner@example.com');
  viewer = await login(h, 'viewer@example.com');
  analyst = await login(h, 'analyst@example.com');
  sales = await login(h, 'sales@example.com');
  const created = await owner.post(`${BASE}/sites`, { name: 'Acme', hostnames: ['acme.test'] });
  siteId = String((created.body['site'] as Record<string, unknown>)['id']);
  const other = await owner.post(`${BASE}/sites`, { name: 'Shop', hostnames: ['shop.test'] });
  otherSiteId = String((other.body['site'] as Record<string, unknown>)['id']);
  ns.store(`site:${siteId}`).ingest(
    [
      ev({ site: siteId, vid: 'visitor-1', sid: 's1', ts: T0, channel: 'Organic search', path: '/' }),
      ev({ site: siteId, vid: 'visitor-1', sid: 's1', ts: T0 + MIN, path: '/pricing' }),
      ev({ site: siteId, vid: 'visitor-1', sid: 's1', ts: T0 + 2 * MIN, type: 'goal', name: 'signup', path: '/pricing' }),
      ev({ site: siteId, vid: 'visitor-2', sid: 's2', ts: T0, path: '/' }),
    ],
    [],
  );
  ns.store(`site:${otherSiteId}`).ingest([ev({ site: otherSiteId, vid: 'shopper', sid: 'x1', ts: T0 })], []);
});

describe('reports', () => {
  it('serves insights, purchases, visitors, profiles, realtime, bots and install checks', async () => {
    expect((await viewer.get(`${BASE}/insights?${q()}`)).status).toBe(200);
    expect((await viewer.get(`${BASE}/purchases?${q()}`)).body).toMatchObject({ currency: 'EUR', data: [] });
    const list = await viewer.get(`${BASE}/visitors?${q()}&sort=sessions`);
    expect(list.status).toBe(200);
    expect((list.body['data'] as unknown[]).length).toBe(2);
    const profile = await viewer.get(`${BASE}/visitors/visitor-1?site_id=${siteId}`);
    expect(profile.body).toMatchObject({ visitor: { visitor_id: 'visitor-1', pageviews: 2 }, completed_goals: [{ name: 'signup' }] });
    expect((await viewer.get(`${BASE}/visitors/nope?site_id=${siteId}`)).status).toBe(404);
    expect((await viewer.get(`${BASE}/realtime?site_id=${siteId}`)).status).toBe(200);
    expect((await viewer.get(`${BASE}/bots?${q()}`)).body).toMatchObject({ total_hits: 0 });
    expect((await viewer.get(`${BASE}/sites/${siteId}/install-check`)).body).toMatchObject({ receiving: true, events_24h: 4 });
    const snippets = await viewer.get(`${BASE}/sites/${siteId}/crawler-snippets`);
    expect(String(snippets.body['worker'])).toContain('https://t.acme.test/e/server');
    expect(String(snippets.body['worker'])).not.toContain('amb_sk_st_');
    const channels = await viewer.get(`${BASE}/breakdown/channel?${q()}&model=linear`);
    expect(channels.body['model']).toBe('linear');
    expect((await viewer.get(`${BASE}/realtime/ws?site_id=${siteId}`)).status).toBe(426);
  });

  it('compares attribution models per dimension', async () => {
    ns.store(`site:${otherSiteId}`).ingest(
      [
        ev({ site: otherSiteId, vid: 'shopper', sid: 'x2', ts: T0 + 5 * MIN, channel: 'Email', path: '/offer' }),
        ev({
          site: otherSiteId,
          vid: 'shopper',
          sid: 'x2',
          ts: T0 + 6 * MIN,
          type: 'payment',
          payment: {
            amountMinor: 1000,
            currency: 'EUR',
            transactionId: 'att-1',
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
    const range = `site_id=${otherSiteId}&from=2026-10-01&to=2026-10-31`;
    const all = await viewer.get(`${BASE}/attribution?${range}`);
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ dimension: 'channel', currency: 'EUR', total_revenue_minor: 1000 });
    expect(all.body['models']).toHaveLength(5);
    const some = await viewer.get(`${BASE}/attribution?${range}&dimension=entry_page&models=first_touch,last_touch,bogus`);
    expect(some.body['models']).toEqual(['first_touch', 'last_touch']);
    const rows = some.body['rows'] as Array<{ value: string; credits: Array<{ model: string; revenue_minor: number }> }>;
    expect(rows.find((r) => r.value === '/offer')?.credits).toEqual([
      { model: 'first_touch', revenue_minor: 0, conversions: 0 },
      { model: 'last_touch', revenue_minor: 1000, conversions: 1 },
    ]);
    expect((await viewer.get(`${BASE}/attribution?${range}&dimension=device`)).status).toBe(422);
    expect((await sales.get(`${BASE}/attribution?${range}`)).status).toBe(403);
  });

  it('forwards realtime upgrades through the API middleware', async () => {
    const seen: string[] = [];
    // Stub responses carry immutable headers, like the real Durable Object stub.
    ns.fetchHandler = (request) => {
      seen.push(request.url);
      return Promise.resolve(Response.redirect('https://analytics.internal/upgraded', 302));
    };
    try {
      const upgrade = { upgrade: 'websocket', origin: 'https://evil.test' };
      expect((await viewer.get(`${BASE}/realtime/ws?site_id=${siteId}`, upgrade)).status).toBe(403);
      const res = await viewer.get(`${BASE}/realtime/ws?site_id=${siteId}`, { upgrade: 'websocket' });
      expect(res.status).toBe(302);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(seen).toEqual(['https://analytics.internal/ws?audience=private']);
    } finally {
      ns.fetchHandler = undefined;
    }
  });

  it('keeps the contact journey behind analytics:journey_read', async () => {
    const contact = await sales.post('/api/v2/t/acme/contacts', { given_name: 'Ann', emails: [{ email: 'ann@example.com' }] });
    expect(contact.status).toBe(201);
    const contactId = String(contact.body['id']);
    ns.store(`site:${siteId}`).applyCrmFacts([
      { kind: 'link', id: 'l1', contactId, visitorId: 'visitor-1', source: 'form', ts: T0 + 3 * MIN },
    ]);
    ns.store(`tenant:${ns.store(`site:${siteId}`).getSite()?.tenantId ?? ''}`).registerLinks([
      { siteId, visitorId: 'visitor-1', contactId, linkedAt: T0 + 3 * MIN, source: 'form' },
    ]);
    const journey = await sales.get(`${BASE}/contacts/${contactId}/journey`);
    expect(journey.status).toBe(200);
    expect(journey.body).toMatchObject({
      contact_id: contactId,
      visitors: [{ site_id: siteId, visitor_id: 'visitor-1', source: 'form' }],
      first_visit: { channel: 'Organic search', entry_page: '/' },
      totals: { sessions: 1, pageviews: 2, goals: 1 },
      goals: [{ name: 'signup', count: 1 }],
    });
    const kinds = (journey.body['items'] as Array<{ kind: string }>).map((i) => i.kind);
    expect(kinds).toEqual(expect.arrayContaining(['session', 'goal', 'identified']));
    // Sales has no site analytics, only the journey.
    expect((await sales.get(`${BASE}/visitors?${q()}`)).status).toBe(403);
    expect((await sales.get(`${BASE}/contacts/missing/journey`)).status).toBe(404);
  });
});

describe('saved views and configuration', () => {
  it('lets analysts save funnels / segments but not configure alerts', async () => {
    const funnel = await analyst.post(`${BASE}/funnels?site_id=${siteId}`, {
      name: 'Pricing → signup',
      steps: [
        { type: 'pageview', value: '/' },
        { type: 'pageview', value: '/pricing' },
        { type: 'goal', value: 'signup' },
      ],
    });
    expect(funnel.status).toBe(201);
    const id = String(funnel.body['id']);
    const results = await viewer.get(`${BASE}/funnels/${id}/results?${q()}`);
    expect(results.body).toMatchObject({ entered: 2, completed: 1 });
    const valid = { name: 'x', steps: [{ type: 'goal', value: 'a' }, { type: 'goal', value: 'b' }] };
    expect((await viewer.post(`${BASE}/funnels?site_id=${siteId}`, valid)).status).toBe(403);
    expect((await analyst.post(`${BASE}/funnels?site_id=${siteId}`, { name: 'x', steps: [{ type: 'goal', value: 'a' }] })).status).toBe(422);
    const segment = await analyst.post(`${BASE}/segments?site_id=${siteId}`, {
      name: 'Italy',
      filters: [{ dimension: 'country', op: 'is', value: 'IT' }],
    });
    expect(segment.status).toBe(201);
    expect(((await viewer.get(`${BASE}/segments?site_id=${siteId}`)).body['data'] as unknown[]).length).toBe(1);
    expect((await analyst.post(`${BASE}/alerts?site_id=${siteId}`, { name: 'a', goal: 'signup' })).status).toBe(403);
    expect((await analyst.delete(`${BASE}/funnels/${id}?site_id=${siteId}`)).status).toBe(200);
  });

  it('creates alerts for members only and shows the webhook secret once', async () => {
    expect(
      (await owner.post(`${BASE}/alerts?site_id=${siteId}`, { name: 'a', goal: 'signup', email_recipients: ['someone@else.test'] })).status,
    ).toBe(422);
    expect(
      (await owner.post(`${BASE}/alerts?site_id=${siteId}`, { name: 'a', goal: 'signup', webhook_url: 'http://insecure.test/' })).status,
    ).toBe(422);
    const created = await owner.post(`${BASE}/alerts?site_id=${siteId}`, {
      name: 'Signups',
      goal: 'signup',
      email_recipients: ['viewer@example.com'],
      webhook_url: 'https://hooks.example.com/a',
    });
    expect(created.status).toBe(201);
    expect(String(created.body['webhook_secret'])).toMatch(/^whsec_[0-9a-f]{64}$/);
    const list = await viewer.get(`${BASE}/alerts?site_id=${siteId}`);
    expect(JSON.stringify(list.body)).not.toContain('whsec_');
    const id = String((created.body['alert'] as Record<string, unknown>)['id']);
    expect((await owner.post(`${BASE}/alerts/${id}/test?site_id=${siteId}`)).body).toEqual({ queued: true });

    expect((await viewer.post(`${BASE}/alerts/${id}/webhook-secret?site_id=${siteId}`)).status).toBe(403);
    const rotated = await owner.post(`${BASE}/alerts/${id}/webhook-secret?site_id=${siteId}`);
    expect(rotated.status).toBe(200);
    expect(String(rotated.body['webhook_secret'])).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(rotated.body['webhook_secret']).not.toBe(created.body['webhook_secret']);
    const noHook = await owner.post(`${BASE}/alerts?site_id=${siteId}`, { name: 'b', goal: 'lead', email_recipients: ['viewer@example.com'] });
    const noHookId = String((noHook.body['alert'] as Record<string, unknown>)['id']);
    expect((await owner.post(`${BASE}/alerts/${noHookId}/webhook-secret?site_id=${siteId}`)).status).toBe(404);
  });

  it('connects the development integrations without any network', async () => {
    const list = await viewer.get(`${BASE}/integrations?site_id=${siteId}`);
    expect(list.body['data']).toEqual([
      expect.objectContaining({ provider: 'meta_ads', available: true, fake: true, status: 'disconnected' }),
      expect.objectContaining({ provider: 'search_console', status: 'disconnected' }),
    ]);
    const start = await owner.post(`${BASE}/integrations/meta_ads/connect?site_id=${siteId}`);
    const url = new URL(String(start.body['authorize_url']));
    expect(url.origin).toBe('https://app.acme.test');
    const bad = await owner.post(`${BASE}/integrations/meta_ads/callback?site_id=${siteId}`, { state: 'forged', code: 'x' });
    expect(bad.status).toBe(422);
    const done = await owner.post(`${BASE}/integrations/meta_ads/callback?site_id=${siteId}`, {
      state: url.searchParams.get('state'),
      code: url.searchParams.get('code'),
    });
    expect(done.body).toMatchObject({ status: 'connected', fake: true, last_error: null });
    const ads = await viewer.get(`${BASE}/ads?${q()}`);
    expect(ads.status).toBe(200);
    expect((ads.body['campaigns'] as unknown[]).length).toBeGreaterThan(0);
    expect((await owner.delete(`${BASE}/integrations/meta_ads?site_id=${siteId}`)).status).toBe(200);
  });

  it('trains the prediction model on demand', async () => {
    expect((await viewer.post(`${BASE}/prediction/train?site_id=${siteId}`)).status).toBe(403);
    const info = await owner.post(`${BASE}/prediction/train?site_id=${siteId}`);
    expect(info.body).toMatchObject({ trained_at: null, samples: 0 });
  });
});

describe('share links', () => {
  it('signs tokens and rejects tampering', async () => {
    const token = await signShareToken('k', 'st_x', 'sh_1');
    expect(await verifyShareToken('k', token)).toEqual({ v: 1, s: 'st_x', i: 'sh_1' });
    expect(await verifyShareToken('other', token)).toBeNull();
    const [body, sig] = token.split('.');
    const forgedBody = Buffer.from(JSON.stringify({ v: 1, s: 'st_y', i: 'sh_1' })).toString('base64url');
    expect(await verifyShareToken('k', `${forgedBody}.${sig ?? ''}`)).toBeNull();
    expect(await verifyShareToken('k', `${body ?? ''}`)).toBeNull();
  });

  it('serves a read-only public dashboard until revoked', async () => {
    const created = await owner.post(`${BASE}/shares?site_id=${siteId}`, { name: 'Investors' });
    expect(created.status).toBe(201);
    const url = String(created.body['url']);
    expect(url).toMatch(/^https:\/\/app\.acme\.test\/share\//);
    // Without APP_ORIGIN the link points at the app the request came from.
    const configured = h.env.APP_ORIGIN;
    delete h.env.APP_ORIGIN;
    const listed = await owner.get(`${BASE}/shares?site_id=${siteId}`);
    h.env.APP_ORIGIN = configured;
    const urls = (listed.body['data'] as { url: string }[]).map((s) => s.url);
    expect(urls.every((u) => u.startsWith('http://localhost/share/'))).toBe(true);
    const token = url.split('/share/')[1] ?? '';
    const pub = h.client();
    expect((await pub.get(`/api/public/analytics/${token}`)).body).toMatchObject({ site: { name: 'Acme' }, share: { name: 'Investors' } });
    const overview = await pub.get(`/api/public/analytics/${token}/overview?from=2026-10-01&to=2026-10-31`);
    expect(overview.body).toMatchObject({ visitors: 2 });
    const realtime = await pub.get(`/api/public/analytics/${token}/realtime`);
    expect(realtime.status).toBe(200);
    expect((await pub.get(`/api/public/analytics/${token}/visitors`)).status).toBe(404);
    expect((await viewer.post(`${BASE}/shares?site_id=${siteId}`, { name: 'x' })).status).toBe(403);
    const id = String(created.body['id']);
    expect((await owner.delete(`${BASE}/shares/${id}?site_id=${siteId}`)).status).toBe(200);
    expect((await pub.get(`/api/public/analytics/${token}/overview`)).status).toBe(404);
    expect((await pub.get(`/api/public/analytics/garbage.token/overview`)).status).toBe(404);
  });
});

describe('site API keys', () => {
  it('scopes keys to one site and to read / write', async () => {
    const noStepUp = await owner.post(`${BASE}/sites/${siteId}/keys`, { name: 'BI', scopes: ['read'] });
    expect(noStepUp.body['error']).toBe('step_up_required');
    await stepUp(h, owner);
    const read = await owner.post(`${BASE}/sites/${siteId}/keys`, { name: 'BI', scopes: ['read'] });
    expect(read.status).toBe(201);
    const readKey = String(read.body['secret']);
    expect(readKey).toMatch(new RegExp(`^amb_ak_${siteId}\\.`));
    const write = await owner.post(`${BASE}/sites/${siteId}/keys`, { name: 'Backend', scopes: ['read', 'write'] });
    const writeKey = String(write.body['secret']);
    const api = (key: string) => ({
      get: (path: string) => h.client().request('GET', `/api/v2/analytics${path}`, undefined, { authorization: `Bearer ${key}` }),
      post: (path: string, body: unknown) =>
        h.client().request('POST', `/api/v2/analytics${path}`, body, { authorization: `Bearer ${key}` }),
    });
    expect((await api(readKey).get('/overview?from=2026-10-01&to=2026-10-31')).body).toMatchObject({ visitors: 2 });
    expect((await api(readKey).get('/goals?from=2026-10-01&to=2026-10-31')).body).toMatchObject({ rows: [{ value: 'signup' }] });
    expect((await api(readKey).get('/visitors/visitor-1')).status).toBe(200);
    // The key only sees its own site: the other site's visitor does not exist for it.
    expect((await api(readKey).get('/visitors/shopper')).status).toBe(404);
    expect((await api(readKey).post('/goals', { visitor_id: 'visitor-2', name: 'demo' })).status).toBe(403);
    expect((await api(writeKey).post('/goals', { visitor_id: 'visitor-2', name: 'demo' })).status).toBe(202);
    expect((await api(writeKey).post('/goals', { visitor_id: 'visitor-2', name: 'Bad Name!' })).status).toBe(422);
    const goals = ns.store(`site:${siteId}`).breakdown({ from: '2026-10-01', to: '2026-10-31' }, 'goal', 10);
    expect(goals.ok && goals.value.rows.map((r) => r.value).sort()).toEqual(['demo', 'signup']);
    expect((await api('amb_ak_nope').get('/overview')).status).toBe(401);
    expect((await api(`${readKey}x`).get('/overview')).status).toBe(401);
    // Revocation is immediate; listing never shows secrets.
    const keyId = String((read.body['key'] as Record<string, unknown>)['id']);
    const listed = await owner.get(`${BASE}/sites/${siteId}/keys`);
    expect(JSON.stringify(listed.body)).not.toContain(readKey);
    expect((await viewer.get(`${BASE}/sites/${siteId}/keys`)).status).toBe(403);
    expect((await owner.delete(`${BASE}/sites/${siteId}/keys/${keyId}`)).status).toBe(200);
    expect((await api(readKey).get('/overview')).status).toBe(401);
  });
});
