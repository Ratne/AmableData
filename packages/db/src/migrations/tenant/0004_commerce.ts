import type { Migration } from '../types';

/**
 * E-commerce schema of the tenant DO: catalog (categories, products,
 * subscription plans), promo codes, orders with lines, manual/API payments and
 * refunds, subscriptions and invoices.
 *
 * Money is always INTEGER minor units (cents) next to an ISO 4217 currency;
 * tax rates are basis points (2200 = 22%). Same conventions as the CRM schema:
 * ULID ids, epoch-ms timestamps, soft delete via `deleted_at`.
 */
export const t0004Commerce: Migration = {
  id: 4,
  name: 'commerce',
  statements: [
    // Per-tenant gapless sequences (order and invoice numbers).
    `CREATE TABLE crm_counters (
      name TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    )`,

    // ------------------------------------------------------------- catalog
    `CREATE TABLE crm_product_categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    )`,
    `CREATE UNIQUE INDEX crm_product_categories_name ON crm_product_categories (name COLLATE NOCASE) WHERE deleted_at IS NULL`,
    `CREATE TABLE crm_products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      sku TEXT,
      category_id TEXT REFERENCES crm_product_categories (id),
      price_minor INTEGER NOT NULL,
      currency TEXT NOT NULL,
      tax_rate_bps INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    )`,
    `CREATE UNIQUE INDEX crm_products_sku ON crm_products (sku COLLATE NOCASE) WHERE deleted_at IS NULL AND sku IS NOT NULL`,
    `CREATE INDEX crm_products_category ON crm_products (category_id)`,
    `CREATE TABLE crm_subscription_plans (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES crm_products (id),
      name TEXT NOT NULL,
      interval TEXT NOT NULL,
      interval_count INTEGER NOT NULL DEFAULT 1,
      trial_days INTEGER NOT NULL DEFAULT 0,
      price_minor INTEGER NOT NULL,
      currency TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    )`,
    `CREATE INDEX crm_subscription_plans_product ON crm_subscription_plans (product_id)`,

    // --------------------------------------------------------- promo codes
    `CREATE TABLE crm_promo_codes (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      description TEXT,
      kind TEXT NOT NULL,
      percent_bps INTEGER,
      amount_minor INTEGER,
      currency TEXT,
      min_subtotal_minor INTEGER,
      product_ids TEXT,
      max_redemptions INTEGER,
      max_per_contact INTEGER,
      redemptions INTEGER NOT NULL DEFAULT 0,
      starts_at INTEGER,
      ends_at INTEGER,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    )`,
    `CREATE UNIQUE INDEX crm_promo_codes_code ON crm_promo_codes (code) WHERE deleted_at IS NULL`,
    `CREATE TABLE crm_promo_redemptions (
      id TEXT PRIMARY KEY,
      promo_code_id TEXT NOT NULL REFERENCES crm_promo_codes (id),
      order_id TEXT NOT NULL,
      contact_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE UNIQUE INDEX crm_promo_redemptions_order ON crm_promo_redemptions (promo_code_id, order_id)`,
    `CREATE INDEX crm_promo_redemptions_contact ON crm_promo_redemptions (promo_code_id, contact_id)`,

    // ------------------------------------------------------- subscriptions
    `CREATE TABLE crm_subscriptions (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL REFERENCES crm_contacts (id),
      product_id TEXT NOT NULL REFERENCES crm_products (id),
      plan_id TEXT NOT NULL REFERENCES crm_subscription_plans (id),
      status TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_price_minor INTEGER NOT NULL,
      currency TEXT NOT NULL,
      interval TEXT NOT NULL,
      interval_count INTEGER NOT NULL,
      tax_rate_bps INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL,
      trial_ends_at INTEGER,
      trial_converted_at INTEGER,
      current_period_start INTEGER,
      current_period_end INTEGER,
      next_bill_at INTEGER,
      -- Period boundaries are anchor + n intervals (no end-of-month drift).
      billing_anchor INTEGER NOT NULL,
      periods_billed INTEGER NOT NULL DEFAULT 0,
      cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
      cancel_reason TEXT,
      cancelled_at INTEGER,
      paused_at INTEGER,
      ended_at INTEGER,
      analytics_visitor_id TEXT,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX crm_subscriptions_contact ON crm_subscriptions (contact_id)`,
    `CREATE INDEX crm_subscriptions_due ON crm_subscriptions (status, next_bill_at)`,

    // -------------------------------------------------------------- orders
    `CREATE TABLE crm_orders (
      id TEXT PRIMARY KEY,
      number TEXT NOT NULL,
      contact_id TEXT NOT NULL REFERENCES crm_contacts (id),
      company_id TEXT REFERENCES crm_companies (id),
      owner_id TEXT,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      currency TEXT NOT NULL,
      subtotal_minor INTEGER NOT NULL,
      discount_minor INTEGER NOT NULL,
      tax_minor INTEGER NOT NULL,
      shipping_minor INTEGER NOT NULL,
      total_minor INTEGER NOT NULL,
      paid_minor INTEGER NOT NULL DEFAULT 0,
      refunded_minor INTEGER NOT NULL DEFAULT 0,
      promo_code_id TEXT REFERENCES crm_promo_codes (id),
      promo_code TEXT,
      notes TEXT,
      subscription_id TEXT REFERENCES crm_subscriptions (id),
      billing_period_start INTEGER,
      billing_period_end INTEGER,
      analytics_visitor_id TEXT,
      order_date INTEGER NOT NULL,
      due_at INTEGER,
      finalized_at INTEGER,
      paid_at INTEGER,
      cancelled_at INTEGER,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    )`,
    `CREATE UNIQUE INDEX crm_orders_number ON crm_orders (number)`,
    `CREATE INDEX crm_orders_contact ON crm_orders (contact_id)`,
    `CREATE INDEX crm_orders_status ON crm_orders (status)`,
    `CREATE INDEX crm_orders_date ON crm_orders (order_date)`,
    // One renewal order per subscription period (billing runs are replay-safe).
    `CREATE UNIQUE INDEX crm_orders_billing_period ON crm_orders (subscription_id, billing_period_start)
       WHERE subscription_id IS NOT NULL AND billing_period_start IS NOT NULL`,
    `CREATE TABLE crm_order_items (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES crm_orders (id),
      product_id TEXT REFERENCES crm_products (id),
      plan_id TEXT REFERENCES crm_subscription_plans (id),
      name TEXT NOT NULL,
      sku TEXT,
      description TEXT,
      quantity INTEGER NOT NULL,
      unit_price_minor INTEGER NOT NULL,
      subtotal_minor INTEGER NOT NULL,
      discount_minor INTEGER NOT NULL,
      tax_rate_bps INTEGER NOT NULL,
      tax_minor INTEGER NOT NULL,
      total_minor INTEGER NOT NULL,
      position INTEGER NOT NULL
    )`,
    `CREATE INDEX crm_order_items_order ON crm_order_items (order_id, position)`,
    `CREATE INDEX crm_order_items_product ON crm_order_items (product_id)`,

    // ---------------------------------------------------- payments & refunds
    `CREATE TABLE crm_payments (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES crm_orders (id),
      contact_id TEXT NOT NULL,
      status TEXT NOT NULL,
      method TEXT NOT NULL,
      amount_minor INTEGER NOT NULL,
      currency TEXT NOT NULL,
      refunded_minor INTEGER NOT NULL DEFAULT 0,
      transaction_id TEXT,
      failure_reason TEXT,
      notes TEXT,
      paid_at INTEGER NOT NULL,
      created_by TEXT,
      created_at INTEGER NOT NULL
    )`,
    `CREATE UNIQUE INDEX crm_payments_transaction ON crm_payments (transaction_id) WHERE transaction_id IS NOT NULL`,
    `CREATE INDEX crm_payments_order ON crm_payments (order_id)`,
    `CREATE INDEX crm_payments_paid_at ON crm_payments (paid_at)`,
    `CREATE TABLE crm_refunds (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES crm_orders (id),
      payment_id TEXT REFERENCES crm_payments (id),
      contact_id TEXT NOT NULL,
      amount_minor INTEGER NOT NULL,
      currency TEXT NOT NULL,
      reason TEXT,
      transaction_id TEXT,
      refunded_at INTEGER NOT NULL,
      created_by TEXT,
      created_at INTEGER NOT NULL
    )`,
    `CREATE UNIQUE INDEX crm_refunds_transaction ON crm_refunds (transaction_id) WHERE transaction_id IS NOT NULL`,
    `CREATE INDEX crm_refunds_order ON crm_refunds (order_id)`,

    // ------------------------------------------------------------ invoices
    `CREATE TABLE crm_invoices (
      id TEXT PRIMARY KEY,
      number TEXT NOT NULL,
      year INTEGER NOT NULL,
      sequence INTEGER NOT NULL,
      order_id TEXT NOT NULL REFERENCES crm_orders (id),
      contact_id TEXT NOT NULL,
      status TEXT NOT NULL,
      currency TEXT NOT NULL,
      total_minor INTEGER NOT NULL,
      issued_at INTEGER NOT NULL,
      due_at INTEGER,
      paid_at INTEGER,
      voided_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE UNIQUE INDEX crm_invoices_number ON crm_invoices (number)`,
    `CREATE UNIQUE INDEX crm_invoices_order ON crm_invoices (order_id)`,
    `CREATE INDEX crm_invoices_contact ON crm_invoices (contact_id)`,
  ],
};
