import { OAUTH_SCOPES, unavailableOAuthProvider } from '@amable/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../src/env';
import { ControlPlaneOAuthTokenProvider, platformOAuthProvider } from '../../../src/platform/oauth';
import { fakeControlPlane, license, type FakeControlPlane } from './helpers';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

let cp: FakeControlPlane | null = null;
afterEach(() => cp?.restore());

function licensedEnv(): Env {
  return license({ ENVIRONMENT: 'production' } as unknown as Env);
}

describe('control plane OAuth broker client', () => {
  it('runs start → finish → token → revoke against the broker', async () => {
    cp = fakeControlPlane(() => 0);
    const revoked = new Set<string>();
    cp.routes = {
      'POST /v1/installation/oauth/start': (body) => {
        expect(body).toEqual({
          tenantId: 't_1',
          provider: 'google',
          scopes: [OAUTH_SCOPES.sheets],
          returnUrl: 'https://crm.example.com/back',
        });
        return json({ authorizeUrl: 'https://cp.test/v1/oauth/fake/authorize?state=s1', state: 's1' });
      },
      'POST /v1/installation/oauth/finish': (body) => {
        expect(body).toEqual({ tenantId: 't_1', state: 's1', code: 'c1' });
        return json({
          account: { tenantId: 't_1', provider: 'google', accountId: 'acc_1' },
          email: 'ada@example.com',
          scopes: [OAUTH_SCOPES.sheets],
        });
      },
      'POST /v1/installation/oauth/token': (body) => {
        const { accountId } = body as { accountId: string };
        if (revoked.has(accountId)) return json({ error: 'not_connected' }, 404);
        return json({ accessToken: 'at-1', expiresAt: 1_000, scopes: [OAUTH_SCOPES.sheets, 'email'] });
      },
      'POST /v1/installation/oauth/revoke': (body) => {
        revoked.add((body as { accountId: string }).accountId);
        return json({ ok: true });
      },
    };
    const provider = platformOAuthProvider(licensedEnv());
    expect(provider).toBeInstanceOf(ControlPlaneOAuthTokenProvider);
    const start = await provider.startConnect({
      tenantId: 't_1',
      provider: 'google',
      scopes: [OAUTH_SCOPES.sheets],
      returnUrl: 'https://crm.example.com/back',
    });
    expect(start).toEqual({ authorizeUrl: 'https://cp.test/v1/oauth/fake/authorize?state=s1', state: 's1' });
    const finished = await provider.finishConnect({ tenantId: 't_1', state: 's1', code: 'c1' });
    expect(finished).toEqual({
      account: { tenantId: 't_1', provider: 'google', accountId: 'acc_1' },
      email: 'ada@example.com',
    });
    expect(await provider.getAccessToken(finished.account)).toEqual({
      accessToken: 'at-1',
      expiresAt: 1_000,
      scopes: [OAUTH_SCOPES.sheets],
      stub: false,
    });
    await provider.revoke(finished.account);
    expect(await provider.getAccessToken(finished.account)).toBeNull();
    expect(cp.calls.every((c) => c.auth?.startsWith('Bearer amb_lic_') === true)).toBe(true);
  });

  it('rejects an account answered for another tenant', async () => {
    cp = fakeControlPlane(() => 0);
    cp.routes = {
      'POST /v1/installation/oauth/finish': () =>
        json({ account: { tenantId: 't_2', provider: 'google', accountId: 'a' }, email: null, scopes: [] }),
    };
    const provider = platformOAuthProvider(licensedEnv());
    await expect(provider.finishConnect({ tenantId: 't_1', state: 's', code: 'c' })).rejects.toThrow(
      /oauth_account_mismatch/,
    );
  });

  it('surfaces broker errors other than not_connected', async () => {
    cp = fakeControlPlane(() => 0);
    cp.routes = { 'POST /v1/installation/oauth/token': () => json({ error: 'services_suspended' }, 402) };
    const provider = platformOAuthProvider(licensedEnv());
    await expect(provider.getAccessToken({ tenantId: 't', provider: 'google', accountId: 'a' })).rejects.toThrow(
      /402 services_suspended/,
    );
  });

  it('falls back to the dev stub in dev and to unavailable otherwise', () => {
    const dev = platformOAuthProvider({ ENVIRONMENT: 'dev' } as unknown as Env);
    expect(dev.available).toBe(true);
    expect(dev).not.toBeInstanceOf(ControlPlaneOAuthTokenProvider);
    expect(platformOAuthProvider({ ENVIRONMENT: 'production' } as unknown as Env)).toBe(unavailableOAuthProvider);
  });
});
