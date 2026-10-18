import type { OutboundConversionJob } from '@amable/api-types';
import { beforeAll, describe, expect, it } from 'vitest';
import { FakeAnalyticsNamespace, T0 } from '../../../edge/test/helpers';
import type { Env } from '../../src/env';
import {
  addMember,
  createHarness,
  login,
  seedTenant,
  seedUser,
  type Harness,
  type TestClient,
} from '../helpers/harness';

const BASE = '/api/v2/t/acme/analytics';
const OTHER = '/api/v2/t/other/analytics';

let h: Harness;
let ns: FakeAnalyticsNamespace;
let owner: TestClient;
let viewer: TestClient;
let stranger: TestClient;
let siteId = '';
const ids: Record<string, string> = {};

beforeAll(async () => {
  h = await createHarness();
  ns = new FakeAnalyticsNamespace(() => h.clock.now);
  h.env.ANALYTICS = ns as unknown as Env['ANALYTICS'];
  h.env.EDGE_ORIGIN = 'https://t.acme.test';
  const acme = await seedTenant(h, 'acme');
  const other = await seedTenant(h, 'other');
  const o = await seedUser(h, { email: 'owner@example.com' });
  const v = await seedUser(h, { email: 'viewer@example.com' });
  const x = await seedUser(h, { email: 'stranger@example.com' });
  await addMember(h, o.id, acme.id, 'owner');
  await addMember(h, v.id, acme.id, 'viewer');
  await addMember(h, x.id, other.id, 'owner');
  owner = await login(h, 'owner@example.com');
  viewer = await login(h, 'viewer@example.com');
  stranger = await login(h, 'stranger@example.com');
  const created = await owner.post(`${BASE}/sites`, { name: 'Acme', hostnames: ['acme.test'] });
  siteId = String((created.body['site'] as Record<string, unknown>)['id']);

  const store = ns.store(`site:${siteId}`);
  const enqueue = (eventId: string, platform: 'meta' | 'google', connection: string) => {
    const r = store.enqueueOutbound({
      platform,
      connection_id: connection,
      kind: 'purchase',
      event_id: eventId,
      payload: {
        event_name: 'Purchase',
        event_time: T0,
        value_minor: 4900,
        currency: 'EUR',
        email: 'buyer@example.com',
        phone: '+393331234567',
        ip: '203.0.113.7',
        user_agent: 'Mozilla/5.0',
        click_ids: { fbclid: 'fb.1' },
      },
    });
    if (!r.ok) throw new Error(r.error.message);
    ids[eventId] = r.value.id;
  };
  enqueue('ev-pending', 'meta', 'conn-meta');
  enqueue('ev-failed-1', 'meta', 'conn-meta');
  enqueue('ev-failed-2', 'google', 'conn-google');
  store.settleOutbound(ids['ev-failed-1']!, { status: 'failed', error: 'permanent: invalid token' });
  store.settleOutbound(ids['ev-failed-2']!, { status: 'failed', error: 'permanent: bad request' });
});

const sq = () => `site_id=${siteId}`;

describe('outbound conversions API', () => {
  it('lists the log with stats and never exposes personal data', async () => {
    const res = await viewer.get(`${BASE}/outbound?${sq()}`);
    expect(res.status).toBe(200);
    const data = res.body['data'] as OutboundConversionJob[];
    expect(data).toHaveLength(3);
    expect(res.body['stats']).toEqual({ pending: 1, sent: 0, failed: 2, skipped: 0 });
    for (const job of data) {
      expect(job.payload).not.toHaveProperty('email');
      expect(job.payload).not.toHaveProperty('phone');
      expect(job.payload).not.toHaveProperty('ip');
      expect(job.payload).not.toHaveProperty('user_agent');
      expect(job.payload).toMatchObject({ event_name: 'Purchase', value_minor: 4900, click_ids: { fbclid: 'fb.1' } });
    }
    expect(JSON.stringify(res.body)).not.toContain('buyer@example.com');
  });

  it('filters by status, platform, connection, event id and date', async () => {
    const get = async (q: string) => ((await viewer.get(`${BASE}/outbound?${sq()}&${q}`)).body['data'] as OutboundConversionJob[]).map((j) => j.event_id).sort();
    expect(await get('status=failed')).toEqual(['ev-failed-1', 'ev-failed-2']);
    expect(await get('platform=google')).toEqual(['ev-failed-2']);
    expect(await get('connection_id=conn-meta')).toEqual(['ev-failed-1', 'ev-pending']);
    expect(await get('event_id=ev-pending')).toEqual(['ev-pending']);
    expect(await get('from=2026-10-16')).toEqual([]);
    expect(await get('from=2026-10-15&to=2026-10-15')).toHaveLength(3);
    expect((await viewer.get(`${BASE}/outbound?${sq()}&status=nope`)).status).toBe(422);
  });

  it('flags the list as truncated when more jobs match than the limit', async () => {
    const list = async (q: string) => (await viewer.get(`${BASE}/outbound?${sq()}&${q}`)).body;
    expect(await list('limit=3')).toMatchObject({ truncated: false });
    expect(await list('limit=2')).toMatchObject({ truncated: true });
    expect(await list('limit=2&status=failed')).toMatchObject({ truncated: false });
    expect(await list('limit=1&status=failed')).toMatchObject({ truncated: true });
    expect(await list('limit=1&platform=google')).toMatchObject({ truncated: false });
  });

  it('reads one job', async () => {
    const res = await viewer.get(`${BASE}/outbound/${ids['ev-pending']}?${sq()}`);
    expect(res.status).toBe(200);
    expect(res.body['event_id']).toBe('ev-pending');
    expect(res.body['payload']).not.toHaveProperty('email');
    expect((await viewer.get(`${BASE}/outbound/nope?${sq()}`)).status).toBe(404);
  });

  it('resends one failed job; pending ones are left alone', async () => {
    expect((await viewer.post(`${BASE}/outbound/${ids['ev-failed-1']}/resend?${sq()}`)).status).toBe(403);
    const res = await owner.post(`${BASE}/outbound/${ids['ev-failed-1']}/resend?${sq()}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ requeued: 1 });
    const job = await viewer.get(`${BASE}/outbound/${ids['ev-failed-1']}?${sq()}`);
    expect(job.body).toMatchObject({ status: 'pending', attempts: 0 });
    expect((await owner.post(`${BASE}/outbound/${ids['ev-pending']}/resend?${sq()}`)).body).toEqual({ requeued: 0 });
    expect((await owner.post(`${BASE}/outbound/nope/resend?${sq()}`)).status).toBe(404);
  });

  it('resends in bulk by ids or by filter', async () => {
    const store = ns.store(`site:${siteId}`);
    store.settleOutbound(ids['ev-failed-1']!, { status: 'failed', error: 'again' });
    const byFilter = await owner.post(`${BASE}/outbound/resend?${sq()}`, { platform: 'google' });
    expect(byFilter.body).toEqual({ requeued: 1 });
    expect(store.getOutbound(ids['ev-failed-2']!)?.status).toBe('pending');
    const byIds = await owner.post(`${BASE}/outbound/resend?${sq()}`, { ids: [ids['ev-failed-1'], ids['ev-pending']] });
    expect(byIds.body).toEqual({ requeued: 1 });
    expect((await owner.post(`${BASE}/outbound/resend?${sq()}`, { ids: [] })).status).toBe(422);
    expect((await owner.post(`${BASE}/outbound/resend?${sq()}`, { platform: 'nope' })).status).toBe(422);
    expect((await viewer.post(`${BASE}/outbound/resend?${sq()}`, {})).status).toBe(403);
  });

  it("isolates tenants: another tenant's site is a 404 on every endpoint", async () => {
    const q = `site_id=${siteId}`;
    const statuses = [
      (await stranger.get(`${OTHER}/outbound?${q}`)).status,
      (await stranger.get(`${OTHER}/outbound/${ids['ev-pending']}?${q}`)).status,
      (await stranger.post(`${OTHER}/outbound/${ids['ev-failed-1']}/resend?${q}`)).status,
      (await stranger.post(`${OTHER}/outbound/resend?${q}`, {})).status,
    ];
    expect(statuses).toEqual([404, 404, 404, 404]);
  });
});
