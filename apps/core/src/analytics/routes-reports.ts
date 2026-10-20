import { z } from '@hono/zod-openapi';
import { siteIdPath } from './params';
import {
  adsReportSchema,
  analyticsInsightsParamsSchema,
  analyticsInsightsSchema,
  analyticsPurchasesParamsSchema,
  analyticsPurchasesSchema,
  analyticsQueryParamsSchema,
  analyticsRealtimeSchema,
  ATTRIBUTION_MODELS,
  attributionModelParamSchema,
  attributionQuerySchema,
  attributionReportSchema,
  botsReportSchema,
  type AttributionModel,
  contactJourneyParamsSchema,
  contactJourneySchema,
  crawlerSnippetsSchema,
  installCheckSchema,
  searchConsoleReportSchema,
  visitorProfileSchema,
  visitorsListParamsSchema,
  visitorsListSchema,
} from '@amable/api-types';
import { siteStub } from '@amable/app-edge/analytics';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { CrmError } from '../crm/errors';
import { actorOf, crmRoute, json } from '../crm/api/core';
import { getTenant, requirePermission, tenantDb, type AppEnv } from '../middleware';
import type { CrmResult } from '../crm/ops';
import type { CrmJourneyFacts } from './crm-ops';
import { contactJourney } from './journey';
import { runTenantSync } from './runtime';
import { contactLabels, edgeOrigin, namespace, rangeOf, siteForQuery, siteRecord, unwrap } from './service';
import { crawlerSnippets } from './snippets';
import { forwardRealtimeSocket } from './ws';

const tags = ['Analytics'];
const filterNote =
  'Filters: `filter_<dimension>=value` (is), `=!value` (is not), `=~value` (contains). Default range: the last 7 days.';

/** Purchases, realtime, insights, visitors, journeys, bots, ads, search, install checks. */
export function registerReportRoutes(api: OpenAPIHono<AppEnv>): void {
  api.openapi(
    crmRoute('analytics:read', {
      method: 'get',
      path: '/purchases',
      tags,
      summary: 'Purchases of the range with the buyer (avatars on the chart)',
      description: filterNote,
      request: { query: analyticsPurchasesParamsSchema },
      responses: { 200: json(analyticsPurchasesSchema, 'Purchases, newest first') },
    }),
    async (c) => {
      const params = c.req.valid('query');
      const stub = await siteForQuery(c, params.site_id);
      const result = unwrap(await stub.purchases(rangeOf(c, params), params.limit));
      const labels = await contactLabels(c, result.data.map((p) => p.contact_id));
      return c.json(
        {
          ...result,
          data: result.data.map((p) => {
            const l = p.contact_id === null ? undefined : labels.get(p.contact_id);
            return { ...p, name: p.name ?? l?.name ?? null, email: p.email ?? l?.email ?? null };
          }),
        },
        200,
      );
    },
  );

  api.openapi(
    crmRoute('analytics:read', {
      method: 'get',
      path: '/attribution',
      tags,
      summary: 'Revenue credited to channels, sources, campaigns or landing pages, per attribution model',
      description: `Models: ${ATTRIBUTION_MODELS.join(', ')} (\`models=a,b\`, default all). Touches are the sessions of the buyer (every visitor of its CRM contact) up to each payment; internal orders paid in the CRM count as payments. ${filterNote}`,
      request: { query: analyticsQueryParamsSchema.extend(attributionQuerySchema.shape) },
      responses: { 200: json(attributionReportSchema, 'Attributed revenue per value and model') },
    }),
    async (c) => {
      const params = c.req.valid('query');
      const models = (params.models ?? '')
        .split(',')
        .map((m) => m.trim())
        .filter((m): m is AttributionModel => (ATTRIBUTION_MODELS as readonly string[]).includes(m));
      const stub = await siteForQuery(c, params.site_id);
      const report = unwrap(
        await stub.attribution(rangeOf(c, params), params.dimension ?? 'channel', models, params.limit ?? 50),
      );
      return c.json(report, 200);
    },
  );

  api.openapi(
    crmRoute('analytics:read', {
      method: 'get',
      path: '/realtime',
      tags,
      summary: 'Visitors of the last 30 minutes, live events and top lists',
      request: { query: z.object({ site_id: z.string().min(1).max(64) }) },
      responses: { 200: json(analyticsRealtimeSchema, 'Realtime snapshot') },
    }),
    async (c) => {
      const stub = await siteForQuery(c, c.req.valid('query').site_id);
      const snapshot = await stub.realtime();
      if (snapshot === null) throw new CrmError('not_found', 'site not found');
      const labels = await contactLabels(c, snapshot.visitors.map((v) => v.contact_id));
      const byVisitor = new Map<string, string>();
      const visitors = snapshot.visitors.map((v) => {
        const l = v.contact_id === null ? undefined : labels.get(v.contact_id);
        const name = v.name ?? l?.name ?? l?.email ?? null;
        if (name !== null) byVisitor.set(v.visitor_id, name);
        return { ...v, name };
      });
      return c.json(
        { ...snapshot, visitors, events: snapshot.events.map((e) => ({ ...e, label: e.label ?? byVisitor.get(e.visitor_id) ?? null })) },
        200,
      );
    },
  );

  /** WebSocket (cookie session, same origin): snapshot + one message per event. */
  api.get('/realtime/ws', requirePermission('analytics:read'), async (c) => {
    const siteId = c.req.query('site_id') ?? '';
    await siteRecord(c, siteId);
    return forwardRealtimeSocket(c, siteStub(namespace(c), siteId), 'private');
  });

  api.openapi(
    crmRoute('analytics:read', {
      method: 'get',
      path: '/insights',
      tags,
      summary: 'Revenue by device / OS / browser / country, time to purchase, converting goals, heatmap',
      description: filterNote,
      request: { query: analyticsInsightsParamsSchema },
      responses: { 200: json(analyticsInsightsSchema, 'Insights') },
    }),
    async (c) => {
      const params = c.req.valid('query');
      const stub = await siteForQuery(c, params.site_id);
      return c.json(unwrap(await stub.insights(rangeOf(c, params), params.interval)), 200);
    },
  );

  api.openapi(
    crmRoute('analytics:read', {
      method: 'get',
      path: '/visitors',
      tags,
      summary: 'Visitors with a session in the range (identity, activity, revenue, prediction)',
      description: filterNote,
      request: { query: visitorsListParamsSchema },
      responses: { 200: json(visitorsListSchema, 'A page of visitors') },
    }),
    async (c) => {
      const params = c.req.valid('query');
      const stub = await siteForQuery(c, params.site_id);
      const flag = (v: 'true' | 'false' | undefined): boolean | undefined =>
        v === undefined ? undefined : v === 'true';
      const list = unwrap(
        await stub.visitors(rangeOf(c, params), {
          q: params.q,
          identified: flag(params.identified),
          customers: flag(params.customers),
          sort: params.sort,
          limit: params.limit,
          cursor: params.cursor,
        }),
      );
      const labels = await contactLabels(c, list.data.map((v) => v.contact_id));
      return c.json(
        {
          ...list,
          data: list.data.map((v) => {
            const l = v.contact_id === null ? undefined : labels.get(v.contact_id);
            return { ...v, name: v.name ?? l?.name ?? null, email: v.email ?? l?.email ?? null };
          }),
        },
        200,
      );
    },
  );

  api.openapi(
    crmRoute('analytics:read', {
      method: 'get',
      path: '/visitors/{visitorId}',
      tags,
      summary: 'Visitor profile and journey (all visitors of the same contact merged)',
      request: {
        params: z.object({ visitorId: z.string().min(1).max(80) }),
        query: z.object({ site_id: z.string().min(1).max(64) }),
      },
      responses: { 200: json(visitorProfileSchema, 'Profile') },
    }),
    async (c) => {
      const stub = await siteForQuery(c, c.req.valid('query').site_id);
      const profile = await stub.visitorProfile(c.req.valid('param').visitorId);
      if (profile === null) throw new CrmError('not_found', 'visitor not found');
      const labels = await contactLabels(c, [profile.visitor.contact_id, ...profile.payments.map((p) => p.contact_id)]);
      const l = profile.visitor.contact_id === null ? undefined : labels.get(profile.visitor.contact_id);
      return c.json(
        {
          ...profile,
          visitor: { ...profile.visitor, name: profile.visitor.name ?? l?.name ?? null, email: profile.visitor.email ?? l?.email ?? null },
          payments: profile.payments.map((p) => ({ ...p, name: p.name ?? l?.name ?? null, email: p.email ?? l?.email ?? null })),
        },
        200,
      );
    },
  );

  api.openapi(
    crmRoute('analytics:journey_read', {
      method: 'get',
      path: '/contacts/{contactId}/journey',
      tags,
      summary: 'Web journey of a CRM contact across sites, with orders, emails, forms and bookings',
      request: { params: z.object({ contactId: z.string().min(1).max(64) }), query: contactJourneyParamsSchema },
      responses: { 200: json(contactJourneySchema, 'Journey') },
    }),
    async (c) => {
      const { contactId } = c.req.valid('param');
      const { limit } = c.req.valid('query');
      const tenantId = getTenant(c).tenant.id;
      const ns = namespace(c);
      // Pending identities / CRM events first, so a just-submitted form already shows up.
      await runTenantSync(c.env, tenantId);
      const facts = (await tenantDb(c).crm('analytics.contactJourneyFacts', actorOf(c), {
        contactId,
        limit,
      })) as CrmResult<CrmJourneyFacts>;
      if (!facts.ok) throw new CrmError('validation_failed', facts.error.message);
      if (!facts.value.exists) throw new CrmError('not_found', 'contact not found');
      return c.json(await contactJourney(ns, tenantId, contactId, facts.value, limit), 200);
    },
  );

  api.openapi(
    crmRoute('analytics:read', {
      method: 'get',
      path: '/bots',
      tags,
      summary: 'Bot and AI crawler traffic (AI answers, training, indexing) with IP verification',
      request: { query: analyticsQueryParamsSchema },
      responses: { 200: json(botsReportSchema, 'Bots report') },
    }),
    async (c) => {
      const params = c.req.valid('query');
      const stub = await siteForQuery(c, params.site_id);
      return c.json(unwrap(await stub.bots(rangeOf(c, params))), 200);
    },
  );

  api.openapi(
    crmRoute('analytics:read', {
      method: 'get',
      path: '/ads',
      tags,
      summary: 'Ad spend per campaign matched on utm_campaign, attributed revenue and ROAS',
      request: { query: analyticsQueryParamsSchema.extend(attributionModelParamSchema.shape) },
      responses: { 200: json(adsReportSchema, 'Ads report') },
    }),
    async (c) => {
      const params = c.req.valid('query');
      const stub = await siteForQuery(c, params.site_id);
      return c.json(unwrap(await stub.ads(rangeOf(c, params), params.model)), 200);
    },
  );

  api.openapi(
    crmRoute('analytics:read', {
      method: 'get',
      path: '/search-console',
      tags,
      summary: 'Organic search queries and pages (clicks, impressions, CTR, position)',
      request: { query: analyticsQueryParamsSchema },
      responses: { 200: json(searchConsoleReportSchema, 'Search report') },
    }),
    async (c) => {
      const params = c.req.valid('query');
      const stub = await siteForQuery(c, params.site_id);
      return c.json(unwrap(await stub.searchConsole(rangeOf(c, params))), 200);
    },
  );

  api.openapi(
    crmRoute('analytics:read', {
      method: 'get',
      path: '/sites/{siteId}/install-check',
      tags,
      summary: 'Whether the tracker is sending events (last event, events in 24 h)',
      request: { params: siteIdPath },
      responses: { 200: json(installCheckSchema, 'Install check') },
    }),
    async (c) => {
      const { siteId } = c.req.valid('param');
      await siteRecord(c, siteId);
      const check = await siteStub(namespace(c), siteId).installCheck();
      if (check === null) throw new CrmError('not_found', 'site not found');
      return c.json(check, 200);
    },
  );

  api.openapi(
    crmRoute('analytics:read', {
      method: 'get',
      path: '/sites/{siteId}/crawler-snippets',
      tags,
      summary: 'Server-side snippets (Worker, Node, PHP) reporting AI crawlers to /e/server',
      request: { params: siteIdPath },
      responses: { 200: json(crawlerSnippetsSchema, 'Snippets') },
    }),
    async (c) => {
      await siteRecord(c, c.req.valid('param').siteId);
      return c.json(crawlerSnippets(`${edgeOrigin(c)}/e/server`), 200);
    },
  );
}
