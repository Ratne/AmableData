import { randomBytes } from './crypto';

/** Uniformly distributed numeric code (rejection sampling, no modulo bias). */
export function generateNumericCode(digits = 6): string {
  const max = 10 ** digits;
  const limit = Math.floor(0xffffffff / max) * max;
  for (;;) {
    const bytes = randomBytes(4);
    const value = ((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8);
    const n = (value | (bytes[3] ?? 0)) >>> 0;
    if (n < limit) return String(n % max).padStart(digits, '0');
  }
}

/** Unambiguous alphabet (no 0/o/1/l/i) for human-typed recovery codes. */
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const RECOVERY_CODE_COUNT = 10;

function recoveryCode(): string {
  const size = RECOVERY_ALPHABET.length;
  const limit = Math.floor(256 / size) * size;
  let out = '';
  while (out.length < 10) {
    for (const byte of randomBytes(16)) {
      if (byte < limit && out.length < 10) out += RECOVERY_ALPHABET[byte % size];
    }
  }
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

/** Ten single-use recovery codes, shown once; only their hashes are stored. */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) codes.add(recoveryCode());
  return [...codes];
}

/** Canonical form used before hashing: lowercase, no separators/spaces. */
export function normalizeRecoveryCode(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, '');
}
