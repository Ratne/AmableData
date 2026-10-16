/**
 * Security policy constants — the single place where the product's auth rules
 * (plan section "Accesso, sicurezza e account") become numbers.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const AUTH_POLICY = {
  /** Second-factor challenge lifetime after a valid first factor. */
  challengeTtlMs: 5 * MINUTE,
  /** OTP attempts per challenge; the last failure cancels the challenge. */
  maxOtpAttempts: 3,
  /** Consecutive cancelled challenges that lock the account. */
  lockoutThreshold: 3,
  /** First lock duration; doubles at every subsequent lock. */
  lockoutBaseMs: 15 * MINUTE,
  /** Upper bound of the doubling (2^10 × 15 min ≈ 10 days). */
  lockoutMaxExponent: 10,

  emailCodeTtlMs: 10 * MINUTE,
  emailCodeMaxPerMinute: 1,
  emailCodeMaxPerHour: 5,

  magicLinkTtlMs: 15 * MINUTE,
  passwordResetTtlMs: HOUR,
  emailChangeTtlMs: HOUR,
  inviteTtlMs: 7 * DAY,

  sessionIdleMs: 7 * DAY,
  sessionAbsoluteMs: 30 * DAY,
  /** last_seen_at is refreshed at most this often (limits D1 writes). */
  sessionTouchIntervalMs: MINUTE,
  /** How long a step-up (re-entered OTP) authorizes sensitive actions. */
  stepUpMaxAgeMs: 5 * MINUTE,

  /** Failed password logins (per account or IP, 15 min) before Turnstile is required. */
  turnstileAfterFailedLogins: 3,
} as const;

/** Lock duration for the n-th lock (0-based), doubling each time. */
export function lockDurationMs(previousLocks: number): number {
  const exponent = Math.min(Math.max(previousLocks, 0), AUTH_POLICY.lockoutMaxExponent);
  return AUTH_POLICY.lockoutBaseMs * 2 ** exponent;
}

export const COOKIE_NAMES = {
  /** Opaque session token (HttpOnly, Secure, SameSite=Lax, host-only). */
  session: '__Host-sid',
  /** Pending second-factor challenge, binds the challenge to this device. */
  challenge: '__Host-amb_chal',
  /** Non-sensitive UI preferences ("<locale>.<theme>") for flash-free first paint. */
  prefs: 'amb_prefs',
} as const;

/** Header every state-changing cookie-authenticated request must carry. */
export const CSRF_HEADER = 'x-amable-csrf';
