import type { Migration } from '@amable/db';

/**
 * Schema of the Engine DO SQLite storage (one per tenant, separate from the
 * TenantDb). Applied at first access by the Engine constructor, like the
 * tenant migrations. Never edit a shipped migration: append a new one.
 *
 * Conventions: ids are ULIDs, timestamps epoch ms, JSON in TEXT.
 */
export const engineMigrations: readonly Migration[] = [
  {
    id: 1,
    name: 'automation_engine',
    statements: [
      `CREATE TABLE engine_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,

      // Automation + its editable draft. Published versions are immutable copies.
      `CREATE TABLE eng_automations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        settings TEXT NOT NULL DEFAULT '{}',
        draft_graph TEXT NOT NULL,
        draft_revision INTEGER NOT NULL DEFAULT 1,
        published_version_id TEXT,
        signing_secret TEXT NOT NULL,
        created_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      )`,
      `CREATE INDEX eng_automations_status ON eng_automations (status, id) WHERE deleted_at IS NULL`,
      `CREATE TABLE eng_versions (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL REFERENCES eng_automations (id),
        number INTEGER NOT NULL,
        graph TEXT NOT NULL,
        settings TEXT NOT NULL,
        published_by TEXT,
        published_at INTEGER NOT NULL,
        UNIQUE (automation_id, number)
      )`,

      // One enrollment per contact run through an automation, pinned to a version.
      `CREATE TABLE eng_enrollments (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL,
        version_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        entry_node_id TEXT,
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        ended_at INTEGER
      )`,
      `CREATE UNIQUE INDEX eng_enrollments_active ON eng_enrollments (automation_id, contact_id) WHERE status = 'active'`,
      `CREATE INDEX eng_enrollments_contact ON eng_enrollments (contact_id, status)`,
      `CREATE INDEX eng_enrollments_list ON eng_enrollments (automation_id, status, id)`,
      // Goals achieved within an enrollment (a goal counts once per enrollment).
      `CREATE TABLE eng_goal_hits (
        enrollment_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (enrollment_id, node_id)
      ) WITHOUT ROWID`,

      // Positions ("tokens") of an enrollment in the graph; parallel branches = several tokens.
      `CREATE TABLE eng_tokens (
        id TEXT PRIMARY KEY,
        enrollment_id TEXT NOT NULL,
        automation_id TEXT NOT NULL,
        version_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        step_index INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        step_state TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX eng_tokens_enrollment ON eng_tokens (enrollment_id, status)`,
      `CREATE INDEX eng_tokens_node ON eng_tokens (automation_id, node_id, status)`,

      // Scheduler: the job table is the priority queue, ordered by due_at; the
      // DO alarm always points at its minimum.
      `CREATE TABLE eng_jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        ref TEXT NOT NULL DEFAULT '',
        due_at INTEGER NOT NULL,
        UNIQUE (kind, ref)
      )`,
      `CREATE INDEX eng_jobs_due ON eng_jobs (due_at, id)`,

      // Completed side effects, keyed by token + step (idempotent re-execution).
      `CREATE TABLE eng_step_runs (
        key TEXT PRIMARY KEY,
        result TEXT,
        at INTEGER NOT NULL
      ) WITHOUT ROWID`,

      // Dedupe of inbound events (outbox + pushed events), pruned after 7 days.
      `CREATE TABLE eng_processed_events (
        event_id TEXT PRIMARY KEY,
        processed_at INTEGER NOT NULL
      ) WITHOUT ROWID`,
      `CREATE INDEX eng_processed_events_at ON eng_processed_events (processed_at)`,

      // Reporting counters per node ('' step) and per sequence step.
      `CREATE TABLE eng_node_stats (
        automation_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        step_id TEXT NOT NULL DEFAULT '',
        entered INTEGER NOT NULL DEFAULT 0,
        completed INTEGER NOT NULL DEFAULT 0,
        errors INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (automation_id, node_id, step_id)
      ) WITHOUT ROWID`,

      // Execution log per enrollment.
      `CREATE TABLE eng_logs (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL,
        enrollment_id TEXT,
        contact_id TEXT,
        node_id TEXT,
        step_id TEXT,
        kind TEXT NOT NULL,
        message TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        at INTEGER NOT NULL
      )`,
      `CREATE INDEX eng_logs_enrollment ON eng_logs (enrollment_id, id)`,
    ],
  },
  {
    id: 2,
    name: 'engine_log_retention',
    statements: [`CREATE INDEX eng_logs_at ON eng_logs (at)`],
  },
  {
    // Folders of automations (generic folder model, see apps/core/src/folders/store.ts).
    // Additive: existing automations stay unfiled (folder_id NULL).
    id: 3,
    name: 'automation_folders',
    statements: [
      `CREATE TABLE eng_folders (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('automation', 'page')),
        parent_id TEXT,
        name TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE UNIQUE INDEX eng_folders_name ON eng_folders (kind, COALESCE(parent_id, ''), name COLLATE NOCASE)`,
      `CREATE INDEX eng_folders_parent ON eng_folders (kind, parent_id, position)`,
      `ALTER TABLE eng_automations ADD COLUMN folder_id TEXT`,
      `CREATE INDEX eng_automations_folder ON eng_automations (folder_id) WHERE deleted_at IS NULL`,
    ],
  },
];
