import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

/**
 * Minimal D1Database implementation over node:sqlite for integration tests:
 * prepare/bind/first/all/run/raw + atomic batch. Same SQLite engine family as
 * D1, so the real migrations and queries run unchanged.
 */

type Bound = readonly SQLInputValue[];

class ShimStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: Bound = [],
  ) {}

  bind(...values: unknown[]): ShimStatement {
    const params = values.map((v): SQLInputValue => {
      if (v === undefined) throw new Error('D1_TYPE_ERROR: undefined is not a valid binding');
      if (typeof v === 'boolean') return v ? 1 : 0;
      if (v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint') {
        return v;
      }
      if (v instanceof Uint8Array) return v;
      throw new Error(`unsupported binding type: ${typeof v}`);
    });
    return new ShimStatement(this.db, this.sql, params);
  }

  private rows(): Record<string, unknown>[] {
    return this.db.prepare(this.sql).all(...this.params) as Record<string, unknown>[];
  }

  first<T>(column?: string): Promise<T | null> {
    const row = this.rows()[0];
    if (row === undefined) return Promise.resolve(null);
    return Promise.resolve((column === undefined ? { ...row } : row[column]) as T);
  }

  all<T>(): Promise<{ results: T[]; success: true; meta: { changes: number } }> {
    const results = this.rows().map((r) => ({ ...r }) as T);
    return Promise.resolve({ results, success: true, meta: { changes: 0 } });
  }

  run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }> {
    return Promise.resolve(this.execute());
  }

  raw<T>(): Promise<T[]> {
    return Promise.resolve(this.rows().map((r) => Object.values(r) as T));
  }

  execute() {
    const stmt = this.db.prepare(this.sql);
    if (/\bRETURNING\b/i.test(this.sql)) {
      const rows = stmt.all(...this.params);
      return { success: true as const, meta: { changes: rows.length, last_row_id: 0 } };
    }
    const result = stmt.run(...this.params);
    return {
      success: true as const,
      meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
    };
  }
}

export class ShimD1 {
  readonly sqlite = new DatabaseSync(':memory:');

  prepare(sql: string): ShimStatement {
    return new ShimStatement(this.sqlite, sql);
  }

  async batch(statements: ShimStatement[]) {
    this.sqlite.exec('BEGIN');
    try {
      const results = statements.map((s) => s.execute());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }

  exec(sql: string) {
    this.sqlite.exec(sql);
    return Promise.resolve({ count: 1, duration: 0 });
  }
}

export function createShimD1(): { shim: ShimD1; db: D1Database } {
  const shim = new ShimD1();
  return { shim, db: shim as unknown as D1Database };
}
