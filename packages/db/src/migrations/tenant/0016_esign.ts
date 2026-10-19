import type { Migration } from '../types';

/**
 * Electronic signatures schema of the tenant DO.
 *
 * - `esign_templates`: a source PDF (R2, versioned keys so requests keep the
 *   exact bytes they were sent with), one image per page for the signing view,
 *   the parties (roles) and the fields placed on the pages, with coordinates
 *   normalized to 0..1 of the page.
 * - `esign_requests`: one document sent for signature; parties, fields, pages
 *   and settings are snapshotted at send time, with the SHA-256 of the source.
 * - `esign_signers`: one row per party of a request (CRM contact + the email
 *   it was sent to). Signing links are HMAC-derived tokens: only their SHA-256
 *   is stored, `token_nonce` lets the link be rotated. OTP codes are stored as
 *   HMAC hashes only. The `*_due_at` / `next_reminder_at` columns are the
 *   timers run by the TenantDb alarm.
 * - `esign_events`: append-only audit trail (who, when, IP, user agent,
 *   browser facts) used to build the signature certificate.
 *
 * ULID ids, epoch-ms timestamps, JSON in TEXT, soft delete on templates.
 */
export const t0016Esign: Migration = {
  id: 16,
  name: 'esign',
  statements: [
    `CREATE TABLE esign_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
      source_r2_key TEXT,
      source_filename TEXT,
      source_size INTEGER,
      source_sha256 TEXT,
      pages TEXT NOT NULL DEFAULT '[]',
      parties TEXT NOT NULL DEFAULT '[]',
      signing_order TEXT NOT NULL DEFAULT 'parallel' CHECK (signing_order IN ('parallel', 'sequential')),
      fields TEXT NOT NULL DEFAULT '[]',
      settings TEXT NOT NULL DEFAULT '{}',
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    )`,
    `CREATE INDEX esign_templates_status ON esign_templates (status, updated_at) WHERE deleted_at IS NULL`,

    `CREATE TABLE esign_requests (
      id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL REFERENCES esign_templates (id),
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'sent'
        CHECK (status IN ('sent', 'partially_signed', 'completed', 'declined', 'voided', 'expired')),
      signing_order TEXT NOT NULL CHECK (signing_order IN ('parallel', 'sequential')),
      parties TEXT NOT NULL,
      fields TEXT NOT NULL,
      pages TEXT NOT NULL,
      settings TEXT NOT NULL,
      source_r2_key TEXT NOT NULL,
      source_sha256 TEXT NOT NULL,
      completed_r2_key TEXT,
      completed_sha256 TEXT,
      finalize_due_at INTEGER,
      finalize_attempts INTEGER NOT NULL DEFAULT 0,
      finalize_error TEXT,
      origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'api', 'automation')),
      origin_ref TEXT,
      message TEXT NOT NULL DEFAULT '',
      locale TEXT NOT NULL DEFAULT 'en',
      created_by TEXT,
      expires_at INTEGER,
      completed_at INTEGER,
      declined_at INTEGER,
      voided_at INTEGER,
      void_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX esign_requests_status ON esign_requests (status, created_at)`,
    `CREATE INDEX esign_requests_template ON esign_requests (template_id, created_at)`,
    `CREATE UNIQUE INDEX esign_requests_origin ON esign_requests (origin_ref) WHERE origin_ref IS NOT NULL`,
    `CREATE INDEX esign_requests_expiry ON esign_requests (expires_at) WHERE status IN ('sent', 'partially_signed')`,
    `CREATE INDEX esign_requests_finalize ON esign_requests (finalize_due_at) WHERE finalize_due_at IS NOT NULL`,

    `CREATE TABLE esign_signers (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES esign_requests (id),
      party_id TEXT NOT NULL,
      party_name TEXT NOT NULL,
      position INTEGER NOT NULL,
      contact_id TEXT,
      email TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sent', 'opened', 'completed', 'declined')),
      token_nonce TEXT NOT NULL,
      token_hash TEXT,
      field_values TEXT NOT NULL DEFAULT '{}',
      otp_hash TEXT,
      otp_expires_at INTEGER,
      otp_attempts INTEGER NOT NULL DEFAULT 0,
      otp_sends TEXT NOT NULL DEFAULT '[]',
      otp_verified_at INTEGER,
      consent_at INTEGER,
      notify_due_at INTEGER,
      next_reminder_at INTEGER,
      reminders_sent INTEGER NOT NULL DEFAULT 0,
      sent_at INTEGER,
      opened_at INTEGER,
      completed_at INTEGER,
      declined_at INTEGER,
      decline_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX esign_signers_request ON esign_signers (request_id, position)`,
    `CREATE UNIQUE INDEX esign_signers_token ON esign_signers (token_hash) WHERE token_hash IS NOT NULL`,
    `CREATE INDEX esign_signers_contact ON esign_signers (contact_id)`,
    `CREATE INDEX esign_signers_notify ON esign_signers (notify_due_at) WHERE notify_due_at IS NOT NULL`,
    `CREATE INDEX esign_signers_reminder ON esign_signers (next_reminder_at) WHERE next_reminder_at IS NOT NULL`,

    `CREATE TABLE esign_events (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES esign_requests (id),
      signer_id TEXT,
      type TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      ip TEXT,
      user_agent TEXT,
      country TEXT,
      meta TEXT NOT NULL DEFAULT '{}',
      occurred_at INTEGER NOT NULL
    )`,
    `CREATE INDEX esign_events_request ON esign_events (request_id, id)`,
  ],
};
