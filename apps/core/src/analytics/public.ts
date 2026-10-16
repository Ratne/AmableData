import {
  ANALYTICS_BREAKDOWN_DIMENSIONS,
  ANALYTICS_INTERVALS,
  ATTRIBUTION_MODELS,
  VISITOR_SORTS,
  analyticsQueryParamsSchema,
  apiGoalSchema,
  apiIdentifySchema,
  apiPaymentSchema,
  type AnalyticsBreakdownDimension,
  type AnalyticsInterval,
  type AttributionModel,
  type PublicShareInfo,
  type ServerEvent,
  type SiteKeyScope,
} from '@amable/api-types';
import {
  enrichServerEvent,
  siteIdOfSiteKey,
  siteStub,
  type AnalyticsDO,
  type SiteRecord,
} from '@amable/app-edge/analytics';
import type { Context, MiddlewareHandler } from 'hono';
import { createCrmRouter } from '../crm/api/core';
import { CrmError } from '../crm/errors';
import { HttpError, type AppEnv } from '../middleware';
import { shareSecret } from './runtime';
import { edgeUnreachableAs503, parseFilters, sha256Hex, unwrap } from './service';
import { verifyShareToken } from './share';
import { forwardRealtimeSocket } from './ws';

/**
 * Analytics surfaces without a user session:
 *
 * - `/api/public/analytics/{token}/…` — read-only public dashboard of a share
 *   link (aggregates only: no identities, no visitor profiles, no settings);
 * - `/api/v2/analytics/…` — the analytics API for **site keys**
 *   (`Authorization: Bearer amb_ak_<siteId>.<secret>`, scopes `read` / `write`),
 *   bound to one site. Account-wide access uses regular tenant API keys
 *   (`amb_live_…` with `analytics:read`) on `/api/v2/t/{slug}/analytics/…`.
 */

type Ctx = Context<AppEnv>;
type Stub = DurableObjectStub<AnalyticsDO>;

const WEEK_MS = 7 * 86_400_000;

function ns(c: Ctx) {
  const namespace = c.env.ANALYTICS;
  if (namespace === undefined) throw new HttpError(503, 'analytics_unavailable');
  return namespace;
}

/** Range from the query string (same rules as the tenant API). */
function rangeFrom(c: Ctx) {
  const parsed = analyticsQueryParamsSchema.omit({ site_id: true }).safeParse(c.req.query());
  if (!parsed.success) throw new CrmError('validation_failed', parsed.error.issues[0]?.message ?? 'invalid query');
  const now = c.get('services').now();
  const query: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(c.req.queries())) query[k] = v.length === 1 ? (v[0] ?? '') : v;
  return {
    from: parsed.data.from ?? new Date(now - WEEK_MS).toISOString(),
    to: parsed.data.to ?? new Date(now).toISOString(),
    ...(parsed.data.timezone === undefined ? {} : { timezone: parsed.data.timezone }),
    filters: parseFilters(query),
  };
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  if (value === undefined || value === '') return fallback;
  if (!(allowed as readonly string[]).includes(value)) throw new CrmError('validation_failed', `invalid value "${value}"`);
  return value as T;
}

function intParam(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new CrmError('validation_failed', 'invalid limit');
  return n;
}

// ------------------------------------------------------------- share links

async function shareSite(c: Ctx): Promise<{ stub: Stub; record: SiteRecord; shareName: string }> {
  const payload = await verifyShareToken(shareSecret(c.env), c.req.param('token') ?? '');
  if (payload === null) throw new CrmError('not_found', 'share link not found');
  const stub = siteStub(ns(c), payload.s);
  const share = await stub.useShare(payload.i);
  const record = await stub.getSite();
  if (share === null || record === null || record.deleted) throw new CrmError('not_found', 'share link not found');
  return { stub, record, shareName: share.name };
}

export const publicAnalyticsApi = createCrmRouter();
publicAnalyticsApi.use('*', edgeUnreachableAs503());

publicAnalyticsApi.get('/:token', async (c) => {
  const { record, shareName } = await shareSite(c);
  const info: PublicShareInfo = {
    share: { name: shareName },
    site: { name: record.site.name, timezone: record.site.timezone, currency: record.site.currency },
  };
  return c.json(info, 200);
});

publicAnalyticsApi.get('/:token/overview', async (c) => {
  const { stub } = await shareSite(c);
  return c.json(unwrap(await stub.overview(rangeFrom(c))), 200);
});

publicAnalyticsApi.get('/:token/timeseries', async (c) => {
  const { stub } = await shareSite(c);
  const interval = oneOf<AnalyticsInterval>(c.req.query('interval'), ANALYTICS_INTERVALS, 'day');
  return c.json(unwrap(await stub.timeseries(rangeFrom(c), interval)), 200);
});

publicAnalyticsApi.get('/:token/breakdown/:dimension', async (c) => {
  const { stub } = await shareSite(c);
  const dimension = oneOf<AnalyticsBreakdownDimension>(c.req.param('dimension'), ANALYTICS_BREAKDOWN_DIMENSIONS, 'page');
  const model = oneOf<AttributionModel>(c.req.query('model'), ATTRIBUTION_MODELS, 'last_non_direct');
  return c.json(
    unwrap(await stub.breakdown(rangeFrom(c), dimension, intParam(c.req.query('limit'), 50, 200), model)),
    200,
  );
});

publicAnalyticsApi.get('/:token/purchases', async (c) => {
  const { stub } = await shareSite(c);
  return c.json(unwrap(await stub.purchases(rangeFrom(c), intParam(c.req.query('limit'), 200, 500), true)), 200);
});

publicAnalyticsApi.get('/:token/realtime', async (c) => {
  const { stub } = await shareSite(c);
  const snapshot = await stub.realtime();
  if (snapshot === null) throw new CrmError('not_found', 'share link not found');
  return c.json(
    {
      ...snapshot,
      visitors: snapshot.visitors.map((v) => ({ ...v, name: null, contact_id: null })),
      events: snapshot.events.map((e) => ({ ...e, label: null })),
    },
    200,
  );
});

publicAnalyticsApi.get('/:token/realtime/ws', async (c) => {
  const { stub } = await shareSite(c);
  return forwardRealtimeSocket(c, stub, 'public');
});

// --------------------------------------------------------------- site keys

interface SiteKeyContext {
  siteId: string;
  scopes: readonly SiteKeyScope[];
}

const keys = new WeakMap<Request, SiteKeyContext>();

function siteKeyAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const match = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '');
    const token = match?.[1] ?? '';
    const siteId = siteIdOfSiteKey(token);
    if (siteId === null) return c.json({ error: 'invalid_site_key' }, 401);
    const scopes = await siteStub(ns(c), siteId).verifySiteKey(await sha256Hex(token));
    if (scopes === null) return c.json({ error: 'invalid_site_key' }, 401);
    keys.set(c.req.raw, { siteId, scopes });
    return next();
  };
}

function keyOf(c: Ctx, scope: SiteKeyScope): { stub: Stub; siteId: string } {
  const key = keys.get(c.req.raw);
  if (key === undefined) throw new HttpError(401, 'invalid_site_key');
  if (!key.scopes.includes(scope)) throw new HttpError(403, 'forbidden', { missing: [`site_key:${scope}`] });
  return { stub: siteStub(ns(c), key.siteId), siteId: key.siteId };
}

export const siteKeyApi = createCrmRouter();
siteKeyApi.use('*', edgeUnreachableAs503());
siteKeyApi.use('*', siteKeyAuth());

siteKeyApi.get('/overview', async (c) => c.json(unwrap(await keyOf(c, 'read').stub.overview(rangeFrom(c))), 200));

siteKeyApi.get('/timeseries', async (c) => {
  const interval = oneOf<AnalyticsInterval>(c.req.query('interval'), ANALYTICS_INTERVALS, 'day');
  return c.json(unwrap(await keyOf(c, 'read').stub.timeseries(rangeFrom(c), interval)), 200);
});

siteKeyApi.get('/breakdown/:dimension', async (c) => {
  const dimension = oneOf<AnalyticsBreakdownDimension>(c.req.param('dimension'), ANALYTICS_BREAKDOWN_DIMENSIONS, 'page');
  const model = c.req.query('model');
  const { stub } = keyOf(c, 'read');
  return c.json(
    unwrap(
      await stub.breakdown(
        rangeFrom(c),
        dimension,
        intParam(c.req.query('limit'), 50, 1000),
        model === undefined ? undefined : oneOf<AttributionModel>(model, ATTRIBUTION_MODELS, 'last_non_direct'),
      ),
    ),
    200,
  );
});

siteKeyApi.get('/goals', async (c) =>
  c.json(unwrap(await keyOf(c, 'read').stub.breakdown(rangeFrom(c), 'goal', intParam(c.req.query('limit'), 50, 1000))), 200),
);

siteKeyApi.get('/realtime', async (c) => {
  const snapshot = await keyOf(c, 'read').stub.realtime();
  if (snapshot === null) throw new CrmError('not_found', 'site not found');
  return c.json(snapshot, 200);
});

siteKeyApi.get('/insights', async (c) => {
  const interval = oneOf(c.req.query('interval'), ['week', 'month'] as const, 'week');
  return c.json(unwrap(await keyOf(c, 'read').stub.insights(rangeFrom(c), interval)), 200);
});

siteKeyApi.get('/purchases', async (c) =>
  c.json(unwrap(await keyOf(c, 'read').stub.purchases(rangeFrom(c), intParam(c.req.query('limit'), 200, 500))), 200),
);

siteKeyApi.get('/visitors', async (c) => {
  const flag = (v: string | undefined): boolean | undefined => (v === undefined ? undefined : v === 'true');
  return c.json(
    unwrap(
      await keyOf(c, 'read').stub.visitors(rangeFrom(c), {
        q: c.req.query('q'),
        identified: flag(c.req.query('identified')),
        customers: flag(c.req.query('customers')),
        sort: oneOf(c.req.query('sort'), VISITOR_SORTS, 'last_seen'),
        limit: intParam(c.req.query('limit'), 50, 200),
        cursor: c.req.query('cursor'),
      }),
    ),
    200,
  );
});

siteKeyApi.get('/visitors/:visitorId', async (c) => {
  const profile = await keyOf(c, 'read').stub.visitorProfile(c.req.param('visitorId'));
  if (profile === null) throw new CrmError('not_found', 'visitor not found');
  return c.json(profile, 200);
});

siteKeyApi.get('/funnels', async (c) => c.json({ data: await keyOf(c, 'read').stub.listFunnels() }, 200));

siteKeyApi.get('/funnels/:id', async (c) => {
  const { stub } = keyOf(c, 'read');
  return c.json(unwrap(await stub.funnelResult(c.req.param('id'), rangeFrom(c))), 200);
});

async function ingestServerEvent(c: Ctx, event: Exclude<ServerEvent, { type: 'crawler' | 'pageview' }>) {
  const { stub } = keyOf(c, 'write');
  const config = await stub.edgeConfig();
  if (config === null) throw new CrmError('not_found', 'site not found');
  const enriched = await enrichServerEvent(event, config, {
    eid: crypto.randomUUID(),
    now: c.get('services').now(),
    ip: '0.0.0.0',
    userAgent: '',
    geo: { country: null, region: null, city: null, latitude: null, longitude: null },
  });
  await stub.ingest([enriched], []);
  return c.json({ ok: true as const }, 202);
}

async function body(c: Ctx): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new CrmError('validation_failed', 'invalid JSON body');
  }
}

function parsed<T>(result: { success: true; data: T } | { success: false; error: { issues: Array<{ message: string }> } }): T {
  if (!result.success) throw new CrmError('validation_failed', result.error.issues[0]?.message ?? 'invalid body');
  return result.data;
}

siteKeyApi.post('/goals', async (c) => {
  const input = parsed(apiGoalSchema.safeParse(await body(c)));
  return ingestServerEvent(c, { type: 'goal', visitor_id: input.visitor_id, name: input.name, ...(input.params ? { params: input.params } : {}) });
});

siteKeyApi.post('/identify', async (c) => {
  const input = parsed(apiIdentifySchema.safeParse(await body(c)));
  return ingestServerEvent(c, { type: 'identify', ...input });
});

siteKeyApi.post('/payments', async (c) => {
  const input = parsed(apiPaymentSchema.safeParse(await body(c)));
  return ingestServerEvent(c, { type: 'payment', ...input, currency: input.currency.toUpperCase() });
});
