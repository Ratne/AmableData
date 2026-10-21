import { META_DEFAULT_SCOPES } from '@amable/ads-providers';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AdsBrokerError,
  adsOAuthBrokerFor,
  brokeredAdPlatform,
  brokerProviderOf,
} from '../../src/analytics/ads-broker';
import { adPlatformClientsFor } from '../../src/analytics/integrations';
import type { Env } from '../../src/env';
import { fakeControlPlane, license, type FakeControlPlane } from '../platform/link/helpers';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

let cp: FakeControlPlane | null = null;
afterEach(() => cp?.restore());

function licensedEnv(): Env {
  return license({ ENVIRONMENT: 'production' } as unknown as Env);
}

function broker(env = licensedEnv()) {
  const b = adsOAuthBrokerFor(env);
  if (b === null) throw new Error('broker missing');
  return b;
}

describe('ads broker selection', () => {
  it('Meta and TikTok are brokered, and only when licensed', () => {
    expect(brokerProviderOf('meta')).toBe('meta');
    expect(brokerProviderOf('tiktok')).toBe('tiktok');
    expect(brokerProviderOf('google')).toBeNull();
    const env = licensedEnv();
    expect(brokeredAdPlatform(env, 'meta')).toBe(true);
    expect(brokeredAdPlatform(env, 'tiktok')).toBe(true);
    expect(brokeredAdPlatform(env, 'google')).toBe(false);
    expect(brokeredAdPlatform({ ENVIRONMENT: 'production' } as unknown as Env, 'meta')).toBe(false);
    expect(adsOAuthBrokerFor({ ENVIRONMENT: 'production' } as unknown as Env)).toBeNull();
  });

  it('an own Meta app wins over the broker; without either the platform is unavailable', () => {
    const brokered = (p: string) => p === 'meta';
    const bare = adPlatformClientsFor({ ENVIRONMENT: 'production' }, { brokered });
    expect(bare.mode('meta')).toBe('broker');
    expect(bare.client('meta')).not.toBeNull();
    expect(bare.mode('google')).toBe('unavailable');
    expect(bare.client('google')).toBeNull();
    const own = adPlatformClientsFor(
      { ENVIRONMENT: 'production', META_APP_ID: 'app-1', META_APP_SECRET: 's-1' },
      { brokered },
    );
    expect(own.mode('meta')).toBe('own');
    const none = adPlatformClientsFor({ ENVIRONMENT: 'production' });
    expect(none.mode('meta')).toBe('unavailable');
    expect(none.client('meta')).toBeNull();
  });
});

describe('control plane ads broker client', () => {
  it('runs start → finish → token → revoke with the Meta scopes', async () => {
    cp = fakeControlPlane(() => 0);
    const revoked = new Set<string>();
    cp.routes = {
      'POST /v1/installation/oauth/start': (body) => {
        expect(body).toEqual({
          tenantId: 't_1',
          provider: 'meta',
          scopes: META_DEFAULT_SCOPES,
          returnUrl: 'https://crm.example.com/oauth/ads/callback',
        });
        return json({ authorizeUrl: 'https://cp.test/v1/oauth/fake/authorize?state=s1', state: 's1' });
      },
      'POST /v1/installation/oauth/finish': (body) => {
        expect(body).toEqual({ tenantId: 't_1', state: 's1', code: 'c1' });
        return json({
          account: { tenantId: 't_1', provider: 'meta', accountId: 'acc_1' },
          email: null,
          scopes: META_DEFAULT_SCOPES,
        });
      },
      'POST /v1/installation/oauth/token': (body) => {
        const { accountId } = body as { accountId: string };
        if (revoked.has(accountId)) return json({ error: 'not_connected' }, 404);
        return json({ accessToken: 'at-1', expiresAt: 1_000, scopes: META_DEFAULT_SCOPES });
      },
      'POST /v1/installation/oauth/revoke': (body) => {
        revoked.add((body as { accountId: string }).accountId);
        return json({ ok: true });
      },
    };
    const b = broker();
    const start = await b.start({
      tenantId: 't_1',
      platform: 'meta',
      scopes: META_DEFAULT_SCOPES,
      returnUrl: 'https://crm.example.com/oauth/ads/callback',
    });
    expect(start).toEqual({ authorizeUrl: 'https://cp.test/v1/oauth/fake/authorize?state=s1', state: 's1' });
    const finished = await b.finish({ tenantId: 't_1', platform: 'meta', state: 's1', code: 'c1' });
    expect(finished).toEqual({ accountId: 'acc_1' });
    expect(await b.token({ tenantId: 't_1', accountId: 'acc_1' })).toEqual({ accessToken: 'at-1', expiresAt: 1_000 });
    await b.revoke({ tenantId: 't_1', accountId: 'acc_1' });
    expect(await b.token({ tenantId: 't_1', accountId: 'acc_1' })).toBeNull();
    // A second revoke of a gone account is swallowed.
    cp.routes['POST /v1/installation/oauth/revoke'] = () => json({ error: 'not_connected' }, 404);
    await expect(b.revoke({ tenantId: 't_1', accountId: 'acc_1' })).resolves.toBeUndefined();
  });

  it('finish passes through the TikTok advertiser ids', async () => {
    cp = fakeControlPlane(() => 0);
    cp.routes = {
      'POST /v1/installation/oauth/finish': () =>
        json({
          account: { tenantId: 't_1', provider: 'tiktok', accountId: 'acc_t' },
          email: null,
          scopes: [],
          advertiserIds: ['7001'],
        }),
    };
    expect(await broker().finish({ tenantId: 't_1', platform: 'tiktok', state: 's', code: 'c' })).toEqual({
      accountId: 'acc_t',
      advertiserIds: ['7001'],
    });
  });

  it('maps broker failures: 503 → unavailable, 400 on finish → invalid_grant, mismatch → unavailable', async () => {
    cp = fakeControlPlane(() => 0);
    cp.routes = {
      'POST /v1/installation/oauth/start': () => json({ error: 'provider_not_configured' }, 503),
      'POST /v1/installation/oauth/finish': () => json({ error: 'invalid_code' }, 400),
    };
    const b = broker();
    const start = await b
      .start({ tenantId: 't', platform: 'meta', scopes: ['ads_read'], returnUrl: 'https://x/cb' })
      .catch((e: unknown) => e);
    expect(start).toBeInstanceOf(AdsBrokerError);
    expect(start).toMatchObject({ code: 'unavailable' });
    await expect(b.finish({ tenantId: 't', platform: 'meta', state: 's', code: 'c' })).rejects.toMatchObject({
      code: 'invalid_grant',
    });
    cp.routes['POST /v1/installation/oauth/finish'] = () =>
      json({ account: { tenantId: 'other', provider: 'meta', accountId: 'a' }, email: null, scopes: [] });
    await expect(b.finish({ tenantId: 't', platform: 'meta', state: 's', code: 'c' })).rejects.toMatchObject({
      code: 'unavailable',
    });
    await expect(
      b.start({ tenantId: 't', platform: 'google', scopes: ['adwords'], returnUrl: 'https://x/cb' }),
    ).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('token: 404 → null (reconnect), other failures stay errors', async () => {
    cp = fakeControlPlane(() => 0);
    cp.routes = { 'POST /v1/installation/oauth/token': () => json({ error: 'not_connected' }, 404) };
    const b = broker();
    expect(await b.token({ tenantId: 't', accountId: 'a' })).toBeNull();
    cp.routes['POST /v1/installation/oauth/token'] = () => json({ error: 'services_suspended' }, 402);
    await expect(b.token({ tenantId: 't', accountId: 'a' })).rejects.toMatchObject({ code: 'unavailable' });
  });
});
