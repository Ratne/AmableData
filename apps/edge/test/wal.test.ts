import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearSiteConfigCache,
  consumeAnalyticsBatch,
  consumeDeadLetters,
  dispatch,
  replayPending,
  shardIndex,
} from '../src/analytics/pipeline';
import type { AnalyticsMessage } from '../src/analytics/types';
import {
  batchKey,
  gunzipLines,
  readPending,
  REPLAY_HORIZON_MS,
  writePending,
} from '../src/analytics/wal';
import type { Env } from '../src/env';
import {
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

/** A namespace whose DO calls all fail (DO unavailable / overloaded). */
const downNamespace = {
  idFromName: (name: string) => ({ name }),
  get: () => new Proxy({}, { get: () => () => Promise.reject(new Error('do down')) }),
} as unknown as Env['ANALYTICS'];

function message(overrides: Parameters<typeof ev>[0] = {}): AnalyticsMessage {
  return { kind: 'event', event: ev(overrides) };
}

interface Outcome {
  acked: string[];
  retried: string[];
}

function batch(
  bodies: AnalyticsMessage[],
  queue = 'analytics',
): [MessageBatch<AnalyticsMessage>, Outcome] {
  const outcome: Outcome = { acked: [], retried: [] };
  const value = {
    queue,
    messages: bodies.map((body, i) => ({
      id: `m${i}`,
      body,
      attempts: 1,
      timestamp: new Date(),
      ack: () => outcome.acked.push(`m${i}`),
      retry: () => outcome.retried.push(`m${i}`),
    })),
  } as unknown as MessageBatch<AnalyticsMessage>;
  return [value, outcome];
}

function pageviews(): number {
  const ov = ns.store(`site:${SITE_ID}`).overview({ from: '2026-09-01', to: '2026-10-15' });
  return ov.ok ? ov.value.pageviews : -1;
}

describe('analytics WAL', () => {
  it('archives on R2 before applying to the DO, then acks', async () => {
    const store = ns.store(`site:${SITE_ID}`);
    const ingest = store.ingest.bind(store);
    vi.spyOn(store, 'ingest').mockImplementation((events, bots) => {
      r2.writes.push('do:ingest');
      return ingest(events, bots);
    });
    const [b, outcome] = batch([message({ eid: 't:1' }), message({ eid: 't:2', ts: T0 - DAY })]);
    await consumeAnalyticsBatch(b, env());
    const key = await batchKey(['t:1', 't:2']);
    expect(r2.writes.at(-1)).toBe('do:ingest');
    expect(r2.writes.slice(0, -1).sort()).toEqual([
      `events/${SITE_ID}/2026-10-14/${key}.ndjson.gz`,
      `events/${SITE_ID}/2026-10-15/${key}.ndjson.gz`,
    ]);
    expect(outcome.acked).toEqual(['m0', 'm1']);
    const object = await r2.get(`events/${SITE_ID}/2026-10-15/${key}.ndjson.gz`);
    const lines = await gunzipLines<AnalyticsMessage>(
      await (object as { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer(),
    );
    expect(lines.map((m) => m.kind === 'event' && m.event.eid)).toEqual(['t:1']);
  });

  it('retries without ack when the DO fails; the redelivery rewrites the same WAL object', async () => {
    const bodies = [message({ eid: 't:1' })];
    const [first, failed] = batch(bodies);
    await consumeAnalyticsBatch(first, { ...env(), ANALYTICS: downNamespace });
    expect(failed).toEqual({ acked: [], retried: ['m0'] });
    expect(r2.keys('events/')).toHaveLength(1);

    const [second, ok] = batch(bodies);
    await consumeAnalyticsBatch(second, env());
    expect(ok.acked).toEqual(['m0']);
    expect(r2.keys('events/')).toHaveLength(1);
    expect(pageviews()).toBe(1);
  });

  it('retries when the WAL cannot be written (never applies unarchived events)', async () => {
    r2.fail = true;
    const [b, outcome] = batch([message({ eid: 't:1' })]);
    await consumeAnalyticsBatch(b, env());
    expect(outcome).toEqual({ acked: [], retried: ['m0'] });
    expect(pageviews()).toBe(0);
  });

  it('routes events older than the hot window to the corrections ledger only', async () => {
    const [b, outcome] = batch([
      message({ eid: 't:late', ts: T0 - 40 * DAY, path: '/late' }),
      message({ eid: 't:fresh', vid: 'v2', sid: 's2', path: '/fresh' }),
    ]);
    await consumeAnalyticsBatch(b, env());
    expect(outcome.acked).toEqual(['m0', 'm1']);
    expect(r2.keys('corrections/')).toEqual([
      `corrections/${SITE_ID}/2026-09-05/${await batchKey(['t:late', 't:fresh'])}.ndjson.gz`,
    ]);
    expect(r2.keys('events/')).toHaveLength(2);
    expect(pageviews()).toBe(1);
  });
});

describe('producer fallback, DLQ and replay', () => {
  it('applies directly when the queue refuses, else parks the segment for the replay', async () => {
    const queue = new FakeQueue();
    queue.sendBatch = () => Promise.reject(new Error('queue down'));
    await dispatch(env(queue), [message({ eid: 't:1' })]);
    expect(pageviews()).toBe(1);
    expect(r2.keys('events/')).toHaveLength(1);

    await dispatch({ ...env(queue), ANALYTICS: downNamespace }, [
      message({ eid: 't:2', vid: 'v2', sid: 's2' }),
    ]);
    const pending = r2.keys('wal-pending/');
    expect(pending).toHaveLength(1);
    expect((await readPending(r2 as unknown as R2Bucket, pending[0] as string))?.reason).toBe(
      'producer_fallback',
    );

    expect(await replayPending(env(), Date.now())).toEqual({ replayed: 1, failed: 0, stale: 0 });
    expect(r2.keys('wal-pending/')).toEqual([]);
    expect(pageviews()).toBe(2);
  });

  it('replay is idempotent: a segment applied twice counts once', async () => {
    const key = await batchKey(['t:1']);
    const segment = { parkedAt: T0, reason: 'dlq' as const, messages: [message({ eid: 't:1' })] };
    await writePending(r2 as unknown as R2Bucket, SITE_ID, key, segment);
    await replayPending(env(), T0);
    await writePending(r2 as unknown as R2Bucket, SITE_ID, key, segment);
    await replayPending(env(), T0 + DAY);
    expect(pageviews()).toBe(1);
  });

  it('keeps failed replays pending and moves segments past the horizon to wal-stale', async () => {
    const bucket = r2 as unknown as R2Bucket;
    await writePending(bucket, SITE_ID, 'fresh', {
      parkedAt: T0,
      reason: 'dlq',
      messages: [message({ eid: 't:1' })],
    });
    await writePending(bucket, SITE_ID, 'old', {
      parkedAt: T0 - REPLAY_HORIZON_MS - 1,
      reason: 'dlq',
      messages: [message({ eid: 't:2' })],
    });
    const failed = await replayPending({ ...env(), ANALYTICS: downNamespace }, T0);
    expect(failed).toEqual({ replayed: 0, failed: 1, stale: 1 });
    expect(r2.keys('wal-pending/')).toEqual([`wal-pending/${SITE_ID}/fresh.ndjson.gz`]);
    expect(r2.keys('wal-stale/')).toEqual([`wal-stale/${SITE_ID}/old.ndjson.gz`]);
    expect(pageviews()).toBe(0);
  });

  it('DLQ consumer parks what the DO still refuses and acks once it is on R2', async () => {
    const [b, outcome] = batch([message({ eid: 't:1' })], 'analytics-dlq');
    await consumeDeadLetters(b, { ...env(), ANALYTICS: downNamespace });
    expect(outcome.acked).toEqual(['m0']);
    expect(r2.keys('wal-pending/')).toHaveLength(1);
  });
});

describe('queue sharding', () => {
  it('maps a site to a stable shard and spreads sites over all shards', () => {
    expect(shardIndex(SITE_ID, 4)).toBe(shardIndex(SITE_ID, 4));
    expect(shardIndex(SITE_ID, 1)).toBe(0);
    const used = new Set(
      Array.from({ length: 64 }, (_, i) => shardIndex(`st_${String(i).padStart(20, 'a')}`, 4)),
    );
    expect(used.size).toBe(4);
  });

  it('sends each site to its shard', async () => {
    const shards = [new FakeQueue(), new FakeQueue()];
    const e: Env = {
      ...env(),
      ANALYTICS_QUEUE: shards[0] as unknown as Queue<AnalyticsMessage>,
      ANALYTICS_QUEUE_1: shards[1] as unknown as Queue<AnalyticsMessage>,
    };
    await dispatch(e, [message({ eid: 't:1' })]);
    expect(shards[shardIndex(SITE_ID, 2)]?.sent).toHaveLength(1);
    expect(shards[1 - shardIndex(SITE_ID, 2)]?.sent).toHaveLength(0);
  });
});
