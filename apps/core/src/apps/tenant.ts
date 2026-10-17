import { SYSTEM_ACTOR, type CrmActor } from '../crm/context';
import { CrmError } from '../crm/errors';
import type { CrmResult } from '../crm/ops';
import type { Env } from '../env';

/** Runs an app tenant op (apps/core/src/apps/tenant-ops.ts) in the tenant's DO. */
export async function tenantOp<T>(
  env: Env,
  tenantId: string,
  op: string,
  input: unknown,
  actor: CrmActor = SYSTEM_ACTOR,
): Promise<T> {
  const stub = env.TENANT_DB.get(env.TENANT_DB.idFromName(tenantId));
  const result = (await stub.crm(op, actor, input)) as CrmResult<unknown>;
  if (!result.ok) throw new CrmError(result.error.code, result.error.message, result.error.details);
  return result.value as T;
}

export function appActor(appId: string): CrmActor {
  return { type: 'app', id: appId, canReadSensitive: false };
}
