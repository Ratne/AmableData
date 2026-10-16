import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { SqlDb, SqlValue } from '../src/analytics/db/sql';
import { analyticsMigrations } from '../src/analytics/migrations';
import { AnalyticsStore, type SiteInit } from '../src/analytics/store/index';
import type { AnalyticsMessage, EnrichedEvent } from '../src/analytics/types';
import type { Env } from '../src/env';

/** SqlDb over node:sqlite with savepoint nesting (mirrors transactionSync). */
export function createNodeSqlDb(): SqlDb & { raw: DatabaseSync } {
  const db = new DatabaseSync(':memory:');
  for (const m of analyticsMigrations) for (const s of m.statements) db.exec(s);
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

export const T0 = Date.UTC(2026, 9, 15, 10, 0, 0);

export interface Clock {
  now: number;
}

export function createStore(clock: Clock = { now: T0 }): {
  store: AnalyticsStore;
  db: SqlDb & { raw: DatabaseSync };
} {
  const db = createNodeSqlDb();
  return { store: new AnalyticsStore(db, () => clock.now), db };
}

export const SITE_ID = 'st_aaaaaaaaaaaaaaaaaaaa';

export function siteInit(overrides: Partial<SiteInit> = {}): SiteInit {
  return {
    siteId: SITE_ID,
    tenantId: 'tenant_1',
    name: 'Example',
    hostnames: ['example.com'],
    cookieless: false,
    allowLocalhost: false,
    timezone: 'UTC',
    currency: 'EUR',
    retentionDays: 395,
    secretHash: null,
    ...overrides,
  };
}

let seq = 0;

/** Builds an enriched browser pageview; override anything. */
export function ev(overrides: Partial<EnrichedEvent> = {}): EnrichedEvent {
  seq += 1;
  const path = overrides.path ?? '/';
  return {
    eid: `e-${seq}`,
    ts: T0,
    site: SITE_ID,
    type: 'pageview',
    server: false,
    vid: 'visitor-1',
    sid: 'session-1',
    firstSeen: T0,
    sessionNumber: 1,
    cookieless: false,
    url: `https://www.example.com${path}`,
    hostname: 'www.example.com',
    path,
    referrer: null,
    referrerHost: null,
    channel: 'Direct',
    paid: false,
    source: null,
    utm: { source: null, medium: null, campaign: null, term: null, content: null },
    clickIds: null,
    geo: { country: 'IT', region: 'Lombardy', city: 'Milan', latitude: 45.46, longitude: 9.19 },
    device: 'desktop',
    browser: 'Chrome',
    os: 'macOS',
    language: 'it-IT',
    screenWidth: 1440,
    name: null,
    data: null,
    payment: null,
    identity: null,
    ...overrides,
  };
}

type StubMethods = Record<string, (...args: never[]) => unknown>;

const DO_LIFECYCLE = new Set(['constructor', 'fetch', 'alarm', 'webSocketMessage', 'webSocketClose', 'webSocketError']);

/**
 * Public RPC methods of AnalyticsDO, parsed from its source (the class only loads
 * inside workerd). The fake namespace exposes only these, so a core call to a
 * method the DO does not have fails in tests instead of in production.
 */
export const ANALYTICS_DO_RPC_METHODS: ReadonlySet<string> = (() => {
  const source = readFileSync(decodeURIComponent(new URL('../src/analytics/do.ts', import.meta.url).pathname), 'utf8');
  const body = source.slice(source.indexOf('export class AnalyticsDO'));
  const names = new Set<string>();
  for (const match of body.matchAll(/^ {2}(?:async )?([a-zA-Z]\w*)\(/gm)) {
    if (match[1] !== undefined && !DO_LIFECYCLE.has(match[1])) names.add(match[1]);
  }
  return names;
})();

/** In-process stand-in for the ANALYTICS namespace: one AnalyticsStore per DO name. */
export class FakeAnalyticsNamespace {
  readonly stores = new Map<string, AnalyticsStore>();
  /** Stands in for `stub.fetch` (WebSocket upgrades); unset → no fetch on the stub. */
  fetchHandler: ((request: Request) => Promise<Response>) | undefined;
  constructor(private readonly now: () => number = Date.now) {}

  store(name: string): AnalyticsStore {
    let s = this.stores.get(name);
    if (s === undefined) {
      s = new AnalyticsStore(createNodeSqlDb(), this.now);
      this.stores.set(name, s);
    }
    return s;
  }

  idFromName(name: string): { name: string } {
    return { name };
  }

  get(id: { name: string }): StubMethods {
    const store = this.store(id.name);
    // Like an RPC stub: every method is async and results are structured-cloned.
    return new Proxy({} as StubMethods, {
      get: (_target, prop: string) => {
        if (prop === 'fetch') return this.fetchHandler;
        if (!ANALYTICS_DO_RPC_METHODS.has(prop)) return undefined;
        const fn = (store as unknown as Record<string, unknown>)[prop];
        if (typeof fn !== 'function') return undefined;
        return async (...args: unknown[]) =>
          structuredClone(await (fn as (...a: unknown[]) => unknown).apply(store, args));
      },
    });
  }
}

export class FakeQueue {
  readonly sent: AnalyticsMessage[] = [];
  send(body: AnalyticsMessage): Promise<void> {
    this.sent.push(body);
    return Promise.resolve();
  }
  sendBatch(messages: Iterable<{ body: AnalyticsMessage }>): Promise<void> {
    for (const m of messages) this.sent.push(m.body);
    return Promise.resolve();
  }
}

export function edgeEnv(ns: FakeAnalyticsNamespace, queue?: FakeQueue): Env {
  return {
    ENVIRONMENT: 'test',
    ANALYTICS: ns as unknown as Env['ANALYTICS'],
    ...(queue === undefined
      ? {}
      : { ANALYTICS_QUEUE: queue as unknown as Queue<AnalyticsMessage> }),
  };
}
