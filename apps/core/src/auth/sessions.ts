import {
  AUTH_POLICY,
  COOKIE_NAMES,
  describeUserAgent,
  newSessionTimes,
  randomToken,
  sha256Hex,
} from '@amable/auth';
import { formatDateTime, resolveLocale } from '@amable/i18n';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { ulid } from 'ulid';
import type { AppEnv } from '../middleware/context';
import { clientCountry, clientIp, defer } from '../middleware/request';
import { sendSystemEmail } from './emails';
import {
  clearFailedChallenges,
  countKnownDevices,
  insertSession,
  rememberDevice,
  rotateSessionHash,
  type UserRow,
} from './store';

const SESSION_COOKIE_MAX_AGE = Math.floor(AUTH_POLICY.sessionAbsoluteMs / 1000);
const CHALLENGE_COOKIE_MAX_AGE = Math.floor(AUTH_POLICY.challengeTtlMs / 1000);

function setHostCookie(c: Context, name: string, value: string, maxAge: number) {
  setCookie(c, name, value, {
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
    maxAge,
  });
}

export function readSessionToken(c: Context): string | undefined {
  return getCookie(c, COOKIE_NAMES.session);
}

export function readChallengeToken(c: Context): string | undefined {
  return getCookie(c, COOKIE_NAMES.challenge);
}

export function setChallengeCookie(c: Context, token: string) {
  setHostCookie(c, COOKIE_NAMES.challenge, token, CHALLENGE_COOKIE_MAX_AGE);
}

export function clearChallengeCookie(c: Context) {
  deleteCookie(c, COOKIE_NAMES.challenge, { path: '/', secure: true });
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, COOKIE_NAMES.session, { path: '/', secure: true });
}

/** Non-sensitive preferences cookie read by the HTML shell before first paint. */
export function setPrefsCookie(c: Context, locale: string, theme: string) {
  setCookie(c, COOKIE_NAMES.prefs, `${locale}.${theme}`, {
    path: '/',
    secure: true,
    httpOnly: false,
    sameSite: 'Lax',
    maxAge: 365 * 24 * 3600,
  });
}

/**
 * Creates a brand-new session after a completed second factor: fresh token
 * (never reused across logins), only its hash stored, device remembered, and a
 * "new device or country" email when this device was never seen before.
 */
export async function issueSession(
  c: Context<AppEnv>,
  user: UserRow,
  mfaMethod: string,
): Promise<{ publicId: string }> {
  const services = c.get('services');
  const now = services.now();
  const token = randomToken(32);
  const hash = await sha256Hex(token);
  const publicId = ulid(now);
  const userAgent = c.req.header('user-agent')?.slice(0, 512) ?? null;
  const country = clientCountry(c);
  const deviceLabel = describeUserAgent(userAgent);

  await insertSession(c.env.DB, {
    id: hash,
    publicId,
    userId: user.id,
    ...newSessionTimes(now),
    userAgent,
    deviceLabel,
    ip: clientIp(c),
    country,
    mfaMethod,
    stepUpAt: null,
  });
  await clearFailedChallenges(c.env.DB, user.id);

  setHostCookie(c, COOKIE_NAMES.session, token, SESSION_COOKIE_MAX_AGE);
  clearChallengeCookie(c);
  setPrefsCookie(c, user.locale, user.theme);

  const deviceKey = await sha256Hex(`${deviceLabel}|${country ?? ''}`);
  const isNewDevice = await rememberDevice(c.env.DB, user.id, deviceKey, now);
  if (isNewDevice && (await countKnownDevices(c.env.DB, user.id)) > 1) {
    const locale = resolveLocale(user.locale);
    await defer(
      c,
      sendSystemEmail(services, user.email, locale, 'new_device', {
        device: deviceLabel,
        location: country ?? (locale === 'it' ? 'posizione sconosciuta' : 'unknown location'),
        time: `${formatDateTime(locale, now, 'UTC')} UTC`,
      }),
    );
  }
  return { publicId };
}

/**
 * Rotates the token of the current session (privilege change: step-up,
 * password change). The old token stops working immediately.
 */
export async function rotateSession(c: Context<AppEnv>, oldHash: string): Promise<string | null> {
  const token = randomToken(32);
  const hash = await sha256Hex(token);
  if (!(await rotateSessionHash(c.env.DB, oldHash, hash))) return null;
  setHostCookie(c, COOKIE_NAMES.session, token, SESSION_COOKIE_MAX_AGE);
  return hash;
}
