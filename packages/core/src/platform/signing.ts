/**
 * Signatures shared by the installation and the control plane (WebCrypto only).
 *
 * - License keys: `amb_lic_<installationId>_<secret>`; the control plane stores only
 *   the SHA-256 of the whole key.
 * - Control plane → installation requests: Ed25519 over
 *   `${t}.${METHOD}.${path}.${sha256hex(body)}` in `Amable-CP-Signature: t=<unix>,sig=<b64url>`.
 * - Assisted access tokens: `amb_assist.<b64url(payload json)>.<b64url(ed25519 sig)>`,
 *   short-lived; the installation accepts them only with a local active grant.
 *
 * The control plane holds the private key (`CP_SIGNING_KEY`, PKCS#8 base64); every
 * installation gets the public key (`CONTROL_PLANE_PUBLIC_KEY`, raw 32 bytes base64)
 * from the installer.
 */

/**
 * Public half of the PUBLIC dev key pair of a local control plane. Honored only
 * with ENVIRONMENT=dev; real installations get the production key from the installer.
 */
export const DEV_CONTROL_PLANE_PUBLIC_KEY = 'EE3tn+MFUGulUF8LAQxMgRH2+ioQpi5v5+eiO64sLHE=';

export const CP_SIGNATURE_HEADER = 'amable-cp-signature';
export const CP_SIGNATURE_TOLERANCE_SECONDS = 300;
export const ASSIST_TOKEN_PREFIX = 'amb_assist';
/** Hard ceiling of one assisted-access token, whatever the issuer asks. */
export const ASSIST_TOKEN_MAX_TTL_SECONDS = 4 * 3600;

const LICENSE_RE = /^amb_lic_([0-9A-HJKMNP-TV-Z]{26})_([A-Za-z0-9_-]{32,64})$/;

export interface ParsedLicenseKey {
  readonly installationId: string;
  readonly key: string;
}

export function parseLicenseKey(key: string): ParsedLicenseKey | null {
  const match = LICENSE_RE.exec(key.trim());
  if (match === null || match[1] === undefined) return null;
  return { installationId: match[1], key: key.trim() };
}

export function formatLicenseKey(installationId: string, secret: string): string {
  return `amb_lic_${installationId}_${secret}`;
}

// ------------------------------------------------------------ encoding

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toB64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function fromB64(value: string): Uint8Array<ArrayBuffer> {
  return fromB64Url(value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
}

async function sha256HexOf(data: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(data)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------- keys

export function importSigningKey(pkcs8Base64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', fromB64(pkcs8Base64), { name: 'Ed25519' }, false, ['sign']);
}

export function importVerifyKey(rawBase64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', fromB64(rawBase64), { name: 'Ed25519' }, false, ['verify']);
}

/** New Ed25519 key pair as (PKCS#8 base64, raw public base64) — used by tooling and tests. */
export async function generateSigningKeyPair(): Promise<{ privateKey: string; publicKey: string }> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  const raw = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  const b64 = (bytes: Uint8Array): string => toB64Url(bytes).replace(/-/g, '+').replace(/_/g, '/');
  const pad = (s: string): string => s + '='.repeat((4 - (s.length % 4)) % 4);
  return { privateKey: pad(b64(pkcs8)), publicKey: pad(b64(raw)) };
}

async function sign(key: CryptoKey, data: string): Promise<string> {
  return toB64Url(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, encoder.encode(data))));
}

async function verify(key: CryptoKey, data: string, signature: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, fromB64Url(signature), encoder.encode(data));
  } catch {
    return false;
  }
}

// ------------------------------------------- control plane → installation

async function requestBase(t: number, method: string, path: string, body: string): Promise<string> {
  return `${String(t)}.${method.toUpperCase()}.${path}.${await sha256HexOf(body)}`;
}

/** Header value for a control plane → installation request. `path` excludes the origin and query. */
export async function signPlatformRequest(
  key: CryptoKey,
  input: { method: string; path: string; body: string; nowMs: number },
): Promise<string> {
  const t = Math.floor(input.nowMs / 1000);
  return `t=${String(t)},sig=${await sign(key, await requestBase(t, input.method, input.path, input.body))}`;
}

export type PlatformSignatureCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'missing' | 'malformed' | 'expired' | 'invalid' };

export async function verifyPlatformRequest(
  key: CryptoKey,
  header: string | null | undefined,
  input: { method: string; path: string; body: string; nowMs: number },
): Promise<PlatformSignatureCheck> {
  if (header === null || header === undefined || header === '') return { ok: false, reason: 'missing' };
  const match = /^t=(\d{1,12}),sig=([A-Za-z0-9_-]{40,200})$/.exec(header.trim());
  if (match === null || match[1] === undefined || match[2] === undefined) return { ok: false, reason: 'malformed' };
  const t = Number(match[1]);
  if (Math.abs(input.nowMs / 1000 - t) > CP_SIGNATURE_TOLERANCE_SECONDS) return { ok: false, reason: 'expired' };
  const valid = await verify(key, await requestBase(t, input.method, input.path, input.body), match[2]);
  return valid ? { ok: true } : { ok: false, reason: 'invalid' };
}

// ----------------------------------------------------- assisted access

export interface AssistTokenPayload {
  readonly v: 1;
  readonly typ: 'assist';
  /** Installation id the token is valid for. */
  readonly iid: string;
  /** Grant id (created by the installation, mirrored to the control plane). */
  readonly gid: string;
  /** Tenant id of the grant. */
  readonly tid: string;
  /** Staff account id and display name (shown in banners and audit). */
  readonly sid: string;
  readonly sname: string;
  /** Unix seconds. */
  readonly iat: number;
  readonly exp: number;
  /** Unique token id: single use on the installation. */
  readonly jti: string;
}

export async function signAssistToken(key: CryptoKey, payload: AssistTokenPayload): Promise<string> {
  const body = toB64Url(encoder.encode(JSON.stringify(payload)));
  return `${ASSIST_TOKEN_PREFIX}.${body}.${await sign(key, `${ASSIST_TOKEN_PREFIX}.${body}`)}`;
}

export type AssistTokenCheck =
  | { readonly ok: true; readonly payload: AssistTokenPayload }
  | { readonly ok: false; readonly reason: 'malformed' | 'invalid_signature' | 'expired' | 'too_long' };

/** Verifies signature, shape and time window. The local grant check is the caller's job. */
export async function verifyAssistToken(
  key: CryptoKey,
  token: string,
  nowMs: number,
): Promise<AssistTokenCheck> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== ASSIST_TOKEN_PREFIX || parts[1] === undefined || parts[2] === undefined) {
    return { ok: false, reason: 'malformed' };
  }
  if (!(await verify(key, `${ASSIST_TOKEN_PREFIX}.${parts[1]}`, parts[2]))) {
    return { ok: false, reason: 'invalid_signature' };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(decoder.decode(fromB64Url(parts[1])));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!isAssistPayload(payload)) return { ok: false, reason: 'malformed' };
  const now = Math.floor(nowMs / 1000);
  if (payload.exp <= now || payload.iat > now + 60) return { ok: false, reason: 'expired' };
  if (payload.exp - payload.iat > ASSIST_TOKEN_MAX_TTL_SECONDS) return { ok: false, reason: 'too_long' };
  return { ok: true, payload };
}

function isAssistPayload(value: unknown): value is AssistTokenPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.v === 1 &&
    v.typ === 'assist' &&
    ['iid', 'gid', 'tid', 'sid', 'sname', 'jti'].every((k) => typeof v[k] === 'string' && v[k] !== '') &&
    typeof v.iat === 'number' &&
    typeof v.exp === 'number'
  );
}
