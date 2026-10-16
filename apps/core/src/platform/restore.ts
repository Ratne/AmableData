import type { PointInTimeRestoreResponse } from '@amable/core/platform';
import { TENANT_DO_NAMES, type TenantDoName } from '../backup/format';
import type { PointInTimeStub } from '../do/point-in-time';
import type { Env } from '../env';

/** Durable Object SQLite storage keeps 30 days of point-in-time history. */
export const POINT_IN_TIME_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export function tenantObject(env: Env, tenantId: string, name: TenantDoName): PointInTimeStub {
  if (name === 'tenant_db') return env.TENANT_DB.get(env.TENANT_DB.idFromName(tenantId));
  if (name === 'mail_db') return env.MAIL_DB.get(env.MAIL_DB.idFromName(tenantId));
  return env.ENGINE.get(env.ENGINE.idFromName(tenantId));
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 300);

/**
 * Rewinds the tenant DOs of every tenant listed in D1 (already restored to `atMs` by
 * the control plane, so tenants created later are left alone). All objects are armed
 * first, then restarted: a failure to arm one never leaves the others half done.
 */
export async function restoreTenantObjects(
  env: Env,
  atMs: number,
  object: (tenantId: string, name: TenantDoName) => PointInTimeStub = (tenantId, name) => tenantObject(env, tenantId, name),
): Promise<PointInTimeRestoreResponse> {
  const tenants = (await env.DB.prepare(`SELECT id FROM tenants ORDER BY id`).all<{ id: string }>()).results;
  const failed: { tenantId: string; object: string; error: string }[] = [];
  const armed: PointInTimeStub[] = [];
  for (const { id } of tenants) {
    for (const name of TENANT_DO_NAMES) {
      const stub = object(id, name);
      try {
        await stub.pointInTimeArm(atMs);
        armed.push(stub);
      } catch (error) {
        failed.push({ tenantId: id, object: name, error: message(error) });
      }
    }
  }
  for (const stub of armed) {
    // The abort that applies the bookmark also rejects this call.
    await stub.pointInTimeApply().catch(() => undefined);
  }
  return { ok: true, tenants: tenants.length, objects: armed.length, failed };
}
