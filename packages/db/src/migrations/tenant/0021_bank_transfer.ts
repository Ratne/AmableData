import type { Migration } from '../types';

/**
 * Bank transfer payments of checkouts and Stripe Managed Payments.
 *
 * - `crm_checkout_sessions.payment_method`: `card` (Stripe) or `bank_transfer`;
 *   `bank_details` snapshots the account shown to the buyer (JSON), so a later
 *   edit of the account never changes what the buyer was told.
 * - `summary_email_due_at` / `summary_email_sent_at`: the single summary email
 *   of a bank transfer purchase, sent when the offer chain ends or after a
 *   pause (abandoned funnel) by the TenantDb alarm.
 * - `crm_orders.payment_method`: how the buyer chose to pay a checkout order
 *   (null for manual/API orders).
 * - `crm_products.stripe_tax_code`: Stripe tax code of the product under
 *   Managed Payments (null: the workspace default).
 */
export const t0021BankTransfer: Migration = {
  id: 21,
  name: 'bank_transfer',
  statements: [
    `ALTER TABLE crm_checkout_sessions ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'card'`,
    `ALTER TABLE crm_checkout_sessions ADD COLUMN bank_details TEXT`,
    `ALTER TABLE crm_checkout_sessions ADD COLUMN summary_email_due_at INTEGER`,
    `ALTER TABLE crm_checkout_sessions ADD COLUMN summary_email_sent_at INTEGER`,
    `CREATE INDEX crm_checkout_sessions_summary ON crm_checkout_sessions (summary_email_due_at)
      WHERE summary_email_due_at IS NOT NULL`,
    `ALTER TABLE crm_orders ADD COLUMN payment_method TEXT`,
    `ALTER TABLE crm_products ADD COLUMN stripe_tax_code TEXT`,
  ],
};
