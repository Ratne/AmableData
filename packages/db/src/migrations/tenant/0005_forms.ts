import type { Migration } from '../types';

/**
 * Forms schema of the tenant DO: form definitions, encrypted submissions,
 * per-form external connections and their delivery log.
 *
 * Submission values are never stored in clear: `ciphertext` is AES-GCM
 * (SecretBox, associated data `form-submission:<tenantId>:<submissionId>`),
 * encrypted by the worker before the row reaches the DO. Connection secrets
 * (signing secrets, API keys) are encrypted the same way
 * (`form-connection:<tenantId>:<connectionId>`). Attribution facts stay in
 * clear for reporting. ULID ids, epoch-ms timestamps, soft delete.
 */
export const t0005Forms: Migration = {
  id: 5,
  name: 'forms',
  statements: [
    `CREATE TABLE form_forms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
      definition TEXT NOT NULL,
      submission_count INTEGER NOT NULL DEFAULT 0,
      last_submission_at INTEGER,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER,
      deleted_at INTEGER
    )`,
    `CREATE INDEX form_forms_updated ON form_forms (updated_at DESC, id DESC) WHERE deleted_at IS NULL`,

    `CREATE TABLE form_submissions (
      id TEXT PRIMARY KEY,
      form_id TEXT NOT NULL REFERENCES form_forms (id),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processed', 'failed')),
      ciphertext TEXT NOT NULL,
      contact_id TEXT,
      contact_created INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      warnings TEXT NOT NULL DEFAULT '[]',
      attempts INTEGER NOT NULL DEFAULT 0,
      visitor_id TEXT,
      utm_source TEXT,
      utm_medium TEXT,
      utm_campaign TEXT,
      utm_term TEXT,
      utm_content TEXT,
      referrer TEXT,
      page_url TEXT,
      page_id TEXT,
      country TEXT,
      created_at INTEGER NOT NULL,
      processed_at INTEGER,
      deleted_at INTEGER
    )`,
    `CREATE INDEX form_submissions_form ON form_submissions (form_id, created_at DESC, id DESC) WHERE deleted_at IS NULL`,
    `CREATE INDEX form_submissions_contact ON form_submissions (contact_id) WHERE contact_id IS NOT NULL`,
    `CREATE INDEX form_submissions_status ON form_submissions (status, created_at) WHERE deleted_at IS NULL`,

    `CREATE TABLE form_connections (
      id TEXT PRIMARY KEY,
      form_id TEXT NOT NULL REFERENCES form_forms (id),
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
    `CREATE INDEX form_connections_form ON form_connections (form_id) WHERE deleted_at IS NULL`,

    `CREATE TABLE form_deliveries (
      id TEXT PRIMARY KEY,
      submission_id TEXT NOT NULL REFERENCES form_submissions (id),
      connection_id TEXT NOT NULL REFERENCES form_connections (id),
      status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'skipped', 'retrying')),
      attempts INTEGER NOT NULL DEFAULT 0,
      status_code INTEGER,
      request TEXT,
      response TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (submission_id, connection_id)
    )`,
    `CREATE INDEX form_deliveries_connection ON form_deliveries (connection_id, updated_at DESC)`,
  ],
};
