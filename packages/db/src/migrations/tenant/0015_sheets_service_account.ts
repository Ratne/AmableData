import type { Migration } from '../types';

/**
 * Google Sheets connections write as a service account (its JSON key is the
 * connection secret) instead of an OAuth account: `account_id` leaves the config.
 */
export const t0015SheetsServiceAccount: Migration = {
  id: 15,
  name: 'sheets_service_account',
  statements: [
    `UPDATE form_connections SET config = json_remove(config, '$.account_id') WHERE type = 'google_sheets'`,
  ],
};
