import type { Migration } from '../types';

/**
 * `crm_contacts.open_tracking_opt_out`: the contact does not want email opens
 * tracked (no open pixel in any email, opens of older emails ignored). Set by
 * the team in the CRM or by the recipient on the hosted preferences page.
 */
export const t0022OpenTracking: Migration = {
  id: 22,
  name: 'open_tracking',
  statements: [`ALTER TABLE crm_contacts ADD COLUMN open_tracking_opt_out INTEGER NOT NULL DEFAULT 0`],
};
