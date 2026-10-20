import {
  acceptLanguageTags,
  resolveWidgetLocale,
  WIDGET_STRINGS,
  type FormsGatewayOps,
  type SubmitPayloadInput,
} from '@amable/forms';
import { FORMS_WIDGET_BUNDLE, FORMS_WIDGET_BUNDLE_HASH } from '@amable/forms/bundle';
import { Hono, type Context } from 'hono';
import type { Env } from '../env';
import { callCore, clientInfo, GatewayCallError, tenantRef } from '../gateway';
import {
  CROSS_ORIGIN_BUNDLE,
  escapeHtml,
  HOSTED_WIDGET_CSP,
  jsonResponders,
  OPEN_CORS,
  readBoundedText,
  serveBundle,
} from '../public/http';

/**
 * Hosted forms on the edge (customer zone or the edge origin):
 * - `GET /forms.js`: embed widget, served from memory (hash ETag);
 * - `GET /f/:slug/:formId`: hosted page (noindex) mounting the widget;
 * - `GET /f/:slug/:formId/config`: public JSON configuration;
 * - `POST /f/:slug/:formId`: submit (JSON from the widget, or a plain
 *   urlencoded HTML form post). CORS is open: embeds live on any site and no
 *   cookie is involved.
 */
export const formsEdgeRoutes = new Hono<{ Bindings: Env }>();

type Ctx = Context<{ Bindings: Env }>;

export const MAX_SUBMIT_BYTES = 64 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/i;

const { errorJson, okJson, fromGatewayError } = jsonResponders('forms', 'form service unavailable', OPEN_CORS);

function validRef(c: Ctx): { slug: string; formId: string } | null {
  const slug = c.req.param('slug') ?? '';
  const formId = c.req.param('formId') ?? '';
  return SLUG_RE.test(slug) && ID_RE.test(formId) ? { slug, formId } : null;
}

function page(locale: string, title: string, body: string): string {
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>
html,body{margin:0;background:#f4f4f5;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#111827}
main{max-width:640px;margin:48px auto;padding:32px;background:#fff;border-radius:16px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
@media (max-width:680px){main{margin:0;border-radius:0;min-height:100vh;box-sizing:border-box}}
p{line-height:1.5}
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}

function htmlHeaders(cache: string): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': cache,
    'x-robots-tag': 'noindex, nofollow',
    'content-security-policy': HOSTED_WIDGET_CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
  };
}

// -------------------------------------------------------------- widget script

formsEdgeRoutes.get('/forms.js', (c) => serveBundle(c, FORMS_WIDGET_BUNDLE, FORMS_WIDGET_BUNDLE_HASH, CROSS_ORIGIN_BUNDLE));

// --------------------------------------------------------------------- config

formsEdgeRoutes.options('/f/:slug/:formId/config', () => new Response(null, { status: 204, headers: OPEN_CORS }));
formsEdgeRoutes.options('/f/:slug/:formId', () => new Response(null, { status: 204, headers: OPEN_CORS }));

formsEdgeRoutes.get('/f/:slug/:formId/config', async (c) => {
  const ref = validRef(c);
  if (ref === null) return errorJson(404, 'not_found', 'form not found');
  try {
    const { value } = await callCore<FormsGatewayOps, 'forms.config'>(
      c.env,
      'forms.config',
      tenantRef(c, ref.slug),
      clientInfo(c),
      { formId: ref.formId },
    );
    return okJson(value, 'public, max-age=30');
  } catch (error) {
    return fromGatewayError(error);
  }
});

// ---------------------------------------------------------------- hosted page

formsEdgeRoutes.get('/f/:slug/:formId', async (c) => {
  const locale = resolveWidgetLocale('auto', acceptLanguageTags(c.req.header('accept-language') ?? null));
  const strings = WIDGET_STRINGS[locale];
  const ref = validRef(c);
  const notFound = () =>
    c.body(page(locale, strings.notFound, `<p>${escapeHtml(strings.notFound)}</p>`), 404, htmlHeaders('no-store'));
  if (ref === null) return notFound();
  try {
    const { value } = await callCore<FormsGatewayOps, 'forms.hosted'>(
      c.env,
      'forms.hosted',
      tenantRef(c, ref.slug),
      clientInfo(c),
      { formId: ref.formId },
    );
    const pageLocale = resolveWidgetLocale(value.config.settings.locale, [locale]);
    const body = `<div data-amable-form="${escapeHtml(value.config.id)}" data-amable-tenant="${escapeHtml(value.config.tenant)}"></div>
<script async src="/forms.js?v=${FORMS_WIDGET_BUNDLE_HASH}"></script>`;
    return c.body(
      page(pageLocale, `${value.config.name} · ${value.tenantName}`, body),
      200,
      htmlHeaders('public, max-age=60'),
    );
  } catch (error) {
    if (error instanceof GatewayCallError && error.body.status === 404) return notFound();
    console.error('[forms] hosted page failed', error);
    return c.body(page(locale, strings.loadError, `<p>${escapeHtml(strings.loadError)}</p>`), 502, htmlHeaders('no-store'));
  }
});

// --------------------------------------------------------------------- submit

const RESERVED_FIELDS = new Set(['company_website', '_hp', 'cf-turnstile-response']);

/** A plain HTML form post: field names are field keys; repeated names become lists. */
export function payloadFromForm(params: URLSearchParams, referer: string | null): SubmitPayloadInput {
  const values: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    if (RESERVED_FIELDS.has(key)) continue;
    const all = params.getAll(key);
    values[key] = all.length > 1 ? all : (all[0] ?? '');
  }
  return {
    values,
    hp: params.get('company_website') ?? params.get('_hp') ?? '',
    turnstile_token: params.get('cf-turnstile-response') ?? '',
    meta: { page_url: referer ?? '' },
  };
}

formsEdgeRoutes.post('/f/:slug/:formId', async (c) => {
  const ref = validRef(c);
  if (ref === null) return errorJson(404, 'not_found', 'form not found');
  const raw = await readBoundedText(c, MAX_SUBMIT_BYTES);
  if (raw === null) return errorJson(413, 'payload_too_large', 'submission too large');
  const contentType = (c.req.header('content-type') ?? '').toLowerCase();
  const isJson = contentType.includes('application/json');
  let payload: unknown;
  if (isJson) {
    try {
      payload = JSON.parse(raw);
    } catch {
      return errorJson(400, 'bad_request', 'invalid JSON');
    }
  } else if (contentType.includes('application/x-www-form-urlencoded')) {
    payload = payloadFromForm(new URLSearchParams(raw), c.req.header('referer') ?? null);
  } else {
    return errorJson(415, 'unsupported_media_type', 'send JSON or a urlencoded form');
  }

  const locale = resolveWidgetLocale('auto', acceptLanguageTags(c.req.header('accept-language') ?? null));
  const strings = WIDGET_STRINGS[locale];
  try {
    const { value } = await callCore<FormsGatewayOps, 'forms.submit'>(
      c.env,
      'forms.submit',
      tenantRef(c, ref.slug),
      clientInfo(c),
      { formId: ref.formId, payload: payload as SubmitPayloadInput },
    );
    if (isJson) {
      return okJson(value);
    }
    if (value.success_mode === 'redirect' && value.redirect_url !== '') {
      return new Response(null, { status: 303, headers: { location: value.redirect_url } });
    }
    const message = value.success_message || strings.success;
    return c.body(page(locale, message, `<p>${escapeHtml(message)}</p>`), 200, htmlHeaders('no-store'));
  } catch (error) {
    if (isJson) return fromGatewayError(error);
    const status = error instanceof GatewayCallError ? error.body.status : 502;
    const message =
      error instanceof GatewayCallError && error.body.code === 'validation_failed'
        ? strings.fixErrors
        : error instanceof GatewayCallError && error.body.code === 'turnstile_failed'
          ? strings.turnstileFailed
          : status === 404
            ? strings.notFound
            : strings.genericError;
    return c.body(page(locale, message, `<p>${escapeHtml(message)}</p>`), status as 400, htmlHeaders('no-store'));
  }
});
