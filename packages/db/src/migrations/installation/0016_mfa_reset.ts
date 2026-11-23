import type { Migration } from '../types';

/**
 * Second-factor recovery: a user who lost their authenticator confirms an
 * email code and the factor is cleared 24 hours later (`mfa_reset_due_at`),
 * unless the request is cancelled first. While both columns are NULL nothing
 * is pending.
 */
export const m0016MfaReset: Migration = {
  id: 16,
  name: 'mfa_reset',
  statements: [
    `ALTER TABLE users ADD COLUMN mfa_reset_requested_at INTEGER`,
    `ALTER TABLE users ADD COLUMN mfa_reset_due_at INTEGER`,
  ],
};
