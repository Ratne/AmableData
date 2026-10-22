import type { Migration } from '../types';

/**
 * Checkouts of the tenant DO: embeddable payment pages (`crm_checkouts`, the
 * definition edited in the commerce section) and the purchase sessions they
 * open (`crm_checkout_sessions`: one per buyer, carrying the Stripe intent,
 * the saved payment method and the position in the post-purchase offer chain).
 * Session tokens are stored as SHA-256 only.
 *
 * Also: setup fee on subscription plans, promo code duration on recurring
 * billing (`once` / `repeating` / `forever`) with the remaining discount kept
 * on the subscription, the Stripe customer of each contact, the saved payment
 * method of subscriptions and the automatic charge schedule of their orders.
 */
export const t0017Checkout: Migration = {
  id: 17,
  name: 'checkout',
  statements: [
    `CREATE TABLE crm_checkouts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      definition TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    )`,
    `CREATE INDEX crm_checkouts_status ON crm_checkouts (status, updated_at) WHERE deleted_at IS NULL`,
    `CREATE TABLE crm_checkout_sessions (
      id TEXT PRIMARY KEY,
      checkout_id TEXT NOT NULL REFERENCES crm_checkouts (id),
      token_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      contact_id TEXT,
      order_id TEXT,
      currency TEXT NOT NULL,
      amount_minor INTEGER NOT NULL DEFAULT 0,
      selection TEXT NOT NULL DEFAULT '{}',
      field_values TEXT NOT NULL DEFAULT '{}',
      tracking TEXT NOT NULL DEFAULT '{}',
      visitor_id TEXT,
      page_url TEXT,
      locale TEXT,
      intent_kind TEXT,
      intent_id TEXT,
      stripe_customer_id TEXT,
      stripe_payment_method_id TEXT,
      current_offer TEXT,
      pending_offer TEXT,
      pending_intent_id TEXT,
      offer_attempts INTEGER NOT NULL DEFAULT 0,
      offers TEXT NOT NULL DEFAULT '[]',
      last_error TEXT,
      expires_at INTEGER NOT NULL,
      paid_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE UNIQUE INDEX crm_checkout_sessions_token ON crm_checkout_sessions (token_hash)`,
    `CREATE INDEX crm_checkout_sessions_checkout ON crm_checkout_sessions (checkout_id, created_at)`,
    `CREATE INDEX crm_checkout_sessions_intent ON crm_checkout_sessions (intent_id) WHERE intent_id IS NOT NULL`,
    `CREATE TABLE crm_stripe_customers (
      contact_id TEXT PRIMARY KEY REFERENCES crm_contacts (id),
      customer_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,

    `ALTER TABLE crm_subscription_plans ADD COLUMN setup_fee_minor INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE crm_promo_codes ADD COLUMN duration TEXT NOT NULL DEFAULT 'once'`,
    `ALTER TABLE crm_promo_codes ADD COLUMN duration_periods INTEGER`,
    `ALTER TABLE crm_subscriptions ADD COLUMN promo_code_id TEXT`,
    `ALTER TABLE crm_subscriptions ADD COLUMN promo_code TEXT`,
    `ALTER TABLE crm_subscriptions ADD COLUMN discount_kind TEXT`,
    `ALTER TABLE crm_subscriptions ADD COLUMN discount_percent_bps INTEGER`,
    `ALTER TABLE crm_subscriptions ADD COLUMN discount_amount_minor INTEGER`,
    // NULL with a discount_kind: the discount applies forever.
    `ALTER TABLE crm_subscriptions ADD COLUMN discount_periods_left INTEGER`,
    `ALTER TABLE crm_subscriptions ADD COLUMN stripe_customer_id TEXT`,
    `ALTER TABLE crm_subscriptions ADD COLUMN stripe_payment_method_id TEXT`,
    `ALTER TABLE crm_orders ADD COLUMN checkout_id TEXT`,
    `ALTER TABLE crm_orders ADD COLUMN checkout_session_id TEXT`,
    `ALTER TABLE crm_orders ADD COLUMN parent_order_id TEXT`,
    // Attribution of the purchase (utm_*, click ids) as JSON; post-purchase offers inherit it.
    `ALTER TABLE crm_orders ADD COLUMN attribution TEXT`,
    `ALTER TABLE crm_orders ADD COLUMN auto_charge_attempts INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE crm_orders ADD COLUMN next_charge_at INTEGER`,
    `CREATE INDEX crm_orders_next_charge ON crm_orders (next_charge_at) WHERE next_charge_at IS NOT NULL`,
  ],
};
