import type { Migration } from '../types';

/**
 * Outgoing webhooks (endpoints + delivery log with retries and replay) and the
 * domain wizard state on `domains`: DNS records to create, Cloudflare zone,
 * landing paths routed to the edge worker, last verification result.
 */
export const m0005Developers: Migration = {
  id: 5,
  name: 'developers',
  statements: [
    `CREATE TABLE webhook_endpoints (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      event_types TEXT NOT NULL DEFAULT '[]',
      secret TEXT NOT NULL,
      secret_hint TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      disabled_reason TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_success_at INTEGER,
      last_failure_at INTEGER
    )`,
    `CREATE INDEX idx_webhook_endpoints_tenant ON webhook_endpoints(tenant_id, status)`,
    `CREATE TABLE webhook_deliveries (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
      event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER,
      last_status INTEGER,
      last_error TEXT,
      last_response TEXT,
      duration_ms INTEGER,
      replay_of TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    )`,
    `CREATE UNIQUE INDEX idx_webhook_deliveries_event ON webhook_deliveries(endpoint_id, event_id) WHERE replay_of IS NULL`,
    `CREATE INDEX idx_webhook_deliveries_endpoint ON webhook_deliveries(endpoint_id, created_at)`,
    `CREATE INDEX idx_webhook_deliveries_created ON webhook_deliveries(created_at)`,
    `ALTER TABLE domains ADD COLUMN records TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE domains ADD COLUMN zone_id TEXT`,
    `ALTER TABLE domains ADD COLUMN paths TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE domains ADD COLUMN dns_applied_at INTEGER`,
    `ALTER TABLE domains ADD COLUMN verified_at INTEGER`,
    `ALTER TABLE domains ADD COLUMN checked_at INTEGER`,
    `ALTER TABLE domains ADD COLUMN last_error TEXT`,
  ],
};
