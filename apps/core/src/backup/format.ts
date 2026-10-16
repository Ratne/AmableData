/**
 * Backup file format and R2 layout.
 *
 *   backups/_state.json                                   scheduler state (last run per scope, lease)
 *   backups/installation/<stamp>-scheduled-<rand>.jsonl.gz installation D1
 *   backups/tenants/<tenantId>/<stamp>-<kind>-<rand>.jsonl.gz  one tenant: 3 DOs + its D1 rows
 *
 * Every file is gzip-compressed JSONL: a header line, one line per row, an end line.
 */

export const BACKUP_FORMAT = 'amable-backup';
export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_PREFIX = 'backups/';
export const BACKUP_STATE_KEY = 'backups/_state.json';

/** Scheduled backups older than this are due (slightly under 24 h so the slot does not drift by a cron tick per day). */
export const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000 - 10 * 60 * 1000;
/** Kept per scope: last N scheduled (daily) backups. */
export const BACKUP_RETENTION_SCHEDULED = 7;
/** Kept per tenant: last N manual backups. */
export const BACKUP_RETENTION_MANUAL = 5;
/** Minimum spacing of two manual backups of the same tenant. */
export const BACKUP_MANUAL_MIN_INTERVAL_MS = 60 * 1000;
/** Scheduled work per cron tick: at most this many backups and roughly this much wall time. */
export const BACKUP_MAX_PER_TICK = 5;
export const BACKUP_TICK_BUDGET_MS = 25_000;
/** A crashed tick releases the scheduler after this long. */
export const BACKUP_LEASE_MS = 10 * 60 * 1000;

export type BackupKind = 'scheduled' | 'manual';
export type BackupDbName = 'tenant_db' | 'mail_db' | 'engine' | 'd1';
export const TENANT_DO_NAMES = ['tenant_db', 'mail_db', 'engine'] as const;
export type TenantDoName = (typeof TENANT_DO_NAMES)[number];

/** A value as stored in a JSONL row line (blobs are base64-wrapped). */
export type BackupJsonValue = string | number | null | { $b64: string };
export type BackupRow = Record<string, BackupJsonValue>;

export interface BackupHeaderLine {
  type: 'header';
  format: typeof BACKUP_FORMAT;
  version: number;
  scope: 'tenant' | 'installation';
  kind: BackupKind;
  tenantId: string | null;
  tenantSlug: string | null;
  createdAt: string;
  /** Schema version of every database in the file (migration id). */
  schemas: Partial<Record<BackupDbName, number>>;
}

export interface BackupRowLine {
  db: BackupDbName;
  table: string;
  row: BackupRow;
}

export interface BackupEndLine {
  type: 'end';
  rows: number;
}

export type BackupLine = BackupHeaderLine | BackupRowLine | BackupEndLine;

const ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-(scheduled|manual)-[0-9A-Za-z]{6,32}$/;

export interface BackupObjectInfo {
  id: string;
  key: string;
  kind: BackupKind;
  createdAt: string;
  size: number;
}

/** `2026-10-15T19:20:00.000Z` → `2026-10-15T19-20-00-000Z` (sortable, key-safe). */
export function stampOf(at: number): string {
  return new Date(at).toISOString().replace(/[:.]/g, '-');
}

export function backupId(at: number, kind: BackupKind, rand: string): string {
  return `${stampOf(at)}-${kind}-${rand}`;
}

export function isBackupId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export function tenantBackupPrefix(tenantId: string): string {
  return `${BACKUP_PREFIX}tenants/${tenantId}/`;
}

export const INSTALLATION_BACKUP_PREFIX = `${BACKUP_PREFIX}installation/`;

export function backupKey(prefix: string, id: string): string {
  return `${prefix}${id}.jsonl.gz`;
}

/** Parses an R2 key under `prefix`; null for foreign objects. */
export function parseBackupKey(prefix: string, key: string, size: number): BackupObjectInfo | null {
  if (!key.startsWith(prefix) || !key.endsWith('.jsonl.gz')) return null;
  const id = key.slice(prefix.length, -'.jsonl.gz'.length);
  const match = ID_PATTERN.exec(id);
  if (match === null) return null;
  const stamp = id.slice(0, 24);
  const iso = `${stamp.slice(0, 13)}:${stamp.slice(14, 16)}:${stamp.slice(17, 19)}.${stamp.slice(20, 23)}Z`;
  return { id, key, kind: match[1] as BackupKind, createdAt: iso, size };
}
