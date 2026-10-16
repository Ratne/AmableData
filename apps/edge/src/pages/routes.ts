import type { GatewayTenantInfo, GatewayTenantRef } from '@amable/api-types';
import {
  builderPageCsp,
  renderBuilderPage,
  type PagesGatewayOps,
  type PublishedPage,
} from '@amable/builder';
import { Hono, type Context, type Handler } from 'hono';
import { siteStub, tenantSitesStub } from '../analytics/rpc';
import type { Env } from '../env';
import { callCore, callCoreRaw, clientInfo, GatewayCallError, tenantRef } from '../gateway';

/**
 * Published landing pages on the edge:
 * - `GET /p/:slug`, `/p/:slug/*`: fallback URLs (before a domain is connected, and in dev);
 * - `GET /p/:slug/sitemap.xml`;
 * - `GET /m/:slug/:file`: media files (R2, through the core raw op);
 * - `pagesCatchAll`: `<host>/<path>` on connected customer hostnames, plus
 *   `/sitemap.xml` and `/robots.txt`.
 * Rendered HTML is cached with the Cache API, keyed by the published version.
 */
export const pagesEdgeRoutes = new Hono<{ Bindings: Env }>();

type Ctx = Context<{ Bindings: Env }>;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/i;
const FILE_RE = /^[A-Za-z0-9]{10,40}\.[a-z0-9]{2,5}$/;
const HTML_CACHE_SECONDS = 300;

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function notFoundPage(): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex"/><title>Page not found</title><style>body{font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;color:#334155;background:#f8fafc}main{text-align:center}h1{font-size:4rem;margin:0;color:#0f172a}</style></head><body><main><h1>404</h1><p>This page does not exist.</p></main></body></html>`;
  return new Response(html, {
    status: 404,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      'x-content-type-options': 'nosniff',
    },
  });
}

function unavailable(error: unknown): Response {
  if (error instanceof GatewayCallError && error.body.status === 404) return notFoundPage();
  console.error('[pages] gateway call failed', error);
  return new Response('Service unavailable', { status: 503, headers: { 'cache-control': 'no-store' } });
}

async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  let binary = '';
  for (const b of new Uint8Array(digest)) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Hostname match: a site hostname also covers its subdomains. */
function hostMatches(siteHost: string, host: string): boolean {
  const h = siteHost.toLowerCase();
  return host === h || host.endsWith(`.${h}`);
}

/**
 * Tracker site of a page: the page setting, else the tenant site whose
 * hostnames include the host, else the tenant's first site, else none.
 */
export async function trackerSiteId(
  env: Env,
  tenantId: string,
  explicit: string | null,
  host: string,
): Promise<string | null> {
  if (explicit !== null) return explicit;
  try {
    const ids = await tenantSitesStub(env.ANALYTICS, tenantId).indexList();
    for (const id of ids) {
      const record = await siteStub(env.ANALYTICS, id).getSite();
      if (record !== null && !record.deleted && record.site.hostnames.some((h) => hostMatches(h, host))) return id;
    }
    return ids[0] ?? null;
  } catch (error) {
    console.error('[pages] analytics site lookup failed', error);
    return null;
  }
}

function defaultCache(): Cache | null {
  const store = (globalThis as { caches?: CacheStorage & { default?: Cache } }).caches;
  return store?.default ?? null;
}

interface ServeOptions {
  ref: GatewayTenantRef;
  /** Page host to resolve (null on `/p/<slug>` URLs). */
  host: string | null;
  path: string;
  /** Public URL of this page as requested (canonical fallback). */
  url: string;
}

async function servePage(c: Ctx, options: ServeOptions): Promise<Response> {
  let resolved: { tenant: GatewayTenantInfo; value: PublishedPage };
  try {
    resolved = await callCore<PagesGatewayOps, 'pages.resolve'>(c.env, 'pages.resolve', options.ref, clientInfo(c), {
      host: options.host,
      path: options.path,
    });
  } catch (error) {
    return unavailable(error);
  }
  const { tenant, value: published } = resolved;
  const cache = defaultCache();
  const cacheKey = new Request(
    `https://pages-cache.internal/${tenant.id}/${published.version.id}/${encodeURIComponent(options.url)}`,
  );
  if (cache !== null) {
    const hit = await cache.match(cacheKey);
    if (hit !== undefined) return hit;
  }
  const requestHost = new URL(c.req.url).hostname.toLowerCase();
  const siteId = await trackerSiteId(c.env, tenant.id, published.settings.analytics_site_id, published.page.host ?? requestHost);
  const { seo, settings } = published;
  const rendered = renderBuilderPage(published.document, {
    mode: 'public',
    tenantSlug: tenant.slug,
    pageId: published.page.id,
    mediaBaseUrl: `/m/${tenant.slug}/`,
    trackerSiteId: siteId,
    meta: {
      title: seo.title ?? published.page.title,
      ...(seo.description === null ? {} : { description: seo.description }),
      canonical: seo.canonical ?? options.url,
      url: options.url,
      ...(seo.og_image === null ? {} : { ogImage: seo.og_image }),
      noindex: seo.noindex,
      ...(settings.favicon === null ? {} : { favicon: settings.favicon }),
      lang: settings.lang ?? 'en',
      siteName: tenant.name,
    },
  });
  const hashes = await Promise.all(rendered.inlineScripts.map(sha256Base64));
  const response = new Response(rendered.html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': `public, max-age=60`,
      'content-security-policy': builderPageCsp(rendered, hashes),
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      ...(seo.noindex ? { 'x-robots-tag': 'noindex' } : {}),
    },
  });
  if (cache !== null) {
    const stored = response.clone();
    const cached = new Response(stored.body, stored);
    cached.headers.set('cache-control', `public, max-age=${HTML_CACHE_SECONDS}`);
    const put = cache.put(cacheKey, cached).catch((error: unknown) => console.error('[pages] cache put failed', error));
    try {
      c.executionCtx.waitUntil(put);
    } catch {
      await put;
    }
  }
  return response;
}

async function serveSitemap(c: Ctx, ref: GatewayTenantRef, host: string | null, base: string): Promise<Response> {
  let urls: Array<{ path: string; published_at: number }>;
  try {
    urls = (await callCore<PagesGatewayOps, 'pages.sitemap'>(c.env, 'pages.sitemap', ref, clientInfo(c), { host })).value.data;
  } catch (error) {
    return unavailable(error);
  }
  const body = urls
    .map(
      (u) =>
        `<url><loc>${escapeHtml(base + (u.path === '/' ? '/' : u.path))}</loc><lastmod>${new Date(u.published_at).toISOString()}</lastmod></url>`,
    )
    .join('');
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`,
    { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=300' } },
  );
}

/** Path after `/p/<slug>`, `/` when empty. */
function restPath(c: Ctx, slug: string): string {
  const pathname = new URL(c.req.url).pathname;
  const rest = pathname.slice(`/p/${slug}`.length);
  return rest === '' ? '/' : rest;
}

pagesEdgeRoutes.get('/m/:slug/:file', async (c) => {
  const slug = c.req.param('slug');
  const file = c.req.param('file');
  if (!SLUG_RE.test(slug) || !FILE_RE.test(file)) return c.text('Not found', 404);
  try {
    const res = await callCoreRaw(c.env, 'pages.media', { slug }, clientInfo(c), { file });
    if (!res.ok) return c.text('Not found', res.status === 404 ? 404 : 502);
    return new Response(res.body, { status: 200, headers: new Headers(res.headers) });
  } catch (error) {
    return unavailable(error);
  }
});

pagesEdgeRoutes.get('/p/:slug/sitemap.xml', (c) => {
  const slug = c.req.param('slug');
  if (!SLUG_RE.test(slug)) return notFoundPage();
  return serveSitemap(c, { slug }, null, `${new URL(c.req.url).origin}/p/${slug}`);
});

const fallbackPage: Handler<{ Bindings: Env }> = (c) => {
  const slug = c.req.param('slug') ?? '';
  if (!SLUG_RE.test(slug)) return notFoundPage();
  const path = restPath(c, slug);
  const origin = new URL(c.req.url).origin;
  return servePage(c, {
    ref: { slug },
    host: null,
    path,
    url: `${origin}/p/${slug}${path === '/' ? '' : path}`,
  });
};
pagesEdgeRoutes.get('/p/:slug', fallbackPage);
pagesEdgeRoutes.get('/p/:slug/*', fallbackPage);

/**
 * Published pages on connected customer hostnames (`GET <host>/<path>`), plus
 * their sitemap.xml / robots.txt. Mounted last: every other edge route wins.
 */
export const pagesCatchAll: Handler<{ Bindings: Env }> = (c) => {
  const url = new URL(c.req.url);
  const host = url.hostname.toLowerCase();
  const ref = tenantRef(c);
  if (url.pathname === '/robots.txt') {
    return c.text(`User-agent: *\nAllow: /\nSitemap: ${url.origin}/sitemap.xml\n`, 200, {
      'cache-control': 'public, max-age=3600',
    });
  }
  if (url.pathname === '/sitemap.xml') return serveSitemap(c, ref, host, url.origin);
  return servePage(c, { ref, host, path: url.pathname, url: `${url.origin}${url.pathname}` });
};
