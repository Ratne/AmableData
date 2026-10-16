import { hmacSha256Hex, timingSafeEqual } from './crypto';

/**
 * HMAC-SHA256 webhook signatures, used for outgoing webhooks (forms, REST
 * hooks) and as the verification model for incoming ones.
 *
 * Header: `Amable-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>…]`, where the
 * signed payload is `${t}.${rawBody}`. Several v1 entries allow secret rotation.
 */
export const WEBHOOK_SIGNATURE_HEADER = 'Amable-Signature';
export const WEBHOOK_TOLERANCE_SECONDS = 300;

export async function signWebhook(
  secret: string,
  rawBody: string,
  nowMs: number = Date.now(),
): Promise<string> {
  const timestamp = Math.floor(nowMs / 1000);
  const signature = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
  return `t=${timestamp},v1=${signature}`;
}

export type WebhookVerifyFailure =
  | 'malformed_header'
  | 'timestamp_out_of_tolerance'
  | 'bad_signature'
  | 'replayed';

/** Optional replay guard: returns false if the (timestamp, signature) pair was already seen. */
export interface ReplayGuard {
  markSeen(id: string, ttlSeconds: number): Promise<boolean>;
}

export async function verifyWebhook(input: {
  secrets: readonly string[];
  header: string | null;
  rawBody: string;
  nowMs?: number;
  toleranceSeconds?: number;
  replayGuard?: ReplayGuard;
}): Promise<{ ok: true } | { ok: false; reason: WebhookVerifyFailure }> {
  if (input.header === null) return { ok: false, reason: 'malformed_header' };
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of input.header.split(',')) {
    const [key, value] = part.trim().split('=', 2);
    if (key === 't' && value !== undefined && /^\d+$/.test(value)) timestamp = Number(value);
    if (key === 'v1' && value !== undefined && /^[0-9a-f]{64}$/.test(value)) signatures.push(value);
  }
  if (timestamp === null || signatures.length === 0) {
    return { ok: false, reason: 'malformed_header' };
  }
  const tolerance = input.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  const now = Math.floor((input.nowMs ?? Date.now()) / 1000);
  if (Math.abs(now - timestamp) > tolerance) {
    return { ok: false, reason: 'timestamp_out_of_tolerance' };
  }
  let matched: string | null = null;
  for (const secret of input.secrets) {
    const expected = await hmacSha256Hex(secret, `${timestamp}.${input.rawBody}`);
    for (const candidate of signatures) {
      if (timingSafeEqual(expected, candidate)) matched = candidate;
    }
  }
  if (matched === null) return { ok: false, reason: 'bad_signature' };
  if (input.replayGuard !== undefined) {
    const fresh = await input.replayGuard.markSeen(`${timestamp}:${matched}`, tolerance * 2);
    if (!fresh) return { ok: false, reason: 'replayed' };
  }
  return { ok: true };
}
