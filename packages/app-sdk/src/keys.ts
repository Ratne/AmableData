import { base64url, fromBase64url, jsonBase64url, parseJsonBase64url, utf8 } from './encoding';

/**
 * App signing keys (Ed25519). The private JWK stays with the app (a Worker
 * secret); the public JWKS is served at the manifest's `jwks_url`. Rotation:
 * publish the new key next to the old one, switch signing to it, drop the old
 * one a day later (`amable-app keys rotate` does the bookkeeping).
 */

export interface PublicJwk {
  readonly kty: 'OKP';
  readonly crv: 'Ed25519';
  readonly x: string;
  readonly kid: string;
  readonly alg: 'EdDSA';
  readonly use: 'sig';
}

export interface PrivateJwk extends PublicJwk {
  readonly d: string;
}

export interface Jwks {
  readonly keys: PublicJwk[];
}

export async function generateAppKey(kid = `k-${new Date().toISOString().slice(0, 10)}`): Promise<PrivateJwk> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  if (typeof jwk.x !== 'string' || typeof jwk.d !== 'string') throw new Error('Ed25519 export failed');
  return { kty: 'OKP', crv: 'Ed25519', x: jwk.x, d: jwk.d, kid, alg: 'EdDSA', use: 'sig' };
}

export function publicJwk(key: PrivateJwk | PublicJwk): PublicJwk {
  return { kty: 'OKP', crv: 'Ed25519', x: key.x, kid: key.kid, alg: 'EdDSA', use: 'sig' };
}

/** JWKS document for `jwks_url` (public parts only, whatever is passed in). */
export function jwksOf(keys: ReadonlyArray<PrivateJwk | PublicJwk>): Jwks {
  return { keys: keys.map(publicJwk) };
}

/** Accepts a JWK object or its JSON (e.g. a Worker secret). */
export function parsePrivateJwk(value: string | PrivateJwk): PrivateJwk {
  const jwk = typeof value === 'string' ? (JSON.parse(value) as PrivateJwk) : value;
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.d !== 'string' || typeof jwk.kid !== 'string') {
    throw new Error('expected an Ed25519 private JWK with kid');
  }
  return jwk;
}

async function importPrivate(jwk: PrivateJwk): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: jwk.x, d: jwk.d }, { name: 'Ed25519' }, false, ['sign']);
}

async function importPublic(jwk: { x?: string }): Promise<CryptoKey> {
  if (typeof jwk.x !== 'string') throw new Error('bad public key');
  return crypto.subtle.importKey('raw', fromBase64url(jwk.x), { name: 'Ed25519' }, false, ['verify']);
}

export async function signJwt(claims: Record<string, unknown>, key: PrivateJwk): Promise<string> {
  const input = `${jsonBase64url({ alg: 'EdDSA', typ: 'JWT', kid: key.kid })}.${jsonBase64url(claims)}`;
  const signature = await crypto.subtle.sign({ name: 'Ed25519' }, await importPrivate(key), utf8(input));
  return `${input}.${base64url(new Uint8Array(signature))}`;
}

export interface DecodedJwt {
  readonly header: { alg?: unknown; kid?: unknown };
  readonly claims: Record<string, unknown>;
}

export function decodeJwt(token: string): DecodedJwt | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = parseJsonBase64url(parts[0]!) as DecodedJwt['header'];
    const claims = parseJsonBase64url(parts[1]!) as Record<string, unknown>;
    if (typeof header !== 'object' || header === null || typeof claims !== 'object' || claims === null) return null;
    return { header, claims };
  } catch {
    return null;
  }
}

/** Verifies an EdDSA JWT against a JWKS (by `kid`, else every Ed25519 key). */
export async function verifyJwtSignature(token: string, jwks: { keys: ReadonlyArray<{ kty?: string; crv?: string; x?: string; kid?: string }> }): Promise<boolean> {
  const decoded = decodeJwt(token);
  if (decoded === null || decoded.header.alg !== 'EdDSA') return false;
  const [header, payload, signature] = token.split('.') as [string, string, string];
  const candidates = jwks.keys.filter(
    (k) => k.kty === 'OKP' && k.crv === 'Ed25519' && (decoded.header.kid === undefined || k.kid === decoded.header.kid),
  );
  for (const jwk of candidates) {
    try {
      const ok = await crypto.subtle.verify({ name: 'Ed25519' }, await importPublic(jwk), fromBase64url(signature), utf8(`${header}.${payload}`));
      if (ok) return true;
    } catch {
      // Try the next key.
    }
  }
  return false;
}
