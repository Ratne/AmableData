import { hmacSha256, randomBytes, sha256Hex, timingSafeEqual } from './crypto';
import { fromBase64, toBase64, toHex, utf8 } from './encoding';

/**
 * Password hashing.
 *
 * Primary: Argon2id (OWASP: m=19 MiB, t=2, p=1) via a WebAssembly engine.
 * The Workers runtime forbids compiling WASM from bytes at runtime, so the
 * engine is injected: the worker instantiates the precompiled module imported
 * as `*.wasm`, Node tests load the same binary from disk.
 *
 * Pepper: the password is first HMAC-SHA256'd with a secret pepper (Wrangler
 * secret), so a leaked database alone cannot be brute-forced offline.
 *
 * Fallback: PBKDF2-SHA256 at 100 000 iterations (the WebCrypto cap in Workers)
 * with the same pepper — only if Argon2id ever proves too expensive in CPU on
 * the target plan. Stored hashes are self-describing, so both coexist and
 * `needsRehash` upgrades users at their next login.
 */

export const PASSWORD_MIN_LENGTH = 12;
/** Upper bound to keep hashing cost bounded (DoS guard). */
export const PASSWORD_MAX_LENGTH = 256;

export interface Argon2idParams {
  readonly memoryKiB: number;
  readonly iterations: number;
  readonly parallelism: number;
}

export const OWASP_ARGON2ID: Argon2idParams = { memoryKiB: 19_456, iterations: 2, parallelism: 1 };

/** Minimal structural view of an Argon2 WASM engine (e.g. @phi-ag/argon2). */
export interface Argon2Engine {
  hash(
    password: string,
    options: {
      salt: Uint8Array;
      hashLength: number;
      timeCost: number;
      memoryCost: number;
      parallelism: number;
      type: number;
      version: number;
    },
  ): { encoded: string };
  tryVerify(encoded: string, password: string): { success: boolean };
}

const ARGON2_TYPE_ID = 2;
const ARGON2_VERSION_13 = 0x13;

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(stored: string, password: string): Promise<boolean>;
  /** True when `stored` uses another algorithm or weaker parameters. */
  needsRehash(stored: string): boolean;
}

async function pepperize(pepper: string, password: string): Promise<string> {
  return toBase64(await hmacSha256(pepper, password.normalize('NFKC')));
}

export function createArgon2idHasher(options: {
  engine: Argon2Engine;
  pepper: string;
  params?: Argon2idParams;
  /** Used to verify legacy/fallback PBKDF2 hashes. */
  pbkdf2Iterations?: number;
}): PasswordHasher {
  const params = options.params ?? OWASP_ARGON2ID;
  const pbkdf2 = createPbkdf2Hasher({
    pepper: options.pepper,
    iterations: options.pbkdf2Iterations ?? PBKDF2_ITERATIONS,
  });
  const paramTag = `m=${params.memoryKiB},t=${params.iterations},p=${params.parallelism}`;

  return {
    async hash(password) {
      const peppered = await pepperize(options.pepper, password);
      return options.engine.hash(peppered, {
        salt: randomBytes(16),
        hashLength: 32,
        timeCost: params.iterations,
        memoryCost: params.memoryKiB,
        parallelism: params.parallelism,
        type: ARGON2_TYPE_ID,
        version: ARGON2_VERSION_13,
      }).encoded;
    },
    async verify(stored, password) {
      if (stored.startsWith('$pbkdf2-sha256$')) return pbkdf2.verify(stored, password);
      if (!stored.startsWith('$argon2id$')) return false;
      const peppered = await pepperize(options.pepper, password);
      return options.engine.tryVerify(stored, peppered).success;
    },
    needsRehash(stored) {
      return !stored.startsWith(`$argon2id$v=19$${paramTag}$`);
    },
  };
}

export const PBKDF2_ITERATIONS = 100_000;

/** Fallback hasher — see module docs. Format: $pbkdf2-sha256$i=<n>$<salt b64>$<hash b64>. */
export function createPbkdf2Hasher(options: { pepper: string; iterations?: number }): PasswordHasher {
  const iterations = options.iterations ?? PBKDF2_ITERATIONS;

  async function derive(password: string, salt: Uint8Array<ArrayBuffer>, rounds: number) {
    const peppered = await pepperize(options.pepper, password);
    const key = await crypto.subtle.importKey('raw', utf8(peppered), 'PBKDF2', false, [
      'deriveBits',
    ]);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: rounds },
      key,
      256,
    );
    return new Uint8Array(bits);
  }

  return {
    async hash(password) {
      const salt = randomBytes(16);
      const derived = await derive(password, salt, iterations);
      return `$pbkdf2-sha256$i=${iterations}$${toBase64(salt)}$${toBase64(derived)}`;
    },
    async verify(stored, password) {
      const match = /^\$pbkdf2-sha256\$i=(\d+)\$([^$]+)\$([^$]+)$/.exec(stored);
      if (match === null) return false;
      const rounds = Number(match[1]);
      if (!Number.isInteger(rounds) || rounds < 1 || rounds > 1_000_000) return false;
      const derived = await derive(password, fromBase64(match[2] ?? ''), rounds);
      return timingSafeEqual(derived, fromBase64(match[3] ?? ''));
    },
    needsRehash(stored) {
      return !stored.startsWith(`$pbkdf2-sha256$i=${iterations}$`);
    },
  };
}

// ---------------------------------------------------------------------------
// Policy + breach check
// ---------------------------------------------------------------------------

/** Is this password present in a known breach corpus? */
export interface PasswordBreachChecker {
  isBreached(password: string): Promise<boolean>;
}

/**
 * k-anonymity range check against the public breached-passwords range API:
 * only the first 5 hex chars of the SHA-1 leave the worker, with padding on.
 * `fetchFn` is injected — tests never touch the network. Network failures
 * fail open (the length rule still applies) and are reported via `onError`.
 */
export function createHibpBreachChecker(options: {
  fetchFn: (input: string, init?: RequestInit) => Promise<Response>;
  endpoint?: string;
  onError?: (error: unknown) => void;
}): PasswordBreachChecker {
  const endpoint = options.endpoint ?? 'https://api.pwnedpasswords.com/range/';
  return {
    async isBreached(password) {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', utf8(password)));
      const sha1 = toHex(digest).toUpperCase();
      const prefix = sha1.slice(0, 5);
      const suffix = sha1.slice(5);
      try {
        const response = await options.fetchFn(`${endpoint}${prefix}`, {
          headers: { 'Add-Padding': 'true' },
          signal: AbortSignal.timeout(3000),
        });
        if (!response.ok) throw new Error(`breach range API returned ${response.status}`);
        const body = await response.text();
        for (const line of body.split('\n')) {
          const [candidate, count] = line.trim().split(':');
          if (candidate === suffix && Number(count) > 0) return true;
        }
        return false;
      } catch (error) {
        options.onError?.(error);
        return false;
      }
    },
  };
}

/** Offline checker over a fixed list — local dev and tests. */
export function createStaticBreachChecker(breached: Iterable<string>): PasswordBreachChecker {
  const hashes = new Set<string>();
  const pending = Promise.all([...breached].map(async (p) => hashes.add(await sha256Hex(p))));
  return {
    async isBreached(password) {
      await pending;
      return hashes.has(await sha256Hex(password));
    },
  };
}

/** A handful of the most common long passwords — the offline dev list. */
export const COMMON_BREACHED_PASSWORDS = [
  'password1234',
  'password12345',
  'password123456',
  '123456789012',
  '1234567890123',
  'qwertyuiop12',
  'qwertyuiopas',
  'iloveyou1234',
  'administrator',
  'passwordpassword',
  'welcome12345',
  'letmein12345',
];

export type PasswordPolicyError = 'too_short' | 'too_long' | 'breached';

export async function checkPasswordPolicy(
  password: string,
  breachChecker: PasswordBreachChecker,
): Promise<PasswordPolicyError | null> {
  if ([...password].length < PASSWORD_MIN_LENGTH) return 'too_short';
  if (password.length > PASSWORD_MAX_LENGTH) return 'too_long';
  if (await breachChecker.isBreached(password)) return 'breached';
  return null;
}
