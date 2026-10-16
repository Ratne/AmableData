import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { tenantMigrations } from '@amable/db';
import {
  createCrmContext,
  type CrmActor,
  type CrmContext,
  type SearchMode,
} from '../../src/crm/context';
import type { SqlDb, SqlValue } from '../../src/crm/db/sql';
import { runCrmOp, type CrmOpInput, type CrmOpName, type CrmOpOutput } from '../../src/crm/ops';
import { ensureSearchIndex } from '../../src/crm/search/index-store';
import type { Env } from '../../src/env';

/** SqlDb over node:sqlite with savepoint-based nesting (mirrors transactionSync). */
export function createNodeSqlDb(db = new DatabaseSync(':memory:')): SqlDb & { raw: DatabaseSync } {
  let depth = 0;
  const bind = (params: SqlValue[]): SQLInputValue[] => params;
  return {
    raw: db,
    all<T extends object>(query: string, ...params: SqlValue[]): T[] {
      return db.prepare(query).all(...bind(params)) as T[];
    },
    run(query: string, ...params: SqlValue[]): void {
      db.prepare(query).run(...bind(params));
    },
    transaction<T>(fn: () => T): T {
      const name = `sp${depth}`;
      db.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${name}`);
      depth += 1;
      try {
        const result = fn();
        depth -= 1;
        db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${name}`);
        return result;
      } catch (error) {
        depth -= 1;
        db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`);
        throw error;
      }
    },
  };
}

export const USER_ACTOR: CrmActor = { type: 'user', id: 'user_1', canReadSensitive: true };
export const VIEWER_ACTOR: CrmActor = { type: 'user', id: 'user_viewer', canReadSensitive: false };

export interface TestTenant {
  db: SqlDb & { raw: DatabaseSync };
  mode: SearchMode;
  clock: { now: number };
  ctx(actor?: CrmActor): CrmContext;
  /** Runs an op exactly like the DO does (transaction + error mapping); throws on error results. */
  op<K extends CrmOpName>(op: K, input: CrmOpInput<K>, actor?: CrmActor): CrmOpOutput<K>;
}

/** A migrated tenant database (FTS5 by default, trigram fallback on demand). */
export function createTestTenant(mode: SearchMode = 'fts5'): TestTenant {
  const db = createNodeSqlDb();
  for (const migration of tenantMigrations) {
    for (const statement of migration.statements) db.raw.exec(statement);
  }
  const effective = ensureSearchIndex(db, mode);
  const clock = { now: Date.UTC(2026, 9, 15, 12, 0, 0) };
  const now = (): number => {
    clock.now += 1;
    return clock.now;
  };
  return {
    db,
    mode: effective,
    clock,
    ctx: (actor = USER_ACTOR) => createCrmContext(db, actor, effective, { now }),
    op<K extends CrmOpName>(op: K, input: CrmOpInput<K>, actor = USER_ACTOR): CrmOpOutput<K> {
      const result = runCrmOp({ db, searchMode: effective, now }, actor, op, input);
      if (!result.ok) {
        throw Object.assign(new Error(`${result.error.code}: ${result.error.message}`), {
          shape: result.error,
        });
      }
      return result.value as CrmOpOutput<K>;
    },
  };
}

/** Outbox rows in emission order. */
export function outbox(t: TestTenant): Array<{ type: string; payload: Record<string, unknown> }> {
  return t.db
    .all<{ type: string; payload: string }>(`SELECT type, payload FROM crm_outbox ORDER BY id`)
    .map((r) => ({ type: r.type, payload: JSON.parse(r.payload) as Record<string, unknown> }));
}

/** In-memory stand-in for the TENANT_DB namespace (one SQLite DB per tenant id). */
export function fakeTenantDbNamespace(now?: () => number): Env['TENANT_DB'] {
  const tenants = new Map<string, TestTenant>();
  const namespace = {
    idFromName: (name: string) => name,
    get: (id: string) => {
      let tenant = tenants.get(id);
      if (tenant === undefined) {
        tenant = createTestTenant();
        tenants.set(id, tenant);
      }
      const current = tenant;
      return {
        crm: (op: string, actor: CrmActor, input: unknown) =>
          // structuredClone mimics the RPC boundary (no shared references, no classes).
          Promise.resolve(
            structuredClone(
              runCrmOp(
                { db: current.db, searchMode: current.mode, ...(now === undefined ? {} : { now }) },
                actor,
                op,
                structuredClone(input),
              ),
            ),
          ),
      };
    },
  };
  return namespace as unknown as Env['TENANT_DB'];
}
