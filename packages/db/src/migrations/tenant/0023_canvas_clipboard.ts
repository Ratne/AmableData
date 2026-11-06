import type { Migration } from '../types';

/**
 * `canvas_clipboard`: personal clipboard of the page builder. Each "Copy" /
 * "Copy whole page" is one entry owned by the user who made it, shown in the
 * editor's clipboard tray on any page. Entries expire after 24h and at most 20
 * are kept per user (cleanup happens on every read/write).
 */
export const t0023CanvasClipboard: Migration = {
  id: 23,
  name: 'canvas_clipboard',
  statements: [
    `CREATE TABLE canvas_clipboard (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      label TEXT NOT NULL,
      whole_page INTEGER NOT NULL DEFAULT 0,
      source_page_name TEXT NOT NULL DEFAULT '',
      nodes TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX canvas_clipboard_user ON canvas_clipboard (user_id, created_at DESC)`,
  ],
};
