import type { Migration } from '../types';

/**
 * Marketplace apps (apps/core/src/apps):
 * - `app_catalog`: verified entries of the signed catalog index (synced every 6 hours);
 * - `app_installs`: one row per (tenant, app) with the accepted manifest snapshot,
 *   granted / pending scopes and lifecycle state;
 * - `app_oauth_codes`, `app_tokens`, `app_assertions`: the installation's OAuth
 *   server (codes and tokens stored as hashes, client assertion replay guard);
 * - `app_events`: log of what was sent to each app, `seq` gives the replay order;
 * - `app_hook_cache`, `app_metrics`: validation results and per-hour health counters.
 * App webhook endpoints reuse `webhook_endpoints` (`app_install_id` set).
 */
export const m0007Apps: Migration = {
  id: 7,
  name: 'apps',
  statements: [
    `CREATE TABLE app_catalog (
      app_id TEXT PRIMARY KEY,
      manifest TEXT NOT NULL,
      manifest_hash TEXT NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      revoked_reason TEXT,
      added_at TEXT,
      synced_at INTEGER NOT NULL
    )`,
    `CREATE TABLE app_installs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      app_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'catalog',
      manifest_url TEXT,
      manifest TEXT NOT NULL,
      manifest_hash TEXT NOT NULL,
      api_version TEXT NOT NULL,
      scopes TEXT NOT NULL DEFAULT '[]',
      pending_scopes TEXT,
      pending_manifest TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      status_reason TEXT,
      installed_by TEXT,
      webhook_secret TEXT,
      webhook_secret_prev TEXT,
      webhook_secret_prev_until INTEGER,
      webhook_endpoint_id TEXT,
      hook_failures INTEGER NOT NULL DEFAULT 0,
      hook_open_until INTEGER,
      keep_data INTEGER,
      cleanup_until INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      activated_at INTEGER,
      uninstalled_at INTEGER
    )`,
    `CREATE UNIQUE INDEX idx_app_installs_tenant_app ON app_installs(tenant_id, app_id)`,
    `CREATE INDEX idx_app_installs_app ON app_installs(app_id, status)`,
    `CREATE INDEX idx_app_installs_status ON app_installs(status, cleanup_until)`,
    `CREATE TABLE app_oauth_codes (
      code_hash TEXT PRIMARY KEY,
      install_id TEXT NOT NULL REFERENCES app_installs(id) ON DELETE CASCADE,
      redirect_uri TEXT NOT NULL,
      code_challenge TEXT,
      user_id TEXT,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    )`,
    `CREATE TABLE app_tokens (
      id TEXT PRIMARY KEY,
      install_id TEXT NOT NULL REFERENCES app_installs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    )`,
    `CREATE INDEX idx_app_tokens_install ON app_tokens(install_id, kind)`,
    `CREATE TABLE app_assertions (
      jti TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    )`,
    `CREATE TABLE app_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      install_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE UNIQUE INDEX idx_app_events_install_event ON app_events(install_id, event_id)`,
    `CREATE INDEX idx_app_events_install_seq ON app_events(install_id, seq)`,
    `CREATE TABLE app_hook_cache (
      install_id TEXT NOT NULL,
      value_hash TEXT NOT NULL,
      result TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (install_id, value_hash)
    )`,
    `CREATE TABLE app_metrics (
      install_id TEXT NOT NULL,
      hour INTEGER NOT NULL,
      kind TEXT NOT NULL,
      calls INTEGER NOT NULL DEFAULT 0,
      errors INTEGER NOT NULL DEFAULT 0,
      total_ms INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (install_id, hour, kind)
    )`,
    `ALTER TABLE webhook_endpoints ADD COLUMN app_install_id TEXT`,
    `CREATE INDEX idx_webhook_endpoints_app ON webhook_endpoints(app_install_id)`,
    `ALTER TABLE audit_log ADD COLUMN actor_app_id TEXT`,
  ],
};
