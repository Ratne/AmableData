/**
 * Minimal synchronous SQL port of the analytics store. The AnalyticsDO implements
 * it on `ctx.storage.sql` (do-sql.ts); tests implement it on node:sqlite, so the
 * whole store runs under vitest against a real SQLite engine.
 */
export type SqlValue = string | number | null;

export interface SqlDb {
  all<T extends object>(query: string, ...params: SqlValue[]): T[];
  run(query: string, ...params: SqlValue[]): void;
  /** Runs `fn` atomically; nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T;
}

export function first<T extends object>(
  db: SqlDb,
  query: string,
  ...params: SqlValue[]
): T | undefined {
  return db.all<T>(query, ...params)[0];
}
