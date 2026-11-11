import { beforeAll, describe, expect, it } from 'vitest';
import { ev, FakeAnalyticsNamespace } from '../../../edge/test/helpers';
import type { Env } from '../../src/env';
import { fakeTenantDbNamespace } from '../crm/helpers';
import type { AnalyticsNamespace } from '@amable/app-edge/analytics';
import { syncPorts } from '../../src/analytics/runtime';
import { sweepSales } from '../../src/analytics/sales-dispatch';
import { SYSTEM_ACTOR } from '../../src/crm/context';
import {
  addMember,
  createHarness,
  login,
  seedTenant,
  seedUser,
  stepUp,
  type Harness,
  type TestClient,
} from '../helpers/harness';

const MIN = 60_000;

let h: Harness;
let ns: FakeAnalyticsNamespace;
let owner: TestClient;
let siteA = '';
let siteB = '';
let ingestKey: Record<string, string>;
let readKey: Record<string, string>;

type Row = Record<string, unknown>;
type Db = { all<T>(q: string, ...a: unknown[]): T[] };
const sql = (siteId: string, query: string, ...args: unknown[]) =>
  (ns.store(`site:${siteId}`) as unknown as { db: Db }).db.all<Row>(query, ...args);

async function key(scopes: string[]): Promise<Record<string, string>> {
  const res = await owner.post('/api/t/acme/api-keys', { name: scopes.join(','), scopes });
  expect(res.status).toBe(201);
  return { authorization: `Bearer ${res.body['key'] as string}`, origin: '' };
}

const api = (path: string, body: unknown, auth = ingestKey) =>
  h.client().post(`/api/v1${path}`, body, auth);

beforeAll(async () => {
  h = await createHarness();
  ns = new FakeAnalyticsNamespace(() => h.clock.now);
  h.env.ANALYTICS = ns as unknown as Env['ANALYTICS'];
  h.env.EDGE_ORIGIN = 'https://t.acme.test';
  h.env.TENANT_DB = fakeTenantDbNamespace(() => h.clock.now);
  const acme = await seedTenant(h, 'acme');
  await seedTenant(h, 'other');
  const o = await seedUser(h, { email: 'owner@example.com' });
  await addMember(h, o.id, acme.id, 'owner');
  owner = await login(h, 'owner@example.com');
  for (const name of ['A', 'B']) {
    const res = await owner.post('/api/v2/t/acme/analytics/sites', {
      name,
      hostnames: [`${name.toLowerCase()}.test`],
    });
    const id = String((res.body['site'] as Row)['id']);
    if (name === 'A') siteA = id;
    else siteB = id;
  }
  await stepUp(h, owner);
  ingestKey = await key(['tracking:ingest']);
  readKey = await key(['contacts:read']);
  const now = h.clock.now;
  // v-a1 on site A (seen 30 min ago), v-b1 on site B (seen 5 min ago), v-a2 anonymous on A.
  ns.store(`site:${siteA}`).ingest(
    [
      ev({ vid: 'visitor-a1', sid: 's-a1', ts: now - 30 * MIN }),
      ev({ vid: 'visitor-a2', sid: 's-a2', ts: now - 20 * MIN }),
    ],
    [],
  );
  ns.store(`site:${siteB}`).ingest([ev({ vid: 'visitor-b1', sid: 's-b1', ts: now - 5 * MIN })], []);
});

describe('/api/v1 access', () => {
  it('needs a workspace API key with tracking:ingest', async () => {
    const lead = { email: 'x@example.com' };
    expect((await h.client().post('/api/v1/leads', lead)).status).toBe(401);
    const session = await owner.post('/api/v1/leads', lead);
    expect(session.status).toBe(401);
    expect(session.body['error']).toBe('api_key_required');
    expect((await api('/leads', lead, readKey)).status).toBe(403);
  });

  it('validates the body', async () => {
    expect((await api('/leads', {})).status).toBe(422);
    expect((await api('/leads', { email: 'nope' })).status).toBe(422);
    expect((await api('/leads', { phone: 'abc' })).status).toBe(422);
    expect((await api('/leads', { email: 'a@b.it', site_id: 'st_missing' })).status).toBe(404);
  });
});

describe('POST /api/v1/leads', () => {
  it('creates the contact, links the visitor and records the lead goal once', async () => {
    const body = {
      event_id: 'lead-1',
      email: 'Ada@Example.com',
      phone: '+39 333 123 4567',
      first_name: 'Ada',
      last_name: 'Lovelace',
      visitor_id: 'visitor-a1',
      source: 'webinar',
    };
    const res = await api('/leads', body);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ created: true, site_id: siteA, visitor_id: 'visitor-a1' });
    const goals = sql(siteA, `SELECT visitor_id, params FROM goals WHERE name = 'lead'`);
    expect(goals).toEqual([{ visitor_id: 'visitor-a1', params: '{"source":"webinar"}' }]);
    // The site holds the link, never the clear email.
    expect(JSON.stringify(sql(siteA, `SELECT * FROM visitors`))).not.toContain('@');
    expect(JSON.stringify(sql(siteA, `SELECT * FROM identity_keys`))).not.toContain('example');

    const again = await api('/leads', body);
    expect(again.body).toMatchObject({ contact_id: res.body['contact_id'], created: false });
    expect(sql(siteA, `SELECT id FROM goals WHERE name = 'lead'`)).toHaveLength(1);
  });

  it('puts a lead without visitor on the contact visitor seen last', async () => {
    const res = await api('/leads', {
      event_id: 'lead-2',
      email: 'ada@example.com',
      visitor_id: 'visitor-b1',
    });
    expect(res.body).toMatchObject({ created: false, site_id: siteB, visitor_id: 'visitor-b1' });
    const third = await api('/leads', { event_id: 'lead-3', email: 'ada@example.com' });
    // visitor-b1 (5 min ago) is more recent than visitor-a1 (30 min ago).
    expect(third.body).toMatchObject({ site_id: siteB, visitor_id: 'visitor-b1' });
    expect(sql(siteB, `SELECT id FROM goals WHERE name = 'lead'`)).toHaveLength(2);
  });

  it('records a contact without any visitor (unplaced lead)', async () => {
    const res = await api('/leads', { event_id: 'lead-4', email: 'nobody@example.com' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ created: true, site_id: null, visitor_id: null });
  });
});

describe('POST /api/v1/sales', () => {
  it('routes the sale to the last-touch site once and dedupes retries', async () => {
    const sale = {
      transaction_id: 'tx-1',
      amount: 49.9,
      currency: 'eur',
      email: 'ada@example.com',
    };
    const res = await api('/sales', sale);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      transaction_id: 'tx-1',
      site_id: siteB,
      visitor_id: 'visitor-b1',
      attribution: 'last_touch',
      duplicate: false,
    });
    const paid = sql(
      siteB,
      `SELECT visitor_id, amount_minor, currency FROM payments WHERE transaction_id = 'tx-1'`,
    );
    expect(paid).toEqual([{ visitor_id: 'visitor-b1', amount_minor: 4990, currency: 'EUR' }]);

    // A newer visit on site A does not move a sale already decided.
    ns.store(`site:${siteA}`).ingest(
      [ev({ vid: 'visitor-a1', sid: 's-a1b', ts: h.clock.now })],
      [],
    );
    const retry = await api('/sales', sale);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ site_id: siteB, duplicate: true });
    expect(sql(siteA, `SELECT id FROM payments`)).toHaveLength(0);
    expect(sql(siteB, `SELECT id FROM payments WHERE transaction_id = 'tx-1'`)).toHaveLength(1);

    const changed = await api('/sales', { ...sale, amount: 10 });
    expect(changed.status).toBe(409);
  });

  it('honours a forced site and the given visitor', async () => {
    const forced = await api('/sales', {
      transaction_id: 'tx-2',
      amount: 10,
      currency: 'EUR',
      visitor_id: 'visitor-a2',
      site_id: siteA,
    });
    expect(forced.body).toMatchObject({
      site_id: siteA,
      visitor_id: 'visitor-a2',
      attribution: 'forced',
      contact_id: null,
    });
    const byVisitor = await api('/sales', {
      transaction_id: 'tx-3',
      amount: 10,
      currency: 'EUR',
      visitor_id: 'visitor-a2',
      email: 'grace@example.com',
    });
    expect(byVisitor.body).toMatchObject({
      site_id: siteA,
      visitor_id: 'visitor-a2',
      attribution: 'visitor',
    });
    expect(sql(siteA, `SELECT visitor_id FROM payments WHERE transaction_id = 'tx-3'`)).toEqual([
      { visitor_id: 'visitor-a2' },
    ]);
  });

  it('joins the browser payment already recorded with the same transaction id', async () => {
    ns.store(`site:${siteA}`).ingest(
      [
        ev({
          vid: 'visitor-a2',
          sid: 's-a2',
          ts: h.clock.now - MIN,
          type: 'payment',
          payment: {
            transactionId: 'tx-web',
            amountMinor: 3000,
            currency: 'EUR',
            email: null,
            customerId: null,
            renewal: false,
            refunded: false,
            freeTrial: false,
          },
        } as never),
      ],
      [],
    );
    const res = await api('/sales', {
      transaction_id: 'tx-web',
      amount: 30,
      currency: 'EUR',
      site_id: siteB,
      email: 'web@example.com',
    });
    expect(res.body).toMatchObject({
      site_id: siteA,
      visitor_id: 'visitor-a2',
      attribution: 'existing',
    });
    expect(sql(siteB, `SELECT 1 FROM payments WHERE transaction_id = 'tx-web'`)).toHaveLength(0);
  });

  it('keeps an unattributed sale in the workspace', async () => {
    const res = await api('/sales', {
      transaction_id: 'tx-4',
      amount: 5,
      currency: 'EUR',
      email: 'walkin@example.com',
    });
    expect(res.body).toMatchObject({ site_id: null, attribution: 'unattributed' });
    const refund = await api('/sales/tx-4/refunds', { refund_id: 'r-4' });
    expect(refund.body).toMatchObject({ amount: 5, refunded_total: 5, duplicate: false });
  });
});

describe('POST /api/v1/sales/{id}/refunds', () => {
  it('refunds on the stored site, once per refund id, capped at the sale', async () => {
    const part = await api('/sales/tx-1/refunds', { refund_id: 'r-1', amount: 9.9 });
    expect(part.status).toBe(201);
    expect(part.body).toMatchObject({ amount: 9.9, refunded_total: 9.9 });
    const replay = await api('/sales/tx-1/refunds', { refund_id: 'r-1', amount: 9.9 });
    expect(replay.status).toBe(200);
    expect(replay.body['duplicate']).toBe(true);
    const rest = await api('/sales/tx-1/refunds', { refund_id: 'r-2' });
    expect(rest.body).toMatchObject({ amount: 40, refunded_total: 49.9 });
    expect(
      sql(siteB, `SELECT refunded_minor, refunded FROM payments WHERE transaction_id = 'tx-1'`),
    ).toEqual([{ refunded_minor: 4990, refunded: 1 }]);
    expect((await api('/sales/tx-1/refunds', { refund_id: 'r-3' })).status).toBe(409);
    expect((await api('/sales/tx-missing/refunds', { refund_id: 'r-9' })).status).toBe(404);
  });
});

describe('POST /api/v1/events', () => {
  it('ingests a server event on a workspace site', async () => {
    const res = await api('/events', {
      site_id: siteA,
      type: 'goal',
      event_id: 'ev-1',
      visitor_id: 'visitor-a2',
      name: 'demo_booked',
    });
    expect(res.status).toBe(202);
    expect(sql(siteA, `SELECT visitor_id FROM goals WHERE name = 'demo_booked'`)).toEqual([
      { visitor_id: 'visitor-a2' },
    ]);
    expect(
      (
        await api('/events', {
          site_id: 'st_nope',
          type: 'goal',
          visitor_id: 'visitor-a2',
          name: 'x',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api('/events', {
          site_id: siteA,
          type: 'crawler',
          url: 'https://a.test/',
          user_agent: 'x',
        })
      ).status,
    ).toBe(422);
  });
});

describe('sale sweep', () => {
  it('applies a placed sale a failed request left undispatched', async () => {
    const tenantDb = h.env.TENANT_DB.get(h.env.TENANT_DB.idFromName('t_acme'));
    const recorded = (await tenantDb.crm('analytics.recordSale', SYSTEM_ACTOR, {
      transactionId: 'tx-crashed',
      contactId: null,
      amountMinor: 1200,
      currency: 'EUR',
      orderId: null,
      renewal: false,
      occurredAt: h.clock.now,
      siteId: siteA,
      visitorId: 'visitor-a2',
      decidedBy: 'forced',
    })) as { ok: boolean };
    expect(recorded.ok).toBe(true);
    h.clock.now += 2 * MIN;
    const ports = syncPorts(h.env, ns as unknown as AnalyticsNamespace, 't_acme');
    expect(await sweepSales({ ...ports, now: () => h.clock.now }, 't_acme')).toBe(1);
    expect(
      sql(siteA, `SELECT visitor_id FROM payments WHERE transaction_id = 'tx-crashed'`),
    ).toEqual([{ visitor_id: 'visitor-a2' }]);
    expect(await sweepSales({ ...ports, now: () => h.clock.now }, 't_acme')).toBe(0);
  });
});

describe('sale on a deleted site', () => {
  it('becomes unattributed instead of looking applied', async () => {
    const tenantDb = h.env.TENANT_DB.get(h.env.TENANT_DB.idFromName('t_acme'));
    await tenantDb.crm('analytics.recordSale', SYSTEM_ACTOR, {
      transactionId: 'tx-gone',
      contactId: null,
      amountMinor: 500,
      currency: 'EUR',
      orderId: null,
      renewal: false,
      occurredAt: h.clock.now,
      siteId: 'st_deleted',
      visitorId: null,
      decidedBy: 'forced',
    });
    h.clock.now += 2 * MIN;
    const ports = syncPorts(h.env, ns as unknown as AnalyticsNamespace, 't_acme');
    expect(await sweepSales({ ...ports, now: () => h.clock.now }, 't_acme')).toBe(1);
    const sale = await ports.crm<Row>('analytics.getSale', { transactionId: 'tx-gone' });
    expect(sale).toMatchObject({ site_id: null, decided_by: 'unattributed' });
    expect(await sweepSales({ ...ports, now: () => h.clock.now }, 't_acme')).toBe(0);
  });
});

describe('suppressions (opt-out / erasure)', () => {
  it('an ingest-only key may block but not erase', async () => {
    const res = await api('/suppressions', { visitor_id: 'visitor-zz', reason: 'opt-out' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ missing: ['tracking:erase'] });
    const block = await api('/suppressions', { visitor_id: 'visitor-zz', purge: false });
    expect(block.status).toBe(200);
  });

  it('erases a person across sites and keeps them out of the registry and of new sites', async () => {
    const eraseKey = await key(['tracking:ingest', 'tracking:erase']);
    const res = await api(
      '/suppressions',
      { email: 'ada@example.com', reason: 'gdpr erasure' },
      eraseKey,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sites: 2 });
    expect(Number(res.body['visitors'])).toBeGreaterThanOrEqual(2);
    expect(sql(siteA, `SELECT id FROM visitors WHERE id = 'visitor-a1'`)).toHaveLength(0);
    expect(sql(siteB, `SELECT id FROM visitors WHERE id = 'visitor-b1'`)).toHaveLength(0);
    // Revenue stays in the site totals, linked to nobody.
    expect(
      sql(
        siteB,
        `SELECT visitor_id, email, contact_id FROM payments WHERE transaction_id = 'tx-1'`,
      ),
    ).toEqual([{ visitor_id: expect.stringMatching(/^x/), email: null, contact_id: null }]);
    expect(sql(siteA, `SELECT vid FROM suppressed_visitors WHERE vid = 'visitor-a1'`)).toHaveLength(
      1,
    );
    const tenant = ns.store('tenant:t_acme') as unknown as { db: Db };
    expect(
      tenant.db.all(
        `SELECT * FROM contact_visitors WHERE visitor_id IN ('visitor-a1', 'visitor-b1')`,
      ),
    ).toHaveLength(0);

    // The registry no longer (re)links the person from web data.
    const lead = await api('/leads', {
      event_id: 'lead-after',
      email: 'ada@example.com',
      visitor_id: 'visitor-a2',
    });
    expect(lead.body).toMatchObject({ contact_id: null, created: false });

    const listed = await owner.get('/api/v2/t/acme/analytics/suppressions');
    expect(listed.status).toBe(200);
    const kinds = (listed.body['data'] as Row[]).map((r) => r['kind']);
    expect(kinds).toContain('email');
    expect(kinds).toContain('visitor');
    expect((listed.body['purge_jobs'] as Row[]).length).toBeGreaterThanOrEqual(1);

    const created = await owner.post('/api/v2/t/acme/analytics/sites', {
      name: 'C',
      hostnames: ['c.test'],
    });
    const siteC = String((created.body['site'] as Row)['id']);
    // The email led to the contact: its phone is suppressed too.
    expect(sql(siteC, `SELECT key_type FROM suppressed_keys ORDER BY key_type`)).toEqual([
      { key_type: 'email' },
      { key_type: 'phone' },
    ]);
  });

  it('validates the request', async () => {
    expect((await api('/suppressions', {})).status).toBe(422);
  });
});
