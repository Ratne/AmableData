/**
 * Wire contract between the edge worker (customer zone: hosted forms, booking
 * pages, landing SSR) and the core worker, which owns tenant data.
 *
 * The edge calls the core worker's default `fetch` through a service binding
 * (`CORE`) on `EDGE_GATEWAY_PATH`, with a JSON body signed with the shared
 * `EDGE_GATEWAY_SECRET` (header `EDGE_GATEWAY_SIGNATURE_HEADER`, same HMAC
 * scheme as outgoing webhooks). The core worker resolves the tenant (slug or
 * customer hostname) and dispatches `op` to the module that registered it.
 *
 * Modules describe their ops as a `GatewayOpMap` (see @amable/forms,
 * @amable/booking, @amable/builder) so both sides share input/output types.
 */

export const EDGE_GATEWAY_PATH = '/_edge/rpc';
/** Ops answering with a raw `Response` (files, streams): `POST` with the same signed body. */
export const EDGE_GATEWAY_RAW_PATH = '/_edge/raw';
export const EDGE_GATEWAY_SIGNATURE_HEADER = 'x-amable-edge-signature';
/**
 * WebSocket upgrades must be `GET` requests: raw ops answering 101 receive the
 * envelope base64url-encoded in this header (signed like a body) on a `GET`
 * with `Upgrade: websocket`.
 */
export const EDGE_GATEWAY_ENVELOPE_HEADER = 'x-amable-edge-envelope';
/** Public constant used when no secret is configured and ENVIRONMENT=dev. Never valid elsewhere. */
export const EDGE_GATEWAY_DEV_SECRET = 'amable-dev-edge-gateway-secret-not-a-secret';

/** A tenant addressed by its slug (`/f/{slug}/…` URLs) or by a connected customer hostname. */
export type GatewayTenantRef = { readonly slug: string } | { readonly host: string };

/** Facts about the public visitor, collected by the edge from the request. */
export interface GatewayClientInfo {
  readonly ip: string | null;
  readonly userAgent: string | null;
  /** `request.cf.country`. */
  readonly country: string | null;
  /** Analytics visitor id from the first-party tracker cookie `amb_vid`. */
  readonly visitorId: string | null;
  readonly referer: string | null;
  /** Accept-Language header (public pages pick their locale from it). */
  readonly acceptLanguage: string | null;
}

/**
 * Replay protection: every envelope carries a random `nonce` and the signature
 * timestamp must be within this window; the core refuses a nonce seen twice.
 */
export const EDGE_GATEWAY_TOLERANCE_SECONDS = 60;

/**
 * Tenant-less op: the edge forwards its unhandled errors (fetch, queue,
 * AnalyticsDO alarm) to the core, whose error reporter picks the sink
 * (`ERROR_REPORTING`: local logs, control plane or own URL) and scrubs them.
 * Sent with `EDGE_INSTALLATION_TENANT` (never resolved).
 */
export const EDGE_ERROR_REPORT_OP = 'platform.reportError';
export const EDGE_INSTALLATION_TENANT: GatewayTenantRef = { slug: '_installation' };

export interface EdgeErrorReport {
  readonly source: 'edge' | 'queue' | 'durable_object';
  readonly module: string | null;
  /** Route pattern (`/f/:slug`), never the concrete URL. */
  readonly route: string | null;
  readonly errorType: string;
  readonly message: string;
  readonly stack: string | null;
}

export interface GatewayRequest {
  /** Random per call (base64url, 16–64 chars), covered by the signature. */
  readonly nonce: string;
  readonly op: string;
  readonly tenant: GatewayTenantRef;
  readonly client: GatewayClientInfo;
  readonly input: unknown;
}

export interface GatewayTenantInfo {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

export interface GatewayErrorBody {
  readonly code: string;
  readonly status: number;
  readonly message: string;
  readonly details?: ReadonlyArray<{ readonly path: string; readonly message: string }>;
}

export type GatewayResponse<T> =
  | { readonly ok: true; readonly tenant: GatewayTenantInfo; readonly value: T }
  | { readonly ok: false; readonly error: GatewayErrorBody };

/** Op name → input/output types. */
export type GatewayOpMap = Record<string, { input: unknown; output: unknown }>;
