import type { Migration } from '../types';

/**
 * Abandoned carts: the email (and name, phone, cart) a buyer typed in a
 * checkout before paying, one row per checkout and email. No contact is
 * created until the cart is abandoned: then the TenantDb alarm upserts the
 * contact and emits `checkout.abandoned`. `due_at` is when an open row is
 * checked; `session_id` the purchase opened by the same buyer, if any.
 *
 * No foreign keys (like every tenant table): the ops delete dependent rows.
 */
export const t0025CheckoutLeads: Migration = {
  id: 25,
  name: 'checkout_leads',
  statements: [
    `CREATE TABLE crm_checkout_leads (
      id TEXT PRIMARY KEY,
      checkout_id TEXT NOT NULL,
      email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      field_values TEXT NOT NULL DEFAULT '{}',
      selection TEXT NOT NULL DEFAULT '{}',
      promo_code TEXT NOT NULL DEFAULT '',
      currency TEXT,
      amount_minor INTEGER NOT NULL DEFAULT 0,
      product_ids TEXT NOT NULL DEFAULT '[]',
      tracking TEXT NOT NULL DEFAULT '{}',
      visitor_id TEXT,
      page_url TEXT,
      locale TEXT,
      session_id TEXT,
      contact_id TEXT,
      due_at INTEGER,
      abandoned_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (checkout_id, email)
    )`,
    `CREATE INDEX crm_checkout_leads_due ON crm_checkout_leads (due_at) WHERE status = 'open'`,
    `CREATE INDEX crm_checkout_leads_session ON crm_checkout_leads (session_id) WHERE session_id IS NOT NULL`,
    `CREATE INDEX crm_checkout_leads_updated ON crm_checkout_leads (updated_at)`,
  ],
};
