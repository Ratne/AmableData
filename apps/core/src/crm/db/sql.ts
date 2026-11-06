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

/** Durable Object SQLite binds at most 100 parameters per statement: IN lists go in chunks. */
const SQL_IN_CHUNK = 90;

export function chunks<T>(items: readonly T[], size: number = SQL_IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** `?, ?, ?` for an IN list of `n` values. */
export function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}
