import type { Migration } from '../types';

/** Lookup indexes for the hot paths: session resolution, membership checks, audit queries. */
export const m0002Indexes: Migration = {
  id: 2,
  name: 'indexes',
  statements: [
    `CREATE INDEX idx_sessions_user ON sessions(user_id)`,
    `CREATE INDEX idx_sessions_expires ON sessions(expires_at)`,
    `CREATE INDEX idx_memberships_tenant ON memberships(tenant_id)`,
    `CREATE INDEX idx_domains_tenant ON domains(tenant_id)`,
    `CREATE INDEX idx_api_keys_tenant ON api_keys(tenant_id)`,
    `CREATE INDEX idx_audit_log_tenant_created ON audit_log(tenant_id, created_at)`,
  ],
};
