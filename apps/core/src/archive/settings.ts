import type { ArchiveSettings, UpdateArchiveRetentionInput } from '@amable/api-types';
import type { Env } from '../env';
import type { RetentionSettings } from './model';
import { archiveCall, archiveDeps } from './scheduler';

/**
 * Settings > Backups > Data & archiving: retention windows (TenantDb
 * `tenant_meta`), what the archive holds per stream, and the size of each
 * Durable Object database (10 GB hard limit per object on Cloudflare).
 */

export const DO_SIZE_LIMIT_BYTES = 10 * 1024 ** 3;
/** Above this a database is reported as close to the limit. */
export const DO_SIZE_WARNING_BYTES = 7 * 1024 ** 3;

type Summary = ArchiveSettings['streams'];

interface StorageRpc {
  storageInfo(): Promise<{ bytes: number }>;
}

export interface DatabaseSizes {
  databases: Array<{ name: 'tenant_db' | 'mail_db' | 'engine'; bytes: number | null }>;
  limit: number;
  warning: number;
}

async function sizeOf(stub: () => unknown): Promise<number | null> {
  try {
    return (await (stub() as StorageRpc).storageInfo()).bytes;
  } catch {
    return null;
  }
}

export async function databaseSizes(env: Env, tenantId: string): Promise<DatabaseSizes> {
  const [tenantDb, mailDb, engine] = await Promise.all([
    sizeOf(() => env.TENANT_DB.get(env.TENANT_DB.idFromName(tenantId))),
    sizeOf(() => env.MAIL_DB.get(env.MAIL_DB.idFromName(tenantId))),
    sizeOf(() => env.ENGINE.get(env.ENGINE.idFromName(tenantId))),
  ]);
  return {
    databases: [
      { name: 'tenant_db', bytes: tenantDb },
      { name: 'mail_db', bytes: mailDb },
      { name: 'engine', bytes: engine },
    ],
    limit: DO_SIZE_LIMIT_BYTES,
    warning: DO_SIZE_WARNING_BYTES,
  };
}

export async function archiveSettings(env: Env, tenantId: string): Promise<ArchiveSettings & { storage: DatabaseSizes }> {
  const deps = archiveDeps(env);
  const [retention, crm, mail, storage] = await Promise.all([
    archiveCall<RetentionSettings>(deps, tenantId, 'tenant_db', 'settings.get', {}),
    archiveCall<Summary>(deps, tenantId, 'tenant_db', 'summary', {}),
    archiveCall<Summary>(deps, tenantId, 'mail_db', 'summary', {}),
    databaseSizes(env, tenantId),
  ]);
  return { retention, streams: [...crm, ...mail], storage };
}

export function saveArchiveRetention(env: Env, tenantId: string, input: UpdateArchiveRetentionInput): Promise<RetentionSettings> {
  return archiveCall<RetentionSettings>(archiveDeps(env), tenantId, 'tenant_db', 'settings.save', input);
}
