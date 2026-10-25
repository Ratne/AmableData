import { beforeEach, describe, expect, it } from 'vitest';
import { readJsonlGzip } from '../../src/backup/jsonl-gzip';
import { archiveObjectKey, contactPartition, cutoffFor, monthKey, normalizeRetention } from '../../src/archive/model';
import {
  ARCHIVE_STATE_KEY,
  archiveCall,
  archiveTenant,
  runScheduledArchive,
  type ArchiveDeps,
} from '../../src/archive/scheduler';
import { eraseContactFromArchive } from '../../src/archive/erase';
import { frozenStats, liveLinks } from '../../src/broadcast/frozen';
import { createNodeSqlDb } from '../crm/helpers';
import { FakeDos, FakeR2 } from '../backup/helpers';

const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);
const TENANT = 'tenant_acme';
const DAY = 24 * 60 * 60 * 1000;

let r2: FakeR2;
let dos: FakeDos;
let clock: { now: number };
let deps: ArchiveDeps;
let seq = 0;

/** ULID-like ids: lexicographic order follows insertion. */
const id = (prefix: string) => `${prefix}_${String((seq += 1)).padStart(8, '0')}`;

function fakeTenantsDb(ids: string[]): D1Database {
  return {
    prepare: () => ({ all: () => Promise.resolve({ results: ids.map((i) => ({ id: i })) }) }),
  } as unknown as D1Database;
}

function activity(contactId: string | null, at: number, extra: { company?: string } = {}): string {
  const activityId = id('act');
  dos
    .get(TENANT)
    .crm.db.run(
      `INSERT INTO crm_activities (id, type, contact_id, company_id, actor_type, data, occurred_at) VALUES (?, 'note', ?, ?, 'user', ?, ?)`,
      activityId,
      contactId,
      extra.company ?? null,
      JSON.stringify({ text: `at ${at}` }),
      at,
    );
  return activityId;
}

function message(broadcastId: string | null, at: number, opts: { opened?: boolean } = {}): string {
  const messageId = id('msg');
  const mail = dos.get(TENANT).mail;
  mail
    .prepare(
      `INSERT INTO mail_messages (id, request_id, contact_id, email, status, source_type, broadcast_id, sent_at, opened_at, created_at, updated_at)
       VALUES (?, ?, 'c1', 'a@b.c', 'sent', 'broadcast', ?, ?, ?, ?, ?)`,
    )
    .run(messageId, `req_${messageId}`, broadcastId, at, opts.opened === true ? at : null, at, at);
  mail.prepare(`INSERT INTO mail_message_links (message_id, position, url) VALUES (?, 0, 'https://x.test/a')`).run(messageId);
  return messageId;
}

function click(messageId: string, broadcastId: string | null, at: number): void {
  dos
    .get(TENANT)
    .mail.prepare(`INSERT INTO mail_clicks (id, message_id, position, url, broadcast_id, created_at) VALUES (?, ?, 0, 'https://x.test/a', ?, ?)`)
    .run(id('clk'), messageId, broadcastId, at);
}

function count(db: 'crm' | 'mail', sql: string): number {
  const t = dos.get(TENANT);
  const raw = db === 'crm' ? t.crm.db.raw : t.mail;
  return (raw.prepare(sql).get() as { n: number }).n;
}

async function lines(key: string): Promise<Record<string, unknown>[]> {
  const object = await r2.get(key);
  expect(object).not.toBeNull();
  const out: Record<string, unknown>[] = [];
  for await (const line of readJsonlGzip(object?.body as ReadableStream<Uint8Array>)) out.push(line as Record<string, unknown>);
  return out;
}

beforeEach(() => {
  r2 = new FakeR2();
  dos = new FakeDos();
  clock = { now: NOW };
  seq = 0;
  deps = {
    bucket: r2.asBucket(),
    db: fakeTenantsDb([TENANT]),
    stub: (tenantId, db) => dos.archiveStub(tenantId, db, () => clock.now),
    now: () => clock.now,
  };
});

describe('retention model', () => {
  it('cuts at the first instant of a month and keeps everything for 0', () => {
    expect(cutoffFor(24, NOW)).toBe(Date.UTC(2024, 9, 1));
    expect(cutoffFor(0, NOW)).toBeNull();
  });

  it('clamps settings and defaults unknown values', () => {
    expect(normalizeRetention({ crm_events: 1, email: 0, clicks: 500, submissions: 'x' })).toEqual({
      crm_events: 3,
      email: 0,
      clicks: 120,
      submissions: 12,
      esign: 24,
    });
  });
});

describe('archiveTenant', () => {
  it('moves months past the window to R2, then deletes them; recent rows stay', async () => {
    const old = Date.UTC(2024, 0, 15);
    const a1 = activity('contact_A', old);
    const a2 = activity('contact_b', old + DAY, { company: 'co_1' });
    activity('contact_A', Date.UTC(2024, 2, 10));
    const recent = activity('contact_A', Date.UTC(2026, 8, 1));

    const report = await archiveTenant(deps, TENANT, NOW + 10_000);
    expect(report.complete).toBe(true);
    expect(report.prunedRows).toBe(3);
    expect(count('crm', `SELECT COUNT(*) AS n FROM crm_activities`)).toBe(1);
    expect(count('crm', `SELECT COUNT(*) AS n FROM crm_activities WHERE id = '${recent}'`)).toBe(1);

    const contactKey = archiveObjectKey(TENANT, 'crm_activities', '2024-01', contactPartition('contact_A'), 0);
    const rows = await lines(contactKey);
    expect(rows.map((r) => r['id'])).toEqual([a1]);
    expect(rows[0]?.['data']).toEqual({ text: `at ${old}` });
    const companyRows = await lines(archiveObjectKey(TENANT, 'crm_activities', '2024-01', 'company', 0));
    expect(companyRows.map((r) => r['id'])).toEqual([a2]);

    const catalog = await archiveCall<Array<{ month: string; rows: number; final: boolean }>>(deps, TENANT, 'tenant_db', 'catalog', {
      stream: 'crm_activities',
      partition: contactPartition('contact_A'),
    });
    expect(catalog.map((e) => [e.month, e.rows, e.final])).toEqual([
      ['2024-03', 1, true],
      ['2024-01', 1, true],
    ]);
  });

  it('is idempotent: a second pass writes and deletes nothing', async () => {
    activity('contact_A', Date.UTC(2024, 0, 15));
    await archiveTenant(deps, TENANT, NOW + 10_000);
    const objects = r2.objects.size;
    const again = await archiveTenant(deps, TENANT, NOW + 10_000);
    expect(again).toMatchObject({ complete: true, objects: 0, prunedRows: 0 });
    expect(r2.objects.size).toBe(objects);
  });

  it('never deletes rows when the budget runs out before they are written', async () => {
    activity('contact_A', Date.UTC(2024, 0, 15));
    const report = await archiveTenant(deps, TENANT, NOW);
    expect(report.complete).toBe(false);
    expect(count('crm', `SELECT COUNT(*) AS n FROM crm_activities`)).toBe(1);
    expect([...r2.objects.keys()].filter((k) => k.includes('crm_activities'))).toEqual([]);
  });

  it('refuses to prune a month with partitions not recorded yet', async () => {
    activity('contact_A', Date.UTC(2024, 0, 15));
    const result = await dos.archiveStub(TENANT, 'tenant_db').archive('prune', {
      stream: 'crm_activities',
      month: '2024-01',
      cutoff: Date.UTC(2024, 9, 1),
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'not_archived' } });
    const early = await dos.archiveStub(TENANT, 'tenant_db').archive('prune', {
      stream: 'crm_activities',
      month: '2024-01',
      cutoff: Date.UTC(2024, 0, 1),
    });
    expect(early).toMatchObject({ ok: false, error: { code: 'bad_request' } });
    expect(count('crm', `SELECT COUNT(*) AS n FROM crm_activities`)).toBe(1);
  });

  it('archives a row written into an already archived month', async () => {
    activity('contact_A', Date.UTC(2024, 0, 15));
    activity('contact_A', Date.UTC(2023, 11, 15));
    await archiveTenant(deps, TENANT, NOW + 10_000);
    const late = activity('contact_A', Date.UTC(2024, 0, 20));
    await archiveTenant(deps, TENANT, NOW + 10_000);
    expect(count('crm', `SELECT COUNT(*) AS n FROM crm_activities`)).toBe(0);
    const second = await lines(archiveObjectKey(TENANT, 'crm_activities', '2024-01', contactPartition('contact_A'), 1));
    expect(second.map((r) => r['id'])).toEqual([late]);
  });

  it('honours "keep forever" and custom windows from the settings', async () => {
    activity('contact_A', Date.UTC(2024, 0, 15));
    await archiveCall(deps, TENANT, 'tenant_db', 'settings.save', { crm_events: 0 });
    await archiveTenant(deps, TENANT, NOW + 10_000);
    expect(count('crm', `SELECT COUNT(*) AS n FROM crm_activities`)).toBe(1);
  });

  it('freezes broadcast stats before archiving its clicks', async () => {
    const at = Date.UTC(2025, 4, 10);
    const mail = dos.get(TENANT).mail;
    mail
      .prepare(`INSERT INTO mail_broadcasts (id, name, status, created_at, updated_at, started_at) VALUES ('bc_1', 'Spring', 'sent', ?, ?, ?)`)
      .run(at, at, at);
    mail
      .prepare(
        `INSERT INTO mail_broadcast_recipients (broadcast_id, contact_id, time_zone, send_at, status, request_id) VALUES ('bc_1', 'c1', 'UTC', ?, 'enqueued', 'r1')`,
      )
      .run(at);
    const m1 = message('bc_1', at, { opened: true });
    message('bc_1', at);
    click(m1, 'bc_1', at + 1000);
    click(m1, 'bc_1', at + 2000);
    const sql = createNodeSqlDb(mail);
    const before = liveLinks(sql, 'bc_1');

    await archiveTenant(deps, TENANT, NOW + 10_000);

    // Clicks (12 months) are archived, messages (24 months) stay.
    expect(count('mail', `SELECT COUNT(*) AS n FROM mail_clicks`)).toBe(0);
    expect(count('mail', `SELECT COUNT(*) AS n FROM mail_messages`)).toBe(2);
    const frozen = frozenStats(sql, ['bc_1']).get('bc_1');
    expect(frozen?.links).toEqual(before);
    expect(frozen?.totals).toMatchObject({ recipients: 1, sent: 2, opened: 1 });
    expect(frozen?.progress.recipients).toBe(1);
    expect(count('mail', `SELECT COUNT(*) AS n FROM mail_broadcast_recipients`)).toBe(0);
    const archived = await lines(archiveObjectKey(TENANT, 'mail_clicks', monthKey(at), 'bc_1', 0));
    expect(archived).toHaveLength(2);
  });

  it('purges consumed outbox rows past 90 days and keeps pending ones', async () => {
    const crm = dos.get(TENANT).crm.db;
    crm.run(`DELETE FROM crm_outbox`);
    const insert = (rowId: string, dispatched: number | null) =>
      crm.run(
        `INSERT INTO crm_outbox (id, type, payload, actor_type, occurred_at, dispatched_at) VALUES (?, 'x', '{}', 'system', ?, ?)`,
        rowId,
        NOW - 200 * DAY,
        dispatched,
      );
    insert('o1', NOW - 100 * DAY);
    insert('o2', NOW - 10 * DAY);
    insert('o3', null);
    const report = await archiveTenant(deps, TENANT, NOW + 10_000);
    expect(report.outboxRows).toBe(1);
    expect(crm.all<{ id: string }>(`SELECT id FROM crm_outbox ORDER BY id`).map((r) => r.id)).toEqual(['o2', 'o3']);
  });
});

describe('eraseContactFromArchive', () => {
  it("rewrites the contact's objects and the company copies without its rows", async () => {
    const at = Date.UTC(2024, 0, 15);
    activity('contact_A', at, { company: 'co_1' });
    const keep = activity('contact_Q', at + 1000);
    const companyKeep = activity(null, at + 2000, { company: 'co_1' });
    await archiveTenant(deps, TENANT, NOW + 10_000);

    const erased = await eraseContactFromArchive(deps, TENANT, 'contact_A');
    expect(erased).toEqual({ objects: 2, rows: 2 });
    expect((await lines(archiveObjectKey(TENANT, 'crm_activities', '2024-01', 'company', 0))).map((r) => r['id'])).toEqual([companyKeep]);
    expect((await lines(archiveObjectKey(TENANT, 'crm_activities', '2024-01', contactPartition('contact_A'), 0))).map((r) => r['id'])).toEqual([]);
    expect((await lines(archiveObjectKey(TENANT, 'crm_activities', '2024-01', contactPartition('contact_Q'), 0))).map((r) => r['id'])).toEqual([keep]);
    const catalog = await archiveCall<Array<{ rows: number }>>(deps, TENANT, 'tenant_db', 'catalog', { stream: 'crm_activities', partition: 'company' });
    expect(catalog[0]?.rows).toBe(1);
  });
});

describe('runScheduledArchive', () => {
  it('runs each tenant once a day under an R2 lease', async () => {
    activity('contact_A', Date.UTC(2024, 0, 15));
    const first = await runScheduledArchive(deps);
    expect(first).toMatchObject({ status: 'ran', done: [TENANT] });
    expect(await runScheduledArchive(deps)).toMatchObject({ status: 'idle' });
    const state = (await (await r2.get(ARCHIVE_STATE_KEY))?.json()) as { leaseUntil: number | null };
    expect(state.leaseUntil).toBeNull();

    clock.now += DAY;
    expect(await runScheduledArchive(deps)).toMatchObject({ status: 'ran', done: [TENANT] });
  });

  it('skips the tick while another one holds the lease', async () => {
    await r2.put(ARCHIVE_STATE_KEY, JSON.stringify({ version: 1, tenants: {}, retryAt: {}, leaseUntil: NOW + 60_000 }));
    expect(await runScheduledArchive(deps)).toMatchObject({ status: 'locked' });
  });

  it('backs off a failing tenant and goes on with the others', async () => {
    deps = {
      ...deps,
      db: fakeTenantsDb(['tenant_bad', TENANT]),
      stub: (tenantId, db) =>
        tenantId === 'tenant_bad'
          ? { archive: () => Promise.reject(new Error('boom')) }
          : dos.archiveStub(tenantId, db, () => clock.now),
    };
    const summary = await runScheduledArchive(deps);
    expect(summary).toMatchObject({ status: 'ran', failed: ['tenant_bad'], done: [TENANT] });
    clock.now += 10 * 60 * 1000;
    expect(await runScheduledArchive(deps)).toMatchObject({ status: 'idle' });
  });
});
