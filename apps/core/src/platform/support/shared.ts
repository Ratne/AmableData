import type { ActingUser } from '@amable/core/platform';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from '../../middleware';
import { getSessionAuth, getTenant, jsonError } from '../../middleware';
import { ControlPlaneError, controlPlaneClient, type ControlPlaneClient } from '../client';

/** Domain of the dedicated support users created by assisted access (never deliverable). */
export const SUPPORT_EMAIL_DOMAIN = 'support.invalid';

export function isSupportUserEmail(email: string): boolean {
  return email.toLowerCase().endsWith(`@${SUPPORT_EMAIL_DOMAIN}`);
}

/** The CRM user acting through the proxy: identity and role only, never contact data. */
export function actingUser(c: Context<AppEnv>): ActingUser {
  const { user } = getSessionAuth(c);
  const { tenant, role } = getTenant(c);
  return { userId: user.id, name: user.name, email: user.email, role, tenantId: tenant.id };
}

/** 404 `platform_unavailable` on an open source installation (no license). */
export function requirePlatform(c: Context<AppEnv>): ControlPlaneClient | Response {
  const client = controlPlaneClient(c.env);
  return client ?? jsonError(c, 404, 'platform_unavailable');
}

/** Cookie sessions only: platform actions are attributed to a person, never to an API key. */
export function sessionOnly(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.get('auth')?.kind !== 'session') return jsonError(c, 403, 'session_required');
    return next();
  };
}

/** Guard for full-export routes: assisted-access support users may never bulk-export tenant data. */
export function rejectSupportUsers(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.get('auth');
    if (auth !== undefined && isSupportUserEmail(auth.user.email)) return jsonError(c, 403, 'support_user_forbidden');
    return next();
  };
}

/** Maps a control plane failure to the installation's answer (never leaks upstream bodies). */
export function controlPlaneFailure(c: Context<AppEnv>, error: unknown): Response {
  if (!(error instanceof ControlPlaneError)) throw error;
  if (error.status === 0) return jsonError(c, 503, 'platform_unreachable');
  if (error.status === 402) return jsonError(c, 402, 'services_suspended');
  if (error.status === 404) return jsonError(c, 404, 'not_found');
  if (error.status === 413) return jsonError(c, 413, 'attachment_too_large');
  if (error.status === 415) return jsonError(c, 415, 'attachment_type_not_allowed');
  if (error.status === 409 || error.status === 422) return jsonError(c, error.status, error.code);
  return jsonError(c, 502, 'platform_error');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
