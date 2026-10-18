import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env as EdgeEnv } from '../../../edge/src/env';
import {
  clearTrackingHostCache,
  resolveTrackingHost,
} from '../../../edge/src/analytics/tracking-domains';
import { FakeAnalyticsNamespace } from '../../../edge/test/helpers';
import type { Env } from '../../src/env';
import {
  cloudflareCustomHostnames,
  devCustomHostnames,
  mapCloudflareHostname,
  overrideCustomHostnames,
} from '../../src/platform/custom-hostnames';
import { handleEdgeGateway } from '../../src/public/gateway';
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
const SECRET = 'tracking-domains-gateway-secret';

let h: Harness;
let owner: TestClient;
let viewer: TestClient;
let stranger: TestClient;
let siteId = '';
let otherSiteId = '';
let edgeEnv: EdgeEnv;

async function createSite(client: TestClient, base: string, hostname: string): Promise<string> {
  const res = await client.post(`${base}/sites`, { name: hostname, hostnames: [hostname] });
  expect(res.status).toBe(201);
  return String((res.body['site'] as Record<string, unknown>)['id']);
}

beforeAll(async () => {
  h = await createHarness();
  h.env.ANALYTICS = new FakeAnalyticsNamespace(() => h.clock.now) as unknown as Env['ANALYTICS'];
  h.env.APP_ORIGIN = 'https://app.amable.test';
  h.env.EDGE_ORIGIN = 'https://edge.amable.test';
  h.env.EDGE_GATEWAY_SECRET = SECRET;
  overrideCustomHostnames((env) => devCustomHostnames(env.DB, 'cname.amable.test'));
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
  siteId = await createSite(owner, BASE, 'acme.test');
  otherSiteId = await createSite(stranger, OTHER, 'other.test');
  edgeEnv = {
    EDGE_GATEWAY_SECRET: SECRET,
    CORE: {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        handleEdgeGateway(new Request(input, init), h.env, {
          waitUntil: () => undefined,
        } as unknown as ExecutionContext),
    } as unknown as Fetcher,
  } as EdgeEnv;
});

afterAll(() => overrideCustomHostnames(null));

describe('tracking domains', () => {
  let domainId = '';

  it('connects a hostname with CNAME and TXT instructions, pending DNS', async () => {
    const res = await owner.post(`${BASE}/tracking-domains`, {
      site_id: siteId,
      hostname: 'Track.Acme.test',
    });
    expect(res.status).toBe(201);
    domainId = String(res.body['id']);
    expect(domainId).toMatch(/^td_/);
    expect(res.body).toMatchObject({
      site_id: siteId,
      hostname: 'track.acme.test',
      status: 'pending_dns',
      error: null,
      checked_at: h.clock.now,
      dns: {
        cname_name: 'track.acme.test',
        cname_target: 'cname.amable.test',
        txt_name: '_cf-custom-hostname.track.acme.test',
      },
    });
    expect(String((res.body['dns'] as Record<string, unknown>)['txt_value'])).toMatch(
      /^dev-[0-9a-f]{8}$/,
    );
    const list = await viewer.get(`${BASE}/tracking-domains?site_id=${siteId}`);
    expect(list.status).toBe(200);
    expect((list.body['data'] as Array<Record<string, unknown>>).map((d) => d['id'])).toEqual([
      domainId,
    ]);
    expect((await viewer.get(`${BASE}/tracking-domains/${domainId}`)).body['hostname']).toBe(
      'track.acme.test',
    );
  });

  it('does not resolve at the edge until active', async () => {
    clearTrackingHostCache();
    expect(await resolveTrackingHost(edgeEnv, 'track.acme.test')).toBeNull();
  });

  it('advances pending_dns → pending_ssl → active on successive checks', async () => {
    h.clock.advance(60_000);
    const first = await owner.post(`${BASE}/tracking-domains/${domainId}/check`);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: 'pending_ssl', checked_at: h.clock.now });
    const second = await owner.post(`${BASE}/tracking-domains/${domainId}/check`);
    expect(second.body['status']).toBe('active');
    const third = await owner.post(`${BASE}/tracking-domains/${domainId}/check`);
    expect(third.body['status']).toBe('active');
  });

  it('resolves an active custom hostname at the edge (tenant + site)', async () => {
    clearTrackingHostCache();
    const found = await resolveTrackingHost(edgeEnv, 'TRACK.acme.test');
    expect(found).not.toBeNull();
    expect(found?.siteId).toBe(siteId);
    expect(found?.tenant.slug).toBe('acme');
    expect(await resolveTrackingHost(edgeEnv, 'unknown.acme.test')).toBeNull();
  });

  it('rejects duplicates across tenants with 409', async () => {
    expect(
      (
        await owner.post(`${BASE}/tracking-domains`, {
          site_id: siteId,
          hostname: 'track.acme.test',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await stranger.post(`${OTHER}/tracking-domains`, {
          site_id: otherSiteId,
          hostname: 'track.acme.test',
        })
      ).status,
    ).toBe(409);
    await h.env.DB.prepare(
      `INSERT INTO domains (id, tenant_id, hostname, kind, status, created_at)
       SELECT 'dom_x', id, 'app.other.test', 'app', 'verified', 0 FROM tenants WHERE slug = 'other'`,
    ).run();
    expect(
      (
        await owner.post(`${BASE}/tracking-domains`, {
          site_id: siteId,
          hostname: 'app.other.test',
        })
      ).status,
    ).toBe(409);
  });

  it('rejects platform and reserved hostnames and invalid input', async () => {
    for (const hostname of [
      'app.amable.test',
      'x.edge.amable.test',
      'cname.amable.test',
      'foo.workers.dev',
      'my.localhost',
    ]) {
      const res = await owner.post(`${BASE}/tracking-domains`, { site_id: siteId, hostname });
      expect(res.status, hostname).toBe(422);
    }
    expect(
      (await owner.post(`${BASE}/tracking-domains`, { site_id: siteId, hostname: 'not a host' }))
        .status,
    ).toBe(422);
    expect(
      (
        await owner.post(`${BASE}/tracking-domains`, {
          site_id: siteId,
          hostname: 'ok.acme.test',
          x: 1,
        })
      ).status,
    ).toBe(422);
  });

  it('isolates tenants and enforces permissions', async () => {
    expect((await stranger.get(`${OTHER}/tracking-domains/${domainId}`)).status).toBe(404);
    expect((await stranger.post(`${OTHER}/tracking-domains/${domainId}/check`)).status).toBe(404);
    expect((await stranger.delete(`${OTHER}/tracking-domains/${domainId}`)).status).toBe(404);
    expect((await stranger.get(`${OTHER}/tracking-domains?site_id=${siteId}`)).status).toBe(404);
    expect(
      (
        await stranger.post(`${OTHER}/tracking-domains`, {
          site_id: siteId,
          hostname: 'steal.acme.test',
        })
      ).status,
    ).toBe(404);
    expect(
      (await viewer.post(`${BASE}/tracking-domains`, { site_id: siteId, hostname: 'v.acme.test' }))
        .status,
    ).toBe(403);
    expect((await viewer.post(`${BASE}/tracking-domains/${domainId}/check`)).status).toBe(403);
    expect((await viewer.delete(`${BASE}/tracking-domains/${domainId}`)).status).toBe(403);
    expect((await h.client().get(`${BASE}/tracking-domains?site_id=${siteId}`)).status).toBe(401);
  });

  it('answers 503 when no provider is configured', async () => {
    overrideCustomHostnames(() => null);
    try {
      const res = await owner.post(`${BASE}/tracking-domains`, {
        site_id: siteId,
        hostname: 'none.acme.test',
      });
      expect(res.status).toBe(503);
      expect(res.body['error']).toBe('tracking_domains_unavailable');
    } finally {
      overrideCustomHostnames((env) => devCustomHostnames(env.DB, 'cname.amable.test'));
    }
  });

  it('deletes a domain, frees the hostname and stops resolving it', async () => {
    const res = await owner.delete(`${BASE}/tracking-domains/${domainId}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: domainId, deleted: true });
    expect((await owner.get(`${BASE}/tracking-domains/${domainId}`)).status).toBe(404);
    clearTrackingHostCache();
    expect(await resolveTrackingHost(edgeEnv, 'track.acme.test')).toBeNull();
    const again = await stranger.post(`${OTHER}/tracking-domains`, {
      site_id: otherSiteId,
      hostname: 'track.acme.test',
    });
    expect(again.status).toBe(201);
    expect(again.body['status']).toBe('pending_dns');
  });
});

describe('Cloudflare custom hostnames provider', () => {
  it('maps hostname and certificate states', () => {
    const base = { id: 'ch_1', hostname: 't.example.org' };
    expect(
      mapCloudflareHostname({
        ...base,
        status: 'pending',
        ownership_verification: { name: '_cf.t', value: 'v1' },
      }),
    ).toMatchObject({ status: 'pending_dns', txtName: '_cf.t', txtValue: 'v1' });
    expect(
      mapCloudflareHostname({ ...base, status: 'active', ssl: { status: 'pending_validation' } })
        .status,
    ).toBe('pending_ssl');
    expect(
      mapCloudflareHostname({ ...base, status: 'active', ssl: { status: 'active' } }).status,
    ).toBe('active');
    expect(
      mapCloudflareHostname({
        ...base,
        status: 'active',
        ssl: { status: 'validation_timed_out', validation_errors: [{ message: 'CAA blocks' }] },
      }),
    ).toMatchObject({ status: 'error', error: 'CAA blocks' });
    expect(mapCloudflareHostname({ ...base, status: 'blocked' }).status).toBe('error');
  });

  it('calls the zone API and treats a missing hostname as gone', async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    const provider = cloudflareCustomHostnames({
      zoneId: 'zone1',
      token: 'tok',
      cnameTarget: 'cname.example.net',
      fetch: (url, init) => {
        calls.push({
          method: init?.method ?? 'GET',
          url,
          body: init?.body === undefined ? null : JSON.parse(String(init.body)),
        });
        if (init?.method === 'DELETE' || url.endsWith('/gone')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ success: false, errors: [{ code: 1436, message: 'not found' }] }),
              { status: 404 },
            ),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              success: true,
              result: {
                id: 'ch_9',
                hostname: 't.example.org',
                status: 'pending',
                ssl: { status: 'initializing' },
              },
            }),
          ),
        );
      },
    });
    expect((await provider.create('t.example.org')).status).toBe('pending_dns');
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.cloudflare.com/client/v4/zones/zone1/custom_hostnames',
      body: { hostname: 't.example.org', ssl: { method: 'http', type: 'dv' } },
    });
    expect(await provider.get('gone')).toBeNull();
    await expect(provider.delete('ch_9')).resolves.toBeUndefined();
  });
});
