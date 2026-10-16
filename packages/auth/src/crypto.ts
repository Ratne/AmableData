import { fromBase64, fromBase64Url, toBase64Url, toHex, utf8 } from './encoding';

/** Cryptographically secure random bytes. */
export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

/** Opaque URL-safe token; 32 bytes = 256 bits of entropy by default. */
export function randomToken(bytes = 32): string {
  return toBase64Url(randomBytes(bytes));
}

export async function sha256Hex(value: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const data = typeof value === 'string' ? utf8(value) : value;
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)));
}

async function hmacKey(secret: string | Uint8Array<ArrayBuffer>, hash: 'SHA-1' | 'SHA-256') {
  const raw = typeof secret === 'string' ? utf8(secret) : secret;
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash }, false, ['sign']);
}

export async function hmacSha256(
  secret: string | Uint8Array<ArrayBuffer>,
  message: string | Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await hmacKey(secret, 'SHA-256');
  const data = typeof message === 'string' ? utf8(message) : message;
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

export async function hmacSha256Hex(
  secret: string | Uint8Array<ArrayBuffer>,
  message: string | Uint8Array<ArrayBuffer>,
): Promise<string> {
  return toHex(await hmacSha256(secret, message));
}

export async function hmacSha1(
  secret: Uint8Array<ArrayBuffer>,
  message: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await hmacKey(secret, 'SHA-1');
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
}

/**
 * Constant-time comparison of two strings (or byte arrays). Length differences
 * return false without early exit on content.
 */
export function timingSafeEqual(a: string | Uint8Array, b: string | Uint8Array): boolean {
  const left = typeof a === 'string' ? utf8(a) : a;
  const right = typeof b === 'string' ? utf8(b) : b;
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Secret encryption (AES-256-GCM) for data at rest: TOTP secrets, OAuth tokens,
// provider credentials. Ciphertext format: "v1.<iv b64url>.<ciphertext b64url>".
// The version prefix allows key rotation without a data migration.
// ---------------------------------------------------------------------------

export interface SecretBox {
  encrypt(plaintext: string, associatedData?: string): Promise<string>;
  decrypt(ciphertext: string, associatedData?: string): Promise<string>;
}

export class SecretBoxError extends Error {
  override readonly name = 'SecretBoxError';
}

function aesParams(iv: Uint8Array<ArrayBuffer>, associatedData: string | undefined) {
  return associatedData === undefined
    ? { name: 'AES-GCM', iv }
    : { name: 'AES-GCM', iv, additionalData: utf8(associatedData) };
}

/**
 * Builds a SecretBox from a base64-encoded 32-byte key (Wrangler secret).
 * `associatedData` binds a ciphertext to its owner (e.g. the user id), so a
 * value copied to another row fails to decrypt.
 */
export async function createSecretBox(base64Key: string): Promise<SecretBox> {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = fromBase64(base64Key);
  } catch {
    throw new SecretBoxError('encryption key is not valid base64');
  }
  if (raw.length !== 32) {
    throw new SecretBoxError('encryption key must be 32 bytes (base64-encoded)');
  }
  const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);

  return {
    async encrypt(plaintext, associatedData) {
      const iv = randomBytes(12);
      const params = aesParams(iv, associatedData);
      const ct = new Uint8Array(await crypto.subtle.encrypt(params, key, utf8(plaintext)));
      return `v1.${toBase64Url(iv)}.${toBase64Url(ct)}`;
    },
    async decrypt(ciphertext, associatedData) {
      const [version, ivPart, ctPart] = ciphertext.split('.');
      if (version !== 'v1' || ivPart === undefined || ctPart === undefined) {
        throw new SecretBoxError('unsupported ciphertext format');
      }
      const params = aesParams(fromBase64Url(ivPart), associatedData);
      try {
        const pt = await crypto.subtle.decrypt(params, key, fromBase64Url(ctPart));
        return new TextDecoder().decode(pt);
      } catch {
        throw new SecretBoxError('decryption failed');
      }
    },
  };
}
