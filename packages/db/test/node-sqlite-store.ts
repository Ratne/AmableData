import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from '../src/migrations/types';
import type { MigrationStore } from '../src/runner/runner';

export interface NodeSqliteStoreOptions {
  readonly migrationsTable?: string;
  readonly lockTable?: string;
  readonly metaTable?: string;
}

/**
 * Test-only MigrationStore backed by node:sqlite, mirroring the semantics of the
 * D1 store: lease-based advisory lock, one transaction per applied migration.
 * Lets the unit tests exercise the runner against a real SQLite engine.
 */
export function createNodeSqliteMigrationStore(
  db: DatabaseSync,
  options: NodeSqliteStoreOptions = {},
): MigrationStore {
  const migrationsTable = options.migrationsTable ?? 'd1_migrations';
  const lockTable = options.lockTable ?? 'd1_migrations_lock';
  const metaTable = options.metaTable;

  return {
    ensureReady(): Promise<void> {
      db.exec(
        `CREATE TABLE IF NOT EXISTS ${migrationsTable} (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ${lockTable} (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          locked_until INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO ${lockTable} (id, locked_until) VALUES (1, 0);`,
      );
      return Promise.resolve();
    },

    appliedIds(): Promise<ReadonlySet<number>> {
      const rows = db.prepare(`SELECT id FROM ${migrationsTable}`).all() as Array<{ id: number }>;
      return Promise.resolve(new Set(rows.map((row) => row.id)));
    },

    apply(migration: Migration): Promise<void> {
      db.exec('BEGIN');
      try {
        for (const statement of migration.statements) {
          db.exec(statement);
        }
        db.prepare(`INSERT INTO ${migrationsTable} (id, name, applied_at) VALUES (?, ?, ?)`).run(
          migration.id,
          migration.name,
          Date.now(),
        );
        if (metaTable !== undefined) {
          db.prepare(
            `INSERT INTO ${metaTable} (key, value) VALUES ('schema_version', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          ).run(String(migration.id));
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return Promise.resolve();
    },

    acquireLock(leaseMs: number): Promise<boolean> {
      const now = Date.now();
      const result = db
        .prepare(`UPDATE ${lockTable} SET locked_until = ? WHERE id = 1 AND locked_until < ?`)
        .run(now + leaseMs, now);
      return Promise.resolve(Number(result.changes) === 1);
    },

    releaseLock(): Promise<void> {
      db.prepare(`UPDATE ${lockTable} SET locked_until = 0 WHERE id = 1`).run();
      return Promise.resolve();
    },
  };
}
