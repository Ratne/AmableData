/**
 * @amable/auth — runtime-agnostic auth primitives (WebCrypto only): password
 * hashing (Argon2id + pepper, PBKDF2 fallback), breach check, TOTP, OTP and
 * recovery codes, opaque tokens, secret encryption, session timing, API keys,
 * CSRF, rate-limit / Turnstile contracts, webhook signatures.
 *
 * Storage (D1) and HTTP wiring live in apps/core/src/auth.
 */

/** Opaque session token as it travels in the __Host-sid cookie. */
export type SessionToken = string;

export interface AuthenticatedUserRef {
  readonly userId: string;
  readonly sessionId: string;
}

export * from './encoding';
export {
  randomBytes,
  randomToken,
  sha256Hex,
  hmacSha256,
  hmacSha256Hex,
  timingSafeEqual,
  createSecretBox,
  SecretBoxError,
} from './crypto';
export type { SecretBox } from './crypto';
export * from './totp';
export * from './codes';
export * from './password';
export * from './policy';
export * from './session';
export * from './api-key';
export * from './csrf';
export * from './rate-limit';
export * from './turnstile';
export * from './webhook';
