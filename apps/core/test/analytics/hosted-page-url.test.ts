import { beforeAll, describe, expect, it } from 'vitest';
import type { Env as EdgeEnv } from '../../../edge/src/env';
import { createLinkRoutes } from '../../../edge/src/analytics/link-routes';
import { clearHostedPageCache, resolveHostedPageUrl } from '../../../edge/src/analytics/links/hosted-pages';
import { FakeAnalyticsNamespace, siteInit, SITE_ID } from '../../../edge/test/helpers';
import { handleEdgeGateway } from '../../src/public/gateway';
import { collectWaits, inspectableTenantDb } from '../forms/helpers';
import { createHarness, seedTenant, type Harness } from '../helpers/harness';

const SECRET = 'hosted-page-gateway-secret';

let h: Harness;
let edgeEnv: EdgeEnv;
let tenantId = '';
const pages: Record<string, string> = {};
const waits = collectWaits();

beforeAll(async () => {
  h = await createHarness();
  const tenants = inspectableTenantDb();
  h.env.TENANT_DB = tenants.namespace;
  h.env.EDGE_GATEWAY_SECRET = SECRET;
  h.env.EDGE_ORIGIN = 'https://edge.amable.test/';
  tenantId = (await seedTenant(h, 'acme')).id;
  const db = tenants.tenant(tenantId);
  const publish = (key: string, input: { title: string; path: string; host?: string }) => {
    const page = db.op('pages.create', input);
    db.op('pages.publish', { id: page.id });
    pages[key] = page.id;
  };
  publish('own_host', { title: 'Spring', path: '/spring', host: 'shop.example' });
  publish('fallback', { title: 'Promo', path: '/promo/autumn' });
  publish('home', { title: 'Home', path: '/' });
  pages['draft'] = db.op('pages.create', { title: 'Draft', path: '/draft' }).id;

  const ns = new FakeAnalyticsNamespace(() => h.clock.now);
  ns.store(`site:${SITE_ID}`).initSite(siteInit({ tenantId }));
  edgeEnv = {
    EDGE_GATEWAY_SECRET: SECRET,
    ANALYTICS: ns as unknown as EdgeEnv['ANALYTICS'],
    CORE: {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => handleEdgeGateway(new Request(input, init), h.env, waits.ctx),
    } as unknown as Fetcher,
  } as EdgeEnv;
});

describe('public URL of builder pages (edge gateway op)', () => {
  it('answers the page host, else the /p/<slug> fallback on the edge origin; 404 for drafts and unknown pages', async () => {
    clearHostedPageCache();
    expect(await resolveHostedPageUrl(edgeEnv, tenantId, pages['own_host']!)).toBe('https://shop.example/spring');
    expect(await resolveHostedPageUrl(edgeEnv, tenantId, pages['fallback']!)).toBe('https://edge.amable.test/p/acme/promo/autumn');
    expect(await resolveHostedPageUrl(edgeEnv, tenantId, pages['home']!)).toBe('https://edge.amable.test/p/acme');
    expect(await resolveHostedPageUrl(edgeEnv, tenantId, pages['draft']!)).toBeNull();
    expect(await resolveHostedPageUrl(edgeEnv, tenantId, 'missing')).toBeNull();
    expect(await resolveHostedPageUrl(edgeEnv, 't_nobody', pages['own_host']!)).toBeNull();
  });

  it('routes a funnel entrance on the shared edge host to the published page', async () => {
    clearHostedPageCache();
    const store = (edgeEnv.ANALYTICS as unknown as FakeAnalyticsNamespace).store(`site:${SITE_ID}`);
    const source = store.createTrafficSource({
      name: 'Newsletter',
      reserved_fields: { campaign: { url_param: 'cid' }, external: { url_param: 'xid' } },
    });
    const graph = store.createFunnelGraph({
      name: 'Hosted',
      nodes: [
        { id: 't', kind: 'traffic', config: {} },
        {
          id: 'lp',
          kind: 'page_group',
          config: { page_type: 'lander', pages: [{ id: 'p1', name: 'Spring', amable_page_id: pages['own_host']!, weight: 1 }] },
        },
      ],
      edges: [{ id: 'e1', from: 't', to: 'lp', via: { type: 'default' } }],
    });
    if (!source.ok || !graph.ok) throw new Error('fixture');
    const app = createLinkRoutes({ resolvers: [] });
    const res = await app.request(
      `https://edge.amable.test/s/${SITE_ID}/go/${graph.value.id}-${source.value.id}?cid=spring`,
      { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/129.0 Safari/537.36' } },
      edgeEnv,
      waits.ctx,
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(`${location.origin}${location.pathname}`).toBe('https://shop.example/spring');
    expect(location.searchParams.get('n')).toBe('lp');
    expect(location.searchParams.get('vid')).toMatch(/^[0-9a-f-]{36}$/);
  });
});
