/**
 * Public share links of a site dashboard: `<base64url(JSON {v, s, i})>.<base64url(HMAC-SHA256)[0..16 bytes]>`
 * where `s` is the site id and `i` the share id. The signature makes tokens
 * unforgeable; revocation lives in the site DO (`shares.revoked_at`), checked on
 * every request, so a revoked link stops working immediately.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAC_BYTES = 16;

export interface ShareTokenPayload {
  v: 1;
  /** Site id. */
  s: string;
  /** Share id. */
  i: string;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

async function mac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(`analytics-share:${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(data))).slice(0, MAC_BYTES);
}

export async function signShareToken(secret: string, siteId: string, shareId: string): Promise<string> {
  const body = toBase64Url(encoder.encode(JSON.stringify({ v: 1, s: siteId, i: shareId } satisfies ShareTokenPayload)));
  return `${body}.${toBase64Url(await mac(secret, body))}`;
}

/** Payload of a well-signed token (revocation is checked separately), else null. */
export async function verifyShareToken(secret: string, token: string): Promise<ShareTokenPayload | null> {
  if (token.length > 512) return null;
  const [body, sig, extra] = token.split('.');
  if (body === undefined || sig === undefined || extra !== undefined) return null;
  const given = fromBase64Url(sig);
  if (given === null || given.length !== MAC_BYTES) return null;
  const expected = await mac(secret, body);
  let diff = 0;
  for (let i = 0; i < MAC_BYTES; i += 1) diff |= (expected[i] ?? 0) ^ (given[i] ?? 0);
  if (diff !== 0) return null;
  const raw = fromBase64Url(body);
  if (raw === null) return null;
  try {
    const p = JSON.parse(decoder.decode(raw)) as Partial<ShareTokenPayload>;
    if (p.v !== 1 || typeof p.s !== 'string' || typeof p.i !== 'string') return null;
    return { v: 1, s: p.s, i: p.i };
  } catch {
    return null;
  }
}
