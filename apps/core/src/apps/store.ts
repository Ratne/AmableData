import type { AppManifest } from '@amable/core/apps';

/** Rows of the installation D1 tables behind marketplace apps (migration 0007). */

export type InstallStatus = 'pending' | 'active' | 'paused' | 'uninstalling' | 'uninstalled' | 'revoked';
export type InstallSource = 'catalog' | 'private';

export interface InstallRow {
  id: string;
  tenant_id: string;
  app_id: string;
  source: InstallSource;
  manifest_url: string | null;
  manifest: string;
  manifest_hash: string;
  api_version: string;
  scopes: string;
  pending_scopes: string | null;
  pending_manifest: string | null;
  status: InstallStatus;
  status_reason: string | null;
  installed_by: string | null;
  webhook_secret: string | null;
  webhook_secret_prev: string | null;
  webhook_secret_prev_until: number | null;
  webhook_endpoint_id: string | null;
  hook_failures: number;
  hook_open_until: number | null;
  keep_data: number | null;
  cleanup_until: number | null;
  created_at: number;
  updated_at: number;
  activated_at: number | null;
  uninstalled_at: number | null;
}

/** Parsed view of an install row. */
export interface AppInstall {
  readonly id: string;
  readonly tenantId: string;
  readonly appId: string;
  readonly source: InstallSource;
  readonly manifestUrl: string | null;
  readonly manifest: AppManifest;
  readonly manifestHash: string;
  readonly apiVersion: string;
  readonly scopes: string[];
  readonly pendingScopes: string[] | null;
  readonly pendingManifest: AppManifest | null;
  readonly status: InstallStatus;
  readonly statusReason: string | null;
  readonly installedBy: string | null;
  readonly webhookEndpointId: string | null;
  readonly hookFailures: number;
  readonly hookOpenUntil: number | null;
  readonly keepData: boolean | null;
  readonly cleanupUntil: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly activatedAt: number | null;
  readonly uninstalledAt: number | null;
}

function parseList(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function toInstall(row: InstallRow): AppInstall {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    appId: row.app_id,
    source: row.source,
    manifestUrl: row.manifest_url,
    manifest: JSON.parse(row.manifest) as AppManifest,
    manifestHash: row.manifest_hash,
    apiVersion: row.api_version,
    scopes: parseList(row.scopes) ?? [],
    pendingScopes: parseList(row.pending_scopes),
    pendingManifest: row.pending_manifest === null ? null : (JSON.parse(row.pending_manifest) as AppManifest),
    status: row.status,
    statusReason: row.status_reason,
    installedBy: row.installed_by,
    webhookEndpointId: row.webhook_endpoint_id,
    hookFailures: row.hook_failures,
    hookOpenUntil: row.hook_open_until,
    keepData: row.keep_data === null ? null : row.keep_data === 1,
    cleanupUntil: row.cleanup_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activatedAt: row.activated_at,
    uninstalledAt: row.uninstalled_at,
  };
}

export async function installRowById(db: D1Database, id: string): Promise<InstallRow | null> {
  return db.prepare(`SELECT * FROM app_installs WHERE id = ?`).bind(id).first<InstallRow>();
}

export async function installById(db: D1Database, id: string): Promise<AppInstall | null> {
  const row = await installRowById(db, id);
  return row === null ? null : toInstall(row);
}

export async function installFor(db: D1Database, tenantId: string, appId: string): Promise<AppInstall | null> {
  const row = await db
    .prepare(`SELECT * FROM app_installs WHERE tenant_id = ? AND app_id = ?`)
    .bind(tenantId, appId)
    .first<InstallRow>();
  return row === null ? null : toInstall(row);
}

/** Installs of a tenant that are visible in the UI (everything but fully uninstalled). */
export async function tenantInstalls(db: D1Database, tenantId: string): Promise<AppInstall[]> {
  const rows = await db
    .prepare(`SELECT * FROM app_installs WHERE tenant_id = ? AND status <> 'uninstalled' ORDER BY created_at`)
    .bind(tenantId)
    .all<InstallRow>();
  return rows.results.map(toInstall);
}

/** Installs whose extensions run (hooks, actions, screens, events). */
export async function activeInstalls(db: D1Database, tenantId: string): Promise<AppInstall[]> {
  const rows = await db
    .prepare(`SELECT * FROM app_installs WHERE tenant_id = ? AND status = 'active' ORDER BY created_at`)
    .bind(tenantId)
    .all<InstallRow>();
  return rows.results.map(toInstall);
}

export async function installsOfApp(db: D1Database, appId: string): Promise<AppInstall[]> {
  const rows = await db
    .prepare(`SELECT * FROM app_installs WHERE app_id = ? AND status IN ('pending', 'active', 'paused')`)
    .bind(appId)
    .all<InstallRow>();
  return rows.results.map(toInstall);
}

export function isRunning(install: Pick<AppInstall, 'status'>): boolean {
  return install.status === 'active';
}
