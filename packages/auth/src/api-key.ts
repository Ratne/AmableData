import { randomToken, sha256Hex } from './crypto';

/**
 * API keys: `amb_live_<43 chars>`; only the SHA-256 hash and a short visible
 * prefix are stored. The full key is returned exactly once at creation.
 */
export const API_KEY_PREFIX = 'amb_live_';
const VISIBLE_PREFIX_LENGTH = API_KEY_PREFIX.length + 6;

export interface GeneratedApiKey {
  readonly key: string;
  readonly prefix: string;
  readonly hash: string;
}

export async function generateApiKey(): Promise<GeneratedApiKey> {
  const key = `${API_KEY_PREFIX}${randomToken(32)}`;
  return { key, prefix: key.slice(0, VISIBLE_PREFIX_LENGTH), hash: await sha256Hex(key) };
}

export function looksLikeApiKey(value: string): boolean {
  return value.startsWith(API_KEY_PREFIX) && value.length > VISIBLE_PREFIX_LENGTH + 20;
}

export function hashApiKey(key: string): Promise<string> {
  return sha256Hex(key);
}

/**
 * Scope cap: returns the requested scopes the creator's role does NOT grant.
 * An empty result means the key may be created.
 */
export function scopesExceedingRole<P extends string>(
  requested: readonly P[],
  granted: ReadonlySet<P> | readonly P[],
): P[] {
  const allowed = granted instanceof Set ? granted : new Set(granted as readonly P[]);
  return requested.filter((scope) => !allowed.has(scope));
}

/** Effective permissions of a key at request time: scopes ∩ creator's current role. */
export function effectiveKeyPermissions<P extends string>(
  scopes: readonly P[],
  creatorPermissions: readonly P[],
): Set<P> {
  const granted = new Set(creatorPermissions);
  return new Set(scopes.filter((scope) => granted.has(scope)));
}
