import { createSecretBox, randomBytes, toBase64 } from '@amable/auth';
import { createFakeProvider, ProviderError, type AdsProvider } from '@amable/ads-providers';
import type { AdPlatform } from '@amable/api-types';
import type { AdConnectionRecord, AnalyticsNamespace } from '@amable/app-edge/analytics';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeAnalyticsNamespace, siteInit, T0 } from '../../../edge/test/helpers';
import {
  aggregateSpend,
  adsStub,
  backfillAdConnection,
  disconnectAdConnection,
  finishAdsConnect,
  kvAdGrantStore,
  RECONCILE_DAYS,
  startAdsConnect,
  syncAdConnection,
  syncAllAds,
  type AdConnectionAlert,
  type AdsSyncPorts,
  type SiteRef,
} from '../../src/analytics/ads-sync';
import type { AdPlatformClients } from '../../src/analytics/integrations';

const MIN = 60_000;
const HOUR = 60 * MIN;
const TODAY = '2026-10-15'; // T0 = 12:00 in Europe/Rome, the fake account time zone

const SITE_A: SiteRef = { tenantId: 'tenant_a', id: 'st_aaaaaaaaaaaaaaaaaaaa', name: 'Site A' };
const SITE_B: SiteRef = { tenantId: 'tenant_a', id: 'st_bbbbbbbbbbbbbbbbbbbb', name: 'Site B' };
const SITE_C: SiteRef = { tenantId: 'tenant_c', id: 'st_cccccccccccccccccccc', name: 'Site C' };

type Override = (base: AdsProvider) => Partial<AdsProvider>;
interface Call {
  platform: AdPlatform;
  method: string;
  args: unknown[];
}

const METHODS = ['authorizeUrl', 'exchangeCode', 'refreshToken', 'listAccounts', 'listEntities', 'fetchSpend'] as const;

let clock: { now: number };
let ns: FakeAnalyticsNamespace;
let edge: AnalyticsNamespace;
let kv: Map<string, string>;
let calls: Call[];
let grantReads: number;
let alerts: AdConnectionAlert[];
let overrides: Partial<Record<AdPlatform, Override>>;
let ports: AdsSyncPorts;

beforeEach(async () => {
  clock = { now: T0 };
  ns = new FakeAnalyticsNamespace(() => clock.now);
  edge = ns as unknown as AnalyticsNamespace;
  kv = new Map();
  calls = [];
  grantReads = 0;
  alerts = [];
  overrides = {};
  const box = await createSecretBox(toBase64(randomBytes(32)));
  const grants = kvAdGrantStore(
    {
      get: (k) => Promise.resolve(kv.get(k) ?? null),
      put: (k, v) => Promise.resolve(void kv.set(k, v)),
      delete: (k) => Promise.resolve(void kv.delete(k)),
    },
    { encrypt: (p, ad) => box.encrypt(p, ad), decrypt: (c, ad) => box.decrypt(c, ad) },
    () => clock.now,
  );
  const clients: AdPlatformClients = {
    fake: true,
    client(platform) {
      const base = createFakeProvider(platform, 'dev');
      const merged: AdsProvider = { ...base, ...(overrides[platform]?.(base) ?? {}) };
      const logged = { ...merged } as Record<string, unknown>;
      for (const m of METHODS) {
        const fn = merged[m] as (...a: unknown[]) => unknown;
        logged[m] = (...args: unknown[]) => {
          calls.push({ platform, method: m, args });
          return fn(...args);
        };
      }
      return logged as unknown as AdsProvider;
    },
  };
  ports = {
    ns: edge,
    clients,
    grants: {
      ...grants,
      getGrant: (ref) => {
        grantReads += 1;
        return grants.getGrant(ref);
      },
    },
    notify: (a) => Promise.resolve(void alerts.push(a)),
    now: () => clock.now,
  };
  for (const site of [SITE_A, SITE_B, SITE_C]) {
    ns.store(`site:${site.id}`).initSite(siteInit({ siteId: site.id, tenantId: site.tenantId, name: site.name }));
    ns.store(`tenant:${site.tenantId}`).indexAdd(site.id);
  }
});

async function connect(site: SiteRef, platform: AdPlatform = 'meta'): Promise<AdConnectionRecord> {
  const start = await startAdsConnect(ports, {
    tenantId: site.tenantId,
    tenantSlug: 'acme',
    siteId: site.id,
    platform,
    redirectUri: 'https://app.test/oauth/ads/callback',
  });
  const code = new URL(start.authorizeUrl).searchParams.get('code') ?? '';
  const [conn] = await finishAdsConnect(ports, {
    tenantId: site.tenantId,
    siteId: site.id,
    platform,
    state: start.state,
    code,
  });
  if (conn === undefined) throw new Error('no connection');
  calls = [];
  return conn;
}

const conn = async (site: SiteRef, id: string) => {
  const c = await adsStub(edge, site.id).getAdConnection(id);
  if (c === null) throw new Error('connection missing');
  return c;
};
const spendOf = (site: SiteRef, from: string, to = from) => adsStub(edge, site.id).listAdSpend({ from, to });
const tenants = ['tenant_a', 'tenant_c'];
const fetches = () => calls.filter((c) => c.method === 'fetchSpend');

async function expireGrant(site: SiteRef, c: AdConnectionRecord, refreshToken: string | null, expiresAt: number) {
  const ref = { tenantId: site.tenantId, siteId: site.id, grantId: String(c.metadata['grant_id']) };
  const grant = await ports.grants.getGrant(ref);
  if (grant === null) throw new Error('grant missing');
  await ports.grants.putGrant(ref, { ...grant, refreshToken, expiresAt });
}

describe('ad connections (OAuth)', () => {
  it('stores the sealed grant in the core store and only the account in the site DO', async () => {
    const c = await connect(SITE_A);
    expect(c).toMatchObject({ platform: 'meta', account_id: 'fake-meta-dev', currency: 'EUR', status: 'active' });
    expect(c.metadata).toMatchObject({ timezone: 'Europe/Rome' });
    expect(String(c.metadata['grant_id'])).toMatch(/^ag_/);
    const stored = [...kv.entries()].filter(([k]) => k.startsWith('ads_grant:'));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.[1]).not.toContain('fake-access');
    expect(JSON.stringify(await adsStub(edge, SITE_A.id).listAdConnections())).not.toContain('fake-access');
    // Grants are bound to tenant + site: another site cannot read them.
    const ref = { tenantId: SITE_B.tenantId, siteId: SITE_B.id, grantId: String(c.metadata['grant_id']) };
    expect(await ports.grants.getGrant(ref)).toBeNull();
  });

  it('rejects a reused, foreign or expired state', async () => {
    const start = await startAdsConnect(ports, {
      tenantId: SITE_A.tenantId,
      tenantSlug: 'acme',
      siteId: SITE_A.id,
      platform: 'meta',
      redirectUri: 'https://app.test/cb',
    });
    expect(start.state.startsWith('acme.')).toBe(true);
    await expect(
      finishAdsConnect(ports, { tenantId: SITE_C.tenantId, siteId: SITE_A.id, platform: 'meta', state: start.state, code: 'x' }),
    ).rejects.toMatchObject({ code: 'invalid_state' });
    // The state is single use, even after a failed attempt.
    await expect(
      finishAdsConnect(ports, { tenantId: SITE_A.tenantId, siteId: SITE_A.id, platform: 'meta', state: start.state, code: 'x' }),
    ).rejects.toMatchObject({ code: 'invalid_state' });
    const late = await startAdsConnect(ports, {
      tenantId: SITE_A.tenantId,
      tenantSlug: 'acme',
      siteId: SITE_A.id,
      platform: 'meta',
      redirectUri: 'https://app.test/cb',
    });
    clock.now += 11 * MIN;
    await expect(
      finishAdsConnect(ports, { tenantId: SITE_A.tenantId, siteId: SITE_A.id, platform: 'meta', state: late.state, code: 'x' }),
    ).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('reconnecting the same account reactivates it and drops the old grant', async () => {
    const first = await connect(SITE_A);
    await expireGrant(SITE_A, first, null, clock.now - 1);
    await syncAllAds(ports, tenants);
    expect((await conn(SITE_A, first.id)).status).toBe('auth_expired');
    const again = await connect(SITE_A);
    expect(again.id).toBe(first.id);
    expect(again.status).toBe('active');
    expect([...kv.keys()].filter((k) => k.startsWith('ads_grant:'))).toEqual([`ads_grant:${String(again.metadata['grant_id'])}`]);
    await disconnectAdConnection(ports, SITE_A.id, again);
    expect([...kv.keys()].filter((k) => k.startsWith('ads_grant:'))).toEqual([]);
    expect((await conn(SITE_A, first.id)).status).toBe('disconnected');
  });
});

describe('ads sync cron', () => {
  it('makes no platform call without active connections', async () => {
    const report = await syncAllAds(ports, tenants);
    expect(report.connections).toBe(0);
    expect(calls).toEqual([]);
    expect(grantReads).toBe(0);
    const c = await connect(SITE_A);
    await disconnectAdConnection(ports, SITE_A.id, c);
    await syncAllAds(ports, tenants);
    expect(calls).toEqual([]);
    expect(grantReads).toBe(0);
  });

  it('pulls today + the closed days, the entity dictionary and the reported numbers', async () => {
    const c = await connect(SITE_A);
    const report = await syncAllAds(ports, tenants);
    expect(report).toMatchObject({ connections: 1, synced: 1 });
    expect(fetches().map((f) => f.args[2])).toEqual([
      { from: TODAY, to: TODAY, granularity: 'day', level: 'campaign' },
      { from: '2026-10-08', to: '2026-10-14', granularity: 'day', level: 'campaign' },
    ]);
    const rows = await spendOf(SITE_A, '2026-10-08', TODAY);
    expect(rows).toHaveLength((RECONCILE_DAYS + 1) * 2);
    expect(rows.every((r) => r.platform === 'meta' && r.currency === 'EUR')).toBe(true);
    expect(rows.some((r) => (r.reported_conversions ?? 0) > 0 && (r.reported_revenue_minor ?? 0) > 0)).toBe(true);
    const names = (await adsStub(edge, SITE_A.id).listAdEntities({ level: 'campaign' })).map((e) => [e.external_id, e.name]);
    expect(names).toEqual([
      ['meta-dev-c1', 'Campaign 1'],
      ['meta-dev-c2', 'Campaign 2'],
    ]);
    const after = await conn(SITE_A, c.id);
    expect(after).toMatchObject({ status: 'active', last_sync_at: T0, last_error: null });
    expect(after.metadata).toMatchObject({ reconciled_on: TODAY, entities_at: T0 });
  });

  it('upserts spend idempotently and respects the hourly cadence', async () => {
    await connect(SITE_A);
    await syncAllAds(ports, tenants);
    const before = await spendOf(SITE_A, '2026-10-08', TODAY);
    calls = [];
    clock.now += 20 * MIN;
    await syncAllAds(ports, tenants);
    expect(calls).toEqual([]);
    clock.now += 40 * MIN;
    await syncAllAds(ports, tenants);
    // Only today: the closed days were reconciled already, the dictionary is fresh.
    expect(fetches().map((f) => (f.args[2] as { from: string }).from)).toEqual([TODAY]);
    expect(calls.some((c) => c.method === 'listEntities')).toBe(false);
    expect(await spendOf(SITE_A, '2026-10-08', TODAY)).toEqual(before);
  });

  it('reconciles once a day after the local cut-off and overwrites the closed days', async () => {
    await connect(SITE_A);
    await syncAllAds(ports, tenants);
    const yesterday = (await spendOf(SITE_A, '2026-10-14')).find((r) => r.entity_external_id === 'meta-dev-c1');
    must(await adsStub(edge, SITE_A.id).upsertAdSpend([{ ...yesterday!, spend_minor: 1, reported_conversions: 99 }]));
    must(await adsStub(edge, SITE_A.id).upsertAdSpend([{ ...yesterday!, day: '2026-10-15', spend_minor: 7 }]));
    // Platform stops reporting campaign 2: its stored closed days go to zero on reconciliation.
    overrides.meta = (base) => ({
      fetchSpend: async (t, a, q) => (await base.fetchSpend(t, a, q)).filter((r) => r.entity_external_id !== 'meta-dev-c2'),
    });
    clock.now = Date.UTC(2026, 9, 16, 0, 0); // 02:00 in Rome: new day, before the cut-off
    calls = [];
    await syncAllAds(ports, tenants);
    expect(fetches().map((f) => f.args[2])).toEqual([
      { from: '2026-10-16', to: '2026-10-16', granularity: 'day', level: 'campaign' },
    ]);
    expect((await spendOf(SITE_A, '2026-10-14')).find((r) => r.entity_external_id === 'meta-dev-c1')?.spend_minor).toBe(1);
    clock.now = Date.UTC(2026, 9, 16, 2, 0); // 04:00 in Rome
    calls = [];
    await syncAllAds(ports, tenants);
    expect(fetches().map((f) => (f.args[2] as { from: string; to: string }).to)).toEqual(['2026-10-16', '2026-10-15']);
    const fixed = (await spendOf(SITE_A, '2026-10-14')).find((r) => r.entity_external_id === 'meta-dev-c1');
    expect(fixed).toEqual(yesterday);
    expect((await spendOf(SITE_A, '2026-10-15')).find((r) => r.entity_external_id === 'meta-dev-c1')?.spend_minor).not.toBe(7);
    const c2 = (await spendOf(SITE_A, '2026-10-09', '2026-10-15')).filter((r) => r.entity_external_id === 'meta-dev-c2');
    expect(c2).toHaveLength(7);
    expect(c2.every((r) => r.spend_minor === 0 && r.reported_conversions === 0)).toBe(true);
    calls = [];
    clock.now += 2 * HOUR;
    await syncAllAds(ports, tenants);
    expect(fetches()).toHaveLength(1);
  });

  it('aggregates hourly provider rows into days', async () => {
    overrides.meta = (base) => ({
      fetchSpend: (t, a, q) => base.fetchSpend(t, a, { ...q, granularity: 'hour' }),
    });
    await connect(SITE_A);
    await syncAllAds(ports, tenants);
    const hourly = await createFakeProvider('meta', 'dev').fetchSpend('t', 'fake-meta-dev', {
      from: TODAY,
      to: TODAY,
      granularity: 'hour',
      level: 'campaign',
    });
    const c1 = hourly.filter((r) => r.entity_external_id === 'meta-dev-c1');
    expect(c1).toHaveLength(24);
    const stored = (await spendOf(SITE_A, TODAY)).filter((r) => r.entity_external_id === 'meta-dev-c1');
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      spend_minor: c1.reduce((s, r) => s + r.spend_minor, 0),
      clicks: c1.reduce((s, r) => s + (r.clicks ?? 0), 0),
      reported_conversions: c1.reduce((s, r) => s + (r.reported_conversions ?? 0), 0),
      reported_revenue_minor: c1.reduce((s, r) => s + (r.reported_revenue_minor ?? 0), 0),
    });
    expect(stored[0]).not.toHaveProperty('hour');
    expect(
      aggregateSpend([
        { platform: 'google', entity_external_id: 'x', day: TODAY, hour: 1, spend_minor: 5, clicks: null },
        { platform: 'google', entity_external_id: 'x', day: TODAY, hour: 2, spend_minor: 6, clicks: 3 },
      ]),
    ).toEqual([
      {
        platform: 'google',
        entity_external_id: 'x',
        day: TODAY,
        spend_minor: 11,
        clicks: 3,
        impressions: null,
        reported_conversions: null,
        reported_revenue_minor: null,
      },
    ]);
  });

  it('marks an expired authorization, alerts once and keeps syncing the other sites and tenants', async () => {
    const a = await connect(SITE_A);
    const b = await connect(SITE_B, 'google');
    const cc = await connect(SITE_C, 'tiktok');
    await expireGrant(SITE_A, a, 'revoked-refresh-token', clock.now + 10 * MIN);
    const report = await syncAllAds(ports, tenants);
    expect(report).toMatchObject({ connections: 3, synced: 2, authExpired: 1 });
    expect(await conn(SITE_A, a.id)).toMatchObject({ status: 'auth_expired', last_sync_at: null });
    expect((await conn(SITE_A, a.id)).last_error).toContain('unknown refresh token');
    expect((await conn(SITE_B, b.id)).status).toBe('active');
    expect((await conn(SITE_C, cc.id)).status).toBe('active');
    expect(await spendOf(SITE_A, TODAY)).toEqual([]);
    expect((await spendOf(SITE_B, TODAY)).length).toBe(2);
    expect((await spendOf(SITE_C, TODAY)).length).toBe(2);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      tenantId: 'tenant_a',
      reason: 'auth_expired',
      site: { id: SITE_A.id, name: 'Site A' },
      connection: { id: a.id, status: 'auth_expired' },
    });
    calls = [];
    clock.now += 2 * HOUR;
    await syncAllAds(ports, tenants);
    expect(alerts).toHaveLength(1);
    expect(calls.filter((c) => c.platform === 'meta')).toEqual([]);
  });

  it('refreshes the token before it expires', async () => {
    const c = await connect(SITE_A);
    await expireGrant(SITE_A, c, 'fake-refresh-meta-dev', clock.now + 30 * MIN);
    await syncAllAds(ports, tenants);
    expect(calls.filter((x) => x.method === 'refreshToken')).toHaveLength(1);
    const grant = await ports.grants.getGrant({
      tenantId: SITE_A.tenantId,
      siteId: SITE_A.id,
      grantId: String(c.metadata['grant_id']),
    });
    expect(grant).toMatchObject({ accessToken: 'fake-access-meta-dev-1', expiresAt: Date.UTC(2100, 0, 1) });
    expect((await conn(SITE_A, c.id)).status).toBe('active');
    calls = [];
    clock.now += HOUR;
    await syncAllAds(ports, tenants);
    expect(calls.filter((x) => x.method === 'refreshToken')).toEqual([]);
  });

  it('retries a retryable failure on the next tick', async () => {
    let failures = 1;
    overrides.meta = (base) => ({
      fetchSpend: (t, a, q) => {
        if (failures-- > 0) return Promise.reject(new ProviderError('retryable', 'rate limited', { status: 429 }));
        return base.fetchSpend(t, a, q);
      },
    });
    const c = await connect(SITE_A);
    expect(await syncAllAds(ports, tenants)).toMatchObject({ retry: 1 });
    expect(await conn(SITE_A, c.id)).toMatchObject({ status: 'active', last_sync_at: null, last_error: 'rate limited' });
    clock.now += 5 * MIN;
    expect(await syncAllAds(ports, tenants)).toMatchObject({ synced: 1 });
    expect(await conn(SITE_A, c.id)).toMatchObject({ status: 'active', last_sync_at: clock.now, last_error: null });
  });

  it('marks permanent failures and retries them hourly', async () => {
    overrides.meta = () => ({
      fetchSpend: () => Promise.reject(new ProviderError('permanent', 'account disabled', { status: 400 })),
    });
    const c = await connect(SITE_A);
    expect(await syncAllAds(ports, tenants)).toMatchObject({ errors: 1 });
    expect(await conn(SITE_A, c.id)).toMatchObject({ status: 'error', last_error: 'account disabled' });
    calls = [];
    clock.now += 10 * MIN;
    await syncAllAds(ports, tenants);
    expect(fetches()).toEqual([]);
    delete overrides.meta;
    clock.now += HOUR;
    expect(await syncAllAds(ports, tenants)).toMatchObject({ synced: 1 });
    expect((await conn(SITE_A, c.id)).status).toBe('active');
  });

  it('updates the ID → name dictionary when spend names an unknown entity', async () => {
    await connect(SITE_A);
    await syncAllAds(ports, tenants);
    overrides.meta = (base) => ({
      listEntities: async (t, a) => [
        ...(await base.listEntities(t, a)).map((e) => (e.external_id === 'meta-dev-c1' ? { ...e, name: 'Spring sale' } : e)),
        { platform: 'meta', level: 'campaign', external_id: 'meta-dev-c3', parent_external_id: null, name: 'Black friday', status: 'active' },
      ],
      fetchSpend: async (t, a, q) => [
        ...(await base.fetchSpend(t, a, q)),
        { platform: 'meta', entity_external_id: 'meta-dev-c3', day: q.from, spend_minor: 4200, currency: 'EUR' },
      ],
    });
    calls = [];
    clock.now += HOUR;
    await syncAllAds(ports, tenants);
    expect(calls.filter((c) => c.method === 'listEntities')).toHaveLength(1);
    const names = Object.fromEntries(
      (await adsStub(edge, SITE_A.id).listAdEntities({ level: 'campaign' })).map((e) => [e.external_id, e.name]),
    );
    expect(names).toEqual({ 'meta-dev-c1': 'Spring sale', 'meta-dev-c2': 'Campaign 2', 'meta-dev-c3': 'Black friday' });
    expect((await spendOf(SITE_A, TODAY)).find((r) => r.entity_external_id === 'meta-dev-c3')?.spend_minor).toBe(4200);
  });

  it('skips a site the tenant does not own', async () => {
    ns.store('tenant:tenant_c').indexAdd(SITE_A.id);
    await connect(SITE_A);
    const report = await syncAllAds(ports, ['tenant_c']);
    expect(report.connections).toBe(0);
    expect(fetches()).toEqual([]);
  });
});

describe('manual backfill', () => {
  it('re-pulls up to 90 days and rejects longer or future ranges', async () => {
    const c = await connect(SITE_A);
    await expect(backfillAdConnection(ports, SITE_A, c, { from: '2026-06-01', to: TODAY })).rejects.toMatchObject({
      code: 'invalid_range',
    });
    await expect(backfillAdConnection(ports, SITE_A, c, { from: TODAY, to: '2026-10-16' })).rejects.toMatchObject({
      code: 'invalid_range',
    });
    const result = await backfillAdConnection(ports, SITE_A, c, { from: '2026-07-18', to: TODAY });
    expect(result).toEqual({ from: '2026-07-18', to: TODAY, rows: 90 * 2 });
    expect(await spendOf(SITE_A, '2026-07-18', TODAY)).toHaveLength(180);
    // The cron still owns its cadence: nothing was marked as synced by the backfill.
    expect((await conn(SITE_A, c.id)).last_sync_at).toBeNull();
    expect(await syncAdConnection(ports, SITE_A, await conn(SITE_A, c.id))).toBe('synced');
  });

  it('marks the connection when the authorization is gone', async () => {
    const c = await connect(SITE_A);
    await expireGrant(SITE_A, c, null, clock.now - 1);
    await expect(backfillAdConnection(ports, SITE_A, c, { from: TODAY, to: TODAY })).rejects.toMatchObject({
      kind: 'auth_expired',
    });
    expect((await conn(SITE_A, c.id)).status).toBe('auth_expired');
    expect(alerts).toHaveLength(1);
  });
});

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}
