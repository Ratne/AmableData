import { hex, safeEqual, utf8 } from './encoding';

/**
 * Every call the CRM makes to the app (webhooks, hooks, actions, connectors,
 * channels) is signed with the installation's webhook secret:
 * `Amable-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`.
 * During a secret rotation the CRM may send two `v1` values.
 */

export const SIGNATURE_HEADER = 'Amable-Signature';
export const INSTALLATION_HEADER = 'Amable-Installation';
export const DEFAULT_TOLERANCE_SECONDS = 300;

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, utf8(message)));
}

export async function signPayload(secret: string, rawBody: string, nowMs = Date.now()): Promise<string> {
  const t = Math.floor(nowMs / 1000);
  return `t=${String(t)},v1=${await hmac(secret, `${String(t)}.${rawBody}`)}`;
}

export type SignatureFailure = 'missing' | 'malformed' | 'expired' | 'mismatch';

export async function verifySignature(input: {
  header: string | null;
  rawBody: string;
  secrets: readonly string[];
  nowMs?: number;
  toleranceSeconds?: number;
}): Promise<{ ok: true } | { ok: false; reason: SignatureFailure }> {
  if (input.header === null || input.header === '') return { ok: false, reason: 'missing' };
  let t: number | null = null;
  const signatures: string[] = [];
  for (const part of input.header.split(',')) {
    const [key, value] = part.trim().split('=', 2);
    if (key === 't' && value !== undefined && /^\d+$/.test(value)) t = Number(value);
    if (key === 'v1' && value !== undefined && /^[0-9a-f]{64}$/.test(value)) signatures.push(value);
  }
  if (t === null || signatures.length === 0) return { ok: false, reason: 'malformed' };
  const now = Math.floor((input.nowMs ?? Date.now()) / 1000);
  if (Math.abs(now - t) > (input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS)) return { ok: false, reason: 'expired' };
  for (const secret of input.secrets) {
    const expected = await hmac(secret, `${String(t)}.${input.rawBody}`);
    if (signatures.some((s) => safeEqual(s, expected))) return { ok: true };
  }
  return { ok: false, reason: 'mismatch' };
}

/** Common fields of every signed call. */
export interface SignedCall {
  readonly installation_id: string;
  readonly tenant: string | null;
  readonly api_version: string;
  readonly [key: string]: unknown;
}

/**
 * Reads and verifies a signed request. `secretsFor` returns the secrets of the
 * installation named in the `Amable-Installation` header (current and, while
 * rotating, previous). Answer 401 when this returns `ok: false`.
 */
export async function readSignedCall(
  request: Request,
  secretsFor: (installationId: string) => Promise<readonly string[]> | readonly string[],
  nowMs?: number,
): Promise<{ ok: true; body: SignedCall } | { ok: false; reason: SignatureFailure | 'unknown_installation' | 'bad_body' }> {
  const installationId = request.headers.get(INSTALLATION_HEADER) ?? '';
  const rawBody = await request.text();
  const secrets = installationId === '' ? [] : await secretsFor(installationId);
  if (secrets.length === 0) return { ok: false, reason: 'unknown_installation' };
  const verified = await verifySignature({ header: request.headers.get(SIGNATURE_HEADER), rawBody, secrets, ...(nowMs === undefined ? {} : { nowMs }) });
  if (!verified.ok) return verified;
  try {
    const body = JSON.parse(rawBody) as SignedCall;
    if (body.installation_id !== installationId) return { ok: false, reason: 'bad_body' };
    return { ok: true, body };
  } catch {
    return { ok: false, reason: 'bad_body' };
  }
}
