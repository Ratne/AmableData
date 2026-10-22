import { safeFetch } from '@amable/auth/security';
import {
  appDatabaseName,
  appWorkerName,
  isDeployableManifest,
  resolveDeployedManifest,
  type AppManifest,
  type ReleasedDeployment,
} from '@amable/core/apps';
import { getAuthServices } from '../auth/services';
import type { Env } from '../env';
import { isManagedOffering } from '../platform/billing';
import { controlPlaneClient, ControlPlaneError } from '../platform/client';
import { CloudflareApiError, CloudflareAppsApi, deployFetch, type CloudflareAccount } from './cloudflare';
import { AppError } from './errors';
import { appFetch } from './http';

/**
 * Official Marketplace apps run in the installation's own Cloudflare account,
 * never in the catalog maintainer's: the first install deploys the app's
 * Worker (one per installation, shared by its workspaces) with its D1
 * databases and crons, catalog updates redeploy it, and when the last
 * workspace uninstalls it everything is deleted from the account.
 *
 * Who holds the Cloudflare token:
 * - `control_plane` (managed offering): the control plane, with the token the
 *   customer gave at onboarding; the CRM only asks it to deploy;
 * - `direct` (self-hosted): this installation, with a token an owner pastes
 *   once (Workers Scripts Edit + D1 Edit), stored encrypted.
 */

export type DeployProvider = 'direct' | 'control_plane';

export interface DeployedDatabase {
  readonly binding: string;
  readonly name: string;
  readonly id: string;
}

export interface AppDeploymentRecord {
  readonly appId: string;
  readonly provider: DeployProvider;
  readonly accountId: string | null;
  readonly scriptName: string;
  readonly origin: string | null;
  readonly databases: DeployedDatabase[];
  readonly bundleSha256: string | null;
  readonly status: 'ready' | 'failed';
  readonly error: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface DeployResult {
  readonly accountId: string | null;
  readonly scriptName: string;
  readonly origin: string;
  readonly databases: DeployedDatabase[];
}

export interface AppDeployer {
  readonly provider: DeployProvider;
  deploy(appId: string, deployment: ReleasedDeployment): Promise<DeployResult>;
  destroy(record: AppDeploymentRecord): Promise<void>;
}

/** Unused deployments (an install abandoned before consent) stay this long before deletion. */
export const UNUSED_DEPLOYMENT_GRACE_MS = 3600 * 1000;
const MAX_BUNDLE_BYTES = 10 * 1024 * 1024;
const TOKEN_AD = 'app-cloudflare-token';

export const tokenRequired = () =>
  new AppError(409, 'cloudflare_token_required', 'connect a Cloudflare account to install this app');
const tokenInvalid = () =>
  new AppError(409, 'cloudflare_token_invalid', 'the Cloudflare token is no longer valid: create a new one');
const tokenInactive = () =>
  new AppError(409, 'cloudflare_token_inactive', 'the Cloudflare token of this workspace is no longer valid: create it again from the portal');

// ---------------------------------------------------------------- records

interface DeploymentRow {
  app_id: string;
  provider: DeployProvider;
  account_id: string | null;
  script_name: string;
  origin: string | null;
  databases: string;
  bundle_sha256: string | null;
  status: 'ready' | 'failed';
  error: string | null;
  created_at: number;
  updated_at: number;
}

const toRecord = (row: DeploymentRow): AppDeploymentRecord => ({
  appId: row.app_id,
  provider: row.provider,
  accountId: row.account_id,
  scriptName: row.script_name,
  origin: row.origin,
  databases: JSON.parse(row.databases) as DeployedDatabase[],
  bundleSha256: row.bundle_sha256,
  status: row.status,
  error: row.error,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export async function getDeployment(db: D1Database, appId: string): Promise<AppDeploymentRecord | null> {
  const row = await db.prepare(`SELECT * FROM app_deployments WHERE app_id = ?`).bind(appId).first<DeploymentRow>();
  return row === null ? null : toRecord(row);
}

export async function listDeployments(db: D1Database): Promise<AppDeploymentRecord[]> {
  return (await db.prepare(`SELECT * FROM app_deployments ORDER BY app_id`).all<DeploymentRow>()).results.map(toRecord);
}

async function saveDeployment(db: D1Database, record: AppDeploymentRecord): Promise<void> {
  await db
    .prepare(
      `INSERT INTO app_deployments (app_id, provider, account_id, script_name, origin, databases, bundle_sha256, status, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(app_id) DO UPDATE SET provider = excluded.provider, account_id = excluded.account_id,
         script_name = excluded.script_name, origin = excluded.origin, databases = excluded.databases,
         bundle_sha256 = excluded.bundle_sha256, status = excluded.status, error = excluded.error,
         updated_at = excluded.updated_at`,
    )
    .bind(
      record.appId,
      record.provider,
      record.accountId,
      record.scriptName,
      record.origin,
      JSON.stringify(record.databases),
      record.bundleSha256,
      record.status,
      record.error,
      record.createdAt,
      record.updatedAt,
    )
    .run();
}

/** The catalog manifest with its URLs on this installation's Worker (what the install keeps). */
export function deployedManifest(manifest: AppManifest, record: AppDeploymentRecord): AppManifest {
  if (record.origin === null) throw new AppError(409, 'deployment_required', 'the app is not deployed yet');
  return resolveDeployedManifest(manifest, record.origin);
}

/** Deployed and running the catalog's bundle. */
export function isCurrent(
  record: AppDeploymentRecord | null,
  manifest: AppManifest,
): record is AppDeploymentRecord & { status: 'ready'; origin: string } {
  return (
    record !== null &&
    record.status === 'ready' &&
    record.origin !== null &&
    isDeployableManifest(manifest) &&
    record.bundleSha256 === manifest.deployment.bundle_sha256
  );
}

// ------------------------------------------------------------ credentials

interface CredentialsRow {
  token: string;
  token_hint: string;
  account_id: string;
  account_name: string | null;
  status: 'active' | 'invalid';
  verified_at: number;
}

export interface CloudflareCredentials {
  readonly accountId: string;
  readonly accountName: string | null;
  readonly tokenHint: string;
  readonly status: 'active' | 'invalid';
  readonly verifiedAt: number;
}

export async function cloudflareCredentials(db: D1Database): Promise<CloudflareCredentials | null> {
  const row = await db.prepare(`SELECT * FROM app_cloudflare_credentials WHERE id = 1`).first<CredentialsRow>();
  if (row === null) return null;
  return {
    accountId: row.account_id,
    accountName: row.account_name,
    tokenHint: row.token_hint,
    status: row.status,
    verifiedAt: row.verified_at,
  };
}

async function storedToken(env: Env): Promise<{ token: string; accountId: string } | null> {
  const row = await env.DB.prepare(`SELECT token, account_id, status FROM app_cloudflare_credentials WHERE id = 1`).first<
    Pick<CredentialsRow, 'token' | 'account_id' | 'status'>
  >();
  if (row === null) return null;
  if (row.status === 'invalid') throw tokenInvalid();
  const box = (await getAuthServices(env)).secretBox;
  return { token: await box.decrypt(row.token, TOKEN_AD), accountId: row.account_id };
}

async function markTokenInvalid(db: D1Database, nowMs: number): Promise<void> {
  await db.prepare(`UPDATE app_cloudflare_credentials SET status = 'invalid', updated_at = ? WHERE id = 1`).bind(nowMs).run();
}

/** The accounts a token can deploy to (shown before saving it). */
export async function tokenAccounts(token: string): Promise<CloudflareAccount[]> {
  const api = new CloudflareAppsApi(token);
  if (!(await api.tokenActive())) throw new AppError(422, 'cloudflare_token_invalid', 'Cloudflare does not accept this token');
  return api.accounts().catch(() => []);
}

export async function saveCloudflareCredentials(
  env: Env,
  input: { token: string; accountId: string; userId: string; nowMs: number },
): Promise<CloudflareCredentials> {
  const api = new CloudflareAppsApi(input.token);
  if (!(await api.tokenActive())) throw new AppError(422, 'cloudflare_token_invalid', 'Cloudflare does not accept this token');
  const accounts = await api.accounts().catch(() => [] as CloudflareAccount[]);
  try {
    // Workers Scripts and D1 are what deploying needs; both answer a list call.
    await api.workersSubdomain(input.accountId);
    await api.findDatabase(input.accountId, appDatabaseName('probe', 'DB'));
  } catch (error) {
    if (error instanceof CloudflareApiError && (error.unauthorized || error.status === 404)) {
      throw new AppError(422, 'cloudflare_permissions', 'the token needs Workers Scripts Edit and D1 Edit on this account');
    }
    throw error;
  }
  const box = (await getAuthServices(env)).secretBox;
  const token = await box.encrypt(input.token, TOKEN_AD);
  const name = accounts.find((a) => a.id === input.accountId)?.name ?? null;
  await env.DB.prepare(
    `INSERT INTO app_cloudflare_credentials (id, token, token_hint, account_id, account_name, status, saved_by, verified_at, created_at, updated_at)
     VALUES (1, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET token = excluded.token, token_hint = excluded.token_hint, account_id = excluded.account_id,
       account_name = excluded.account_name, status = 'active', saved_by = excluded.saved_by,
       verified_at = excluded.verified_at, updated_at = excluded.updated_at`,
  )
    .bind(token, `…${input.token.slice(-4)}`, input.accountId, name, input.userId, input.nowMs, input.nowMs, input.nowMs)
    .run();
  return (await cloudflareCredentials(env.DB))!;
}

export async function deleteCloudflareCredentials(db: D1Database): Promise<void> {
  await db.prepare(`DELETE FROM app_cloudflare_credentials WHERE id = 1`).run();
}

// --------------------------------------------------------------- providers

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** The release bundle, checked against the SHA-256 of the signed catalog. */
export async function downloadBundle(deployment: ReleasedDeployment): Promise<Uint8Array> {
  let response;
  try {
    response = await safeFetch(deployment.bundle_url, { method: 'GET' }, {
      fetchFn: deployFetch(),
      timeoutMs: 30_000,
      maxBytes: MAX_BUNDLE_BYTES,
      maxRedirects: 5,
    });
  } catch (error) {
    throw new AppError(502, 'deploy_failed', `the app bundle could not be downloaded: ${error instanceof Error ? error.message : 'error'}`);
  }
  if (response.status !== 200) throw new AppError(502, 'deploy_failed', `the app bundle could not be downloaded (HTTP ${String(response.status)})`);
  const digest = hex(await crypto.subtle.digest('SHA-256', response.body as Uint8Array<ArrayBuffer>));
  if (digest !== deployment.bundle_sha256) throw new AppError(502, 'bundle_mismatch', 'the app bundle does not match the catalog');
  return response.body;
}

function directDeployer(env: Env, credentials: { token: string; accountId: string }, nowMs: number): AppDeployer {
  const api = new CloudflareAppsApi(credentials.token);
  const guard = async <T>(run: () => Promise<T>, onOwnAccount = true): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof CloudflareApiError && error.unauthorized) {
        // A token saved later for another account says nothing about this one.
        if (onOwnAccount) await markTokenInvalid(env.DB, nowMs);
        throw tokenInvalid();
      }
      if (error instanceof CloudflareApiError) throw new AppError(502, 'deploy_failed', `Cloudflare: ${error.message}`);
      throw error;
    }
  };
  return {
    provider: 'direct',
    deploy: (appId, deployment) =>
      guard(async () => {
        const code = await downloadBundle(deployment);
        const accountId = credentials.accountId;
        const scriptName = appWorkerName(appId);
        const subdomain =
          (await api.workersSubdomain(accountId)) ?? (await api.createWorkersSubdomain(accountId, `amable-${accountId.slice(0, 12)}`));
        const databases: DeployedDatabase[] = [];
        for (const { binding } of deployment.d1) {
          const name = appDatabaseName(appId, binding);
          databases.push({ binding, name, id: (await api.findDatabase(accountId, name)) ?? (await api.createDatabase(accountId, name)) });
        }
        const origin = `https://${scriptName}.${subdomain}.workers.dev`;
        await api.uploadWorker(accountId, scriptName, { name: 'worker.mjs', code }, {
          compatibilityDate: deployment.compatibility_date,
          compatibilityFlags: deployment.compatibility_flags,
          bindings: [
            ...databases.map((d) => ({ type: 'd1' as const, name: d.binding, id: d.id })),
            { type: 'plain_text' as const, name: 'APP_BASE_URL', text: origin },
          ],
        });
        await api.enableWorkersDev(accountId, scriptName);
        await api.setSchedules(accountId, scriptName, deployment.cron);
        return { accountId, scriptName, origin, databases };
      }),
    destroy: (record) => {
      const accountId = record.accountId ?? credentials.accountId;
      return guard(async () => {
        await api.deleteWorker(accountId, record.scriptName);
        for (const db of record.databases) await api.deleteDatabase(accountId, db.id);
      }, accountId === credentials.accountId);
    },
  };
}

/** Cloud: the control plane deploys with the customer's onboarding token. */
function controlPlaneDeployer(env: Env): AppDeployer | null {
  const client = controlPlaneClient(env);
  if (client === null) return null;
  const guard = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ControlPlaneError && error.code === 'token_inactive') throw tokenInactive();
      if (error instanceof ControlPlaneError && error.code === 'bundle_mismatch') {
        throw new AppError(502, 'bundle_mismatch', 'the app bundle does not match the catalog');
      }
      if (error instanceof ControlPlaneError) throw new AppError(502, 'deploy_failed', `control plane: ${error.code}`);
      throw error;
    }
  };
  return {
    provider: 'control_plane',
    deploy: (appId, deployment) =>
      guard(async () => {
        const result = await client.post<{ account_id: string; script_name: string; origin: string; databases: DeployedDatabase[] }>(
          '/apps/deploy',
          {
            app_id: appId,
            deployment: {
              bundle_url: deployment.bundle_url,
              bundle_sha256: deployment.bundle_sha256,
              compatibility_date: deployment.compatibility_date,
              compatibility_flags: deployment.compatibility_flags,
              d1: deployment.d1,
              cron: deployment.cron,
            },
          },
        );
        return { accountId: result.account_id, scriptName: result.script_name, origin: result.origin, databases: result.databases };
      }),
    destroy: (record) =>
      guard(async () => {
        await client.post('/apps/destroy', {
          app_id: record.appId,
          script_name: record.scriptName,
          databases: record.databases.map((d) => d.id),
        });
      }),
  };
}

let deployerOverride: ((env: Env, provider: DeployProvider) => AppDeployer) | null = null;

/** Test hook (pass `null` to restore). */
export function overrideAppDeployer(next: ((env: Env, provider: DeployProvider) => AppDeployer) | null): void {
  deployerOverride = next;
}

/** Where this installation's apps are deployed from: the control plane on the managed offering. */
export async function deployProvider(env: Env): Promise<DeployProvider> {
  return (await isManagedOffering(env)) ? 'control_plane' : 'direct';
}

async function deployerFor(env: Env, provider: DeployProvider, nowMs: number): Promise<AppDeployer> {
  if (deployerOverride !== null) return deployerOverride(env, provider);
  if (provider === 'control_plane') {
    const deployer = controlPlaneDeployer(env);
    if (deployer !== null) return deployer;
  }
  const credentials = await storedToken(env);
  if (credentials === null) throw tokenRequired();
  return directDeployer(env, credentials, nowMs);
}

// --------------------------------------------------------------- lifecycle

/**
 * Deploys (or redeploys, when the catalog bundle changed) the app into the
 * installation's Cloudflare account. A failed update keeps the running
 * version: the record stays `ready` on the previous bundle, with the error.
 */
export async function ensureAppDeployed(env: Env, manifest: AppManifest, nowMs: number): Promise<AppDeploymentRecord> {
  if (!isDeployableManifest(manifest)) throw new AppError(409, 'not_deployable', 'this app is not deployed by the CRM');
  const existing = await getDeployment(env.DB, manifest.id);
  if (isCurrent(existing, manifest)) return existing;
  const provider = existing?.status === 'ready' ? existing.provider : await deployProvider(env);
  try {
    const deployer = await deployerFor(env, provider, nowMs);
    const result = await deployer.deploy(manifest.id, manifest.deployment);
    const record: AppDeploymentRecord = {
      appId: manifest.id,
      provider: deployer.provider,
      accountId: result.accountId,
      scriptName: result.scriptName,
      origin: result.origin,
      databases: result.databases,
      bundleSha256: manifest.deployment.bundle_sha256,
      status: 'ready',
      error: null,
      createdAt: existing?.createdAt ?? nowMs,
      updatedAt: nowMs,
    };
    await saveDeployment(env.DB, record);
    return record;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'deploy failed';
    await saveDeployment(
      env.DB,
      existing?.status === 'ready'
        ? { ...existing, error: message, updatedAt: nowMs }
        : {
            appId: manifest.id,
            provider,
            accountId: existing?.accountId ?? null,
            scriptName: appWorkerName(manifest.id),
            origin: existing?.origin ?? null,
            databases: existing?.databases ?? [],
            bundleSha256: null,
            status: 'failed',
            error: message,
            createdAt: existing?.createdAt ?? nowMs,
            updatedAt: nowMs,
          },
    );
    throw error;
  }
}

/** Whether the deployed Worker answers (a fresh workers.dev script can take a few seconds). */
export async function deploymentReachable(env: Env, record: AppDeploymentRecord): Promise<boolean> {
  if (record.origin === null) return false;
  try {
    const response = await appFetch(env, `${record.origin}/.well-known/jwks.json`, {}, { timeoutMs: 5_000, maxBytes: 64 * 1024 });
    return response.status === 200;
  } catch {
    return false;
  }
}

/**
 * Deletes from the Cloudflare account the apps no workspace uses anymore (the
 * last uninstall finished, or a deploy whose install was abandoned): Worker,
 * crons and D1 databases, with the app's data. Retried at every cron tick.
 */
export async function releaseUnusedDeployments(env: Env, nowMs: number): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT d.* FROM app_deployments d
     WHERE d.updated_at <= ? AND NOT EXISTS (
       SELECT 1 FROM app_installs i WHERE i.app_id = d.app_id AND i.status IN ('pending', 'active', 'paused', 'uninstalling', 'revoked')
     )`,
  )
    .bind(nowMs - UNUSED_DEPLOYMENT_GRACE_MS)
    .all<DeploymentRow>();
  let released = 0;
  for (const record of rows.results.map(toRecord)) {
    try {
      if (record.origin !== null || record.databases.length > 0) {
        await (await deployerFor(env, record.provider, nowMs)).destroy(record);
      }
      await env.DB.prepare(`DELETE FROM app_deployments WHERE app_id = ?`).bind(record.appId).run();
      released += 1;
    } catch (error) {
      console.error(`[apps] release of ${record.appId} failed:`, error instanceof Error ? error.message : error);
    }
  }
  return released;
}
