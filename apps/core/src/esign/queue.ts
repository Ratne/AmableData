import { SYSTEM_ACTOR } from '../crm/context';
import type { CrmResult } from '../crm/ops';
import type { Env } from '../env';
import { sealRequest, type EsignAsyncCall, type EsignSealMessage } from './runner';

function isMessage(body: unknown): body is EsignSealMessage {
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as Record<string, unknown>)['tenantId'] === 'string' &&
    typeof (body as Record<string, unknown>)['requestId'] === 'string'
  );
}

function tenantCall(env: Env, tenantId: string): EsignAsyncCall {
  const stub = env.TENANT_DB.get(env.TENANT_DB.idFromName(tenantId));
  return async (op, input) => {
    const result = (await stub.crm(op, SYSTEM_ACTOR, input)) as CrmResult<unknown>;
    if (!result.ok) throw new Error(`${op} ${result.error.code}: ${result.error.message}`);
    return result.value as never;
  };
}

/**
 * `esign-seal` consumer: builds the signed PDF outside the tenant's Durable
 * Object, so the CRM keeps answering meanwhile. Failures are recorded on the
 * request and retried by the TenantDb alarm (lease + backoff), so messages are
 * always acknowledged; a worker killed mid-job (memory, CPU) leaves the lease
 * to expire and the alarm hands the job out again.
 */
export async function consumeEsignSeal(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    if (isMessage(message.body)) {
      await sealRequest(env, tenantCall(env, message.body.tenantId), message.body.requestId);
    }
    message.ack();
  }
}
