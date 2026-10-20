import {
  acceptLanguageList,
  BOOKING_LIVE_RAW_OP,
  BOOKING_WIDGET_STRINGS,
  resolveBookingLocale,
  type BookingGatewayOps,
  type BookingWidgetStrings,
  type BookPayload,
  type ManageView,
} from '@amable/booking';
import { BOOKING_WIDGET_BUNDLE, BOOKING_WIDGET_BUNDLE_HASH } from '@amable/booking/bundle';
import { Hono, type Context } from 'hono';
import type { Env } from '../env';
import { callCore, callCoreRaw, clientInfo, GatewayCallError, tenantRef } from '../gateway';
import {
  CROSS_ORIGIN_BUNDLE,
  escapeHtml,
  HOSTED_WIDGET_CSP,
  inlineJson,
  jsonResponders,
  OPEN_CORS,
  readBoundedText,
  serveBundle,
} from '../public/http';

/**
 * Booking pages on the edge (customer zone or the edge origin):
 * - `GET /booking.js`: embed widget, served from memory (hash ETag);
 * - `GET /b/:slug/:eventSlug`: hosted booking page (noindex);
 * - `GET /b/:slug/:eventSlug/{config,slots,version}` and `POST …/book`: JSON
 *   API of the widget; `GET …/live`: WebSocket of availability changes;
 * - `GET /b/:slug/manage/:token` (+ `POST …/cancel`, `POST …/reschedule`):
 *   the invitee's manage page.
 * CORS is open: embeds live on any site and no cookie is involved.
 */
export const bookingEdgeRoutes = new Hono<{ Bindings: Env }>();

type Ctx = Context<{ Bindings: Env }>;

export const MAX_BOOK_BYTES = 32 * 1024;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/i;
const EVENT_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const { errorJson, okJson, fromGatewayError } = jsonResponders('booking', 'booking service unavailable', OPEN_CORS);

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
main{max-width:920px;margin:40px auto;padding:0 16px}
@media (max-width:680px){main{margin:0;padding:0}}
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
    'content-security-policy': HOSTED_WIDGET_CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };
}

function visitorStrings(c: Ctx): { locale: 'en' | 'it'; strings: BookingWidgetStrings } {
  const locale = resolveBookingLocale('auto', acceptLanguageList(c.req.header('accept-language') ?? null));
  return { locale, strings: BOOKING_WIDGET_STRINGS[locale] };
}

function message(c: Ctx, status: number, text: string): Response {
  const { locale } = visitorStrings(c);
  return c.body(page(locale, text, `<p class="msg">${escapeHtml(text)}</p>`), status as 200, htmlHeaders('no-store'));
}

function eventRef(c: Ctx): { slug: string; eventSlug: string } | null {
  const slug = c.req.param('slug') ?? '';
  const eventSlug = c.req.param('eventSlug') ?? '';
  return SLUG_RE.test(slug) && EVENT_RE.test(eventSlug) ? { slug, eventSlug } : null;
}

function manageRef(c: Ctx): { slug: string; token: string } | null {
  const slug = c.req.param('slug') ?? '';
  const token = c.req.param('token') ?? '';
  return SLUG_RE.test(slug) && TOKEN_RE.test(token) ? { slug, token } : null;
}

async function readJson(c: Ctx): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const raw = await readBoundedText(c, MAX_BOOK_BYTES);
  if (raw === null) return { ok: false, response: errorJson(413, 'payload_too_large', 'request too large') };
  try {
    return { ok: true, value: raw === '' ? {} : (JSON.parse(raw) as unknown) };
  } catch {
    return { ok: false, response: errorJson(400, 'bad_request', 'invalid JSON') };
  }
}

const scriptTag = `<script async src="/booking.js?v=${BOOKING_WIDGET_BUNDLE_HASH}"></script>`;

// -------------------------------------------------------------- widget script

bookingEdgeRoutes.get('/booking.js', (c) => serveBundle(c, BOOKING_WIDGET_BUNDLE, BOOKING_WIDGET_BUNDLE_HASH, CROSS_ORIGIN_BUNDLE));

// ------------------------------------------------------------------- manage

bookingEdgeRoutes.options('/b/:slug/manage/:token/:action', () => new Response(null, { status: 204, headers: OPEN_CORS }));

bookingEdgeRoutes.get('/b/:slug/manage/:token', async (c) => {
  const { strings } = visitorStrings(c);
  const ref = manageRef(c);
  if (ref === null) return message(c, 404, strings.notFound);
  try {
    const { value } = await callCore<BookingGatewayOps, 'booking.manage'>(c.env, 'booking.manage', tenantRef(c, ref.slug), clientInfo(c), {
      token: ref.token,
    });
    const locale = resolveBookingLocale(value.config.locale, acceptLanguageList(c.req.header('accept-language') ?? null));
    const body = `<div data-amable-booking-manage data-amable-tenant="${escapeHtml(ref.slug)}" data-amable-token="${escapeHtml(ref.token)}"></div>
<script type="application/json" id="amable-booking-manage">${inlineJson(value)}</script>
<noscript><form method="post" action="/b/${escapeHtml(ref.slug)}/manage/${escapeHtml(ref.token)}/cancel"><button type="submit">${escapeHtml(BOOKING_WIDGET_STRINGS[locale].cancel)}</button></form></noscript>
${scriptTag}`;
    return c.body(page(locale, `${value.config.title} · ${BOOKING_WIDGET_STRINGS[locale].manageTitle}`, body), 200, htmlHeaders('no-store'));
  } catch (error) {
    if (error instanceof GatewayCallError && error.body.status === 404) return message(c, 404, strings.notFound);
    console.error('[booking] manage page failed', error);
    return message(c, 502, strings.loadError);
  }
});

bookingEdgeRoutes.post('/b/:slug/manage/:token/cancel', async (c) => {
  const ref = manageRef(c);
  if (ref === null) return errorJson(404, 'not_found', 'booking not found');
  const isJson = (c.req.header('content-type') ?? '').toLowerCase().includes('application/json');
  let reason: string | undefined;
  if (isJson) {
    const body = await readJson(c);
    if (!body.ok) return body.response;
    const value = (body.value ?? {}) as { reason?: unknown };
    reason = typeof value.reason === 'string' ? value.reason.slice(0, 500) : undefined;
  }
  try {
    const { value } = await callCore<BookingGatewayOps, 'booking.cancel'>(c.env, 'booking.cancel', tenantRef(c, ref.slug), clientInfo(c), {
      token: ref.token,
      ...(reason === undefined || reason === '' ? {} : { reason }),
    });
    if (isJson) return okJson(value);
    return new Response(null, { status: 303, headers: { location: `/b/${ref.slug}/manage/${ref.token}` } });
  } catch (error) {
    if (isJson) return fromGatewayError(error);
    const { strings } = visitorStrings(c);
    return message(c, error instanceof GatewayCallError ? error.body.status : 502, strings.genericError);
  }
});

bookingEdgeRoutes.post('/b/:slug/manage/:token/reschedule', async (c) => {
  const ref = manageRef(c);
  if (ref === null) return errorJson(404, 'not_found', 'booking not found');
  const body = await readJson(c);
  if (!body.ok) return body.response;
  const value = (body.value ?? {}) as { start?: unknown; time_zone?: unknown };
  if (typeof value.start !== 'string' || typeof value.time_zone !== 'string') {
    return errorJson(422, 'validation_failed', 'start and time_zone are required');
  }
  try {
    const result = await callCore<BookingGatewayOps, 'booking.reschedule'>(
      c.env,
      'booking.reschedule',
      tenantRef(c, ref.slug),
      clientInfo(c),
      { token: ref.token, start: value.start, timeZone: value.time_zone },
    );
    return okJson(result.value satisfies ManageView);
  } catch (error) {
    return fromGatewayError(error);
  }
});

// -------------------------------------------------------------- event pages

for (const path of ['/b/:slug/:eventSlug/config', '/b/:slug/:eventSlug/slots', '/b/:slug/:eventSlug/version', '/b/:slug/:eventSlug/book']) {
  bookingEdgeRoutes.options(path, () => new Response(null, { status: 204, headers: OPEN_CORS }));
}

bookingEdgeRoutes.get('/b/:slug/:eventSlug/config', async (c) => {
  const ref = eventRef(c);
  if (ref === null) return errorJson(404, 'not_found', 'event not found');
  try {
    const { value } = await callCore<BookingGatewayOps, 'booking.config'>(c.env, 'booking.config', tenantRef(c, ref.slug), clientInfo(c), {
      eventSlug: ref.eventSlug,
    });
    return okJson(value, 'public, max-age=30');
  } catch (error) {
    return fromGatewayError(error);
  }
});

bookingEdgeRoutes.get('/b/:slug/:eventSlug/slots', async (c) => {
  const ref = eventRef(c);
  if (ref === null) return errorJson(404, 'not_found', 'event not found');
  const from = c.req.query('from') ?? '';
  const to = c.req.query('to') ?? '';
  const tz = c.req.query('tz') ?? 'UTC';
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || tz.length > 64) {
    return errorJson(422, 'validation_failed', 'from and to must be YYYY-MM-DD');
  }
  try {
    const { value } = await callCore<BookingGatewayOps, 'booking.slots'>(c.env, 'booking.slots', tenantRef(c, ref.slug), clientInfo(c), {
      eventSlug: ref.eventSlug,
      from,
      to,
      timeZone: tz,
    });
    return okJson(value);
  } catch (error) {
    return fromGatewayError(error);
  }
});

bookingEdgeRoutes.get('/b/:slug/:eventSlug/version', async (c) => {
  const ref = eventRef(c);
  if (ref === null) return errorJson(404, 'not_found', 'event not found');
  try {
    const { value } = await callCore<BookingGatewayOps, 'booking.version'>(c.env, 'booking.version', tenantRef(c, ref.slug), clientInfo(c), {
      eventSlug: ref.eventSlug,
    });
    return okJson(value);
  } catch (error) {
    return fromGatewayError(error);
  }
});

bookingEdgeRoutes.get('/b/:slug/:eventSlug/live', async (c) => {
  const ref = eventRef(c);
  if (ref === null) return errorJson(404, 'not_found', 'event not found');
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') return errorJson(426, 'websocket_required', 'expected a WebSocket upgrade');
  try {
    const response = await callCoreRaw(
      c.env,
      BOOKING_LIVE_RAW_OP,
      tenantRef(c, ref.slug),
      clientInfo(c),
      { eventSlug: ref.eventSlug },
      { upgrade: true },
    );
    if (response.status !== 101) return errorJson(response.status === 404 ? 404 : 503, 'live_unavailable', 'live updates unavailable');
    return response;
  } catch (error) {
    return fromGatewayError(error);
  }
});

bookingEdgeRoutes.post('/b/:slug/:eventSlug/book', async (c) => {
  const ref = eventRef(c);
  if (ref === null) return errorJson(404, 'not_found', 'event not found');
  if (!(c.req.header('content-type') ?? '').toLowerCase().includes('application/json')) {
    return errorJson(415, 'unsupported_media_type', 'send JSON');
  }
  const body = await readJson(c);
  if (!body.ok) return body.response;
  try {
    const { value } = await callCore<BookingGatewayOps, 'booking.book'>(c.env, 'booking.book', tenantRef(c, ref.slug), clientInfo(c), {
      eventSlug: ref.eventSlug,
      payload: body.value as BookPayload,
    });
    return okJson(value);
  } catch (error) {
    return fromGatewayError(error);
  }
});

bookingEdgeRoutes.get('/b/:slug/:eventSlug', async (c) => {
  const { strings } = visitorStrings(c);
  const ref = eventRef(c);
  if (ref === null) return message(c, 404, strings.notFound);
  try {
    const { value } = await callCore<BookingGatewayOps, 'booking.hosted'>(c.env, 'booking.hosted', tenantRef(c, ref.slug), clientInfo(c), {
      eventSlug: ref.eventSlug,
    });
    const locale = resolveBookingLocale(value.config.locale, acceptLanguageList(c.req.header('accept-language') ?? null));
    const body = `<div data-amable-booking="${escapeHtml(value.config.slug)}" data-amable-tenant="${escapeHtml(value.config.tenant)}"></div>\n${scriptTag}`;
    return c.body(page(locale, `${value.config.title} · ${value.tenantName}`, body), 200, htmlHeaders('public, max-age=60'));
  } catch (error) {
    if (error instanceof GatewayCallError && error.body.status === 404) return message(c, 404, strings.notFound);
    console.error('[booking] hosted page failed', error);
    return message(c, 502, strings.loadError);
  }
});
