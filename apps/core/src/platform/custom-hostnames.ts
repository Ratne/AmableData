import type { TrackingDomainStatus } from '@amable/api-types';
import type { Env } from '../env';

/**
 * Custom hostnames of the platform zone (Cloudflare for SaaS): a customer
 * points `track.customer.com` (CNAME) at the tracking target and Cloudflare
 * issues the certificate, so the edge worker answers on the customer host.
 * Implementations:
 * - `cloudflareCustomHostnames()`: zone API (token with "SSL and Certificates: Edit");
 * - `devCustomHostnames()` (ENVIRONMENT=dev, tests): deterministic, state in
 *   `installation_meta`, never any network; every status read advances
 *   pending_dns → pending_ssl → active.
 * Without credentials outside dev, tracking domains are unavailable.
 */

export interface CustomHostnameState {
  readonly id: string;
  readonly hostname: string;
  readonly status: TrackingDomainStatus;
  /** Ownership / certificate validation record, when the provider asks for one. */
  readonly txtName: string | null;
  readonly txtValue: string | null;
  readonly error: string | null;
}

export interface CustomHostnameProvider {
  readonly kind: 'cloudflare' | 'fake';
  /** Hostname the customer CNAME must point at. */
  readonly cnameTarget: string;
  create(hostname: string): Promise<CustomHostnameState>;
  /** Current state; `null` when the provider no longer knows the hostname. */
  get(id: string): Promise<CustomHostnameState | null>;
  /** Idempotent: an already deleted hostname is not an error. */
  delete(id: string): Promise<void>;
}

export class CustomHostnameError extends Error {
  override readonly name = 'CustomHostnameError';
}

/** Variables of `apps/core/wrangler.jsonc` (token as a Wrangler secret). */
export interface CustomHostnameEnv {
  CF_ZONE_ID?: string;
  CF_API_TOKEN?: string;
  TRACKING_CNAME_TARGET?: string;
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

const CF_API = 'https://api.cloudflare.com/client/v4';

// ------------------------------------------------------------- cloudflare

interface CfCustomHostname {
  id: string;
  hostname: string;
  status?: string;
  ssl?: {
    status?: string;
    txt_name?: string;
    txt_value?: string;
    validation_records?: Array<{ txt_name?: string; txt_value?: string }>;
    validation_errors?: Array<{ message?: string }>;
  };
  ownership_verification?: { type?: string; name?: string; value?: string };
  verification_errors?: string[];
}

interface CfEnvelope<T> {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result: T;
}

const SSL_PENDING = new Set([
  'initializing',
  'pending_validation',
  'pending_issuance',
  'pending_deployment',
  'pending_cleanup',
]);
const HOSTNAME_FAILED = new Set(['blocked', 'moved', 'deleted', 'test_failed']);

/** Maps a Cloudflare custom hostname onto the tracking domain lifecycle. */
export function mapCloudflareHostname(raw: CfCustomHostname): CustomHostnameState {
  const ssl = raw.ssl ?? {};
  const sslStatus = ssl.status ?? 'initializing';
  const hostStatus = raw.status ?? 'pending';
  const sslError = ssl.validation_errors?.find((e) => e.message !== undefined)?.message ?? null;
  const hostError = raw.verification_errors?.[0] ?? null;
  let status: TrackingDomainStatus;
  if (HOSTNAME_FAILED.has(hostStatus)) status = 'error';
  else if (hostStatus !== 'active') status = 'pending_dns';
  else if (sslStatus === 'active') status = 'active';
  else if (SSL_PENDING.has(sslStatus)) status = 'pending_ssl';
  else status = 'error';
  const ownership = raw.ownership_verification;
  const record = ssl.validation_records?.find((r) => r.txt_name !== undefined);
  const txtName = ownership?.name ?? ssl.txt_name ?? record?.txt_name ?? null;
  const txtValue = ownership?.value ?? ssl.txt_value ?? record?.txt_value ?? null;
  const error =
    status === 'error'
      ? (sslError ?? hostError ?? `${hostStatus}/${sslStatus}`)
      : (sslError ?? hostError);
  return {
    id: raw.id,
    hostname: raw.hostname,
    status,
    txtName,
    txtValue,
    error: error === null ? null : error.slice(0, 300),
  };
}

export function cloudflareCustomHostnames(input: {
  zoneId: string;
  token: string;
  cnameTarget: string;
  fetch: FetchFn;
}): CustomHostnameProvider {
  const call = async <T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; result: T | null }> => {
    let response: Response;
    try {
      response = await input.fetch(`${CF_API}/zones/${input.zoneId}/custom_hostnames${path}`, {
        method,
        headers: {
          authorization: `Bearer ${input.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new CustomHostnameError('Cloudflare API unreachable');
    }
    const envelope = (await response.json().catch(() => null)) as CfEnvelope<T> | null;
    if (response.status === 404) return { status: 404, result: null };
    if (envelope === null || !envelope.success) {
      const message =
        envelope?.errors?.map((e) => e.message).join('; ') ?? `HTTP ${String(response.status)}`;
      throw new CustomHostnameError(`Cloudflare API ${method}: ${message}`);
    }
    return { status: response.status, result: envelope.result };
  };
  return {
    kind: 'cloudflare',
    cnameTarget: input.cnameTarget,
    async create(hostname) {
      const { result } = await call<CfCustomHostname>('POST', '', {
        hostname,
        ssl: { method: 'http', type: 'dv', settings: { min_tls_version: '1.2' } },
      });
      if (result === null) throw new CustomHostnameError('Cloudflare API POST: zone not found');
      return mapCloudflareHostname(result);
    },
    async get(id) {
      const { result } = await call<CfCustomHostname>('GET', `/${encodeURIComponent(id)}`);
      return result === null ? null : mapCloudflareHostname(result);
    },
    async delete(id) {
      await call<unknown>('DELETE', `/${encodeURIComponent(id)}`);
    },
  };
}

// -------------------------------------------------------------------- dev

const FAKE_STEPS: readonly TrackingDomainStatus[] = ['pending_dns', 'pending_ssl', 'active'];

/** FNV-1a, hex: stable ids and validation tokens for the dev provider. */
function fnv(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

interface FakeRow {
  hostname: string;
  step: number;
}

export function devCustomHostnames(db: D1Database, cnameTarget: string): CustomHostnameProvider {
  const key = (id: string) => `dev_custom_hostname:${id}`;
  const load = async (id: string): Promise<FakeRow | null> => {
    const row = await db
      .prepare(`SELECT value FROM installation_meta WHERE key = ?`)
      .bind(key(id))
      .first<{ value: string }>();
    return row === null ? null : (JSON.parse(row.value) as FakeRow);
  };
  const save = async (id: string, value: FakeRow): Promise<void> => {
    await db
      .prepare(
        `INSERT INTO installation_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .bind(key(id), JSON.stringify(value))
      .run();
  };
  const state = (id: string, row: FakeRow): CustomHostnameState => {
    const status = FAKE_STEPS[Math.min(row.step, FAKE_STEPS.length - 1)] ?? 'active';
    return {
      id,
      hostname: row.hostname,
      status,
      txtName: `_cf-custom-hostname.${row.hostname}`,
      txtValue: `dev-${fnv(`txt|${row.hostname}`)}`,
      error: null,
    };
  };
  return {
    kind: 'fake',
    cnameTarget,
    async create(hostname) {
      const id = `devch_${fnv(hostname)}`;
      const row: FakeRow = { hostname, step: 0 };
      await save(id, row);
      return state(id, row);
    },
    async get(id) {
      const row = await load(id);
      if (row === null) return null;
      const next = { ...row, step: Math.min(row.step + 1, FAKE_STEPS.length - 1) };
      await save(id, next);
      return state(id, next);
    },
    async delete(id) {
      await db.prepare(`DELETE FROM installation_meta WHERE key = ?`).bind(key(id)).run();
    },
  };
}

// ---------------------------------------------------------------- runtime

/** CNAME target shown to customers: `TRACKING_CNAME_TARGET`, else the edge origin host. */
export function trackingCnameTarget(env: Env): string {
  const vars = env as Env & CustomHostnameEnv;
  if (vars.TRACKING_CNAME_TARGET !== undefined && vars.TRACKING_CNAME_TARGET !== '') {
    return vars.TRACKING_CNAME_TARGET.toLowerCase();
  }
  try {
    const host = new URL(env.EDGE_ORIGIN ?? '').hostname;
    return host === '' ? 'tracking.invalid' : host;
  } catch {
    return 'tracking.invalid';
  }
}

type Factory = (env: Env) => CustomHostnameProvider | null;
let override: Factory | null = null;

/** Test hook (pass `null` to restore). */
export function overrideCustomHostnames(next: Factory | null): void {
  override = next;
}

/** Fake in dev, the zone API with credentials, otherwise `null` (feature unavailable). */
export function customHostnames(env: Env): CustomHostnameProvider | null {
  if (override !== null) return override(env);
  const target = trackingCnameTarget(env);
  if (env.ENVIRONMENT === 'dev') return devCustomHostnames(env.DB, target);
  const vars = env as Env & CustomHostnameEnv;
  if (!vars.CF_ZONE_ID || !vars.CF_API_TOKEN) return null;
  return cloudflareCustomHostnames({
    zoneId: vars.CF_ZONE_ID,
    token: vars.CF_API_TOKEN,
    cnameTarget: target,
    fetch: (input, init) => fetch(input, init),
  });
}
