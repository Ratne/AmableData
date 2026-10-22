/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';

/**
 * D1's API over an in-memory node:sqlite database, for offline tests of apps
 * that keep their data in D1: the app's SQL runs unchanged. Like D1, a batch is
 * one transaction nothing else interleaves with.
 */

export interface MemoryStatement {
  bind(...values: unknown[]): MemoryStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}

export interface MemoryD1 {
  readonly sqlite: DatabaseSync;
  prepare(sql: string): MemoryStatement;
  batch(statements: MemoryStatement[]): Promise<Array<{ meta: { changes: number } }>>;
}

export function memoryD1(): MemoryD1 {
  const sqlite = new DatabaseSync(':memory:');
  const normalize = (values: unknown[]) =>
    values.map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v)) as Array<null | number | string>;
  const runSync = new WeakMap<MemoryStatement, () => { meta: { changes: number } }>();

  const statement = (sql: string, values: unknown[] = []): MemoryStatement => {
    const run = () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...normalize(values)).changes) } });
    const s: MemoryStatement = {
      bind: (...next) => statement(sql, next),
      async first<T>() {
        return (sqlite.prepare(sql).get(...normalize(values)) as T | undefined) ?? null;
      },
      async all<T>() {
        return { results: sqlite.prepare(sql).all(...normalize(values)) as T[] };
      },
      async run() {
        return run();
      },
    };
    runSync.set(s, run);
    return s;
  };

  return {
    sqlite,
    prepare: (sql) => statement(sql),
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map((s) => runSync.get(s)!());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
