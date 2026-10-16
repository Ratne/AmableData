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
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
  );
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
