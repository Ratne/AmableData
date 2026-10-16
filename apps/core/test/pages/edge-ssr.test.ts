import { app as edgeApp, type Env as EdgeEnv } from '@amable/app-edge';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { handleEdgeGateway } from '../../src/public/gateway';
import type { TestTenant } from '../crm/helpers';
import { inspectableTenantDb, collectWaits } from '../forms/helpers';
import { createHarness, seedTenant, type Harness } from '../helpers/harness';
import { fakeR2 } from './helpers';

// The edge entry exports its Durable Object class, which needs the Workers runtime.
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

const SECRET = 'e2e-edge-gateway-secret';
const SITE_MAIN = 'st_aaaaaaaaaaaaaaaaaaaa';
const SITE_SHOP = 'st_bbbbbbbbbbbbbbbbbbbb';

let h: Harness;
let db: TestTenant;
let edgeEnv: EdgeEnv;
let pageId = '';
let hostPageId = '';
const waits = collectWaits();
const files = fakeR2();

function edge(url: string, init: RequestInit = {}) {
  return edgeApp.request(url, init, edgeEnv, waits.ctx);
}

function fakeAnalytics(): EdgeEnv['ANALYTICS'] {
  const sites: Record<string, string[]> = { [SITE_MAIN]: ['acme.test'], [SITE_SHOP]: ['shop.example'] };
  return {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      indexList: () => Promise.resolve(Object.keys(sites)),
      getSite: () => {
        const id = name.replace(/^site:/, '');
        const hostnames = sites[id];
        return Promise.resolve(hostnames === undefined ? null : { site: { id, hostnames }, deleted: false });
      },
    }),
  } as unknown as EdgeEnv['ANALYTICS'];
}

beforeAll(async () => {
  h = await createHarness();
  const tenants = inspectableTenantDb();
  h.env.TENANT_DB = tenants.namespace;
  h.env.EDGE_GATEWAY_SECRET = SECRET;
  h.env.FILES = files;
  const acme = await seedTenant(h, 'acme');
  await h.env.DB.prepare(
    `INSERT INTO domains (id, tenant_id, hostname, kind, status, created_at) VALUES ('dom_1', ?, 'shop.example', 'pages', 'verified', 0)`,
  )
    .bind(acme.id)
    .run();
  db = tenants.tenant(acme.id);

  const page = db.op('pages.create', {
    title: 'Spring sale',
    path: '/spring',
    document: {
      editorKind: 'canvas',
      body: [
        {
          id: 'root',
          type: 'container',
          children: [
            { id: 'h', type: 'heading', settings: { title: 'Spring <em>sale</em>', htmlTag: 'h1' } },
            { id: 'img', type: 'image', settings: { image: { url: 'https://t.acme.example/m/acme/01HXMEDIA00000000000000000.png' } } },
            { id: 'f', type: 'form', settings: { formId: '01FORMID' } },
            { id: 'b', type: 'booking', settings: { eventSlug: 'demo-call' } },
          ],
        },
      ],
    },
  });
  pageId = page.id;
  db.op('pages.update', {
    id: pageId,
    data: { seo: { title: 'Spring sale | Acme', description: 'Up to 50% off', og_image: 'https://cdn.acme.test/og.png' }, settings: { lang: 'it' } },
  });
  db.op('pages.publish', { id: pageId });

  hostPageId = db.op('pages.create', { title: 'Shop home', path: '/', host: 'shop.example' }).id;
  db.op('pages.publish', { id: hostPageId });
  const hidden = db.op('pages.create', { title: 'Hidden', path: '/thanks', host: 'shop.example' });
  db.op('pages.update', { id: hidden.id, data: { seo: { noindex: true } } });
  db.op('pages.publish', { id: hidden.id });

  db.op('pages.createMedia', {
    id: '01HXMEDIA00000000000000000',
    r2_key: 'tenants/acme/media/01HXMEDIA00000000000000000.png',
    file: '01HXMEDIA00000000000000000.png',
    filename: 'hero.png',
    content_type: 'image/png',
    size: 4,
    sha256: 'deadbeef',
  });
  await files.put('tenants/acme/media/01HXMEDIA00000000000000000.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

  edgeEnv = {
    EDGE_GATEWAY_SECRET: SECRET,
    ANALYTICS: fakeAnalytics(),
    CORE: {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => handleEdgeGateway(new Request(input, init), h.env, waits.ctx),
    } as unknown as Fetcher,
  } as EdgeEnv;
});

describe('publish → edge SSR', () => {
  it('serves the published page on the /p/<slug> fallback URL with SEO, tracker and native embeds', async () => {
    const res = await edge('https://t.acme.example/p/acme/spring');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/=]+' 'sha256-[A-Za-z0-9+/=]+' https:\/\/challenges\.cloudflare\.com/);
    expect(csp).toContain("object-src 'none'");
    const html = await res.text();
    expect(html).toContain('<html lang="it">');
    expect(html).toContain('<title>Spring sale | Acme</title>');
    expect(html).toContain('<meta name="description" content="Up to 50% off"/>');
    expect(html).toContain('<link rel="canonical" href="https://t.acme.example/p/acme/spring"/>');
    expect(html).toContain('<meta property="og:title" content="Spring sale | Acme"/>');
    expect(html).toContain('<meta property="og:image" content="https://cdn.acme.test/og.png"/>');
    expect(html).toContain('<meta property="og:url" content="https://t.acme.example/p/acme/spring"/>');
    expect(html).toContain(`<meta name="amable-page-id" content="${pageId}"/>`);
    expect(html).toContain('<h1 class="b-heading">Spring <em>sale</em></h1>');
    expect(html).toContain('src="/m/acme/01HXMEDIA00000000000000000.png"');
    expect(html).toContain(`<div data-amable-form="01FORMID" data-amable-tenant="acme" data-amable-page="${pageId}"></div>`);
    expect(html).toContain(`<div data-amable-booking="demo-call" data-amable-tenant="acme" data-amable-page="${pageId}"></div>`);
    expect(html).toContain('<script async src="/forms.js"></script>');
    expect(html).toContain('<script async src="/booking.js"></script>');
    // No site matches the edge host: the tenant's first site gets the pageviews.
    expect(html).toContain(`<script defer data-site="${SITE_MAIN}" src="/s.js"></script>`);
    expect(html).not.toContain('noindex');
  });

  it('serves pages on a connected hostname with the matching analytics site, sitemap and robots', async () => {
    const res = await edge('https://shop.example/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<title>Shop home</title>');
    expect(html).toContain('<link rel="canonical" href="https://shop.example/"/>');
    expect(html).toContain(`data-site="${SITE_SHOP}"`);

    const hidden = await edge('https://shop.example/thanks');
    expect(hidden.headers.get('x-robots-tag')).toBe('noindex');
    expect(await hidden.text()).toContain('<meta name="robots" content="noindex,nofollow"/>');

    const sitemap = await edge('https://shop.example/sitemap.xml');
    expect(sitemap.headers.get('content-type')).toContain('application/xml');
    const xml = await sitemap.text();
    expect(xml).toContain('<loc>https://shop.example/</loc>');
    expect(xml).not.toContain('/thanks');

    const robots = await edge('https://shop.example/robots.txt');
    expect(await robots.text()).toContain('Sitemap: https://shop.example/sitemap.xml');

    const fallbackSitemap = await edge('https://t.acme.example/p/acme/sitemap.xml');
    expect(await fallbackSitemap.text()).toContain('<loc>https://t.acme.example/p/acme/spring</loc>');
  });

  it('answers 404 for unknown pages, unpublished pages and unknown hosts', async () => {
    expect((await edge('https://t.acme.example/p/acme/nope')).status).toBe(404);
    expect((await edge('https://unknown.example/')).status).toBe(404);
    db.op('pages.unpublish', { id: hostPageId });
    const gone = await edge('https://shop.example/');
    expect(gone.status).toBe(404);
    expect(await gone.text()).toContain('404');
  });

  it('streams media files from R2 through the core raw op', async () => {
    const res = await edge('https://shop.example/m/acme/01HXMEDIA00000000000000000.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(new Uint8Array(await res.arrayBuffer())[1]).toBe(0x50);
    expect((await edge('https://shop.example/m/acme/01HXMISSING000000000000000.png')).status).toBe(404);
    expect((await edge('https://shop.example/m/acme/..%2Fsecret')).status).toBe(404);
  });
});
