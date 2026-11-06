import {
  SHORTLINK_CLICK_GATEWAY_OP,
  SHORTLINK_HOST_GATEWAY_OP,
  SHORTLINK_RESOLVE_GATEWAY_OP,
  type GatewayClientInfo,
  type ShortlinkClickInput,
  type ShortlinkGatewayOps,
  type ShortlinkTarget,
} from '@amable/api-types';
import type { MiddlewareHandler } from 'hono';
import { detectBot } from '../analytics/crawlers';
import { geoFromCf } from '../analytics/enrich';
import { parseUserAgent } from '../analytics/ua';
import type { Env } from '../env';
import { callCore, GatewayCallError } from '../gateway';
import { escapeHtml } from '../public/http';

/**
 * Public side of short links. Hostnames connected as `shortlink` domains are
 * dedicated: every request on them is answered here and never reaches the
 * landing pages.
 *
 * - `https://<host>/<key>` → 302 to the link URL + its UTM + (pass_query) the
 *   query of the visit, which wins over the saved UTM.
 * - Expired link → 302 to its fallback URL, else 404; expired visits are not counted.
 * - Social crawlers on a link with custom og fields → minimal page with og:* / twitter:* meta.
 * - Root and unknown keys → minimal 404. `/health` (domain verification) passes through.
 *   Nested paths are never looked up: they go on to the other edge routes,
 *   whose landing catch-all does not serve shortlink hostnames (404).
 * - Host and link lookups go through the core gateway, cached per isolate for
 *   60s (edits show up within a minute); clicks are recorded with `waitUntil`.
 *   Bots are flagged in the statistics, never blocked.
 */

const CACHE_TTL_MS = 60_000;
const MAX_ENTRIES = 5_000;
const KEY_PATH_RE = /^\/([a-zA-Z0-9_-]{1,64})\/?$/;
const PASS_THROUGH = new Set(['/health']);

/** Automated clients (statistics flag only). */
const BOT_RE =
  /bot|crawler|spider|crawling|facebookexternalhit|facebook|meta-external|whatsapp|telegram|slack|twitterbot|linkedin|pinterest|discord|skypeuripreview|preview|curl|wget|python-requests|python-httpx|go-http-client|axios|node-fetch|okhttp|headless|lighthouse|pingdom|uptime|monitor/i;

/** Social crawlers served the custom og preview instead of the redirect. */
const SOCIAL_CRAWLER_RE =
  /facebookexternalhit|facebot|meta-externalagent|twitterbot|linkedinbot|whatsapp|telegrambot|slackbot|discordbot|pinterest|skypeuripreview|redditbot|snapchat|vkshare/i;

const NO_CLIENT: GatewayClientInfo = {
  ip: null,
  userAgent: null,
  country: null,
  visitorId: null,
  referer: null,
  acceptLanguage: null,
};

export interface ShortlinkHost {
  readonly tenantSlug: string;
  readonly domainId: string;
}

class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; until: number }>();

  get(key: string, now: number): V | undefined {
    const hit = this.entries.get(key);
    if (hit === undefined) return undefined;
    if (hit.until <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V, now: number): void {
    if (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, until: now + CACHE_TTL_MS });
  }

  clear(): void {
    this.entries.clear();
  }
}

const hosts = new TtlCache<ShortlinkHost | null>();
const links = new TtlCache<ShortlinkTarget | null>();

/** Test hook. */
export function clearShortlinkCaches(): void {
  hosts.clear();
  links.clear();
}

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
}

/**
 * Tenant and domain of a verified shortlink hostname; `null` for any other
 * hostname. Gateway outages are not cached and resolve to `null` (the request
 * goes on to the other routes).
 */
export async function resolveShortlinkHost(
  env: Env,
  hostname: string,
  now: number = Date.now(),
): Promise<ShortlinkHost | null> {
  const host = normalizeHost(hostname);
  if (env.CORE === undefined || host === '' || host.length > 253 || host.endsWith('.workers.dev')) return null;
  const cached = hosts.get(host, now);
  if (cached !== undefined) return cached;
  let value: ShortlinkHost | null;
  try {
    const result = await callCore<ShortlinkGatewayOps, typeof SHORTLINK_HOST_GATEWAY_OP>(
      env,
      SHORTLINK_HOST_GATEWAY_OP,
      { host },
      NO_CLIENT,
      {},
    );
    value = { tenantSlug: result.tenant.slug, domainId: result.value.domainId };
  } catch (error) {
    if (!(error instanceof GatewayCallError) || error.body.status !== 404) {
      console.error('[shortlinks] host lookup failed', error);
      return null;
    }
    value = null;
  }
  hosts.set(host, value, now);
  return value;
}

async function resolveTarget(
  env: Env,
  host: ShortlinkHost,
  key: string,
  now: number,
): Promise<ShortlinkTarget | null> {
  const cacheKey = `${host.domainId}/${key}`;
  const cached = links.get(cacheKey, now);
  if (cached !== undefined) return cached;
  const result = await callCore<ShortlinkGatewayOps, typeof SHORTLINK_RESOLVE_GATEWAY_OP>(
    env,
    SHORTLINK_RESOLVE_GATEWAY_OP,
    { slug: host.tenantSlug },
    NO_CLIENT,
    { domainId: host.domainId, key },
  );
  links.set(cacheKey, result.value, now);
  return result.value;
}

/** Saved URL + UTM + (pass_query) the query of the visit, which wins. */
export function composeDestination(link: ShortlinkTarget, incoming: URL): string {
  let dest: URL;
  try {
    dest = new URL(link.url);
  } catch {
    return link.url;
  }
  for (const [k, v] of Object.entries(link.utm)) {
    if (v !== undefined && v !== '') dest.searchParams.set(k, v);
  }
  if (link.passQuery) {
    for (const [k, v] of incoming.searchParams.entries()) dest.searchParams.set(k, v);
  }
  return dest.toString();
}

function hasOg(link: ShortlinkTarget): boolean {
  return Boolean(link.ogTitle || link.ogDescription || link.ogImage);
}

/** Minimal page with the custom og meta, for social crawlers only. */
export function ogPreviewHtml(link: ShortlinkTarget, destination: string): string {
  const title = escapeHtml(link.ogTitle ?? '');
  const description = escapeHtml(link.ogDescription ?? '');
  const image = escapeHtml(link.ogImage ?? '');
  const url = escapeHtml(destination);
  const meta = [
    '<meta property="og:type" content="website">',
    `<meta property="og:url" content="${url}">`,
    link.ogTitle ? `<meta property="og:title" content="${title}">` : '',
    link.ogDescription
      ? `<meta property="og:description" content="${description}"><meta name="description" content="${description}">`
      : '',
    link.ogImage ? `<meta property="og:image" content="${image}">` : '',
    `<meta name="twitter:card" content="${link.ogImage ? 'summary_large_image' : 'summary'}">`,
    link.ogTitle ? `<meta name="twitter:title" content="${title}">` : '',
    link.ogDescription ? `<meta name="twitter:description" content="${description}">` : '',
    link.ogImage ? `<meta name="twitter:image" content="${image}">` : '',
  ].filter((m) => m !== '');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>\n${meta.join('\n')}\n</head><body></body></html>`;
}

function notFound(): Response {
  return new Response('Link not found', {
    status: 404,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
    },
  });
}

function redirect302(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location, 'cache-control': 'no-store' },
  });
}

function referrerHost(referer: string | null): string | null {
  if (referer === null || referer === '') return null;
  try {
    return new URL(referer).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

export function clickFacts(request: Request, linkId: string): ShortlinkClickInput {
  const ua = request.headers.get('user-agent') ?? '';
  const cf = (request as { cf?: Record<string, unknown> }).cf;
  const verifiedBot = typeof cf?.verifiedBotCategory === 'string' && cf.verifiedBotCategory !== '';
  const parsed = parseUserAgent(ua);
  return {
    linkId,
    country: geoFromCf(cf).country,
    referrerHost: referrerHost(request.headers.get('referer')),
    device: parsed.device,
    browser: parsed.browser,
    os: parsed.os,
    bot: verifiedBot || BOT_RE.test(ua) || detectBot(ua) !== null,
  };
}

async function trackClick(env: Env, host: ShortlinkHost, facts: ShortlinkClickInput): Promise<void> {
  try {
    await callCore<ShortlinkGatewayOps, typeof SHORTLINK_CLICK_GATEWAY_OP>(
      env,
      SHORTLINK_CLICK_GATEWAY_OP,
      { slug: host.tenantSlug },
      NO_CLIENT,
      facts,
    );
  } catch (error) {
    console.error('[shortlinks] click not recorded', error);
  }
}

/** Answers a request on a shortlink hostname (always a Response). */
export async function handleShortlinkRequest(
  request: Request,
  env: Env,
  host: ShortlinkHost,
  waitUntil: (promise: Promise<unknown>) => void,
  now: number = Date.now(),
): Promise<Response> {
  const url = new URL(request.url);
  const key = KEY_PATH_RE.exec(url.pathname)?.[1];
  if (key === undefined) return notFound();
  let link: ShortlinkTarget | null;
  try {
    link = await resolveTarget(env, host, key, now);
  } catch (error) {
    if (error instanceof GatewayCallError && error.body.status === 404) return notFound();
    throw error;
  }
  if (link === null) return notFound();

  if (link.expiresAt !== null && now >= link.expiresAt) {
    return link.expiredUrl !== null ? redirect302(link.expiredUrl) : notFound();
  }
  waitUntil(trackClick(env, host, clickFacts(request, link.id)));

  const destination = composeDestination(link, url);
  const ua = request.headers.get('user-agent') ?? '';
  if (hasOg(link) && SOCIAL_CRAWLER_RE.test(ua)) {
    return new Response(ogPreviewHtml(link, destination), {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  return redirect302(destination);
}

/** Mounted before every other route: answers `GET /` and `GET /<key>` on shortlink hostnames, lets the rest through. */
export const shortlinkHostMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const method = c.req.method;
  if (method !== 'GET' && method !== 'HEAD') return next();
  const url = new URL(c.req.url);
  if (PASS_THROUGH.has(url.pathname) || (url.pathname !== '/' && !KEY_PATH_RE.test(url.pathname))) return next();
  const host = await resolveShortlinkHost(c.env, url.hostname);
  if (host === null) return next();
  return handleShortlinkRequest(c.req.raw, c.env, host, (p) => {
    try {
      c.executionCtx.waitUntil(p);
    } catch {
      // No execution context (tests): the promise still runs.
    }
  });
};
