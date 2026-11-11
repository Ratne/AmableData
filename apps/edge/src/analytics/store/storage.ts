/**
 * Storage guard of a site DO (SQLite-backed Durable Objects stop accepting
 * writes at 10 GB). The daily alarm measures the database: above the warning
 * ratio it alerts, above the shrink ratio it also runs the retention with a
 * shorter hot window so the DO keeps ingesting. A site that stays over the
 * limit with the minimum window needs era sharding (see the wiki).
 */
export const DO_STORAGE_LIMIT_BYTES = 10 * 1024 ** 3;
export const STORAGE_WARN_RATIO = 0.7;
export const STORAGE_SHRINK_RATIO = 0.85;
/** Lowest hot window the auto-shrink goes to (the plan's minimum retention). */
export const MIN_SHRUNK_RETENTION_DAYS = 30;

export type StoragePressure = 'ok' | 'warn' | 'shrink';

export function storagePressure(bytes: number, limit = DO_STORAGE_LIMIT_BYTES): StoragePressure {
  if (bytes >= limit * STORAGE_SHRINK_RATIO) return 'shrink';
  if (bytes >= limit * STORAGE_WARN_RATIO) return 'warn';
  return 'ok';
}

/** Hot window used by an auto-shrink pass: half the configured one, never under the minimum. */
export function shrunkRetentionDays(retentionDays: number): number {
  return Math.max(
    MIN_SHRUNK_RETENTION_DAYS,
    Math.min(retentionDays, Math.floor(retentionDays / 2)),
  );
}
