import { Hono, type Context } from 'hono';
import { pageLocale, pageText, renderUnsubscribePage } from './pages';

/**
 * Email recipient endpoints on the customer's tracking domain:
 * - `GET /r/:token`  click redirect (302 to the signed destination + `_amb_c`);
 * - `GET /o/:token`  open pixel (1×1 GIF, recorded in the background);
 * - `GET /unsub/:token`  hosted unsubscribe page; `POST` confirms, including
 *   RFC 8058 one-click (`List-Unsubscribe=One-Click`).
 *
 * The edge holds no secret: tokens are verified by the core worker, reached
 * through the `CORE` service binding when present or `CORE_ORIGIN` over HTTPS
 * (no deploy-time cycle with the core → edge Durable Object binding).
 */
export interface EmailEdgeEnv {
  CORE?: Fetcher;
  /** Public origin of the core worker, e.g. https://crm.customer.example (dev: http://localhost:8787). */
  CORE_ORIGIN?: string;
}

type EmailEnv = { Bindings: EmailEdgeEnv };

const TOKEN_RE = /^[A-Za-z0-9_-]{8,4000}\.[A-Za-z0-9_-]{8,64}$/;
const PIXEL = Uint8Array.from(
  atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'),
  (ch) => ch.charCodeAt(0),
);
const NO_STORE = 'no-store, no-cache, must-revalidate, private';
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'";

/** POSTs to the core public email endpoints; null when unreachable. */
export async function callCore<T>(env: EmailEdgeEnv, path: string, body: unknown): Promise<T | null> {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  };
  try {
    let response: Response;
    if (env.CORE !== undefined) response = await env.CORE.fetch(`https://core${path}`, init);
    else if (env.CORE_ORIGIN !== undefined) response = await fetch(`${env.CORE_ORIGIN.replace(/\/+$/, '')}${path}`, init);
    else return null;
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export const emailEdgeRoutes = new Hono<EmailEnv>();

emailEdgeRoutes.get('/r/:token', async (c) => {
  const token = c.req.param('token');
  const locale = pageLocale(c.req.header('accept-language'));
  const result = TOKEN_RE.test(token)
    ? await callCore<{ url?: unknown }>(c.env, '/edge/email/click', { token })
    : null;
  const url = typeof result?.url === 'string' && /^https?:\/\//i.test(result.url) ? result.url : null;
  if (url === null) {
    return c.html(renderUnsubscribePage(locale, { message: 'invalid' }), 404, {
      'cache-control': NO_STORE,
      'content-security-policy': PAGE_CSP,
    });
  }
  return c.redirect(url, 302);
});

emailEdgeRoutes.get('/o/:token', (c) => {
  const token = c.req.param('token');
  if (TOKEN_RE.test(token)) {
    c.executionCtx.waitUntil(callCore(c.env, '/edge/email/open', { token }).then(() => undefined));
  }
  return c.body(PIXEL, 200, {
    'content-type': 'image/gif',
    'cache-control': NO_STORE,
    'content-length': String(PIXEL.byteLength),
  });
});

function page(c: Context<EmailEnv>, html: string, status: 200 | 400 | 404 | 502 = 200): Response {
  return c.html(html, status, {
    'cache-control': NO_STORE,
    'content-security-policy': PAGE_CSP,
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex',
  });
}

interface UnsubInfo {
  valid?: boolean;
  email?: string | null;
  alreadyUnsubscribed?: boolean;
}

emailEdgeRoutes.get('/unsub/:token', async (c) => {
  const token = c.req.param('token');
  const locale = pageLocale(c.req.header('accept-language'));
  if (token === 'test') return page(c, renderUnsubscribePage(locale, { message: 'test' }));
  if (!TOKEN_RE.test(token)) return page(c, renderUnsubscribePage(locale, { message: 'invalid' }), 404);
  const info = await callCore<UnsubInfo>(c.env, '/edge/email/unsubscribe/info', { token });
  if (info === null) return page(c, renderUnsubscribePage(locale, { message: 'error' }), 502);
  if (info.valid !== true) return page(c, renderUnsubscribePage(locale, { message: 'invalid' }), 404);
  if (info.alreadyUnsubscribed === true) return page(c, renderUnsubscribePage(locale, { message: 'already' }));
  return page(c, renderUnsubscribePage(locale, { message: 'confirm', email: info.email ?? '', form: true }));
});

emailEdgeRoutes.post('/unsub/:token', async (c) => {
  const token = c.req.param('token');
  const locale = pageLocale(c.req.header('accept-language'));
  const raw = (await c.req.text()).slice(0, 2048);
  const oneClick = /(^|&)List-Unsubscribe=One-Click(&|$)/.test(raw);
  if (token === 'test') {
    return oneClick ? c.text('ok') : page(c, renderUnsubscribePage(locale, { message: 'test' }));
  }
  if (!TOKEN_RE.test(token)) {
    return oneClick ? c.text('invalid', 400) : page(c, renderUnsubscribePage(locale, { message: 'invalid' }), 404);
  }
  const result = await callCore<{ ok?: boolean }>(c.env, '/edge/email/unsubscribe', {
    token,
    via: oneClick ? 'one_click' : 'link',
  });
  if (oneClick) return result?.ok === true ? c.text(pageText(locale, 'done')) : c.text('error', 400);
  if (result?.ok !== true) return page(c, renderUnsubscribePage(locale, { message: 'invalid' }), 400);
  return page(c, renderUnsubscribePage(locale, { message: 'done' }));
});
