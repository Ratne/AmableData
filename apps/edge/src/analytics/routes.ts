import { serverEventSchema, trackerEventSchema } from '@amable/api-types';
import {
  TRACKER_BUNDLE_HASHES,
  TRACKER_BUNDLES,
  type TrackerVariant,
} from '@amable/tracker/bundles';
import { Hono, type Context } from 'hono';
import type { Env } from '../env';
import { sha256Hex } from './cookieless';
import { verifyCrawlerIp } from './crawler-ip';
import { detectBot } from './crawlers';
import {
  enrichServerEvent,
  enrichTrackerEvent,
  geoFromCf,
  hostAllowed,
  type RequestContext,
} from './enrich';
import { dispatch, loadSiteConfig } from './pipeline';
import { siteIdOfSecret } from './rpc';
import type { AnalyticsMessage, BotHit } from './types';

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
  overrides: { ip?: string; userAgent?: string } = {},
): RequestContext {
  const cf = (c.req.raw as Request & { cf?: Record<string, unknown> }).cf;
  return {
    eid: crypto.randomUUID(),
    now: Date.now(),
    ip: overrides.ip ?? c.req.header('cf-connecting-ip') ?? '0.0.0.0',
    userAgent: overrides.userAgent ?? c.req.header('user-agent') ?? '',
    geo: geoFromCf(cf),
  };
}

function pathOfUrl(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '/';
  }
}

// ------------------------------------------------------------------ browser ingest

analyticsRoutes.options('/e', (c) => {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(c),
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    },
  });
});

/**
 * Site mode for the cookie builds of the tracker, asked before they write any
 * cookie: on a site set to cookieless they run without cookies.
 */
analyticsRoutes.get('/e', async (c) => {
  const site = await loadSiteConfig(c.env, c.req.query('site') ?? '', Date.now());
  const headers = { 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' };
  if (site === null) {
    return c.json({ error: 'unknown_site' }, 404, { ...headers, 'cache-control': 'no-store' });
  }
  return c.json({ cookieless: site.cookieless }, 200, {
    ...headers,
    'cache-control': 'public, max-age=300',
  });
});

/**
 * Browser tracker ingest. The body is JSON sent as text/plain (CORS-simple, works
 * with sendBeacon). Accepted only from the site's hostnames; bots and crawlers
 * are counted separately and never become visitors.
 */
analyticsRoutes.post('/e', async (c) => {
  const body = await readBody(c);
  if (body === 'too_large') return reply(c, 413, { error: 'payload_too_large' });
  const parsed = trackerEventSchema.safeParse(body);
  if (!parsed.success) return reply(c, 400, { error: 'invalid_event' });
  const payload = parsed.data;
  const ctx = requestContext(c);
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

  const bot = detectBot(ctx.userAgent);
  if (bot !== null) {
    const hit: BotHit = {
      site: site.siteId,
      ts: ctx.now,
      ...bot,
      path: pathOfUrl(payload.url),
      verification: verifyCrawlerIp(bot.name, ctx.ip),
    };
    await dispatch(c.env, [{ kind: 'bot', hit }]);
    return reply(c, 202, { ok: true });
  }
  const event = await enrichTrackerEvent(payload, site, ctx);
  if (event === null) return reply(c, 400, { error: 'invalid_event' });
  await dispatch(c.env, [{ kind: 'event', event }]);
  return reply(c, 202, { ok: true });
});

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
    const ctx = requestContext(c, { ip: payload.ip ?? '0.0.0.0', userAgent: payload.user_agent });
    const bot = detectBot(payload.user_agent);
    if (bot !== null) {
      messages.push({
        kind: 'bot',
        hit: {
          site: site.siteId,
          ts: ctx.now,
          ...bot,
          path: pathOfUrl(payload.url),
          verification: verifyCrawlerIp(bot.name, payload.ip),
        },
      });
    } else if (payload.type === 'pageview') {
      messages.push({ kind: 'event', event: await enrichServerEvent(payload, site, ctx) });
    }
    await dispatch(c.env, messages);
    const verification = bot === null ? null : verifyCrawlerIp(bot.name, payload.ip);
    return reply(c, 202, { ok: true, bot: bot === null ? null : { ...bot, verification } });
  }

  const ctx = requestContext(c);
  messages.push({ kind: 'event', event: await enrichServerEvent(payload, site, ctx) });
  await dispatch(c.env, messages);
  return reply(c, 202, { ok: true });
});

// ------------------------------------------------------------------ tracker script

const SCRIPT_ROUTES: ReadonlyArray<[path: string, variant: TrackerVariant]> = [
  ['/s.js', 'default'],
  ['/s.cookieless.js', 'cookieless'],
  ['/s.hash.js', 'hash'],
];

for (const [path, variant] of SCRIPT_ROUTES) {
  analyticsRoutes.get(path, (c) => {
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
  });
}
