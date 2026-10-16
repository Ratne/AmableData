import { checkCsrf, CSRF_HEADER } from '@amable/auth';
import type { Context, MiddlewareHandler } from 'hono';
import { AuthConfigError, getAuthServices } from '../auth/services';
import type { Env } from '../env';
import type { AppEnv } from './context';
import { jsonError } from './errors';

/** Origins accepted for cookie-authenticated, state-changing requests. */
export function allowedOrigins(env: Env, requestUrl: string): string[] {
  const origins = new Set<string>([new URL(requestUrl).origin]);
  if (env.APP_ORIGIN !== undefined && env.APP_ORIGIN !== '') origins.add(env.APP_ORIGIN);
  for (const origin of (env.ALLOWED_ORIGINS ?? '').split(',')) {
    if (origin.trim() !== '') origins.add(origin.trim());
  }
  if (env.ENVIRONMENT === 'dev') {
    origins.add('http://localhost:5173');
    origins.add('http://localhost:8787');
  }
  return [...origins];
}

/** Origin used to build links in emails (magic link, reset, invites). */
export function appOrigin(c: Context<AppEnv>): string {
  const configured = c.env.APP_ORIGIN;
  if (configured !== undefined && configured !== '') return configured;
  // On Workers the Host is the routed hostname (custom domain or workers.dev),
  // so the request origin is trustworthy here.
  return new URL(c.req.url).origin;
}

/** Baseline headers on every API response. HTML documents get the CSP from serveSpa. */
export function apiSecurityHeaders(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    const h = c.res.headers;
    h.set('Cache-Control', 'no-store');
    h.set('X-Content-Type-Options', 'nosniff');
    h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    h.set('X-Frame-Options', 'DENY');
    h.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    h.set('Cross-Origin-Resource-Policy', 'same-origin');
    if (new URL(c.req.url).protocol === 'https:') {
      h.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    }
  };
}

const API_CORS_PREFIX = '/api/v2/';

function apiCorsOrigin(env: Env, origin: string | undefined): string | null {
  if (origin === undefined || origin === '' || origin === 'null') return null;
  const configured = (env.API_CORS_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');
  if (configured.includes('*')) return '*';
  return configured.includes(origin) ? origin : null;
}

/**
 * CORS for the API-key REST surface only (`/api/v2/*`), for the origins listed
 * in `API_CORS_ORIGINS` (`*` = any). Credentials are never allowed, so a
 * browser can call the API with a Bearer key but never ride the session
 * cookie; every other /api route (session, auth, account) emits no CORS
 * header at all. Preflights are answered here, before authentication.
 */
export function apiCors(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!new URL(c.req.url).pathname.startsWith(API_CORS_PREFIX)) return next();
    const allowed = apiCorsOrigin(c.env, c.req.header('origin'));
    if (c.req.method === 'OPTIONS' && c.req.header('access-control-request-method') !== undefined) {
      const headers = new Headers({ Vary: 'Origin' });
      if (allowed !== null) {
        headers.set('Access-Control-Allow-Origin', allowed);
        headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE');
        headers.set('Access-Control-Allow-Headers', 'authorization, content-type, idempotency-key');
        headers.set('Access-Control-Max-Age', '600');
      }
      return new Response(null, { status: allowed === null ? 403 : 204, headers });
    }
    await next();
    c.res.headers.append('Vary', 'Origin');
    if (allowed !== null) {
      c.res.headers.set('Access-Control-Allow-Origin', allowed);
      c.res.headers.set('Access-Control-Expose-Headers', 'retry-after, x-request-id');
    }
  };
}

/**
 * CSRF guard for every state-changing /api request that is not a Bearer
 * (API key) call — including unauthenticated ones like login, to stop login
 * CSRF. Inbound webhooks (later phases) are listed in `exempt`.
 */
export function csrfProtection(
  options: { exempt?: readonly string[] } = {},
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (options.exempt?.some((prefix) => path.startsWith(prefix)) === true) return next();
    if (/^Bearer\s/i.test(c.req.header('authorization') ?? '')) return next();
    const failure = checkCsrf({
      method: c.req.method,
      origin: c.req.header('origin') ?? null,
      customHeader: c.req.header(CSRF_HEADER) ?? null,
      allowedOrigins: allowedOrigins(c.env, c.req.url),
    });
    if (failure !== null) return jsonError(c, 403, 'csrf_rejected', { reason: failure });
    return next();
  };
}

/** Resolves the auth service container once per isolate. */
export function authServices(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    try {
      c.set('services', await getAuthServices(c.env));
    } catch (error) {
      if (error instanceof AuthConfigError) {
        console.error(`[auth] ${error.message}`);
        return jsonError(c, 503, 'auth_not_configured');
      }
      throw error;
    }
    return next();
  };
}
