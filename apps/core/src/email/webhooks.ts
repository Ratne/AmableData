import { verifyWebhook, type ReplayGuard } from '@amable/auth';
import type { EmailSendSource } from '@amable/core';
import { MailError, normalizeEmail, parseJson, type MailDeps } from './context';
import { emitEmailEvent } from './outbox';
import { evaluateHealth, suspension } from './settings';
import { suppress, type MessageRow } from './suppressions';

/**
 * PostShiba delivery webhooks (SendGrid Event Webhook format, one event per
 * POST): processed / delivered / deferred / bounce (`type` bounce = hard,
 * blocked = refused) / dropped / spamreport / unsubscribe (one-click
 * List-Unsubscribe handled by the provider). Signed with HMAC-SHA256 over
 * `${timestamp}.${rawBody}` (headers `X-Capsule-Timestamp` +
 * `X-Capsule-Signature: sha256=<hex>`, normalized by the route), checked in
 * constant time with a timestamp tolerance and replay protection; provider
 * event ids (`sg_event_id`) are remembered so retried deliveries apply once.
 */

/** Unique arg carrying our mail message id; echoed on every delivery event. */
export const MESSAGE_ID_ARG = 'amb_message_id';

export type ProviderEventType =
  | 'processed'
  | 'delivered'
  | 'deferred'
  | 'bounced'
  | 'dropped'
  | 'complained'
  | 'unsubscribed';

export interface ProviderEvent {
  readonly id: string;
  readonly type: ProviderEventType;
  readonly providerMessageId: string | null;
  readonly messageId: string | null;
  readonly recipient: string | null;
  /** hard = bad address (suppress); soft = refused/blocked or temporary (no suppression). */
  readonly bounceType: 'hard' | 'soft';
  /** Provider failure category, e.g. "Invalid Address", "Reputation". */
  readonly classification: string | null;
  readonly reason: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v.slice(0, 500) : null);

const TYPES: Record<string, ProviderEventType> = {
  processed: 'processed',
  delivered: 'delivered',
  deferred: 'deferred',
  bounce: 'bounced',
  bounced: 'bounced',
  dropped: 'dropped',
  spamreport: 'complained',
  spam_report: 'complained',
  complained: 'complained',
  complaint: 'complained',
  unsubscribe: 'unsubscribed',
  unsubscribed: 'unsubscribed',
};

function bounceTypeOf(item: Record<string, unknown>): 'hard' | 'soft' {
  // PostShiba: `type` is "bounce" (bad address) or "blocked" (message refused).
  const kind = (str(item['type']) ?? '').toLowerCase();
  if (kind === 'blocked') return 'soft';
  if (kind === 'bounce') return 'hard';
  const legacy = (str(item['bounce_type']) ?? '').toLowerCase();
  if (legacy === 'soft' || legacy === 'transient') return 'soft';
  if (legacy === 'hard') return 'hard';
  const status = str(item['status']) ?? '';
  return status.startsWith('4.') ? 'soft' : 'hard';
}

export function parseProviderEvents(rawBody: string): ProviderEvent[] {
  const body = parseJson<unknown>(rawBody, null);
  const list: unknown[] = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body['events'])
      ? body['events']
      : [body];
  const events: ProviderEvent[] = [];
  for (const item of list.slice(0, 1000)) {
    if (!isRecord(item) || item['test'] === true) continue;
    const rawType = (str(item['event']) ?? str(item['type']) ?? '').toLowerCase();
    const type = TYPES[rawType];
    const id = str(item['sg_event_id']) ?? str(item['id']) ?? str(item['event_id']);
    if (type === undefined || id === null) continue;
    const args = isRecord(item['unique_args']) ? item['unique_args'] : {};
    const metadata = isRecord(item['metadata']) ? item['metadata'] : {};
    const status = str(item['status']);
    const reason = str(item['reason']) ?? str(item['response']) ?? str(item['description']);
    events.push({
      id,
      type,
      providerMessageId: str(item['sg_message_id']) ?? str(item['message_id']),
      messageId: str(args[MESSAGE_ID_ARG]) ?? str(item[MESSAGE_ID_ARG]) ?? str(metadata['message_id']),
      recipient: str(item['email']) ?? str(item['recipient']),
      bounceType: type === 'bounced' ? bounceTypeOf(item) : 'hard',
      classification: str(item['bounce_classification']),
      reason: status !== null && reason !== null && !reason.includes(status) ? `${status} ${reason}`.slice(0, 500) : reason,
    });
  }
  return events;
}

/** Dropped because the address is on the provider suppression list (never retry it). */
function droppedForSuppression(event: ProviderEvent): boolean {
  return /suppress/i.test(event.reason ?? '') || /invalid address/i.test(event.classification ?? '');
}

function replayGuard(deps: MailDeps): ReplayGuard {
  return {
    markSeen(id: string, ttlSeconds: number): Promise<boolean> {
      const key = `sig:${id}`;
      if (deps.db.all(`SELECT 1 AS x FROM mail_webhook_seen WHERE id = ?`, key).length > 0) {
        return Promise.resolve(false);
      }
      deps.db.run(
        `INSERT INTO mail_webhook_seen (id, expires_at) VALUES (?, ?)`,
        key,
        deps.now() + ttlSeconds * 1000,
      );
      return Promise.resolve(true);
    },
  };
}

export async function handleProviderWebhook(
  deps: MailDeps,
  input: { rawBody: string; signature: string | null; secrets: readonly string[] },
): Promise<{ processed: number; ignored: number; suspended: string | null }> {
  if (input.secrets.length === 0) {
    throw new MailError('webhook_not_configured', 503, 'webhook secret is not configured');
  }
  const verdict = await verifyWebhook({
    secrets: input.secrets,
    header: input.signature,
    rawBody: input.rawBody,
    nowMs: deps.now(),
    replayGuard: replayGuard(deps),
  });
  if (!verdict.ok) throw new MailError('invalid_signature', 401, verdict.reason);
  let processed = 0;
  let ignored = 0;
  for (const event of parseProviderEvents(input.rawBody)) {
    const result = applyProviderEvent(deps, event);
    if (!result.applied) {
      ignored += 1;
      continue;
    }
    processed += 1;
    if (result.contactStatus !== null) {
      try {
        await deps.crm.setMarketableStatus(result.contactStatus.contactId, result.contactStatus.status);
      } catch (error) {
        console.warn(
          `[email] marketable status update failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  const suspendedFor = processed > 0 ? evaluateHealth(deps) : null;
  if (suspendedFor !== null) {
    const { providerTenantId } = await deps.sending();
    if (providerTenantId !== null) {
      await deps.provider
        .suspendTenant(providerTenantId, suspendedFor)
        .catch((error: unknown) =>
          console.warn(`[email] provider suspend failed: ${error instanceof Error ? error.message : String(error)}`),
        );
    }
  }
  return { processed, ignored, suspended: suspendedFor };
}

function findMessage(deps: MailDeps, event: ProviderEvent): MessageRow | undefined {
  if (event.messageId !== null) {
    const row = deps.db.all<MessageRow>(`SELECT * FROM mail_messages WHERE id = ?`, event.messageId)[0];
    if (row !== undefined) return row;
  }
  if (event.providerMessageId === null) return undefined;
  return deps.db.all<MessageRow>(
    `SELECT * FROM mail_messages WHERE provider_message_id = ?`,
    event.providerMessageId,
  )[0];
}

export interface AppliedEvent {
  readonly applied: boolean;
  /** Contact marketable status to set in the CRM (hard bounce, complaint, provider unsubscribe). */
  readonly contactStatus: { contactId: string; status: 'bounced' | 'complained' | 'unsubscribed' } | null;
}

/** Applies one event (deduplicated by provider event id). */
export function applyProviderEvent(deps: MailDeps, event: ProviderEvent): AppliedEvent {
  const key = `evt:${event.id}`;
  if (deps.db.all(`SELECT 1 AS x FROM mail_webhook_seen WHERE id = ?`, key).length > 0) {
    return { applied: false, contactStatus: null };
  }
  const row = findMessage(deps, event);
  const now = deps.now();
  let newlyUnsubscribed = false;
  deps.db.transaction(() => {
    deps.db.run(
      `INSERT INTO mail_webhook_seen (id, expires_at) VALUES (?, ?)`,
      key,
      now + 30 * 86_400_000,
    );
    if (row === undefined) return;
    const source = parseJson<EmailSendSource | null>(row.source, null);
    const refs = { messageId: row.id, contactId: row.contact_id, source };
    const email = row.email ?? (event.recipient === null ? null : normalizeEmail(event.recipient));
    const detail =
      event.classification === null ? event.reason : `${event.classification}: ${event.reason ?? ''}`.trim();
    switch (event.type) {
      case 'processed':
        break;
      case 'delivered':
        deps.db.run(
          `UPDATE mail_messages SET status = CASE WHEN status IN ('sent', 'deferred') THEN 'delivered' ELSE status END,
                  delivered_at = COALESCE(delivered_at, ?), updated_at = ? WHERE id = ?`,
          now,
          now,
          row.id,
        );
        emitEmailEvent(deps, 'email.delivered', refs);
        break;
      case 'deferred':
        deps.db.run(
          `UPDATE mail_messages SET status = CASE WHEN status = 'sent' THEN 'deferred' ELSE status END,
                  status_reason = ?, updated_at = ? WHERE id = ?`,
          detail,
          now,
          row.id,
        );
        break;
      case 'bounced':
        if (event.bounceType === 'soft') {
          // Refused / blocked (reputation, content, volume...): not delivered, address kept.
          deps.db.run(
            `UPDATE mail_messages SET status = CASE WHEN status IN ('sent', 'deferred') THEN 'dropped' ELSE status END,
                    status_reason = ?, updated_at = ? WHERE id = ?`,
            detail,
            now,
            row.id,
          );
          emitEmailEvent(deps, 'email.bounced', { ...refs, bounceType: 'soft', reason: detail });
          break;
        }
        deps.db.run(
          `UPDATE mail_messages SET status = 'bounced', status_reason = ?, bounced_at = COALESCE(bounced_at, ?),
                  updated_at = ? WHERE id = ?`,
          detail,
          now,
          now,
          row.id,
        );
        if (email !== null) suppress(deps, { email, reason: 'bounce', source: 'webhook', contactId: row.contact_id });
        emitEmailEvent(deps, 'email.bounced', { ...refs, bounceType: 'hard', reason: detail });
        break;
      case 'dropped':
        deps.db.run(
          `UPDATE mail_messages SET status = 'dropped', status_reason = ?, updated_at = ? WHERE id = ?`,
          detail,
          now,
          row.id,
        );
        if (email !== null && droppedForSuppression(event)) {
          suppress(deps, { email, reason: 'manual', source: 'provider', contactId: row.contact_id });
        }
        break;
      case 'unsubscribed': {
        if (email === null) break;
        newlyUnsubscribed =
          deps.db.all(`SELECT 1 AS x FROM mail_suppressions WHERE email = ? AND reason <> 'manual'`, email)
            .length === 0;
        deps.db.run(`DELETE FROM mail_suppressions WHERE email = ? AND reason = 'manual'`, email);
        suppress(deps, { email, reason: 'unsubscribe', source: 'provider', contactId: row.contact_id });
        deps.db.run(
          `UPDATE mail_messages SET unsubscribed_at = COALESCE(unsubscribed_at, ?), updated_at = ? WHERE id = ?`,
          now,
          now,
          row.id,
        );
        if (newlyUnsubscribed) {
          emitEmailEvent(deps, 'email.unsubscribed', { ...refs, email, via: 'provider' });
        }
        break;
      }
      case 'complained':
        deps.db.run(
          `UPDATE mail_messages SET status = 'complained', complained_at = COALESCE(complained_at, ?),
                  updated_at = ? WHERE id = ?`,
          now,
          now,
          row.id,
        );
        if (email !== null) suppress(deps, { email, reason: 'complaint', source: 'webhook', contactId: row.contact_id });
        emitEmailEvent(deps, 'email.complained', refs);
        break;
    }
  });
  if (row === undefined) return { applied: false, contactStatus: null };
  if (event.type === 'unsubscribed') {
    return {
      applied: true,
      contactStatus: newlyUnsubscribed ? { contactId: row.contact_id, status: 'unsubscribed' } : null,
    };
  }
  if (event.type === 'complained' || (event.type === 'bounced' && event.bounceType === 'hard')) {
    return {
      applied: true,
      contactStatus: {
        contactId: row.contact_id,
        status: event.type === 'complained' ? 'complained' : 'bounced',
      },
    };
  }
  return { applied: true, contactStatus: null };
}

export function isSuspended(deps: MailDeps): boolean {
  return suspension(deps).suspended;
}
