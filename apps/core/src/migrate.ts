import { createD1MigrationStore, installationMigrations, runMigrations } from '@amable/db';

let migrated: Promise<number> | null = null;

/**
 * Applies pending installation migrations exactly once per isolate, at the first
 * request after boot — this is what makes fleet updates "deploy and forget".
 * Later requests reuse the memoized promise. On failure the memo resets, so the
 * next request retries instead of serving a broken schema forever.
 */
export function ensureInstallationMigrated(db: D1Database): Promise<number> {
  if (migrated === null) {
    migrated = runMigrations(
      createD1MigrationStore(db, { metaTable: 'installation_meta' }),
      installationMigrations,
    ).catch((error: unknown) => {
      migrated = null;
      throw error;
    });
  }
  return migrated;
}
