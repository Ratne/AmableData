import type { Migration } from '../types';

/**
 * Landing pages schema of the tenant DO: pages with their draft builder
 * document, immutable published versions, reusable saved sections and the
 * media library (files live in R2 under `media_files.r2_key`).
 *
 * A page path is unique per host among non-deleted pages (`host` '' in the
 * index stands for "no host": the `/p/<slug>/…` URLs). ULID ids, epoch-ms
 * timestamps, JSON in TEXT, soft delete.
 */
export const t0007Pages: Migration = {
  id: 7,
  name: 'pages',
  statements: [
    `CREATE TABLE page_pages (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      path TEXT NOT NULL,
      host TEXT,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
      draft TEXT NOT NULL,
      draft_revision INTEGER NOT NULL DEFAULT 0,
      published_version_id TEXT,
      published_at INTEGER,
      seo TEXT NOT NULL DEFAULT '{}',
      settings TEXT NOT NULL DEFAULT '{}',
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    )`,
    `CREATE UNIQUE INDEX page_pages_route ON page_pages (COALESCE(host, ''), path) WHERE deleted_at IS NULL`,
    `CREATE INDEX page_pages_updated ON page_pages (updated_at DESC, id DESC)`,

    `CREATE TABLE page_versions (
      id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL REFERENCES page_pages (id),
      version INTEGER NOT NULL,
      document TEXT NOT NULL,
      title TEXT NOT NULL,
      seo TEXT NOT NULL DEFAULT '{}',
      settings TEXT NOT NULL DEFAULT '{}',
      note TEXT,
      published_at INTEGER NOT NULL,
      published_by TEXT
    )`,
    `CREATE UNIQUE INDEX page_versions_number ON page_versions (page_id, version)`,

    `CREATE TABLE saved_sections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT,
      node TEXT NOT NULL,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    )`,
    `CREATE INDEX saved_sections_updated ON saved_sections (updated_at DESC, id DESC) WHERE deleted_at IS NULL`,

    `CREATE TABLE media_files (
      id TEXT PRIMARY KEY,
      r2_key TEXT NOT NULL,
      file TEXT NOT NULL UNIQUE,
      filename TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      sha256 TEXT,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      deleted_at INTEGER
    )`,
    `CREATE INDEX media_files_created ON media_files (created_at DESC, id DESC) WHERE deleted_at IS NULL`,
  ],
};
