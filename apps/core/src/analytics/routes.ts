import { z } from '@hono/zod-openapi';
import {
  ANALYTICS_BREAKDOWN_DIMENSIONS,
  analyticsBreakdownParamsSchema,
  analyticsBreakdownSchema,
  analyticsOverviewSchema,
  analyticsQueryParamsSchema,
  analyticsTimeseriesParamsSchema,
  analyticsTimeseriesSchema,
  createSiteSchema,
  siteSchema,
  siteSnippetSchema,
  siteWithSecretSchema,
  updateSiteSchema,
} from '@amable/api-types';
import type { Hono, MiddlewareHandler } from 'hono';
import { createCrmRouter, crmRoute, json, jsonBody } from '../crm/api/core';
import { audit, getTenant, requireAuth, requireTenant, type AppEnv } from '../middleware';
import { publicAnalyticsApi, siteKeyApi } from './public';
import { registerAdsRoutes } from './routes-ads';
import { registerAdsReportRoutes } from './routes-ads-reports';
import { registerConfigRoutes } from './routes-config';
import { registerFunnelRoutes } from './routes-funnels';
import { registerOutboundRoutes } from './routes-outbound';
import { registerSourceRoutes } from './routes-sources';
import { registerReportRoutes } from './routes-reports';
import { registerTrackingDomainRoutes, removeSiteTrackingDomains } from './routes-tracking-domains';
import { siteStub } from '@amable/app-edge/analytics';
import { generateTraffic, liveTraffic } from './dev-traffic';
import { FunnelDemoError, generateFunnelDemo } from './dev-funnel-demo';
import { syncIntegration } from './integrations';
import { integrationsFor, runTenantSync, syncPorts } from './runtime';
import {
  createSite,
  deleteSite,
  edgeUnreachableAs503,
  getSite,
  listSites,
  rangeOf,
  rollSecret,
  siteForQuery,
  siteSnippet,
  unwrap,
  updateSite,
} from './service';

const siteIdParam = z.object({ siteId: z.string().min(1).max(64) });
const tags = ['Analytics'];

/** Web analytics REST v2, relative to `/api/v2/t/{slug}/analytics`. */
export const analyticsApi = createCrmRouter();
analyticsApi.use('*', edgeUnreachableAs503());

// ------------------------------------------------------------------- sites

analyticsApi.openapi(
  crmRoute('analytics:read', {
    method: 'get',
    path: '/sites',
    tags,
    summary: 'List tracked sites',
    responses: { 200: json(z.object({ data: z.array(siteSchema) }), 'Sites of the tenant') },
  }),
  async (c) => c.json({ data: await listSites(c) }, 200),
);

analyticsApi.openapi(
  crmRoute('analytics:configure', {
    method: 'post',
    path: '/sites',
    tags,
    summary: 'Create a site (returns its secret once and the tracking snippet)',
    request: { body: jsonBody(createSiteSchema) },
    responses: { 201: json(siteWithSecretSchema, 'The site, its server secret and snippet') },
  }),
  async (c) => {
    const created = await createSite(c, c.req.valid('json'));
    await audit(c, 'analytics.site_created', {
      target: created.site.id,
      details: { name: created.site.name },
    });
    return c.json(created, 201);
  },
);

analyticsApi.openapi(
  crmRoute('analytics:read', {
    method: 'get',
    path: '/sites/{siteId}',
    tags,
    summary: 'Get a site',
    request: { params: siteIdParam },
    responses: { 200: json(siteSchema, 'The site') },
  }),
  async (c) => c.json(await getSite(c, c.req.valid('param').siteId), 200),
);

analyticsApi.openapi(
  crmRoute('analytics:configure', {
    method: 'patch',
    path: '/sites/{siteId}',
    tags,
    summary: 'Update a site',
    request: { params: siteIdParam, body: jsonBody(updateSiteSchema) },
    responses: { 200: json(siteSchema, 'The site') },
  }),
  async (c) => {
    const { siteId } = c.req.valid('param');
    const site = await updateSite(c, siteId, c.req.valid('json'));
    await audit(c, 'analytics.site_updated', { target: siteId });
    return c.json(site, 200);
  },
);

analyticsApi.openapi(
  crmRoute('analytics:configure', {
    method: 'delete',
    path: '/sites/{siteId}',
    tags,
    summary: 'Delete a site (ingest stops; raw data follows the retention)',
    request: { params: siteIdParam },
    responses: { 200: json(z.object({ id: z.string(), deleted: z.literal(true) }), 'Deleted') },
  }),
  async (c) => {
    const { siteId } = c.req.valid('param');
    await deleteSite(c, siteId);
    await removeSiteTrackingDomains(c.env, getTenant(c).tenant.id, siteId, c.get('services').now());
    await audit(c, 'analytics.site_deleted', { target: siteId });
    return c.json({ id: siteId, deleted: true as const }, 200);
  },
);

analyticsApi.openapi(
  crmRoute('analytics:configure', {
    method: 'post',
    path: '/sites/{siteId}/secret',
    tags,
    summary: 'Roll the server secret of a site',
    request: { params: siteIdParam },
    responses: { 200: json(z.object({ secret: z.string() }), 'The new secret (shown once)') },
  }, { stepUp: true }),
  async (c) => {
    const { siteId } = c.req.valid('param');
    const secret = await rollSecret(c, siteId);
    await audit(c, 'analytics.site_secret_rolled', { target: siteId });
    return c.json({ secret }, 200);
  },
);

analyticsApi.openapi(
  crmRoute('analytics:read', {
    method: 'get',
    path: '/sites/{siteId}/snippet',
    tags,
    summary: 'Tracking snippet of a site',
    request: { params: siteIdParam },
    responses: { 200: json(siteSnippetSchema, 'Snippet and script URLs') },
  }),
  async (c) => c.json(await siteSnippet(c, c.req.valid('param').siteId), 200),
);

// ----------------------------------------------------------------- queries

const filterNote =
  'Filters: `filter_<dimension>=value` (is), `=!value` (is not), `=~value` (contains). Dates are local days in `timezone` (default: the site time zone); default range: the last 7 days.';

analyticsApi.openapi(
  crmRoute('analytics:read', {
    method: 'get',
    path: '/overview',
    tags,
    summary: 'KPIs of a site over a range',
    description: filterNote,
    request: { query: analyticsQueryParamsSchema },
    responses: { 200: json(analyticsOverviewSchema, 'Overview') },
  }),
  async (c) => {
    const params = c.req.valid('query');
    const stub = await siteForQuery(c, params.site_id);
    return c.json(unwrap(await stub.overview(rangeOf(c, params))), 200);
  },
);

analyticsApi.openapi(
  crmRoute('analytics:read', {
    method: 'get',
    path: '/timeseries',
    tags,
    summary: 'Visitors, sessions, pageviews, goals and revenue per interval',
    description: filterNote,
    request: { query: analyticsTimeseriesParamsSchema },
    responses: { 200: json(analyticsTimeseriesSchema, 'Time series') },
  }),
  async (c) => {
    const params = c.req.valid('query');
    const stub = await siteForQuery(c, params.site_id);
    return c.json(unwrap(await stub.timeseries(rangeOf(c, params), params.interval)), 200);
  },
);

analyticsApi.openapi(
  crmRoute('analytics:read', {
    method: 'get',
    path: '/breakdown/{dimension}',
    tags,
    summary:
      'Top values of a dimension (pages, referrers, channels, campaigns, geo, devices, goals, bots, …)',
    description: filterNote,
    request: {
      params: z.object({ dimension: z.enum(ANALYTICS_BREAKDOWN_DIMENSIONS) }),
      query: analyticsBreakdownParamsSchema,
    },
    responses: { 200: json(analyticsBreakdownSchema, 'Breakdown') },
  }),
  async (c) => {
    const params = c.req.valid('query');
    const { dimension } = c.req.valid('param');
    const stub = await siteForQuery(c, params.site_id);
    return c.json(
      unwrap(await stub.breakdown(rangeOf(c, params), dimension, params.limit, params.model)),
      200,
    );
  },
);

registerReportRoutes(analyticsApi);
registerConfigRoutes(analyticsApi);
registerFunnelRoutes(analyticsApi);
registerSourceRoutes(analyticsApi);
registerOutboundRoutes(analyticsApi);
registerTrackingDomainRoutes(analyticsApi);
registerAdsRoutes(analyticsApi);
registerAdsReportRoutes(analyticsApi);

/** OpenAPI 3.1 document of the analytics endpoints. */
export function analyticsOpenApiDocument(): ReturnType<typeof analyticsApi.getOpenAPI31Document> {
  return analyticsApi.getOpenAPI31Document({
    openapi: '3.1.0',
    info: { title: 'amabledata analytics API', version: '2.0.0' },
    servers: [{ url: '/api/v2/t/{slug}/analytics', variables: { slug: { default: 'demo' } } }],
  });
}

/**
 * Mounts `/api/v2/t/:slug/analytics/*` (central guards: session or API key, then
 * membership + role; each route adds its permission) and the public
 * `/api/v2/openapi/analytics.json`.
 */
export function mountAnalyticsApi(app: Hono<AppEnv>): void {
  const auth = requireAuth({ apiKey: true });
  const tenant = requireTenant();
  // The CRM mount may already have run the same guards for /v2/t/:slug/*.
  app.use('/v2/t/:slug/analytics/*', (c, next) =>
    c.get('auth') === undefined ? auth(c, next) : next(),
  );
  app.use('/v2/t/:slug/analytics/*', (c, next) =>
    c.get('tenant') === undefined ? tenant(c, next) : next(),
  );
  app.route('/v2/t/:slug/analytics', analyticsApi);
  app.get('/v2/openapi/analytics.json', (c) => c.json(analyticsOpenApiDocument()));
  // Site-key analytics API (no session, no tenant slug: the key names the site).
  app.route('/v2/analytics', siteKeyApi);
  // Read-only public dashboards of share links.
  app.route('/public/analytics', publicAnalyticsApi);
  mountAnalyticsDevRoutes(app);
}

/**
 * Dev-only (ENVIRONMENT=dev, `scripts/analytics-traffic.mjs`): fake traffic for
 * the demo tenant, the demo funnel with its click-log and fake ad data, live
 * visitors for the realtime view, a forced CRM sync.
 */
function mountAnalyticsDevRoutes(app: Hono<AppEnv>): void {
  const tenantOf = async (env: AppEnv['Bindings'], slug: string) =>
    env.DB.prepare(`SELECT id FROM tenants WHERE slug = ?`).bind(slug).first<{ id: string }>();
  app.use('/dev/analytics/*', edgeUnreachableAs503());

  app.post('/dev/analytics/traffic', async (c) => {
    if (c.env.ENVIRONMENT !== 'dev' || c.env.ANALYTICS === undefined) return c.notFound();
    const tenant = await tenantOf(c.env, c.req.query('tenant') ?? 'demo');
    if (tenant === null) return c.json({ error: 'tenant_not_found' }, 404);
    const ns = c.env.ANALYTICS;
    const ports = syncPorts(c.env, ns, tenant.id);
    const now = Date.now();
    // CRM events first, so the seeded orders are known before visitors get identified.
    await runTenantSync(c.env, tenant.id);
    const report = await generateTraffic(
      c.env,
      ns,
      tenant.id,
      {
        days: Math.min(Math.max(Number(c.req.query('days') ?? '30'), 1), 120),
        perDay: Math.min(Math.max(Number(c.req.query('per_day') ?? '220'), 10), 3000),
        seed: c.req.query('seed') ?? 'amable-demo',
        now,
      },
      ports.crm,
    );
    // Identities → links, then the outbox again (payments find their visitors).
    await runTenantSync(c.env, tenant.id);
    await runTenantSync(c.env, tenant.id);
    const site = siteStub(ns, report.siteId);
    if ((await site.listFunnels()).length === 0) {
      await site.createFunnel({
        name: 'Pricing → signup',
        steps: [
          { type: 'pageview', value: '/', match: 'exact' },
          { type: 'pageview', value: '/pricing', match: 'exact' },
          { type: 'pageview', value: '/signup', match: 'exact' },
          { type: 'goal', value: 'signup', match: 'exact' },
        ],
      });
      await site.createFunnel({
        name: 'Blog → newsletter',
        steps: [
          { type: 'pageview', value: '/blog/', match: 'contains' },
          { type: 'goal', value: 'newsletter_signup', match: 'exact' },
        ],
      });
      await site.createSegment({ name: 'Italy · mobile', filters: [{ dimension: 'country', op: 'is', value: 'IT' }, { dimension: 'device', op: 'is', value: 'mobile' }] });
      await site.createSegment({ name: 'Paid traffic', filters: [{ dimension: 'channel', op: 'contains', value: 'Paid' }] });
      await site.createAlert({ name: 'New signups', goal: 'signup', enabled: true, email_recipients: ['admin@example.com'], webhook_url: null }, null);
      await site.createShare('Investors (read-only)');
      const integrations = integrationsFor(c.env);
      for (const provider of ['meta_ads', 'search_console'] as const) {
        await site.saveIntegration({
          provider,
          status: 'connected',
          account_id: `dev-${provider}`,
          account_name: provider === 'meta_ads' ? 'Development ad account' : 'sc-domain:example.com (development)',
          connected_at: now,
          last_sync_at: null,
          last_error: null,
        });
        await syncIntegration(ns, report.siteId, provider, integrations, now);
      }
    }
    const prediction = await site.trainPrediction();
    return c.json({ ok: true, ...report, prediction });
  });

  app.post('/dev/analytics/funnel-demo', async (c) => {
    if (c.env.ENVIRONMENT !== 'dev' || c.env.ANALYTICS === undefined) return c.notFound();
    const slug = c.req.query('tenant') ?? 'demo';
    const tenant = await tenantOf(c.env, slug);
    if (tenant === null) return c.json({ error: 'tenant_not_found' }, 404);
    try {
      const report = await generateFunnelDemo(c.env, c.env.ANALYTICS, { id: tenant.id, slug }, {
        days: Math.min(Math.max(Number(c.req.query('days') ?? '30'), 1), 90),
        visitors: Math.min(Math.max(Number(c.req.query('visitors') ?? '400'), 1), 5000),
        seed: c.req.query('seed') ?? 'amable-demo',
        now: Date.now(),
      });
      return c.json({ ok: true, ...report });
    } catch (error) {
      if (error instanceof FunnelDemoError) return c.json({ error: 'no_site', message: error.message }, 409);
      throw error;
    }
  });

  app.post('/dev/analytics/live', async (c) => {
    if (c.env.ENVIRONMENT !== 'dev' || c.env.ANALYTICS === undefined) return c.notFound();
    const tenant = await tenantOf(c.env, c.req.query('tenant') ?? 'demo');
    if (tenant === null) return c.json({ error: 'tenant_not_found' }, 404);
    const count = Math.min(Math.max(Number(c.req.query('count') ?? '6'), 1), 50);
    return c.json({ ok: true, events: await liveTraffic(c.env.ANALYTICS, tenant.id, Date.now(), count) });
  });

  app.post('/dev/analytics/sync', async (c) => {
    if (c.env.ENVIRONMENT !== 'dev') return c.notFound();
    const tenant = await tenantOf(c.env, c.req.query('tenant') ?? 'demo');
    if (tenant === null) return c.json({ error: 'tenant_not_found' }, 404);
    return c.json({ ok: true, report: await runTenantSync(c.env, tenant.id) });
  });
}

/**
 * Registered in app.ts before the CRM mount (middleware only runs for routes
 * registered after it). After every successful mutating v2 request of a tenant (orders, payments,
 * form submissions, contact merges…): CRM → analytics sync in the background.
 */
export function analyticsKick(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.res.status >= 400) return;
    const tenant = c.get('tenant');
    if (tenant === undefined || c.env.ANALYTICS === undefined) return;
    try {
      c.executionCtx.waitUntil(runTenantSync(c.env, tenant.tenant.id));
    } catch {
      // No execution context (tests): the cron pass picks the events up.
    }
  };
}
