import {
  CHECKOUT_STRINGS,
  resolveCheckoutLocale,
  SESSION_PARAM,
  type CheckoutGatewayOps,
  type SelectionInput,
  type SessionPayloadInput,
} from '@amable/checkout';
import { CHECKOUT_WIDGET_BUNDLE, CHECKOUT_WIDGET_BUNDLE_HASH } from '@amable/checkout/bundle';
import { Hono, type Context } from 'hono';
import type { Env } from '../env';
import { callCore, clientInfo, GatewayCallError, tenantRef } from '../gateway';
import { CROSS_ORIGIN_BUNDLE, escapeHtml, jsonResponders, OPEN_CORS, readBoundedText, serveBundle } from '../public/http';

/**
 * Checkouts on the edge (customer zone or the edge origin):
 * - `GET /checkout.js`: embed widget (checkout form and post-purchase offer block);
 * - `GET /c/:slug/:checkoutId`: hosted checkout page (noindex);
 * - `GET /c/:slug/offer?amb_cs=…`: hosted post-purchase offer page;
 * - `GET …/config`, `POST …/quote|session|address`: JSON API of the widget;
 * - `POST /c/:slug/session/{complete,offer,accept,confirm,decline}`: session steps (token in the body);
 * - `POST /c/:slug/stripe/webhook`: Stripe events of the tenant account (raw body, signed).
 * CORS is open: embeds live on any site; the session token travels in the body.
 */
export const checkoutEdgeRoutes = new Hono<{ Bindings: Env }>();

type Ctx = Context<{ Bindings: Env }>;

const MAX_BODY_BYTES = 64 * 1024;
const MAX_WEBHOOK_BYTES = 512 * 1024;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/i;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;
const RESERVED_IDS = new Set(['offer', 'session', 'stripe']);

/** Stripe.js, its iframes and its API; `payment` lets wallets (Apple Pay, Google Pay) run in Stripe's frames. */
export const CHECKOUT_CSP = [
  "default-src 'none'",
  "script-src 'self' https://js.stripe.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "connect-src 'self' https://api.stripe.com",
  'frame-src https://js.stripe.com https://hooks.stripe.com',
  "form-action 'self'",
  "base-uri 'none'",
].join('; ');
export const CHECKOUT_PERMISSIONS = 'camera=(), microphone=(), geolocation=(), usb=(), payment=(self "https://js.stripe.com"), browsing-topics=()';

const { errorJson, okJson, fromGatewayError } = jsonResponders('checkout', 'checkout service unavailable', OPEN_CORS);

function locale(c: Ctx, configured = 'auto'): 'en' | 'it' {
  const header = c.req.header('accept-language') ?? '';
  const list = header
    .split(',')
    .map((part) => part.split(';')[0]?.trim() ?? '')
    .filter((part) => part !== '');
  return resolveCheckoutLocale(configured, list);
}

function page(lang: string, title: string, body: string): string {
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>
html,body{margin:0;background:#f4f4f5;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#111827}
main{max-width:980px;margin:40px auto;padding:0 16px}
@media (max-width:680px){main{margin:16px auto}}
p.msg{background:#fff;border-radius:14px;padding:32px;text-align:center}
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
    'content-security-policy': CHECKOUT_CSP,
    'permissions-policy': CHECKOUT_PERMISSIONS,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };
}

function message(c: Ctx, status: number, text: string): Response {
  return c.body(page(locale(c), text, `<p class="msg">${escapeHtml(text)}</p>`), status as 200, htmlHeaders('no-store'));
}

function checkoutRef(c: Ctx): { slug: string; checkoutId: string } | null {
  const slug = c.req.param('slug') ?? '';
  const checkoutId = c.req.param('checkoutId') ?? '';
  return SLUG_RE.test(slug) && ID_RE.test(checkoutId) && !RESERVED_IDS.has(checkoutId) ? { slug, checkoutId } : null;
}

function slugOf(c: Ctx): string | null {
  const slug = c.req.param('slug') ?? '';
  return SLUG_RE.test(slug) ? slug : null;
}

async function readJson(c: Ctx): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; response: Response }> {
  if (!(c.req.header('content-type') ?? '').toLowerCase().includes('application/json')) {
    return { ok: false, response: errorJson(415, 'unsupported_media_type', 'send JSON') };
  }
  const raw = await readBoundedText(c, MAX_BODY_BYTES);
  if (raw === null) return { ok: false, response: errorJson(413, 'payload_too_large', 'request too large') };
  try {
    const value = raw === '' ? {} : (JSON.parse(raw) as unknown);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { ok: false, response: errorJson(400, 'bad_request', 'expected a JSON object') };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, response: errorJson(400, 'bad_request', 'invalid JSON') };
  }
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

const scriptTag = `<script async src="/checkout.js?v=${CHECKOUT_WIDGET_BUNDLE_HASH}"></script>`;

// -------------------------------------------------------------- widget script

checkoutEdgeRoutes.get('/checkout.js', (c) =>
  serveBundle(c, CHECKOUT_WIDGET_BUNDLE, CHECKOUT_WIDGET_BUNDLE_HASH, CROSS_ORIGIN_BUNDLE),
);

// ------------------------------------------------------------ stripe webhook

checkoutEdgeRoutes.post('/c/:slug/stripe/webhook', async (c) => {
  const slug = slugOf(c);
  if (slug === null) return c.json({ error: 'not_found' }, 404);
  const payload = await readBoundedText(c, MAX_WEBHOOK_BYTES);
  if (payload === null) return c.json({ error: 'payload_too_large' }, 413);
  try {
    await callCore<CheckoutGatewayOps, 'checkout.stripeWebhook'>(c.env, 'checkout.stripeWebhook', tenantRef(c, slug), clientInfo(c), {
      payload,
      signature: c.req.header('stripe-signature') ?? null,
    });
    return c.json({ received: true });
  } catch (error) {
    if (error instanceof GatewayCallError) {
      // 4xx tells Stripe not to insist on a bad signature; 5xx gets retried.
      return c.json({ error: error.body.code }, error.body.status >= 500 ? 503 : (error.body.status as 400));
    }
    console.error('[checkout] webhook failed', error);
    return c.json({ error: 'unavailable' }, 503);
  }
});

// --------------------------------------------------------- session steps

const SESSION_STEPS = ['complete', 'offer', 'accept', 'confirm', 'decline'] as const;

for (const step of SESSION_STEPS) {
  checkoutEdgeRoutes.options(`/c/:slug/session/${step}`, () => new Response(null, { status: 204, headers: OPEN_CORS }));
}

checkoutEdgeRoutes.post('/c/:slug/session/:step', async (c) => {
  const slug = slugOf(c);
  const step = c.req.param('step') as (typeof SESSION_STEPS)[number];
  if (slug === null || !SESSION_STEPS.includes(step)) return errorJson(404, 'not_found', 'not found');
  const body = await readJson(c);
  if (!body.ok) return body.response;
  const token = text(body.value['token'], 128);
  if (!TOKEN_RE.test(token)) return errorJson(422, 'validation_failed', 'invalid session token');
  const offerKey = text(body.value['offer_key'], 40);
  const tenant = tenantRef(c, slug);
  const client = clientInfo(c);
  try {
    switch (step) {
      case 'complete':
        return okJson((await callCore<CheckoutGatewayOps, 'checkout.complete'>(c.env, 'checkout.complete', tenant, client, { token })).value);
      case 'offer':
        return okJson((await callCore<CheckoutGatewayOps, 'checkout.offer'>(c.env, 'checkout.offer', tenant, client, { token })).value);
      case 'accept':
        return okJson(
          (await callCore<CheckoutGatewayOps, 'checkout.offerAccept'>(c.env, 'checkout.offerAccept', tenant, client, { token, offerKey })).value,
        );
      case 'confirm':
        return okJson(
          (await callCore<CheckoutGatewayOps, 'checkout.offerConfirm'>(c.env, 'checkout.offerConfirm', tenant, client, { token, offerKey })).value,
        );
      case 'decline':
        return okJson(
          (await callCore<CheckoutGatewayOps, 'checkout.offerDecline'>(c.env, 'checkout.offerDecline', tenant, client, { token, offerKey })).value,
        );
    }
  } catch (error) {
    return fromGatewayError(error);
  }
});

checkoutEdgeRoutes.get('/c/:slug/offer', (c) => {
  const slug = slugOf(c);
  const strings = CHECKOUT_STRINGS[locale(c)];
  if (slug === null) return message(c, 404, strings.notFound);
  const token = c.req.query(SESSION_PARAM) ?? '';
  if (!TOKEN_RE.test(token)) return message(c, 404, strings.offerExpired);
  const body = `<div data-amable-offer data-amable-tenant="${escapeHtml(slug)}"></div>\n${scriptTag}`;
  return c.body(page(locale(c), strings.summaryTitle, body), 200, htmlHeaders('no-store'));
});

// ---------------------------------------------------------------- checkouts

for (const path of ['/c/:slug/:checkoutId/config', '/c/:slug/:checkoutId/quote', '/c/:slug/:checkoutId/session', '/c/:slug/:checkoutId/address']) {
  checkoutEdgeRoutes.options(path, () => new Response(null, { status: 204, headers: OPEN_CORS }));
}

checkoutEdgeRoutes.get('/c/:slug/:checkoutId/config', async (c) => {
  const ref = checkoutRef(c);
  if (ref === null) return errorJson(404, 'not_found', 'checkout not found');
  try {
    const { value } = await callCore<CheckoutGatewayOps, 'checkout.config'>(c.env, 'checkout.config', tenantRef(c, ref.slug), clientInfo(c), {
      checkoutId: ref.checkoutId,
    });
    return okJson(value, 'public, max-age=30');
  } catch (error) {
    return fromGatewayError(error);
  }
});

checkoutEdgeRoutes.post('/c/:slug/:checkoutId/quote', async (c) => {
  const ref = checkoutRef(c);
  if (ref === null) return errorJson(404, 'not_found', 'checkout not found');
  const body = await readJson(c);
  if (!body.ok) return body.response;
  try {
    const { value } = await callCore<CheckoutGatewayOps, 'checkout.quote'>(c.env, 'checkout.quote', tenantRef(c, ref.slug), clientInfo(c), {
      checkoutId: ref.checkoutId,
      selection: (body.value['selection'] ?? {}) as SelectionInput,
      promoCode: text(body.value['promo_code'], 64),
    });
    return okJson(value);
  } catch (error) {
    return fromGatewayError(error);
  }
});

checkoutEdgeRoutes.post('/c/:slug/:checkoutId/session', async (c) => {
  const ref = checkoutRef(c);
  if (ref === null) return errorJson(404, 'not_found', 'checkout not found');
  const body = await readJson(c);
  if (!body.ok) return body.response;
  try {
    const { value } = await callCore<CheckoutGatewayOps, 'checkout.session'>(c.env, 'checkout.session', tenantRef(c, ref.slug), clientInfo(c), {
      checkoutId: ref.checkoutId,
      payload: body.value as SessionPayloadInput,
    });
    return okJson(value);
  } catch (error) {
    return fromGatewayError(error);
  }
});

checkoutEdgeRoutes.post('/c/:slug/:checkoutId/address', async (c) => {
  const ref = checkoutRef(c);
  if (ref === null) return errorJson(404, 'not_found', 'checkout not found');
  const body = await readJson(c);
  if (!body.ok) return body.response;
  try {
    const { value } = await callCore<CheckoutGatewayOps, 'checkout.address'>(c.env, 'checkout.address', tenantRef(c, ref.slug), clientInfo(c), {
      checkoutId: ref.checkoutId,
      q: text(body.value['q'], 200),
      country: text(body.value['country'], 2),
      lang: text(body.value['lang'], 10),
    });
    return okJson(value);
  } catch (error) {
    return fromGatewayError(error);
  }
});

checkoutEdgeRoutes.get('/c/:slug/:checkoutId', async (c) => {
  const strings = CHECKOUT_STRINGS[locale(c)];
  const ref = checkoutRef(c);
  if (ref === null) return message(c, 404, strings.notFound);
  try {
    const { value } = await callCore<CheckoutGatewayOps, 'checkout.hosted'>(c.env, 'checkout.hosted', tenantRef(c, ref.slug), clientInfo(c), {
      checkoutId: ref.checkoutId,
    });
    const lang = locale(c, value.config.settings.locale);
    const title = value.config.settings.heading !== '' ? value.config.settings.heading : value.config.name;
    const body = `<div data-amable-checkout="${escapeHtml(value.config.id)}" data-amable-tenant="${escapeHtml(value.config.tenant)}"></div>\n${scriptTag}`;
    return c.body(page(lang, `${title} · ${value.tenantName}`, body), 200, htmlHeaders('no-store'));
  } catch (error) {
    if (error instanceof GatewayCallError && error.body.status === 404) return message(c, 404, strings.notFound);
    console.error('[checkout] hosted page failed', error);
    return message(c, 502, strings.loadError);
  }
});
