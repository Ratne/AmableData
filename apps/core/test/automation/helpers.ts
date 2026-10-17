import type { AppActionPort } from '../../src/apps/actions';
import type { AutomationGraph, GraphNode, Step } from '@amable/api-types';
import { createSecretBox } from '@amable/auth/security';
import type { EmailSendRequest, QuotaDecision } from '@amable/core';
import { monotonicFactory } from 'ulid';
import { AutomationEngine } from '../../src/automation/engine';
import { engineMigrations } from '../../src/automation/migrations';
import {
  runAutomationOp,
  type AutomationOpInput,
  type AutomationOpName,
  type AutomationOpOutput,
} from '../../src/automation/ops';
import { ENGINE_ACTOR, type FetchFn } from '../../src/automation/ports';
import type { SqlDb, SqlValue } from '../../src/crm/db/sql';
import { runCrmOp, type CrmResult } from '../../src/crm/ops';
import type { Env } from '../../src/env';
import { createNodeSqlDb, createTestTenant, type TestTenant } from '../crm/helpers';

/** Fixed 32-byte test key (base64) for the signing-secret SecretBox. */
export const TEST_ENCRYPTION_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export interface EngineHarness {
  tenant: TestTenant;
  engine: AutomationEngine;
  db: ReturnType<typeof createNodeSqlDb>;
  clock: { now: number };
  emails: EmailSendRequest[];
  alarm: { at: number | null };
  quota: { decision: QuotaDecision; checks: number };
  fetchCalls: Array<{ url: string; init: RequestInit | undefined }>;
  setFetch(fn: FetchFn): void;
  /** Makes CRM calls of `op` fail with a transport error `times` times. */
  failCrm(op: string, times: number): void;
  /** Executes CRM `op` but loses the response (crash-like) `times` times. */
  loseResponse(op: string, times: number): void;
  op<K extends AutomationOpName>(
    op: K,
    input: AutomationOpInput<K>,
  ): Promise<AutomationOpOutput<K>>;
  /** Drains the outbox and runs every due job (like the kick + alarm in the DO). */
  flush(): Promise<void>;
  /** Moves the clock and fires the alarm if due. */
  advance(ms: number): Promise<void>;
  contact(name?: string): string;
  tag(name: string): string;
  tagsOf(contactId: string): string[];
  /** Creates and publishes an automation. */
  publish(graph: AutomationGraph, settings?: Record<string, unknown>): Promise<string>;
}

/** Durable Object SQLite refuses statements with more than 100 bound parameters: mimic it. */
function withParamLimit<T extends SqlDb>(db: T): T {
  const check = (query: string, params: readonly SqlValue[]): void => {
    if (params.length > 100)
      throw new Error(`too many SQL variables (${params.length}): ${query.slice(0, 60)}`);
  };
  return {
    ...db,
    all: <R extends object>(query: string, ...params: SqlValue[]): R[] => {
      check(query, params);
      return db.all<R>(query, ...params);
    },
    run: (query: string, ...params: SqlValue[]): void => {
      check(query, params);
      db.run(query, ...params);
    },
    transaction: <R>(fn: () => R): R => db.transaction(fn),
  };
}

export function createEngineHarness(options: { apps?: AppActionPort } = {}): EngineHarness {
  const tenant = createTestTenant();
  const clock = tenant.clock;
  const tenantDb = withParamLimit(tenant.db);
  const db = withParamLimit(createNodeSqlDb());
  for (const migration of engineMigrations) {
    for (const statement of migration.statements) db.raw.exec(statement);
  }
  const emails: EmailSendRequest[] = [];
  const alarm = { at: null as number | null };
  const quota = { decision: { action: 'allow' } as QuotaDecision, checks: 0 };
  const fetchCalls: EngineHarness['fetchCalls'] = [];
  let fetchImpl: FetchFn = () => Promise.resolve(new Response('ok', { status: 200 }));
  const failures = new Map<string, number>();
  const lost = new Map<string, number>();
  const nextId = monotonicFactory();

  const engine = new AutomationEngine(db, {
    tenantId: 'tenant_1',
    crm: {
      call: (op: string, input: unknown): Promise<CrmResult<unknown>> => {
        const left = failures.get(op) ?? 0;
        if (left > 0) {
          failures.set(op, left - 1);
          return Promise.reject(new Error(`network error calling ${op}`));
        }
        const result = structuredClone(
          runCrmOp(
            { db: tenantDb, searchMode: tenant.mode, now: () => clock.now },
            ENGINE_ACTOR,
            op,
            structuredClone(input),
          ),
        );
        const lose = lost.get(op) ?? 0;
        if (lose > 0) {
          lost.set(op, lose - 1);
          return Promise.reject(new Error(`connection reset after ${op}`));
        }
        return Promise.resolve(result);
      },
    },
    email: {
      send: (message) => {
        emails.push(message);
        return Promise.resolve();
      },
    },
    quota: {
      check: () => {
        quota.checks += 1;
        return Promise.resolve(quota.decision);
      },
    },
    fetch: (input, init) => {
      fetchCalls.push({ url: input, init });
      return fetchImpl(input, init);
    },
    alarm: {
      set: (at) => {
        alarm.at = at;
        return Promise.resolve();
      },
    },
    secretBox: () => createSecretBox(TEST_ENCRYPTION_KEY),
    ...(options.apps === undefined ? {} : { apps: options.apps }),
    now: () => clock.now,
    newId: () => nextId(clock.now),
  });

  const op = async <K extends AutomationOpName>(
    name: K,
    input: AutomationOpInput<K>,
  ): Promise<AutomationOpOutput<K>> => {
    const result = await runAutomationOp(db, engine, { userId: 'user_1' }, name, input);
    if (!result.ok) {
      throw Object.assign(new Error(`${result.error.code}: ${result.error.message}`), {
        shape: result.error,
      });
    }
    return result.value as AutomationOpOutput<K>;
  };

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) {
      await engine.drainOutbox();
      const processed = await engine.runDue();
      const pending =
        tenant.db.all<{ n: number }>(
          `SELECT COUNT(*) AS n FROM crm_outbox WHERE dispatched_at IS NULL`,
        )[0]?.n ?? 0;
      if (processed === 0 && pending === 0) return;
    }
  };

  return {
    tenant,
    engine,
    db,
    clock,
    emails,
    alarm,
    quota,
    fetchCalls,
    setFetch: (fn) => {
      fetchImpl = fn;
    },
    failCrm: (name, times) => failures.set(name, times),
    loseResponse: (name, times) => lost.set(name, times),
    op,
    flush,
    advance: async (ms) => {
      clock.now += ms;
      await flush();
    },
    contact: (name = 'Ada') =>
      tenant.op('contacts.create', {
        given_name: name,
        emails: [{ email: `${name.toLowerCase()}${clock.now}@example.com` }],
      }).id,
    tag: (name) => tenant.op('tags.create', { name }).id,
    tagsOf: (contactId) => tenant.op('contacts.get', { id: contactId }).tag_ids,
    publish: async (graph, settings = {}) => {
      const created = await op('automations.create', { name: 'Test', graph, settings });
      await op('automations.publish', { id: created.id });
      return created.id;
    },
  };
}

/** In-memory stand-in for the ENGINE namespace, wired to a (fake) TENANT_DB namespace. */
export function fakeEngineNamespace(
  tenantDbs: Env['TENANT_DB'],
  clock: { now: number },
): Env['ENGINE'] {
  const engines = new Map<string, { db: SqlDb; engine: AutomationEngine }>();
  const nextId = monotonicFactory();
  const namespace = {
    idFromName: (name: string) => name,
    get: (id: string) => {
      let entry = engines.get(id);
      if (entry === undefined) {
        const db = createNodeSqlDb();
        for (const migration of engineMigrations) {
          for (const statement of migration.statements) db.raw.exec(statement);
        }
        const tenantDb = tenantDbs.get(tenantDbs.idFromName(id));
        const engine = new AutomationEngine(db, {
          tenantId: id,
          crm: {
            call: async (op, input) =>
              (await tenantDb.crm(op, ENGINE_ACTOR, input)) as CrmResult<unknown>,
          },
          email: { send: () => Promise.resolve() },
          quota: { check: () => Promise.resolve({ action: 'allow' }) },
          fetch: () => Promise.resolve(new Response('ok')),
          alarm: { set: () => Promise.resolve() },
          now: () => clock.now,
          newId: () => nextId(clock.now),
        });
        entry = { db, engine };
        engines.set(id, entry);
      }
      const current = entry;
      return {
        automation: async (
          _tenantId: string,
          op: string,
          actor: { userId: string | null },
          input: unknown,
        ) =>
          structuredClone(
            await runAutomationOp(current.db, current.engine, actor, op, structuredClone(input)),
          ),
        kick: () => current.engine.kick(),
        ingest: (_tenantId: string, events: Parameters<AutomationEngine['ingest']>[0]) =>
          current.engine.ingest(events),
      };
    },
  };
  return namespace as unknown as Env['ENGINE'];
}

// ------------------------------------------------------------ graph DSL

let n = 0;
const pos = (): { x: number; y: number } => ({ x: (n += 1), y: 0 });

export const goal = (
  id: string,
  triggers: Extract<GraphNode, { type: 'goal' }>['triggers'],
  extra: { accept?: 'anyone' | 'enrolled_only' } = {},
): GraphNode => ({
  id,
  type: 'goal',
  position: pos(),
  triggers,
  ...extra,
});

export const seq = (id: string, steps: Step[]): GraphNode => ({
  id,
  type: 'sequence',
  position: pos(),
  steps,
});

export const edge = (
  source: string,
  target: string,
  handle?: string,
): AutomationGraph['edges'][number] => ({
  id: `${source}-${target}-${handle ?? ''}`,
  source,
  target,
  ...(handle === undefined ? {} : { source_handle: handle }),
});

export const graph = (nodes: GraphNode[], edges: AutomationGraph['edges']): AutomationGraph => ({
  schema_version: 1,
  nodes,
  edges,
});

export const tagStep = (id: string, tagId: string): Step => ({
  id,
  type: 'apply_tag',
  tag_ids: [tagId],
});

export const doc = {
  type: 'doc' as const,
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }],
};
