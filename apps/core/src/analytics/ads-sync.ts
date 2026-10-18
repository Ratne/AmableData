import { isProviderError, ProviderError, type AdsProvider as AdPlatformClient } from '@amable/ads-providers';
import type {
  AdConnection,
  AdConnectionSettings,
  AdEntity,
  AdEntityLevel,
  AdPlatform,
  AdSpendDay,
  GatewayResponse,
  GatewayTenantInfo,
} from '@amable/api-types';
import {
  siteStub,
  tenantSitesStub,
  type AdConnectionInput,
  type AdConnectionRecord,
  type AdEntityQuery,
  type AdEntityRecord,
  type AdSpendQuery,
  type AnalyticsNamespace,
  type AnalyticsResult,
} from '@amable/app-edge/analytics';
import type { OAuthKeyValueStore, OAuthSealer, SystemEmail } from '@amable/core';
import { z } from 'zod';
import { getAuthServices } from '../auth/services';
import type { Env } from '../env';
import { authSealer, d1OAuthStore } from '../providers/select';
import {
  adPlatformClientsFor,
  adPlatformCredentials,
  type AdPlatformClients,
  type AdPlatformSecretsEnv,
} from './integrations';

/**
 * Ad platform connections of a site: OAuth grants, spend and entity sync.
 *
 * Grants (access + refresh token) live sealed in the installation D1
 * (`installation_meta`, key `ads_grant:<grantId>`, encrypted with the
 * installation SecretBox bound to tenant + site + grant). The site DO only
 * holds the connection (account, status, `metadata.grant_id`), the entity
 * dictionary and the daily spend.
 *
 * Cadence (cron every 5 minutes, per-connection guards): the current local day
 * of the ad account is re-pulled at most once per `SPEND_SYNC_INTERVAL_MS`; once
 * per local day (after `RECONCILE_LOCAL_HOUR`) the previous `RECONCILE_DAYS`
 * closed days are pulled again and overwrite what is stored; the entity
 * dictionary is refreshed when spend names an unknown entity or every
 * `ENTITY_REFRESH_MS`. A retryable failure is retried on the next tick.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const SPEND_SYNC_INTERVAL_MS = 55 * MIN;
export const RECONCILE_DAYS = 7;
export const RECONCILE_LOCAL_HOUR = 3;
export const ENTITY_REFRESH_MS = DAY;
export const BACKFILL_MAX_DAYS = 90;
/** Access tokens closer than this to their expiry are refreshed first (sync runs hourly). */
export const TOKEN_REFRESH_MARGIN_MS = 2 * HOUR;
const STATE_TTL_MS = 10 * MIN;
const MAX_ACCOUNTS_PER_CONNECT = 25;
/**
 * Spend is pulled at every level (one provider call per level and range); the
 * performance report reads a single level per platform, so the levels never
 * add up twice.
 */
export const SPEND_LEVELS: readonly AdEntityLevel[] = ['campaign', 'adset', 'ad'];

/** Ad methods of the site DO with plain types (the RPC stub types erase `metadata: Record<string, unknown>`). */
export interface AdsSiteStub {
  getAdConnection(id: string): Promise<AdConnectionRecord | null>;
  listAdConnections(platform?: AdPlatform): Promise<AdConnectionRecord[]>;
  upsertAdConnection(input: AdConnectionInput): Promise<AnalyticsResult<AdConnectionRecord>>;
  upsertAdEntities(entities: AdEntity[], connectionId?: string | null): Promise<AnalyticsResult<{ upserted: number }>>;
  listAdEntities(query?: AdEntityQuery): Promise<AdEntityRecord[]>;
  upsertAdSpend(rows: AdSpendDay[], connectionId?: string | null): Promise<AnalyticsResult<{ upserted: number }>>;
  listAdSpend(query: AdSpendQuery): Promise<AdSpendDay[]>;
}

export const adsStub = (ns: AnalyticsNamespace, siteId: string): AdsSiteStub =>
  siteStub(ns, siteId) as unknown as AdsSiteStub;

// ------------------------------------------------------------------ grants

export interface AdGrant {
  tenantId: string;
  siteId: string;
  platform: AdPlatform;
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms; null when the platform token does not expire. */
  expiresAt: number | null;
}

export interface AdOAuthState {
  tenantId: string;
  siteId: string;
  platform: AdPlatform;
  redirectUri: string;
  expiresAt: number;
}

export interface AdGrantStore {
  putState(state: string, value: AdOAuthState): Promise<void>;
  /** One-time: the state is removed when read. */
  takeState(state: string): Promise<AdOAuthState | null>;
  getGrant(ref: GrantRef): Promise<AdGrant | null>;
  putGrant(ref: GrantRef, grant: AdGrant): Promise<void>;
  deleteGrant(grantId: string): Promise<void>;
}

export interface GrantRef {
  tenantId: string;
  siteId: string;
  grantId: string;
}

const STATE_PREFIX = 'ads_state:';
const GRANT_PREFIX = 'ads_grant:';
const grantAad = (ref: GrantRef): string => `${GRANT_PREFIX}${ref.tenantId}:${ref.siteId}:${ref.grantId}`;

/** Grants sealed in a key/value store (production: installation D1 + SecretBox). */
export function kvAdGrantStore(store: OAuthKeyValueStore, sealer: OAuthSealer, now: () => number): AdGrantStore {
  return {
    async putState(state, value) {
      await store.put(`${STATE_PREFIX}${state}`, JSON.stringify(value));
    },
    async takeState(state) {
      const raw = await store.get(`${STATE_PREFIX}${state}`);
      if (raw === null) return null;
      await store.delete(`${STATE_PREFIX}${state}`);
      const parsed = JSON.parse(raw) as AdOAuthState;
      return parsed.expiresAt < now() ? null : parsed;
    },
    async getGrant(ref) {
      const sealed = await store.get(`${GRANT_PREFIX}${ref.grantId}`);
      if (sealed === null) return null;
      try {
        const grant = JSON.parse(await sealer.decrypt(sealed, grantAad(ref))) as AdGrant;
        return grant.tenantId === ref.tenantId && grant.siteId === ref.siteId ? grant : null;
      } catch {
        return null;
      }
    },
    async putGrant(ref, grant) {
      await store.put(`${GRANT_PREFIX}${ref.grantId}`, await sealer.encrypt(JSON.stringify(grant), grantAad(ref)));
    },
    async deleteGrant(grantId) {
      await store.delete(`${GRANT_PREFIX}${grantId}`);
    },
  };
}

// --------------------------------------------------------------------- days

function dayParts(ts: number, timeZone: string): { day: string; hour: number } {
  const format = (tz: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(ts);
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = format(timeZone);
  } catch {
    parts = format('UTC');
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24 };
}

export const localDay = (ts: number, timeZone: string): string => dayParts(ts, timeZone).day;

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

/** Inclusive number of days of [from, to]. */
export const dayCount = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY) + 1;

// -------------------------------------------------------------------- spend

type ProviderSpendRow = AdSpendDay & { readonly hour?: number };

const sumNullable = (a: number | null | undefined, b: number | null | undefined): number | null =>
  a == null && b == null ? null : (a ?? 0) + (b ?? 0);

/** Sums provider rows (hourly or daily) into one row per platform + entity + day. */
export function aggregateSpend(rows: readonly ProviderSpendRow[]): AdSpendDay[] {
  const out = new Map<string, AdSpendDay>();
  for (const { hour: _hour, ...r } of rows) {
    const key = `${r.platform}|${r.entity_external_id}|${r.day}`;
    const acc = out.get(key);
    if (acc === undefined) {
      out.set(key, {
        platform: r.platform,
        entity_external_id: r.entity_external_id,
        day: r.day,
        spend_minor: r.spend_minor,
        ...(r.currency === undefined ? {} : { currency: r.currency }),
        clicks: r.clicks ?? null,
        impressions: r.impressions ?? null,
        reported_conversions: r.reported_conversions ?? null,
        reported_revenue_minor: r.reported_revenue_minor ?? null,
      });
      continue;
    }
    acc.spend_minor += r.spend_minor;
    if (acc.currency === undefined && r.currency !== undefined) acc.currency = r.currency;
    acc.clicks = sumNullable(acc.clicks, r.clicks);
    acc.impressions = sumNullable(acc.impressions, r.impressions);
    acc.reported_conversions = sumNullable(acc.reported_conversions, r.reported_conversions);
    acc.reported_revenue_minor = sumNullable(acc.reported_revenue_minor, r.reported_revenue_minor);
  }
  return [...out.values()];
}

// --------------------------------------------------------------- connection

interface ConnectionMeta {
  grant_id?: string;
  timezone?: string;
  entities_at?: number;
  reconciled_on?: string;
  attempted_at?: number;
}

const metaOf = (c: AdConnectionRecord): ConnectionMeta => c.metadata as ConnectionMeta;

/** Metadata keys read by the edge outbound worker (`connectionSendOptions`). */
const PIXEL_KEYS: Partial<Record<AdPlatform, readonly [string, string]>> = {
  meta: ['pixel_id', 'dataset_id'],
  tiktok: ['pixel_code', 'event_source_id'],
};

function metaText(md: Record<string, unknown>, key: string): string | null {
  const v = md[key];
  return typeof v === 'string' && v !== '' ? v : null;
}

export function toAdConnection(c: AdConnectionRecord): AdConnection {
  const keys = PIXEL_KEYS[c.platform];
  return {
    id: c.id,
    platform: c.platform,
    account_id: c.account_id,
    account_name: c.account_name,
    currency: c.currency,
    status: c.status,
    last_sync_at: c.last_sync_at,
    last_error: c.last_error,
    created_at: c.created_at,
    ...(keys === undefined
      ? {}
      : {
          pixel_id: metaText(c.metadata, keys[0]) ?? metaText(c.metadata, keys[1]),
          test_event_code: metaText(c.metadata, 'test_event_code'),
        }),
  };
}

/** Sets the conversion destination of a Meta/TikTok connection; `null` clears a field. */
export async function updateAdConnectionSettings(
  ports: AdsSyncPorts,
  siteId: string,
  conn: AdConnectionRecord,
  settings: AdConnectionSettings,
): Promise<AdConnectionRecord> {
  const keys = PIXEL_KEYS[conn.platform];
  if (keys === undefined) {
    throw new AdsSyncError('invalid_settings', 'this platform takes no pixel settings');
  }
  const metadata: Record<string, unknown> = { ...conn.metadata };
  if (settings.pixel_id !== undefined) {
    delete metadata[keys[1]];
    if (settings.pixel_id === null) delete metadata[keys[0]];
    else metadata[keys[0]] = settings.pixel_id;
  }
  if (settings.test_event_code !== undefined) {
    if (settings.test_event_code === null) delete metadata.test_event_code;
    else metadata.test_event_code = settings.test_event_code;
  }
  return must(
    await adsStub(ports.ns, siteId).upsertAdConnection({
      id: conn.id,
      platform: conn.platform,
      account_id: conn.account_id,
      metadata,
    }),
  );
}

/** Stable per site: reconnecting the same account updates the same connection. */
export async function adConnectionId(platform: AdPlatform, accountId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${platform}|${accountId}`));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `adc_${hex.slice(0, 20)}`;
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function must<T>(result: AnalyticsResult<T>): T {
  if (!result.ok) throw new Error(`analytics: ${result.error.code} ${result.error.message}`);
  return result.value;
}

export interface AdConnectionAlert {
  tenantId: string;
  site: { id: string; name: string };
  connection: AdConnection;
  reason: 'auth_expired';
}

export interface AdsSyncPorts {
  ns: AnalyticsNamespace;
  clients: AdPlatformClients;
  grants: AdGrantStore;
  /** Tells the workspace a connection needs attention; must not throw. */
  notify(alert: AdConnectionAlert): Promise<void>;
  now(): number;
  /** Entity levels whose spend is pulled; default `SPEND_LEVELS`. */
  spendLevels?: readonly AdEntityLevel[];
}

export interface SiteRef {
  tenantId: string;
  id: string;
  name: string;
}

export type ConnectionOutcome = 'skipped' | 'synced' | 'retry' | 'auth_expired' | 'error';

const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 500) || 'sync failed';

async function accessTokenOf(
  ports: AdsSyncPorts,
  client: AdPlatformClient,
  site: SiteRef,
  conn: AdConnectionRecord,
): Promise<string> {
  const grantId = metaOf(conn).grant_id;
  const ref: GrantRef | null = grantId === undefined ? null : { tenantId: site.tenantId, siteId: site.id, grantId };
  const grant = ref === null ? null : await ports.grants.getGrant(ref);
  if (ref === null || grant === null) throw new ProviderError('auth_expired', 'authorization missing, reconnect the account');
  const now = ports.now();
  if (grant.expiresAt === null || grant.expiresAt - TOKEN_REFRESH_MARGIN_MS > now) return grant.accessToken;
  if (grant.refreshToken === null) {
    if (grant.expiresAt > now) return grant.accessToken;
    throw new ProviderError('auth_expired', 'access token expired');
  }
  const tokens = await client.refreshToken(grant.refreshToken);
  await ports.grants.putGrant(ref, {
    ...grant,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken ?? grant.refreshToken,
    expiresAt: tokens.expiresAt ?? null,
  });
  return tokens.accessToken;
}

/**
 * Stores the spend of [from, to] for a connection, overwriting the range: stored
 * days of the connection's entities the platform no longer reports become zero.
 * Refreshes the entity dictionary first when needed. Returns the stored rows.
 */
async function pullRange(
  ports: AdsSyncPorts,
  client: AdPlatformClient,
  token: string,
  site: SiteRef,
  conn: AdConnectionRecord,
  range: { from: string; to: string },
  meta: ConnectionMeta,
): Promise<number> {
  const stub = adsStub(ports.ns, site.id);
  const fetched: Awaited<ReturnType<AdPlatformClient['fetchSpend']>> = [];
  for (const level of ports.spendLevels ?? SPEND_LEVELS) {
    fetched.push(...(await client.fetchSpend(token, conn.account_id, { ...range, granularity: 'day', level })));
  }
  const rows = aggregateSpend(fetched).filter((r) => r.platform === conn.platform);
  const ids = [...new Set(rows.map((r) => r.entity_external_id))];
  const known =
    ids.length === 0 ? [] : await stub.listAdEntities({ platform: conn.platform, external_ids: ids });
  const now = ports.now();
  if (
    known.length < ids.length ||
    meta.entities_at === undefined ||
    now - meta.entities_at >= ENTITY_REFRESH_MS
  ) {
    const entities: AdEntity[] = (await client.listEntities(token, conn.account_id)).filter(
      (e) => e.platform === conn.platform,
    );
    if (entities.length > 0) must(await stub.upsertAdEntities(entities, conn.id));
    meta.entities_at = now;
  }
  const levels = new Set(ports.spendLevels ?? SPEND_LEVELS);
  const own = new Set(
    (await stub.listAdEntities({ platform: conn.platform }))
      .filter((e) => e.connection_id === conn.id && levels.has(e.level))
      .map((e) => e.external_id),
  );
  const fresh = new Set(rows.map((r) => `${r.entity_external_id}|${r.day}`));
  const stale: AdSpendDay[] = (await stub.listAdSpend({ ...range, platform: conn.platform }))
    .filter((r) => own.has(r.entity_external_id) && !fresh.has(`${r.entity_external_id}|${r.day}`))
    .map((r) => ({
      platform: r.platform,
      entity_external_id: r.entity_external_id,
      day: r.day,
      spend_minor: 0,
      ...(r.currency === undefined ? {} : { currency: r.currency }),
      clicks: 0,
      impressions: 0,
      reported_conversions: 0,
      reported_revenue_minor: 0,
    }));
  const all = [...rows, ...stale];
  if (all.length > 0) must(await stub.upsertAdSpend(all, conn.id));
  return rows.length;
}

async function markFailure(
  ports: AdsSyncPorts,
  site: SiteRef,
  conn: AdConnectionRecord,
  meta: ConnectionMeta,
  error: unknown,
): Promise<ConnectionOutcome> {
  const stub = adsStub(ports.ns, site.id);
  const kind = isProviderError(error) ? error.kind : 'retryable';
  const status = kind === 'auth_expired' ? 'auth_expired' : kind === 'permanent' ? 'error' : conn.status;
  const updated = must(
    await stub.upsertAdConnection({
      id: conn.id,
      platform: conn.platform,
      account_id: conn.account_id,
      status,
      last_error: errorText(error),
      metadata: { ...meta, attempted_at: ports.now() },
    }),
  );
  if (kind === 'auth_expired') {
    if (conn.status !== 'auth_expired') {
      await ports.notify({ tenantId: site.tenantId, site: { id: site.id, name: site.name }, connection: toAdConnection(updated), reason: 'auth_expired' });
    }
    return 'auth_expired';
  }
  return kind === 'permanent' ? 'error' : 'retry';
}

/**
 * One cron pass of a connection: today's spend when due, the daily
 * reconciliation of the closed days when due. Never throws for platform
 * errors (they are recorded on the connection).
 */
export async function syncAdConnection(
  ports: AdsSyncPorts,
  site: SiteRef,
  conn: AdConnectionRecord,
  options: { force?: boolean } = {},
): Promise<ConnectionOutcome> {
  if (conn.status === 'auth_expired' || conn.status === 'disconnected') return 'skipped';
  const now = ports.now();
  const meta: ConnectionMeta = { ...metaOf(conn) };
  const { day: today, hour } = dayParts(now, meta.timezone ?? 'UTC');
  const force = options.force === true;
  // Failed connections are retried hourly; a retryable failure keeps the status and retries next tick.
  if (!force && conn.status === 'error' && meta.attempted_at !== undefined && now - meta.attempted_at < SPEND_SYNC_INTERVAL_MS) {
    return 'skipped';
  }
  const spendDue = force || conn.last_sync_at === null || now - conn.last_sync_at >= SPEND_SYNC_INTERVAL_MS;
  const reconcileDue =
    meta.reconciled_on !== today && (meta.reconciled_on === undefined || hour >= RECONCILE_LOCAL_HOUR);
  if (!spendDue && !reconcileDue) return 'skipped';

  const client = ports.clients.client(conn.platform);
  if (client === null) {
    return markFailure(ports, site, conn, meta, new ProviderError('permanent', 'integration_unavailable'));
  }
  try {
    const token = await accessTokenOf(ports, client, site, conn);
    await pullRange(ports, client, token, site, conn, { from: today, to: today }, meta);
    if (reconcileDue) {
      await pullRange(
        ports,
        client,
        token,
        site,
        conn,
        { from: addDays(today, -RECONCILE_DAYS), to: addDays(today, -1) },
        meta,
      );
      meta.reconciled_on = today;
    }
    must(
      await adsStub(ports.ns, site.id).upsertAdConnection({
        id: conn.id,
        platform: conn.platform,
        account_id: conn.account_id,
        status: 'active',
        last_sync_at: now,
        last_error: null,
        metadata: { ...meta, attempted_at: now },
      }),
    );
    return 'synced';
  } catch (error) {
    return markFailure(ports, site, conn, meta, error);
  }
}

export interface AdsSyncReport {
  connections: number;
  synced: number;
  retry: number;
  authExpired: number;
  errors: number;
}

/** Every connection of the given sites (sites of other tenants or deleted ones are skipped). */
export async function syncAdsOfTenant(
  ports: AdsSyncPorts,
  tenantId: string,
  report: AdsSyncReport = { connections: 0, synced: 0, retry: 0, authExpired: 0, errors: 0 },
): Promise<AdsSyncReport> {
  for (const siteId of await tenantSitesStub(ports.ns, tenantId).indexList()) {
    try {
      const record = await siteStub(ports.ns, siteId).getSite();
      if (record === null || record.deleted || record.tenantId !== tenantId) continue;
      const site: SiteRef = { tenantId, id: siteId, name: record.site.name };
      for (const conn of await adsStub(ports.ns, siteId).listAdConnections()) {
        if (conn.status === 'disconnected') continue;
        report.connections += 1;
        const outcome = await syncAdConnection(ports, site, conn);
        if (outcome === 'synced') report.synced += 1;
        else if (outcome === 'retry') report.retry += 1;
        else if (outcome === 'auth_expired') report.authExpired += 1;
        else if (outcome === 'error') report.errors += 1;
      }
    } catch (error) {
      report.errors += 1;
      console.error(`[analytics] ads sync of site ${siteId} failed: ${errorText(error)}`);
    }
  }
  return report;
}

export async function syncAllAds(ports: AdsSyncPorts, tenantIds: readonly string[]): Promise<AdsSyncReport> {
  const report: AdsSyncReport = { connections: 0, synced: 0, retry: 0, authExpired: 0, errors: 0 };
  for (const tenantId of tenantIds) {
    try {
      await syncAdsOfTenant(ports, tenantId, report);
    } catch (error) {
      report.errors += 1;
      console.error(`[analytics] ads sync of tenant ${tenantId} failed: ${errorText(error)}`);
    }
  }
  return report;
}

// ------------------------------------------------------------------ backfill

export class AdsSyncError extends Error {
  constructor(
    readonly code:
      | 'invalid_range'
      | 'invalid_settings'
      | 'invalid_state'
      | 'no_accounts'
      | 'unavailable'
      | 'not_connected',
    message: string,
  ) {
    super(message);
  }
}

/** Manual re-pull of up to `BACKFILL_MAX_DAYS` closed or current days; throws `ProviderError` / `AdsSyncError`. */
export async function backfillAdConnection(
  ports: AdsSyncPorts,
  site: SiteRef,
  conn: AdConnectionRecord,
  range: { from: string; to: string },
): Promise<{ from: string; to: string; rows: number }> {
  const meta: ConnectionMeta = { ...metaOf(conn) };
  const today = localDay(ports.now(), meta.timezone ?? 'UTC');
  if (range.from > range.to || range.to > today || dayCount(range.from, range.to) > BACKFILL_MAX_DAYS) {
    throw new AdsSyncError('invalid_range', `from <= to <= ${today}, at most ${String(BACKFILL_MAX_DAYS)} days`);
  }
  if (conn.status === 'disconnected') throw new AdsSyncError('not_connected', 'connection is disconnected');
  const client = ports.clients.client(conn.platform);
  if (client === null) throw new AdsSyncError('unavailable', 'integration_unavailable');
  try {
    const token = await accessTokenOf(ports, client, site, conn);
    const rows = await pullRange(ports, client, token, site, conn, range, meta);
    must(
      await adsStub(ports.ns, site.id).upsertAdConnection({
        id: conn.id,
        platform: conn.platform,
        account_id: conn.account_id,
        status: 'active',
        last_error: null,
        metadata: { ...meta },
      }),
    );
    return { ...range, rows };
  } catch (error) {
    if (isProviderError(error)) await markFailure(ports, site, conn, meta, error);
    throw error;
  }
}

// --------------------------------------------------------------------- OAuth

export async function startAdsConnect(
  ports: Pick<AdsSyncPorts, 'clients' | 'grants' | 'now'>,
  input: { tenantId: string; tenantSlug: string; siteId: string; platform: AdPlatform; redirectUri: string },
): Promise<{ authorizeUrl: string; state: string }> {
  const client = ports.clients.client(input.platform);
  if (client === null) throw new AdsSyncError('unavailable', 'integration_unavailable');
  // The slug lets the fixed redirect page find the workspace that started the flow.
  const state = `${input.tenantSlug}.${randomId()}`;
  await ports.grants.putState(state, {
    tenantId: input.tenantId,
    siteId: input.siteId,
    platform: input.platform,
    redirectUri: input.redirectUri,
    expiresAt: ports.now() + STATE_TTL_MS,
  });
  return { authorizeUrl: client.authorizeUrl({ redirectUri: input.redirectUri, state }), state };
}

async function releaseGrantIfUnused(ports: AdsSyncPorts, siteId: string, grantId: string | undefined): Promise<void> {
  if (grantId === undefined) return;
  const inUse = (await adsStub(ports.ns, siteId).listAdConnections()).some(
    (c) => c.status !== 'disconnected' && metaOf(c).grant_id === grantId,
  );
  if (!inUse) await ports.grants.deleteGrant(grantId);
}

/**
 * Exchanges the code, stores the grant and creates (or re-activates) one
 * connection per ad account of the grant (`accountIds` narrows the set).
 */
export async function finishAdsConnect(
  ports: AdsSyncPorts,
  input: {
    tenantId: string;
    siteId: string;
    platform: AdPlatform;
    state: string;
    code: string;
    accountIds?: readonly string[] | undefined;
  },
): Promise<AdConnectionRecord[]> {
  const pending = await ports.grants.takeState(input.state);
  if (
    pending === null ||
    pending.tenantId !== input.tenantId ||
    pending.siteId !== input.siteId ||
    pending.platform !== input.platform
  ) {
    throw new AdsSyncError('invalid_state', 'invalid or expired authorization');
  }
  const client = ports.clients.client(input.platform);
  if (client === null) throw new AdsSyncError('unavailable', 'integration_unavailable');
  const tokens = await client.exchangeCode({ code: input.code, redirectUri: pending.redirectUri });
  const wanted = input.accountIds === undefined ? null : new Set(input.accountIds);
  const accounts = (await client.listAccounts(tokens.accessToken))
    .filter((a) => wanted === null || wanted.has(a.account_id))
    .slice(0, MAX_ACCOUNTS_PER_CONNECT);
  if (accounts.length === 0) throw new AdsSyncError('no_accounts', 'no ad account available for this authorization');

  const grantId = `ag_${randomId()}`;
  await ports.grants.putGrant(
    { tenantId: input.tenantId, siteId: input.siteId, grantId },
    {
      tenantId: input.tenantId,
      siteId: input.siteId,
      platform: input.platform,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? null,
      expiresAt: tokens.expiresAt ?? null,
    },
  );
  const stub = adsStub(ports.ns, input.siteId);
  const created: AdConnectionRecord[] = [];
  const previousGrants = new Set<string>();
  for (const account of accounts) {
    const id = await adConnectionId(input.platform, account.account_id);
    const current = await stub.getAdConnection(id);
    const previous = current === null ? undefined : metaOf(current).grant_id;
    if (previous !== undefined) previousGrants.add(previous);
    created.push(
      must(
        await stub.upsertAdConnection({
          id,
          platform: input.platform,
          account_id: account.account_id,
          account_name: account.name,
          currency: /^[A-Z]{3}$/.test(account.currency) ? account.currency : null,
          status: 'active',
          last_error: null,
          metadata: { ...(current === null ? {} : metaOf(current)), grant_id: grantId, timezone: account.timezone },
        }),
      ),
    );
  }
  for (const previous of previousGrants) await releaseGrantIfUnused(ports, input.siteId, previous);
  return created;
}

/** Stops syncing (data already synced is kept) and drops the grant once no connection uses it. */
export async function disconnectAdConnection(
  ports: AdsSyncPorts,
  siteId: string,
  conn: AdConnectionRecord,
): Promise<AdConnectionRecord> {
  const { grant_id: grantId, ...rest } = metaOf(conn);
  const updated = must(
    await adsStub(ports.ns, siteId).upsertAdConnection({
      id: conn.id,
      platform: conn.platform,
      account_id: conn.account_id,
      status: 'disconnected',
      last_error: null,
      metadata: rest as Record<string, unknown>,
    }),
  );
  await releaseGrantIfUnused(ports, siteId, grantId);
  return updated;
}

// ------------------------------------------------- tokens for the edge worker

/** Gateway op of the edge outbound queue (same name and shapes as the edge's `AnalyticsGatewayOps`). */
export const ADS_TOKEN_GATEWAY_OP = 'analytics.adsToken';

export const adsTokenInputSchema = z.strictObject({
  tenant_id: z.string().min(1).max(64),
  site_id: z.string().min(1).max(64),
  connection_id: z.string().min(1).max(64),
});
export type AdsTokenInput = z.infer<typeof adsTokenInputSchema>;

export type AdsTokenOutput = {
  platform: AdPlatform;
  access_token: string;
  developer_token?: string | null;
  login_customer_id?: string | null;
  api_version?: string | null;
} | null;

/**
 * Access token of a connection (refreshed and saved first when close to its
 * expiry). Null for an unknown site / connection, another tenant's site or a
 * disconnected connection; throws `ProviderError` `auth_expired` (connection
 * marked) when the authorization is gone.
 */
export async function adsTokenForConnection(
  ports: AdsSyncPorts,
  input: AdsTokenInput,
  extras: (platform: AdPlatform) => Omit<NonNullable<AdsTokenOutput>, 'platform' | 'access_token'> = () => ({}),
): Promise<AdsTokenOutput> {
  const record = await siteStub(ports.ns, input.site_id).getSite();
  if (record === null || record.deleted || record.tenantId !== input.tenant_id) return null;
  const conn = await adsStub(ports.ns, input.site_id).getAdConnection(input.connection_id);
  if (conn === null || conn.status === 'disconnected') return null;
  const site: SiteRef = { tenantId: input.tenant_id, id: input.site_id, name: record.site.name };
  if (conn.status === 'auth_expired') throw new ProviderError('auth_expired', conn.last_error ?? 'authorization expired');
  const client = ports.clients.client(conn.platform);
  if (client === null) return null;
  try {
    const token = await accessTokenOf(ports, client, site, conn);
    return { platform: conn.platform, access_token: token, ...extras(conn.platform) };
  } catch (error) {
    if (isProviderError(error) && error.kind === 'auth_expired') {
      await markFailure(ports, site, conn, { ...metaOf(conn) }, error);
    }
    throw error;
  }
}

// ------------------------------------------------------------------- runtime

const ALERT_ROLES = ['owner', 'admin'];

export function adConnectionAlertEmail(alert: AdConnectionAlert, to: string, appOrigin: string): SystemEmail {
  const account = alert.connection.account_name ?? alert.connection.account_id;
  const what = `The ${alert.connection.platform} ad account "${account}" of ${alert.site.name} needs to be reconnected: its authorization expired or was revoked. Spend sync is paused until then.`;
  const link = `${appOrigin.replace(/\/+$/, '')}/`;
  const esc = (s: string) =>
    s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);
  return {
    to,
    subject: `[amabledata] Reconnect ${alert.connection.platform} ads on ${alert.site.name}`,
    text: `${what}\n\n${link}`,
    html: `<p>${esc(what)}</p><p><a href="${esc(link)}">amabledata</a></p>`,
    locale: 'en',
  };
}

export function adsRedirectUri(env: Env, fallbackOrigin?: string): string {
  const configured = (env as Env & { ADS_OAUTH_REDIRECT_URI?: string }).ADS_OAUTH_REDIRECT_URI?.trim() ?? '';
  if (configured !== '') return configured;
  const origin = (env.APP_ORIGIN ?? fallbackOrigin ?? 'http://localhost:5173').replace(/\/+$/, '');
  return `${origin}/oauth/ads/callback`;
}

export function adsSyncPorts(env: Env, ns: AnalyticsNamespace, now: () => number = Date.now): AdsSyncPorts {
  const appOrigin = (env.APP_ORIGIN ?? 'http://localhost:5173').replace(/\/+$/, '');
  return {
    ns,
    clients: adPlatformClientsFor(env as Env & AdPlatformSecretsEnv, { now }),
    grants: kvAdGrantStore(d1OAuthStore(env.DB), authSealer(env), now),
    async notify(alert) {
      try {
        const rows = await env.DB.prepare(
          `SELECT lower(u.email) AS email FROM users u JOIN memberships m ON m.user_id = u.id
           WHERE m.tenant_id = ? AND m.role IN (SELECT value FROM json_each(?))`,
        )
          .bind(alert.tenantId, JSON.stringify(ALERT_ROLES))
          .all<{ email: string }>();
        const email = (await getAuthServices(env)).email;
        for (const { email: to } of rows.results) await email.send(adConnectionAlertEmail(alert, to, appOrigin));
      } catch (error) {
        console.error(`[analytics] ads alert of ${alert.connection.id} failed: ${errorText(error)}`);
      }
    },
    now,
  };
}

/** `analytics.adsToken` of the signed edge gateway (installation op, the tenant travels in the input). */
export async function handleAdsTokenOp(
  env: Env,
  input: unknown,
): Promise<{ status: number; body: GatewayResponse<AdsTokenOutput> }> {
  const fail = (status: number, code: string, message: string) => ({
    status,
    body: { ok: false as const, error: { code, status, message } },
  });
  const parsed = adsTokenInputSchema.safeParse(input);
  if (!parsed.success) return fail(400, 'bad_request', 'invalid ads token request');
  const ns = env.ANALYTICS;
  if (ns === undefined) return fail(503, 'analytics_unavailable', 'analytics is not deployed');
  const tenant = await env.DB.prepare(`SELECT id, slug, name FROM tenants WHERE id = ?`)
    .bind(parsed.data.tenant_id)
    .first<GatewayTenantInfo>();
  if (tenant === null) return fail(404, 'not_found', 'tenant not found');
  const ports = adsSyncPorts(env, ns);
  try {
    const value = await adsTokenForConnection(ports, parsed.data, (platform) => {
      if (ports.clients.fake || platform !== 'google') return {};
      const credentials = adPlatformCredentials(env as Env & AdPlatformSecretsEnv, 'google');
      return {
        developer_token: credentials?.developerToken ?? null,
        login_customer_id: credentials?.loginCustomerId ?? null,
      };
    });
    return { status: 200, body: { ok: true, tenant, value } };
  } catch (error) {
    if (isProviderError(error) && error.kind === 'auth_expired') return fail(409, 'auth_expired', errorText(error));
    if (isProviderError(error)) return fail(503, 'provider_unavailable', errorText(error));
    console.error(`[analytics] ads token of ${parsed.data.connection_id} failed: ${errorText(error)}`);
    return fail(500, 'internal_error', 'internal error');
  }
}

/** Cron entry point (every tick; per-connection guards decide what runs). Never throws. */
export async function runScheduledAdsSync(env: Env): Promise<AdsSyncReport | null> {
  const ns = env.ANALYTICS;
  if (ns === undefined) return null;
  try {
    const tenants = await env.DB.prepare(`SELECT id FROM tenants`).all<{ id: string }>();
    return await syncAllAds(adsSyncPorts(env, ns), tenants.results.map((t) => t.id));
  } catch (error) {
    console.error(`[analytics] ads sync failed: ${errorText(error)}`);
    return null;
  }
}
