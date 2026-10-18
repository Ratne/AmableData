import {
  CATALOG_PUBLIC_KEYS,
  DEFAULT_CATALOG_URL,
  manifestHash,
  parseAppManifest,
  verifySignedCatalog,
  type AppManifest,
} from '@amable/core/apps';
import type { Env } from '../env';
import { AppError } from './errors';
import { appFetch, type AppHttpResponse } from './http';
import { applyManifestUpdate, revokeApp } from './lifecycle';
import { installsOfApp, toInstall, type AppInstall, type InstallRow } from './store';

/**
 * Marketplace catalog of this installation: the signed index published by the
 * catalog repo, downloaded every CATALOG_SYNC_INTERVAL_MS and stored in
 * `app_catalog` only after the signature checks out. Self-hosters can point
 * APP_CATALOG_URL at their own index (signed with their own key) or turn the
 * marketplace off with APP_CATALOG=off.
 */

export const CATALOG_SYNC_INTERVAL_MS = 6 * 3600 * 1000;
export const CATALOG_SYNC_KEY = 'app_catalog_sync';
const FETCH_TIMEOUT_MS = 15_000;
const MAX_INDEX_BYTES = 20_000_000;

export interface CatalogConfig {
  readonly enabled: boolean;
  readonly url: string;
  readonly keys: Readonly<Record<string, string>>;
}

/** `APP_CATALOG_PUBLIC_KEY` = `<key_id>:<base64 raw Ed25519>`, comma separated. */
export function catalogConfig(env: Env): CatalogConfig {
  const extra: Record<string, string> = {};
  for (const item of (env.APP_CATALOG_PUBLIC_KEY ?? '').split(',')) {
    const [id, key] = item.trim().split(':');
    if (id !== undefined && key !== undefined && id !== '' && key !== '') extra[id] = key;
  }
  const custom = env.APP_CATALOG_URL?.trim();
  return {
    enabled: env.APP_CATALOG?.trim().toLowerCase() !== 'off',
    url: custom === undefined || custom === '' ? DEFAULT_CATALOG_URL : custom,
    // A custom catalog is trusted only with its own keys.
    keys: custom === undefined || custom === '' ? { ...CATALOG_PUBLIC_KEYS, ...extra } : extra,
  };
}

export interface CatalogSyncState {
  readonly syncedAt: number;
  readonly ok: boolean;
  readonly apps: number;
  readonly error: string | null;
  readonly skipped: Array<{ id: string; issues: string[] }>;
}

export async function catalogSyncState(db: D1Database): Promise<CatalogSyncState | null> {
  const row = await db.prepare(`SELECT value FROM installation_meta WHERE key = ?`).bind(CATALOG_SYNC_KEY).first<{ value: string }>();
  if (row === null) return null;
  try {
    return JSON.parse(row.value) as CatalogSyncState;
  } catch {
    return null;
  }
}

async function writeState(db: D1Database, state: CatalogSyncState): Promise<void> {
  await db
    .prepare(
      `INSERT INTO installation_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .bind(CATALOG_SYNC_KEY, JSON.stringify(state))
    .run();
}

export type CatalogFetcher = (url: string, maxBytes: number) => Promise<AppHttpResponse>;

function defaultFetcher(env: Env): CatalogFetcher {
  return (url, maxBytes) => appFetch(env, url, { headers: { accept: 'application/json' } }, { timeoutMs: FETCH_TIMEOUT_MS, maxBytes });
}

interface CatalogRow {
  app_id: string;
  manifest_hash: string;
}

/**
 * Downloads, verifies and stores the catalog, then propagates it to installs:
 * revoked apps are disabled everywhere, changed manifests go through
 * applyManifestUpdate (new scopes wait for an admin). A failure keeps the
 * previous catalog; `force` ignores the interval (admin "refresh").
 */
export async function runCatalogSync(
  env: Env,
  nowMs: number,
  options: { force?: boolean; fetcher?: CatalogFetcher } = {},
): Promise<CatalogSyncState | null> {
  const config = catalogConfig(env);
  if (!config.enabled) return null;
  const previous = await catalogSyncState(env.DB);
  if (options.force !== true && previous !== null && nowMs - previous.syncedAt < CATALOG_SYNC_INTERVAL_MS) {
    return previous;
  }
  const fail = async (error: string): Promise<CatalogSyncState> => {
    const state: CatalogSyncState = { syncedAt: nowMs, ok: false, apps: previous?.apps ?? 0, error, skipped: [] };
    await writeState(env.DB, state);
    console.warn(`[apps] catalog sync failed: ${error}`);
    return state;
  };
  if (Object.keys(config.keys).length === 0) return fail('no catalog public key configured');

  let raw: unknown;
  try {
    const response = await (options.fetcher ?? defaultFetcher(env))(config.url, MAX_INDEX_BYTES);
    if (response.status !== 200) return await fail(`HTTP ${String(response.status)}`);
    raw = JSON.parse(response.text) as unknown;
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'download failed');
  }
  const verified = await verifySignedCatalog(raw, config.keys);
  if (!verified.ok) return fail(verified.reason);

  const existing = new Map(
    (await env.DB.prepare(`SELECT app_id, manifest_hash FROM app_catalog`).all<CatalogRow>()).results.map((r) => [
      r.app_id,
      r.manifest_hash,
    ]),
  );
  const seen = new Set<string>();
  const updates: Array<{ manifest: AppManifest; hash: string }> = [];
  const revocations: Array<{ id: string; reason: string }> = [];
  const statements: D1PreparedStatement[] = [];
  for (const entry of verified.index.apps) {
    const id = entry.manifest.id;
    if (seen.has(id)) continue;
    seen.add(id);
    const hash = await manifestHash(entry.manifest);
    statements.push(
      env.DB.prepare(
        `INSERT INTO app_catalog (app_id, manifest, manifest_hash, revoked, revoked_reason, added_at, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(app_id) DO UPDATE SET manifest = excluded.manifest, manifest_hash = excluded.manifest_hash,
           revoked = excluded.revoked, revoked_reason = excluded.revoked_reason, added_at = excluded.added_at,
           synced_at = excluded.synced_at`,
      ).bind(
        id,
        JSON.stringify(entry.manifest),
        hash,
        entry.revoked ? 1 : 0,
        entry.revoked_reason ?? null,
        entry.added_at ?? null,
        nowMs,
      ),
    );
    if (entry.revoked) revocations.push({ id, reason: entry.revoked_reason ?? 'revoked by the marketplace' });
    else if (existing.get(id) !== hash) updates.push({ manifest: entry.manifest, hash });
  }
  // Apps that left the index stay installed where they are; only the listing goes.
  for (const id of existing.keys()) {
    if (!seen.has(id)) statements.push(env.DB.prepare(`DELETE FROM app_catalog WHERE app_id = ?`).bind(id));
  }
  for (let i = 0; i < statements.length; i += 50) await env.DB.batch(statements.slice(i, i + 50));

  for (const revocation of revocations) await revokeApp(env, revocation.id, revocation.reason, nowMs);
  for (const update of updates) {
    for (const install of await installsOfApp(env.DB, update.manifest.id)) {
      if (install.source !== 'catalog') continue;
      await applyManifestUpdate(env, install, update.manifest, update.hash, nowMs).catch((error: unknown) => {
        console.error(`[apps] update ${install.id} failed:`, error instanceof Error ? error.message : error);
      });
    }
  }
  const state: CatalogSyncState = {
    syncedAt: nowMs,
    ok: true,
    apps: seen.size,
    error: null,
    skipped: verified.invalid,
  };
  await writeState(env.DB, state);
  return state;
}

export interface CatalogApp {
  readonly manifest: AppManifest;
  readonly manifestHash: string;
  readonly revoked: boolean;
  readonly revokedReason: string | null;
  readonly addedAt: string | null;
}

interface StoredCatalogRow {
  app_id: string;
  manifest: string;
  manifest_hash: string;
  revoked: number;
  revoked_reason: string | null;
  added_at: string | null;
}

const toCatalogApp = (row: StoredCatalogRow): CatalogApp => ({
  manifest: JSON.parse(row.manifest) as AppManifest,
  manifestHash: row.manifest_hash,
  revoked: row.revoked === 1,
  revokedReason: row.revoked_reason,
  addedAt: row.added_at,
});

/** Listed apps (revoked ones are hidden from the marketplace). */
export async function listCatalog(db: D1Database): Promise<CatalogApp[]> {
  const rows = await db
    .prepare(`SELECT * FROM app_catalog WHERE revoked = 0 ORDER BY app_id`)
    .all<StoredCatalogRow>();
  return rows.results.map(toCatalogApp);
}

export async function getCatalogApp(db: D1Database, appId: string): Promise<CatalogApp | null> {
  const row = await db.prepare(`SELECT * FROM app_catalog WHERE app_id = ?`).bind(appId).first<StoredCatalogRow>();
  return row === null ? null : toCatalogApp(row);
}

/**
 * Private apps: an admin installs from a manifest URL that is not in the
 * catalog (internal tools, apps under review). https only, except
 * http://localhost with ENVIRONMENT=dev for local development.
 */
export async function fetchPrivateManifest(
  env: Env,
  url: string,
  fetcher?: CatalogFetcher,
): Promise<{ manifest: AppManifest; hash: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AppError(422, 'invalid_manifest_url', 'not a valid URL');
  }
  const local = parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(local && env.ENVIRONMENT === 'dev')) {
    throw new AppError(422, 'invalid_manifest_url', 'the manifest must be served over https');
  }
  let raw: unknown;
  try {
    const response = await (fetcher ?? defaultFetcher(env))(parsed.toString(), 512 * 1024);
    if (response.status !== 200) throw new AppError(422, 'manifest_unreachable', `HTTP ${String(response.status)}`);
    raw = JSON.parse(response.text) as unknown;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(422, 'manifest_unreachable', error instanceof Error ? error.message : 'download failed');
  }
  const check = parseAppManifest(raw);
  if (!check.ok) throw new AppError(422, 'invalid_manifest', 'the manifest is not valid', check.issues);
  if (check.manifest.base_url.startsWith('http://') && env.ENVIRONMENT !== 'dev') {
    throw new AppError(422, 'invalid_manifest', 'development manifests (http://localhost) need ENVIRONMENT=dev');
  }
  return { manifest: check.manifest, hash: await manifestHash(check.manifest) };
}

export const PRIVATE_REFRESH_KEY = 'app_private_refresh';

/**
 * Apps installed from a URL get manifest updates like catalog ones: every
 * CATALOG_SYNC_INTERVAL_MS each `manifest_url` is fetched again (once per URL)
 * and changes go through applyManifestUpdate (new scopes wait for an admin).
 * An unreachable or invalid manifest, or one now describing another app,
 * keeps the installed one.
 */
export async function refreshPrivateInstalls(
  env: Env,
  nowMs: number,
  options: { force?: boolean; tenantId?: string; fetcher?: CatalogFetcher } = {},
): Promise<{ checked: number; updated: number; failed: number }> {
  const result = { checked: 0, updated: 0, failed: 0 };
  if (options.force !== true) {
    const last = await env.DB.prepare(`SELECT value FROM installation_meta WHERE key = ?`)
      .bind(PRIVATE_REFRESH_KEY)
      .first<{ value: string }>();
    if (last !== null && nowMs - Number(last.value) < CATALOG_SYNC_INTERVAL_MS) return result;
    await env.DB.prepare(
      `INSERT INTO installation_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
      .bind(PRIVATE_REFRESH_KEY, String(nowMs))
      .run();
  }
  const rows = await env.DB.prepare(
    `SELECT * FROM app_installs WHERE source = 'private' AND manifest_url IS NOT NULL
       AND status IN ('pending', 'active', 'paused') AND (? IS NULL OR tenant_id = ?)`,
  )
    .bind(options.tenantId ?? null, options.tenantId ?? null)
    .all<InstallRow>();
  const byUrl = new Map<string, AppInstall[]>();
  for (const install of rows.results.map(toInstall)) {
    const url = install.manifestUrl!;
    byUrl.set(url, [...(byUrl.get(url) ?? []), install]);
  }
  for (const [url, installs] of byUrl) {
    let fetched: { manifest: AppManifest; hash: string };
    try {
      fetched = await fetchPrivateManifest(env, url, options.fetcher);
    } catch (error) {
      result.failed += installs.length;
      console.warn(`[apps] private manifest ${url} not refreshed:`, error instanceof Error ? error.message : error);
      continue;
    }
    for (const install of installs) {
      result.checked += 1;
      if (fetched.manifest.id !== install.appId) {
        result.failed += 1;
        console.warn(`[apps] private manifest ${url} now describes ${fetched.manifest.id}, not ${install.appId}`);
        continue;
      }
      try {
        const outcome = await applyManifestUpdate(env, install, fetched.manifest, fetched.hash, nowMs);
        if (outcome !== 'unchanged') result.updated += 1;
      } catch (error) {
        result.failed += 1;
        console.error(`[apps] update ${install.id} failed:`, error instanceof Error ? error.message : error);
      }
    }
  }
  return result;
}
