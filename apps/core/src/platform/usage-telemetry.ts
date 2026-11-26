import {
  TELEMETRY_PATH,
  type ContactsBucket,
  type TelemetryEdition,
  type TelemetryPing,
} from '@amable/core/platform';
import { siteStub, tenantSitesStub } from '@amable/app-edge/analytics';
import { mapLimited } from '../concurrency';
import type { Env } from '../env';
import { DEFAULT_CONTROL_PLANE_URL, platformLink } from './license';
import { readMeta, storedQuotaSnapshot, writeMeta } from './quota';
import type { EngineUsageCounts, TenantUsageCounts } from './usage-counts';
import { parseVersion } from './updates';

/**
 * Anonymous usage telemetry (docs/telemetry.md): once a day the cron sends
 * structural counts (workspaces, funnels, forms, apps...) to
 * `POST <control plane>/v1/public/telemetry`, without the license key, under a
 * random id that is replaced after every opt-out. Contacts only as a range.
 *
 * Who decides:
 * - `TELEMETRY=off` (env) switches it off for good;
 * - linked installations (license key): the toggle of the portal, delivered by
 *   the heartbeat; nothing is sent until the portal has answered;
 * - open source: the owner toggle in Settings > Operations (default on).
 */

const META_TELEMETRY = 'platform:telemetry';
export const TELEMETRY_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** After a failed delivery the next attempt waits an hour, not a day. */
const RETRY_AFTER_MS = 60 * 60 * 1000;
const COUNT_CONCURRENCY = 4;
/** Beyond this many workspaces the counts are a lower bound (keeps the cron tick short). */
const MAX_COUNTED_TENANTS = 500;
const MAX_APPS = 50;

export interface TelemetryState {
  /** Local choice of the owner (open source); null = never chosen (default on). */
  readonly enabled: boolean | null;
  /** Choice made in the portal (linked installations); null = not received yet. */
  readonly portal: boolean | null;
  readonly anonymousId: string | null;
  readonly lastSentAt: number;
}

export type TelemetryControl = 'env_off' | 'portal' | 'local';

export interface TelemetryStatus {
  readonly enabled: boolean;
  /** Where the choice is made: env var, cloud portal or this installation. */
  readonly control: TelemetryControl;
  readonly lastSentAt: number | null;
}

const EMPTY_STATE: TelemetryState = { enabled: null, portal: null, anonymousId: null, lastSentAt: 0 };

export async function readTelemetryState(db: D1Database): Promise<TelemetryState> {
  const raw = await readMeta(db, META_TELEMETRY);
  if (typeof raw !== 'object' || raw === null) return EMPTY_STATE;
  const v = raw as Partial<Record<keyof TelemetryState, unknown>>;
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : null,
    portal: typeof v.portal === 'boolean' ? v.portal : null,
    anonymousId: typeof v.anonymousId === 'string' ? v.anonymousId : null,
    lastSentAt: typeof v.lastSentAt === 'number' ? v.lastSentAt : 0,
  };
}

async function writeTelemetryState(db: D1Database, state: TelemetryState): Promise<void> {
  await writeMeta(db, META_TELEMETRY, state);
}

/** A disabled telemetry forgets its id: switching it on again starts as a new installation. */
function withChoice(state: TelemetryState, patch: Partial<TelemetryState>, before: boolean, after: boolean): TelemetryState {
  const next = { ...state, ...patch };
  return before === after ? next : { ...next, anonymousId: null, lastSentAt: 0 };
}

function envOff(env: Env): boolean {
  return env.TELEMETRY?.trim().toLowerCase() === 'off';
}

export function telemetryControl(env: Env): TelemetryControl {
  if (envOff(env)) return 'env_off';
  return platformLink(env).mode === 'licensed' ? 'portal' : 'local';
}

function effectiveEnabled(control: TelemetryControl, state: TelemetryState): boolean {
  if (control === 'env_off') return false;
  if (control === 'portal') return state.portal === true;
  return state.enabled !== false;
}

export async function telemetryStatus(env: Env): Promise<TelemetryStatus> {
  const control = telemetryControl(env);
  const state = await readTelemetryState(env.DB);
  return {
    enabled: effectiveEnabled(control, state),
    control,
    lastSentAt: state.lastSentAt > 0 ? state.lastSentAt : null,
  };
}

/** Owner toggle (open source installations only: the caller checks `telemetryControl`). */
export async function setLocalTelemetry(env: Env, enabled: boolean): Promise<void> {
  const state = await readTelemetryState(env.DB);
  const before = effectiveEnabled('local', state);
  await writeTelemetryState(env.DB, withChoice(state, { enabled }, before, enabled));
}

/** Portal choice, from the heartbeat response. */
export async function applyPortalTelemetry(db: D1Database, allowed: boolean): Promise<void> {
  const state = await readTelemetryState(db);
  if (state.portal === allowed) return;
  await writeTelemetryState(db, withChoice(state, { portal: allowed }, state.portal === true, allowed));
}

export function contactsBucket(contacts: number): ContactsBucket {
  if (contacts <= 0) return '0';
  if (contacts <= 100) return '1-100';
  if (contacts <= 1000) return '101-1k';
  if (contacts <= 10_000) return '1k-10k';
  return '10k+';
}

async function edition(env: Env): Promise<TelemetryEdition> {
  if (platformLink(env).mode !== 'licensed') return 'open_source';
  const snapshot = await storedQuotaSnapshot(env.DB);
  return snapshot?.serviceState === 'self_hosted' ? 'self_hosted_licensed' : 'managed';
}

async function scalar(db: D1Database, sql: string): Promise<number> {
  return (await db.prepare(sql).first<{ n: number }>())?.n ?? 0;
}

const ZERO_TENANT: TenantUsageCounts = { contacts: 0, forms: 0, pages: 0, products: 0, bookingCalendars: 0 };

/** A workspace whose object cannot answer counts as empty: the ping never fails for one of them. */
async function orZero<T>(read: () => Promise<T>, zero: T): Promise<T> {
  try {
    return await read();
  } catch {
    return zero;
  }
}

async function tenantCounts(env: Env, tenantId: string) {
  const [tenant, engine, analytics] = await Promise.all([
    orZero<TenantUsageCounts>(
      async () => env.TENANT_DB.get(env.TENANT_DB.idFromName(tenantId)).usageCounts(),
      ZERO_TENANT,
    ),
    orZero<EngineUsageCounts>(
      async () => env.ENGINE.get(env.ENGINE.idFromName(tenantId)).usageCounts(),
      { automations: 0 },
    ),
    orZero(() => analyticsCounts(env, tenantId), { sites: 0, funnels: 0 }),
  ]);
  return { ...tenant, ...engine, ...analytics };
}

async function analyticsCounts(env: Env, tenantId: string): Promise<{ sites: number; funnels: number }> {
  const ns = env.ANALYTICS;
  if (ns === undefined) return { sites: 0, funnels: 0 };
  let sites = 0;
  let funnels = 0;
  for (const id of await tenantSitesStub(ns, tenantId).indexList()) {
    const stub = siteStub(ns, id);
    const record = await stub.getSite();
    if (record === null || record.deleted || record.tenantId !== tenantId) continue;
    sites += 1;
    funnels += (await stub.listFunnelGraphs('active')).length;
  }
  return { sites, funnels };
}

/** The exact body of the next ping (also shown to the owner before anything is sent). */
export async function buildUsagePing(env: Env, anonymousId: string): Promise<TelemetryPing> {
  const tenants = (
    await env.DB.prepare(`SELECT id FROM tenants ORDER BY id LIMIT ?`).bind(MAX_COUNTED_TENANTS).all<{ id: string }>()
  ).results;
  const perTenant = await mapLimited(tenants, COUNT_CONCURRENCY, ({ id }) => tenantCounts(env, id));
  const sum = (key: keyof (typeof perTenant)[number]) => perTenant.reduce((total, t) => total + t[key], 0);
  const apps = (
    await env.DB.prepare(
      `SELECT DISTINCT app_id FROM app_installs WHERE source = 'catalog' AND status = 'active' ORDER BY app_id LIMIT ?`,
    )
      .bind(MAX_APPS)
      .all<{ app_id: string }>()
  ).results.map((r) => r.app_id);
  const schema = Number(await readMeta(env.DB, 'schema_version'));
  const version = env.APP_VERSION?.trim() ?? '';
  return {
    anonymousId,
    version: version === '' ? 'dev' : version,
    schemaVersion: Number.isFinite(schema) ? schema : 0,
    edition: await edition(env),
    counts: {
      tenants: await scalar(env.DB, `SELECT COUNT(*) AS n FROM tenants`),
      users: await scalar(env.DB, `SELECT COUNT(*) AS n FROM users`),
      sites: sum('sites'),
      funnels: sum('funnels'),
      forms: sum('forms'),
      pages: sum('pages'),
      automations: sum('automations'),
      products: sum('products'),
      bookingCalendars: sum('bookingCalendars'),
    },
    contactsBucket: contactsBucket(sum('contacts')),
    apps,
  };
}

/** Placeholder id of the preview while the real one does not exist yet. */
const PREVIEW_ANONYMOUS_ID = '00000000-0000-4000-8000-000000000000';

export async function previewUsagePing(env: Env): Promise<TelemetryPing> {
  const state = await readTelemetryState(env.DB);
  return buildUsagePing(env, state.anonymousId ?? PREVIEW_ANONYMOUS_ID);
}

function telemetryUrl(env: Env): string {
  return `${(env.CONTROL_PLANE_URL ?? DEFAULT_CONTROL_PLANE_URL).replace(/\/$/, '')}${TELEMETRY_PATH}`;
}

/** Cron step: at most one ping a day, only from a release build, never throws for network failures. */
export async function runTelemetryPing(
  env: Env,
  nowMs: number,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
): Promise<void> {
  if (parseVersion(env.APP_VERSION) === null) return;
  const state = await readTelemetryState(env.DB);
  if (!effectiveEnabled(telemetryControl(env), state)) return;
  if (nowMs - state.lastSentAt < TELEMETRY_INTERVAL_MS) return;
  const anonymousId = state.anonymousId ?? crypto.randomUUID();
  const ping = await buildUsagePing(env, anonymousId);
  let delivered = false;
  try {
    const response = await fetcher(telemetryUrl(env), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'amable-telemetry' },
      body: JSON.stringify(ping),
    });
    delivered = response.ok;
    if (!delivered) console.warn(`[telemetry] usage ping answered ${String(response.status)}`);
  } catch (error) {
    console.warn('[telemetry] usage ping failed', error instanceof Error ? error.message : error);
  }
  // Re-read: the owner may have switched it off while the counts were computed.
  const latest = await readTelemetryState(env.DB);
  if (!effectiveEnabled(telemetryControl(env), latest) || latest.anonymousId !== state.anonymousId) return;
  await writeTelemetryState(env.DB, {
    ...latest,
    anonymousId,
    lastSentAt: delivered ? nowMs : nowMs - TELEMETRY_INTERVAL_MS + RETRY_AFTER_MS,
  });
}
