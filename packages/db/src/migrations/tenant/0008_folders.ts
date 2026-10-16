import type { Migration } from '../types';

/**
 * Folders of the tenant DO's items (today landing pages, `kind = 'page'`;
 * automation folders live in the Engine DO next to the automations). A folder
 * name is unique per parent (case-insensitive); nesting depth and cycles are
 * enforced by the folder store. Additive: existing pages stay unfiled.
 */
export const t0008Folders: Migration = {
  id: 8,
  name: 'folders',
  statements: [
    `CREATE TABLE folders (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('automation', 'page')),
      parent_id TEXT,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE UNIQUE INDEX folders_name ON folders (kind, COALESCE(parent_id, ''), name COLLATE NOCASE)`,
    `CREATE INDEX folders_parent ON folders (kind, parent_id, position)`,
    `ALTER TABLE page_pages ADD COLUMN folder_id TEXT`,
    `CREATE INDEX page_pages_folder ON page_pages (folder_id) WHERE deleted_at IS NULL`,
  ],
};
