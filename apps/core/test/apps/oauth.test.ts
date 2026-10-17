import { toBase64Url, utf8 } from '@amable/auth';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { overrideAuthServices } from '../../src/auth/services';
import { runCatalogSync } from '../../src/apps/catalog-sync';
import { clearJwksCache } from '../../src/apps/tokens';
import { addMember, login, seedTenant, seedUser, stepUp, type TestClient } from '../helpers/harness';
import {
  CATALOG_URL,
  catalogKeys,
  createAppsHarness,
  manifestInput,
  resetAppsHarness,
  signedCatalog,
  type AppsHarness,
} from './helpers';

let h: AppsHarness;
let owner: TestClient;
let appKey: CryptoKeyPair;
let jti = 0;

async function assertion(overrides: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(h.clock.now / 1000);
  const head = toBase64Url(utf8(JSON.stringify({ alg: 'EdDSA', kid: 'k1', typ: 'JWT' })));
  const body = toBase64Url(
    utf8(
      JSON.stringify({
        iss: 'emailable',
        sub: 'emailable',
        aud: 'https://crm.example.com/api/apps/v1/token',
        iat: now,
        exp: now + 120,
        jti: `jti-${String(++jti)}-abcdef`,
        ...overrides,
      }),
    ),
  );
  const sig = await crypto.subtle.sign('Ed25519', appKey.privateKey, utf8(`${head}.${body}`));
  return `${head}.${body}.${toBase64Url(new Uint8Array(sig))}`;
}

async function token(params: Record<string, string>) {
  const response = await (await import('../../src/app')).app.request(
    'https://crm.example.com/api/apps/v1/token',
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    },
    h.env,
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown>, headers: response.headers };
}

async function bearer(method: string, path: string, accessToken: string, body?: unknown) {
  const response = await (await import('../../src/app')).app.request(
    `https://crm.example.com${path}`,
    {
      method,
      headers: { authorization: `Bearer ${accessToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    h.env,
  );
  const text = await response.text();
  return { status: response.status, body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>, headers: response.headers };
}

async function consent(extra: Record<string, unknown> = {}) {
  const res = await owner.post('/api/t/acme/apps/authorize', { app_id: 'emailable', state: 'xyz', ...extra });
  expect(res.status).toBe(200);
  const url = new URL(res.body.redirect_url as string);
  expect(url.origin + url.pathname).toBe('https://apps.example.com/install');
  expect(url.searchParams.get('state')).toBe('xyz');
  expect(url.searchParams.get('tenant')).toBe('acme');
  return url.searchParams.get('code')!;
}

async function exchange(code: string, extra: Record<string, string> = {}) {
  return token({
    grant_type: 'authorization_code',
    code,
    redirect_uri: 'https://apps.example.com/install',
    client_id: 'emailable',
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: await assertion(),
    ...extra,
  });
}

beforeEach(async () => {
  h = await createAppsHarness();
  clearJwksCache();
  await seedTenant(h, 'acme');
  const user = await seedUser(h, { email: 'owner@acme.test' });
  await addMember(h, user.id, 't_acme', 'owner');
  const keys = await catalogKeys();
  Object.assign(h.env, keys.env);
  const catalog = await signedCatalog(keys.privateKey, [{ manifest: manifestInput() }]);
  h.routes.set(CATALOG_URL, () => new Response(catalog));
  appKey = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', appKey.publicKey);
  h.routes.set('https://apps.example.com/.well-known/jwks.json', () =>
    Response.json({ keys: [{ ...jwk, kid: 'k1', alg: 'EdDSA', use: 'sig' }] }),
  );
  await runCatalogSync(h.env, h.clock.now);
  owner = await login(h, 'owner@acme.test');
  await stepUp(h, owner);
});

afterEach(() => {
  resetAppsHarness();
  overrideAuthServices(null);
});

describe('app OAuth', () => {
  it('consent → code → tokens; the token works on the API with the granted scopes only', async () => {
    const code = await consent();
    const res = await exchange(code);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ token_type: 'Bearer', scope: 'contacts:read contacts:write' });
    expect(String(res.body.access_token)).toMatch(/^amb_app_/);
    expect(String(res.body.webhook_secret)).toMatch(/^whsec_/);
    const access = String(res.body.access_token);

    const list = await bearer('GET', '/api/v2/t/acme/contacts', access);
    expect(list.status).toBe(200);
    expect(list.headers.get('amable-api-version')).toBe('2026-10');
    expect(list.headers.get('amable-granted-scopes')).toBe('contacts:read contacts:write');

    // Out of scope, another tenant, the admin surface.
    expect((await bearer('GET', '/api/v2/t/acme/orders', access)).status).toBe(403);
    await seedTenant(h, 'other');
    expect((await bearer('GET', '/api/v2/t/other/contacts', access)).status).toBe(404);
    expect((await bearer('GET', '/api/t/acme/apps/installs', access)).status).toBe(403);

    const me = await bearer('GET', '/api/apps/v1/installation', access);
    expect(me.body).toMatchObject({ app_id: 'emailable', status: 'active' });
  });

  it('codes are single use and bound to the redirect URI and PKCE verifier', async () => {
    const code = await consent();
    expect((await exchange(code, { redirect_uri: 'https://apps.example.com/other' })).status).toBe(400);
    expect((await exchange(code)).status).toBe(200);
    const again = await exchange(code);
    expect(again.body.error).toBe('invalid_grant');

    const verifier = 'v'.repeat(43);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(verifier)));
    const challenge = toBase64Url(digest);
    const uninstall = await owner.get('/api/t/acme/apps/installs');
    const installId = (uninstall.body.data as Array<{ id: string }>)[0]!.id;
    await owner.post(`/api/t/acme/apps/installs/${installId}/uninstall`, { keep_data: true });
    h.clock.advance(49 * 3600_000);
    const { finalizeUninstalls } = await import('../../src/apps/lifecycle');
    await finalizeUninstalls(h.env, h.clock.now);
    await stepUp(h, owner);
    const pkce = await consent({ code_challenge: challenge, code_challenge_method: 'S256' });
    expect((await exchange(pkce)).body.error).toBe('invalid_grant');
    const pkce2 = await consent({ code_challenge: challenge, code_challenge_method: 'S256' });
    expect((await exchange(pkce2, { code_verifier: verifier })).status).toBe(200);
  });

  it('rejects assertions that are unsigned by the app, replayed or for another audience', async () => {
    const code = await consent();
    const forged = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const real = appKey;
    appKey = forged;
    expect((await exchange(code)).body.error).toBe('invalid_client');
    appKey = real;
    const code2 = await consent();
    const wrongAud = await assertion({ aud: 'https://elsewhere.example.com' });
    expect((await exchange(code2, { client_assertion: wrongAud })).body.error).toBe('invalid_client');
    const code3 = await consent();
    const once = await assertion();
    const ok = await exchange(code3, { client_assertion: once });
    expect(ok.status).toBe(200);
    const replayed = await token({
      grant_type: 'refresh_token',
      refresh_token: String(ok.body.refresh_token),
      client_id: 'emailable',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: once,
    });
    expect(replayed.body.error).toBe('invalid_client');
  });

  it('refresh tokens rotate and a reused one revokes the install tokens', async () => {
    const first = await exchange(await consent());
    const refresh = String(first.body.refresh_token);
    const params = {
      grant_type: 'refresh_token',
      client_id: 'emailable',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    };
    const second = await token({ ...params, refresh_token: refresh, client_assertion: await assertion() });
    expect(second.status).toBe(200);
    expect(second.body.refresh_token).not.toBe(refresh);
    const reused = await token({ ...params, refresh_token: refresh, client_assertion: await assertion() });
    expect(reused.body.error).toBe('invalid_grant');
    expect((await bearer('GET', '/api/v2/t/acme/contacts', String(second.body.access_token))).status).toBe(401);
  });

  it('serves the discovery document and the installation keys', async () => {
    const { handleWellKnown, DISCOVERY_PATH, JWKS_PATH } = await import('../../src/apps/well-known');
    const get = (path: string) => handleWellKnown(new Request(`https://crm.example.com${path}`), h.env, path);
    const doc = await get(DISCOVERY_PATH);
    const body = (await doc.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      issuer: 'https://crm.example.com',
      token_endpoint: 'https://crm.example.com/api/apps/v1/token',
      api_versions: ['2026-10'],
    });
    const jwks = await get(JWKS_PATH);
    const keys = ((await jwks.json()) as { keys: Array<{ kty: string; crv: string }> }).keys;
    expect(keys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519' });
  });
});
