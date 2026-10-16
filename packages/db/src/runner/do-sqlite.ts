import type { Migration } from '../migrations/types';
import type { MigrationStore } from './runner';

export interface DoSqliteMigrationStoreOptions {
  /** Table recording applied migrations. Default: "do_migrations". */
  readonly migrationsTable?: string;
  /**
   * Optional key/value meta table that receives a `schema_version` upsert in the
   * same transaction as each applied migration (e.g. "tenant_meta").
   * The table itself must be created by one of the migrations.
   */
  readonly metaTable?: string;
}

/**
 * MigrationStore backed by Durable Object SQLite storage.
 *
 * Call `runMigrations` with this store inside `ctx.blockConcurrencyWhile()` in the
 * DO constructor: the object migrates itself on first access (and on first wake
 * after a deploy), before any request can observe a stale schema.
 *
 * Atomicity: `storage.transactionSync()`. Locking: not needed — a Durable Object
 * instance is single-threaded and blockConcurrencyWhile defers all other work.
 */
export function createDoSqliteMigrationStore(
  storage: DurableObjectStorage,
  options: DoSqliteMigrationStoreOptions = {},
): MigrationStore {
  const migrationsTable = options.migrationsTable ?? 'do_migrations';
  const metaTable = options.metaTable;
  const sql = storage.sql;

  return {
    ensureReady(): Promise<void> {
      sql.exec(
        `CREATE TABLE IF NOT EXISTS ${migrationsTable} (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at INTEGER NOT NULL
        )`,
      );
      return Promise.resolve();
    },

    appliedIds(): Promise<ReadonlySet<number>> {
      const rows = sql.exec<{ id: number }>(`SELECT id FROM ${migrationsTable}`).toArray();
      return Promise.resolve(new Set(rows.map((row) => row.id)));
    },

    apply(migration: Migration): Promise<void> {
      storage.transactionSync(() => {
        for (const statement of migration.statements) {
          sql.exec(statement);
        }
        sql.exec(
          `INSERT INTO ${migrationsTable} (id, name, applied_at) VALUES (?, ?, ?)`,
          migration.id,
          migration.name,
          Date.now(),
        );
        if (metaTable !== undefined) {
          sql.exec(
            `INSERT INTO ${metaTable} (key, value) VALUES ('schema_version', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            String(migration.id),
          );
        }
      });
      return Promise.resolve();
    },

    acquireLock(): Promise<boolean> {
      // The DO execution model already guarantees exclusivity.
      return Promise.resolve(true);
    },

    releaseLock(): Promise<void> {
      return Promise.resolve();
    },
  };
}
