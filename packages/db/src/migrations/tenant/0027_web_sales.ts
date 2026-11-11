import type { Migration } from '../types';

/**
 * Sales received by the server API (`POST /v1/sales`). The workspace is the
 * source of truth: each sale is recorded once (transaction id) with its
 * routing decision — the site whose DO gets the revenue, decided once and
 * re-read on every retry, never recomputed (`site_id` NULL = unattributed).
 * Refunds follow the stored decision. `dispatched_at` marks what the site DO
 * has applied; the dispatch itself is idempotent.
 */
export const t0027WebSales: Migration = {
  id: 27,
  name: 'web_sales',
  statements: [
    `CREATE TABLE crm_web_sales (
      transaction_id TEXT PRIMARY KEY,
      contact_id TEXT,
      site_id TEXT,
      visitor_id TEXT,
      decided_by TEXT NOT NULL,
      amount_minor INTEGER NOT NULL,
      currency TEXT NOT NULL,
      order_id TEXT,
      renewal INTEGER NOT NULL DEFAULT 0,
      refunded_minor INTEGER NOT NULL DEFAULT 0,
      occurred_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      dispatched_at INTEGER
    )`,
    `CREATE INDEX crm_web_sales_contact ON crm_web_sales (contact_id)`,
    `CREATE INDEX crm_web_sales_undispatched ON crm_web_sales (created_at)
       WHERE dispatched_at IS NULL AND site_id IS NOT NULL`,
    `CREATE TABLE crm_web_refunds (
      refund_id TEXT PRIMARY KEY,
      transaction_id TEXT NOT NULL,
      amount_minor INTEGER NOT NULL,
      occurred_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      dispatched_at INTEGER
    )`,
    `CREATE INDEX crm_web_refunds_sale ON crm_web_refunds (transaction_id)`,
    `CREATE INDEX crm_web_refunds_undispatched ON crm_web_refunds (created_at) WHERE dispatched_at IS NULL`,
  ],
};
