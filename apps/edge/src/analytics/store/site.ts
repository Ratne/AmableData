import {
  ATTRIBUTION_MODELS,
  type AttributionModel,
  type Site,
  type UpdateSiteInput,
} from '@amable/api-types';
import { randomSalt, saltDay, SALT_RETENTION_DAYS } from '../cookieless';
import type { EdgeSiteConfig } from '../enrich';
import { first, type SqlDb } from '../db/sql';
import { DAY_MS } from '../time';

interface SiteRow {
  site_id: string;
  tenant_id: string;
  name: string;
  hostnames: string;
  cookieless: number;
  allow_localhost: number;
  timezone: string;
  currency: string;
  retention_days: number;
  attribution_model: string;
  secret_hash: string | null;
  last_event_at: number | null;
  last_event_url: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

/** Site configuration as stored in its own AnalyticsDO. */
export interface SiteRecord {
  site: Site;
  tenantId: string;
  secretHash: string | null;
  deleted: boolean;
  lastEventAt: number | null;
  lastEventUrl: string | null;
}

export interface SiteInit {
  siteId: string;
  tenantId: string;
  name: string;
  hostnames: string[];
  cookieless: boolean;
  allowLocalhost: boolean;
  timezone: string;
  currency: string;
  retentionDays: number;
  attributionModel?: AttributionModel;
  secretHash: string | null;
}

function toRecord(row: SiteRow): SiteRecord {
  return {
    site: {
      id: row.site_id,
      name: row.name,
      hostnames: JSON.parse(row.hostnames) as string[],
      cookieless: row.cookieless === 1,
      allow_localhost: row.allow_localhost === 1,
      timezone: row.timezone,
      currency: row.currency,
      retention_days: row.retention_days,
      attribution_model: toModel(row.attribution_model),
      has_secret: row.secret_hash !== null,
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
    },
    tenantId: row.tenant_id,
    secretHash: row.secret_hash,
    deleted: row.deleted_at !== null,
    lastEventAt: row.last_event_at,
    lastEventUrl: row.last_event_url,
  };
}

function toModel(value: string): AttributionModel {
  return (ATTRIBUTION_MODELS as readonly string[]).includes(value)
    ? (value as AttributionModel)
    : 'last_non_direct';
}

export function getSiteRecord(db: SqlDb): SiteRecord | null {
  const row = first<SiteRow>(db, `SELECT * FROM site_config WHERE id = 1`);
  return row === undefined ? null : toRecord(row);
}

/** Creates the site row (first call) — a second call with another tenant is refused. */
export function initSite(db: SqlDb, init: SiteInit, now: number): SiteRecord {
  const existing = getSiteRecord(db);
  if (existing !== null) {
    if (existing.tenantId !== init.tenantId || existing.site.id !== init.siteId) {
      throw new Error('site id already in use');
    }
    return existing;
  }
  db.run(
    `INSERT INTO site_config (id, site_id, tenant_id, name, hostnames, cookieless, allow_localhost,
       timezone, currency, retention_days, attribution_model, secret_hash, created_at, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    init.siteId,
    init.tenantId,
    init.name,
    JSON.stringify(init.hostnames),
    init.cookieless ? 1 : 0,
    init.allowLocalhost ? 1 : 0,
    init.timezone,
    init.currency,
    init.retentionDays,
    init.attributionModel ?? 'last_non_direct',
    init.secretHash,
    now,
    now,
  );
  return getSiteRecord(db) as SiteRecord;
}

export function updateSite(db: SqlDb, patch: UpdateSiteInput, now: number): SiteRecord | null {
  const current = getSiteRecord(db);
  if (current === null || current.deleted) return null;
  const s = current.site;
  db.run(
    `UPDATE site_config SET name = ?, hostnames = ?, cookieless = ?, allow_localhost = ?, timezone = ?,
       currency = ?, retention_days = ?, attribution_model = ?, updated_at = ? WHERE id = 1`,
    patch.name ?? s.name,
    JSON.stringify(patch.hostnames ?? s.hostnames),
    (patch.cookieless ?? s.cookieless) ? 1 : 0,
    (patch.allow_localhost ?? s.allow_localhost) ? 1 : 0,
    patch.timezone ?? s.timezone,
    patch.currency ?? s.currency,
    patch.retention_days ?? s.retention_days,
    patch.attribution_model ?? s.attribution_model,
    now,
  );
  if (patch.timezone !== undefined && patch.timezone !== s.timezone) {
    // Daily rollups are keyed by local day: rebuild the days still covered by raw data.
    db.run(
      `INSERT OR IGNORE INTO rollup_dirty (grain, key)
       SELECT 'hour', CAST((started_at / 3600000) * 3600000 AS TEXT) FROM sessions GROUP BY started_at / 3600000`,
    );
  }
  return getSiteRecord(db);
}

export function setSecretHash(db: SqlDb, hash: string, now: number): boolean {
  const current = getSiteRecord(db);
  if (current === null || current.deleted) return false;
  db.run(`UPDATE site_config SET secret_hash = ?, updated_at = ? WHERE id = 1`, hash, now);
  return true;
}

/** Soft delete: ingest stops immediately; data is kept until the retention job. */
export function deleteSite(db: SqlDb, now: number): boolean {
  const current = getSiteRecord(db);
  if (current === null || current.deleted) return false;
  db.run(`UPDATE site_config SET deleted_at = ?, updated_at = ? WHERE id = 1`, now, now);
  return true;
}

/** Today's cookieless salt (UTC day), created on demand; salts older than 2 days are destroyed. */
export function todaySalt(db: SqlDb, now: number): { day: string; value: string } {
  const day = saltDay(now);
  const row = first<{ salt: string }>(db, `SELECT salt FROM daily_salts WHERE day = ?`, day);
  if (row !== undefined) return { day, value: row.salt };
  const value = randomSalt();
  db.run(`INSERT INTO daily_salts (day, salt, created_at) VALUES (?, ?, ?)`, day, value, now);
  db.run(`DELETE FROM daily_salts WHERE day < ?`, saltDay(now - SALT_RETENTION_DAYS * DAY_MS));
  return { day, value };
}

/** Config the edge caches per isolate; null for unknown or deleted sites. */
export function edgeConfig(db: SqlDb, now: number): EdgeSiteConfig | null {
  const record = getSiteRecord(db);
  if (record === null || record.deleted) return null;
  return {
    siteId: record.site.id,
    tenantId: record.tenantId,
    hostnames: record.site.hostnames,
    cookieless: record.site.cookieless,
    allowLocalhost: record.site.allow_localhost,
    currency: record.site.currency,
    secretHash: record.secretHash,
    salt: todaySalt(db, now),
  };
}

// ------------------------------------------------------------- tenant index

export function indexAdd(db: SqlDb, siteId: string, now: number): void {
  db.run(`INSERT OR IGNORE INTO tenant_sites (site_id, created_at) VALUES (?, ?)`, siteId, now);
}

export function indexRemove(db: SqlDb, siteId: string): void {
  db.run(`DELETE FROM tenant_sites WHERE site_id = ?`, siteId);
}

export function indexList(db: SqlDb): string[] {
  return db
    .all<{ site_id: string }>(`SELECT site_id FROM tenant_sites ORDER BY created_at, site_id`)
    .map((r) => r.site_id);
}
