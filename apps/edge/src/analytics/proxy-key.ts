/**
 * Per-site key of the reverse-proxy recipes. The forwarded visitor IP, host and
 * location headers are trusted only with it: anyone else could claim any IP
 * (fake verified crawlers, someone else's cookieless id). Derived from the
 * gateway secret shared by core and edge, so nothing is stored; without that
 * secret the forwarded headers are always ignored.
 */

export const PROXY_KEY_HEADER = 'x-amb-proxy-key';
export const PROXY_IP_HEADER = 'x-amb-forwarded-for';
export const PROXY_HOST_HEADER = 'x-amb-forwarded-host';
export const PROXY_COUNTRY_HEADER = 'x-amb-geo-country';
export const PROXY_REGION_HEADER = 'x-amb-geo-region';
export const PROXY_CITY_HEADER = 'x-amb-geo-city';

export async function proxyKeyFor(
  secret: string | undefined,
  siteId: string,
): Promise<string | null> {
  if (secret === undefined || secret === '') return null;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`tracking-proxy:${siteId}`)),
  );
  return btoa(String.fromCharCode(...mac.slice(0, 24)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Constant-time comparison of the presented key. */
export async function proxyKeyValid(
  secret: string | undefined,
  siteId: string,
  presented: string | undefined,
): Promise<boolean> {
  const expected = await proxyKeyFor(secret, siteId);
  if (expected === null || presented === undefined || presented.length !== expected.length)
    return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++)
    diff |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
  return diff === 0;
}
