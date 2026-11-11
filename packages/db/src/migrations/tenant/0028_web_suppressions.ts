import type { Migration } from '../types';

/**
 * Web tracking suppressions of the workspace (opt-out and erasure requests):
 * visitor ids and hashed identities pushed to every site DO, and to sites
 * created later. Values are visitor ids or SHA-256 hex, never clear data.
 */
export const t0028WebSuppressions: Migration = {
  id: 28,
  name: 'web_suppressions',
  statements: [
    `CREATE TABLE crm_web_suppressions (
      kind TEXT NOT NULL,
      value TEXT NOT NULL,
      purge INTEGER NOT NULL,
      reason TEXT,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (kind, value)
    )`,
    `CREATE INDEX crm_web_suppressions_created ON crm_web_suppressions (created_at)`,
  ],
};
