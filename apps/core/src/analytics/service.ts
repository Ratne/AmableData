import {
  ANALYTICS_FILTER_DIMENSIONS,
  type AnalyticsFilter,
  type AnalyticsFilterDimension,
  type AnalyticsQueryParams,
  type AnalyticsRange,
  type CreateSiteInput,
  type Site,
  type SiteSnippet,
  type SiteKey,
  type SiteKeyScope,
  type SiteWithSecret,
  type UpdateSiteInput,
} from '@amable/api-types';
import {
  newSiteId,
  newSiteKey,
  newSiteSecret,
  siteStub,
  SITE_ID_RE,
  tenantSitesStub,
  type AnalyticsNamespace,
  type AnalyticsResult,
  type SiteRecord,
} from '@amable/app-edge/analytics';
import type { Context, MiddlewareHandler } from 'hono';
import { actorOf } from '../crm/api/core';
import { CrmError } from '../crm/errors';
import type { CrmResult } from '../crm/ops';
import { getTenant, HttpError, jsonError, tenantDb, type AppEnv } from '../middleware';

type Ctx = Context<AppEnv>;

const EDGE_UNREACHABLE_RE =
  /Worker "[^"]*" not found|Network connection lost|script[^.]* (not found|does not exist)|Durable Object namespace .* not found/i;

/** The AnalyticsDO binding exists but the edge worker behind it cannot be reached. */
export function isEdgeUnreachable(error: unknown): boolean {
  return error instanceof Error && EDGE_UNREACHABLE_RE.test(error.message);
}

/**
 * Turns "edge worker not running / not deployed" failures of the cross-script
 * AnalyticsDO binding into 503 `analytics_unavailable` (reason `edge_unreachable`)
 * instead of an opaque 500, so the UI can say what to do.
 */
export function edgeUnreachableAs503(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    if (c.error === undefined || !isEdgeUnreachable(c.error)) return;
    c.res = undefined;
    c.res = jsonError(c, 503, 'analytics_unavailable', { reason: 'edge_unreachable' });
  };
}

/** The edge worker's AnalyticsDO namespace (cross-script binding). */
export function namespace(c: Ctx): AnalyticsNamespace {
  const ns = c.env.ANALYTICS;
  if (ns === undefined) throw new HttpError(503, 'analytics_unavailable');
  return ns;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Public origin of the edge worker (tracking subdomain of the customer zone). */
export function edgeOrigin(c: Ctx): string {
  return (c.env.EDGE_ORIGIN ?? 'http://localhost:8788').replace(/\/+$/, '');
}

export function snippetFor(site: Pick<Site, 'id' | 'cookieless'>, origin: string): SiteSnippet {
  const scripts = {
    default: `${origin}/s.js`,
    cookieless: `${origin}/s.cookieless.js`,
    hash: `${origin}/s.hash.js`,
  };
  const src = site.cookieless ? scripts.cookieless : scripts.default;
  const html = [
    '<script>window.amable=window.amable||function(){(window.amable.q=window.amable.q||[]).push(arguments)};</script>',
    `<script defer data-site="${site.id}" src="${src}"></script>`,
  ].join('\n');
  return { site_id: site.id, html, scripts, server_endpoint: `${origin}/e/server` };
}

/** Site of the verified tenant; any other site (or a deleted one) is a 404. */
export async function siteRecord(c: Ctx, siteId: string): Promise<SiteRecord> {
  if (!SITE_ID_RE.test(siteId)) throw new CrmError('not_found', 'site not found');
  const record = await siteStub(namespace(c), siteId).getSite();
  if (record === null || record.deleted || record.tenantId !== getTenant(c).tenant.id) {
    throw new CrmError('not_found', 'site not found');
  }
  return record;
}

export async function listSites(c: Ctx): Promise<Site[]> {
  const ns = namespace(c);
  const ids = await tenantSitesStub(ns, getTenant(c).tenant.id).indexList();
  const records = await Promise.all(ids.map((id) => siteStub(ns, id).getSite()));
  const sites: Site[] = [];
  for (const r of records) {
    if (r !== null && !r.deleted && r.tenantId === getTenant(c).tenant.id) sites.push(r.site);
  }
  return sites;
}

export async function getSite(c: Ctx, siteId: string): Promise<Site> {
  return (await siteRecord(c, siteId)).site;
}

export async function createSite(c: Ctx, input: CreateSiteInput): Promise<SiteWithSecret> {
  const ns = namespace(c);
  const tenantId = getTenant(c).tenant.id;
  const siteId = newSiteId();
  const secret = newSiteSecret(siteId);
  const record = await siteStub(ns, siteId).initSite({
    siteId,
    tenantId,
    name: input.name,
    hostnames: [...new Set(input.hostnames)],
    cookieless: input.cookieless,
    allowLocalhost: input.allow_localhost,
    timezone: input.timezone,
    currency: input.currency,
    retentionDays: input.retention_days,
    attributionModel: input.attribution_model,
    secretHash: await sha256Hex(secret),
  });
  await tenantSitesStub(ns, tenantId).indexAdd(siteId);
  return { site: record.site, secret, snippet: snippetFor(record.site, edgeOrigin(c)) };
}

export async function updateSite(c: Ctx, siteId: string, patch: UpdateSiteInput): Promise<Site> {
  await siteRecord(c, siteId);
  const normalized =
    patch.hostnames === undefined ? patch : { ...patch, hostnames: [...new Set(patch.hostnames)] };
  const record = await siteStub(namespace(c), siteId).updateSite(normalized);
  if (record === null) throw new CrmError('not_found', 'site not found');
  return record.site;
}

export async function deleteSite(c: Ctx, siteId: string): Promise<void> {
  await siteRecord(c, siteId);
  const ns = namespace(c);
  await siteStub(ns, siteId).deleteSite();
  await tenantSitesStub(ns, getTenant(c).tenant.id).indexRemove(siteId);
}

/** Issues a new site secret; the previous one stops working within the edge cache TTL (60 s). */
export async function rollSecret(c: Ctx, siteId: string): Promise<string> {
  await siteRecord(c, siteId);
  const secret = newSiteSecret(siteId);
  await siteStub(namespace(c), siteId).setSecretHash(await sha256Hex(secret));
  return secret;
}

export async function siteSnippet(c: Ctx, siteId: string): Promise<SiteSnippet> {
  return snippetFor((await siteRecord(c, siteId)).site, edgeOrigin(c));
}

// --------------------------------------------------------------------- queries

const FILTER_DIMENSIONS = new Set<string>(ANALYTICS_FILTER_DIMENSIONS);

/** `filter_<dim>=value` (is), `=!value` (is not), `=~value` (contains). */
export function parseFilters(
  query: Record<string, string | string[] | undefined>,
): AnalyticsFilter[] {
  const filters: AnalyticsFilter[] = [];
  for (const [key, raw] of Object.entries(query)) {
    if (!key.startsWith('filter_')) continue;
    const dimension = key.slice('filter_'.length);
    if (!FILTER_DIMENSIONS.has(dimension))
      throw new CrmError('validation_failed', `unknown filter "${dimension}"`);
    for (const value of Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]) {
      const op = value.startsWith('!') ? 'is_not' : value.startsWith('~') ? 'contains' : 'is';
      const v = op === 'is' ? value : value.slice(1);
      if (v.length > 255)
        throw new CrmError('validation_failed', `filter "${dimension}" is too long`);
      filters.push({ dimension: dimension as AnalyticsFilterDimension, op, value: v });
    }
  }
  if (filters.length > 20) throw new CrmError('validation_failed', 'at most 20 filters');
  return filters;
}

const WEEK_MS = 7 * 86_400_000;

/** Query range from the REST params; default: the last 7 days up to now. */
export function rangeOf(c: Ctx, params: AnalyticsQueryParams): AnalyticsRange {
  const now = c.get('services').now();
  const query: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(c.req.queries()))
    query[k] = v.length === 1 ? (v[0] ?? '') : v;
  return {
    from: params.from ?? new Date(now - WEEK_MS).toISOString(),
    to: params.to ?? new Date(now).toISOString(),
    ...(params.timezone === undefined ? {} : { timezone: params.timezone }),
    filters: parseFilters(query),
  };
}

export function unwrap<T>(result: AnalyticsResult<T>): T {
  if (result.ok) return result.value;
  const code =
    result.error.code === 'not_found' || result.error.code === 'conflict' ? result.error.code : 'validation_failed';
  throw new CrmError(code, result.error.message);
}

/** Stub of a site owned by the verified tenant. */
export async function siteForQuery(c: Ctx, siteId: string) {
  await siteRecord(c, siteId);
  return siteStub(namespace(c), siteId);
}

/** Required `site_id` query parameter of the saved-object routes. */
export function siteIdParam(c: Ctx): string {
  const id = c.req.query('site_id');
  if (id === undefined || id === '') throw new CrmError('validation_failed', 'site_id is required');
  return id;
}

// ------------------------------------------------------------------ site keys

export async function createSiteKey(
  c: Ctx,
  siteId: string,
  input: { name: string; scopes: SiteKeyScope[] },
): Promise<{ key: SiteKey; secret: string }> {
  await siteRecord(c, siteId);
  const secret = newSiteKey(siteId);
  const key = await siteStub(namespace(c), siteId).createSiteKey({
    id: `sk_${(await sha256Hex(secret)).slice(0, 20)}`,
    name: input.name,
    prefix: secret.slice(0, 18),
    hash: await sha256Hex(secret),
    scopes: input.scopes,
  });
  return { key, secret };
}

// -------------------------------------------------------- CRM contact labels

export interface ContactLabel {
  name: string | null;
  email: string | null;
}

/**
 * Names / emails of linked CRM contacts (visitors identified by forms or email
 * clicks often have no identify traits). Empty when the caller cannot read contacts.
 */
export async function contactLabels(c: Ctx, ids: ReadonlyArray<string | null>): Promise<Map<string, ContactLabel>> {
  const unique = [...new Set(ids.filter((id): id is string => id !== null))];
  const out = new Map<string, ContactLabel>();
  if (unique.length === 0 || !getTenant(c).can('contacts:read')) return out;
  const result = (await tenantDb(c).crm('analytics.contactsBrief', actorOf(c), { ids: unique })) as CrmResult<
    Array<{ id: string; name: string | null; email: string | null; deleted: boolean }>
  >;
  if (!result.ok) return out;
  for (const r of result.value) if (!r.deleted) out.set(r.id, { name: r.name, email: r.email });
  return out;
}
