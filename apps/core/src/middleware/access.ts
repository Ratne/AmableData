import {
  AUTH_POLICY,
  effectiveKeyPermissions,
  hashApiKey,
  looksLikeApiKey,
  sessionState,
  sha256Hex,
  slideSession,
} from '@amable/auth';
import { PERMISSIONS, ROLE_PERMISSIONS, type Permission } from '@amable/core';
import type { Context, MiddlewareHandler } from 'hono';
import { RATE_RULES } from '../auth/rate-limit';
import { clearSessionCookie, readSessionToken } from '../auth/sessions';
import {
  deleteSessionByHash,
  findApiKeyByHash,
  findMembership,
  findSessionByHash,
  findTenantBySlug,
  findUserById,
  setLastTenant,
  touchApiKey,
  touchSession,
} from '../auth/store';
import type { DurableObjectStubOf } from './tenant-db';
import type { AppEnv, AuthContext, TenantContext } from './context';
import { jsonError } from './errors';
import { defer } from './request';

/**
 * THE central access middleware. Every route that touches user or tenant data
 * goes through `requireAuth` → (`requireTenant`) → `requirePermission`. Tenant
 * Durable Objects are only reachable through `tenantDb(c)`, which requires a
 * verified tenant context.
 */

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function bearerToken(c: Context): string | null {
  const header = c.req.header('authorization');
  if (header === undefined) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1] ?? null;
}

async function resolveApiKey(c: Context<AppEnv>, token: string): Promise<AuthContext | null> {
  if (!looksLikeApiKey(token)) return null;
  const key = await findApiKeyByHash(c.env.DB, await hashApiKey(token));
  if (key === null || key.createdBy === null) return null;
  const creator = await findUserById(c.env.DB, key.createdBy);
  if (creator === null || creator.disabledAt !== null) return null;
  const services = c.get('services');
  const limit = await services.apiLimiter.consume(RATE_RULES.apiKey, key.id);
  if (!limit.allowed) return null;
  await defer(c, touchApiKey(c.env.DB, key.id, services.now()));
  return {
    kind: 'api_key',
    user: {
      id: creator.id,
      email: creator.email,
      name: creator.name,
      locale: creator.locale,
      theme: creator.theme,
      lastTenantId: creator.lastTenantId,
    },
    session: null,
    apiKey: {
      id: key.id,
      tenantId: key.tenantId,
      scopes: key.scopes.filter((s) => PERMISSION_SET.has(s)),
      createdBy: key.createdBy,
    },
  };
}

type SessionResolution =
  | { ok: true; auth: AuthContext }
  | { ok: false; code: 'unauthenticated' | 'session_expired' };

async function resolveSession(c: Context<AppEnv>): Promise<SessionResolution> {
  const token = readSessionToken(c);
  if (token === undefined || token.length < 20 || token.length > 128) {
    return { ok: false, code: 'unauthenticated' };
  }
  const hash = await sha256Hex(token);
  const session = await findSessionByHash(c.env.DB, hash);
  if (session === null) return { ok: false, code: 'unauthenticated' };
  const now = c.get('services').now();
  if (sessionState(session, now) !== 'valid') {
    await deleteSessionByHash(c.env.DB, hash);
    return { ok: false, code: 'session_expired' };
  }
  const user = await findUserById(c.env.DB, session.userId);
  if (user === null || user.disabledAt !== null) {
    await deleteSessionByHash(c.env.DB, hash);
    return { ok: false, code: 'unauthenticated' };
  }
  const slide = slideSession(session, now);
  if (slide !== null) await touchSession(c.env.DB, hash, slide.lastSeenAt, slide.expiresAt);
  return {
    ok: true,
    auth: {
      kind: 'session',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        locale: user.locale,
        theme: user.theme,
        lastTenantId: user.lastTenantId,
      },
      session: { publicId: session.publicId, hash, stepUpAt: session.stepUpAt },
      apiKey: null,
    },
  };
}

/**
 * Resolves the caller: session cookie, or `Authorization: Bearer amb_live_…`
 * when `apiKey: true`. 401 otherwise.
 */
export function requireAuth(options: { apiKey?: boolean } = {}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.get('auth') !== undefined) return next();
    const bearer = bearerToken(c);
    if (bearer !== null) {
      if (options.apiKey !== true) return jsonError(c, 401, 'api_key_not_allowed');
      const auth = await resolveApiKey(c, bearer);
      if (auth === null) return jsonError(c, 401, 'invalid_api_key');
      c.set('auth', auth);
      return next();
    }
    const resolved = await resolveSession(c);
    if (!resolved.ok) {
      clearSessionCookie(c);
      return jsonError(c, 401, resolved.code);
    }
    c.set('auth', resolved.auth);
    return next();
  };
}

function buildTenantContext(
  tenant: { id: string; slug: string; name: string },
  role: TenantContext['role'],
  permissions: ReadonlySet<Permission>,
): TenantContext {
  return { tenant, role, permissions, can: (p) => permissions.has(p) };
}

/**
 * Resolves `:slug` → tenant and verifies membership (or that the API key
 * belongs to that tenant). Unknown tenant and "not a member" are the same 404,
 * so tenants cannot be enumerated. The tenant id is never taken from the client.
 */
export function requireTenant(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.get('auth');
    if (auth === undefined) throw new Error('requireTenant() used without requireAuth()');
    const slug = c.req.param('slug');
    if (slug === undefined || !SLUG_RE.test(slug)) return jsonError(c, 404, 'tenant_not_found');
    const tenant = await findTenantBySlug(c.env.DB, slug);
    if (tenant === null) return jsonError(c, 404, 'tenant_not_found');

    if (auth.kind === 'api_key') {
      if (auth.apiKey.tenantId !== tenant.id) return jsonError(c, 404, 'tenant_not_found');
      const creatorRole = await findMembership(c.env.DB, auth.apiKey.createdBy, tenant.id);
      if (creatorRole === null) return jsonError(c, 401, 'invalid_api_key');
      const permissions = effectiveKeyPermissions(
        auth.apiKey.scopes as readonly Permission[],
        ROLE_PERMISSIONS[creatorRole],
      );
      c.set('tenant', buildTenantContext(tenant, creatorRole, permissions));
      return next();
    }

    const role = await findMembership(c.env.DB, auth.user.id, tenant.id);
    if (role === null) return jsonError(c, 404, 'tenant_not_found');
    c.set('tenant', buildTenantContext(tenant, role, new Set(ROLE_PERMISSIONS[role])));
    if (auth.user.lastTenantId !== tenant.id) {
      await defer(c, setLastTenant(c.env.DB, auth.user.id, tenant.id));
    }
    return next();
  };
}

/** Resolves a session cookie when present and valid; never rejects (public routes). */
export function optionalAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.get('auth') === undefined && readSessionToken(c) !== undefined) {
      const resolved = await resolveSession(c);
      if (resolved.ok) c.set('auth', resolved.auth);
    }
    return next();
  };
}

/** 403 unless the verified tenant context grants every listed permission. */
export function requirePermission(...required: Permission[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const tenant = c.get('tenant');
    if (tenant === undefined) throw new Error('requirePermission() used without requireTenant()');
    const missing = required.filter((p) => !tenant.permissions.has(p));
    if (missing.length > 0) return jsonError(c, 403, 'forbidden', { missing });
    return next();
  };
}

/**
 * Sensitive actions require a recently re-entered second factor
 * (POST /api/auth/step-up/*). API keys can never satisfy a step-up.
 */
export function requireStepUp(
  maxAgeMs: number = AUTH_POLICY.stepUpMaxAgeMs,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.get('auth');
    if (auth === undefined) throw new Error('requireStepUp() used without requireAuth()');
    if (auth.kind !== 'session') return jsonError(c, 403, 'session_required');
    const at = auth.session.stepUpAt;
    if (at === null || c.get('services').now() - at > maxAgeMs) {
      return jsonError(c, 403, 'step_up_required');
    }
    return next();
  };
}

/**
 * Step-up for browser sessions on actions that reveal or replace secrets
 * (webhook and signing secrets, domains): a stolen cookie alone is not enough.
 * API keys pass: they are explicit integrations bounded by their scopes.
 */
export function requireStepUpForSession(
  maxAgeMs: number = AUTH_POLICY.stepUpMaxAgeMs,
): MiddlewareHandler<AppEnv> {
  const sessionGuard = requireStepUp(maxAgeMs);
  return async (c, next) => {
    if (c.get('auth')?.kind === 'api_key') return next();
    return sessionGuard(c, next);
  };
}

/** `requireStepUpForSession` only for requests `when` flags (e.g. a PATCH that replaces a secret). */
export function requireStepUpForSessionWhen(
  when: (c: Context<AppEnv>) => boolean | Promise<boolean>,
  maxAgeMs: number = AUTH_POLICY.stepUpMaxAgeMs,
): MiddlewareHandler<AppEnv> {
  const guard = requireStepUpForSession(maxAgeMs);
  return async (c, next) => ((await when(c)) ? guard(c, next) : next());
}

export function getAuth(c: Context<AppEnv>): AuthContext {
  const auth = c.get('auth');
  if (auth === undefined) throw new Error('getAuth() used on a route without requireAuth()');
  return auth;
}

/** Same as getAuth but narrowed to cookie sessions (403 handled by the caller's guard). */
export function getSessionAuth(c: Context<AppEnv>): Extract<AuthContext, { kind: 'session' }> {
  const auth = getAuth(c);
  if (auth.kind !== 'session') throw new Error('route requires a session, got an API key');
  return auth;
}

export function getTenant(c: Context<AppEnv>): TenantContext {
  const tenant = c.get('tenant');
  if (tenant === undefined) throw new Error('getTenant() used on a route without requireTenant()');
  return tenant;
}

/** Only sessions (not API keys) may pass — for account and admin-only flows. */
export function requireSession(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (getAuth(c).kind !== 'session') return jsonError(c, 403, 'session_required');
    return next();
  };
}

/** TenantDb Durable Object stub of the verified tenant — the only sanctioned way to reach it. */
export function tenantDb(c: Context<AppEnv>): DurableObjectStubOf {
  const { tenant } = getTenant(c);
  return c.env.TENANT_DB.get(c.env.TENANT_DB.idFromName(tenant.id));
}
