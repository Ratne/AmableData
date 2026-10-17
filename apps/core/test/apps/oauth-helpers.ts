import { toBase64Url, utf8 } from '@amable/auth';
import type { AppManifestInput } from '@amable/core/apps';
import { expect } from 'vitest';
import { app } from '../../src/app';
import { runCatalogSync } from '../../src/apps/catalog-sync';
import { clearJwksCache } from '../../src/apps/tokens';
import { addMember, login, seedTenant, seedUser, stepUp, type TestClient } from '../helpers/harness';
import { CATALOG_URL, catalogKeys, manifestInput, signedCatalog, type AppsHarness } from './helpers';

export interface InstalledApp {
  readonly owner: TestClient;
  readonly access: string;
  readonly refresh: string;
  readonly webhookSecret: string;
  readonly installId: string;
  readonly appKey: CryptoKeyPair;
}

let jti = 0;

export async function clientAssertion(h: AppsHarness, key: CryptoKeyPair, appId = 'emailable'): Promise<string> {
  const now = Math.floor(h.clock.now / 1000);
  const head = toBase64Url(utf8(JSON.stringify({ alg: 'EdDSA', kid: 'k1', typ: 'JWT' })));
  const body = toBase64Url(
    utf8(
      JSON.stringify({
        iss: appId,
        sub: appId,
        aud: 'https://crm.example.com/api/apps/v1/token',
        iat: now,
        exp: now + 120,
        jti: `jti-${String(++jti)}-${String(Math.random()).slice(2)}`,
      }),
    ),
  );
  const sig = await crypto.subtle.sign('Ed25519', key.privateKey, utf8(`${head}.${body}`));
  return `${head}.${body}.${toBase64Url(new Uint8Array(sig))}`;
}

export async function bearer(h: AppsHarness, method: string, path: string, token: string, body?: unknown) {
  const response = await app.request(
    `https://crm.example.com${path}`,
    {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    h.env,
  );
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
  } catch {
    parsed = { text };
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

/** Catalog with `manifest`, an owner with step-up, consent and code exchange. */
export async function installApp(h: AppsHarness, overrides: Partial<AppManifestInput> = {}): Promise<InstalledApp> {
  clearJwksCache();
  await seedTenant(h, 'acme');
  const user = await seedUser(h, { email: 'owner@acme.test' });
  await addMember(h, user.id, 't_acme', 'owner');
  const keys = await catalogKeys();
  Object.assign(h.env, keys.env);
  const manifest = manifestInput(overrides);
  const catalog = await signedCatalog(keys.privateKey, [{ manifest }]);
  h.routes.set(CATALOG_URL, () => new Response(catalog));
  const appKey = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', appKey.publicKey);
  h.routes.set(String(manifest.jwks_url), () => Response.json({ keys: [{ ...jwk, kid: 'k1', alg: 'EdDSA', use: 'sig' }] }));
  await runCatalogSync(h.env, h.clock.now);
  const owner = await login(h, 'owner@acme.test');
  await stepUp(h, owner);
  const consent = await owner.post('/api/t/acme/apps/authorize', { app_id: manifest.id });
  expect(consent.status).toBe(200);
  const code = new URL(String(consent.body.redirect_url)).searchParams.get('code')!;
  const response = await app.request(
    'https://crm.example.com/api/apps/v1/token',
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: String(manifest.redirect_uris?.[0]),
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: await clientAssertion(h, appKey, manifest.id),
      }).toString(),
    },
    h.env,
  );
  const body = (await response.json()) as Record<string, unknown>;
  expect(response.status).toBe(200);
  return {
    owner,
    access: String(body.access_token),
    refresh: String(body.refresh_token),
    webhookSecret: String(body.webhook_secret),
    installId: String((body.installation as { id: string }).id),
    appKey,
  };
}
