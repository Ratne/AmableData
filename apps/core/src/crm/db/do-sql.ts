import type { SqlDb, SqlValue } from './sql';

/** SqlDb backed by the SQLite storage of a Durable Object. */
export function createDoSqlDb(storage: DurableObjectStorage): SqlDb {
  let depth = 0;
  return {
    all<T extends object>(query: string, ...params: SqlValue[]): T[] {
      return storage.sql.exec(query, ...params).toArray() as T[];
    },
    run(query: string, ...params: SqlValue[]): void {
      storage.sql.exec(query, ...params).toArray();
    },
    transaction<T>(fn: () => T): T {
      if (depth > 0) return fn();
      depth += 1;
      try {
        return storage.transactionSync(fn);
      } finally {
        depth -= 1;
      }
    },
  };
}
