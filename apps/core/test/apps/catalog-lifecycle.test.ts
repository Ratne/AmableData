import { manifestHash, parseAppManifest, type AppManifest } from '@amable/core/apps';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { overrideAuthServices } from '../../src/auth/services';
import { runCatalogSync, getCatalogApp, listCatalog } from '../../src/apps/catalog-sync';
import {
  activateInstall,
  approvePendingScopes,
  CLEANUP_WINDOW_MS,
  createPendingInstall,
  finalizeUninstalls,
  uninstallApp,
} from '../../src/apps/lifecycle';
import { installById } from '../../src/apps/store';
import { tenantOp } from '../../src/apps/tenant';
import { addMember, seedTenant, seedUser } from '../helpers/harness';
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
let privateKey: string;
let catalogBody: string;

function parsed(overrides: Parameters<typeof manifestInput>[0] = {}): AppManifest {
  const result = parseAppManifest(manifestInput(overrides));
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.manifest;
}

let ownerId: string;

async function install(manifest = parsed()) {
  const pending = await createPendingInstall(h.env, {
    tenantId: 't_acme',
    manifest,
    manifestHash: await manifestHash(manifest),
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
  const user = await seedUser(h, { email: 'owner@acme.test', mfa: null });
  await addMember(h, user.id, 't_acme', 'owner');
  ownerId = user.id;
  const keys = await catalogKeys();
  privateKey = keys.privateKey;
  Object.assign(h.env, keys.env);
  catalogBody = await signedCatalog(privateKey, [{ manifest: manifestInput() }]);
  h.routes.set(CATALOG_URL, () => new Response(catalogBody));
});

afterEach(() => {
  resetAppsHarness();
  overrideAuthServices(null);
});

describe('catalog sync', () => {
  it('stores the verified index and waits 6 hours before the next download', async () => {
    const state = await runCatalogSync(h.env, h.clock.now);
    expect(state).toMatchObject({ ok: true, apps: 1 });
    expect((await listCatalog(h.env.DB)).map((a) => a.manifest.id)).toEqual(['emailable']);
    await runCatalogSync(h.env, h.clock.now + 3600_000);
    expect(h.calls.filter((c) => c.url === CATALOG_URL)).toHaveLength(1);
  });

  it('rejects an index signed by an unknown key and keeps the previous catalog', async () => {
    await runCatalogSync(h.env, h.clock.now);
    const other = await catalogKeys();
    catalogBody = await signedCatalog(other.privateKey, []);
    const state = await runCatalogSync(h.env, h.clock.now, { force: true });
    expect(state).toMatchObject({ ok: false, error: 'bad_signature' });
    expect(await listCatalog(h.env.DB)).toHaveLength(1);
  });

  it('turns the marketplace off with APP_CATALOG=off', async () => {
    Object.assign(h.env, { APP_CATALOG: 'off' });
    expect(await runCatalogSync(h.env, h.clock.now)).toBeNull();
    expect(h.calls).toHaveLength(0);
  });

  it('revoking an app disables every install, its tokens and its endpoint', async () => {
    await runCatalogSync(h.env, h.clock.now);
    const active = await install();
    expect(active.status).toBe('active');
    catalogBody = await signedCatalog(privateKey, [
      { manifest: manifestInput(), revoked: true, revoked_reason: 'leaks data' },
    ]);
    await runCatalogSync(h.env, h.clock.now, { force: true });
    const after = await installById(h.env.DB, active.id);
    expect(after).toMatchObject({ status: 'revoked', statusReason: 'leaks data' });
    const endpoint = await h.env.DB.prepare(`SELECT status FROM webhook_endpoints WHERE app_install_id = ?`)
      .bind(active.id)
      .first<{ status: string }>();
    expect(endpoint?.status).toBe('disabled');
    expect(await listCatalog(h.env.DB)).toHaveLength(0);
    expect((await getCatalogApp(h.env.DB, 'emailable'))?.revoked).toBe(true);
    expect(h.emails.some((e) => e.subject.includes('removed from the marketplace'))).toBe(true);
  });

  it('applies updates without new scopes and holds the ones asking for more', async () => {
    await runCatalogSync(h.env, h.clock.now);
    const active = await install();
    catalogBody = await signedCatalog(privateKey, [{ manifest: manifestInput({ name: 'Emailable 2' }) }]);
    await runCatalogSync(h.env, h.clock.now, { force: true });
    expect((await installById(h.env.DB, active.id))?.manifest.name).toBe('Emailable 2');

    const wider = manifestInput({ scopes: ['contacts:read', 'contacts:write', 'forms:read'] });
    catalogBody = await signedCatalog(privateKey, [{ manifest: wider }]);
    await runCatalogSync(h.env, h.clock.now, { force: true });
    const pending = await installById(h.env.DB, active.id);
    expect(pending?.scopes).toEqual(['contacts:read', 'contacts:write']);
    expect(pending?.pendingScopes).toEqual(['forms:read']);
    const approved = await approvePendingScopes(h.env, pending!, await manifestHash(pending!.pendingManifest), h.clock.now);
    expect(approved.scopes).toContain('forms:read');
    expect(approved.pendingScopes).toBeNull();
  });
});

describe('install lifecycle', () => {
  it('activation creates the endpoint, the owned field and sends app.installed', async () => {
    const active = await install();
    expect(active.activatedAt).toBe(h.clock.now);
    const fields = await tenantOp<Array<{ key: string; owner_app_id: string | null }>>(
      h.env,
      't_acme',
      'customFields.list',
      { entity: 'contact' },
    );
    expect(fields.find((f) => f.key === 'app_emailable_email_status')?.owner_app_id).toBe('emailable');
    await h.drain();
    const delivery = h.calls.find((c) => c.url === 'https://apps.example.com/webhooks');
    expect(delivery).toBeDefined();
    const body = JSON.parse(delivery!.body) as Record<string, unknown>;
    expect(body).toMatchObject({ type: 'app.installed', installation_id: active.id, api_version: '2026-10', sequence: 1 });
  });

  it('uninstall notifies the app, waits for the cleanup window, then applies the data choice', async () => {
    const active = await install();
    await tenantOp(h.env, 't_acme', 'apps.data.set', { appId: 'emailable', key: 'k', value: '"v"', secret: false });
    const uninstalling = await uninstallApp(h.env, active, { keepData: false, nowMs: h.clock.now });
    expect(uninstalling.status).toBe('uninstalling');
    await h.drain();
    expect(h.calls.some((c) => c.body.includes('"app.uninstalled"'))).toBe(true);

    expect(await finalizeUninstalls(h.env, h.clock.now + CLEANUP_WINDOW_MS - 1)).toBe(0);
    expect(await finalizeUninstalls(h.env, h.clock.now + CLEANUP_WINDOW_MS)).toBe(1);
    expect((await installById(h.env.DB, active.id))?.status).toBe('uninstalled');
    expect(await tenantOp<unknown[]>(h.env, 't_acme', 'apps.data.list', { appId: 'emailable' })).toEqual([]);

    // Reinstalling reuses the row.
    const again = await install(parsed());
    expect(again.id).toBe(active.id);
    expect(again.status).toBe('active');
  });
});
