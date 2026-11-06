import type { Migration } from '../types';

/**
 * Short links served by the edge on dedicated domains (`domains.kind =
 * 'shortlink'` in the installation D1; `domain_id` is not a foreign key since
 * domains live in another database, links are removed by the domain cascade).
 *
 * - `short_link_folders`: flat folders; `short_link_folder_domains` binds a
 *   folder to zero or more domains (empty = any domain).
 * - `short_link_clicks_daily`: one row per link, UTC day and dimension tuple
 *   (exact series and breakdowns without raw click rows). Empty strings stand
 *   for unknown dimensions so the UNIQUE key works.
 *
 * No foreign keys (like every tenant table): the ops delete dependent rows.
 */
export const t0024Shortlinks: Migration = {
  id: 24,
  name: 'shortlinks',
  statements: [
    `CREATE TABLE short_link_folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE short_link_folder_domains (
      folder_id TEXT NOT NULL,
      domain_id TEXT NOT NULL,
      PRIMARY KEY (folder_id, domain_id)
    )`,
    `CREATE INDEX short_link_folder_domains_domain ON short_link_folder_domains (domain_id)`,
    `CREATE TABLE short_links (
      id TEXT PRIMARY KEY,
      domain_id TEXT NOT NULL,
      folder_id TEXT,
      key TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT,
      utm_source TEXT,
      utm_medium TEXT,
      utm_campaign TEXT,
      utm_term TEXT,
      utm_content TEXT,
      pass_query INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER,
      expired_url TEXT,
      og_title TEXT,
      og_description TEXT,
      og_image TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      clicks INTEGER NOT NULL DEFAULT 0,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (domain_id, key)
    )`,
    `CREATE INDEX short_links_folder ON short_links (folder_id)`,
    `CREATE INDEX short_links_created ON short_links (created_at DESC)`,
    `CREATE TABLE short_link_clicks_daily (
      link_id TEXT NOT NULL,
      day TEXT NOT NULL,
      country TEXT NOT NULL DEFAULT '',
      referrer_host TEXT NOT NULL DEFAULT '',
      device TEXT NOT NULL DEFAULT '',
      browser TEXT NOT NULL DEFAULT '',
      os TEXT NOT NULL DEFAULT '',
      bot INTEGER NOT NULL DEFAULT 0,
      clicks INTEGER NOT NULL DEFAULT 0,
      UNIQUE (link_id, day, country, referrer_host, device, browser, os, bot)
    )`,
    `CREATE INDEX short_link_clicks_daily_link_day ON short_link_clicks_daily (link_id, day)`,
  ],
};
