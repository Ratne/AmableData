import { hmacSha256, hmacSha256Hex, sha256Hex, toBase64Url } from '@amable/auth';
import { edgeOrigin } from '../booking/flow';
import { tokenSecrets } from '../email/runtime';
import type { Env } from '../env';

/**
 * Signing links carry a token derived from the signer's random nonce and the
 * email token secret: reminders can rebuild the same link without storing it,
 * the TenantDb only keeps its SHA-256 (lookup by hash).
 */

async function derive(secret: string, nonce: string): Promise<string> {
  return toBase64Url(await hmacSha256(secret, `esign-link:${nonce}`));
}

export const hashSigningToken = (token: string): Promise<string> => sha256Hex(token);

/**
 * Token of a signer's link: the one matching the stored hash (a previous
 * secret still listed keeps old links working), else a fresh one under the
 * current secret (`rotated` when it replaces a stored hash).
 */
export async function signerToken(
  env: Env,
  nonce: string,
  storedHash: string | null,
): Promise<{ token: string; hash: string; rotated: boolean }> {
  const secrets = tokenSecrets(env);
  if (storedHash !== null) {
    for (const secret of secrets) {
      const token = await derive(secret, nonce);
      const hash = await hashSigningToken(token);
      if (hash === storedHash) return { token, hash, rotated: false };
    }
  }
  const token = await derive(secrets[0]!, nonce);
  return { token, hash: await hashSigningToken(token), rotated: storedHash !== null };
}

export function signingUrl(env: Env, tenantSlug: string, token: string): string {
  return `${edgeOrigin(env)}/sign/${encodeURIComponent(tenantSlug)}/${token}`;
}

/** Hash of an email confirmation code, bound to the signer (codes are never stored). */
export async function otpCodeHash(env: Env, signerId: string, code: string): Promise<string> {
  return hmacSha256Hex(tokenSecrets(env)[0]!, `esign-otp:${signerId}:${code}`);
}
