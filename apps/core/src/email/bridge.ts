import type { EmailOutboxEvent } from '@amable/core';
import type { BridgedEmailEvent } from '../crm/email-events';
import { chunked, type MailDeps } from './context';
import { ackEmailEvents, pendingEmailEvents } from './outbox';

/**
 * Drains the MailDb outbox into the CRM event bus (TenantDb `mail.recordEvents`):
 * from there the automation engine matches goals and fans out the outgoing
 * webhooks, and the contact timeline shows the email activity. Batched,
 * at-least-once (the TenantDb dedupes by event id), acked after the write.
 *
 * Not forwarded (acked only): test sends (no source) and repeated opens.
 */

const BATCH = 200;
const MAX_ROUNDS = 20;
/** Delay that groups the events of a burst (clicks, webhook batches) into one bridge run. */
export const BRIDGE_DELAY_MS = 1_000;
export const BRIDGE_RETRY_MS = 30_000;

function forwarded(event: EmailOutboxEvent): boolean {
  if (event.payload.source === null || event.payload.contactId === '') return false;
  if (event.type === 'email.opened' && !event.payload.unique) return false;
  return true;
}

function subjects(deps: MailDeps, messageIds: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const ids of chunked([...new Set(messageIds)].filter((id) => id !== ''))) {
    for (const row of deps.db.all<{ id: string; subject: string | null }>(
      `SELECT id, subject FROM mail_messages WHERE id IN (${ids.map(() => '?').join(', ')})`,
      ...ids,
    )) {
      if (row.subject !== null && row.subject !== '') out.set(row.id, row.subject);
    }
  }
  return out;
}

function toBridged(event: EmailOutboxEvent, subject: string | undefined): BridgedEmailEvent {
  return {
    id: event.id,
    type: event.type,
    occurredAt: Date.parse(event.occurredAt),
    contactId: event.payload.contactId,
    // `emailId` keeps the payload shape automations and webhooks already see.
    payload: { ...event.payload, emailId: event.payload.messageId },
    ...(subject === undefined ? {} : { timeline: { subject } }),
  };
}

export function hasPendingEmailEvents(deps: MailDeps): boolean {
  return deps.db.all(`SELECT 1 AS x FROM mail_outbox WHERE acked_at IS NULL LIMIT 1`).length > 0;
}

/** One full drain; returns how many events reached the CRM bus. Throws on a TenantDb failure (nothing acked). */
export async function bridgeEmailEvents(deps: MailDeps): Promise<{ bridged: number; skipped: number }> {
  let bridged = 0;
  let skipped = 0;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const events = pendingEmailEvents(deps, { limit: BATCH });
    if (events.length === 0) break;
    const wanted = events.filter(forwarded);
    skipped += events.length - wanted.length;
    if (wanted.length > 0) {
      const subjectOf = subjects(
        deps,
        wanted.map((e) => e.payload.messageId),
      );
      const result = await deps.crm.recordEvents(
        wanted.map((e) => toBridged(e, subjectOf.get(e.payload.messageId))),
      );
      bridged += result.recorded;
    }
    ackEmailEvents(deps, { ids: events.map((e) => e.id) });
    if (events.length < BATCH) break;
  }
  if (bridged > 0 && deps.automation !== null) {
    try {
      await deps.automation.kick();
    } catch (error) {
      // The engine also drains on its own poll; the events are already in the CRM outbox.
      console.warn(`[email] engine kick failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { bridged, skipped };
}
