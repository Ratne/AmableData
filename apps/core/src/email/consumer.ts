import { TRANSACTIONAL_EMAIL_PURPOSES, type EmailSendRequest } from '@amable/core';
import type { Env } from '../env';
import type { MailResult } from './ops';
import type { SendOutcome } from './pipeline';

/**
 * `email-send` queue consumer: validates messages, groups them by tenant and
 * hands each group to the tenant MailDb in one RPC (batching); each message is
 * then acked or retried with the delay chosen by the pipeline (backoff,
 * warm-up cap, rate limit, paused broadcast). Malformed messages are dropped.
 */

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;
const isNullableStr = (v: unknown): v is string | null => v === null || typeof v === 'string';

function validSource(v: unknown): boolean {
  if (!isRecord(v)) return false;
  switch (v['type']) {
    case 'broadcast':
      return isStr(v['broadcastId']);
    case 'single':
      return isStr(v['userId']);
    case 'transactional':
      return (
        TRANSACTIONAL_EMAIL_PURPOSES.some((p) => p === v['purpose']) &&
        isStr(v['referenceId']) &&
        (v['userId'] === null || isStr(v['userId']))
      );
    case 'automation':
      return ['automationId', 'versionId', 'nodeId', 'stepId', 'enrollmentId'].every((k) => isStr(v[k]));
    default:
      return false;
  }
}

export function parseEmailSendRequest(body: unknown): EmailSendRequest | null {
  if (!isRecord(body) || body['kind'] !== 'email.send' || body['version'] !== 1) return null;
  const content = body['content'];
  if (
    !isStr(body['id']) ||
    !isStr(body['tenantId']) ||
    !isStr(body['contactId']) ||
    !isStr(body['requestedAt']) ||
    !isNullableStr(body['notAfter']) ||
    !validSource(body['source']) ||
    !isRecord(content) ||
    !isNullableStr(content['templateId']) ||
    !isNullableStr(content['subject']) ||
    !isNullableStr(content['preheader']) ||
    !isNullableStr(content['fromName']) ||
    !isNullableStr(content['replyTo']) ||
    !(content['body'] === null || isRecord(content['body']))
  ) {
    return null;
  }
  return body as unknown as EmailSendRequest;
}

export interface QueueMessageLike {
  readonly body: unknown;
  readonly attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export type TenantBatchProcessor = (
  tenantId: string,
  batch: { request: EmailSendRequest; queueAttempts: number }[],
) => Promise<SendOutcome[]>;

/** Queue limit for message delays. */
const MAX_DELAY_SECONDS = 43_200;

export async function consumeEmailMessages(
  messages: readonly QueueMessageLike[],
  process: TenantBatchProcessor,
): Promise<{ acked: number; retried: number; dropped: number }> {
  const stats = { acked: 0, retried: 0, dropped: 0 };
  const byTenant = new Map<string, { message: QueueMessageLike; request: EmailSendRequest }[]>();
  for (const message of messages) {
    const request = parseEmailSendRequest(message.body);
    if (request === null) {
      console.warn('[email] dropping malformed email-send message');
      message.ack();
      stats.dropped += 1;
      continue;
    }
    const group = byTenant.get(request.tenantId) ?? [];
    group.push({ message, request });
    byTenant.set(request.tenantId, group);
  }
  for (const [tenantId, group] of byTenant) {
    let outcomes: SendOutcome[];
    try {
      outcomes = await process(
        tenantId,
        group.map((g) => ({ request: g.request, queueAttempts: g.message.attempts })),
      );
    } catch (error) {
      console.error(`[email] batch for tenant failed: ${error instanceof Error ? error.message : String(error)}`);
      for (const g of group) {
        g.message.retry({ delaySeconds: 60 });
        stats.retried += 1;
      }
      continue;
    }
    const byId = new Map(outcomes.map((o) => [o.id, o] as const));
    for (const g of group) {
      const outcome = byId.get(g.request.id);
      if (outcome === undefined || outcome.action === 'retry') {
        const delay = outcome?.action === 'retry' ? outcome.delaySeconds : 60;
        g.message.retry({ delaySeconds: Math.min(Math.max(Math.ceil(delay), 1), MAX_DELAY_SECONDS) });
        stats.retried += 1;
      } else {
        g.message.ack();
        stats.acked += 1;
      }
    }
  }
  return stats;
}

/** Worker queue handler for `email-send`. */
export async function handleEmailSendBatch(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  await consumeEmailMessages(batch.messages, async (tenantId, items) => {
    const stub = env.MAIL_DB.get(env.MAIL_DB.idFromName(tenantId));
    const result = (await stub.mail(tenantId, 'send.process', { batch: items })) as MailResult<SendOutcome[]>;
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
  });
}
