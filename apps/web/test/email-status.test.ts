import { describe, expect, it } from 'vitest';
import { emailVerificationState } from '../src/features/crm/pages/contact-detail/emails-phones';

describe('emailVerificationState', () => {
  it('reads the status a verification app wrote', () => {
    for (const status of ['deliverable', 'risky', 'unknown', 'undeliverable'] as const) {
      expect(
        emailVerificationState({ custom_fields: { app_emailable_email_status: status } }),
      ).toBe(status);
    }
    expect(emailVerificationState({ custom_fields: { app_other_app_email_status: 'risky' } })).toBe(
      'risky',
    );
  });

  it('ignores missing, unknown and user-owned values', () => {
    expect(emailVerificationState({ custom_fields: {} })).toBeNull();
    expect(
      emailVerificationState({ custom_fields: { app_emailable_email_status: 'valid' } }),
    ).toBeNull();
    expect(
      emailVerificationState({ custom_fields: { app_emailable_email_status: null } }),
    ).toBeNull();
    expect(emailVerificationState({ custom_fields: { email_status: 'deliverable' } })).toBeNull();
  });
});
