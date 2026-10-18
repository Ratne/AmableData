import {
  EDGE_ERROR_REPORT_OP,
  EDGE_GATEWAY_DEV_SECRET,
  EDGE_GATEWAY_ENVELOPE_HEADER,
  EDGE_GATEWAY_PATH,
  EDGE_GATEWAY_RAW_PATH,
  EDGE_GATEWAY_SIGNATURE_HEADER,
  EDGE_GATEWAY_TOLERANCE_SECONDS,
  type GatewayClientInfo,
  type GatewayResponse,
  type GatewayTenantInfo,
  type GatewayTenantRef,
} from '@amable/api-types';
import { verifyWebhook } from '@amable/auth/security';
import { z } from 'zod';
import { ADS_TOKEN_GATEWAY_OP, handleAdsTokenOp } from '../analytics/ads-sync';
import { findTrackingHost, TRACKING_HOST_GATEWAY_OP } from '../analytics/routes-tracking-domains';
import { findTenantBySlug } from '../auth/store';
import { bookingGatewayHandlers, bookingGatewayRawHandlers } from '../booking/gateway';
import type { Env } from '../env';
import { formsGatewayHandlers, formsGatewayRawHandlers } from '../forms/gateway';
import { ensureInstallationMigrated } from '../migrate';
import {
  handlePagePublicUrlOp,
  PAGE_PUBLIC_URL_GATEWAY_OP,
  pagesGatewayHandlers,
  pagesGatewayRawHandlers,
} from '../pages/gateway';
import { reportError } from '../platform/telemetry';
import {
  createGatewayContext,
  GatewayError,
  type GatewayHandlers,
  type GatewayRawHandlers,
} from './context';

/**
 * Entry point of the edge worker into the core worker (service binding
 * `CORE` → default `fetch`, paths under `/_edge/`). Every call is a signed
 * JSON envelope `{ op, tenant, client, input }`: the signature proves it comes
 * from our edge worker, then the tenant is resolved (slug, or a connected
 * customer hostname) and the op of the owning module runs.
 */

export const EDGE_GATEWAY_PREFIX = '/_edge/';

const handlers: GatewayHandlers = {
  ...formsGatewayHandlers,
  ...bookingGatewayHandlers,
  ...pagesGatewayHandlers,
};
const rawHandlers: GatewayRawHandlers = {
  ...formsGatewayRawHandlers,
  ...bookingGatewayRawHandlers,
  ...pagesGatewayRawHandlers,
};

const MAX_BODY_BYTES = 1_000_000;

const nullableString = z.string().max(4096).nullable();
const envelopeSchema = z.strictObject({
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  op: z.string().min(1).max(100),
  tenant: z.union([
    z.strictObject({ slug: z.string().min(1).max(100) }),
    z.strictObject({ host: z.string().min(1).max(253) }),
  ]),
  client: z.strictObject({
    ip: nullableString,
    userAgent: nullableString,
    country: nullableString,
    visitorId: nullableString,
    referer: nullableString,
    acceptLanguage: nullableString,
  }),
  input: z.unknown(),
});

/**
 * Nonces seen by this isolate inside the tolerance window. Signatures only
 * travel over the service binding, so this bounds the damage of a leaked
 * envelope (log, trace) to one use per isolate within 60 s.
 */
const seenNonces = new Map<string, number>();
const MAX_SEEN_NONCES = 50_000;

/** Records a nonce; false when it was already used inside the window. */
export function markGatewayNonce(nonce: string, nowMs: number): boolean {
  const windowMs = EDGE_GATEWAY_TOLERANCE_SECONDS * 2 * 1000;
  if (seenNonces.size >= MAX_SEEN_NONCES) {
    // Insertion order is chronological: drop the oldest half.
    let drop = seenNonces.size / 2;
    for (const key of seenNonces.keys()) {
      if (drop-- <= 0) break;
      seenNonces.delete(key);
    }
  }
  const previous = seenNonces.get(nonce);
  if (previous !== undefined && nowMs - previous <= windowMs) return false;
  seenNonces.set(nonce, nowMs);
  return true;
}

function gatewaySecret(env: Env): string | null {
  const configured = env.EDGE_GATEWAY_SECRET;
  if (configured !== undefined && configured !== '') return configured;
  return env.ENVIRONMENT === 'dev' ? EDGE_GATEWAY_DEV_SECRET : null;
}

function decodeEnvelopeHeader(value: string | null): string {
  if (value === null || value.length > MAX_BODY_BYTES) return '';
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)));
  } catch {
    return '';
  }
}

function reply<T>(body: GatewayResponse<T>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function failure(error: GatewayError): Response {
  return reply({ ok: false, error: error.toBody() }, error.status);
}

/** Tenant of a public request; unknown slugs / hostnames are a 404. */
export async function resolveTenant(env: Env, ref: GatewayTenantRef): Promise<GatewayTenantInfo> {
  const row =
    'slug' in ref
      ? await findTenantBySlug(env.DB, ref.slug.toLowerCase())
      : await env.DB.prepare(
          `SELECT t.id AS id, t.slug AS slug, t.name AS name
           FROM domains d JOIN tenants t ON t.id = d.tenant_id
           WHERE d.hostname = ? AND (d.status = 'verified' OR ? = 'dev')`,
        )
          .bind(ref.host.toLowerCase(), env.ENVIRONMENT ?? '')
          .first<GatewayTenantInfo>();
  if (row === null) throw new GatewayError(404, 'not_found', 'site not found');
  return row;
}

const edgeErrorSchema = z.strictObject({
  source: z.enum(['edge', 'queue', 'durable_object']),
  module: z.string().max(100).nullable(),
  route: z.string().max(300).nullable(),
  errorType: z.string().min(1).max(100),
  message: z.string().max(4096),
  stack: z.string().max(16_384).nullable(),
});

/** Edge errors go through this installation's reporter: same sink, same scrubbing, core release. */
async function reportEdgeError(env: Env, executionCtx: ExecutionContext, input: unknown): Promise<Response> {
  const report = edgeErrorSchema.safeParse(input);
  if (!report.success) return failure(new GatewayError(400, 'bad_request', 'invalid error report'));
  const { source, module, route, errorType, message, stack } = report.data;
  const error = new Error(message);
  error.name = errorType;
  error.stack = stack ?? `${errorType}: ${message}`;
  await ensureInstallationMigrated(env.DB);
  await reportError(env, error, { source, module, route }, { waitUntil: (p) => executionCtx.waitUntil(p) });
  return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
}

/** Custom tracking hostnames are not workspace hostnames: resolved before (and instead of) `resolveTenant`. */
async function trackingHost(env: Env, ref: GatewayTenantRef): Promise<Response> {
  await ensureInstallationMigrated(env.DB);
  const found = 'host' in ref ? await findTrackingHost(env.DB, ref.host) : null;
  if (found === null) return failure(new GatewayError(404, 'not_found', 'tracking domain not found'));
  return reply({ ok: true, tenant: found.tenant, value: { site_id: found.site_id } });
}

/** Ad platform token for the edge outbound queue: the tenant travels in the input, not in the envelope. */
async function adsToken(env: Env, input: unknown): Promise<Response> {
  await ensureInstallationMigrated(env.DB);
  const { status, body } = await handleAdsTokenOp(env, input);
  return reply(body, status);
}

/** Public URL of a builder page for the edge funnel routes: the tenant travels in the input. */
async function pagePublicUrl(
  env: Env,
  executionCtx: ExecutionContext,
  client: GatewayClientInfo,
  input: unknown,
): Promise<Response> {
  await ensureInstallationMigrated(env.DB);
  const { status, body } = await handlePagePublicUrlOp(env, executionCtx, client, input);
  return reply(body, status);
}

export async function handleEdgeGateway(
  request: Request,
  env: Env,
  executionCtx: ExecutionContext,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  const raw = pathname === EDGE_GATEWAY_RAW_PATH;
  const upgrade =
    raw && request.method === 'GET' && request.headers.get('upgrade')?.toLowerCase() === 'websocket';
  if ((request.method !== 'POST' && !upgrade) || (!raw && pathname !== EDGE_GATEWAY_PATH)) {
    return new Response('Not found', { status: 404 });
  }
  const secret = gatewaySecret(env);
  if (secret === null) {
    return failure(new GatewayError(503, 'gateway_not_configured', 'EDGE_GATEWAY_SECRET missing'));
  }
  const body = upgrade
    ? decodeEnvelopeHeader(request.headers.get(EDGE_GATEWAY_ENVELOPE_HEADER))
    : await request.text();
  if (body.length > MAX_BODY_BYTES) {
    return failure(new GatewayError(413, 'payload_too_large', 'request too large'));
  }
  const verified = await verifyWebhook({
    secrets: [secret],
    header: request.headers.get(EDGE_GATEWAY_SIGNATURE_HEADER),
    rawBody: body,
    toleranceSeconds: EDGE_GATEWAY_TOLERANCE_SECONDS,
  });
  // Unsigned callers learn nothing about the gateway.
  if (!verified.ok) return new Response('Not found', { status: 404 });

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return failure(new GatewayError(400, 'bad_request', 'invalid JSON'));
  }
  const envelope = envelopeSchema.safeParse(json);
  if (!envelope.success) {
    return failure(new GatewayError(400, 'bad_request', 'invalid gateway envelope'));
  }
  const { nonce, op, tenant: ref, client, input } = envelope.data;
  if (!markGatewayNonce(nonce, Date.now())) {
    return failure(new GatewayError(409, 'replayed', 'gateway envelope already used'));
  }
  if (!raw && op === EDGE_ERROR_REPORT_OP) return reportEdgeError(env, executionCtx, input);
  if (!raw && op === TRACKING_HOST_GATEWAY_OP) return trackingHost(env, ref);
  if (!raw && op === ADS_TOKEN_GATEWAY_OP) return adsToken(env, input);
  if (!raw && op === PAGE_PUBLIC_URL_GATEWAY_OP) return pagePublicUrl(env, executionCtx, client, input);
  const handler = raw ? rawHandlers[op] : handlers[op];
  if (handler === undefined || !Object.hasOwn(raw ? rawHandlers : handlers, op)) {
    return failure(new GatewayError(404, 'unknown_op', `unknown gateway op ${op}`));
  }

  try {
    await ensureInstallationMigrated(env.DB);
    const tenant = await resolveTenant(env, ref);
    const ctx = createGatewayContext({ env, executionCtx, tenant, client });
    if (raw) return await (handler as GatewayRawHandlers[string])(ctx, input);
    const value = await (handler as GatewayHandlers[string])(ctx, input);
    return reply({ ok: true, tenant, value });
  } catch (error) {
    if (error instanceof GatewayError) return failure(error);
    console.error(`[edge-gateway] ${op} failed`, error);
    return failure(new GatewayError(500, 'internal_error', 'internal error'));
  }
}
