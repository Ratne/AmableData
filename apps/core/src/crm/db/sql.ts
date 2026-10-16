/**
 * Minimal synchronous SQL port used by every CRM service.
 *
 * The TenantDb Durable Object implements it on top of `ctx.storage.sql`
 * (see do-sql.ts); unit tests implement it on top of node:sqlite. Keeping the
 * services on this port (instead of the DO API directly) is what lets the whole
 * CRM domain run under vitest against a real SQLite engine.
 */
export type SqlValue = string | number | null;

export interface SqlDb {
  /** Runs a query and returns every row. */
  all<T extends object>(query: string, ...params: SqlValue[]): T[];
  /** Runs a statement, discarding rows. */
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

/** `?, ?, ?` for an IN list of `n` values. */
export function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}
