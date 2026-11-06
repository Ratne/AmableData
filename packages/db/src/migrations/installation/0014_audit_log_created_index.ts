import type { Migration } from '../types';

/** The hourly retention prunes `audit_log` by `created_at`; without this index each run scanned it all. */
export const m0014AuditLogCreatedIndex: Migration = {
  id: 14,
  name: 'audit_log_created_index',
  statements: [`CREATE INDEX idx_audit_log_created ON audit_log(created_at)`],
};
