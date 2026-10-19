import {
  ESIGN_DOCUMENT_RAW_OP,
  ESIGN_PAGE_RAW_OP,
  resolveEsignLocale,
  SIGNING_STRINGS,
  SIGNING_SUBMIT_MAX_BYTES,
  SIGNING_TOKEN_RE,
  type EsignGatewayOps,
  type EsignLocale,
} from '@amable/esign';
import { ESIGN_APP_BUNDLE, ESIGN_APP_BUNDLE_HASH } from '@amable/esign/bundle';
import { acceptLanguageList } from '@amable/booking';
import { Hono, type Context } from 'hono';
import type { Env } from '../env';
import { callCore, callCoreRaw, clientInfo, GatewayCallError, tenantRef } from '../gateway';

/**
 * Signing pages on the edge (edge origin or a customer zone):
 * - `GET /sign.js`: the signing app, served from memory (hash ETag);
 * - `GET /sign/:slug/:token`: the signer's page (noindex, never framed, no referrer: the token is the credential);
 * - `POST /sign/:slug/:token/{open,otp/send,otp/verify,complete,decline}`: JSON actions;
 * - `GET /sign/:slug/:token/pages/:page`, `GET …/document`: page images and the PDF.
 * No cookies and no CORS: everything is same-origin, the link token authorizes.
 */
export const esignEdgeRoutes = new Hono<{ Bindings: Env }>();

type Ctx = Context<{ Bindings: Env }>;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/i;
const ACTION_MAX_BYTES = 16 * 1024;

const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

function errorJson(status: number, error: string, message: string, details?: unknown): Response {
  return new Response(JSON.stringify({ error, message, ...(details === undefined ? {} : { details }) }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
  });
}

function okJson(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
  });
}

function fromGatewayError(error: unknown): Response {
  if (error instanceof GatewayCallError) return errorJson(error.body.status, error.body.code, error.body.message, error.body.details);
  console.error('[esign] gateway call failed', error);
  return errorJson(502, 'gateway_error', 'signing service unavailable');
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** JSON inside `<script type="application/json">`: no way to close the tag. */
function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function htmlHeaders(): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex, nofollow',
    'content-security-policy': PAGE_CSP,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
  };
}

function page(locale: EsignLocale, title: string, body: string): string {
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>
html,body{margin:0;background:#eef0f3;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#111827}
p.msg{max-width:520px;margin:64px auto;background:#fff;border-radius:14px;padding:32px;text-align:center}
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function visitorLocale(c: Ctx): EsignLocale {
  return resolveEsignLocale('auto', acceptLanguageList(c.req.header('accept-language') ?? null));
}

function message(c: Ctx, status: number, text: string): Response {
  return c.body(page(visitorLocale(c), text, `<p class="msg">${escapeHtml(text)}</p>`), status as 200, htmlHeaders());
}

function linkRef(c: Ctx): { slug: string; token: string } | null {
  const slug = c.req.param('slug') ?? '';
  const token = c.req.param('token') ?? '';
  return SLUG_RE.test(slug) && SIGNING_TOKEN_RE.test(token) ? { slug, token } : null;
}

async function readJson(c: Ctx, max: number): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; response: Response }> {
  if (!(c.req.header('content-type') ?? '').toLowerCase().includes('application/json')) {
    return { ok: false, response: errorJson(415, 'unsupported_media_type', 'send JSON') };
  }
  const declared = Number(c.req.header('content-length') ?? '0');
  if (declared > max) return { ok: false, response: errorJson(413, 'payload_too_large', 'request too large') };
  const raw = await c.req.text();
  if (new TextEncoder().encode(raw).length > max) return { ok: false, response: errorJson(413, 'payload_too_large', 'request too large') };
  try {
    const value: unknown = raw === '' ? {} : JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object');
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, response: errorJson(400, 'bad_request', 'invalid JSON') };
  }
}

const scriptTag = `<script defer src="/sign.js?v=${ESIGN_APP_BUNDLE_HASH}"></script>`;

// --------------------------------------------------------------- app script

esignEdgeRoutes.get('/sign.js', (c) => {
  const etag = `"${ESIGN_APP_BUNDLE_HASH}"`;
  const headers: Record<string, string> = {
    'content-type': 'application/javascript; charset=utf-8',
    'cache-control': 'public, max-age=3600, stale-while-revalidate=86400',
    etag,
    'x-content-type-options': 'nosniff',
  };
  const inm = c.req.header('if-none-match');
  if (inm !== undefined && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(ESIGN_APP_BUNDLE, { status: 200, headers });
});

// ---------------------------------------------------------------- the page

esignEdgeRoutes.get('/sign/:slug/:token', async (c) => {
  const strings = SIGNING_STRINGS[visitorLocale(c)];
  const ref = linkRef(c);
  if (ref === null) return message(c, 404, strings.notFound);
  try {
    const { value } = await callCore<EsignGatewayOps, 'esign.view'>(c.env, 'esign.view', tenantRef(c, ref.slug), clientInfo(c), { token: ref.token });
    const s = SIGNING_STRINGS[value.locale];
    const body = `<div id="amable-sign" data-base="/sign/${escapeHtml(ref.slug)}/${escapeHtml(ref.token)}"></div>
<script type="application/json" id="amable-sign-view">${inlineJson(value)}</script>
<noscript><p class="msg">${escapeHtml(s.loadError)}</p></noscript>
${scriptTag}`;
    return c.body(page(value.locale, `${value.request_name} · ${value.tenant_name}`, body), 200, htmlHeaders());
  } catch (error) {
    if (error instanceof GatewayCallError && error.body.status === 404) return message(c, 404, strings.notFound);
    console.error('[esign] signing page failed', error);
    return message(c, 502, strings.loadError);
  }
});

// ------------------------------------------------------------------ actions

type JsonOp = 'esign.open' | 'esign.otpSend' | 'esign.otpVerify' | 'esign.complete' | 'esign.decline';

function action(path: string, op: JsonOp, max: number, build: (token: string, body: Record<string, unknown>) => EsignGatewayOps[JsonOp]['input']) {
  esignEdgeRoutes.post(`/sign/:slug/:token/${path}`, async (c) => {
    const ref = linkRef(c);
    if (ref === null) return errorJson(404, 'not_found', 'signing link not found');
    const body = await readJson(c, max);
    if (!body.ok) return body.response;
    try {
      const { value } = await callCore<EsignGatewayOps, typeof op>(c.env, op, tenantRef(c, ref.slug), clientInfo(c), build(ref.token, body.value) as never);
      return okJson(value);
    } catch (error) {
      return fromGatewayError(error);
    }
  });
}

const browserOf = (body: Record<string, unknown>) => (typeof body['browser'] === 'object' && body['browser'] !== null ? { browser: body['browser'] as never } : {});

action('open', 'esign.open', ACTION_MAX_BYTES, (token, body) => ({ token, ...browserOf(body) }));
action('otp/send', 'esign.otpSend', ACTION_MAX_BYTES, (token, body) => ({ token, ...browserOf(body) }));
action('otp/verify', 'esign.otpVerify', ACTION_MAX_BYTES, (token, body) => ({
  token,
  code: typeof body['code'] === 'string' ? body['code'] : '',
  ...browserOf(body),
}));
action('complete', 'esign.complete', SIGNING_SUBMIT_MAX_BYTES, (token, body) => ({ token, submit: body as never }));
action('decline', 'esign.decline', ACTION_MAX_BYTES, (token, body) => ({
  token,
  ...(typeof body['reason'] === 'string' ? { reason: body['reason'].slice(0, 500) } : {}),
  ...browserOf(body),
}));

// -------------------------------------------------------------------- files

esignEdgeRoutes.get('/sign/:slug/:token/pages/:page', async (c) => {
  const ref = linkRef(c);
  const pageIndex = Number(c.req.param('page'));
  if (ref === null || !Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex > 49) return new Response('Not found', { status: 404 });
  try {
    return await callCoreRaw(c.env, ESIGN_PAGE_RAW_OP, tenantRef(c, ref.slug), clientInfo(c), { token: ref.token, page: pageIndex });
  } catch (error) {
    return fromGatewayError(error);
  }
});

esignEdgeRoutes.get('/sign/:slug/:token/document', async (c) => {
  const ref = linkRef(c);
  if (ref === null) return new Response('Not found', { status: 404 });
  try {
    return await callCoreRaw(c.env, ESIGN_DOCUMENT_RAW_OP, tenantRef(c, ref.slug), clientInfo(c), { token: ref.token });
  } catch (error) {
    return fromGatewayError(error);
  }
});
