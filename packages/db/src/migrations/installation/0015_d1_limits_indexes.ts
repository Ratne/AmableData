import type { Migration } from '../types';

/**
 * Indexes for scans that ran on every cron tick or backup page: the expiry
 * prunes of `app_hook_cache` (every 5 minutes) and of the auth rows (hourly),
 * and `audit_log` by tenant in rowid order (tenant backups page on rowid).
 */
export const m0015D1LimitsIndexes: Migration = {
  id: 15,
  name: 'd1_limits_indexes',
  statements: [
    `CREATE INDEX IF NOT EXISTS idx_app_hook_cache_expires ON app_hook_cache(expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_auth_challenges_expires ON auth_challenges(expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_auth_tokens_expires ON auth_tokens(expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_log_tenant ON audit_log(tenant_id)`,
  ],
};
