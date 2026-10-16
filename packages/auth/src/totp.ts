import { hmacSha1, randomBytes } from './crypto';
import { fromBase32, toBase32 } from './encoding';

/** RFC 6238 parameters fixed by the product: SHA-1, 6 digits, 30 s step, ±1 step tolerance. */
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_WINDOW = 1;

/** New 160-bit secret, base32-encoded (what authenticator apps import). */
export function generateTotpSecret(): string {
  return toBase32(randomBytes(20));
}

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

/** HOTP (RFC 4226) value for a counter — TOTP is HOTP over the time step. */
export async function hotp(secretBase32: string, counter: number, digits = TOTP_DIGITS) {
  const message = new Uint8Array(8);
  let value = counter;
  for (let i = 7; i >= 0; i -= 1) {
    message[i] = value & 0xff;
    value = Math.floor(value / 256);
  }
  const mac = await hmacSha1(fromBase32(secretBase32), message);
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    ((mac[offset + 1] ?? 0) << 16) |
    ((mac[offset + 2] ?? 0) << 8) |
    (mac[offset + 3] ?? 0);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function totpCode(secretBase32: string, nowMs: number): Promise<string> {
  return hotp(secretBase32, totpStep(nowMs));
}

export type TotpVerification = { ok: true; step: number } | { ok: false };

/**
 * Verifies a TOTP code within ±TOTP_WINDOW steps. `lastUsedStep` enforces
 * single use: a step at or before the last accepted one is refused, so a code
 * seen once (shoulder surfing, phishing relay) cannot be replayed. The caller
 * must persist the returned step atomically.
 */
export async function verifyTotp(
  secretBase32: string,
  code: string,
  nowMs: number,
  lastUsedStep: number | null,
): Promise<TotpVerification> {
  const normalized = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(normalized)) return { ok: false };
  const current = totpStep(nowMs);
  let matched: number | null = null;
  // Check every candidate step (no early exit) to keep timing uniform.
  for (let delta = -TOTP_WINDOW; delta <= TOTP_WINDOW; delta += 1) {
    const step = current + delta;
    const expected = await hotp(secretBase32, step);
    if (expected === normalized && (lastUsedStep === null || step > lastUsedStep)) {
      matched = step;
    }
  }
  return matched === null ? { ok: false } : { ok: true, step: matched };
}

/** otpauth:// URI rendered as QR code during enrollment. */
export function otpauthUri(params: { secret: string; account: string; issuer: string }): string {
  const label = encodeURIComponent(`${params.issuer}:${params.account}`);
  const query = new URLSearchParams({
    secret: params.secret,
    issuer: params.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
