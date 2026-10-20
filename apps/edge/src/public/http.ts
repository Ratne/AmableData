import type { Context } from 'hono';
import type { Env } from '../env';
import { GatewayCallError } from '../gateway';

/** HTTP building blocks of the public edge pages (booking, forms, e-signature). */

type Ctx = Context<{ Bindings: Env }>;

/** Open CORS of the embeddable widgets: they live on any site and no cookie is involved. */
export const OPEN_CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, accept',
  'access-control-max-age': '86400',
};

/** CSP of the hosted widget pages (Turnstile allowed). */
export const HOSTED_WIDGET_CSP = [
  "default-src 'none'",
  "script-src 'self' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  'frame-src https://challenges.cloudflare.com',
  "form-action 'self'",
  "base-uri 'none'",
].join('; ');

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** JSON inside `<script type="application/json">`: no way to close the tag. */
export function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export interface JsonResponders {
  errorJson(status: number, error: string, message: string, details?: unknown): Response;
  okJson(value: unknown, cache?: string): Response;
  /** Gateway error passed through as is; anything else is logged and becomes a 502. */
  fromGatewayError(error: unknown): Response;
}

/** JSON responses of one module; `headers` are added to every response (CORS, referrer policy). */
export function jsonResponders(
  module: string,
  unavailable: string,
  headers: Readonly<Record<string, string>>,
): JsonResponders {
  const respond = (status: number, body: unknown, cache: string): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'cache-control': cache, ...headers },
    });
  const errorJson = (status: number, error: string, message: string, details?: unknown): Response =>
    respond(status, { error, message, ...(details === undefined ? {} : { details }) }, 'no-store');
  return {
    errorJson,
    okJson: (value, cache = 'no-store') => respond(200, value, cache),
    fromGatewayError(error) {
      if (error instanceof GatewayCallError) {
        return errorJson(error.body.status, error.body.code, error.body.message, error.body.details);
      }
      console.error(`[${module}] gateway call failed`, error);
      return errorJson(502, 'gateway_error', unavailable);
    },
  };
}

/** Request body as text, or `null` when it exceeds `max` bytes (declared or actual). */
export async function readBoundedText(c: Ctx, max: number): Promise<string | null> {
  const declared = Number(c.req.header('content-length') ?? '0');
  if (declared > max) return null;
  const raw = await c.req.text();
  return new TextEncoder().encode(raw).length > max ? null : raw;
}

/** A script bundle served from memory with its content hash as ETag (304 on match). */
export function serveBundle(
  c: Ctx,
  bundle: string,
  hash: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): Response {
  const etag = `"${hash}"`;
  const headers: Record<string, string> = {
    'content-type': 'application/javascript; charset=utf-8',
    'cache-control': 'public, max-age=3600, stale-while-revalidate=86400',
    etag,
    ...extraHeaders,
    'x-content-type-options': 'nosniff',
  };
  const inm = c.req.header('if-none-match');
  if (inm !== undefined && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(bundle, { status: 200, headers });
}

/** Headers of the embeddable widget bundles (loaded cross-origin). */
export const CROSS_ORIGIN_BUNDLE: Record<string, string> = {
  'access-control-allow-origin': '*',
  'cross-origin-resource-policy': 'cross-origin',
};
