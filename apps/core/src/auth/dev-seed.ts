import { totpCode } from '@amable/auth';
import type { Context } from 'hono';
import type { AppEnv } from '../middleware/context';
import { recoveryCodeHash } from './challenge';
import { replaceRecoveryCodes } from './store';

/**
 * Local-only credentials for the seeded admin. Public on purpose — they only
 * ever exist when ENVIRONMENT=dev (the seed route is not mounted otherwise).
 */
export const DEV_ADMIN_PASSWORD = 'amable-local-dev-password';
export const DEV_ADMIN_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
export const DEV_ADMIN_RECOVERY_CODES = [
  'devaa-aaaa1',
  'devaa-aaaa2',
  'devaa-aaaa3',
  'devaa-aaaa4',
  'devaa-aaaa5',
  'devaa-aaaa6',
  'devaa-aaaa7',
  'devaa-aaaa8',
  'devaa-aaaa9',
  'devaa-aaab2',
];

export async function seedDevCredentials(c: Context<AppEnv>, userId: string) {
  if (c.env.ENVIRONMENT !== 'dev') throw new Error('dev credentials outside ENVIRONMENT=dev');
  const services = c.get('services');
  const now = services.now();
  const passwordHash = await services.hasher.hash(DEV_ADMIN_PASSWORD);
  const totpSecretEnc = await services.secretBox.encrypt(DEV_ADMIN_TOTP_SECRET, `totp:${userId}`);
  await c.env.DB.prepare(
    `UPDATE users SET password_hash = ?, password_changed_at = ?, email_verified_at = ?,
       mfa_method = 'totp', mfa_enrolled_at = ?, totp_secret_enc = ?, totp_last_step = NULL,
       failed_challenges = 0, lock_count = 0, locked_until = NULL, updated_at = ?
     WHERE id = ?`,
  )
    .bind(passwordHash, now, now, now, totpSecretEnc, now, userId)
    .run();
  const hashes = await Promise.all(
    DEV_ADMIN_RECOVERY_CODES.map((code) => recoveryCodeHash(services.pepper, code)),
  );
  await replaceRecoveryCodes(c.env.DB, userId, hashes, now);

  const currentCode = await totpCode(DEV_ADMIN_TOTP_SECRET, now);
  console.log(
    [
      '',
      '[dev-seed] local admin credentials (dev only):',
      `  email:        admin@example.com`,
      `  password:     ${DEV_ADMIN_PASSWORD}`,
      `  TOTP secret:  ${DEV_ADMIN_TOTP_SECRET}  (current code: ${currentCode})`,
      `  recovery:     ${DEV_ADMIN_RECOVERY_CODES.join(' ')}`,
      '',
    ].join('\n'),
  );
  return {
    password: DEV_ADMIN_PASSWORD,
    totpSecret: DEV_ADMIN_TOTP_SECRET,
    recoveryCodes: DEV_ADMIN_RECOVERY_CODES,
  };
}
