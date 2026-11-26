import type { Migration } from '../types';

/**
 * Per-checkout integrations (Meta Conversions API, TikTok Events API): a paid
 * checkout order is sent as a server-side Purchase to every enabled
 * connection, once (`checkout_deliveries` keeps one row per order and
 * connection). `crm_checkout_sessions.ad_meta` keeps the ad cookies, IP and
 * user agent of the buyer (JSON) for the platforms' matching.
 */
export const t0029CheckoutConnections: Migration = {
  id: 29,
  name: 'checkout_connections',
  statements: [
    `CREATE TABLE checkout_connections (
      id TEXT PRIMARY KEY,
      checkout_id TEXT NOT NULL REFERENCES crm_checkouts (id),
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      config TEXT NOT NULL DEFAULT '{}',
      secret_ciphertext TEXT,
      secret_hint TEXT,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    )`,
    `CREATE INDEX checkout_connections_checkout ON checkout_connections (checkout_id) WHERE deleted_at IS NULL`,

    `CREATE TABLE checkout_deliveries (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      connection_id TEXT NOT NULL REFERENCES checkout_connections (id),
      status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'skipped', 'retrying')),
      attempts INTEGER NOT NULL DEFAULT 0,
      status_code INTEGER,
      request TEXT,
      response TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (order_id, connection_id)
    )`,
    `CREATE INDEX checkout_deliveries_connection ON checkout_deliveries (connection_id, updated_at DESC)`,

    `ALTER TABLE crm_checkout_sessions ADD COLUMN ad_meta TEXT`,
  ],
};
