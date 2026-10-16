import type { Migration } from '../types';

/**
 * Installation-side state of the platform link (managed offering): assisted
 * access grants and support sessions, email usage meter reported to the
 * control plane in idempotent hourly blocks, and the local error outbox of the
 * fleet reporter. All tables stay empty on an open source installation without
 * a license. Quota snapshots and heartbeat state live in `installation_meta`
 * (`platform:*` keys).
 */
export const m0004Platform: Migration = {
  id: 4,
  name: 'platform',
  statements: [
    // Assisted access: granted by a tenant Owner/Admin, mirrored to the control plane.
    `CREATE TABLE platform_assist_grants (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      granted_by TEXT NOT NULL,
      reason TEXT NOT NULL,
      ticket_id TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER,
      revoked_by TEXT,
      mirrored_at INTEGER,
      first_entry_at INTEGER
    )`,
    `CREATE INDEX idx_platform_assist_grants_tenant ON platform_assist_grants(tenant_id, expires_at)`,
    // One row per accepted assisted-access token (jti is single use).
    `CREATE TABLE platform_assist_sessions (
      jti TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL REFERENCES platform_assist_grants(id) ON DELETE CASCADE,
      staff_id TEXT NOT NULL,
      staff_name TEXT NOT NULL,
      user_id TEXT NOT NULL,
      session_public_id TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      ended_at INTEGER
    )`,
    `CREATE INDEX idx_platform_assist_sessions_grant ON platform_assist_sessions(grant_id)`,
    // Email usage meter: one row per tenant, channel and UTC hour; closed hours are reported once.
    `CREATE TABLE platform_usage (
      tenant_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      hour_start INTEGER NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      reported_at INTEGER,
      PRIMARY KEY (tenant_id, channel, hour_start)
    )`,
    `CREATE INDEX idx_platform_usage_unreported ON platform_usage(reported_at, hour_start)`,
    // Error reporter outbox: batches retried with backoff until the control plane accepts them.
    `CREATE TABLE platform_error_outbox (
      id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      payload TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX idx_platform_error_outbox_due ON platform_error_outbox(next_attempt_at)`,
  ],
};
