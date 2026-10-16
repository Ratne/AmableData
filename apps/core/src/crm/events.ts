import type { Activity } from '@amable/api-types';
import type { EventActor, OutboxEvent, OutboxEventPayloads, OutboxEventType } from '@amable/core';
import type { CrmContext } from './context';
import { notFound } from './errors';
import { placeholders } from './db/sql';
import { decodeCursor, encodeCursor, parseJson, toIso } from './util';

/**
 * Emits a typed domain event: one row in the transactional outbox (consumed by
 * the automation engine) and, when the payload references a contact, company or
 * opportunity, one row in the activity timeline. Always called inside the
 * mutation's transaction, so events and data commit or roll back together.
 *
 * `timeline` adds display-only facts to the activity (e.g. tag name, note title).
 */
export function emit<K extends OutboxEventType>(
  ctx: CrmContext,
  type: K,
  payload: OutboxEventPayloads[K],
  timeline: Record<string, unknown> = {},
): string {
  const id = ctx.newId();
  const occurredAt = ctx.now();
  const actorType = ctx.actor.type;
  const actorId = ctx.actor.id;
  ctx.db.run(
    `INSERT INTO crm_outbox (id, type, payload, actor_type, actor_id, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    type,
    JSON.stringify(payload),
    actorType,
    actorId,
    occurredAt,
  );

  const refs = refsOf(payload);
  if (refs.contactId !== null || refs.companyId !== null || refs.opportunityId !== null) {
    ctx.db.run(
      `INSERT INTO crm_activities
         (id, type, contact_id, company_id, opportunity_id, actor_type, actor_id, data, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      type,
      refs.contactId,
      refs.companyId,
      refs.opportunityId,
      actorType,
      actorId,
      JSON.stringify({ ...payload, ...timeline }),
      occurredAt,
    );
  }
  return id;
}

function refsOf(payload: object): {
  contactId: string | null;
  companyId: string | null;
  opportunityId: string | null;
} {
  const pick = (key: string): string | null => {
    const value: unknown = (payload as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : null;
  };
  return {
    contactId: pick('contactId'),
    companyId: pick('companyId'),
    opportunityId: pick('opportunityId'),
  };
}

// ------------------------------------------------------------------- outbox

interface OutboxRow {
  id: string;
  type: string;
  payload: string;
  actor_type: EventActor['type'];
  actor_id: string | null;
  occurred_at: number;
}

/** Oldest undispatched events, in emission order (at-least-once delivery). */
export function pendingEvents(ctx: CrmContext, input: { limit?: number }): OutboxEvent[] {
  const rows = ctx.db.all<OutboxRow>(
    `SELECT id, type, payload, actor_type, actor_id, occurred_at
     FROM crm_outbox WHERE dispatched_at IS NULL ORDER BY id LIMIT ?`,
    Math.min(Math.max(input.limit ?? 100, 1), 1000),
  );
  for (const ids of chunks(rows.map((row) => row.id))) {
    ctx.db.run(
      `UPDATE crm_outbox SET attempts = attempts + 1 WHERE id IN (${placeholders(ids.length)})`,
      ...ids,
    );
  }
  return rows.map(
    (row) =>
      ({
        id: row.id,
        type: row.type,
        occurredAt: toIso(row.occurred_at),
        actor: { type: row.actor_type, id: row.actor_id },
        payload: parseJson<Record<string, unknown>>(row.payload, {}),
      }) as OutboxEvent,
  );
}

/** Marks events as consumed. */
export function ackEvents(ctx: CrmContext, input: { ids: string[] }): { acked: number } {
  if (input.ids.length === 0) return { acked: 0 };
  const now = ctx.now();
  for (const ids of chunks(input.ids)) {
    ctx.db.run(
      `UPDATE crm_outbox SET dispatched_at = ? WHERE dispatched_at IS NULL AND id IN (${placeholders(ids.length)})`,
      now,
      ...ids,
    );
  }
  return { acked: input.ids.length };
}

/** SQLite in Durable Objects binds at most 100 parameters per statement. */
const MAX_IN_PARAMS = 90;

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += MAX_IN_PARAMS) out.push(items.slice(i, i + MAX_IN_PARAMS));
  return out;
}

// ----------------------------------------------------------------- timeline

interface ActivityRow {
  id: string;
  type: string;
  contact_id: string | null;
  company_id: string | null;
  opportunity_id: string | null;
  actor_type: EventActor['type'];
  actor_id: string | null;
  data: string;
  occurred_at: number;
}

const TIMELINE_SUBJECTS = {
  contact: { table: 'crm_contacts', column: 'contact_id' },
  company: { table: 'crm_companies', column: 'company_id' },
  opportunity: { table: 'crm_opportunities', column: 'opportunity_id' },
} as const;

export function timeline(
  ctx: CrmContext,
  input: {
    subject: keyof typeof TIMELINE_SUBJECTS;
    id: string;
    limit: number;
    cursor?: string | undefined;
  },
): { data: Activity[]; next_cursor: string | null } {
  const subject = TIMELINE_SUBJECTS[input.subject];
  const exists = ctx.db.all(`SELECT 1 FROM ${subject.table} WHERE id = ?`, input.id);
  if (exists.length === 0) throw notFound(input.subject, input.id);
  const before = input.cursor === undefined ? null : decodeCursor(input.cursor).id;
  const rows = ctx.db.all<ActivityRow>(
    `SELECT * FROM crm_activities
     WHERE ${subject.column} = ? AND (? IS NULL OR id < ?)
     ORDER BY id DESC LIMIT ?`,
    input.id,
    before,
    before,
    input.limit + 1,
  );
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    data: page.map((row) => ({
      id: row.id,
      type: row.type,
      contact_id: row.contact_id,
      company_id: row.company_id,
      opportunity_id: row.opportunity_id,
      actor: { type: row.actor_type, id: row.actor_id },
      data: parseJson<Record<string, unknown>>(row.data, {}),
      occurred_at: toIso(row.occurred_at),
    })),
    next_cursor:
      rows.length > input.limit && last !== undefined
        ? encodeCursor({ v: null, id: last.id })
        : null,
  };
}
