import {
  EDGE_GATEWAY_DEV_SECRET,
  EDGE_GATEWAY_ENVELOPE_HEADER,
  EDGE_GATEWAY_PATH,
  EDGE_GATEWAY_RAW_PATH,
  EDGE_GATEWAY_SIGNATURE_HEADER,
  type GatewayClientInfo,
  type GatewayErrorBody,
  type GatewayOpMap,
  type GatewayRequest,
  type GatewayResponse,
  type GatewayTenantInfo,
  type GatewayTenantRef,
} from '@amable/api-types';
import { signWebhook } from '@amable/auth/security';
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Env } from './env';

/**
 * Typed client of the core worker gateway (see @amable/api-types
 * edge-gateway). Tenant data never lives in the edge: hosted forms, booking
 * pages and landing SSR fetch what they need through these signed calls.
 */

export type EdgeContext = Context<{ Bindings: Env }>;

/** Error answered by the core worker for a gateway op. */
export class GatewayCallError extends Error {
  constructor(readonly body: GatewayErrorBody) {
    super(body.message);
    this.name = 'GatewayCallError';
  }
}

export interface GatewayResult<T> {
  readonly tenant: GatewayTenantInfo;
  readonly value: T;
}

function gatewaySecret(env: Env): string {
  const configured = env.EDGE_GATEWAY_SECRET;
  if (configured !== undefined && configured !== '') return configured;
  if (env.ENVIRONMENT === 'dev') return EDGE_GATEWAY_DEV_SECRET;
  throw new GatewayCallError({
    code: 'gateway_not_configured',
    status: 503,
    message: 'EDGE_GATEWAY_SECRET missing',
  });
}

function coreBinding(env: Env): Fetcher {
  if (env.CORE === undefined) {
    throw new GatewayCallError({
      code: 'gateway_unavailable',
      status: 503,
      message: 'CORE service binding missing',
    });
  }
  return env.CORE;
}

/** Visitor facts forwarded with every call. */
export function clientInfo(c: EdgeContext): GatewayClientInfo {
  const req = c.req.raw;
  const cf = (req as Request & { cf?: { country?: unknown } }).cf;
  const visitorId = getCookie(c, 'amb_vid') ?? null;
  return {
    ip: req.headers.get('cf-connecting-ip'),
    userAgent: req.headers.get('user-agent'),
    country: typeof cf?.country === 'string' ? cf.country : null,
    visitorId: visitorId !== null && /^[A-Za-z0-9_-]{8,64}$/.test(visitorId) ? visitorId : null,
    referer: req.headers.get('referer'),
    acceptLanguage: req.headers.get('accept-language'),
  };
}

function nonce(): string {
  return base64UrlBytes(crypto.getRandomValues(new Uint8Array(16)));
}

function base64UrlBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function post(
  env: Env,
  path: string,
  request: Omit<GatewayRequest, 'nonce'>,
): Promise<Response> {
  const body = JSON.stringify({ nonce: nonce(), ...request } satisfies GatewayRequest);
  const signature = await signWebhook(gatewaySecret(env), body);
  return coreBinding(env).fetch(`https://core.internal${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [EDGE_GATEWAY_SIGNATURE_HEADER]: signature },
    body,
  });
}

/** Calls a JSON op of the core gateway; error answers are thrown as `GatewayCallError`. */
export async function callCore<M extends GatewayOpMap, K extends keyof M & string>(
  env: Env,
  op: K,
  tenant: GatewayTenantRef,
  client: GatewayClientInfo,
  input: M[K]['input'],
): Promise<GatewayResult<M[K]['output']>> {
  const response = await post(env, EDGE_GATEWAY_PATH, { op, tenant, client, input });
  let parsed: GatewayResponse<M[K]['output']>;
  try {
    parsed = (await response.json()) as GatewayResponse<M[K]['output']>;
  } catch {
    throw new GatewayCallError({
      code: 'gateway_error',
      status: 502,
      message: `gateway answered ${response.status}`,
    });
  }
  if (!parsed.ok) throw new GatewayCallError(parsed.error);
  return { tenant: parsed.tenant, value: parsed.value };
}

function base64Url(text: string): string {
  return base64UrlBytes(new TextEncoder().encode(text));
}

/**
 * Calls a raw op (files, streams): the core `Response` is returned as-is.
 * `upgrade: true` forwards a WebSocket upgrade (the op answers 101).
 */
export async function callCoreRaw(
  env: Env,
  op: string,
  tenant: GatewayTenantRef,
  client: GatewayClientInfo,
  input: unknown,
  options: { upgrade?: boolean } = {},
): Promise<Response> {
  if (options.upgrade !== true) return post(env, EDGE_GATEWAY_RAW_PATH, { op, tenant, client, input });
  const body = JSON.stringify({ nonce: nonce(), op, tenant, client, input } satisfies GatewayRequest);
  const signature = await signWebhook(gatewaySecret(env), body);
  return coreBinding(env).fetch(`https://core.internal${EDGE_GATEWAY_RAW_PATH}`, {
    headers: {
      upgrade: 'websocket',
      [EDGE_GATEWAY_SIGNATURE_HEADER]: signature,
      [EDGE_GATEWAY_ENVELOPE_HEADER]: base64Url(body),
    },
  });
}

/** Tenant of a request: `{ slug }` from the URL when present, else the request hostname. */
export function tenantRef(c: EdgeContext, slug?: string): GatewayTenantRef {
  if (slug !== undefined && slug !== '') return { slug };
  return { host: new URL(c.req.url).host.toLowerCase() };
}
