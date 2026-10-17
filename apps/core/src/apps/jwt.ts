import { fromBase64Url, fromUtf8, toBase64Url, utf8 } from '@amable/auth';

/**
 * Minimal JWS compact (JWT) for the apps module: the installation signs
 * session tokens with EdDSA; apps sign client assertions with EdDSA, ES256 or
 * RS256 (keys from their published JWKS).
 */

export type JwtAlg = 'EdDSA' | 'ES256' | 'RS256';
export const JWT_ALGS: readonly JwtAlg[] = ['EdDSA', 'ES256', 'RS256'];

export interface JwtHeader {
  readonly alg: string;
  readonly kid?: string;
  readonly typ?: string;
}

export type JwtClaims = Record<string, unknown>;

export interface PublicJwk {
  readonly kty: string;
  readonly kid?: string;
  readonly alg?: string;
  readonly use?: string;
  readonly crv?: string;
  readonly x?: string;
  readonly y?: string;
  readonly n?: string;
  readonly e?: string;
}

const encodeJson = (value: unknown) => toBase64Url(utf8(JSON.stringify(value)));

export async function signJwt(claims: JwtClaims, key: CryptoKey, kid: string): Promise<string> {
  const head = encodeJson({ alg: 'EdDSA', kid, typ: 'JWT' });
  const body = encodeJson(claims);
  const signature = await crypto.subtle.sign('Ed25519', key, utf8(`${head}.${body}`));
  return `${head}.${body}.${toBase64Url(new Uint8Array(signature))}`;
}

export interface DecodedJwt {
  readonly header: JwtHeader;
  readonly claims: JwtClaims;
  readonly signingInput: string;
  readonly signature: Uint8Array<ArrayBuffer>;
}

export function decodeJwt(token: string): DecodedJwt | null {
  const parts = token.split('.');
  if (parts.length !== 3 || token.length > 16_384) return null;
  const [head, body, sig] = parts as [string, string, string];
  try {
    const header = JSON.parse(fromUtf8(fromBase64Url(head))) as unknown;
    const claims = JSON.parse(fromUtf8(fromBase64Url(body))) as unknown;
    if (typeof header !== 'object' || header === null || typeof claims !== 'object' || claims === null) return null;
    if (typeof (header as JwtHeader).alg !== 'string') return null;
    return {
      header: header as JwtHeader,
      claims: claims as JwtClaims,
      signingInput: `${head}.${body}`,
      signature: fromBase64Url(sig),
    };
  } catch {
    return null;
  }
}

type Algo = { name: string; namedCurve?: string; hash?: string };

function importParams(alg: JwtAlg): { importAlg: Algo; verifyAlg: Algo } {
  if (alg === 'EdDSA') return { importAlg: { name: 'Ed25519' }, verifyAlg: { name: 'Ed25519' } };
  if (alg === 'ES256') {
    return { importAlg: { name: 'ECDSA', namedCurve: 'P-256' }, verifyAlg: { name: 'ECDSA', hash: 'SHA-256' } };
  }
  return { importAlg: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, verifyAlg: { name: 'RSASSA-PKCS1-v1_5' } };
}

function jwkMatchesAlg(jwk: PublicJwk, alg: JwtAlg): boolean {
  if (jwk.alg !== undefined && jwk.alg !== alg) return false;
  if (alg === 'EdDSA') return jwk.kty === 'OKP' && jwk.crv === 'Ed25519';
  if (alg === 'ES256') return jwk.kty === 'EC' && jwk.crv === 'P-256';
  return jwk.kty === 'RSA';
}

/** Verifies the signature against the JWKS key named by `kid` (or the only compatible key). */
export async function verifyJwtSignature(decoded: DecodedJwt, keys: readonly PublicJwk[]): Promise<boolean> {
  const alg = decoded.header.alg as JwtAlg;
  if (!JWT_ALGS.includes(alg)) return false;
  const compatible = keys.filter((k) => jwkMatchesAlg(k, alg) && (k.use === undefined || k.use === 'sig'));
  const candidates =
    decoded.header.kid === undefined
      ? compatible.length === 1
        ? compatible
        : []
      : compatible.filter((k) => k.kid === decoded.header.kid);
  const { importAlg, verifyAlg } = importParams(alg);
  for (const jwk of candidates) {
    try {
      const { kid: _kid, alg: _alg, use: _use, ...material } = jwk;
      const key = await crypto.subtle.importKey('jwk', material as JsonWebKey, importAlg, false, ['verify']);
      if (await crypto.subtle.verify(verifyAlg, key, decoded.signature, utf8(decoded.signingInput))) return true;
    } catch {
      // Malformed key: try the next one.
    }
  }
  return false;
}
