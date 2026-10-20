import { sha256Hex, type RateLimiter, type RateLimitRule } from '@amable/auth';
import { ROLE_PERMISSIONS } from '@amable/core';
import type { Context } from 'hono';
import type { AppEnv } from '../middleware/context';
import { HttpError } from '../middleware/errors';
import { isManagedOffering } from '../platform/billing';
import type { AuthServices } from './services';
import {
  countRecoveryCodes,
  findTenantById,
  listMemberships,
  type UserRow,
} from './store';

export async function enforceLimit(limiter: RateLimiter, rule: RateLimitRule, key: string) {
  const result = await limiter.consume(rule, key);
  if (!result.allowed) {
    throw new HttpError(429, 'rate_limited', { retryAfterMs: result.retryAfterMs });
  }
}

let dummyHash: Promise<string> | null = null;

/**
 * Verifies a password, hashing against a dummy value when the account does not
 * exist so response time does not reveal which emails are registered.
 */
export async function verifyPasswordUniform(
  services: AuthServices,
  storedHash: string | null,
  password: string,
): Promise<boolean> {
  if (storedHash === null) {
    dummyHash ??= services.hasher.hash('timing-equalizer-password');
    await services.hasher.verify(await dummyHash, password);
    return false;
  }
  return services.hasher.verify(storedHash, password);
}

export function accountKey(email: string): Promise<string> {
  return sha256Hex(`account:${email}`);
}

export function publicUser(user: Pick<UserRow, 'id' | 'email' | 'name' | 'locale' | 'theme'>) {
  return { id: user.id, email: user.email, name: user.name, locale: user.locale, theme: user.theme };
}

/** Body of GET /api/me and of the "authenticated" login response. */
export async function meBody(c: Context<AppEnv>, user: UserRow) {
  const memberships = await listMemberships(c.env.DB, user.id);
  const last =
    user.lastTenantId === null ? null : await findTenantById(c.env.DB, user.lastTenantId);
  const lastIsMember = last !== null && memberships.some((m) => m.tenantId === last.id);
  return {
    user: publicUser(user),
    mfa: {
      method: user.mfaMethod,
      recoveryCodesLeft: await countRecoveryCodes(c.env.DB, user.id),
    },
    memberships: memberships.map((m) => ({
      slug: m.slug,
      name: m.name,
      role: m.role,
      permissions: ROLE_PERMISSIONS[m.role],
    })),
    lastTenantSlug: lastIsMember ? last.slug : (memberships[0]?.slug ?? null),
    // Cloud workspaces are sold through the portal, never created from the switcher.
    canCreateTenant:
      memberships.some((m) => m.role === 'owner') &&
      !(await isManagedOffering(c.env)),
  };
}
