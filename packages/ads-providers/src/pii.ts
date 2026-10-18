/**
 * PII normalization and hashing as the ad platforms expect it. Web Crypto only,
 * so it runs unchanged on Workers, in Durable Objects and in Node tests.
 */

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

export interface NormalizeEmailOptions {
  /** Drop dots and the `+alias` of the local part on gmail.com / googlemail.com (Google enhanced conversions). */
  readonly canonicalizeGmail?: boolean;
}

/** Trimmed, lower-cased email, or `null` when it is not a plausible address. */
export function normalizeEmail(raw: string, options: NormalizeEmailOptions = {}): string | null {
  const email = raw.trim().toLowerCase();
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1 || email.indexOf('@') !== at || /\s/.test(email))
    return null;
  let local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!domain.includes('.')) return null;
  if (options.canonicalizeGmail === true && GMAIL_DOMAINS.has(domain)) {
    const plus = local.indexOf('+');
    if (plus >= 0) local = local.slice(0, plus);
    local = local.replaceAll('.', '');
    if (local === '') return null;
  }
  return `${local}@${domain}`;
}

export interface NormalizePhoneOptions {
  /** Country calling code (digits, e.g. `39`) for numbers written without an international prefix. */
  readonly defaultCallingCode?: string;
}

/**
 * E.164 digits without the leading `+` (e.g. `393331234567`), or `null`.
 * `+` and `00` mark an international number; otherwise `defaultCallingCode`
 * is prepended (dropping a national trunk `0`, except for Italy where the
 * leading 0 is part of the number). Without a default the number is assumed
 * to already carry its country code.
 */
export function normalizePhone(raw: string, options: NormalizePhoneOptions = {}): string | null {
  const trimmed = raw.trim();
  if (!/^[+\d\s().\-/]+$/.test(trimmed)) return null;
  let digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+')) {
    // already international
  } else if (digits.startsWith('00')) {
    digits = digits.slice(2);
  } else if (options.defaultCallingCode !== undefined) {
    const cc = options.defaultCallingCode.replace(/\D/g, '');
    if (cc !== '39' && digits.startsWith('0')) digits = digits.slice(1);
    digits = cc + digits;
  }
  if (digits.length < 8 || digits.length > 15 || digits.startsWith('0')) return null;
  return digits;
}

function toHex(buffer: ArrayBuffer): string {
  let out = '';
  for (const byte of new Uint8Array(buffer)) out += byte.toString(16).padStart(2, '0');
  return out;
}

export async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

export async function hmacSha256Hex(key: string, value: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(value)));
}

/** SHA-256 of the normalized email, or `null` when the email is invalid. */
export async function hashEmail(
  raw: string,
  options: NormalizeEmailOptions = {},
): Promise<string | null> {
  const email = normalizeEmail(raw, options);
  return email === null ? null : sha256Hex(email);
}

export interface HashPhoneOptions extends NormalizePhoneOptions {
  /** Hash `+<digits>` instead of the bare digits (Google, TikTok). */
  readonly withPlus?: boolean;
}

/** SHA-256 of the normalized phone, or `null` when the phone is invalid. */
export async function hashPhone(
  raw: string,
  options: HashPhoneOptions = {},
): Promise<string | null> {
  const phone = normalizePhone(raw, options);
  if (phone === null) return null;
  return sha256Hex(options.withPlus === true ? `+${phone}` : phone);
}
