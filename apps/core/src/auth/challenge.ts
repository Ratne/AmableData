import {
  AUTH_POLICY,
  describeUserAgent,
  generateNumericCode,
  generateRecoveryCodes,
  generateTotpSecret,
  hmacSha256Hex,
  normalizeRecoveryCode,
  otpauthUri,
  randomToken,
  sha256Hex,
  timingSafeEqual,
  verifyTotp,
} from '@amable/auth';
import { formatDateTime, resolveLocale } from '@amable/i18n';
import type { Context } from 'hono';
import { audit } from '../middleware/audit';
import type { AppEnv } from '../middleware/context';
import { HttpError } from '../middleware/errors';
import { defer } from '../middleware/request';
import { sendSystemEmail } from './emails';
import { RATE_RULES } from './rate-limit';
import { setChallengeCookie } from './sessions';
import {
  cancelChallenge,
  claimTotpStep,
  completeChallenge,
  consumeRecoveryCode,
  enrollMfa,
  insertChallenge,
  registerFailedChallenge,
  replaceRecoveryCodes,
  reserveAttempt,
  setChallengeEmailCode,
  setChallengePendingTotp,
  type ChallengePurpose,
  type ChallengeRow,
  type FirstFactor,
  type UserRow,
} from './store';

/**
 * Second-factor challenges.
 *
 * - Max 3 OTP attempts per challenge. Each attempt is *reserved* with an
 *   atomic UPDATE before the code is checked, so parallel requests can never
 *   test more than 3 codes. The 3rd failure cancels the challenge (and its
 *   email code), mails the user and counts toward the account lockout.
 * - 3 consecutive cancelled challenges lock the account for 15 min, doubling
 *   at every further lock (atomic counter in D1).
 */

export type OtpMethod = 'totp' | 'email' | 'recovery';
export type VerifyMethod = OtpMethod | 'enroll_totp' | 'enroll_email';

export const ISSUER = 'amabledata';

/** Methods a challenge accepts, given the user's enrollment and how they got here. */
export function allowedMethods(user: UserRow, challenge: Pick<ChallengeRow, 'purpose' | 'firstFactor'>): VerifyMethod[] {
  if (challenge.purpose === 'enroll' || user.mfaMethod === null) {
    return ['enroll_totp', 'enroll_email'];
  }
  if (user.mfaMethod === 'email') return ['email', 'recovery'];
  // TOTP users may fall back to an email code only after a password: after a
  // magic link (email possession already proven) email would not be a 2nd factor.
  return challenge.purpose === 'login' && challenge.firstFactor === 'password'
    ? ['totp', 'email', 'recovery']
    : ['totp', 'recovery'];
}

export interface ChallengeState {
  status: 'mfa_required';
  enrolled: boolean;
  methods: VerifyMethod[];
  attemptsLeft: number;
  expiresAt: number;
}

export function describeChallenge(user: UserRow, challenge: ChallengeRow): ChallengeState {
  return {
    status: 'mfa_required',
    enrolled: user.mfaMethod !== null && challenge.purpose !== 'enroll',
    methods: allowedMethods(user, challenge),
    attemptsLeft: Math.max(AUTH_POLICY.maxOtpAttempts - challenge.attempts, 0),
    expiresAt: challenge.expiresAt,
  };
}

/** Starts a login challenge bound to this device through the challenge cookie. */
export async function startLoginChallenge(
  c: Context<AppEnv>,
  user: UserRow,
  firstFactor: FirstFactor,
): Promise<ChallengeState> {
  const now = c.get('services').now();
  const token = randomToken(32);
  const id = await sha256Hex(token);
  await insertChallenge(c.env.DB, {
    id,
    userId: user.id,
    purpose: 'login',
    firstFactor,
    sessionPublicId: null,
    now,
    expiresAt: now + AUTH_POLICY.challengeTtlMs,
  });
  setChallengeCookie(c, token);
  return describeChallenge(user, {
    id,
    userId: user.id,
    purpose: 'login',
    firstFactor,
    sessionPublicId: null,
    status: 'pending',
    attempts: 0,
    emailCodeHash: null,
    emailCodeExpiresAt: null,
    pendingTotpSecretEnc: null,
    createdAt: now,
    expiresAt: now + AUTH_POLICY.challengeTtlMs,
  });
}

/** Starts a step-up or enroll challenge tied to the live session. */
export async function startSessionChallenge(
  c: Context<AppEnv>,
  user: UserRow,
  sessionPublicId: string,
  purpose: Extract<ChallengePurpose, 'step_up' | 'enroll'>,
): Promise<ChallengeRow> {
  const now = c.get('services').now();
  const id = await sha256Hex(randomToken(32));
  const row: ChallengeRow = {
    id,
    userId: user.id,
    purpose,
    firstFactor: 'session',
    sessionPublicId,
    status: 'pending',
    attempts: 0,
    emailCodeHash: null,
    emailCodeExpiresAt: null,
    pendingTotpSecretEnc: null,
    createdAt: now,
    expiresAt: now + AUTH_POLICY.challengeTtlMs,
  };
  await insertChallenge(c.env.DB, { ...row, now });
  return row;
}

async function emailCodeHash(pepper: string, challengeId: string, code: string) {
  return hmacSha256Hex(pepper, `email-otp:${challengeId}:${code}`);
}

export async function recoveryCodeHash(pepper: string, code: string) {
  return hmacSha256Hex(pepper, `recovery:${normalizeRecoveryCode(code)}`);
}

/** Sends a 6-digit email code for this challenge: at most 1/minute and 5/hour per user. */
export async function sendEmailCode(c: Context<AppEnv>, user: UserRow, challenge: ChallengeRow) {
  const methods = allowedMethods(user, challenge);
  if (!methods.includes('email') && !methods.includes('enroll_email')) {
    throw new HttpError(400, 'method_not_allowed');
  }
  const services = c.get('services');
  const now = services.now();
  if (challenge.status !== 'pending' || challenge.expiresAt <= now) {
    throw new HttpError(401, 'challenge_expired');
  }
  for (const rule of [RATE_RULES.emailCodeMinute, RATE_RULES.emailCodeHour]) {
    const result = await services.limiter.consume(rule, user.id);
    if (!result.allowed) {
      throw new HttpError(429, 'rate_limited', { retryAfterMs: result.retryAfterMs });
    }
  }
  const code = generateNumericCode(6);
  const expiresAt = Math.min(now + AUTH_POLICY.emailCodeTtlMs, challenge.expiresAt);
  await setChallengeEmailCode(
    c.env.DB,
    challenge.id,
    await emailCodeHash(services.pepper, challenge.id, code),
    expiresAt,
  );
  // OTP codes are sent immediately, never queued.
  await sendSystemEmail(services, user.email, user.locale, 'email_code', {
    code,
    minutes: Math.round(AUTH_POLICY.emailCodeTtlMs / 60_000),
  });
}

/** TOTP enrollment: a new secret kept encrypted on the challenge until confirmed. */
export async function startTotpEnrollment(c: Context<AppEnv>, user: UserRow, challenge: ChallengeRow) {
  if (!allowedMethods(user, challenge).includes('enroll_totp')) {
    throw new HttpError(400, 'method_not_allowed');
  }
  const services = c.get('services');
  const secret = generateTotpSecret();
  await setChallengePendingTotp(
    c.env.DB,
    challenge.id,
    await services.secretBox.encrypt(secret, `totp:${user.id}`),
  );
  return { secret, otpauthUri: otpauthUri({ secret, account: user.email, issuer: ISSUER }) };
}

export type VerifyOutcome =
  | { status: 'ok'; method: VerifyMethod; recoveryCodes: string[] | null }
  | { status: 'wrong'; attemptsLeft: number }
  | { status: 'cancelled'; locked: boolean; lockedUntil: number | null }
  | { status: 'expired' };

async function checkCode(
  c: Context<AppEnv>,
  user: UserRow,
  challenge: ChallengeRow,
  method: VerifyMethod,
  code: string,
): Promise<{ totpStep: number | null } | null> {
  const services = c.get('services');
  const now = services.now();
  switch (method) {
    case 'totp': {
      if (user.totpSecretEnc === null) return null;
      const secret = await services.secretBox.decrypt(user.totpSecretEnc, `totp:${user.id}`);
      const result = await verifyTotp(secret, code, now, user.totpLastStep);
      return result.ok && (await claimTotpStep(c.env.DB, user.id, result.step))
        ? { totpStep: result.step }
        : null;
    }
    case 'enroll_totp': {
      if (challenge.pendingTotpSecretEnc === null) return null;
      const secret = await services.secretBox.decrypt(
        challenge.pendingTotpSecretEnc,
        `totp:${user.id}`,
      );
      const result = await verifyTotp(secret, code, now, null);
      return result.ok ? { totpStep: result.step } : null;
    }
    case 'email':
    case 'enroll_email': {
      if (challenge.emailCodeHash === null || challenge.emailCodeExpiresAt === null) return null;
      if (challenge.emailCodeExpiresAt <= now) return null;
      const normalized = code.replace(/\s+/g, '');
      if (!/^\d{6}$/.test(normalized)) return null;
      const matches = timingSafeEqual(
        await emailCodeHash(services.pepper, challenge.id, normalized),
        challenge.emailCodeHash,
      );
      return matches ? { totpStep: null } : null;
    }
    case 'recovery': {
      const consumed = await consumeRecoveryCode(
        c.env.DB,
        user.id,
        await recoveryCodeHash(services.pepper, code),
        now,
      );
      return consumed ? { totpStep: null } : null;
    }
  }
}

/** Generates and stores 10 fresh recovery codes, returning them for one-time display. */
export async function regenerateRecoveryCodes(c: Context<AppEnv>, userId: string) {
  const services = c.get('services');
  const codes = generateRecoveryCodes();
  const hashes = await Promise.all(codes.map((code) => recoveryCodeHash(services.pepper, code)));
  await replaceRecoveryCodes(c.env.DB, userId, hashes, services.now());
  return codes;
}

/**
 * Verifies one OTP attempt against a challenge (see module docs for the rules).
 * On success with an enrollment method the user's 2FA is saved and fresh
 * recovery codes are returned.
 */
export async function verifyChallenge(
  c: Context<AppEnv>,
  user: UserRow,
  challenge: ChallengeRow,
  method: VerifyMethod,
  code: string,
): Promise<VerifyOutcome> {
  const services = c.get('services');
  const now = services.now();
  if (!allowedMethods(user, challenge).includes(method)) {
    throw new HttpError(400, 'method_not_allowed');
  }
  if (challenge.status !== 'pending' || challenge.expiresAt <= now) return { status: 'expired' };

  const attempt = await reserveAttempt(c.env.DB, challenge.id, AUTH_POLICY.maxOtpAttempts, now);
  if (attempt === null) return { status: 'expired' };

  const correct = code.length <= 64 ? await checkCode(c, user, challenge, method, code) : null;
  if (correct !== null) {
    if (!(await completeChallenge(c.env.DB, challenge.id))) return { status: 'expired' };
    let recoveryCodes: string[] | null = null;
    if (method === 'enroll_totp' || method === 'enroll_email') {
      const totpSecretEnc = method === 'enroll_totp' ? challenge.pendingTotpSecretEnc : null;
      await enrollMfa(
        c.env.DB,
        user.id,
        {
          method: method === 'enroll_totp' ? 'totp' : 'email',
          totpSecretEnc,
          // The confirming code's step is consumed: it cannot be replayed at login.
          totpStep: correct.totpStep,
        },
        now,
      );
      recoveryCodes = await regenerateRecoveryCodes(c, user.id);
      await audit(c, 'auth.mfa_enrolled', {
        actorUserId: user.id,
        tenantId: null,
        details: { method: method === 'enroll_totp' ? 'totp' : 'email' },
      });
      if (challenge.purpose === 'enroll') {
        await defer(
          c,
          sendSystemEmail(services, user.email, user.locale, 'mfa_changed', {
            method: method === 'enroll_totp' ? 'TOTP' : 'email',
          }),
        );
      }
    }
    return { status: 'ok', method, recoveryCodes };
  }

  if (attempt < AUTH_POLICY.maxOtpAttempts) {
    return { status: 'wrong', attemptsLeft: AUTH_POLICY.maxOtpAttempts - attempt };
  }

  // Third failure: cancel the challenge (only the request that actually cancels
  // it counts the failure, so parallel losers do not double-count).
  if (!(await cancelChallenge(c.env.DB, challenge.id))) {
    return { status: 'cancelled', locked: false, lockedUntil: null };
  }
  const lock = await registerFailedChallenge(c.env.DB, user.id, {
    threshold: AUTH_POLICY.lockoutThreshold,
    baseMs: AUTH_POLICY.lockoutBaseMs,
    maxExponent: AUTH_POLICY.lockoutMaxExponent,
    now,
  });
  const locale = resolveLocale(user.locale);
  const time = `${formatDateTime(locale, now, 'UTC')} UTC`;
  await audit(c, 'auth.challenge_cancelled', {
    actorUserId: user.id,
    tenantId: null,
    details: { purpose: challenge.purpose, locked: lock.locked },
  });
  await defer(
    c,
    sendSystemEmail(services, user.email, locale, 'otp_failed', {
      device: describeUserAgent(c.req.header('user-agent') ?? null),
      time,
    }),
  );
  if (lock.locked && lock.lockedUntil !== null) {
    await audit(c, 'auth.account_locked', { actorUserId: user.id, tenantId: null });
    await defer(
      c,
      sendSystemEmail(services, user.email, locale, 'account_locked', {
        until: `${formatDateTime(locale, lock.lockedUntil, 'UTC')} UTC`,
      }),
    );
  }
  return { status: 'cancelled', locked: lock.locked, lockedUntil: lock.lockedUntil };
}
