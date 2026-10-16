import type { Migration } from '../types';

/**
 * Submissions of one contact, newest first (contact page tab and its count):
 * the 0005 `form_submissions_contact` index has no order. `IF NOT EXISTS`
 * keeps it safe on databases that already got the index by hand.
 */
export const t0009FormSubmissionsContact: Migration = {
  id: 9,
  name: 'form_submissions_contact',
  statements: [
    `CREATE INDEX IF NOT EXISTS form_submissions_contact_created
       ON form_submissions (contact_id, created_at DESC, id DESC) WHERE deleted_at IS NULL`,
  ],
};
