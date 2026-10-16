import { redactIpAddresses } from '@amable/auth/security';

/**
 * Removes personal data and secrets from free text before it leaves the
 * process (error messages, breadcrumbs, file paths). Conservative on purpose:
 * a redacted id costs nothing, a leaked email address does.
 */

const MAX_TEXT = 1_000;

const RULES: readonly (readonly [RegExp, string | ((match: string) => string)])[] = [
  // Bearer credentials and license / assist / API tokens.
  [/\bBearer\s+\S+/gi, 'Bearer [token]'],
  [/\bamb_[A-Za-z0-9_.-]+/g, '[token]'],
  // Email addresses (also percent-encoded @).
  [/[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  // Query strings of URLs or paths: `?a=b&c=d`.
  [/\?[\w.~%-]+=[^\s"'`)\]]*/g, '?[query]'],
  // Hex / base64 runs of 20+ characters containing a digit (keys, hashes, ULIDs, JWT parts).
  [/[A-Za-z0-9+_=-]{20,}/g, (match) => (/\d/.test(match) ? '[redacted]' : match)],
  // Long digit runs (phone numbers, card numbers, numeric ids).
  [/\d{6,}/g, '[number]'],
];

const QUOTED = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

/** Scrubs secrets and personal data from any text (paths, breadcrumbs). */
export function scrubText(input: string, max = MAX_TEXT): string {
  let out = redactIpAddresses(input);
  for (const [pattern, replacement] of RULES) {
    out = typeof replacement === 'string' ? out.replace(pattern, replacement) : out.replace(pattern, replacement);
  }
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

/** Stack frame file: no query / fragment / origin, no credentials; the path itself is kept. */
export function scrubFile(input: string): string {
  const withoutOrigin = input.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '');
  return withoutOrigin
    .replace(/[?#].*$/, '')
    .replace(/\bamb_[A-Za-z0-9_.-]+/g, '[token]')
    .replace(/[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .slice(0, 300);
}

/** Error messages additionally lose quoted strings: they usually carry user input. */
export function scrubMessage(input: string, max = MAX_TEXT): string {
  return scrubText(input.replace(QUOTED, (m) => `${m[0] ?? '"'}[str]${m[0] ?? '"'}`), max);
}
