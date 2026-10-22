import type { PrivateJwk } from '@amable/app-sdk';

/** Secrets of the email link token (`tly`), one per signing key: the first signs, all verify. */
export function linkSecrets(keys: readonly PrivateJwk[]): string[] {
  return keys.map((key) => `timely-link:${key.d}`);
}
