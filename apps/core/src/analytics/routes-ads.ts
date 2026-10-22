import { z } from '@hono/zod-openapi';
import { idParam, siteQuery } from './params';
import { isProviderError } from '@amable/ads-providers';
import { AD_PLATFORMS, adConnectionSchema, adConnectionSettingsSchema } from '@amable/api-types';
import type { AdConnectionRecord } from '@amable/app-edge/analytics';
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
  authorizeAdsConnect,
  backfillAdConnection,
  BACKFILL_MAX_DAYS,
  cancelAdsConnect,
  connectAdAccounts,
  disconnectAdConnection,
  finishAdsConnect,
  MAX_ACCOUNTS_PER_CONNECT,
  startAdsConnect,
  syncAdConnection,
  toAdConnection,
  updateAdConnectionSettings,
  type AdsSyncPorts,
  type SiteRef,
} from './ads-sync';
import { namespace, siteIdParam, siteRecord } from './service';
import { mapLimited } from '../concurrency';

const tags = ['Analytics'];
/** Accounts of one authorization synced at once right after connecting. */
const FIRST_SYNC_CONCURRENCY = 3;
const platformParam = z.object({ platform: z.enum(AD_PLATFORMS) });
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const connectionsSchema = z.object({
  available: z.array(z.enum(AD_PLATFORMS)),
  fake: z.boolean(),
  data: z.array(adConnectionSchema),
});
const connectStartSchema = z.object({ authorize_url: z.string(), state: z.string() });
const accountIdsSchema = z.array(z.string().min(1).max(128)).min(1).max(MAX_ACCOUNTS_PER_CONNECT);
const grantIdSchema = z.string().regex(/^ag_[A-Za-z0-9_-]{1,64}$/);
const callbackSchema = z.strictObject({
  state: z.string().min(1).max(512),
  code: z.string().min(1).max(4096),
  /** Ad accounts to connect right away; without them the accounts are returned for selection. */
  account_ids: accountIdsSchema.optional(),
});
const selectionSchema = z.object({
  grant_id: z.string(),
  /** Pick at most `max` with `POST …/{platform}/accounts`, or drop the authorization with `…/cancel`. */
  max: z.number().int(),
  accounts: z.array(
    z.object({
      account_id: z.string(),
      name: z.string(),
      currency: z.string(),
      timezone: z.string(),
      connected: z.boolean(),
    }),
  ),
});
const callbackResultSchema = z.object({
  /** Connections created; empty while `selection` waits for the user. */
  data: z.array(adConnectionSchema),
  selection: selectionSchema.optional(),
});
const pickSchema = z.strictObject({ grant_id: grantIdSchema, account_ids: accountIdsSchema });
const cancelSchema = z.strictObject({ grant_id: grantIdSchema });
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

/** Connection `id` of the request's site, or 404. */
async function connectionOf(c: Ctx, id: string) {
  const { site, ports } = await siteOf(c);
  const conn = await adsStub(ports.ns, site.id).getAdConnection(id);
  if (conn === null) throw new CrmError('not_found', 'connection not found');
  return { site, ports, conn };
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

/** Audits the new connections and runs their first sync. */
async function connected(c: Ctx, site: SiteRef, ports: AdsSyncPorts, platform: string, created: AdConnectionRecord[]) {
  await audit(c, 'analytics.ads_connected', {
    target: platform,
    details: { site: site.id, accounts: created.length },
  });
  const stub = adsStub(ports.ns, site.id);
  return mapLimited(created, FIRST_SYNC_CONCURRENCY, async (conn) => {
    await syncAdConnection(ports, site, conn, { force: true });
    return toAdConnection((await stub.getAdConnection(conn.id)) ?? conn);
  });
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
      summary:
        'Complete the OAuth authorization: a single ad account (or the given account_ids) is connected and synced, several are returned for selection',
      request: { params: platformParam, query: siteQuery, body: jsonBody(callbackSchema) },
      responses: { 200: json(callbackResultSchema, 'Connections, or the accounts to pick from') },
    }),
    async (c) => {
      const { site, ports } = await siteOf(c);
      const { platform } = c.req.valid('param');
      const body = c.req.valid('json');
      const input = { tenantId: site.tenantId, siteId: site.id, platform, state: body.state, code: body.code };
      let created: AdConnectionRecord[];
      try {
        if (body.account_ids !== undefined) {
          created = await finishAdsConnect(ports, { ...input, accountIds: body.account_ids });
        } else {
          const authorization = await authorizeAdsConnect(ports, input);
          const [only, ...others] = authorization.accounts;
          if (only === undefined || others.length > 0) {
            return c.json(
              {
                data: [],
                selection: {
                  grant_id: authorization.grantId,
                  max: MAX_ACCOUNTS_PER_CONNECT,
                  accounts: authorization.accounts.map((a) => ({ ...a })),
                },
              },
              200,
            );
          }
          created = await connectAdAccounts(ports, {
            ...input,
            grantId: authorization.grantId,
            accountIds: [only.account_id],
          });
        }
      } catch (error) {
        if (isProviderError(error)) throw new CrmError('validation_failed', 'invalid or expired authorization');
        return providerFailure(error);
      }
      return c.json({ data: await connected(c, site, ports, platform, created) }, 200);
    },
  );

  api.openapi(
    crmRoute('analytics:configure', {
      method: 'post',
      path: '/ads/connections/{platform}/accounts',
      tags,
      summary: 'Connect the ad accounts picked from a pending authorization, then run their first sync',
      request: { params: platformParam, query: siteQuery, body: jsonBody(pickSchema) },
      responses: { 200: json(z.object({ data: z.array(adConnectionSchema) }), 'Connections') },
    }),
    async (c) => {
      const { site, ports } = await siteOf(c);
      const { platform } = c.req.valid('param');
      const body = c.req.valid('json');
      let created: AdConnectionRecord[];
      try {
        created = await connectAdAccounts(ports, {
          tenantId: site.tenantId,
          siteId: site.id,
          platform,
          grantId: body.grant_id,
          accountIds: body.account_ids,
        });
      } catch (error) {
        return providerFailure(error);
      }
      return c.json({ data: await connected(c, site, ports, platform, created) }, 200);
    },
  );

  api.openapi(
    crmRoute('analytics:configure', {
      method: 'post',
      path: '/ads/connections/{platform}/cancel',
      tags,
      summary: 'Drop a pending authorization without connecting any ad account',
      request: { params: platformParam, query: siteQuery, body: jsonBody(cancelSchema) },
      responses: { 200: json(z.object({ ok: z.literal(true) }), 'Dropped') },
    }),
    async (c) => {
      const { site, ports } = await siteOf(c);
      const { platform } = c.req.valid('param');
      try {
        await cancelAdsConnect(ports, {
          tenantId: site.tenantId,
          siteId: site.id,
          platform,
          grantId: c.req.valid('json').grant_id,
        });
      } catch (error) {
        return providerFailure(error);
      }
      return c.json({ ok: true as const }, 200);
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
      const { site, ports, conn } = await connectionOf(c, id);
      await disconnectAdConnection(ports, site, conn);
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
      const { site, ports, conn } = await connectionOf(c, id);
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
      const { site, ports, conn } = await connectionOf(c, id);
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
