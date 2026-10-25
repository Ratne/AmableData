import type { Migration } from '../types';

/**
 * Event archive: rows past the retention window (timeline activities, form
 * submissions, signature audit events) move to R2 as gzip JSONL objects and
 * leave the TenantDb. `archive_catalog` lists every object written, so the app
 * reads them back (timeline, submissions, signature log) without listing R2.
 * One row per object: a partition of a month (`crm_activities`: contact bucket,
 * company or opportunity; `form_submissions`: the form; `esign_events`: the
 * request) split in parts of bounded size; `final` marks the last part.
 *
 * Indexes on the age columns let the retention job find the oldest month and
 * page through it without scanning the whole table.
 */
export const t0018Archive: Migration = {
  id: 18,
  name: 'archive',
  statements: [
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
    `CREATE INDEX crm_activities_occurred ON crm_activities (occurred_at)`,
    `CREATE INDEX form_submissions_created ON form_submissions (created_at)`,
  ],
};
