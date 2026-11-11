import { SCRIPT_PATH_RE, serverEventSchema, trackerEventSchema } from '@amable/api-types';
import {
  TRACKER_BUNDLE_HASHES,
  TRACKER_BUNDLES,
  type TrackerVariant,
} from '@amable/tracker/bundles';
import { Hono, type Context, type Next } from 'hono';
import type { Env } from '../env';
import { verifyCrawlerIp } from './crawler-ip';
import { detectBot } from './crawlers';
import {
  enrichServerEvent,
  enrichTrackerEvent,
  eventIdOf,
  geoFromCf,
  hostAllowed,
  occurredAt,
  type RequestContext,
} from './enrich';
import { dispatch, ingestMessages, loadSiteConfig } from './pipeline';
import { siteIdOfSecret } from './rpc';
import {
  PROXY_CITY_HEADER,
  PROXY_COUNTRY_HEADER,
  PROXY_HOST_HEADER,
  PROXY_IP_HEADER,
  PROXY_KEY_HEADER,
  PROXY_REGION_HEADER,
  proxyKeyValid,
} from './proxy-key';
import type { AnalyticsMessage, BotHit, Geo } from './types';
import { sha256Hex } from '@amable/auth';

type AppContext = Context<{ Bindings: Env }>;

export const MAX_EVENT_BYTES = 16 * 1024;

export const analyticsRoutes = new Hono<{ Bindings: Env }>();

function hostOf(value: string | undefined | null): string | null {
  if (value === undefined || value === null || value === '' || value === 'null') return null;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function corsHeaders(c: AppContext): Record<string, string> {
  const origin = c.req.header('origin');
  return origin === undefined
    ? {}
    : { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-max-age': '86400' };
}

function reply(
  c: AppContext,
  status: 202 | 400 | 401 | 403 | 404 | 413,
  body: Record<string, unknown>,
): Response {
  return c.json(body, status, corsHeaders(c));
}

async function readBody(c: AppContext): Promise<unknown | 'too_large' | 'invalid'> {
  const length = Number(c.req.header('content-length') ?? '0');
  if (length > MAX_EVENT_BYTES) return 'too_large';
  const text = await c.req.text();
  if (text.length > MAX_EVENT_BYTES) return 'too_large';
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return 'invalid';
  }
}

function requestContext(
  c: AppContext,
  overrides: { ip?: string; userAgent?: string; eid?: string; at?: number | string } = {},
): RequestContext {
  const cf = (c.req.raw as Request & { cf?: Record<string, unknown> }).cf;
  const now = Date.now();
  return {
    eid: overrides.eid ?? crypto.randomUUID(),
    now,
    ts: occurredAt(overrides.at, now),
    ip: overrides.ip ?? c.req.header('cf-connecting-ip') ?? '0.0.0.0',
    userAgent: overrides.userAgent ?? c.req.header('user-agent') ?? '',
    geo: geoFromCf(cf),
  };
}

interface TrustedProxy {
  ip: string | null;
  host: string | null;
  geo: Partial<Pick<Geo, 'country' | 'region' | 'city'>>;
}

/**
 * Headers of a reverse-proxy recipe, only when they carry the site's proxy key
 * (`proxy-key.ts`): without it they are ignored and the request is taken as is.
 */
async function trustedProxy(c: AppContext, siteId: string): Promise<TrustedProxy | null> {
  if (!(await proxyKeyValid(c.env.EDGE_GATEWAY_SECRET, siteId, c.req.header(PROXY_KEY_HEADER))))
    return null;
  const ip = c.req.header(PROXY_IP_HEADER)?.split(',')[0]?.trim() ?? '';
  const host = c.req.header(PROXY_HOST_HEADER)?.trim().toLowerCase() ?? '';
  const text = (name: string, re: RegExp) => {
    const v = c.req.header(name)?.trim() ?? '';
    return re.test(v) ? decodeURIComponent(v) : undefined;
  };
  return {
    ip: /^[\d.]{7,15}$|^[\da-f:]{2,45}$/i.test(ip) ? ip : null,
    host: /^[a-z0-9.-]{1,253}$/.test(host) ? host : null,
    geo: {
      country: text(PROXY_COUNTRY_HEADER, /^[A-Z]{2}$/),
      region: text(PROXY_REGION_HEADER, /^[\w%.\- ]{1,120}$/),
      city: text(PROXY_CITY_HEADER, /^[\w%.\- ]{1,120}$/),
    },
  };
}

/** Applies a trusted proxy to the request context (visitor IP and location). */
function applyProxy(ctx: RequestContext, proxy: TrustedProxy): void {
  if (proxy.ip !== null) ctx.ip = proxy.ip;
  if (proxy.geo.country !== undefined)
    ctx.geo = {
      country: proxy.geo.country,
      region: proxy.geo.region ?? null,
      city: proxy.geo.city ?? null,
      latitude: null,
      longitude: null,
    };
}

/**
 * Cookie domain behind a proxy: the page host itself, without `www.` (the
 * tracker writes its cookie on the root domain, the two must be the same one).
 */
function proxyCookieDomain(host: string): string | null {
  if (/^[\d.]+$/.test(host) || host.includes(':') || !host.includes('.')) return null;
  return host.startsWith('www.') && host.split('.').length > 2 ? host.slice(4) : host;
}

/**
 * Neutral per-site paths (`SCRIPT_PATH_RE` of api-types): `/<dir>/<name>` takes
 * the events and site mode, `/<dir>/<name>.js` (`-l` cookieless, `-h` hash) the script.
 */
export const NEUTRAL_EVENT_PATH = '/:dir{[a-z0-9]{6,16}}/:name{[a-z0-9]{2,16}}';
const NEUTRAL_SCRIPT_PATH = '/:dir{[a-z0-9]{6,16}}/:file{[a-z0-9]{2,16}(?:-[lh])?\\.js}';

/**
 * The neutral patterns also match landing page paths served by the catch-all
 * (`/offerta/estate`): anything that is not a valid site path, or a mode
 * request without `site`, goes on to the next routes.
 */
const neutralOnly =
  (handler: (c: AppContext) => Response | Promise<Response>, needsSite = false) =>
  (c: AppContext, next: Next) => {
    const name = (c.req.param('name') ?? c.req.param('file') ?? '').replace(/(?:-[lh])?\.js$/, '');
    if (!SCRIPT_PATH_RE.test(`${c.req.param('dir') ?? ''}/${name}`)) return next();
    if (needsSite && c.req.query('site') === undefined) return next();
    return handler(c);
  };

function pathOfUrl(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '/';
  }
}

// ------------------------------------------------------------------ browser ingest

const preflight = (c: AppContext) =>
  new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(c),
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    },
  });
analyticsRoutes.options('/e', preflight);
analyticsRoutes.options(NEUTRAL_EVENT_PATH, neutralOnly(preflight));

/**
 * Site mode for the cookie builds of the tracker, asked before they write any
 * cookie: on a site set to cookieless they run without cookies.
 */
const siteMode = async (c: AppContext) => {
  const site = await loadSiteConfig(c.env, c.req.query('site') ?? '', Date.now());
  const headers = {
    'access-control-allow-origin': '*',
    'cross-origin-resource-policy': 'cross-origin',
  };
  if (site === null) {
    return c.json({ error: 'unknown_site' }, 404, { ...headers, 'cache-control': 'no-store' });
  }
  const origin = c.req.header('origin');
  const originHost = hostOf(origin);
  const proxy = await trustedProxy(c, site.siteId);
  const domain =
    site.cookieless || originHost === null || !hostAllowed(originHost, site)
      ? null
      : proxy?.host != null
        ? proxy.host === originHost
          ? proxyCookieDomain(proxy.host)
          : sharedCookieDomain(originHost, proxy.host)
        : sharedCookieDomain(originHost, new URL(c.req.url).hostname);
  if (domain === null || origin === undefined) {
    return c.json({ cookieless: site.cookieless }, 200, {
      ...headers,
      'cache-control': 'public, max-age=300',
    });
  }
  // Tracking domain of the site: the visitor id also lives in a cookie set by
  // this response (kept longer than script cookies by some browsers).
  const stored = visitorIdOf(cookieOf(c.req.header('cookie'), VISITOR_COOKIE));
  const vid = visitorIdOf(c.req.query('vid')) ?? stored;
  const res = c.json({ cookieless: false, ...(stored === null ? {} : { vid: stored }) }, 200, {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    vary: 'Origin, Cookie',
    'cache-control': 'private, no-store',
  });
  if (vid !== null) {
    res.headers.append(
      'set-cookie',
      `${VISITOR_COOKIE}=${vid}; Domain=${domain}; Path=/; Max-Age=${VISITOR_COOKIE_MAX_AGE_S}; Secure; SameSite=Lax`,
    );
  }
  return res;
};
analyticsRoutes.get('/e', siteMode);
analyticsRoutes.get(NEUTRAL_EVENT_PATH, neutralOnly(siteMode, true));

const VISITOR_COOKIE = 'amb_vid';
const VISITOR_COOKIE_MAX_AGE_S = 400 * 24 * 3600;

const visitorIdOf = (v: string | null | undefined): string | null =>
  v !== undefined && v !== null && /^[a-zA-Z0-9-]{8,64}$/.test(v) ? v : null;

function cookieOf(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * Domain both hosts belong to (`example.com` for `www.example.com` and
 * `t.example.com`), at least two labels; null when the tracking host is not a
 * subdomain of the page's site (a shared endpoint never sets cookies).
 */
export function sharedCookieDomain(pageHost: string, trackingHost: string): string | null {
  if (/^[\d.]+$/.test(trackingHost) || trackingHost.includes(':')) return null;
  const a = pageHost.split('.').reverse();
  const b = trackingHost.split('.').reverse();
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  if (n < 2) return null;
  return b.slice(0, n).reverse().join('.');
}

/**
 * Browser tracker ingest. The body is JSON sent as text/plain (CORS-simple, works
 * with sendBeacon). Accepted only from the site's hostnames; bots and crawlers
 * are counted separately and never become visitors.
 */
const browserIngest = async (c: AppContext) => {
  const body = await readBody(c);
  if (body === 'too_large') return reply(c, 413, { error: 'payload_too_large' });
  const parsed = trackerEventSchema.safeParse(body);
  if (!parsed.success) return reply(c, 400, { error: 'invalid_event' });
  const payload = parsed.data;
  const ctx = requestContext(c, {
    eid: eventIdOf('tracker', payload.type, payload.id),
    at: payload.at,
  });
  const site = await loadSiteConfig(c.env, payload.site, ctx.now);
  if (site === null) return reply(c, 404, { error: 'unknown_site' });

  const originHost = hostOf(c.req.header('origin')) ?? hostOf(c.req.header('referer'));
  const pageHost = hostOf(payload.url);
  if (
    originHost === null ||
    pageHost === null ||
    !hostAllowed(originHost, site) ||
    !hostAllowed(pageHost, site)
  ) {
    return reply(c, 403, { error: 'origin_not_allowed' });
  }

  const proxy = await trustedProxy(c, site.siteId);
  if (proxy !== null) applyProxy(ctx, proxy);
  const bot = detectBot(ctx.userAgent);
  if (bot !== null) {
    const hit: BotHit = {
      id: ctx.eid,
      site: site.siteId,
      ts: ctx.now,
      ...bot,
      path: pathOfUrl(payload.url),
      verification: verifyCrawlerIp(bot.name, ctx.ip),
    };
    await dispatch(c.env, [{ kind: 'bot', hit }]);
    return reply(c, 202, { ok: true });
  }
  ctx.collector =
    proxy !== null
      ? 'proxy'
      : sharedCookieDomain(pageHost, new URL(c.req.url).hostname) !== null
        ? 'first_party'
        : 'third_party';
  const event = await enrichTrackerEvent(payload, site, ctx);
  if (event === null) return reply(c, 400, { error: 'invalid_event' });
  await ingestMessages(c.env, site, [{ kind: 'event', event }]);
  return reply(c, 202, { ok: true });
};
analyticsRoutes.post('/e', browserIngest);
analyticsRoutes.post(NEUTRAL_EVENT_PATH, neutralOnly(browserIngest));

// ------------------------------------------------------------------ server SDK ingest

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Server SDK ingest: goals, payments, identify, server-side pageviews and crawler
 * hits (e.g. a Worker/Node/PHP middleware reporting AI bots that never run JS).
 * `Authorization: Bearer amb_sk_<siteId>.<secret>`.
 */
analyticsRoutes.post('/e/server', async (c) => {
  const auth = c.req.header('authorization') ?? '';
  const secret = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const siteId = siteIdOfSecret(secret);
  if (siteId === null) return reply(c, 401, { error: 'invalid_site_secret' });
  const ctxNow = Date.now();
  const site = await loadSiteConfig(c.env, siteId, ctxNow);
  if (
    site === null ||
    site.secretHash === null ||
    !timingSafeEqualHex(await sha256Hex(secret), site.secretHash)
  ) {
    return reply(c, 401, { error: 'invalid_site_secret' });
  }
  const body = await readBody(c);
  if (body === 'too_large') return reply(c, 413, { error: 'payload_too_large' });
  const parsed = serverEventSchema.safeParse(body);
  if (!parsed.success) {
    return reply(c, 400, {
      error: 'invalid_event',
      details: parsed.error.issues
        .slice(0, 5)
        .map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  const payload = parsed.data;
  const messages: AnalyticsMessage[] = [];

  if (payload.type === 'crawler' || payload.type === 'pageview') {
    const ctx = requestContext(c, {
      ip: payload.ip ?? '0.0.0.0',
      userAgent: payload.user_agent,
      eid: eventIdOf('server', payload.type, payload.event_id),
      at: payload.occurred_at,
    });
    const bot = detectBot(payload.user_agent);
    const verification = bot === null ? null : verifyCrawlerIp(bot.name, payload.ip);
    if (bot !== null) {
      messages.push({
        kind: 'bot',
        hit: {
          id: ctx.eid,
          site: site.siteId,
          ts: ctx.now,
          ...bot,
          path: pathOfUrl(payload.url),
          verification: verification ?? 'unknown',
        },
      });
    } else if (payload.type === 'pageview') {
      messages.push({ kind: 'event', event: await enrichServerEvent(payload, site, ctx) });
    }
    await ingestMessages(c.env, site, messages);
    return reply(c, 202, { ok: true, bot: bot === null ? null : { ...bot, verification } });
  }

  const ctx = requestContext(c, {
    eid: eventIdOf('server', payload.type, payload.event_id),
    at: payload.occurred_at,
  });
  messages.push({ kind: 'event', event: await enrichServerEvent(payload, site, ctx) });
  await ingestMessages(c.env, site, messages);
  return reply(c, 202, { ok: true });
});

// ------------------------------------------------------------------ tracker script

const SCRIPT_ROUTES: ReadonlyArray<[path: string, variant: TrackerVariant]> = [
  ['/s.js', 'default'],
  ['/s.cookieless.js', 'cookieless'],
  ['/s.hash.js', 'hash'],
];

function serveScript(c: AppContext, variant: TrackerVariant): Response {
  const etag = `"${TRACKER_BUNDLE_HASHES[variant]}"`;
  const headers: Record<string, string> = {
    'content-type': 'application/javascript; charset=utf-8',
    'cache-control': 'public, max-age=3600, stale-while-revalidate=86400',
    etag,
    'access-control-allow-origin': '*',
    'cross-origin-resource-policy': 'cross-origin',
    'x-content-type-options': 'nosniff',
  };
  const inm = c.req.header('if-none-match');
  if (inm !== undefined && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(TRACKER_BUNDLES[variant], { status: 200, headers });
}

for (const [path, variant] of SCRIPT_ROUTES)
  analyticsRoutes.get(path, (c) => serveScript(c, variant));
analyticsRoutes.get(
  NEUTRAL_SCRIPT_PATH,
  neutralOnly((c) => {
    const file = c.req.param('file') ?? '';
    return serveScript(
      c,
      file.endsWith('-l.js') ? 'cookieless' : file.endsWith('-h.js') ? 'hash' : 'default',
    );
  }),
);
