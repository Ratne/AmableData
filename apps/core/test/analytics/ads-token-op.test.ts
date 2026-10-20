import {
  ADS_TOKEN_GATEWAY_OP,
  EDGE_GATEWAY_PATH,
  EDGE_GATEWAY_SIGNATURE_HEADER,
  EDGE_INSTALLATION_TENANT,
} from '@amable/api-types';
import type { AdConnectionRecord, AnalyticsNamespace } from '@amable/app-edge/analytics';
import { signWebhook } from '@amable/auth/security';
import { beforeAll, describe, expect, it } from 'vitest';
import { FakeAnalyticsNamespace, siteInit } from '../../../edge/test/helpers';
import {
  adConnectionId,
  adsStub,
  adsSyncPorts,
  disconnectAdConnection,
  finishAdsConnect,
  startAdsConnect,
  type AdsSyncPorts,
  type SiteRef,
} from '../../src/analytics/ads-sync';
import type { Env } from '../../src/env';
import { handleEdgeGateway } from '../../src/public/gateway';
import { createHarness, seedTenant, type Harness } from '../helpers/harness';

const SECRET = 'test-edge-gateway-secret';
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
const MIN = 60_000;

let h: Harness;
let ns: FakeAnalyticsNamespace;
let ports: AdsSyncPorts;
let siteA: SiteRef;
let siteB: SiteRef;
let foreign: SiteRef;
let nonce = 0;

async function call(input: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const body = JSON.stringify({
    nonce: `ads-token-nonce-${String(Date.now())}-${String((nonce += 1))}`,
    op: ADS_TOKEN_GATEWAY_OP,
    tenant: EDGE_INSTALLATION_TENANT,
    client: { ip: null, userAgent: null, country: null, visitorId: null, referer: null, acceptLanguage: null },
    input,
  });
  const res = await handleEdgeGateway(
    new Request(`https://core${EDGE_GATEWAY_PATH}`, {
      method: 'POST',
      headers: { [EDGE_GATEWAY_SIGNATURE_HEADER]: await signWebhook(SECRET, body) },
      body,
    }),
    h.env,
    ctx,
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function connect(site: SiteRef, platform: 'meta' | 'google' = 'meta'): Promise<AdConnectionRecord> {
  const start = await startAdsConnect(ports, {
    tenantId: site.tenantId,
    tenantSlug: 'acme',
    siteId: site.id,
    platform,
    redirectUri: 'https://app.test/oauth/ads/callback',
  });
  const [conn] = await finishAdsConnect(ports, {
    tenantId: site.tenantId,
    siteId: site.id,
    platform,
    state: start.state,
    code: new URL(start.authorizeUrl).searchParams.get('code') ?? '',
  });
  if (conn === undefined) throw new Error('no connection');
  return conn;
}

const grantRef = (site: SiteRef, c: AdConnectionRecord) => ({
  tenantId: site.tenantId,
  siteId: site.id,
  grantId: String(c.metadata['grant_id']),
});

async function setGrant(site: SiteRef, c: AdConnectionRecord, refreshToken: string | null, expiresAt: number) {
  const grant = await ports.grants.getGrant(grantRef(site, c));
  if (grant === null) throw new Error('grant missing');
  await ports.grants.putGrant(grantRef(site, c), { ...grant, refreshToken, expiresAt });
}

const tokenInput = (site: SiteRef, c: AdConnectionRecord) => ({
  tenant_id: site.tenantId,
  site_id: site.id,
  connection_id: c.id,
});

beforeAll(async () => {
  h = await createHarness();
  ns = new FakeAnalyticsNamespace(() => h.clock.now);
  h.env.ANALYTICS = ns as unknown as Env['ANALYTICS'];
  h.env.EDGE_GATEWAY_SECRET = SECRET;
  const acme = await seedTenant(h, 'acme');
  const other = await seedTenant(h, 'other');
  siteA = { tenantId: acme.id, id: 'st_aaaaaaaaaaaaaaaaaaaa', name: 'A' };
  siteB = { tenantId: acme.id, id: 'st_bbbbbbbbbbbbbbbbbbbb', name: 'B' };
  foreign = { tenantId: other.id, id: 'st_cccccccccccccccccccc', name: 'C' };
  for (const s of [siteA, siteB, foreign]) {
    ns.store(`site:${s.id}`).initSite(siteInit({ siteId: s.id, tenantId: s.tenantId, name: s.name }));
  }
  ports = adsSyncPorts(h.env, ns as unknown as AnalyticsNamespace);
});

describe('analytics.adsToken gateway op', () => {
  it('answers the access token of an active connection', async () => {
    const c = await connect(siteA);
    const res = await call(tokenInput(siteA, c));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, tenant: { id: siteA.tenantId, slug: 'acme' } });
    expect(res.body['value']).toEqual({ platform: 'meta', access_token: 'fake-access-meta-dev-1' });
    const google = await connect(siteB, 'google');
    // Fake clients: no installation credentials are added.
    expect((await call(tokenInput(siteB, google))).body['value']).toEqual({
      platform: 'google',
      access_token: 'fake-access-google-dev-1',
    });
  });

  it('answers null for a disconnected or unknown connection', async () => {
    const c = await connect(siteB);
    await disconnectAdConnection(ports, siteB.id, c);
    expect((await call(tokenInput(siteB, c))).body).toMatchObject({ ok: true, value: null });
    expect((await call({ ...tokenInput(siteB, c), connection_id: 'adc_missing' })).body).toMatchObject({
      ok: true,
      value: null,
    });
    expect((await call({ tenant_id: siteA.tenantId })).body).toMatchObject({ ok: false, error: { code: 'bad_request' } });
  });

  it('refreshes a token close to its expiry and saves the grant', async () => {
    const c = await connect(siteA);
    await setGrant(siteA, c, 'fake-refresh-meta-dev', Date.now() + 30 * MIN);
    const res = await call(tokenInput(siteA, c));
    expect(res.body['value']).toEqual({ platform: 'meta', access_token: 'fake-access-meta-dev-1' });
    expect(await ports.grants.getGrant(grantRef(siteA, c))).toMatchObject({
      accessToken: 'fake-access-meta-dev-1',
      refreshToken: 'fake-refresh-meta-dev',
      expiresAt: Date.UTC(2100, 0, 1),
    });
  });

  it('answers auth_expired and marks the connection when the refresh is refused', async () => {
    const c = await connect(siteA);
    await setGrant(siteA, c, 'revoked', Date.now() + 10 * MIN);
    const res = await call(tokenInput(siteA, c));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ ok: false, error: { code: 'auth_expired' } });
    expect(await adsStub(ns as unknown as AnalyticsNamespace, siteA.id).getAdConnection(c.id)).toMatchObject({
      status: 'auth_expired',
    });
    // Still expired on the next call, without asking the platform again.
    expect((await call(tokenInput(siteA, c))).body).toMatchObject({ ok: false, error: { code: 'auth_expired' } });
  });

  it('never answers the token of another tenant or site', async () => {
    const theirs = await connect(foreign);
    const mine = await connect(siteB);
    // Right connection id, wrong tenant / site.
    expect((await call({ ...tokenInput(foreign, theirs), tenant_id: siteA.tenantId })).body).toMatchObject({
      ok: true,
      value: null,
    });
    expect((await call({ ...tokenInput(foreign, theirs), site_id: siteB.id })).body).toMatchObject({
      ok: true,
      value: null,
    });
    // A connection of another site of the same tenant (Google on B only) is unknown on this site.
    const googleOfB = await adConnectionId('google', 'fake-google-dev');
    expect(await adsStub(ns as unknown as AnalyticsNamespace, siteB.id).getAdConnection(googleOfB)).not.toBeNull();
    expect((await call({ ...tokenInput(siteA, mine), connection_id: googleOfB })).body).toMatchObject({
      ok: true,
      value: null,
    });
    expect((await call({ ...tokenInput(foreign, theirs), tenant_id: 'tenant_missing' })).body).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect((await call(tokenInput(foreign, theirs))).body['value']).toMatchObject({ platform: 'meta' });
  });
});
