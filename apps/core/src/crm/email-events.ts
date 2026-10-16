import { EMAIL_EVENT_TYPES, type EmailEventType } from '@amable/core';
import type { CrmContext } from './context';
import { placeholders } from './db/sql';
import { CrmError } from './errors';

/**
 * Bridge of the email module (MailDb outbox) into the CRM event bus: each
 * email event becomes one `crm_outbox` row (drained by the automation engine,
 * which also fans out the outgoing webhooks) and, when the contact still
 * exists, one row in the contact timeline. The MailDb event id is reused, so
 * a redelivered batch is ignored (at-least-once on the MailDb side).
 */

export interface BridgedEmailEvent {
  /** MailDb outbox id (ULID), reused as the CRM outbox / activity id. */
  readonly id: string;
  readonly type: EmailEventType;
  /** Epoch ms. */
  readonly occurredAt: number;
  readonly contactId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Display-only timeline facts (e.g. the subject). */
  readonly timeline?: Readonly<Record<string, unknown>>;
}

export const EMAIL_BRIDGE_MAX_EVENTS = 200;
/** Durable Object SQLite binds at most 100 parameters per statement. */
const IN_CHUNK = 90;
const EMAIL_TYPES = new Set<string>(EMAIL_EVENT_TYPES);

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += IN_CHUNK) out.push(items.slice(i, i + IN_CHUNK));
  return out;
}

export function recordEmailEvents(
  ctx: CrmContext,
  input: { events: BridgedEmailEvent[] },
): { recorded: number; duplicates: number } {
  const events = input.events;
  if (events.length > EMAIL_BRIDGE_MAX_EVENTS) {
    throw new CrmError('bad_request', `at most ${String(EMAIL_BRIDGE_MAX_EVENTS)} events per call`);
  }
  for (const event of events) {
    if (!EMAIL_TYPES.has(event.type)) throw new CrmError('bad_request', `not an email event: ${event.type}`);
  }

  const existing = new Set<string>();
  for (const ids of chunks([...new Set(events.map((e) => e.id))])) {
    for (const row of ctx.db.all<{ id: string }>(
      `SELECT id FROM crm_outbox WHERE id IN (${placeholders(ids.length)})`,
      ...ids,
    )) {
      existing.add(row.id);
    }
  }

  const live = new Set<string>();
  for (const ids of chunks([...new Set(events.map((e) => e.contactId))])) {
    for (const row of ctx.db.all<{ id: string }>(
      `SELECT id FROM crm_contacts WHERE deleted_at IS NULL AND id IN (${placeholders(ids.length)})`,
      ...ids,
    )) {
      live.add(row.id);
    }
  }

  let recorded = 0;
  for (const event of events) {
    if (existing.has(event.id)) continue;
    existing.add(event.id);
    const payload = JSON.stringify({ ...event.payload, contactId: event.contactId });
    ctx.db.run(
      `INSERT INTO crm_outbox (id, type, payload, actor_type, actor_id, occurred_at)
       VALUES (?, ?, ?, 'system', NULL, ?)`,
      event.id,
      event.type,
      payload,
      event.occurredAt,
    );
    if (live.has(event.contactId)) {
      ctx.db.run(
        `INSERT OR IGNORE INTO crm_activities
           (id, type, contact_id, company_id, opportunity_id, actor_type, actor_id, data, occurred_at)
         VALUES (?, ?, ?, NULL, NULL, 'system', NULL, ?, ?)`,
        event.id,
        event.type,
        event.contactId,
        JSON.stringify({ ...event.payload, contactId: event.contactId, ...(event.timeline ?? {}) }),
        event.occurredAt,
      );
    }
    recorded += 1;
  }
  return { recorded, duplicates: events.length - recorded };
}
