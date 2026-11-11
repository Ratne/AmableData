import { beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/analytics/store/identity';
import type { AnalyticsMessage } from '../src/analytics/types';
import { gunzipLines, writePending, writeWal, type PendingSegment } from '../src/analytics/wal';
import { ev, FakeAnalyticsNamespace, FakeR2, SITE_ID, siteInit, T0 } from './helpers';

const MIN = 60_000;
let now = T0;
let ns: FakeAnalyticsNamespace;
const site = () => ns.store(`site:${SITE_ID}`);
type Db = { all<T>(q: string, ...a: unknown[]): T[]; run(q: string, ...a: unknown[]): unknown };
const sql = <T = Record<string, unknown>>(q: string) =>
  (site() as unknown as { db: Db }).db.all<T>(q);

const ADA = sha256Hex('ada@example.com');
/** Visitors still identifiable (erased ones live on under `x…` ids). */
const known = () => sql(`SELECT id FROM visitors WHERE id NOT LIKE 'x%' ORDER BY id`);

beforeEach(() => {
  now = T0;
  ns = new FakeAnalyticsNamespace(() => now);
  site().initSite(siteInit());
  site().ingest(
    [
      ev({ vid: 'v-1', sid: 's-1', ts: T0 - 10 * MIN }),
      ev({
        vid: 'v-1',
        sid: 's-1',
        ts: T0 - 9 * MIN,
        type: 'identify',
        identity: { userId: null, email: ADA, name: null, traits: null },
      }),
      ev({ vid: 'v-2', sid: 's-2', ts: T0 - 8 * MIN }),
    ],
    [],
  );
});

describe('visitor suppression', () => {
  it('erases the visitor: identity rows deleted, traffic kept under an id linked to nothing', () => {
    const before = sql<{ n: number }>(`SELECT COUNT(*) AS n FROM pageviews`)[0]?.n;
    const r = site().suppressVisitors({ visitorIds: ['v-1'], keys: [], purge: true });
    expect(r.visitorIds).toEqual(['v-1']);
    expect(r.purgedRows).toBe(1);
    expect(r.jobId).not.toBeNull();
    expect(known()).toEqual([{ id: 'v-2' }]);
    const [anon] = sql<{ id: string; email: string | null; traits: string | null }>(
      `SELECT id, email, traits FROM visitors WHERE id LIKE 'x%'`,
    );
    expect(anon).toMatchObject({ email: null, traits: null });
    // Rollups recomputed later still count the traffic.
    expect(sql<{ n: number }>(`SELECT COUNT(*) AS n FROM pageviews`)[0]?.n).toBe(before);
    expect(sql(`SELECT DISTINCT visitor_id FROM pageviews ORDER BY visitor_id`)).toEqual([
      { visitor_id: 'v-2' },
      { visitor_id: anon?.id },
    ]);
    expect(sql(`SELECT visitor_id FROM identity_keys WHERE visitor_id = 'v-1'`)).toHaveLength(0);
    expect(
      sql(
        `SELECT visitor_id FROM identity_keys WHERE visitor_id = ?`.replace('?', `'${anon?.id}'`),
      ),
    ).toHaveLength(0);
    expect(site().edgeConfig()?.suppressed.visitors).toEqual(['v-1']);

    // Late or replayed events of the tombstone are never applied again.
    const again = site().ingest([ev({ vid: 'v-1', sid: 's-9', ts: T0 - MIN })], []);
    expect(again.ingested).toBe(0);
    expect(sql(`SELECT id FROM visitors WHERE id = 'v-1'`)).toHaveLength(0);
  });

  it('suppresses by hashed identity: the carriers now and any new visitor carrying it', () => {
    const r = site().suppressVisitors({
      visitorIds: [],
      keys: [{ type: 'email', hash: ADA }],
      purge: true,
    });
    expect(r.visitorIds).toEqual(['v-1']);
    site().ingest(
      [
        ev({ vid: 'v-3', sid: 's-3', ts: T0 - 2 * MIN }),
        ev({
          vid: 'v-3',
          sid: 's-3',
          ts: T0 - MIN,
          type: 'identify',
          identity: { userId: null, email: ADA, name: null, traits: null },
        }),
      ],
      [],
    );
    expect(known()).toEqual([{ id: 'v-2' }]);
    expect(site().edgeConfig()?.suppressed.keys).toEqual([ADA]);
    // Found on ingest with a purging key: erased and queued for the R2 rewrite as well.
    expect(site().purgeJobs()).toHaveLength(2);
    expect(sql(`SELECT vid FROM suppressed_visitors ORDER BY vid`)).toEqual([
      { vid: 'v-1' },
      { vid: 'v-3' },
    ]);
  });

  it('follows active merges only: an undone merge is another person', () => {
    const db = (site() as unknown as { db: Db }).db;
    db.run(`INSERT INTO visitor_merges VALUES ('v-1', 'v-2', 'email', 0, ?, ?)`, T0, T0);
    expect(
      site().suppressVisitors({ visitorIds: ['v-1'], keys: [], purge: true }).visitorIds,
    ).toEqual(['v-1']);
    expect(known()).toEqual([{ id: 'v-2' }]);
    db.run(`INSERT INTO visitor_merges VALUES ('v-3', 'v-2', 'email', 1, ?, ?)`, T0, T0);
    expect(
      site()
        .suppressVisitors({ visitorIds: ['v-3'], keys: [], purge: true })
        .visitorIds.sort(),
    ).toEqual(['v-2', 'v-3']);
  });

  it('without purge only blocks what comes next', () => {
    const r = site().suppressVisitors({ visitorIds: ['v-2'], keys: [], purge: false });
    expect(r.jobId).toBeNull();
    expect(sql(`SELECT id FROM visitors WHERE id = 'v-2'`)).toHaveLength(1);
    site().ingest([ev({ vid: 'v-2', sid: 's-2b', ts: T0 - MIN })], []);
    expect(sql(`SELECT id FROM sessions WHERE id = 's-2b'`)).toHaveLength(0);
  });

  it('a key with no carrier on the site still blocks, and a blocking key never erases', () => {
    const BOB = sha256Hex('bob@example.com');
    site().suppressVisitors({ visitorIds: [], keys: [{ type: 'email', hash: BOB }], purge: false });
    expect(sql(`SELECT vid FROM suppressed_visitors`)).toEqual([]);
    site().ingest(
      [
        ev({
          vid: 'v-2',
          sid: 's-2',
          ts: T0 - MIN,
          type: 'payment',
          payment: {
            transactionId: 'tx-b',
            amountMinor: 100,
            currency: 'EUR',
            email: BOB,
            customerId: null,
            renewal: false,
            refunded: false,
            freeTrial: false,
          },
        } as never),
      ],
      [],
    );
    expect(sql(`SELECT vid FROM suppressed_visitors`)).toEqual([{ vid: 'v-2' }]);
    expect(sql(`SELECT id FROM visitors WHERE id = 'v-2'`)).toHaveLength(1);
    expect(site().purgeJobs()).toHaveLength(0);
  });
});

describe('purge job on R2', () => {
  it('rewrites archive, ledgers, parked segments and retention rows, then stops', async () => {
    const bucket = new FakeR2();
    const r2 = bucket as unknown as R2Bucket;
    const m = (vid: string, ts: number): AnalyticsMessage => ({
      kind: 'event',
      event: ev({ vid, sid: `s-${vid}`, ts }),
    });
    await writeWal(r2, SITE_ID, [m('v-1', T0 - 10 * MIN), m('v-2', T0 - 8 * MIN)], 'k1');
    await writeWal(r2, SITE_ID, [m('v-1', T0 - 9 * MIN)], 'k2');
    const segment: PendingSegment = { parkedAt: T0, reason: 'dlq', messages: [m('v-1', T0)] };
    await writePending(r2, SITE_ID, 'k3', segment);
    await bucket.put(
      `analytics-archive/${SITE_ID}/pageviews/2026-01-01-x.ndjson`,
      `${JSON.stringify({ visitor_id: 'v-1' })}\n${JSON.stringify({ visitor_id: 'v-2' })}\n`,
    );
    // Days before the visitor's first_seen are rewritten too (the archive is permanent).
    await writeWal(r2, SITE_ID, [m('v-1', T0 - 40 * 86_400_000)], 'k0');

    site().suppressVisitors({ visitorIds: ['v-1'], keys: [], purge: true });
    expect(await site().runPurge(r2)).toBe(false);
    expect(site().purgeJobs()[0]?.status).toBe('running');

    now = T0 + 10 * MIN;
    expect(await site().runPurge(r2)).toBe(false);
    expect(site().purgeJobs()[0]).toMatchObject({
      status: 'running',
      rewritten: 5,
      tail: 1,
      visitors: 1,
    });

    const day = new Date(T0).toISOString().slice(0, 10);
    const events = bucket.keys(`events/${SITE_ID}/${day}/`);
    expect(events).toHaveLength(1);
    const kept = await gunzipLines<AnalyticsMessage>(
      (bucket.objects.get(events[0] as string) as { body: Uint8Array }).body,
    );
    expect(kept.map((x) => (x.kind === 'event' ? x.event.vid : ''))).toEqual(['v-2']);
    expect(bucket.keys(`wal-pending/${SITE_ID}/`)).toHaveLength(0);
    const rows = new TextDecoder().decode(
      bucket.objects.get(`analytics-archive/${SITE_ID}/pageviews/2026-01-01-x.ndjson`)?.body,
    );
    expect(rows).toBe(`${JSON.stringify({ visitor_id: 'v-2' })}\n`);
    expect(bucket.keys(`events/${SITE_ID}/`).length).toBe(1);

    // A batch retried after the first pass is caught by the daily tail rescan.
    await writeWal(r2, SITE_ID, [m('v-1', T0 + 5 * MIN)], 'k9');
    now = T0 + 10 * MIN + 86_400_000;
    await site().runPurge(r2);
    expect(bucket.keys(`events/${SITE_ID}/`).length).toBe(1);

    // Past the tail the job is done.
    now = T0 + 16 * 86_400_000;
    await site().runPurge(r2);
    expect(site().purgeJobs()[0]?.status).toBe('done');
  });

  it('skips an unreadable object and counts it, the job still completes its pass', async () => {
    const bucket = new FakeR2();
    const r2 = bucket as unknown as R2Bucket;
    await bucket.put(`events/${SITE_ID}/2026-01-01/broken.ndjson.gz`, 'not gzip');
    site().suppressVisitors({ visitorIds: ['v-1'], keys: [], purge: true });
    now = T0 + 10 * MIN;
    await site().runPurge(r2);
    expect(site().purgeJobs()[0]).toMatchObject({ failed: 1, tail: 1 });
  });
});
