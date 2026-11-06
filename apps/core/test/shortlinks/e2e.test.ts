import { app as edgeApp, type Env as EdgeEnv } from '@amable/app-edge';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { handleEdgeGateway } from '../../src/public/gateway';
import type { TestTenant } from '../crm/helpers';
import { collectWaits, inspectableTenantDb } from '../forms/helpers';
import { createHarness, seedTenant, type Harness } from '../helpers/harness';

// The edge entry exports its Durable Object class, which needs the Workers runtime.
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

const SECRET = 'e2e-edge-gateway-secret';
const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

let h: Harness;
let db: TestTenant;
let edgeEnv: EdgeEnv;
const waits = collectWaits();

function edge(url: string, init: RequestInit = {}) {
  return edgeApp.request(url, { redirect: 'manual', ...init }, edgeEnv, waits.ctx);
}

const visit = (url: string, ua = CHROME, headers: Record<string, string> = {}) =>
  edge(url, { headers: { 'user-agent': ua, ...headers } });

beforeAll(async () => {
  h = await createHarness();
  const tenants = inspectableTenantDb();
  h.env.TENANT_DB = tenants.namespace;
  h.env.EDGE_GATEWAY_SECRET = SECRET;
  const acme = await seedTenant(h, 'acme');
  await h.env.DB.prepare(
    `INSERT INTO domains (id, tenant_id, hostname, kind, status, created_at) VALUES
       ('dom_go', ?1, 'go.acme.test', 'shortlink', 'verified', 0),
       ('dom_pending', ?1, 'pending.acme.test', 'shortlink', 'pending', 0),
       ('dom_site', ?1, 'www.acme.test', 'app', 'verified', 0)`,
  )
    .bind(acme.id)
    .run();
  db = tenants.tenant(acme.id);
  db.op('shortlinks.create', {
    domain_id: 'dom_go',
    key: 'spring',
    url: 'https://shop.example/sale?ref=x',
    utm_source: 'newsletter',
    utm_campaign: 'spring',
    pass_query: true,
  });
  db.op('shortlinks.create', { domain_id: 'dom_go', key: 'plain', url: 'https://shop.example/plain' });
  db.op('shortlinks.create', {
    domain_id: 'dom_go',
    key: 'over',
    url: 'https://shop.example/over',
    expires_at: '2020-01-01T00:00:00Z',
    expired_url: 'https://shop.example/ended',
  });
  db.op('shortlinks.create', {
    domain_id: 'dom_go',
    key: 'gone',
    url: 'https://shop.example/gone',
    expires_at: '2020-01-01T00:00:00Z',
  });
  db.op('shortlinks.create', {
    domain_id: 'dom_go',
    key: 'social',
    url: 'https://shop.example/social',
    og_title: 'Spring <sale>',
    og_image: 'https://cdn.example/og.png',
  });
  db.op('shortlinks.create', { domain_id: 'dom_go', key: 'shelved', url: 'https://shop.example/a', archived: true });
  db.op('shortlinks.create', { domain_id: 'dom_pending', key: 'p', url: 'https://shop.example/p' });

  edgeEnv = {
    EDGE_GATEWAY_SECRET: SECRET,
    CORE: {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => handleEdgeGateway(new Request(input, init), h.env, waits.ctx),
    } as unknown as Fetcher,
  } as EdgeEnv;
});

describe('shortlink redirect (edge → core)', () => {
  it('redirects with the saved UTM and the visit query, which wins', async () => {
    const res = await visit('https://go.acme.test/spring?utm_source=ig&x=1');
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location') ?? '');
    expect(location.origin + location.pathname).toBe('https://shop.example/sale');
    expect(Object.fromEntries(location.searchParams)).toEqual({
      ref: 'x',
      utm_source: 'ig',
      utm_campaign: 'spring',
      x: '1',
    });
    expect(res.headers.get('cache-control')).toBe('no-store');

    const plain = await visit('https://go.acme.test/plain/?drop=1');
    expect(plain.headers.get('location')).toBe('https://shop.example/plain');
  });

  it('records clicks with dimensions and flags bots', async () => {
    await waits.flush();
    const before = db.op('shortlinks.list', {}).data.find((l) => l.key === 'plain')?.clicks ?? 0;
    await visit('https://go.acme.test/plain', CHROME, { referer: 'https://www.instagram.com/p/1' });
    await visit('https://go.acme.test/plain', 'curl/8.4.0');
    await waits.flush();
    const link = db.op('shortlinks.list', {}).data.find((l) => l.key === 'plain');
    expect(link?.clicks).toBe(before + 2);
    const stats = db.op('shortlinks.stats', { id: link?.id ?? '', days: 1 });
    expect(stats.bot_clicks).toBe(1);
    expect(stats.referrers).toContainEqual({ value: 'www.instagram.com', clicks: 1 });
    expect(stats.browsers).toContainEqual({ value: 'Chrome', clicks: expect.any(Number) as number });
  });

  it('sends expired visits to the fallback URL or a 404, without counting them', async () => {
    await waits.flush();
    const res = await visit('https://go.acme.test/over');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://shop.example/ended');
    expect((await visit('https://go.acme.test/gone')).status).toBe(404);
    await waits.flush();
    const expired = db.op('shortlinks.list', {}).data.filter((l) => l.key === 'over' || l.key === 'gone');
    expect(expired.map((l) => l.clicks)).toEqual([0, 0]);
  });

  it('serves the og preview to social crawlers only', async () => {
    const crawler = await visit('https://go.acme.test/social', 'facebookexternalhit/1.1');
    expect(crawler.status).toBe(200);
    const html = await crawler.text();
    expect(html).toContain('<meta property="og:title" content="Spring &lt;sale&gt;">');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toContain('content="https://shop.example/social"');
    expect((await visit('https://go.acme.test/social')).status).toBe(302);
    // Without custom og fields crawlers follow the redirect to the destination's own meta.
    expect((await visit('https://go.acme.test/plain', 'facebookexternalhit/1.1')).status).toBe(302);
  });

  it('answers 404 for the root, nested paths, unknown and archived keys', async () => {
    for (const path of ['/', '/a/b', '/nope', '/shelved', '/bad%20key']) {
      const res = await visit(`https://go.acme.test${path}`);
      expect(res.status, path).toBe(404);
    }
    // Only verified shortlink domains are dedicated (outside dev).
    expect((await visit('https://pending.acme.test/p')).status).not.toBe(302);
  });

  it('keeps /health for the domain verification and leaves other hostnames alone', async () => {
    const health = await visit('https://go.acme.test/health');
    expect(await health.json()).toEqual({ ok: true, worker: 'amable-edge' });
    expect((await visit('https://www.acme.test/spring')).headers.get('location')).toBeNull();
  });
});
