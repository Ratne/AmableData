import { afterEach, describe, expect, it } from 'vitest';
import { recordPlatformUsage, storeQuotaSnapshot } from '../../src/platform/quota';
import {
  addMember,
  createHarness,
  login,
  seedTenant,
  seedUser,
  type Harness,
  type TestClient,
} from '../helpers/harness';
import { CP_URL, fakeControlPlane, license, type FakeControlPlane } from './link/helpers';

const URL_BILLING = '/api/v2/t/acme/billing';

let cp: FakeControlPlane | null = null;
afterEach(() => {
  cp?.restore();
  cp = null;
});

async function setup(): Promise<{ h: Harness; owner: TestClient; admin: TestClient }> {
  const h = await createHarness();
  const tenant = await seedTenant(h, 'acme');
  const o = await seedUser(h, { email: 'owner@acme.test' });
  await addMember(h, o.id, tenant.id, 'owner');
  const a = await seedUser(h, { email: 'admin@acme.test' });
  await addMember(h, a.id, tenant.id, 'admin');
  return { h, owner: await login(h, o.email), admin: await login(h, a.email) };
}

function managed(h: Harness): FakeControlPlane {
  license(h.env);
  cp = fakeControlPlane(() => h.clock.now);
  return cp;
}

describe('GET /api/v2/t/:slug/billing', () => {
  it('managed: plan, quota net of unreported sends, wallet in dollars and portal links', async () => {
    const { h, owner } = await setup();
    const fake = managed(h);
    fake.includedRemaining = 100;
    fake.balanceMicros = 12_500_000;
    await recordPlatformUsage(
      h.env.DB,
      { tenantId: 't_1', channel: 'email', count: 1_100 },
      h.clock.now,
    );

    const res = await owner.get(URL_BILLING);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      mode: 'managed',
      linked: true,
      service_state: 'active',
      plan: { code: 'managed', price_monthly: 99, currency: 'USD' },
      email: {
        included_monthly: 10_000,
        used_this_period: 1_100,
        remaining: 0,
        period_start: '2026-10-01T00:00:00.000Z',
        period_end: '2026-11-01T00:00:00.000Z',
        overage_per_1000: 1,
        currency: 'USD',
        caps: { hourly: null, daily: null },
        dedicated: false,
      },
      // 1,000 unreported sends beyond the included 100 → 1 $ already owed.
      wallet: { balance: 11.5, balance_micros: 11_500_000, currency: 'USD' },
      snapshot: { status: 'fresh', stale: false, issued_at: new Date(h.clock.now).toISOString() },
      portal: {
        url: CP_URL,
        billing_url: `${CP_URL}/billing`,
        wallet_url: `${CP_URL}/wallet`,
        capacity_url: `${CP_URL}/capacity`,
        connect_url: `${CP_URL}/signup`,
      },
    });
  });

  it('flags the last stored snapshot as stale when the control plane is unreachable', async () => {
    const { h, owner } = await setup();
    const fake = managed(h);
    fake.serviceState = 'grace';
    const issuedAt = new Date(h.clock.now).toISOString();
    await storeQuotaSnapshot(h.env.DB, fake.snapshot(), h.clock.now);
    fake.down = true;
    h.clock.advance(3_600_000);

    const res = await owner.get(URL_BILLING);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      mode: 'managed',
      service_state: 'grace',
      snapshot: { status: 'stale', stale: true, issued_at: issuedAt },
    });
  });

  it('managed without any snapshot: plan only, no quota or wallet', async () => {
    const { h, owner } = await setup();
    managed(h).down = true;

    const res = await owner.get(URL_BILLING);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      mode: 'managed',
      linked: true,
      service_state: null,
      plan: { code: 'managed', price_monthly: 99 },
      email: null,
      wallet: null,
      snapshot: { status: 'missing', stale: true, issued_at: null },
    });
  });

  it('linked open source installation: wallet only', async () => {
    const { h, owner } = await setup();
    const fake = managed(h);
    fake.serviceState = 'self_hosted';
    fake.balanceMicros = 5_000_000;

    const res = await owner.get(URL_BILLING);
    expect(res.body).toMatchObject({
      mode: 'open_source',
      linked: true,
      plan: null,
      email: null,
      wallet: { balance: 5, currency: 'USD' },
    });
  });

  it('open source: no quota, portal link to connect an account, no control plane call', async () => {
    const { h, owner } = await setup();
    let calls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.reject(new Error('unexpected network call'));
    }) as typeof fetch;
    try {
      const res = await owner.get(URL_BILLING);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        mode: 'open_source',
        linked: false,
        service_state: null,
        plan: null,
        email: null,
        wallet: null,
        snapshot: { status: 'missing', stale: false, issued_at: null },
        portal: {
          url: 'https://app.amabledata.com',
          billing_url: 'https://app.amabledata.com/billing',
          wallet_url: 'https://app.amabledata.com/wallet',
          capacity_url: 'https://app.amabledata.com/capacity',
          connect_url: 'https://app.amabledata.com/signup',
        },
      });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls).toBe(0);
    expect(h.env.LICENSE_KEY).toBeUndefined();
  });

  it('is reserved to the owner (tenant:billing)', async () => {
    const { h, admin } = await setup();
    managed(h);
    const res = await admin.get(URL_BILLING);
    expect(res.status).toBe(403);
    expect(cp?.calls).toEqual([]);
  });
});
