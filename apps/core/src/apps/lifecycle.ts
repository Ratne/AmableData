import { newScopes, type AppManifest } from '@amable/core/apps';
import { monotonicFactory } from 'ulid';
import { getAuthServices } from '../auth/services';
import type { Env } from '../env';
import { appSecretAd } from '../webhooks/service';
import { AppError } from './errors';
import {
  appEventTypes,
  currentWebhookSecret,
  newWebhookSecret,
  sendAppEvent,
  upsertAppEndpoint,
} from './events';
import { notifyAppAdmins } from './notify';
import { installById, installFor, installsOfApp, type AppInstall, type InstallSource } from './store';
import { tenantOp } from './tenant';

/**
 * Lifecycle of an install: pending (consent given, waiting for the app's first
 * code exchange) → active ⇄ paused → uninstalling (cleanup window) → uninstalled.
 * `revoked` is set by the catalog kill switch and only allows uninstalling.
 */

const nextId = monotonicFactory();
/** After uninstall, the app may still delete its own copies before the data choice is applied. */
export const CLEANUP_WINDOW_MS = 48 * 3600 * 1000;

async function tenantSlug(env: Env, tenantId: string): Promise<string> {
  const row = await env.DB.prepare(`SELECT slug FROM tenants WHERE id = ?`).bind(tenantId).first<{ slug: string }>();
  return row?.slug ?? '';
}

async function reload(env: Env, id: string): Promise<AppInstall> {
  const install = await installById(env.DB, id);
  if (install === null) throw new AppError(404, 'not_found', 'install not found');
  return install;
}

export async function revokeTokens(db: D1Database, installId: string, nowMs: number): Promise<void> {
  await db
    .prepare(`UPDATE app_tokens SET revoked_at = ? WHERE install_id = ? AND revoked_at IS NULL`)
    .bind(nowMs, installId)
    .run();
}

async function disableEndpoint(db: D1Database, installId: string, reason: string, nowMs: number): Promise<void> {
  await db
    .prepare(`UPDATE webhook_endpoints SET status = 'disabled', disabled_reason = ?, updated_at = ? WHERE app_install_id = ?`)
    .bind(reason, nowMs, installId)
    .run();
}

async function ensureFields(env: Env, install: AppInstall): Promise<void> {
  if (install.manifest.custom_fields.length === 0) return;
  const result = await tenantOp<{ conflicts: string[] }>(env, install.tenantId, 'apps.fields.ensure', {
    appId: install.appId,
    appName: install.manifest.name,
    fields: install.manifest.custom_fields,
  });
  if (result.conflicts.length > 0) {
    console.warn(`[apps] ${install.appId}: custom field keys owned by another app: ${result.conflicts.join(', ')}`);
  }
}

export interface CreateInstallInput {
  readonly tenantId: string;
  readonly manifest: AppManifest;
  readonly manifestHash: string;
  readonly source: InstallSource;
  readonly manifestUrl: string | null;
  readonly userId: string;
  readonly nowMs: number;
}

/**
 * Records the admin's consent. Every requested scope is granted (an app either
 * gets what its manifest declares or is not installed). A previous, fully
 * uninstalled row of the same app is reused so the tenant keeps one row per app.
 */
export async function createPendingInstall(env: Env, input: CreateInstallInput): Promise<AppInstall> {
  const existing = await installFor(env.DB, input.tenantId, input.manifest.id);
  if (existing !== null && ['active', 'paused', 'uninstalling'].includes(existing.status)) {
    throw new AppError(409, 'already_installed', 'the app is already installed in this workspace');
  }
  const id = existing?.id ?? `ins_${nextId(input.nowMs)}`;
  const box = (await getAuthServices(env)).secretBox;
  const secret = await box.encrypt(newWebhookSecret(), appSecretAd(id, 'current'));
  const values = [
    input.source,
    input.manifestUrl,
    JSON.stringify(input.manifest),
    input.manifestHash,
    input.manifest.api_version,
    JSON.stringify(input.manifest.scopes),
    input.userId,
    secret,
    input.nowMs,
  ];
  if (existing === null) {
    await env.DB.prepare(
      `INSERT INTO app_installs (source, manifest_url, manifest, manifest_hash, api_version, scopes, installed_by,
         webhook_secret, updated_at, id, tenant_id, app_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
      .bind(...values, id, input.tenantId, input.manifest.id, input.nowMs)
      .run();
  } else {
    await revokeTokens(env.DB, id, input.nowMs);
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM app_oauth_codes WHERE install_id = ?`).bind(id),
      env.DB.prepare(
        `UPDATE app_installs SET source = ?, manifest_url = ?, manifest = ?, manifest_hash = ?, api_version = ?, scopes = ?,
           installed_by = ?, webhook_secret = ?, updated_at = ?, status = 'pending', status_reason = NULL,
           pending_scopes = NULL, pending_manifest = NULL, webhook_secret_prev = NULL, webhook_secret_prev_until = NULL,
           hook_failures = 0, hook_open_until = NULL, keep_data = NULL, cleanup_until = NULL, activated_at = NULL,
           uninstalled_at = NULL
         WHERE id = ?`,
      ).bind(...values, id),
    ]);
  }
  return reload(env, id);
}

/** First successful code exchange: the app now holds its credentials and webhook secret. */
export async function activateInstall(env: Env, install: AppInstall, nowMs: number): Promise<AppInstall> {
  if (install.status !== 'pending') return install;
  await env.DB.prepare(`UPDATE app_installs SET status = 'active', activated_at = ?, updated_at = ? WHERE id = ?`)
    .bind(nowMs, nowMs, install.id)
    .run();
  const active = await reload(env, install.id);
  const secret = await currentWebhookSecret(env, install.id);
  await upsertAppEndpoint(env, active, { ...(secret === null ? {} : { secret }), nowMs });
  await ensureFields(env, active);
  await sendAppEvent(env, active, 'app.installed', {
    app_id: active.appId,
    tenant: await tenantSlug(env, active.tenantId),
    scopes: active.scopes,
    installed_by: active.installedBy,
  }, nowMs);
  return active;
}

/**
 * A new manifest from the catalog (or a refreshed private manifest). Without new
 * scopes it applies at once (removed scopes are dropped); with new scopes it
 * waits for an admin while the app keeps running with what was granted.
 */
export async function applyManifestUpdate(
  env: Env,
  install: AppInstall,
  manifest: AppManifest,
  hash: string,
  nowMs: number,
): Promise<'unchanged' | 'applied' | 'pending'> {
  if (install.manifestHash === hash || install.pendingManifest !== null && JSON.stringify(install.pendingManifest) === JSON.stringify(manifest)) {
    return 'unchanged';
  }
  const added = newScopes(install.scopes, manifest.scopes);
  if (added.length > 0) {
    await env.DB.prepare(`UPDATE app_installs SET pending_manifest = ?, pending_scopes = ?, updated_at = ? WHERE id = ?`)
      .bind(JSON.stringify(manifest), JSON.stringify(added), nowMs, install.id)
      .run();
    if (install.status === 'active') {
      await sendAppEvent(env, install, 'app.scopes_pending', { scopes: added }, nowMs);
    }
    await notifyAppAdmins(env, install.tenantId, 'scopes_pending', { app: manifest.name, scopes: added });
    return 'pending';
  }
  const scopes = install.scopes.filter((scope) => manifest.scopes.includes(scope as never));
  await env.DB.prepare(
    `UPDATE app_installs SET manifest = ?, manifest_hash = ?, api_version = ?, scopes = ?, pending_manifest = NULL,
       pending_scopes = NULL, updated_at = ? WHERE id = ?`,
  )
    .bind(JSON.stringify(manifest), hash, manifest.api_version, JSON.stringify(scopes), nowMs, install.id)
    .run();
  const updated = await reload(env, install.id);
  if (updated.status === 'active' || updated.status === 'paused') {
    await syncEndpoint(env, updated, nowMs);
    await ensureFields(env, updated);
  }
  return 'applied';
}

async function syncEndpoint(env: Env, install: AppInstall, nowMs: number): Promise<void> {
  const exists = await env.DB.prepare(`SELECT status FROM webhook_endpoints WHERE app_install_id = ?`)
    .bind(install.id)
    .first<{ status: string }>();
  if (exists === null) return;
  await upsertAppEndpoint(env, install, { eventTypes: appEventTypes(install.manifest, install.scopes), nowMs });
  if (install.status !== 'active') await disableEndpoint(env.DB, install.id, 'app_paused', nowMs);
}

/** Admin approval of the scopes a manifest update asked for. */
export async function approvePendingScopes(env: Env, install: AppInstall, manifestHash: string, nowMs: number): Promise<AppInstall> {
  if (install.pendingManifest === null) throw new AppError(409, 'nothing_pending', 'no permissions waiting for approval');
  const manifest = install.pendingManifest;
  await env.DB.prepare(
    `UPDATE app_installs SET manifest = ?, manifest_hash = ?, api_version = ?, scopes = ?, pending_manifest = NULL,
       pending_scopes = NULL, updated_at = ? WHERE id = ?`,
  )
    .bind(JSON.stringify(manifest), manifestHash, manifest.api_version, JSON.stringify(manifest.scopes), nowMs, install.id)
    .run();
  const updated = await reload(env, install.id);
  await syncEndpoint(env, updated, nowMs);
  await ensureFields(env, updated);
  if (updated.status === 'active') {
    await sendAppEvent(env, updated, 'app.scopes_granted', { scopes: updated.scopes }, nowMs);
  }
  return updated;
}

export async function pauseInstall(env: Env, install: AppInstall, reason: string, nowMs: number): Promise<void> {
  if (install.status !== 'active') return;
  await env.DB.prepare(`UPDATE app_installs SET status = 'paused', status_reason = ?, updated_at = ? WHERE id = ?`)
    .bind(reason, nowMs, install.id)
    .run();
  await disableEndpoint(env.DB, install.id, 'app_paused', nowMs);
  await notifyAppAdmins(env, install.tenantId, 'paused', { app: install.manifest.name, reason });
}

export async function resumeInstall(env: Env, install: AppInstall, nowMs: number): Promise<AppInstall> {
  if (install.status !== 'paused') throw new AppError(409, 'not_paused', 'only a paused app can be resumed');
  await env.DB.prepare(
    `UPDATE app_installs SET status = 'active', status_reason = NULL, hook_failures = 0, hook_open_until = NULL,
       updated_at = ? WHERE id = ?`,
  )
    .bind(nowMs, install.id)
    .run();
  const active = await reload(env, install.id);
  await upsertAppEndpoint(env, active, { nowMs });
  return active;
}

/**
 * Starts an uninstall: the app is told at once (`app.uninstalled`) and keeps a
 * token restricted to its own data for CLEANUP_WINDOW_MS; the cron then applies
 * the tenant's choice about fields and values the app created.
 */
export async function uninstallApp(
  env: Env,
  install: AppInstall,
  options: { keepData: boolean; nowMs: number },
): Promise<AppInstall> {
  if (install.status === 'uninstalling' || install.status === 'uninstalled') {
    throw new AppError(409, 'already_uninstalled', 'the app is already being uninstalled');
  }
  const notifyApp = install.status === 'active' || install.status === 'paused';
  if (install.status === 'pending') {
    await finalize(env, { ...install, keepData: options.keepData }, options.nowMs);
    return reload(env, install.id);
  }
  await env.DB.prepare(
    `UPDATE app_installs SET status = 'uninstalling', keep_data = ?, cleanup_until = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(options.keepData ? 1 : 0, options.nowMs + CLEANUP_WINDOW_MS, options.nowMs, install.id)
    .run();
  if (notifyApp) {
    await sendAppEvent(env, install, 'app.uninstalled', {
      app_id: install.appId,
      keep_data: options.keepData,
      cleanup_until: new Date(options.nowMs + CLEANUP_WINDOW_MS).toISOString(),
    }, options.nowMs);
  }
  return reload(env, install.id);
}

async function finalize(env: Env, install: AppInstall, nowMs: number): Promise<void> {
  await tenantOp(env, install.tenantId, 'apps.cleanup', { appId: install.appId, keepData: install.keepData === true });
  await revokeTokens(env.DB, install.id, nowMs);
  await disableEndpoint(env.DB, install.id, 'app_uninstalled', nowMs);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM app_oauth_codes WHERE install_id = ?`).bind(install.id),
    env.DB.prepare(`DELETE FROM app_hook_cache WHERE install_id = ?`).bind(install.id),
    env.DB.prepare(
      `UPDATE app_installs SET status = 'uninstalled', uninstalled_at = ?, updated_at = ?, cleanup_until = NULL,
         webhook_secret = NULL, webhook_secret_prev = NULL, webhook_secret_prev_until = NULL,
         pending_manifest = NULL, pending_scopes = NULL WHERE id = ?`,
    ).bind(nowMs, nowMs, install.id),
  ]);
}

/** Cron: closes the uninstalls whose cleanup window is over (a few per tick). */
export async function finalizeUninstalls(env: Env, nowMs: number, limit = 20): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT id FROM app_installs WHERE status = 'uninstalling' AND cleanup_until <= ? ORDER BY cleanup_until LIMIT ?`,
  )
    .bind(nowMs, limit)
    .all<{ id: string }>();
  let done = 0;
  for (const row of rows.results) {
    const install = await installById(env.DB, row.id);
    if (install === null) continue;
    try {
      await finalize(env, install, nowMs);
      done += 1;
    } catch (error) {
      console.error(`[apps] finalize ${row.id} failed:`, error instanceof Error ? error.message : error);
    }
  }
  return done;
}

/** Kill switch: every install of the app stops at once (tokens, events, extensions). */
export async function revokeApp(env: Env, appId: string, reason: string, nowMs: number): Promise<number> {
  const installs = await installsOfApp(env.DB, appId);
  for (const install of installs) {
    await env.DB.prepare(`UPDATE app_installs SET status = 'revoked', status_reason = ?, updated_at = ? WHERE id = ?`)
      .bind(reason, nowMs, install.id)
      .run();
    await revokeTokens(env.DB, install.id, nowMs);
    await disableEndpoint(env.DB, install.id, 'app_revoked', nowMs);
    await notifyAppAdmins(env, install.tenantId, 'revoked', { app: install.manifest.name, reason });
  }
  return installs.length;
}
