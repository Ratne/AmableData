import type { Migration } from '../migrations/types';
import type { MigrationStore } from './runner';

export interface D1MigrationStoreOptions {
  /** Table recording applied migrations. Default: "d1_migrations". */
  readonly migrationsTable?: string;
  /** Single-row table used as advisory lock. Default: "d1_migrations_lock". */
  readonly lockTable?: string;
  /**
   * Optional key/value meta table that receives a `schema_version` upsert in the
   * same transaction as each applied migration (e.g. "installation_meta").
   * The table itself must be created by one of the migrations.
   */
  readonly metaTable?: string;
}

/**
 * MigrationStore backed by the installation D1 database.
 *
 * Atomicity: `D1Database.batch()` runs all statements of one migration plus its
 * bookkeeping row as a single implicit transaction.
 *
 * Advisory lock: a lease row updated with a compare-and-set UPDATE. D1 writes are
 * serialized on the primary, so only one booting instance can win the lease; the
 * lease expires on its own if the winner crashes.
 */
export function createD1MigrationStore(
  db: D1Database,
  options: D1MigrationStoreOptions = {},
): MigrationStore {
  const migrationsTable = options.migrationsTable ?? 'd1_migrations';
  const lockTable = options.lockTable ?? 'd1_migrations_lock';
  const metaTable = options.metaTable;

  return {
    async ensureReady(): Promise<void> {
      await db.batch([
        db.prepare(
          `CREATE TABLE IF NOT EXISTS ${migrationsTable} (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at INTEGER NOT NULL
          )`,
        ),
        db.prepare(
          `CREATE TABLE IF NOT EXISTS ${lockTable} (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            locked_until INTEGER NOT NULL
          )`,
        ),
        db.prepare(`INSERT OR IGNORE INTO ${lockTable} (id, locked_until) VALUES (1, 0)`),
      ]);
    },

    async appliedIds(): Promise<ReadonlySet<number>> {
      const result = await db.prepare(`SELECT id FROM ${migrationsTable}`).all<{ id: number }>();
      return new Set(result.results.map((row) => row.id));
    },

    async apply(migration: Migration): Promise<void> {
      const statements = [
        ...migration.statements.map((sql) => db.prepare(sql)),
        db
          .prepare(`INSERT INTO ${migrationsTable} (id, name, applied_at) VALUES (?1, ?2, ?3)`)
          .bind(migration.id, migration.name, Date.now()),
      ];
      if (metaTable !== undefined) {
        statements.push(
          db
            .prepare(
              `INSERT INTO ${metaTable} (key, value) VALUES ('schema_version', ?1)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            )
            .bind(String(migration.id)),
        );
      }
      await db.batch(statements);
    },

    async acquireLock(leaseMs: number): Promise<boolean> {
      const now = Date.now();
      const result = await db
        .prepare(`UPDATE ${lockTable} SET locked_until = ?1 WHERE id = 1 AND locked_until < ?2`)
        .bind(now + leaseMs, now)
        .run();
      return result.meta.changes === 1;
    },

    async releaseLock(): Promise<void> {
      await db.prepare(`UPDATE ${lockTable} SET locked_until = 0 WHERE id = 1`).run();
    },
  };
}
