import type { Migration } from '@amable/db';

/**
 * Schema of the MailDb DO SQLite storage (one per tenant, separate from the
 * TenantDb). Applied at first access by the MailDb constructor with the
 * packages/db runner. Never edit a shipped migration: append a new one.
 *
 * Conventions: ids are ULIDs, timestamps epoch ms, JSON in TEXT, emails
 * normalized (trimmed, lowercase).
 */
export const mailMigrations: readonly Migration[] = [
  {
    id: 1,
    name: 'mail_core',
    statements: [
      `CREATE TABLE mail_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,

      `CREATE TABLE mail_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        subject TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL,
        from_name TEXT,
        reply_to TEXT,
        body_hash TEXT NOT NULL,
        compiled_hash TEXT,
        compiled_html TEXT,
        compiled_text TEXT,
        compiled_subject TEXT,
        compiled_preheader TEXT,
        created_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      )`,
      `CREATE INDEX mail_templates_live ON mail_templates (updated_at DESC, id) WHERE deleted_at IS NULL`,

      `CREATE TABLE mail_snippets (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,

      // One row per EmailSendRequest (request_id = idempotency key per message+recipient).
      `CREATE TABLE mail_messages (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        contact_id TEXT NOT NULL,
        email TEXT,
        subject TEXT,
        status TEXT NOT NULL,
        status_reason TEXT,
        source_type TEXT NOT NULL,
        source TEXT,
        broadcast_id TEXT,
        provider_message_id TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        lease_until INTEGER,
        open_count INTEGER NOT NULL DEFAULT 0,
        click_count INTEGER NOT NULL DEFAULT 0,
        sent_at INTEGER,
        delivered_at INTEGER,
        opened_at INTEGER,
        clicked_at INTEGER,
        bounced_at INTEGER,
        complained_at INTEGER,
        unsubscribed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX mail_messages_contact ON mail_messages (contact_id, created_at DESC)`,
      `CREATE INDEX mail_messages_broadcast ON mail_messages (broadcast_id, status) WHERE broadcast_id IS NOT NULL`,
      `CREATE INDEX mail_messages_provider ON mail_messages (provider_message_id) WHERE provider_message_id IS NOT NULL`,
      `CREATE INDEX mail_messages_sent ON mail_messages (sent_at) WHERE sent_at IS NOT NULL`,

      // Links of a message, in body order (per-link stats).
      `CREATE TABLE mail_message_links (
        message_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        url TEXT NOT NULL,
        PRIMARY KEY (message_id, position)
      )`,
      `CREATE TABLE mail_clicks (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        url TEXT NOT NULL,
        broadcast_id TEXT,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX mail_clicks_broadcast ON mail_clicks (broadcast_id, url) WHERE broadcast_id IS NOT NULL`,
      `CREATE INDEX mail_clicks_message ON mail_clicks (message_id)`,

      `CREATE TABLE mail_suppressions (
        email TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        source TEXT,
        contact_id TEXT,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX mail_suppressions_created ON mail_suppressions (created_at DESC, email)`,

      `CREATE TABLE mail_outbox (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT,
        occurred_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        acked_at INTEGER
      )`,
      `CREATE INDEX mail_outbox_pending ON mail_outbox (id) WHERE acked_at IS NULL`,

      // Per-day send counters (warm-up cap) and per-minute window (rate limit).
      `CREATE TABLE mail_counters (
        bucket TEXT PRIMARY KEY,
        count INTEGER NOT NULL
      )`,

      // Webhook replay protection (signature ids and provider event ids).
      `CREATE TABLE mail_webhook_seen (
        id TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      )`,

      `CREATE TABLE mail_broadcasts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        segment TEXT,
        template_id TEXT,
        subject TEXT NOT NULL DEFAULT '',
        body TEXT,
        from_name TEXT,
        reply_to TEXT,
        throttle_per_hour INTEGER,
        schedule TEXT,
        next_send_at INTEGER,
        created_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        deleted_at INTEGER
      )`,
      `CREATE INDEX mail_broadcasts_live ON mail_broadcasts (created_at DESC, id) WHERE deleted_at IS NULL`,
      `CREATE TABLE mail_broadcast_recipients (
        broadcast_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        time_zone TEXT NOT NULL,
        send_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        request_id TEXT NOT NULL,
        PRIMARY KEY (broadcast_id, contact_id)
      )`,
      `CREATE INDEX mail_broadcast_recipients_due ON mail_broadcast_recipients (broadcast_id, status, send_at)`,
    ],
  },
  {
    id: 2,
    name: 'mail_archive',
    statements: [
      // Objects of messages and clicks moved to R2 past the retention window
      // (same shape as the TenantDb catalog; partition = broadcast id or "tx").
      `CREATE TABLE archive_catalog (
        stream TEXT NOT NULL,
        month TEXT NOT NULL,
        partition TEXT NOT NULL,
        part INTEGER NOT NULL,
        object_key TEXT NOT NULL,
        rows INTEGER NOT NULL,
        bytes INTEGER NOT NULL,
        last_cursor TEXT,
        final INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (stream, month, partition, part)
      )`,
      `CREATE INDEX archive_catalog_partition ON archive_catalog (stream, partition, month)`,
      // Totals of a broadcast frozen before its first message or click leaves
      // the database: lists, stats and reports read them from then on.
      `CREATE TABLE mail_broadcast_stats (
        broadcast_id TEXT PRIMARY KEY,
        recipients INTEGER NOT NULL,
        total INTEGER NOT NULL,
        sent INTEGER NOT NULL,
        delivered INTEGER NOT NULL,
        opened INTEGER NOT NULL,
        clicked INTEGER NOT NULL,
        bounced INTEGER NOT NULL,
        complained INTEGER NOT NULL,
        unsubscribed INTEGER NOT NULL,
        failed INTEGER NOT NULL,
        skipped INTEGER NOT NULL,
        progress TEXT NOT NULL,
        links TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX mail_messages_created ON mail_messages (created_at)`,
      `CREATE INDEX mail_clicks_created ON mail_clicks (created_at)`,
    ],
  },
];
