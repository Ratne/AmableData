import { z } from '@hono/zod-openapi';
import { idParam, siteQuery } from './params';
import {
  INTEGRATION_PROVIDERS,
  alertSchema,
  alertWithSecretSchema,
  analyticsQueryParamsSchema,
  createAlertSchema,
  createFunnelSchema,
  createSegmentSchema,
  createShareSchema,
  createSiteKeySchema,
  funnelResultSchema,
  funnelSchema,
  integrationCallbackSchema,
  integrationConnectSchema,
  integrationSchema,
  predictionModelSchema,
  segmentSchema,
  shareSchema,
  siteKeySchema,
  siteKeyWithSecretSchema,
  updateAlertSchema,
  updateFunnelSchema,
  updateSegmentSchema,
  type Share,
} from '@amable/api-types';
import { siteStub, type ShareRow } from '@amable/app-edge/analytics';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { crmRoute, json, jsonBody } from '../crm/api/core';
import { CrmError } from '../crm/errors';
import { appOrigin as requestAppOrigin, audit, getTenant, HttpError, type AppEnv } from '../middleware';
import { syncIntegration, toIntegration } from './integrations';
import { integrationsFor, shareSecret } from './runtime';
import {
  createSiteKey,
  namespace,
  rangeOf,
  siteIdParam,
  siteRecord,
  unwrap,
} from './service';
import { signShareToken } from './share';

const tags = ['Analytics'];
const ok = z.object({ id: z.string(), deleted: z.literal(true) });
const SAVED_VIEW_WRITERS = ['analytics:configure', 'reports:create'] as const;

type Ctx = Context<AppEnv>;

async function siteOf(c: Ctx) {
  const siteId = siteIdParam(c);
  const record = await siteRecord(c, siteId);
  return { siteId, record, stub: siteStub(namespace(c), siteId) };
}

function randomSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `whsec_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

async function shareOut(c: Ctx, siteId: string, row: ShareRow): Promise<Share> {
  const token = await signShareToken(shareSecret(c.env), siteId, row.id);
  return {
    id: row.id,
    name: row.name,
    url: `${requestAppOrigin(c).replace(/\/+$/, '')}/share/${token}`,
    created_at: new Date(row.created_at).toISOString(),
    revoked_at: row.revoked_at === null ? null : new Date(row.revoked_at).toISOString(),
    last_used_at: row.last_used_at === null ? null : new Date(row.last_used_at).toISOString(),
  };
}

/** Recipients must be members of the tenant (alerts are team notifications). */
async function assertMembers(c: Ctx, emails: readonly string[]): Promise<void> {
  if (emails.length === 0) return;
  const rows = await c.env.DB.prepare(
    `SELECT lower(u.email) AS email FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.tenant_id = ?`,
  )
    .bind(getTenant(c).tenant.id)
    .all<{ email: string }>();
  const members = new Set(rows.results.map((r) => r.email));
  const outside = emails.filter((e) => !members.has(e.toLowerCase()));
  if (outside.length > 0) {
    throw new CrmError('validation_failed', `not a member of this workspace: ${outside.join(', ')}`);
  }
}

type SiteStub = ReturnType<typeof siteStub>;

/**
 * List / create / (get) / update / delete of a site's saved view (funnels, segments):
 * readable with analytics:read, writable with any of SAVED_VIEW_WRITERS.
 */
function savedViewRoutes<C extends z.ZodType, U extends z.ZodType>(
  api: OpenAPIHono<AppEnv>,
  view: {
    path: `/${string}`;
    noun: string;
    schema: z.ZodType;
    createSchema: C;
    updateSchema: U;
    summaries: { list: string; create: string; get?: string; update: string; remove: string };
    list: (stub: SiteStub) => Promise<unknown[]>;
    create: (stub: SiteStub, input: z.output<C>) => Promise<unknown>;
    get?: (stub: SiteStub, id: string) => Promise<unknown>;
    update: (stub: SiteStub, id: string, patch: z.output<U>) => Promise<unknown>;
    remove: (stub: SiteStub, id: string) => Promise<boolean>;
  },
): void {
  const createBody: z.ZodType = view.createSchema;
  const updateBody: z.ZodType = view.updateSchema;
  const label = view.noun[0]!.toUpperCase() + view.noun.slice(1);
  const notFound = () => new CrmError('not_found', `${view.noun} not found`);
  const writers = { anyOf: SAVED_VIEW_WRITERS };
  api.openapi(
    crmRoute('analytics:read', {
      method: 'get',
      path: view.path,
      tags,
      summary: view.summaries.list,
      request: { query: siteQuery },
      responses: { 200: json(z.object({ data: z.array(view.schema) }), `${label}s`) },
    }),
    async (c) => c.json({ data: await view.list((await siteOf(c)).stub) }, 200),
  );
  api.openapi(
    crmRoute('analytics:read', {
      method: 'post',
      path: view.path,
      tags,
      summary: view.summaries.create,
      request: { query: siteQuery, body: jsonBody(createBody) },
      responses: { 201: json(view.schema, label) },
    }, writers),
    async (c) => c.json(await view.create((await siteOf(c)).stub, c.req.valid('json') as z.output<C>), 201),
  );
  const get = view.get;
  if (get !== undefined) {
    api.openapi(
      crmRoute('analytics:read', {
        method: 'get',
        path: `${view.path}/{id}`,
        tags,
        summary: view.summaries.get ?? `Get a ${view.noun}`,
        request: { params: idParam, query: siteQuery },
        responses: { 200: json(view.schema, label) },
      }),
      async (c) => {
        const row = await get((await siteOf(c)).stub, c.req.valid('param').id);
        if (row === null) throw notFound();
        return c.json(row, 200);
      },
    );
  }
  api.openapi(
    crmRoute('analytics:read', {
      method: 'patch',
      path: `${view.path}/{id}`,
      tags,
      summary: view.summaries.update,
      request: { params: idParam, query: siteQuery, body: jsonBody(updateBody) },
      responses: { 200: json(view.schema, label) },
    }, writers),
    async (c) => {
      const row = await view.update((await siteOf(c)).stub, c.req.valid('param').id, c.req.valid('json') as z.output<U>);
      if (row === null) throw notFound();
      return c.json(row, 200);
    },
  );
  api.openapi(
    crmRoute('analytics:read', {
      method: 'delete',
      path: `${view.path}/{id}`,
      tags,
      summary: view.summaries.remove,
      request: { params: idParam, query: siteQuery },
      responses: { 200: json(ok, 'Deleted') },
    }, writers),
    async (c) => {
      const { id } = c.req.valid('param');
      if (!(await view.remove((await siteOf(c)).stub, id))) throw notFound();
      return c.json({ id, deleted: true as const }, 200);
    },
  );
}

/** Funnels, segments, goal alerts, share links, site keys, integrations and prediction. */
export function registerConfigRoutes(api: OpenAPIHono<AppEnv>): void {
  // ------------------------------------------------------- funnels, segments
  savedViewRoutes(api, {
    path: '/funnels',
    noun: 'funnel',
    schema: funnelSchema,
    createSchema: createFunnelSchema,
    updateSchema: updateFunnelSchema,
    summaries: {
      list: 'Funnels of a site',
      create: 'Create a funnel (2-8 ordered pageview / goal steps)',
      get: 'Get a funnel',
      update: 'Update a funnel',
      remove: 'Delete a funnel',
    },
    list: (stub) => stub.listFunnels(),
    create: (stub, input) => stub.createFunnel(input),
    get: (stub, id) => stub.getFunnel(id),
    update: (stub, id, patch) => stub.updateFunnel(id, patch),
    remove: (stub, id) => stub.deleteFunnel(id),
  });
  api.openapi(
    crmRoute('analytics:read', {
      method: 'get',
      path: '/funnels/{id}/results',
      tags,
      summary: 'Funnel conversion over a range (visitors per step, drop-off, median time)',
      request: { params: idParam, query: analyticsQueryParamsSchema },
      responses: { 200: json(funnelResultSchema, 'Funnel result') },
    }),
    async (c) => {
      const params = c.req.valid('query');
      const { stub } = await siteOf(c);
      return c.json(unwrap(await stub.funnelResult(c.req.valid('param').id, rangeOf(c, params))), 200);
    },
  );

  savedViewRoutes(api, {
    path: '/segments',
    noun: 'segment',
    schema: segmentSchema,
    createSchema: createSegmentSchema,
    updateSchema: updateSegmentSchema,
    summaries: {
      list: 'Saved segments (filter sets) of a site',
      create: 'Save a segment',
      update: 'Update a segment',
      remove: 'Delete a segment',
    },
    list: (stub) => stub.listSegments(),
    create: (stub, input) => stub.createSegment(input),
    update: (stub, id, patch) => stub.updateSegment(id, patch),
    remove: (stub, id) => stub.deleteSegment(id),
  });

  // ------------------------------------------------------------------- alerts
  api.openapi(
    crmRoute('analytics:read', {
      method: 'get',
      path: '/alerts',
      tags,
      summary: 'Goal alerts of a site',
      request: { query: siteQuery },
      responses: { 200: json(z.object({ data: z.array(alertSchema) }), 'Alerts') },
    }),
    async (c) => c.json({ data: await (await siteOf(c)).stub.listAlerts() }, 200),
  );
  api.openapi(
    crmRoute('analytics:configure', {
      method: 'post',
      path: '/alerts',
      tags,
      summary: 'Create a goal alert (email to members and/or signed webhook)',
      request: { query: siteQuery, body: jsonBody(createAlertSchema) },
      responses: { 201: json(alertWithSecretSchema, 'Alert and its webhook secret (shown once)') },
    }),
    async (c) => {
      const input = c.req.valid('json');
      await assertMembers(c, input.email_recipients);
      const { siteId, stub } = await siteOf(c);
      const created = await stub.createAlert(input, input.webhook_url === null ? null : randomSecret());
      await audit(c, 'analytics.alert_created', { target: created.alert.id, details: { site: siteId } });
      return c.json(created, 201);
    },
  );
  api.openapi(
    crmRoute('analytics:configure', {
      method: 'patch',
      path: '/alerts/{id}',
      tags,
      summary: 'Update a goal alert',
      request: { params: idParam, query: siteQuery, body: jsonBody(updateAlertSchema) },
      responses: { 200: json(alertWithSecretSchema, 'Alert (webhook secret only when newly issued)') },
    }),
    async (c) => {
      const patch = c.req.valid('json');
      if (patch.email_recipients !== undefined) await assertMembers(c, patch.email_recipients);
      const updated = await (await siteOf(c)).stub.updateAlert(c.req.valid('param').id, patch, randomSecret());
      if (updated === null) throw new CrmError('not_found', 'alert not found');
      return c.json(updated, 200);
    },
  );
  api.openapi(
    crmRoute('analytics:configure', {
      method: 'post',
      path: '/alerts/{id}/webhook-secret',
      tags,
      summary: 'Issue a new webhook secret for an alert (the old one stops verifying at once)',
      request: { params: idParam, query: siteQuery },
      responses: { 200: json(alertWithSecretSchema, 'Alert and its new webhook secret (shown once)') },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const rotated = await (await siteOf(c)).stub.rotateAlertSecret(id, randomSecret());
      if (rotated === null) throw new CrmError('not_found', 'alert not found or without webhook');
      await audit(c, 'analytics.alert_secret_rotated', { target: id });
      return c.json(rotated, 200);
    },
  );
  api.openapi(
    crmRoute('analytics:configure', {
      method: 'delete',
      path: '/alerts/{id}',
      tags,
      summary: 'Delete a goal alert',
      request: { params: idParam, query: siteQuery },
      responses: { 200: json(ok, 'Deleted') },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      if (!(await (await siteOf(c)).stub.deleteAlert(id))) throw new CrmError('not_found', 'alert not found');
      await audit(c, 'analytics.alert_deleted', { target: id });
      return c.json({ id, deleted: true as const }, 200);
    },
  );
  api.openapi(
    crmRoute('analytics:configure', {
      method: 'post',
      path: '/alerts/{id}/test',
      tags,
      summary: 'Queue a test delivery of an alert',
      request: { params: idParam, query: siteQuery },
      responses: { 200: json(z.object({ queued: z.literal(true) }), 'Queued') },
    }),
    async (c) => {
      if (!(await (await siteOf(c)).stub.testAlert(c.req.valid('param').id))) {
        throw new CrmError('not_found', 'alert not found');
      }
      return c.json({ queued: true as const }, 200);
    },
  );

  // ------------------------------------------------------------------- shares
  api.openapi(
    crmRoute('analytics:read', {
      method: 'get',
      path: '/shares',
      tags,
      summary: 'Public share links of a site dashboard',
      request: { query: siteQuery },
      responses: { 200: json(z.object({ data: z.array(shareSchema) }), 'Share links') },
    }, { anyOf: ['analytics:configure'] }),
    async (c) => {
      const { siteId, stub } = await siteOf(c);
      const rows = await stub.listShares();
      return c.json({ data: await Promise.all(rows.map((r) => shareOut(c, siteId, r))) }, 200);
    },
  );
  api.openapi(
    crmRoute('analytics:configure', {
      method: 'post',
      path: '/shares',
      tags,
      summary: 'Create a read-only public share link (signed, revocable)',
      request: { query: siteQuery, body: jsonBody(createShareSchema) },
      responses: { 201: json(shareSchema, 'Share link') },
    }),
    async (c) => {
      const { siteId, stub } = await siteOf(c);
      const row = await stub.createShare(c.req.valid('json').name);
      await audit(c, 'analytics.share_created', { target: row.id, details: { site: siteId } });
      return c.json(await shareOut(c, siteId, row), 201);
    },
  );
  api.openapi(
    crmRoute('analytics:configure', {
      method: 'delete',
      path: '/shares/{id}',
      tags,
      summary: 'Revoke a share link (immediately)',
      request: { params: idParam, query: siteQuery },
      responses: { 200: json(ok, 'Revoked') },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      if (!(await (await siteOf(c)).stub.revokeShare(id))) throw new CrmError('not_found', 'share not found');
      await audit(c, 'analytics.share_revoked', { target: id });
      return c.json({ id, deleted: true as const }, 200);
    },
  );

  // ---------------------------------------------------------------- site keys
  const siteParam = z.object({ siteId: z.string().min(1).max(64) });
  api.openapi(
    crmRoute('analytics:configure', {
      method: 'get',
      path: '/sites/{siteId}/keys',
      tags,
      summary: 'Analytics API keys of a site',
      request: { params: siteParam },
      responses: { 200: json(z.object({ data: z.array(siteKeySchema) }), 'Keys') },
    }),
    async (c) => {
      const { siteId } = c.req.valid('param');
      await siteRecord(c, siteId);
      return c.json({ data: await siteStub(namespace(c), siteId).listSiteKeys() }, 200);
    },
  );
  api.openapi(
    crmRoute('analytics:configure', {
      method: 'post',
      path: '/sites/{siteId}/keys',
      tags,
      summary: 'Create a site API key (read and/or write; shown once)',
      request: { params: siteParam, body: jsonBody(createSiteKeySchema) },
      responses: { 201: json(siteKeyWithSecretSchema, 'Key and secret') },
    }, { stepUp: true }),
    async (c) => {
      const { siteId } = c.req.valid('param');
      const created = await createSiteKey(c, siteId, c.req.valid('json'));
      await audit(c, 'analytics.site_key_created', { target: created.key.id, details: { site: siteId } });
      return c.json(created, 201);
    },
  );
  api.openapi(
    crmRoute('analytics:configure', {
      method: 'delete',
      path: '/sites/{siteId}/keys/{keyId}',
      tags,
      summary: 'Revoke a site API key',
      request: { params: siteParam.extend({ keyId: z.string().min(1).max(64) }) },
      responses: { 200: json(ok, 'Revoked') },
    }),
    async (c) => {
      const { siteId, keyId } = c.req.valid('param');
      await siteRecord(c, siteId);
      if (!(await siteStub(namespace(c), siteId).revokeSiteKey(keyId))) throw new CrmError('not_found', 'key not found');
      await audit(c, 'analytics.site_key_revoked', { target: keyId });
      return c.json({ id: keyId, deleted: true as const }, 200);
    },
  );

  // ------------------------------------------------------------- integrations
  const providerParam = z.object({ provider: z.enum(INTEGRATION_PROVIDERS) });
  api.openapi(
    crmRoute('analytics:read', {
      method: 'get',
      path: '/integrations',
      tags,
      summary: 'Ad spend and organic search integrations of a site',
      request: { query: siteQuery },
      responses: { 200: json(z.object({ data: z.array(integrationSchema) }), 'Integrations') },
    }),
    async (c) => {
      const { stub } = await siteOf(c);
      const rows = await stub.listIntegrations();
      const integrations = integrationsFor(c.env);
      return c.json(
        {
          data: INTEGRATION_PROVIDERS.map((p) =>
            toIntegration(p, rows.find((r) => r.provider === p) ?? null, integrations),
          ),
        },
        200,
      );
    },
  );
  api.openapi(
    crmRoute('analytics:configure', {
      method: 'post',
      path: '/integrations/{provider}/connect',
      tags,
      summary: 'Start the OAuth connection (returns the authorization URL)',
      request: { params: providerParam, query: siteQuery },
      responses: { 200: json(integrationConnectSchema, 'Authorization URL') },
    }),
    async (c) => {
      const { siteId } = await siteOf(c);
      const integrations = integrationsFor(c.env);
      if (!integrations.oauth.available) throw new HttpError(503, 'integration_unavailable');
      const { provider } = c.req.valid('param');
      const returnUrl = `${requestAppOrigin(c).replace(/\/+$/, '')}/t/${getTenant(c).tenant.slug}/analytics/settings?site=${siteId}&tab=integrations`;
      const start = await integrations.oauth.startConnect({
        tenantId: getTenant(c).tenant.id,
        siteId,
        provider,
        returnUrl,
      });
      return c.json({ authorize_url: start.authorizeUrl }, 200);
    },
  );
  api.openapi(
    crmRoute('analytics:configure', {
      method: 'post',
      path: '/integrations/{provider}/callback',
      tags,
      summary: 'Complete the OAuth connection and run a first sync',
      request: { params: providerParam, query: siteQuery, body: jsonBody(integrationCallbackSchema) },
      responses: { 200: json(integrationSchema, 'Integration') },
    }),
    async (c) => {
      const { siteId, stub } = await siteOf(c);
      const integrations = integrationsFor(c.env);
      if (!integrations.oauth.available) throw new HttpError(503, 'integration_unavailable');
      const { provider } = c.req.valid('param');
      const { state, code } = c.req.valid('json');
      let account;
      try {
        account = await integrations.oauth.finishConnect({ tenantId: getTenant(c).tenant.id, siteId, provider, state, code });
      } catch {
        throw new CrmError('validation_failed', 'invalid or expired authorization');
      }
      const now = c.get('services').now();
      await stub.saveIntegration({
        provider,
        status: 'connected',
        account_id: account.accountId,
        account_name: account.accountName,
        connected_at: now,
        last_sync_at: null,
        last_error: null,
      });
      await audit(c, 'analytics.integration_connected', { target: provider, details: { site: siteId } });
      const row = await syncIntegration(namespace(c), siteId, provider, integrations, now);
      return c.json(toIntegration(provider, row, integrations), 200);
    },
  );
  api.openapi(
    crmRoute('analytics:configure', {
      method: 'post',
      path: '/integrations/{provider}/sync',
      tags,
      summary: 'Sync an integration now',
      request: { params: providerParam, query: siteQuery },
      responses: { 200: json(integrationSchema, 'Integration') },
    }),
    async (c) => {
      const { siteId } = await siteOf(c);
      const integrations = integrationsFor(c.env);
      const { provider } = c.req.valid('param');
      const row = await syncIntegration(namespace(c), siteId, provider, integrations, c.get('services').now());
      if (row === null) throw new CrmError('not_found', 'integration not connected');
      return c.json(toIntegration(provider, row, integrations), 200);
    },
  );
  api.openapi(
    crmRoute('analytics:configure', {
      method: 'delete',
      path: '/integrations/{provider}',
      tags,
      summary: 'Disconnect an integration (synced numbers are kept)',
      request: { params: providerParam, query: siteQuery },
      responses: { 200: json(z.object({ provider: z.enum(INTEGRATION_PROVIDERS), deleted: z.literal(true) }), 'Disconnected') },
    }),
    async (c) => {
      const { stub } = await siteOf(c);
      const { provider } = c.req.valid('param');
      await stub.removeIntegration(provider);
      await audit(c, 'analytics.integration_disconnected', { target: provider });
      return c.json({ provider, deleted: true as const }, 200);
    },
  );

  // --------------------------------------------------------------- prediction
  api.openapi(
    crmRoute('analytics:read', {
      method: 'get',
      path: '/prediction',
      tags,
      summary: 'Conversion prediction model of a site (retrained nightly)',
      request: { query: siteQuery },
      responses: { 200: json(predictionModelSchema, 'Model') },
    }),
    async (c) => {
      const info = await (await siteOf(c)).stub.predictionInfo();
      if (info === null) throw new CrmError('not_found', 'site not found');
      return c.json(info, 200);
    },
  );
  api.openapi(
    crmRoute('analytics:configure', {
      method: 'post',
      path: '/prediction/train',
      tags,
      summary: 'Retrain the conversion prediction model now',
      request: { query: siteQuery },
      responses: { 200: json(predictionModelSchema, 'Model') },
    }),
    async (c) => {
      const info = await (await siteOf(c)).stub.trainPrediction();
      if (info === null) throw new CrmError('not_found', 'site not found');
      return c.json(info, 200);
    },
  );
}
