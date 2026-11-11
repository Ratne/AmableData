import { randomHex, sha256Hex } from '@amable/auth';
/**
 * Cookieless visitor ids: SHA-256 of (daily salt, site, IP, user agent).
 *
 * The salt is random per site and per UTC day, stored only in the site's
 * AnalyticsDO and deleted after two days, so a hash can never be linked to the
 * same visitor on another day — nor recomputed from the IP later.
 */

export const SALT_RETENTION_DAYS = 2;

/** UTC day key (YYYY-MM-DD) used for salt rotation. */
export function saltDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function randomSalt(): string {
  return randomHex(32);
}

/** Visitor id of a cookieless hit: `h` + 32 hex chars (fits the tracker id format). */
export async function cookielessVisitorId(
  salt: string,
  siteId: string,
  ip: string,
  userAgent: string,
): Promise<string> {
  const digest = await sha256Hex(`${salt}\n${siteId}\n${ip}\n${userAgent}`);
  return `h${digest.slice(0, 32)}`;
}

/**
 * Same-day fingerprint of a cookie visitor (IP + user agent) for the optional
 * `ip_ua` merge: salted like the cookieless ids, so it dies with the salt.
 */
export async function ipUaHash(
  salt: string,
  siteId: string,
  ip: string,
  userAgent: string,
): Promise<string> {
  return (await sha256Hex(`ip_ua\n${salt}\n${siteId}\n${ip}\n${userAgent}`)).slice(0, 32);
}
