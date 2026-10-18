import { z } from '@hono/zod-openapi';
import { isProviderError } from '@amable/ads-providers';
import { AD_PLATFORMS, adConnectionSchema, adConnectionSettingsSchema } from '@amable/api-types';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { crmRoute, json, jsonBody } from '../crm/api/core';
import { CrmError } from '../crm/errors';
import { appOrigin as requestAppOrigin, audit, getTenant, HttpError, type AppEnv } from '../middleware';
import {
  adsRedirectUri,
  adsStub,
  adsSyncPorts,
  AdsSyncError,
  backfillAdConnection,
  BACKFILL_MAX_DAYS,
  disconnectAdConnection,
  finishAdsConnect,
  startAdsConnect,
  syncAdConnection,
  toAdConnection,
  updateAdConnectionSettings,
  type AdsSyncPorts,
  type SiteRef,
} from './ads-sync';
import { namespace, siteIdParam, siteRecord } from './service';

const tags = ['Analytics'];
const siteQuery = z.object({ site_id: z.string().min(1).max(64) });
const platformParam = z.object({ platform: z.enum(AD_PLATFORMS) });
const idParam = z.object({ id: z.string().min(1).max(64) });
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const connectionsSchema = z.object({
  available: z.array(z.enum(AD_PLATFORMS)),
  fake: z.boolean(),
  data: z.array(adConnectionSchema),
});
const connectStartSchema = z.object({ authorize_url: z.string(), state: z.string() });
const callbackSchema = z.strictObject({
  state: z.string().min(1).max(512),
  code: z.string().min(1).max(4096),
  /** Ad accounts to connect (default: every account of the authorization). */
  account_ids: z.array(z.string().min(1).max(128)).min(1).max(25).optional(),
});
const backfillSchema = z.strictObject({ from: day, to: day });
const backfillResultSchema = z.object({
  connection_id: z.string(),
  from: day,
  to: day,
  rows: z.number().int(),
});

type Ctx = Context<AppEnv>;

async function siteOf(c: Ctx): Promise<{ site: SiteRef; ports: AdsSyncPorts }> {
  const siteId = siteIdParam(c);
  const record = await siteRecord(c, siteId);
  const services = c.get('services');
  return {
    site: { tenantId: getTenant(c).tenant.id, id: siteId, name: record.site.name },
    ports: adsSyncPorts(c.env, namespace(c), () => services.now()),
  };
}

function providerFailure(error: unknown): never {
  if (error instanceof AdsSyncError) {
    if (error.code === 'unavailable') throw new HttpError(503, 'integration_unavailable');
    throw new CrmError('validation_failed', error.message);
  }
  if (isProviderError(error)) {
    if (error.kind === 'auth_expired') throw new HttpError(409, 'ads_auth_expired');
    if (error.kind === 'retryable') throw new HttpError(503, 'ads_provider_unavailable');
    throw new HttpError(502, 'ads_provider_error', { message: error.message.slice(0, 200) });
  }
  throw error;
}

/** Ad platform connections of a site: OAuth, listing, disconnection and manual backfill. */
export function registerAdsRoutes(api: OpenAPIHono<AppEnv>): void {
  api.openapi(
    crmRoute('analytics:read', {
      method: 'get',
      path: '/ads/connections',
      tags,
      summary: 'Ad platform connections of a site (tokens never leave the server)',
      request: { query: siteQuery },
      responses: { 200: json(connectionsSchema, 'Connections') },
    }),
    async (c) => {
      const { site, ports } = await siteOf(c);
      const rows = await adsStub(ports.ns, site.id).listAdConnections();
      return c.json(
        {
          available: AD_PLATFORMS.filter((p) => ports.clients.client(p) !== null),
          fake: ports.clients.fake,
          data: rows.map(toAdConnection),
        },
        200,
      );
    },
  );

  api.openapi(
    crmRoute('analytics:configure', {
      method: 'post',
      path: '/ads/connections/{platform}/connect',
      tags,
      summary: 'Start the OAuth connection of an ad platform (returns the authorization URL)',
      request: { params: platformParam, query: siteQuery },
      responses: { 200: json(connectStartSchema, 'Authorization URL') },
    }),
    async (c) => {
      const { site, ports } = await siteOf(c);
      const { platform } = c.req.valid('param');
      const tenant = getTenant(c).tenant;
      const origin = requestAppOrigin(c).replace(/\/+$/, '');
      // The fake clients redirect straight back to the settings page with state + code.
      const redirectUri = ports.clients.fake
        ? `${origin}/t/${tenant.slug}/analytics/settings?site=${site.id}&tab=ads&platform=${platform}`
        : adsRedirectUri(c.env, origin);
      try {
        const start = await startAdsConnect(ports, {
          tenantId: tenant.id,
          tenantSlug: tenant.slug,
          siteId: site.id,
          platform,
          redirectUri,
        });
        return c.json({ authorize_url: start.authorizeUrl, state: start.state }, 200);
      } catch (error) {
        return providerFailure(error);
      }
    },
  );

  api.openapi(
    crmRoute('analytics:configure', {
      method: 'post',
      path: '/ads/connections/{platform}/callback',
      tags,
      summary: 'Complete the OAuth connection: one connection per ad account, then a first sync',
      request: { params: platformParam, query: siteQuery, body: jsonBody(callbackSchema) },
      responses: { 200: json(z.object({ data: z.array(adConnectionSchema) }), 'Connections') },
    }),
    async (c) => {
      const { site, ports } = await siteOf(c);
      const { platform } = c.req.valid('param');
      const body = c.req.valid('json');
      let created;
      try {
        created = await finishAdsConnect(ports, {
          tenantId: site.tenantId,
          siteId: site.id,
          platform,
          state: body.state,
          code: body.code,
          accountIds: body.account_ids,
        });
      } catch (error) {
        if (isProviderError(error)) throw new CrmError('validation_failed', 'invalid or expired authorization');
        return providerFailure(error);
      }
      await audit(c, 'analytics.ads_connected', {
        target: platform,
        details: { site: site.id, accounts: created.length },
      });
      const stub = adsStub(ports.ns, site.id);
      const out = [];
      for (const conn of created) {
        await syncAdConnection(ports, site, conn, { force: true });
        out.push(toAdConnection((await stub.getAdConnection(conn.id)) ?? conn));
      }
      return c.json({ data: out }, 200);
    },
  );

  api.openapi(
    crmRoute('analytics:configure', {
      method: 'delete',
      path: '/ads/connections/{id}',
      tags,
      summary: 'Disconnect an ad account (synced spend and entities are kept)',
      request: { params: idParam, query: siteQuery },
      responses: { 200: json(z.object({ id: z.string(), deleted: z.literal(true) }), 'Disconnected') },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const { site, ports } = await siteOf(c);
      const conn = await adsStub(ports.ns, site.id).getAdConnection(id);
      if (conn === null) throw new CrmError('not_found', 'connection not found');
      await disconnectAdConnection(ports, site.id, conn);
      await audit(c, 'analytics.ads_disconnected', { target: id, details: { site: site.id } });
      return c.json({ id, deleted: true as const }, 200);
    },
  );

  api.openapi(
    crmRoute('analytics:configure', {
      method: 'patch',
      path: '/ads/connections/{id}',
      tags,
      summary: 'Set where the server-side conversions of a Meta/TikTok account go (dataset or pixel ID, test code)',
      request: { params: idParam, query: siteQuery, body: jsonBody(adConnectionSettingsSchema) },
      responses: { 200: json(adConnectionSchema, 'The connection') },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const { site, ports } = await siteOf(c);
      const conn = await adsStub(ports.ns, site.id).getAdConnection(id);
      if (conn === null) throw new CrmError('not_found', 'connection not found');
      try {
        const updated = await updateAdConnectionSettings(ports, site.id, conn, c.req.valid('json'));
        await audit(c, 'analytics.ads_settings_updated', { target: id, details: { site: site.id } });
        return c.json(toAdConnection(updated), 200);
      } catch (error) {
        return providerFailure(error);
      }
    },
  );

  api.openapi(
    crmRoute('analytics:configure', {
      method: 'post',
      path: '/ads/connections/{id}/backfill',
      tags,
      summary: `Re-pull the spend of a day range (at most ${String(BACKFILL_MAX_DAYS)} days, overwrites it)`,
      request: { params: idParam, query: siteQuery, body: jsonBody(backfillSchema) },
      responses: { 200: json(backfillResultSchema, 'Backfilled range') },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const { site, ports } = await siteOf(c);
      const conn = await adsStub(ports.ns, site.id).getAdConnection(id);
      if (conn === null) throw new CrmError('not_found', 'connection not found');
      try {
        const result = await backfillAdConnection(ports, site, conn, c.req.valid('json'));
        await audit(c, 'analytics.ads_backfilled', {
          target: id,
          details: { site: site.id, from: result.from, to: result.to },
        });
        return c.json({ connection_id: id, ...result }, 200);
      } catch (error) {
        return providerFailure(error);
      }
    },
  );
}
