import { beforeAll, describe, expect, it } from 'vitest';
import { FakeAnalyticsNamespace } from '../../../edge/test/helpers';
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
let strangerSiteId = '';

beforeAll(async () => {
  h = await createHarness();
  ns = new FakeAnalyticsNamespace(() => h.clock.now);
  h.env.ANALYTICS = ns as unknown as Env['ANALYTICS'];
  h.env.APP_ORIGIN = 'https://app.acme.test';
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
  const theirs = await stranger.post(`${OTHER}/sites`, { name: 'Other', hostnames: ['other.test'] });
  strangerSiteId = String((theirs.body['site'] as Record<string, unknown>)['id']);
});

const grantKeys = async () =>
  (await h.env.DB.prepare(`SELECT key, value FROM installation_meta WHERE key LIKE 'ads_grant:%'`).all<{
    key: string;
    value: string;
  }>()).results;

describe('ad connections API', () => {
  let connectionId = '';

  it('lists the platforms of the development installation', async () => {
    const res = await viewer.get(`${BASE}/ads/connections?site_id=${siteId}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: ['meta', 'google', 'tiktok'], fake: true, data: [] });
  });

  it('connects through the fake OAuth round-trip, stores the grant sealed and runs a first sync', async () => {
    expect((await viewer.post(`${BASE}/ads/connections/meta/connect?site_id=${siteId}`)).status).toBe(403);
    const start = await owner.post(`${BASE}/ads/connections/meta/connect?site_id=${siteId}`);
    expect(start.status).toBe(200);
    const url = new URL(String(start.body['authorize_url']));
    expect(url.origin + url.pathname).toBe('https://app.acme.test/t/acme/analytics/settings');
    const state = url.searchParams.get('state') ?? '';
    const code = url.searchParams.get('code') ?? '';
    expect(state).toBe(start.body['state']);

    const forged = await owner.post(`${BASE}/ads/connections/meta/callback?site_id=${siteId}`, { state: 'acme.forged', code });
    expect(forged.status).toBe(422);
    // A state issued for another platform does not complete this one.
    expect(
      (await owner.post(`${BASE}/ads/connections/google/callback?site_id=${siteId}`, { state, code })).status,
    ).toBe(422);

    const again = await owner.post(`${BASE}/ads/connections/meta/connect?site_id=${siteId}`);
    const state2 = new URL(String(again.body['authorize_url'])).searchParams.get('state') ?? '';
    const done = await owner.post(`${BASE}/ads/connections/meta/callback?site_id=${siteId}`, { state: state2, code });
    expect(done.status).toBe(200);
    const [conn] = done.body['data'] as Array<Record<string, unknown>>;
    expect(conn).toMatchObject({
      platform: 'meta',
      account_id: 'fake-meta-dev',
      account_name: 'Fake meta account',
      currency: 'EUR',
      status: 'active',
      last_error: null,
      last_sync_at: h.clock.now,
    });
    expect(conn).not.toHaveProperty('metadata');
    connectionId = String(conn?.['id']);

    const grants = await grantKeys();
    expect(grants).toHaveLength(1);
    expect(grants[0]?.value).not.toContain('fake-access');
    const spend = await ns.store(`site:${siteId}`).listAdSpend({ from: '2026-10-08', to: '2026-10-15' });
    expect(spend.length).toBe(16);

    const list = await viewer.get(`${BASE}/ads/connections?site_id=${siteId}`);
    expect((list.body['data'] as unknown[]).length).toBe(1);
    expect(JSON.stringify(list.body)).not.toContain('fake-access');
  });

  it('backfills a range of at most 90 days', async () => {
    const res = await owner.post(`${BASE}/ads/connections/${connectionId}/backfill?site_id=${siteId}`, {
      from: '2026-09-16',
      to: '2026-10-15',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connection_id: connectionId, from: '2026-09-16', to: '2026-10-15', rows: 60 });
    const tooLong = await owner.post(`${BASE}/ads/connections/${connectionId}/backfill?site_id=${siteId}`, {
      from: '2026-01-01',
      to: '2026-10-15',
    });
    expect(tooLong.status).toBe(422);
    expect(
      (await owner.post(`${BASE}/ads/connections/${connectionId}/backfill?site_id=${siteId}`, { from: 'x', to: 'y' }))
        .status,
    ).toBe(422);
    expect(
      (await viewer.post(`${BASE}/ads/connections/${connectionId}/backfill?site_id=${siteId}`, {
        from: '2026-10-01',
        to: '2026-10-02',
      })).status,
    ).toBe(403);
    expect(
      (await owner.post(`${BASE}/ads/connections/adc_missing/backfill?site_id=${siteId}`, {
        from: '2026-10-01',
        to: '2026-10-02',
      })).status,
    ).toBe(404);
  });

  it('isolates tenants', async () => {
    expect((await stranger.get(`${OTHER}/ads/connections?site_id=${siteId}`)).status).toBe(404);
    expect((await stranger.post(`${OTHER}/ads/connections/meta/connect?site_id=${siteId}`)).status).toBe(404);
    expect((await stranger.delete(`${OTHER}/ads/connections/${connectionId}?site_id=${siteId}`)).status).toBe(404);
    expect(
      (await stranger.post(`${OTHER}/ads/connections/${connectionId}/backfill?site_id=${siteId}`, {
        from: '2026-10-01',
        to: '2026-10-02',
      })).status,
    ).toBe(404);
    // A connection id of another site is unknown on the caller's own site.
    expect((await stranger.delete(`${OTHER}/ads/connections/${connectionId}?site_id=${strangerSiteId}`)).status).toBe(404);
    // A state issued to acme cannot be completed by another workspace, even on its own site.
    const start = await owner.post(`${BASE}/ads/connections/tiktok/connect?site_id=${siteId}`);
    const url = new URL(String(start.body['authorize_url']));
    const stolen = await stranger.post(`${OTHER}/ads/connections/tiktok/callback?site_id=${strangerSiteId}`, {
      state: url.searchParams.get('state'),
      code: url.searchParams.get('code'),
    });
    expect(stolen.status).toBe(422);
    expect((await stranger.get(`${OTHER}/ads/connections?site_id=${strangerSiteId}`)).body['data']).toEqual([]);
    expect((await h.client().get(`${BASE}/ads/connections?site_id=${siteId}`)).status).toBe(401);
  });

  it('disconnects, keeps the synced data and drops the grant', async () => {
    const res = await owner.delete(`${BASE}/ads/connections/${connectionId}?site_id=${siteId}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: connectionId, deleted: true });
    const list = await viewer.get(`${BASE}/ads/connections?site_id=${siteId}`);
    expect((list.body['data'] as Array<Record<string, unknown>>)[0]).toMatchObject({ status: 'disconnected' });
    expect(await grantKeys()).toEqual([]);
    expect((await ns.store(`site:${siteId}`).listAdSpend({ from: '2026-09-16', to: '2026-10-15' })).length).toBe(60);
  });
});
