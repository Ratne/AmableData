import { z } from '@hono/zod-openapi';
import {
  createTrackingDomainSchema,
  TRACKING_DOMAIN_CHECK_PATH,
  TRACKING_DOMAIN_CHECK_SERVICE,
  trackingDomainOptionsSchema,
  trackingDomainSchema,
  type GatewayTenantInfo,
  type TrackingDomain,
  type TrackingDomainKind,
  type TrackingDomainStatus,
} from '@amable/api-types';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { monotonicFactory } from 'ulid';
import { crmRoute, json, jsonBody } from '../crm/api/core';
import { CrmError } from '../crm/errors';
import type { Env } from '../env';
import { audit, getTenant, HttpError, type AppEnv } from '../middleware';
import {
  customHostnames,
  CustomHostnameError,
  trackingCnameTarget,
  type CustomHostnameProvider,
  type CustomHostnameState,
} from '../platform/custom-hostnames';
import { siteIdParam, siteRecord } from './service';

/**
 * Custom tracking hostnames per site (`track.customer.com` → edge worker).
 * Rows live in the installation D1 (`tracking_domains`), which is also the
 * global hostname → (tenant, site) index the edge resolves through the gateway.
 */

type Ctx = Context<AppEnv>;

const tags = ['Analytics'];
const siteQuery = z.object({ site_id: z.string().min(1).max(64) });
const idParam = z.object({ id: z.string().min(1).max(64) });
const nextId = monotonicFactory();

/** Gateway op answered by the core worker for the edge (see `apps/edge/src/analytics/tracking-domains.ts`). */
export const TRACKING_HOST_GATEWAY_OP = 'analytics.tracking_host';

/** Never connectable as a tracking hostname (exact or any subdomain). */
const RESERVED_SUFFIXES = [
  'localhost',
  'local',
  'internal',
  'invalid',
  'example',
  'arpa',
  'workers.dev',
  'pages.dev',
  'cloudflare.com',
  'cloudflare.net',
  'cloudflare-dns.com',
] as const;

interface TrackingDomainRow {
  id: string;
  tenant_id: string;
  site_id: string;
  hostname: string;
  kind: TrackingDomainKind;
  status: TrackingDomainStatus;
  provider_id: string | null;
  cname_target: string;
  txt_name: string | null;
  txt_value: string | null;
  error: string | null;
  created_at: number;
  checked_at: number | null;
  activated_at: number | null;
}

function toTrackingDomain(row: TrackingDomainRow): TrackingDomain {
  return {
    id: row.id,
    site_id: row.site_id,
    hostname: row.hostname,
    kind: row.kind,
    status: row.status,
    dns: {
      cname_name: row.hostname,
      cname_target: row.cname_target,
      txt_name: row.txt_name,
      txt_value: row.txt_value,
    },
    error: row.error,
    created_at: row.created_at,
    checked_at: row.checked_at,
  };
}

function hostOf(origin: string | undefined): string | null {
  if (origin === undefined || origin === '') return null;
  try {
    return new URL(origin).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

const covers = (base: string, host: string): boolean => host === base || host.endsWith(`.${base}`);

/** Hostnames of the installation itself (app, API, edge, CNAME target) and well-known reserved names. */
export function isReservedTrackingHost(env: Env, hostname: string, cnameTarget: string): boolean {
  if (RESERVED_SUFFIXES.some((suffix) => covers(suffix, hostname))) return true;
  const platform = [
    hostOf(env.APP_ORIGIN),
    hostOf(env.EDGE_ORIGIN),
    env.EDGE_HOSTNAME?.toLowerCase() ?? null,
    cnameTarget,
  ];
  return platform.some((host) => host !== null && host !== '' && covers(host, hostname));
}

function provider(c: Ctx): CustomHostnameProvider {
  const found = customHostnames(c.env);
  if (found === null) throw new HttpError(503, 'tracking_domains_unavailable');
  return found;
}

function providerFailure(error: unknown): HttpError {
  const message =
    error instanceof CustomHostnameError ? error.message : 'custom hostname provider failed';
  return new HttpError(502, 'tracking_domain_provider_error', { message: message.slice(0, 300) });
}

async function rowOf(c: Ctx, id: string): Promise<TrackingDomainRow> {
  const row = await c.env.DB.prepare(
    `SELECT * FROM tracking_domains WHERE id = ? AND tenant_id = ?`,
  )
    .bind(id, getTenant(c).tenant.id)
    .first<TrackingDomainRow>();
  if (row === null) throw new CrmError('not_found', 'tracking domain not found');
  return row;
}

async function applyState(
  c: Ctx,
  row: TrackingDomainRow,
  state: CustomHostnameState | null,
): Promise<TrackingDomainRow> {
  await writeState(c.env.DB, c.get('services').now(), row, state);
  return rowOf(c, row.id);
}

async function writeState(
  db: D1Database,
  now: number,
  row: TrackingDomainRow,
  state: CustomHostnameState | null,
): Promise<void> {
  const status: TrackingDomainStatus = state === null ? 'error' : state.status;
  const error = state === null ? 'hostname_unknown_to_provider' : state.error;
  await db.prepare(
    `UPDATE tracking_domains
       SET status = ?, provider_id = COALESCE(?, provider_id), txt_name = COALESCE(?, txt_name),
           txt_value = COALESCE(?, txt_value), error = ?, checked_at = ?,
           activated_at = CASE WHEN ? = 'active' THEN COALESCE(activated_at, ?) ELSE activated_at END
     WHERE id = ? AND tenant_id = ?`,
  )
    .bind(
      status,
      state?.id ?? null,
      state?.txtName ?? null,
      state?.txtValue ?? null,
      error,
      now,
      status,
      now,
      row.id,
      row.tenant_id,
    )
    .run();
}

// ------------------------------------------------------------- zone domains

/** Outcome of probing a `zone` domain (no `pending_ssl`: the zone's own certificate applies). */
export interface ZoneProbeResult {
  status: 'active' | 'pending_dns' | 'error';
  error: string | null;
}

type ZoneProbe = (hostname: string) => Promise<ZoneProbeResult>;

let zoneProbeOverride: ZoneProbe | null = null;

/** Test hook. */
export function overrideZoneProbe(next: ZoneProbe | null): void {
  zoneProbeOverride = next;
}

const ZONE_PROBE_TIMEOUT_MS = 8_000;

/**
 * A `zone` domain is verified by fetching the edge marker endpoint on it: DNS,
 * proxy and certificate come from the zone itself, so one successful answer
 * from the right worker is the whole proof. Network failures stay `pending_dns`
 * (record missing or not propagated); a wrong answer is a config `error`
 * (another service, or the worker route is missing).
 */
export async function probeZoneDomain(
  fetchFn: (input: string, init?: RequestInit) => Promise<Response>,
  hostname: string,
): Promise<ZoneProbeResult> {
  let response: Response;
  try {
    response = await fetchFn(`https://${hostname}${TRACKING_DOMAIN_CHECK_PATH}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(ZONE_PROBE_TIMEOUT_MS),
    });
  } catch {
    return { status: 'pending_dns', error: 'hostname_unreachable' };
  }
  if (response.ok) {
    const body = (await response.json().catch(() => null)) as { service?: string } | null;
    if (body?.service === TRACKING_DOMAIN_CHECK_SERVICE) return { status: 'active', error: null };
  }
  return { status: 'error', error: `not_tracking_worker (HTTP ${String(response.status)})` };
}

/** In dev the probe succeeds immediately, like the fake custom hostname provider. */
function zoneProbe(env: Env): ZoneProbe {
  if (zoneProbeOverride !== null) return zoneProbeOverride;
  if (env.ENVIRONMENT === 'dev') return () => Promise.resolve({ status: 'active', error: null });
  return (hostname) => probeZoneDomain((input, init) => fetch(input, init), hostname);
}

async function writeZoneState(
  db: D1Database,
  now: number,
  row: TrackingDomainRow,
  result: ZoneProbeResult,
): Promise<void> {
  await db
    .prepare(
      `UPDATE tracking_domains
         SET status = ?, error = ?, checked_at = ?,
             activated_at = CASE WHEN ? = 'active' THEN COALESCE(activated_at, ?) ELSE activated_at END
       WHERE id = ? AND tenant_id = ?`,
    )
    .bind(result.status, result.error, now, result.status, now, row.id, row.tenant_id)
    .run();
}

/** Marks a domain whose site is gone and whose custom hostname could not be removed yet. */
const SITE_DELETED = 'site_deleted';

async function removeRow(db: D1Database, row: TrackingDomainRow): Promise<void> {
  await db.prepare(`DELETE FROM tracking_domains WHERE id = ? AND tenant_id = ?`).bind(row.id, row.tenant_id).run();
}

/**
 * Disconnects every tracking domain of a deleted site: the custom hostname is
 * removed at the provider, then the row. When the provider is unavailable or
 * fails, the row stays as `error` / `site_deleted` (no longer resolved by the
 * edge) and the cron retries the removal.
 */
export async function removeSiteTrackingDomains(
  env: Env,
  tenantId: string,
  siteId: string,
  now: number,
): Promise<{ removed: number; deferred: number }> {
  const rows = await env.DB.prepare(`SELECT * FROM tracking_domains WHERE tenant_id = ? AND site_id = ?`)
    .bind(tenantId, siteId)
    .all<TrackingDomainRow>();
  const hostnames = rows.results.some((r) => r.provider_id !== null) ? customHostnames(env) : null;
  let removed = 0;
  let deferred = 0;
  for (const row of rows.results) {
    if (row.provider_id !== null) {
      try {
        if (hostnames === null) throw new CustomHostnameError('provider unavailable');
        await hostnames.delete(row.provider_id);
      } catch {
        await env.DB.prepare(
          `UPDATE tracking_domains SET status = 'error', error = ?, checked_at = ? WHERE id = ? AND tenant_id = ?`,
        )
          .bind(SITE_DELETED, now, row.id, row.tenant_id)
          .run();
        deferred += 1;
        continue;
      }
    }
    await removeRow(env.DB, row);
    removed += 1;
  }
  return { removed, deferred };
}

/** Per cron tick: at most this many provider calls, each domain re-checked at most every interval. */
export const TRACKING_DOMAIN_CHECKS_PER_TICK = 5;
export const TRACKING_DOMAIN_RECHECK_MS = 10 * 60_000;
/** Domains in `error` usually wait for a DNS fix, so they are re-checked less often. */
export const TRACKING_DOMAIN_ERROR_RECHECK_MS = 60 * 60_000;

/**
 * Cron: finishes the removals deferred by a site deletion, then refreshes the
 * status of the pending and failed domains least recently checked, so a domain
 * becomes active (or recovers) without the customer pressing "check".
 */
export async function runScheduledTrackingDomains(
  env: Env,
  now: number,
): Promise<{ removed: number; checked: number }> {
  // `zone` domains are verified without it; only custom hostnames need the provider.
  const hostnames = customHostnames(env);
  const probe = zoneProbe(env);
  let budget = TRACKING_DOMAIN_CHECKS_PER_TICK;
  let removed = 0;
  let checked = 0;
  const orphans = await env.DB.prepare(
    `SELECT * FROM tracking_domains WHERE status = 'error' AND error = ? ORDER BY checked_at, id LIMIT ?`,
  )
    .bind(SITE_DELETED, budget)
    .all<TrackingDomainRow>();
  for (const row of orphans.results) {
    budget -= 1;
    try {
      if (row.provider_id !== null) {
        if (hostnames === null) throw new CustomHostnameError('provider unavailable');
        await hostnames.delete(row.provider_id);
      }
      await removeRow(env.DB, row);
      removed += 1;
    } catch (error) {
      await env.DB.prepare(`UPDATE tracking_domains SET checked_at = ? WHERE id = ?`).bind(now, row.id).run();
      console.error(`[tracking-domains] removal of ${row.hostname} failed: ${String(error)}`);
    }
  }
  if (budget <= 0) return { removed, checked };
  const pending = await env.DB.prepare(
    `SELECT * FROM tracking_domains
      WHERE (status IN ('pending_dns', 'pending_ssl') AND (checked_at IS NULL OR checked_at <= ?))
         OR (status = 'error' AND COALESCE(error, '') <> ? AND (checked_at IS NULL OR checked_at <= ?))
      ORDER BY COALESCE(checked_at, 0), id LIMIT ?`,
  )
    .bind(now - TRACKING_DOMAIN_RECHECK_MS, SITE_DELETED, now - TRACKING_DOMAIN_ERROR_RECHECK_MS, budget)
    .all<TrackingDomainRow>();
  for (const row of pending.results) {
    try {
      if (row.kind === 'zone') {
        await writeZoneState(env.DB, now, row, await probe(row.hostname));
      } else if (hostnames !== null) {
        const state =
          row.provider_id === null ? await hostnames.create(row.hostname) : await hostnames.get(row.provider_id);
        await writeState(env.DB, now, row, state);
      } else {
        // No provider for a `cname` row: yield the selection window to the others.
        await env.DB.prepare(`UPDATE tracking_domains SET checked_at = ? WHERE id = ?`).bind(now, row.id).run();
        continue;
      }
      checked += 1;
    } catch (error) {
      await env.DB.prepare(`UPDATE tracking_domains SET checked_at = ? WHERE id = ?`).bind(now, row.id).run();
      console.error(`[tracking-domains] check of ${row.hostname} failed: ${String(error)}`);
    }
  }
  return { removed, checked };
}

async function hostnameTaken(env: Env, hostname: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS taken FROM tracking_domains WHERE hostname = ?
     UNION ALL SELECT 1 AS taken FROM domains WHERE hostname = ? LIMIT 1`,
  )
    .bind(hostname, hostname)
    .first<{ taken: number }>();
  return row !== null;
}

/** Active tracking hostname → owning tenant and site (edge gateway lookup). */
export async function findTrackingHost(
  db: D1Database,
  hostname: string,
): Promise<{ tenant: GatewayTenantInfo; site_id: string } | null> {
  const row = await db
    .prepare(
      `SELECT t.id AS id, t.slug AS slug, t.name AS name, d.site_id AS site_id
         FROM tracking_domains d JOIN tenants t ON t.id = d.tenant_id
        WHERE d.hostname = ? AND d.status = 'active'`,
    )
    .bind(hostname.toLowerCase().replace(/\.$/, ''))
    .first<{ id: string; slug: string; name: string; site_id: string }>();
  if (row === null) return null;
  return { tenant: { id: row.id, slug: row.slug, name: row.name }, site_id: row.site_id };
}

/** Tracking domains of a site: list, connect, read, check with the provider, delete. */
export function registerTrackingDomainRoutes(api: OpenAPIHono<AppEnv>): void {
  api.openapi(
    crmRoute('analytics:read', {
      method: 'get',
      path: '/tracking-domains',
      tags,
      summary: 'Custom tracking domains of a site',
      request: { query: siteQuery },
      responses: {
        200: json(
          z.object({ data: z.array(trackingDomainSchema), options: trackingDomainOptionsSchema }),
          'Tracking domains',
        ),
      },
    }),
    async (c) => {
      const siteId = siteIdParam(c);
      await siteRecord(c, siteId);
      const rows = await c.env.DB.prepare(
        `SELECT * FROM tracking_domains WHERE tenant_id = ? AND site_id = ? ORDER BY created_at, id`,
      )
        .bind(getTenant(c).tenant.id, siteId)
        .all<TrackingDomainRow>();
      const hostnames = customHostnames(c.env);
      return c.json(
        {
          data: rows.results.map(toTrackingDomain),
          options: {
            cname_available: hostnames !== null,
            target: hostnames?.cnameTarget ?? trackingCnameTarget(c.env),
          },
        },
        200,
      );
    },
  );

  api.openapi(
    crmRoute('analytics:configure', {
      method: 'post',
      path: '/tracking-domains',
      tags,
      summary: 'Connect a custom tracking hostname to a site',
      description:
        'The customer then creates a CNAME to `dns.cname_target` (and the TXT record when shown); `POST /tracking-domains/{id}/check` refreshes the status. A hostname belongs to one site of one workspace: duplicates answer 409.',
      request: { body: jsonBody(createTrackingDomainSchema) },
      responses: { 201: json(trackingDomainSchema, 'The tracking domain') },
    }),
    async (c) => {
      const input = c.req.valid('json');
      const hostname = input.hostname.replace(/\.$/, '');
      await siteRecord(c, input.site_id);
      // `zone` domains need no provider: the zone of the account serves them.
      const hostnames = input.kind === 'cname' ? provider(c) : null;
      const target = hostnames?.cnameTarget ?? trackingCnameTarget(c.env);
      if (isReservedTrackingHost(c.env, hostname, target)) {
        throw new CrmError(
          'validation_failed',
          'this hostname cannot be used as a tracking domain',
          [{ path: 'hostname', message: 'reserved hostname' }],
        );
      }
      if (await hostnameTaken(c.env, hostname))
        throw new CrmError('conflict', 'hostname already connected');
      const tenantId = getTenant(c).tenant.id;
      const id = `td_${nextId().toLowerCase()}`;
      try {
        await c.env.DB.prepare(
          `INSERT INTO tracking_domains (id, tenant_id, site_id, hostname, kind, status, cname_target, created_at)
           VALUES (?, ?, ?, ?, ?, 'pending_dns', ?, ?)`,
        )
          .bind(id, tenantId, input.site_id, hostname, input.kind, target, c.get('services').now())
          .run();
      } catch (error) {
        if (error instanceof Error && /UNIQUE/i.test(error.message)) {
          throw new CrmError('conflict', 'hostname already connected');
        }
        throw error;
      }
      if (hostnames === null) {
        const now = c.get('services').now();
        await writeZoneState(c.env.DB, now, await rowOf(c, id), await zoneProbe(c.env)(hostname));
      } else {
        let state: CustomHostnameState;
        try {
          state = await hostnames.create(hostname);
        } catch (error) {
          await c.env.DB.prepare(`DELETE FROM tracking_domains WHERE id = ?`).bind(id).run();
          throw providerFailure(error);
        }
        await applyState(c, await rowOf(c, id), state);
      }
      const row = await rowOf(c, id);
      await audit(c, 'analytics.tracking_domain_created', {
        target: id,
        details: { hostname, site_id: input.site_id, kind: input.kind },
      });
      return c.json(toTrackingDomain(row), 201);
    },
  );

  api.openapi(
    crmRoute('analytics:read', {
      method: 'get',
      path: '/tracking-domains/{id}',
      tags,
      summary: 'Get a tracking domain',
      request: { params: idParam },
      responses: { 200: json(trackingDomainSchema, 'The tracking domain') },
    }),
    async (c) => c.json(toTrackingDomain(await rowOf(c, c.req.valid('param').id)), 200),
  );

  api.openapi(
    crmRoute('analytics:configure', {
      method: 'post',
      path: '/tracking-domains/{id}/check',
      tags,
      summary: 'Refresh the DNS / certificate status of a tracking domain',
      request: { params: idParam },
      responses: { 200: json(trackingDomainSchema, 'The tracking domain') },
    }),
    async (c) => {
      const row = await rowOf(c, c.req.valid('param').id);
      if (row.kind === 'zone') {
        await writeZoneState(c.env.DB, c.get('services').now(), row, await zoneProbe(c.env)(row.hostname));
        return c.json(toTrackingDomain(await rowOf(c, row.id)), 200);
      }
      const hostnames = provider(c);
      let state: CustomHostnameState | null;
      try {
        state =
          row.provider_id === null
            ? await hostnames.create(row.hostname)
            : await hostnames.get(row.provider_id);
      } catch (error) {
        throw providerFailure(error);
      }
      return c.json(toTrackingDomain(await applyState(c, row, state)), 200);
    },
  );

  api.openapi(
    crmRoute('analytics:configure', {
      method: 'delete',
      path: '/tracking-domains/{id}',
      tags,
      summary: 'Disconnect a tracking domain',
      request: { params: idParam },
      responses: { 200: json(z.object({ id: z.string(), deleted: z.literal(true) }), 'Deleted') },
    }),
    async (c) => {
      const row = await rowOf(c, c.req.valid('param').id);
      if (row.provider_id !== null) {
        try {
          await provider(c).delete(row.provider_id);
        } catch (error) {
          throw error instanceof HttpError ? error : providerFailure(error);
        }
      }
      await c.env.DB.prepare(`DELETE FROM tracking_domains WHERE id = ? AND tenant_id = ?`)
        .bind(row.id, row.tenant_id)
        .run();
      await audit(c, 'analytics.tracking_domain_deleted', {
        target: row.id,
        details: { hostname: row.hostname },
      });
      return c.json({ id: row.id, deleted: true as const }, 200);
    },
  );
}
