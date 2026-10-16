/**
 * Signed tokens carried by marketing emails: click redirects, the open pixel,
 * the unsubscribe page and the contact identity param appended to clicked
 * links (`_amb_c`, consumed by web analytics to link a visitor to a contact).
 *
 * Format: `<base64url(JSON payload)>.<base64url(HMAC-SHA256(secret, payload))[0..16 bytes]>`.
 * Tokens never expire (an unsubscribe link must keep working) but they are
 * bound to a tenant, a message and a contact; the click token also carries the
 * destination URL, so the redirect can never become an open redirect.
 * Verification accepts several secrets to allow rotation.
 */

export type EmailTokenKind = 'click' | 'open' | 'unsubscribe' | 'contact';

export interface ClickTokenPayload {
  readonly k: 'click';
  /** Tenant id. */
  readonly t: string;
  /** Mail message id. */
  readonly m: string;
  /** Contact id. */
  readonly c: string;
  /** Link position in the HTML body (0-based). */
  readonly l: number;
  /** Destination URL (http/https only). */
  readonly u: string;
}

export interface OpenTokenPayload {
  readonly k: 'open';
  readonly t: string;
  readonly m: string;
  readonly c: string;
}

export interface UnsubscribeTokenPayload {
  readonly k: 'unsubscribe';
  readonly t: string;
  /** Message the link came from (null for links built outside a send). */
  readonly m: string | null;
  readonly c: string;
  /** Normalized recipient address. */
  readonly e: string;
}

export interface ContactTokenPayload {
  readonly k: 'contact';
  readonly t: string;
  readonly c: string;
  /** Issued at, unix seconds. Consumers may enforce a maximum age. */
  readonly i: number;
}

export type EmailTokenPayload =
  | ClickTokenPayload
  | OpenTokenPayload
  | UnsubscribeTokenPayload
  | ContactTokenPayload;

type PayloadOf<K extends EmailTokenKind> = Extract<EmailTokenPayload, { k: K }>;

/** Query parameter appended to clicked links (signed contact identity). */
export const CONTACT_TOKEN_PARAM = '_amb_c';

const MAC_BYTES = 16;
const MAX_TOKEN_LENGTH = 4096;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret);
  if (key === undefined) {
    key = crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    keyCache.set(secret, key);
  }
  return key;
}

async function mac(secret: string, data: string): Promise<Uint8Array> {
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(data));
  return new Uint8Array(signature).slice(0, MAC_BYTES);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export async function signEmailToken(secret: string, payload: EmailTokenPayload): Promise<string> {
  if (secret === '') throw new Error('email token secret is empty');
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  return `${body}.${toBase64Url(await mac(secret, body))}`;
}

const isString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 2048;

function isHttpUrl(value: unknown): value is string {
  if (!isString(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function parsePayload(value: unknown): EmailTokenPayload | null {
  if (typeof value !== 'object' || value === null) return null;
  const p = value as Record<string, unknown>;
  switch (p['k']) {
    case 'click':
      return isString(p['t']) &&
        isString(p['m']) &&
        isString(p['c']) &&
        typeof p['l'] === 'number' &&
        Number.isInteger(p['l']) &&
        p['l'] >= 0 &&
        isHttpUrl(p['u'])
        ? { k: 'click', t: p['t'], m: p['m'], c: p['c'], l: p['l'], u: p['u'] }
        : null;
    case 'open':
      return isString(p['t']) && isString(p['m']) && isString(p['c'])
        ? { k: 'open', t: p['t'], m: p['m'], c: p['c'] }
        : null;
    case 'unsubscribe':
      return isString(p['t']) &&
        (p['m'] === null || isString(p['m'])) &&
        isString(p['c']) &&
        isString(p['e'])
        ? { k: 'unsubscribe', t: p['t'], m: p['m'], c: p['c'], e: p['e'] }
        : null;
    case 'contact':
      return isString(p['t']) && isString(p['c']) && typeof p['i'] === 'number'
        ? { k: 'contact', t: p['t'], c: p['c'], i: p['i'] }
        : null;
    default:
      return null;
  }
}

/** Verifies a token of the expected kind; null when malformed, forged or of another kind. */
export async function verifyEmailToken<K extends EmailTokenKind>(
  secrets: readonly string[],
  token: string,
  kind: K,
): Promise<PayloadOf<K> | null> {
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
  const body = token.slice(0, dot);
  const signature = fromBase64Url(token.slice(dot + 1));
  if (signature === null || signature.length !== MAC_BYTES) return null;
  let valid = false;
  for (const secret of secrets) {
    if (secret !== '' && constantTimeEqual(await mac(secret, body), signature)) valid = true;
  }
  if (!valid) return null;
  const raw = fromBase64Url(body);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(raw));
  } catch {
    return null;
  }
  const payload = parsePayload(parsed);
  if (payload === null || payload.k !== kind) return null;
  return payload as PayloadOf<K>;
}

/** Signed contact identity appended to clicked links as `_amb_c`. */
export function signContactToken(
  secret: string,
  tenantId: string,
  contactId: string,
  nowMs: number = Date.now(),
): Promise<string> {
  return signEmailToken(secret, { k: 'contact', t: tenantId, c: contactId, i: Math.floor(nowMs / 1000) });
}

/** Verifies an `_amb_c` value; `maxAgeSeconds` rejects old links (default 90 days). */
export async function verifyContactToken(
  secrets: readonly string[],
  token: string,
  options: { nowMs?: number; maxAgeSeconds?: number } = {},
): Promise<ContactTokenPayload | null> {
  const payload = await verifyEmailToken(secrets, token, 'contact');
  if (payload === null) return null;
  const age = Math.floor((options.nowMs ?? Date.now()) / 1000) - payload.i;
  if (age < -300 || age > (options.maxAgeSeconds ?? 90 * 24 * 3600)) return null;
  return payload;
}
