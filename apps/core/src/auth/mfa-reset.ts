import { AUTH_POLICY, randomToken, sha256Hex } from '@amable/auth';
import { formatDateTime, resolveLocale } from '@amable/i18n';
import type { Context } from 'hono';
import { audit } from '../middleware/audit';
import type { AppEnv } from '../middleware/context';
import { defer } from '../middleware/request';
import { appOrigin } from '../middleware/security';
import { sendSystemEmail } from './emails';
import {
  applyDueMfaReset,
  cancelMfaReset,
  findUserById,
  insertToken,
  invalidateTokens,
  scheduleMfaReset,
  type UserRow,
} from './store';

/**
 * Recovery of a lost second factor. The user proves the email address with a
 * code, then the factor is cleared after `AUTH_POLICY.mfaResetDelayMs` and
 * they enroll a new one at the next sign-in. Until then the request is
 * cancelled by the link in the warning email, from Security, or by any
 * successful use of the old factor (so whoever still has it wins).
 */

/** Schedules the reset (a pending one keeps its due time) and mails the cancel link. */
export async function scheduleReset(c: Context<AppEnv>, user: UserRow): Promise<number> {
  const services = c.get('services');
  const now = services.now();
  const dueAt = await scheduleMfaReset(c.env.DB, user.id, now + AUTH_POLICY.mfaResetDelayMs, now);
  const token = randomToken(32);
  await insertToken(c.env.DB, {
    hash: await sha256Hex(token),
    purpose: 'mfa_reset_cancel',
    userId: user.id,
    email: null,
    now,
    expiresAt: dueAt,
  });
  await audit(c, 'auth.mfa_reset_requested', {
    actorUserId: user.id,
    tenantId: null,
    details: { dueAt },
  });
  const locale = resolveLocale(user.locale);
  await sendSystemEmail(services, user.email, locale, 'mfa_reset_scheduled', {
    until: `${formatDateTime(locale, dueAt, 'UTC')} UTC`,
    cancelUrl: `${appOrigin(c)}/auth/mfa-reset/cancel#token=${token}`,
  });
  return dueAt;
}

export type ResetCancelReason = 'link' | 'settings' | 'factor_used';

/** Cancels a pending reset; false when none was pending. */
export async function cancelReset(
  c: Context<AppEnv>,
  user: UserRow,
  reason: ResetCancelReason,
): Promise<boolean> {
  const services = c.get('services');
  const now = services.now();
  if (!(await cancelMfaReset(c.env.DB, user.id, now))) return false;
  await invalidateTokens(c.env.DB, user.id, 'mfa_reset_cancel', now);
  await audit(c, 'auth.mfa_reset_cancelled', {
    actorUserId: user.id,
    tenantId: null,
    details: { reason },
  });
  await defer(c, sendSystemEmail(services, user.email, user.locale, 'mfa_reset_cancelled', {}));
  return true;
}

/**
 * Applies the reset when its time has come, before a sign-in or step-up opens
 * a challenge. Returns the user as it is now (without a factor once applied).
 */
export async function applyDueReset(c: Context<AppEnv>, user: UserRow): Promise<UserRow> {
  const services = c.get('services');
  const now = services.now();
  if (user.mfaResetDueAt === null || user.mfaResetDueAt > now) return user;
  if (await applyDueMfaReset(c.env.DB, user.id, now)) {
    await audit(c, 'auth.mfa_reset_applied', { actorUserId: user.id, tenantId: null });
    await defer(c, sendSystemEmail(services, user.email, user.locale, 'mfa_reset_done', {}));
  }
  return (await findUserById(c.env.DB, user.id)) ?? user;
}
