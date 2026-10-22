import { formatLicenseKey } from '@amable/core/platform';
import { DEPLOYED_APP_ORIGIN, manifestHash, parseAppManifest, type AppManifestInput } from '@amable/core/apps';
import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { overrideAuthServices } from '../../src/auth/services';
import { getCatalogApp, runCatalogSync } from '../../src/apps/catalog-sync';
import { overrideCloudflareFetch } from '../../src/apps/cloudflare';
import {
  deployedManifest,
  ensureAppDeployed,
  getDeployment,
  releaseUnusedDeployments,
  UNUSED_DEPLOYMENT_GRACE_MS,
} from '../../src/apps/deployer';
import { activateInstall, createPendingInstall, uninstallApp } from '../../src/apps/lifecycle';
import { installById } from '../../src/apps/store';
import { overrideControlPlaneFetch } from '../../src/platform/client';
import { addMember, login, seedTenant, seedUser, stepUp, type TestClient } from '../helpers/harness';
import { CATALOG_URL, catalogKeys, createAppsHarness, manifestInput, resetAppsHarness, signedCatalog, type AppsHarness } from './helpers';

const CF = 'https://api.cloudflare.com/client/v4';
const TOKEN = 'cf_test_token_0123456789abcdef0123';
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const SUBDOMAIN = 'acme-sub';
const ORIGIN = `https://amable-app-emailable.${SUBDOMAIN}.workers.dev`;
const BUNDLE_URL = 'https://github.com/Ratne/AmableData/releases/download/app-emailable-1.0.0/worker.mjs';
const BUNDLE_V1 = 'export default { fetch: () => new Response("v1") };';
const BUNDLE_V2 = 'export default { fetch: () => new Response("v2") };';

const sha256 = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

async function deployable(bundle: string, overrides: Partial<AppManifestInput> = {}): Promise<AppManifestInput> {
  return manifestInput({
    base_url: DEPLOYED_APP_ORIGIN,
    jwks_url: `${DEPLOYED_APP_ORIGIN}/.well-known/jwks.json`,
    redirect_uris: [`${DEPLOYED_APP_ORIGIN}/install`],
    deployment: {
      kind: 'cloudflare_worker',
      bundle_url: BUNDLE_URL,
      bundle_sha256: await sha256(bundle),
      compatibility_date: '2026-10-01',
      d1: [{ binding: 'DB' }],
      cron: ['*/5 * * * *'],
    },
    ...overrides,
  });
}

interface FakeCloudflare {
  tokenActive: boolean;
  subdomain: string | null;
  readonly scripts: Map<string, { metadata: { bindings: Array<Record<string, string>>; compatibility_date: string }; code: string }>;
  readonly databases: Map<string, string>;
  readonly schedules: Map<string, string[]>;
  readonly workersDev: Set<string>;
}

function fakeCloudflare(): FakeCloudflare {
  const cf: FakeCloudflare = {
    tokenActive: true,
    subdomain: SUBDOMAIN,
    scripts: new Map(),
    databases: new Map(),
    schedules: new Map(),
    workersDev: new Set(),
  };
  const ok = (result: unknown) => Response.json({ success: true, errors: [], result });
  const fail = (status: number, code: number, message: string) =>
    Response.json({ success: false, errors: [{ code, message }], result: null }, { status });
  overrideCloudflareFetch(async (input, init) => {
    if (!input.startsWith(CF)) return fetch(input, init);
    if (new Headers(init?.headers).get('authorization') !== `Bearer ${TOKEN}` || !cf.tokenActive) {
      return fail(403, 10000, 'Authentication error');
    }
    const url = new URL(input);
    const path = url.pathname.slice('/client/v4'.length);
    const method = init?.method ?? 'GET';
    const account = `/accounts/${ACCOUNT}`;
    if (path === '/user/tokens/verify') return ok({ status: 'active' });
    if (path === '/accounts') return ok([{ id: ACCOUNT, name: 'Acme' }]);
    if (!path.startsWith(account)) return fail(403, 9109, 'no access to this account');
    const rest = path.slice(account.length);
    if (rest === '/workers/subdomain') {
      if (method === 'PUT') {
        cf.subdomain = (JSON.parse(String(init?.body)) as { subdomain: string }).subdomain;
        return ok({ subdomain: cf.subdomain });
      }
      return cf.subdomain === null ? fail(404, 10007, 'no subdomain') : ok({ subdomain: cf.subdomain });
    }
    if (rest === '/d1/database' && method === 'GET') {
      const name = url.searchParams.get('name');
      return ok([...cf.databases].filter(([, n]) => name === null || n === name).map(([uuid, n]) => ({ uuid, name: n })));
    }
    if (rest === '/d1/database' && method === 'POST') {
      const uuid = crypto.randomUUID();
      cf.databases.set(uuid, (JSON.parse(String(init?.body)) as { name: string }).name);
      return ok({ uuid });
    }
    const db = rest.match(/^\/d1\/database\/([0-9a-f-]+)$/);
    if (db !== null && method === 'DELETE') return cf.databases.delete(db[1]!) ? ok(null) : fail(404, 7404, 'not found');
    const script = rest.match(/^\/workers\/scripts\/([a-z0-9-]+)(\/subdomain|\/schedules)?$/);
    if (script !== null) {
      const [, name, sub] = script as unknown as [string, string, string | undefined];
      if (sub === undefined && method === 'PUT') {
        const form = init?.body as FormData;
        cf.scripts.set(name, {
          metadata: JSON.parse(await (form.get('metadata') as Blob).text()) as never,
          code: await (form.get('worker.mjs') as Blob).text(),
        });
        return ok({ id: name });
      }
      if (sub === undefined && method === 'DELETE') {
        cf.schedules.delete(name);
        cf.workersDev.delete(name);
        return cf.scripts.delete(name) ? ok(null) : fail(404, 10007, 'not found');
      }
      if (!cf.scripts.has(name)) return fail(404, 10007, 'script not found');
      if (sub === '/subdomain') return (cf.workersDev.add(name), ok({ enabled: true }));
      if (sub === '/schedules') {
        cf.schedules.set(name, (JSON.parse(String(init?.body)) as Array<{ cron: string }>).map((s) => s.cron));
        return ok({ schedules: [] });
      }
    }
    return fail(404, 7003, `unknown route ${method} ${path}`);
  });
  return cf;
}

let h: AppsHarness;
let cf: FakeCloudflare;
let privateKey: string;
let catalog: AppManifestInput[];
let bundle: string;
let ownerId: string;

async function publish(...apps: AppManifestInput[]) {
  catalog = apps;
  await runCatalogSync(h.env, h.clock.now, { force: true });
}

async function owner(): Promise<TestClient> {
  const client = await login(h, 'owner@acme.test');
  await stepUp(h, client);
  return client;
}

async function connectCloudflare(client: TestClient) {
  const saved = await client.post('/api/t/acme/apps/cloudflare', { token: TOKEN, account_id: ACCOUNT });
  expect(saved.status).toBe(200);
}

async function installDeployed() {
  const app = (await getCatalogApp(h.env.DB, 'emailable'))!;
  const record = await ensureAppDeployed(h.env, app.manifest, h.clock.now);
  const pending = await createPendingInstall(h.env, {
    tenantId: 't_acme',
    manifest: deployedManifest(app.manifest, record),
    manifestHash: app.manifestHash,
    source: 'catalog',
    manifestUrl: null,
    userId: ownerId,
    nowMs: h.clock.now,
  });
  return activateInstall(h.env, pending, h.clock.now);
}

beforeEach(async () => {
  h = await createAppsHarness();
  await seedTenant(h, 'acme');
  const user = await seedUser(h, { email: 'owner@acme.test' });
  await addMember(h, user.id, 't_acme', 'owner');
  ownerId = user.id;
  const keys = await catalogKeys();
  privateKey = keys.privateKey;
  Object.assign(h.env, keys.env);
  bundle = BUNDLE_V1;
  catalog = [];
  h.routes.set(CATALOG_URL, async () => new Response(await signedCatalog(privateKey, catalog.map((manifest) => ({ manifest })))));
  h.routes.set(BUNDLE_URL, () => new Response(bundle));
  h.routes.set(`${ORIGIN}/.well-known/jwks.json`, () => Response.json({ keys: [] }));
  cf = fakeCloudflare();
});

afterEach(() => {
  overrideCloudflareFetch(null);
  overrideControlPlaneFetch(null);
  resetAppsHarness();
  overrideAuthServices(null);
});

describe('self-hosted: apps deployed with the installation token', () => {
  it('asks for a token, then deploys the Worker, its database and cron, and installs on it', async () => {
    await publish(await deployable(BUNDLE_V1));
    const client = await owner();

    const early = await client.post('/api/t/acme/apps/deployments/emailable');
    expect(early.status).toBe(409);
    expect(early.body.error).toBe('cloudflare_token_required');
    const consentFirst = await client.post('/api/t/acme/apps/authorize', { app_id: 'emailable' });
    expect(consentFirst.body.error).toBe('deployment_required');

    const accounts = await client.post('/api/t/acme/apps/cloudflare/accounts', { token: TOKEN });
    expect(accounts.body.data).toEqual([{ id: ACCOUNT, name: 'Acme' }]);
    await connectCloudflare(client);
    const stored = await h.env.DB.prepare(`SELECT token, token_hint FROM app_cloudflare_credentials`).first<{ token: string; token_hint: string }>();
    expect(stored?.token).not.toContain(TOKEN);
    expect(stored?.token_hint).toBe('…0123');
    expect((await client.get('/api/t/acme/apps/cloudflare')).body).toMatchObject({
      provider: 'direct',
      credentials: { account_id: ACCOUNT, account_name: 'Acme', status: 'active' },
    });

    const deployed = await client.post('/api/t/acme/apps/deployments/emailable');
    expect(deployed.status).toBe(200);
    expect(deployed.body.deployment).toMatchObject({ status: 'ready', provider: 'direct', origin: ORIGIN, reachable: true });
    const script = cf.scripts.get('amable-app-emailable')!;
    expect(script.code).toBe(BUNDLE_V1);
    const [dbId, dbName] = [...cf.databases][0]!;
    expect(dbName).toBe('amable-app-emailable-db');
    expect(script.metadata.bindings).toEqual([
      { type: 'd1', name: 'DB', id: dbId },
      { type: 'plain_text', name: 'APP_BASE_URL', text: ORIGIN },
    ]);
    expect(cf.schedules.get('amable-app-emailable')).toEqual(['*/5 * * * *']);
    expect(cf.workersDev.has('amable-app-emailable')).toBe(true);

    const consent = await client.post('/api/t/acme/apps/authorize', { app_id: 'emailable' });
    expect(consent.status).toBe(200);
    expect(String(consent.body.redirect_url).startsWith(`${ORIGIN}/install?`)).toBe(true);
    const install = await installById(h.env.DB, String((consent.body.install as { id: string }).id));
    expect(install?.manifest).toMatchObject({ base_url: ORIGIN, jwks_url: `${ORIGIN}/.well-known/jwks.json`, redirect_uris: [`${ORIGIN}/install`] });
    expect(install?.manifestHash).toBe((await getCatalogApp(h.env.DB, 'emailable'))!.manifestHash);
  });

  it('refuses a bundle that does not match the signed catalog', async () => {
    await publish(await deployable(BUNDLE_V1));
    const client = await owner();
    await connectCloudflare(client);
    bundle = 'export default { fetch: () => new Response("tampered") };';
    const response = await client.post('/api/t/acme/apps/deployments/emailable');
    expect(response.status).toBe(502);
    expect(response.body.error).toBe('bundle_mismatch');
    expect(cf.scripts.size).toBe(0);
  });

  it('only owners connect the account, and a token Cloudflare refuses is not saved', async () => {
    await publish(await deployable(BUNDLE_V1));
    const admin = await seedUser(h, { email: 'admin@acme.test' });
    await addMember(h, admin.id, 't_acme', 'admin');
    const client = await login(h, 'admin@acme.test');
    await stepUp(h, client);
    expect((await client.post('/api/t/acme/apps/cloudflare', { token: TOKEN, account_id: ACCOUNT })).status).toBe(403);
    const ownerClient = await owner();
    cf.tokenActive = false;
    const refused = await ownerClient.post('/api/t/acme/apps/cloudflare', { token: TOKEN, account_id: ACCOUNT });
    expect(refused.body.error).toBe('cloudflare_token_invalid');
    expect(await h.env.DB.prepare(`SELECT 1 FROM app_cloudflare_credentials`).first()).toBeNull();
  });

  it('redeploys on a catalog update before moving installs, and keeps the running version when it fails', async () => {
    await publish(await deployable(BUNDLE_V1));
    await connectCloudflare(await owner());
    const active = await installDeployed();

    bundle = BUNDLE_V2;
    await publish(await deployable(BUNDLE_V2, { name: 'Emailable 2' }));
    expect(cf.scripts.get('amable-app-emailable')?.code).toBe(BUNDLE_V2);
    expect(cf.databases.size).toBe(1);
    expect((await installById(h.env.DB, active.id))?.manifest).toMatchObject({ name: 'Emailable 2', base_url: ORIGIN });

    // The token is deleted on Cloudflare: the update waits, the app keeps running.
    const BUNDLE_V3 = 'export default { fetch: () => new Response("v3") };';
    bundle = BUNDLE_V3;
    cf.tokenActive = false;
    await publish(await deployable(BUNDLE_V3, { name: 'Emailable 3' }));
    expect(cf.scripts.get('amable-app-emailable')?.code).toBe(BUNDLE_V2);
    expect((await installById(h.env.DB, active.id))?.manifest.name).toBe('Emailable 2');
    expect(await getDeployment(h.env.DB, 'emailable')).toMatchObject({ status: 'ready', error: expect.stringContaining('no longer valid') });
    expect(h.emails.some((e) => e.subject.includes('not installed'))).toBe(true);

    // A new token: the next sync retries the same catalog.
    cf.tokenActive = true;
    await connectCloudflare(await owner());
    await runCatalogSync(h.env, h.clock.now, { force: true });
    expect(cf.scripts.get('amable-app-emailable')?.code).toBe(BUNDLE_V3);
    expect((await installById(h.env.DB, active.id))?.manifest.name).toBe('Emailable 3');
  });

  it('deletes the Worker, its cron and its database when the last workspace uninstalled', async () => {
    await publish(await deployable(BUNDLE_V1));
    await connectCloudflare(await owner());
    const active = await installDeployed();
    h.clock.advance(UNUSED_DEPLOYMENT_GRACE_MS + 1);
    expect(await releaseUnusedDeployments(h.env, h.clock.now)).toBe(0);
    expect(cf.scripts.size).toBe(1);

    await uninstallApp(h.env, active, { keepData: false, nowMs: h.clock.now });
    expect(await releaseUnusedDeployments(h.env, h.clock.now)).toBe(0);
    const { finalizeUninstalls } = await import('../../src/apps/lifecycle');
    h.clock.advance(49 * 3600 * 1000);
    await finalizeUninstalls(h.env, h.clock.now);
    expect(await releaseUnusedDeployments(h.env, h.clock.now)).toBe(1);
    expect(cf.scripts.size).toBe(0);
    expect(cf.databases.size).toBe(0);
    expect(await getDeployment(h.env.DB, 'emailable')).toBeNull();
  });

  it('installs from a manifest URL never deploy into the account', async () => {
    const parsed = parseAppManifest(await deployable(BUNDLE_V1));
    expect(parsed.ok).toBe(true);
    h.routes.set('https://apps.example.com/manifest.json', async () => Response.json(await deployable(BUNDLE_V1)));
    const client = await owner();
    const preview = await client.post('/api/t/acme/apps/private/preview', { manifest_url: 'https://apps.example.com/manifest.json' });
    expect(preview.status).toBe(422);
  });
});

describe('Cloud: apps deployed by the control plane', () => {
  const CP = 'https://cp.test';

  function linkToCloud(answer: (body: unknown) => Response) {
    Object.assign(h.env, { LICENSE_KEY: formatLicenseKey(ulid(), 'b'.repeat(40)), CONTROL_PLANE_URL: CP });
    const calls: Array<{ path: string; body: unknown }> = [];
    overrideControlPlaneFetch(async (input, init) => {
      const body = JSON.parse(String(init?.body ?? 'null')) as unknown;
      calls.push({ path: new URL(input).pathname, body });
      return answer(body);
    });
    return calls;
  }

  it('asks the control plane to deploy with the onboarding token; nothing to connect', async () => {
    await publish(await deployable(BUNDLE_V1));
    const calls = linkToCloud(() =>
      Response.json({ account_id: ACCOUNT, script_name: 'amable-app-emailable', origin: ORIGIN, databases: [{ binding: 'DB', name: 'amable-app-emailable-db', id: 'db-1' }] }),
    );
    const client = await owner();
    expect((await client.get('/api/t/acme/apps/cloudflare')).body).toEqual({ provider: 'control_plane', credentials: null });
    expect((await client.post('/api/t/acme/apps/cloudflare', { token: TOKEN, account_id: ACCOUNT })).body.error).toBe('managed_by_portal');

    const deployed = await client.post('/api/t/acme/apps/deployments/emailable');
    expect(deployed.body.deployment).toMatchObject({ provider: 'control_plane', origin: ORIGIN, status: 'ready' });
    expect(calls).toEqual([
      {
        path: '/v1/installation/apps/deploy',
        body: {
          app_id: 'emailable',
          deployment: expect.objectContaining({ bundle_url: BUNDLE_URL, bundle_sha256: await sha256(BUNDLE_V1), d1: [{ binding: 'DB' }] }),
        },
      },
    ]);
    expect(cf.scripts.size).toBe(0);
    const consent = await client.post('/api/t/acme/apps/authorize', { app_id: 'emailable' });
    expect(String(consent.body.redirect_url).startsWith(`${ORIGIN}/install?`)).toBe(true);
  });

  it('tells the admin to recreate the token from the portal when it was deleted', async () => {
    await publish(await deployable(BUNDLE_V1));
    linkToCloud(() => Response.json({ error: 'token_inactive' }, { status: 409 }));
    const client = await owner();
    const response = await client.post('/api/t/acme/apps/deployments/emailable');
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('cloudflare_token_inactive');
    expect(String(response.body.message)).toContain('portal');
  });
});

describe('hash of deployed installs', () => {
  it('keeps the catalog hash, so an unchanged catalog does not reapply', async () => {
    await publish(await deployable(BUNDLE_V1));
    await connectCloudflare(await owner());
    const active = await installDeployed();
    const before = await installById(h.env.DB, active.id);
    await runCatalogSync(h.env, h.clock.now, { force: true });
    const after = await installById(h.env.DB, active.id);
    expect(after?.updatedAt).toBe(before?.updatedAt);
    expect(after?.manifestHash).not.toBe(await manifestHash(after!.manifest));
  });
});
