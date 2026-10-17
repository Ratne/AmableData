import { APP_SENSITIVE_SCOPES, manifestHash, type AppManifest } from '@amable/core/apps';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../middleware';
import { getAuth, getTenant, requirePermission, requireSession, requireStepUp } from '../middleware/access';
import { audit } from '../middleware/audit';
import { isNewer, parseVersion } from '../platform/updates';
import { appOriginOf } from '../providers/select';
import { catalogConfig, catalogSyncState, fetchPrivateManifest, getCatalogApp, listCatalog, runCatalogSync } from './catalog-sync';
import { AppError } from './errors';
import { replayAppEvents, rotateWebhookSecret, sendAppEvent } from './events';
import {
  approvePendingScopes,
  createPendingInstall,
  pauseInstall,
  resumeInstall,
  uninstallApp,
} from './lifecycle';
import { appHealth } from './metrics';
import { installById, tenantInstalls, type AppInstall } from './store';
import { issueCode } from './tokens';
import { frameExtension, frameSession, isContactSlot } from './frames';
import { validateContactValues } from './validate-hook';

/**
 * Workspace side of the marketplace (`/api/t/:slug/apps/*`, used by the SPA):
 * catalog, consent, installed apps, permissions to approve, health, uninstall.
 * Installing and anything that changes what an app may do need a session with
 * a recent second factor.
 */

export const appsAdminRoutes = new Hono<AppEnv>();

// Apps never manage apps (their own install included).
appsAdminRoutes.use('*', async (c, next) => {
  if (getAuth(c).kind === 'app') return c.json({ error: 'forbidden' }, 403);
  return next();
});

appsAdminRoutes.onError((error, c) => {
  if (error instanceof AppError) {
    return c.json({ error: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) }, error.status);
  }
  throw error;
});

export function manifestView(manifest: AppManifest) {
  return {
    ...manifest,
    sensitive_scopes: manifest.scopes.filter((s) => (APP_SENSITIVE_SCOPES as readonly string[]).includes(s)),
  };
}

export function installView(install: AppInstall) {
  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
  return {
    id: install.id,
    app_id: install.appId,
    source: install.source,
    verified: install.source === 'catalog',
    manifest_url: install.manifestUrl,
    manifest: manifestView(install.manifest),
    status: install.status,
    status_reason: install.statusReason,
    scopes: install.scopes,
    pending_scopes: install.pendingScopes ?? [],
    api_version: install.apiVersion,
    installed_by: install.installedBy,
    keep_data: install.keepData,
    cleanup_until: iso(install.cleanupUntil),
    created_at: iso(install.createdAt),
    activated_at: iso(install.activatedAt),
    updated_at: iso(install.updatedAt),
  };
}

async function ownInstall(c: Context<AppEnv>): Promise<AppInstall> {
  const install = await installById(c.env.DB, c.req.param('id') ?? '');
  if (install === null || install.tenantId !== getTenant(c).tenant.id) {
    throw new AppError(404, 'not_found', 'app install not found');
  }
  return install;
}

const now = (c: Context<AppEnv>) => c.get('services').now();

// ------------------------------------------------------------------ catalog

appsAdminRoutes.get('/catalog', async (c) => {
  const config = catalogConfig(c.env);
  const installs = new Map((await tenantInstalls(c.env.DB, getTenant(c).tenant.id)).map((i) => [i.appId, i]));
  const apps = config.enabled ? await listCatalog(c.env.DB) : [];
  const state = await catalogSyncState(c.env.DB);
  return c.json({
    enabled: config.enabled,
    synced_at: state?.syncedAt === undefined ? null : new Date(state.syncedAt).toISOString(),
    sync_error: state?.ok === false ? state.error : null,
    data: apps.map((app) => ({
      manifest: manifestView(app.manifest),
      added_at: app.addedAt,
      install: installs.has(app.manifest.id) ? installView(installs.get(app.manifest.id)!) : null,
    })),
  });
});

appsAdminRoutes.get('/catalog/:appId', async (c) => {
  const app = await getCatalogApp(c.env.DB, c.req.param('appId'));
  if (app === null || app.revoked || !catalogConfig(c.env).enabled) throw new AppError(404, 'not_found', 'app not found');
  const install = (await tenantInstalls(c.env.DB, getTenant(c).tenant.id)).find((i) => i.appId === app.manifest.id);
  return c.json({ manifest: manifestView(app.manifest), added_at: app.addedAt, install: install === undefined ? null : installView(install) });
});

appsAdminRoutes.post('/catalog/refresh', requirePermission('apps:manage'), async (c) => {
  const state = await runCatalogSync(c.env, now(c), { force: true });
  return c.json({ state });
});

/** Private app: fetches and validates a manifest for the consent screen. */
appsAdminRoutes.post('/private/preview', requirePermission('apps:install'), async (c) => {
  const body = z.strictObject({ manifest_url: z.string().url().max(2000) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) throw new AppError(422, 'validation_failed', 'manifest_url is required');
  const { manifest } = await fetchPrivateManifest(c.env, body.data.manifest_url);
  return c.json({ manifest: manifestView(manifest), verified: false });
});

// ---------------------------------------------------------------- consent

const authorizeSchema = z
  .strictObject({
    app_id: z.string().regex(/^[a-z][a-z0-9-]{2,39}$/).optional(),
    manifest_url: z.string().url().max(2000).optional(),
    redirect_uri: z.string().url().max(2000).optional(),
    state: z.string().max(500).optional(),
    code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
    code_challenge_method: z.literal('S256').optional(),
  })
  .refine((v) => (v.app_id === undefined) !== (v.manifest_url === undefined), 'pass app_id or manifest_url')
  .refine((v) => v.code_challenge === undefined || v.code_challenge_method === 'S256', 'code_challenge_method must be S256');

/**
 * The admin accepts the requested permissions: a pending install and a
 * one-time code are created and the browser is sent to the app's redirect URI.
 */
appsAdminRoutes.post('/authorize', requireSession(), requirePermission('apps:install'), requireStepUp(), async (c) => {
  const parsed = authorizeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new AppError(422, 'validation_failed', parsed.error.issues[0]?.message ?? 'invalid request');
  }
  const input = parsed.data;
  const tenant = getTenant(c).tenant;
  let manifest: AppManifest;
  let hash: string;
  if (input.app_id !== undefined) {
    const app = catalogConfig(c.env).enabled ? await getCatalogApp(c.env.DB, input.app_id) : null;
    if (app === null || app.revoked) throw new AppError(404, 'not_found', 'app not found in the marketplace');
    manifest = app.manifest;
    hash = app.manifestHash;
  } else {
    ({ manifest, hash } = await fetchPrivateManifest(c.env, input.manifest_url!));
    const listed = await getCatalogApp(c.env.DB, manifest.id);
    if (listed?.revoked === true) throw new AppError(409, 'app_revoked', 'this app was revoked by the marketplace');
  }
  if (manifest.min_version !== undefined && parseVersion(c.env.APP_VERSION) !== null && isNewer(manifest.min_version, c.env.APP_VERSION!)) {
    throw new AppError(409, 'crm_too_old', `the app needs version ${manifest.min_version} or newer`);
  }
  const redirectUri = input.redirect_uri ?? manifest.redirect_uris[0]!;
  if (!manifest.redirect_uris.includes(redirectUri)) throw new AppError(422, 'invalid_redirect_uri', 'redirect_uri is not declared by the app');

  const install = await createPendingInstall(c.env, {
    tenantId: tenant.id,
    manifest,
    manifestHash: hash,
    source: input.app_id !== undefined ? 'catalog' : 'private',
    manifestUrl: input.manifest_url ?? null,
    userId: getAuth(c).user.id,
    nowMs: now(c),
  });
  const code = await issueCode(c.env.DB, {
    installId: install.id,
    redirectUri,
    codeChallenge: input.code_challenge ?? null,
    userId: getAuth(c).user.id,
    nowMs: now(c),
  });
  const target = new URL(redirectUri);
  target.searchParams.set('code', code);
  target.searchParams.set('installation_id', install.id);
  target.searchParams.set('tenant', tenant.slug);
  target.searchParams.set('iss', appOriginOf(c.env));
  if (input.state !== undefined) target.searchParams.set('state', input.state);
  await audit(c, 'app.install_consented', {
    target: install.id,
    details: { app: manifest.id, source: install.source, scopes: manifest.scopes.length },
  });
  return c.json({ redirect_url: target.toString(), install: installView(install) });
});

// --------------------------------------------------------------- installs

appsAdminRoutes.get('/installs', async (c) => {
  const installs = await tenantInstalls(c.env.DB, getTenant(c).tenant.id);
  return c.json({ data: installs.map(installView) });
});

/** What the installed apps add to the workspace (automation editor, screens); any member. */
appsAdminRoutes.get('/extensions', async (c) => {
  const installs = await tenantInstalls(c.env.DB, getTenant(c).tenant.id);
  return c.json({
    data: installs
      .filter((install) => install.status === 'active' || install.status === 'paused')
      .map((install) => ({
        install_id: install.id,
        app_id: install.appId,
        name: install.manifest.name,
        icon_url: install.manifest.icon_url,
        status: install.status,
        extensions: install.manifest.extensions,
      })),
  });
});

/** Opens an app screen: signed iframe URL with a 5-minute session token. */
appsAdminRoutes.post('/frames', requireSession(), async (c) => {
  const body = z
    .strictObject({
      app_id: z.string().regex(/^[a-z][a-z0-9-]{2,39}$/),
      key: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
      contact_id: z.string().min(1).max(64).optional(),
      theme: z.enum(['light', 'dark']).default('light'),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) throw new AppError(422, 'validation_failed', 'app_id and key are required');
  const tenant = getTenant(c);
  const install = (await tenantInstalls(c.env.DB, tenant.tenant.id)).find((i) => i.appId === body.data.app_id);
  if (install === undefined) throw new AppError(404, 'not_found', 'app not installed');
  const ui = frameExtension(install, body.data.key);
  if (ui === null) throw new AppError(404, 'not_found', 'screen not found');
  if (ui.slot === 'app.settings' && !tenant.can('apps:manage')) throw new AppError(403, 'forbidden', 'apps:manage required');
  if (isContactSlot(ui.slot) && !tenant.can('contacts:read')) throw new AppError(403, 'forbidden', 'contacts:read required');
  const user = getAuth(c).user;
  return c.json(
    await frameSession(c.env, {
      install,
      key: body.data.key,
      contactId: body.data.contact_id ?? null,
      tenant: tenant.tenant,
      user: { id: user.id, name: user.name, locale: user.locale },
      role: tenant.role,
      theme: body.data.theme,
      nowMs: now(c),
    }),
  );
});

/** Live check while a member types an email/phone (contact form); results are advisory. */
appsAdminRoutes.post('/validate', requirePermission('contacts:write'), async (c) => {
  const body = z
    .strictObject({ email: z.string().max(320).nullish(), phone: z.string().max(64).nullish() })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) throw new AppError(422, 'validation_failed', 'email or phone expected');
  const results = await validateContactValues(c.env, getTenant(c).tenant.id, body.data, 'crm');
  return c.json({
    data: results.map(({ app_id, app_name, valid, reason, fields, cached }) => ({ app_id, app_name, valid, reason, fields, cached })),
  });
});

appsAdminRoutes.get('/installs/:id', requirePermission('apps:manage'), async (c) => {
  const install = await ownInstall(c);
  const hours = Math.min(Math.max(Number(c.req.query('hours')) || 24, 1), 24 * 30);
  return c.json({ install: installView(install), health: await appHealth(c.env.DB, install.id, now(c), hours) });
});

appsAdminRoutes.get('/installs/:id/events', requirePermission('apps:manage'), async (c) => {
  const install = await ownInstall(c);
  const since = Math.max(Number(c.req.query('since')) || 0, 0);
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 200);
  return c.json(await replayAppEvents(c.env, install.id, { since, limit }));
});

appsAdminRoutes.post('/installs/:id/approve-scopes', requireSession(), requirePermission('apps:manage'), requireStepUp(), async (c) => {
  const install = await ownInstall(c);
  if (install.pendingManifest === null) throw new AppError(409, 'nothing_pending', 'no permissions waiting for approval');
  const updated = await approvePendingScopes(c.env, install, await manifestHash(install.pendingManifest), now(c));
  await audit(c, 'app.scopes_approved', { target: install.id, details: { app: install.appId, scopes: (install.pendingScopes ?? []).join(' ') } });
  return c.json({ install: installView(updated) });
});

appsAdminRoutes.post('/installs/:id/pause', requirePermission('apps:manage'), async (c) => {
  const install = await ownInstall(c);
  if (install.status !== 'active') throw new AppError(409, 'not_active', 'only an active app can be paused');
  await pauseInstall(c.env, install, 'paused_by_admin', now(c));
  await audit(c, 'app.paused', { target: install.id, details: { app: install.appId } });
  return c.json({ install: installView((await installById(c.env.DB, install.id))!) });
});

appsAdminRoutes.post('/installs/:id/resume', requirePermission('apps:manage'), async (c) => {
  const install = await ownInstall(c);
  const resumed = await resumeInstall(c.env, install, now(c));
  await audit(c, 'app.resumed', { target: install.id, details: { app: install.appId } });
  return c.json({ install: installView(resumed) });
});

appsAdminRoutes.post('/installs/:id/rotate-secret', requireSession(), requirePermission('apps:manage'), requireStepUp(), async (c) => {
  const install = await ownInstall(c);
  if (install.status !== 'active' && install.status !== 'paused') throw new AppError(409, 'not_installed', 'the app is not installed');
  await rotateWebhookSecret(c.env, install, now(c));
  await sendAppEvent(c.env, install, 'app.secret_rotated', { previous_valid_for_seconds: 86_400 }, now(c));
  await audit(c, 'app.secret_rotated', { target: install.id, details: { app: install.appId } });
  return c.json({ ok: true });
});

const uninstallSchema = z.strictObject({ keep_data: z.boolean() });

appsAdminRoutes.post('/installs/:id/uninstall', requireSession(), requirePermission('apps:manage'), requireStepUp(), async (c) => {
  const install = await ownInstall(c);
  const body = uninstallSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) throw new AppError(422, 'validation_failed', 'keep_data is required');
  const updated = await uninstallApp(c.env, install, { keepData: body.data.keep_data, nowMs: now(c) });
  await audit(c, 'app.uninstalled', { target: install.id, details: { app: install.appId, keep_data: body.data.keep_data } });
  return c.json({ install: installView(updated) });
});
