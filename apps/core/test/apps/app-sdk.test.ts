import { signWebhook, verifyWebhook } from '@amable/auth';
import {
  clearDiscoveryCache,
  createAmableClient,
  createAppHandler,
  generateAppKey,
  jwksOf,
  kvInstallStore,
  readSignedCall,
  refreshTokens,
  signPayload,
  verifySessionToken,
  verifySignature,
  type PrivateJwk,
} from '@amable/app-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { app } from '../../src/app';
import { overrideAuthServices } from '../../src/auth/services';
import { DISCOVERY_PATH, handleWellKnown, JWKS_PATH } from '../../src/apps/well-known';
import { appOriginOf } from '../../src/providers/select';
import { runCatalogSync } from '../../src/apps/catalog-sync';
import { clearJwksCache } from '../../src/apps/tokens';
import { addMember, login, seedTenant, seedUser, stepUp } from '../helpers/harness';
import { CATALOG_URL, catalogKeys, createAppsHarness, manifestInput, resetAppsHarness, signedCatalog, type AppsHarness } from './helpers';
import { installApp } from './oauth-helpers';

afterEach(() => {
  resetAppsHarness();
  overrideAuthServices(null);
  clearDiscoveryCache();
});

/** The SDK talking to the real worker (well-known + Hono app). */
function crmFetch(h: AppsHarness) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    if (url.pathname === DISCOVERY_PATH || url.pathname === JWKS_PATH) {
      return handleWellKnown(new Request(input, init), h.env, url.pathname);
    }
    return app.request(input, init, h.env);
  };
}

describe('@amable/app-sdk against the CRM', () => {
  it('verifies the signatures the CRM produces (and vice versa)', async () => {
    const body = JSON.stringify({ installation_id: 'ai_1', tenant: 'acme', api_version: '2026-10', event: 'x' });
    const header = await signWebhook('whsec_test', body);
    expect(await verifySignature({ header, rawBody: body, secrets: ['old', 'whsec_test'] })).toEqual({ ok: true });
    expect(await verifySignature({ header, rawBody: `${body} `, secrets: ['whsec_test'] })).toEqual({ ok: false, reason: 'mismatch' });
    expect(await verifyWebhook({ secrets: ['s'], header: await signPayload('s', body), rawBody: body })).toEqual({ ok: true });

    const request = new Request('https://app.example/hook', {
      method: 'POST',
      headers: { 'Amable-Signature': header, 'Amable-Installation': 'ai_1' },
      body,
    });
    const read = await readSignedCall(request, (id) => (id === 'ai_1' ? ['whsec_test'] : []));
    expect(read).toMatchObject({ ok: true, body: { tenant: 'acme', event: 'x' } });
  });

  it('refreshes tokens with private_key_jwt, verifies screen tokens and calls the API', async () => {
    const h = await createAppsHarness();
    const installed = await installApp(h, {
      extensions: { ui: [{ slot: 'app.page', key: 'home', path: '/ui', title: { en: 'Home' } }] },
    });
    const origin = appOriginOf(h.env);
    const exported = (await crypto.subtle.exportKey('jwk', installed.appKey.privateKey)) as JsonWebKey;
    const key: PrivateJwk = { kty: 'OKP', crv: 'Ed25519', x: exported.x!, d: exported.d!, kid: 'k1', alg: 'EdDSA', use: 'sig' };
    const fetcher = crmFetch(h);

    const tokens = await refreshTokens({ origin, refreshToken: installed.refresh }, { appId: 'emailable', key, now: () => h.clock.now }, fetcher);
    expect(tokens.access_token).toMatch(/^amb_app_/);
    expect(tokens.refresh_token).not.toBe(installed.refresh);
    expect(tokens.installation).toMatchObject({ app_id: 'emailable', tenant: { slug: 'acme' } });

    const client = createAmableClient({ apiBase: tokens.installation.api_base, accessToken: () => tokens.access_token, fetch: fetcher });
    await client.data.set('api_key', 'sk_live', { secret: true });
    expect(await client.data.get('api_key')).toMatchObject({ key: 'api_key', value: 'sk_live' });
    expect(await client.installation()).toMatchObject({ app_id: 'emailable', status: 'active' });

    const frame = await installed.owner.post('/api/t/acme/apps/frames', { app_id: 'emailable', key: 'home' });
    const claims = await verifySessionToken(String(frame.body.token), {
      audience: 'https://apps.example.com',
      isTrustedIssuer: (issuer) => issuer === origin,
      appId: 'emailable',
      nowMs: h.clock.now,
      fetch: fetcher,
    });
    expect(claims).toMatchObject({ slot: 'app.page', tenant: { slug: 'acme' }, role: 'owner' });
    await expect(
      verifySessionToken(String(frame.body.token), { audience: 'https://other.example.com', isTrustedIssuer: () => true, nowMs: h.clock.now, fetch: fetcher }),
    ).rejects.toThrow(/audience/);
    await expect(
      verifySessionToken(String(frame.body.token), { audience: 'https://apps.example.com', isTrustedIssuer: () => false, nowMs: h.clock.now, fetch: fetcher }),
    ).rejects.toThrow(/issuer/);
  });
});

describe('createAppHandler', () => {
  it('installs, answers signed hooks and survives a secret rotation', async () => {
    const h = await createAppsHarness();
    // Signed calls use the real clock: keep the CRM clock on it.
    h.clock.now = Date.now();
    clearJwksCache();
    await seedTenant(h, 'acme');
    const user = await seedUser(h, { email: 'owner@acme.test' });
    await addMember(h, user.id, 't_acme', 'owner');
    const catalogKey = await catalogKeys();
    Object.assign(h.env, catalogKey.env);
    const manifest = manifestInput();
    h.routes.set(CATALOG_URL, async () => new Response(await signedCatalog(catalogKey.privateKey, [{ manifest }])));

    const key = await generateAppKey('k-test');
    const kv = new Map<string, string>();
    const handler = createAppHandler({
      appId: 'emailable',
      baseUrl: 'https://apps.example.com',
      keys: [JSON.stringify(key)],
      store: kvInstallStore({
        get: async (k) => kv.get(k) ?? null,
        put: async (k, v) => void kv.set(k, v),
        delete: async (k) => void kv.delete(k),
      }),
      calls: {
        '/hooks/validate': async (body) => {
          const email = String((body['values'] as { email?: string }).email ?? '');
          return email.startsWith('bad') ? { valid: false, reason: 'bounced', fields: { email_status: 'invalid' } } : { valid: true };
        },
      },
      fetch: crmFetch(h),
    });
    // Every CRM → app call (JWKS included) goes to the handler.
    h.routes.set('https://apps.example.com/', (call) =>
      handler.fetch(new Request(call.url, { method: call.method, headers: call.headers, ...(call.method === 'GET' ? {} : { body: call.body }) })),
    );
    expect(await (await handler.fetch(new Request('https://apps.example.com/.well-known/jwks.json'))).json()).toEqual(jwksOf([key]));

    await runCatalogSync(h.env, h.clock.now);
    const owner = await login(h, 'owner@acme.test');
    await stepUp(h, owner);
    const consent = await owner.post('/api/t/acme/apps/authorize', { app_id: 'emailable' });
    const landed = await handler.fetch(new Request(String(consent.body.redirect_url)));
    expect(landed.status).toBe(302);
    expect(landed.headers.get('location')).toMatch(/\/t\/acme\/settings\/apps\/installed$/);
    const [installKey] = [...kv.keys()].filter((k) => k.startsWith('install:'));
    const record = JSON.parse(kv.get(installKey!)!) as { webhookSecrets: string[]; tenant: { slug: string } };
    expect(record.tenant.slug).toBe('acme');
    expect(record.webhookSecrets).toHaveLength(1);

    const created = await owner.post('/api/v2/t/acme/contacts', { given_name: 'Ada', emails: [{ email: 'bad@example.com' }] });
    const contact = await owner.get(`/api/v2/t/acme/contacts/${String(created.body.id)}`);
    expect(contact.body.custom_fields).toMatchObject({ app_emailable_email_status: 'invalid' });

    const unsigned = await handler.fetch(new Request('https://apps.example.com/hooks/validate', { method: 'POST', body: '{}' }));
    expect(unsigned.status).toBe(401);

    const installId = installKey!.slice('install:'.length);
    const rotated = await owner.post(`/api/t/acme/apps/installs/${installId}/rotate-secret`, {});
    expect(rotated.status).toBe(200);
    await h.drain();
    const after = JSON.parse(kv.get(installKey!)!) as { webhookSecrets: string[] };
    expect(after.webhookSecrets).toHaveLength(2);
    expect(after.webhookSecrets[1]).toBe(record.webhookSecrets[0]);
  });
});
