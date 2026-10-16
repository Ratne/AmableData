import {
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
  GoogleOAuthTokenProvider,
  OAUTH_SCOPES,
  type OAuthKeyValueStore,
  type OAuthSealer,
} from '@amable/core';
import { describe, expect, it } from 'vitest';

interface Call {
  url: string;
  body: URLSearchParams;
}

const REDIRECT = 'https://crm.example.com/oauth/google/callback';
const RETURN = 'https://crm.example.com/t/acme/bookings/calendars?calendar=cal_1';

function idToken(email: string): string {
  const b64 = (value: object) => btoa(JSON.stringify(value)).replace(/=+$/, '');
  return `${b64({ alg: 'RS256' })}.${b64({ email })}.sig`;
}

function world() {
  const map = new Map<string, string>();
  const store: OAuthKeyValueStore = {
    get: (key) => Promise.resolve(map.get(key) ?? null),
    put: (key, value) => {
      map.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => {
      map.delete(key);
      return Promise.resolve();
    },
  };
  // Reversible stand-in that still binds the associated data.
  const sealer: OAuthSealer = {
    encrypt: (plaintext, ad) => Promise.resolve(`sealed:${ad ?? ''}:${btoa(plaintext)}`),
    decrypt: (ciphertext, ad) => {
      const [tag, boundAd, body] = ciphertext.split(':');
      if (tag !== 'sealed' || boundAd !== (ad ?? '')) return Promise.reject(new Error('bad seal'));
      return Promise.resolve(atob(body ?? ''));
    },
  };
  const calls: Call[] = [];
  const responses: Response[] = [];
  const clock = { now: Date.UTC(2026, 9, 15, 12) };
  let n = 0;
  const provider = new GoogleOAuthTokenProvider({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: REDIRECT,
    store,
    sealer,
    now: () => clock.now,
    randomId: () => `rnd${String((n += 1))}`,
    fetch: (url, init) => {
      calls.push({ url, body: new URLSearchParams(typeof init?.body === 'string' ? init.body : '') });
      const next = responses.shift();
      return next === undefined ? Promise.reject(new Error('unexpected fetch')) : Promise.resolve(next);
    },
  });
  const reply = (status: number, body: object) => responses.push(new Response(JSON.stringify(body), { status }));
  return { provider, map, calls, reply, clock };
}

describe('bring-your-own Google OAuth app', () => {
  it('runs the consent round-trip, stores the grant sealed and refreshes tokens', async () => {
    const w = world();
    const start = await w.provider.startConnect({
      tenantId: 't_1',
      provider: 'google',
      scopes: [OAUTH_SCOPES.calendar],
      returnUrl: RETURN,
    });
    const authorize = new URL(start.authorizeUrl);
    expect(authorize.origin).toBe('https://accounts.google.com');
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      client_id: 'client-id',
      redirect_uri: REDIRECT,
      access_type: 'offline',
      state: start.state,
      scope: `openid email ${OAUTH_SCOPES.calendar}`,
    });

    // Google → fixed callback → back to the page that started the flow.
    const back = await w.provider.callbackRedirect(new URLSearchParams({ state: start.state, code: 'the-code' }));
    const backUrl = new URL(back ?? 'x:');
    expect(backUrl.pathname).toBe('/t/acme/bookings/calendars');
    expect(Object.fromEntries(backUrl.searchParams)).toEqual({ calendar: 'cal_1', state: start.state, code: 'the-code' });
    expect(await w.provider.callbackRedirect(new URLSearchParams({ state: 'forged', code: 'x' }))).toBeNull();

    w.reply(200, {
      access_token: 'at-1',
      expires_in: 3600,
      refresh_token: 'rt-1',
      scope: `openid ${OAUTH_SCOPES.calendar}`,
      id_token: idToken('owner@example.com'),
    });
    const { account, email } = await w.provider.finishConnect({ tenantId: 't_1', state: start.state, code: 'the-code' });
    expect(email).toBe('owner@example.com');
    expect(account).toMatchObject({ tenantId: 't_1', provider: 'google' });
    expect(w.calls[0]?.url).toBe(GOOGLE_TOKEN_URL);
    expect(Object.fromEntries(w.calls[0]?.body ?? [])).toMatchObject({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: REDIRECT,
      client_secret: 'client-secret',
    });
    // The state is single use; nothing sensitive is stored in clear.
    await expect(w.provider.finishConnect({ tenantId: 't_1', state: start.state, code: 'the-code' })).rejects.toThrow(
      /expired OAuth state/,
    );
    for (const value of w.map.values()) expect(value).not.toContain('rt-1');

    expect(await w.provider.getAccessToken(account)).toMatchObject({ accessToken: 'at-1', stub: false, scopes: [OAUTH_SCOPES.calendar] });
    expect(w.calls).toHaveLength(1);
    // Other tenants never see the grant.
    expect(await w.provider.getAccessToken({ ...account, tenantId: 't_2' })).toBeNull();

    w.clock.now += 3_600_000;
    w.reply(200, { access_token: 'at-2', expires_in: 3600 });
    expect((await w.provider.getAccessToken(account))?.accessToken).toBe('at-2');
    expect(Object.fromEntries(w.calls[1]?.body ?? [])).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'rt-1' });

    w.reply(200, {});
    await w.provider.revoke(account);
    expect(w.calls[2]?.url).toBe(GOOGLE_REVOKE_URL);
    expect(await w.provider.getAccessToken(account)).toBeNull();
  });

  it('drops a grant revoked on the Google side and rejects foreign or expired states', async () => {
    const w = world();
    const start = await w.provider.startConnect({ tenantId: 't_1', provider: 'google', scopes: [OAUTH_SCOPES.sheets], returnUrl: RETURN });
    await expect(w.provider.finishConnect({ tenantId: 't_2', state: start.state, code: 'c' })).rejects.toThrow(/OAuth state/);
    w.reply(200, { access_token: 'at', expires_in: 10, refresh_token: 'rt' });
    const { account } = await w.provider.finishConnect({ tenantId: 't_1', state: start.state, code: 'c' });
    w.clock.now += 60_000;
    w.reply(400, { error: 'invalid_grant' });
    expect(await w.provider.getAccessToken(account)).toBeNull();
    expect([...w.map.keys()].some((k) => k.startsWith('oauth_account:'))).toBe(false);

    const late = await w.provider.startConnect({ tenantId: 't_1', provider: 'google', scopes: [], returnUrl: RETURN });
    w.clock.now += 11 * 60_000;
    expect(await w.provider.callbackRedirect(new URLSearchParams({ state: late.state, code: 'c' }))).toBeNull();
  });
});
