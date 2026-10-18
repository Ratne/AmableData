import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FakeAnalyticsNamespace } from '../../../edge/test/helpers';
import {
  findTrackingHost,
  overrideZoneProbe,
  probeZoneDomain,
  runScheduledTrackingDomains,
  TRACKING_DOMAIN_CHECKS_PER_TICK,
  TRACKING_DOMAIN_RECHECK_MS,
} from '../../src/analytics/routes-tracking-domains';
import type { Env } from '../../src/env';
import {
  devCustomHostnames,
  overrideCustomHostnames,
  type CustomHostnameProvider,
} from '../../src/platform/custom-hostnames';
import { addMember, createHarness, login, seedTenant, seedUser, type Harness, type TestClient } from '../helpers/harness';

const BASE = '/api/v2/t/acme/analytics';

let h: Harness;
let owner: TestClient;
/** Provider deletes that fail before succeeding again. */
let failDeletes = 0;
const deleted: string[] = [];

function provider(env: Env): CustomHostnameProvider {
  const dev = devCustomHostnames(env.DB, 'cname.amable.test');
  return {
    ...dev,
    async delete(id) {
      if (failDeletes > 0) {
        failDeletes -= 1;
        throw new Error('provider down');
      }
      deleted.push(id);
      await dev.delete(id);
    },
  };
}

async function createSite(hostname: string): Promise<string> {
  const res = await owner.post(`${BASE}/sites`, { name: hostname, hostnames: [hostname] });
  expect(res.status).toBe(201);
  return String((res.body['site'] as Record<string, unknown>)['id']);
}

async function connect(siteId: string, hostname: string): Promise<string> {
  const res = await owner.post(`${BASE}/tracking-domains`, { site_id: siteId, hostname });
  expect(res.status).toBe(201);
  return String(res.body['id']);
}

const statusOf = async (id: string): Promise<string | null> =>
  (await h.env.DB.prepare(`SELECT status FROM tracking_domains WHERE id = ?`).bind(id).first<{ status: string }>())
    ?.status ?? null;

const providerRows = async (): Promise<number> =>
  (
    await h.env.DB.prepare(`SELECT COUNT(*) AS n FROM installation_meta WHERE key LIKE 'dev_custom_hostname:%'`).first<{
      n: number;
    }>()
  )?.n ?? 0;

beforeAll(async () => {
  h = await createHarness();
  h.env.ANALYTICS = new FakeAnalyticsNamespace(() => h.clock.now) as unknown as Env['ANALYTICS'];
  h.env.APP_ORIGIN = 'https://app.amable.test';
  h.env.EDGE_ORIGIN = 'https://edge.amable.test';
  overrideCustomHostnames(provider);
  const acme = await seedTenant(h, 'acme');
  const o = await seedUser(h, { email: 'owner@example.com' });
  await addMember(h, o.id, acme.id, 'owner');
  owner = await login(h, 'owner@example.com');
});

afterAll(() => overrideCustomHostnames(null));

describe('tracking domains cron', () => {
  it('re-checks the pending domains, a few per tick and not more often than the interval', async () => {
    const siteId = await createSite('cron.test');
    const ids: string[] = [];
    for (let i = 0; i < TRACKING_DOMAIN_CHECKS_PER_TICK + 2; i += 1) ids.push(await connect(siteId, `t${String(i)}.cron.test`));
    const t0 = h.clock.now;
    // Just checked by the creation: nothing due yet.
    expect(await runScheduledTrackingDomains(h.env, t0 + 1000)).toEqual({ removed: 0, checked: 0 });
    const tick1 = t0 + TRACKING_DOMAIN_RECHECK_MS;
    expect(await runScheduledTrackingDomains(h.env, tick1)).toEqual({ removed: 0, checked: TRACKING_DOMAIN_CHECKS_PER_TICK });
    const statuses = await Promise.all(ids.map(statusOf));
    expect(statuses.filter((s) => s === 'pending_ssl')).toHaveLength(TRACKING_DOMAIN_CHECKS_PER_TICK);
    // Next tick: the two left over first, the rest is not due again yet.
    expect(await runScheduledTrackingDomains(h.env, tick1 + 60_000)).toEqual({ removed: 0, checked: 2 });
    expect(await Promise.all(ids.map(statusOf))).toEqual(ids.map(() => 'pending_ssl'));
    await runScheduledTrackingDomains(h.env, tick1 + TRACKING_DOMAIN_RECHECK_MS);
    await runScheduledTrackingDomains(h.env, tick1 + TRACKING_DOMAIN_RECHECK_MS + 60_000);
    expect(await Promise.all(ids.map(statusOf))).toEqual(ids.map(() => 'active'));
    expect((await findTrackingHost(h.env.DB, 't0.cron.test'))?.site_id).toBe(siteId);
    // Active domains are left alone.
    expect(await runScheduledTrackingDomains(h.env, tick1 + 10 * TRACKING_DOMAIN_RECHECK_MS)).toEqual({ removed: 0, checked: 0 });
  });

  it('does nothing without a provider', async () => {
    overrideCustomHostnames(() => null);
    try {
      expect(await runScheduledTrackingDomains(h.env, h.clock.now + 86_400_000)).toEqual({ removed: 0, checked: 0 });
    } finally {
      overrideCustomHostnames(provider);
    }
  });
});

describe('site deletion', () => {
  it('removes the tracking domains of the site and their custom hostnames', async () => {
    const siteId = await createSite('gone.test');
    const keepId = await createSite('kept.test');
    const a = await connect(siteId, 'a.gone.test');
    const b = await connect(siteId, 'b.gone.test');
    const kept = await connect(keepId, 'x.kept.test');
    const before = await providerRows();
    expect((await owner.request('DELETE', `${BASE}/sites/${siteId}`)).status).toBe(200);
    expect(await statusOf(a)).toBeNull();
    expect(await statusOf(b)).toBeNull();
    expect(await statusOf(kept)).toBe('pending_dns');
    expect(await providerRows()).toBe(before - 2);
    // The hostname is free again.
    const other = await createSite('again.test');
    expect(await connect(other, 'a.gone.test')).toMatch(/^td_/);
  });

  it('defers the removal when the provider fails and the cron finishes it', async () => {
    const siteId = await createSite('flaky.test');
    const id = await connect(siteId, 'track.flaky.test');
    await owner.post(`${BASE}/tracking-domains/${id}/check`, {});
    await owner.post(`${BASE}/tracking-domains/${id}/check`, {});
    expect(await statusOf(id)).toBe('active');
    expect(await findTrackingHost(h.env.DB, 'track.flaky.test')).not.toBeNull();
    failDeletes = 1;
    expect((await owner.request('DELETE', `${BASE}/sites/${siteId}`)).status).toBe(200);
    // Kept for the retry, but no longer resolved by the edge.
    expect(await statusOf(id)).toBe('error');
    expect(await findTrackingHost(h.env.DB, 'track.flaky.test')).toBeNull();
    const res = await runScheduledTrackingDomains(h.env, h.clock.now + 60_000);
    expect(res.removed).toBe(1);
    expect(await statusOf(id)).toBeNull();
    expect(deleted.at(-1)).toMatch(/^devch_/);
  });
});

describe('zone domains (no custom hostname provider)', () => {
  afterEach(() => {
    overrideZoneProbe(null);
    overrideCustomHostnames(provider);
  });

  it('connects, verifies and resolves a zone domain while cname creation is unavailable', async () => {
    overrideCustomHostnames(() => null);
    overrideZoneProbe(() => Promise.resolve({ status: 'pending_dns', error: 'hostname_unreachable' }));
    const siteId = await createSite('zone.test');
    const refused = await owner.post(`${BASE}/tracking-domains`, {
      site_id: siteId,
      hostname: 'c.zone.test',
      kind: 'cname',
    });
    expect(refused.status).toBe(503);
    const res = await owner.post(`${BASE}/tracking-domains`, {
      site_id: siteId,
      hostname: 'go.zone.test',
      kind: 'zone',
    });
    expect(res.status).toBe(201);
    expect(res.body['kind']).toBe('zone');
    expect(res.body['status']).toBe('pending_dns');
    const id = String(res.body['id']);
    const list = await owner.get(`${BASE}/tracking-domains?site_id=${siteId}`);
    expect(list.body['options']).toEqual({ cname_available: false, target: 'edge.amable.test' });
    expect(await findTrackingHost(h.env.DB, 'go.zone.test')).toBeNull();
    // The route and record are in place: the probe sees the worker.
    overrideZoneProbe(() => Promise.resolve({ status: 'active', error: null }));
    const checked = await owner.post(`${BASE}/tracking-domains/${id}/check`, {});
    expect(checked.body['status']).toBe('active');
    expect((await findTrackingHost(h.env.DB, 'go.zone.test'))?.site_id).toBe(siteId);
  });

  it('is re-checked by the cron and removed with the site, all without a provider', async () => {
    overrideCustomHostnames(() => null);
    overrideZoneProbe(() => Promise.resolve({ status: 'error', error: 'not_tracking_worker (HTTP 404)' }));
    const siteId = await createSite('zcron.test');
    const res = await owner.post(`${BASE}/tracking-domains`, {
      site_id: siteId,
      hostname: 'go.zcron.test',
      kind: 'zone',
    });
    const id = String(res.body['id']);
    expect(await statusOf(id)).toBe('error');
    // A fixed route: the user presses check, then the cron keeps it green.
    overrideZoneProbe(() => Promise.resolve({ status: 'pending_dns', error: 'hostname_unreachable' }));
    await owner.post(`${BASE}/tracking-domains/${id}/check`, {});
    expect(await statusOf(id)).toBe('pending_dns');
    overrideZoneProbe(() => Promise.resolve({ status: 'active', error: null }));
    let activated = false;
    for (let tick = 1; tick <= 6 && !activated; tick += 1) {
      await runScheduledTrackingDomains(h.env, h.clock.now + tick * (TRACKING_DOMAIN_RECHECK_MS + 60_000));
      activated = (await statusOf(id)) === 'active';
    }
    expect(activated).toBe(true);
    expect((await owner.request('DELETE', `${BASE}/sites/${siteId}`)).status).toBe(200);
    expect(await statusOf(id)).toBeNull();
  });

  it('maps the probe outcomes: active, wrong service, unreachable', async () => {
    const json = (body: unknown, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
    expect(await probeZoneDomain(() => json({ service: 'amable-edge' }), 'x.test')).toEqual({
      status: 'active',
      error: null,
    });
    expect((await probeZoneDomain(() => json({ service: 'something-else' }), 'x.test')).status).toBe('error');
    expect((await probeZoneDomain(() => Promise.resolve(new Response('<html>', { status: 404 })), 'x.test')).status).toBe(
      'error',
    );
    expect(await probeZoneDomain(() => Promise.reject(new Error('dns')), 'x.test')).toEqual({
      status: 'pending_dns',
      error: 'hostname_unreachable',
    });
  });
});
