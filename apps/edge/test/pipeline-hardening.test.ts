import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearSiteConfigCache,
  consumeAnalyticsBatch,
  consumeDeadLetters,
  dispatch,
  eidOf,
  replayPending,
} from '../src/analytics/pipeline';
import { claimEvent, DEDUPE_HORIZON_MS, pruneEventKeys } from '../src/analytics/store/dedupe';
import type { AnalyticsMessage, BotHit } from '../src/analytics/types';
import { batchKey, gunzipLines, writePending } from '../src/analytics/wal';
import type { Env } from '../src/env';
import {
  createStore,
  edgeEnv,
  ev,
  FakeAnalyticsNamespace,
  FakeQueue,
  FakeR2,
  SITE_ID,
  siteInit,
  T0,
} from './helpers';

const DAY = 86_400_000;

let ns: FakeAnalyticsNamespace;
let r2: FakeR2;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  clearSiteConfigCache();
  ns = new FakeAnalyticsNamespace(() => Date.now());
  r2 = new FakeR2();
  ns.store(`site:${SITE_ID}`).initSite(siteInit({ retentionDays: 30 }));
});
afterEach(() => vi.useRealTimers());

function env(queue?: FakeQueue): Env {
  return { ...edgeEnv(ns, queue), FILES: r2 as unknown as R2Bucket };
}

const downNamespace = {
  idFromName: (name: string) => ({ name }),
  get: () => new Proxy({}, { get: () => () => Promise.reject(new Error('do down')) }),
} as unknown as Env['ANALYTICS'];

function batch(bodies: AnalyticsMessage[], ids?: string[]) {
  const outcome = { acked: [] as string[], retried: [] as string[] };
  const value = {
    queue: 'analytics',
    messages: bodies.map((body, i) => ({
      id: ids?.[i] ?? `m${i}`,
      body,
      attempts: 1,
      timestamp: new Date(),
      ack: () => outcome.acked.push(`m${i}`),
      retry: () => outcome.retried.push(`m${i}`),
    })),
  } as unknown as MessageBatch<AnalyticsMessage>;
  return [value, outcome] as const;
}

const bot = (id: string): AnalyticsMessage => ({
  kind: 'bot',
  hit: {
    id,
    site: SITE_ID,
    ts: T0,
    name: 'Googlebot',
    provider: 'Google',
    category: 'indexing',
    path: '/',
  } satisfies BotHit,
});

function botHits(): number {
  const store = ns.store(`site:${SITE_ID}`) as unknown as { db: { all<T>(q: string): T[] } };
  return store.db.all<{ n: number }>(`SELECT COALESCE(SUM(hits), 0) AS n FROM bot_hits`)[0]?.n ?? 0;
}

describe('pipeline hardening', () => {
  it('a redelivered bot hit is counted once', async () => {
    await consumeAnalyticsBatch(batch([bot('t:b1')])[0], env());
    await consumeAnalyticsBatch(batch([bot('t:b1')], ['other-id'])[0], env());
    expect(botHits()).toBe(1);
  });

  it('the WAL key depends on the events, not on queue message ids or the delivery path', async () => {
    const bodies = [{ kind: 'event', event: ev({ eid: 't:1' }) } as AnalyticsMessage];
    await consumeAnalyticsBatch(batch(bodies, ['first'])[0], env());
    await consumeAnalyticsBatch(batch(bodies, ['second'])[0], env());
    const queue = new FakeQueue();
    queue.sendBatch = () => Promise.reject(new Error('queue down'));
    await dispatch(env(queue), bodies);
    expect(r2.keys('events/')).toEqual([
      `events/${SITE_ID}/2026-10-15/${await batchKey(bodies.map(eidOf))}.ndjson.gz`,
    ]);
  });

  it('the DLQ keeps the messages (retry) when neither the DO nor R2 accept them', async () => {
    r2.fail = true;
    const [b, outcome] = batch([{ kind: 'event', event: ev({ eid: 't:1' }) }]);
    await consumeDeadLetters(b, { ...env(), ANALYTICS: downNamespace });
    expect(outcome).toEqual({ acked: [], retried: ['m0'] });
  });

  it('replay pages through every pending segment and skips a failing site after its first failure', async () => {
    const bucket = r2 as unknown as R2Bucket;
    const other = 'st_bbbbbbbbbbbbbbbbbbbb';
    for (let i = 0; i < 5; i += 1) {
      await writePending(bucket, other, `o${i}`, {
        parkedAt: T0,
        reason: 'dlq',
        messages: [{ kind: 'event', event: ev({ site: other, eid: `t:o${i}` }) }],
      });
      await writePending(bucket, SITE_ID, `s${i}`, {
        parkedAt: T0,
        reason: 'dlq',
        messages: [{ kind: 'event', event: ev({ eid: `t:s${i}`, vid: `v${i}`, sid: `s${i}` }) }],
      });
    }
    const failingOther = {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) =>
        id.name.includes(other)
          ? (downNamespace as unknown as { get(): unknown }).get()
          : ns.get(id),
    } as unknown as Env['ANALYTICS'];
    const result = await replayPending({ ...env(), ANALYTICS: failingOther }, T0, { pageSize: 2 });
    expect(result).toEqual({ replayed: 5, failed: 1, stale: 0 });
    expect(r2.keys(`wal-pending/${SITE_ID}/`)).toEqual([]);
    expect(r2.keys(`wal-pending/${other}/`)).toHaveLength(5);
  });

  it('isolates an event whose apply throws, applies the rest and archives it to poison/', async () => {
    const store = ns.store(`site:${SITE_ID}`) as unknown as {
      db: { run(q: string, ...p: unknown[]): void };
    };
    const run = store.db.run.bind(store.db);
    vi.spyOn(store.db, 'run').mockImplementation((q: string, ...p: unknown[]) => {
      if (q.startsWith('INSERT INTO pageviews') && p.includes('/poison')) throw new Error('boom');
      run(q, ...p);
    });
    const [b, outcome] = batch([
      { kind: 'event', event: ev({ eid: 't:ok', path: '/fine' }) },
      { kind: 'event', event: ev({ eid: 't:bad', path: '/poison', vid: 'v2', sid: 's2' }) },
    ]);
    await consumeAnalyticsBatch(b, env());
    expect(outcome.acked).toEqual(['m0', 'm1']);
    expect(r2.keys('poison/')).toHaveLength(1);
    const ov = ns.store(`site:${SITE_ID}`).overview({ from: '2026-10-15', to: '2026-10-15' });
    expect(ov.ok && ov.value.pageviews).toBe(1);
  });

  it('archives redact PII: emails hashed, names dropped, stray addresses masked', async () => {
    const event = ev({
      eid: 't:id',
      type: 'identify',
      identity: {
        userId: 'u1',
        email: 'Anna@Example.com',
        name: 'Anna',
        traits: { phone: '+39 333', plan: 'pro' },
      },
      url: 'https://www.example.com/?ref=anna@example.com',
    });
    await consumeAnalyticsBatch(batch([{ kind: 'event', event }])[0], env());
    const [key] = r2.keys('events/');
    const object = await r2.get(key as string);
    const text = JSON.stringify(
      await gunzipLines(await (object as { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer()),
    );
    expect(text).not.toMatch(/anna@example\.com|Anna"|\+39 333/i);
    expect(text).toContain('sha256:');
    expect(text).toContain('"plan":"pro"');
  });
});

describe('store guards', () => {
  it('after a shrunk purge, events older than the purge floor are refused and the rollups stay whole', async () => {
    const clock = { now: T0 - 20 * DAY };
    const { store } = createStore(clock);
    store.initSite(siteInit({ retentionDays: 30, timezone: 'UTC' }));
    store.ingest(
      [
        ev({ eid: 't:a', ts: T0 - 20 * DAY }),
        ev({ eid: 't:b', vid: 'v2', sid: 's2', ts: T0 - 20 * DAY + 60_000 }),
      ],
      [],
    );
    clock.now = T0;
    await store.retention(null, 15);
    const day = new Date(T0 - 20 * DAY).toISOString().slice(0, 10);
    const before = store.timeseries({ from: day, to: day }, 'day');
    const late = store.ingest(
      [ev({ eid: 't:late', vid: 'v3', sid: 's3', ts: T0 - 20 * DAY + 120_000 })],
      [],
    );
    expect(late.late).toEqual(['t:late']);
    expect(store.timeseries({ from: day, to: day }, 'day')).toEqual(before);
    expect(before.ok && before.value.points[0]?.pageviews).toBe(2);
  });

  it('keeps dormant anonymous visitors that belong to a merge', async () => {
    const { store, db } = createStore({ now: T0 });
    store.initSite(siteInit({ retentionDays: 0 }));
    const ancient = T0 - 400 * DAY;
    for (const id of ['origin', 'child', 'lonely'])
      db.run(
        `INSERT INTO visitors (id, first_seen, last_seen) VALUES (?, ?, ?)`,
        id,
        ancient,
        ancient,
      );
    db.run(
      `INSERT INTO visitor_merges (child_visitor_id, origin_visitor_id, mechanism, active, created_at, updated_at)
       VALUES ('child', 'origin', 'email', 0, ?, ?)`,
      ancient,
      ancient,
    );
    const result = await store.retention(null);
    expect(result?.dormant_visitors).toBe(1);
    expect(db.all<{ id: string }>(`SELECT id FROM visitors ORDER BY id`)).toEqual([
      { id: 'child' },
      { id: 'origin' },
    ]);
    expect(db.all(`SELECT * FROM visitor_merges`)).toHaveLength(1);
  });

  it('forgets dedupe keys after the horizon, in bounded chunks', () => {
    const { db } = createStore();
    for (let i = 0; i < 5; i += 1) claimEvent(db, `t:${i}`, T0);
    expect(claimEvent(db, 't:0', T0 + DAY)).toBe(false);
    expect(pruneEventKeys(db, T0 + DEDUPE_HORIZON_MS + 1, 2)).toBe(true);
    expect(pruneEventKeys(db, T0 + DEDUPE_HORIZON_MS + 1, 10)).toBe(false);
    expect(claimEvent(db, 't:0', T0 + DEDUPE_HORIZON_MS + 1)).toBe(true);
  });
});
