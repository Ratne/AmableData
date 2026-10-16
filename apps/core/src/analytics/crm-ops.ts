import type { OutboxEvent } from '@amable/core';
import { encodeTime } from 'ulid';
import type { CrmContext } from '../crm/context';
import { parseJson, toIso } from '../crm/util';

/**
 * Read-only TenantDb operations used by the analytics sync (spread into
 * `crmOps`, so they run through the same `TenantDb.crm(op, actor, input)` RPC).
 * They never mark outbox events as dispatched: the automation engine owns
 * that flag; analytics keeps its own cursor in the tenant AnalyticsDO.
 */

/** Outbox event types analytics consumes. */
export const ANALYTICS_OUTBOX_TYPES = [
  'form.submitted',
  'appointment.booked',
  'payment.recorded',
  'refund.recorded',
  'contact.merged',
  'subscription.started',
  'subscription.trial_started',
  'subscription.trial_converted',
  'subscription.renewed',
  'subscription.upgraded',
  'subscription.downgraded',
  'subscription.cancel_scheduled',
  'subscription.reactivated',
  'subscription.paused',
  'subscription.past_due',
  'subscription.ended',
] as const;

/** Re-read window behind the cursor (events committed out of id order are claimed once). */
export const OUTBOX_LOOKBACK_MS = 5_000;

interface OutboxRow {
  id: string;
  type: string;
  payload: string;
  actor_type: OutboxEvent['actor']['type'];
  actor_id: string | null;
  occurred_at: number;
}

/** Lower id bound re-reading the last seconds before a cursor timestamp (ULIDs sort by time). */
export function lookbackBound(cursorTs: number): string {
  return encodeTime(Math.max(0, cursorTs - OUTBOX_LOOKBACK_MS), 10);
}

/**
 * Outbox events with an id greater than `after` (ULID order), restricted to the
 * analytics types. Returns the last id scanned so the caller can page even
 * past events of other types.
 */
export function outboxSince(
  ctx: CrmContext,
  input: { after: string; limit?: number },
): { events: OutboxEvent[]; scanned: number; lastId: string | null; lastTs: number | null } {
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 500);
  const lower = input.after;
  const rows = ctx.db.all<OutboxRow>(
    `SELECT id, type, payload, actor_type, actor_id, occurred_at FROM crm_outbox
     WHERE id > ? ORDER BY id LIMIT ?`,
    lower,
    limit,
  );
  const wanted = new Set<string>(ANALYTICS_OUTBOX_TYPES);
  const last = rows.at(-1);
  return {
    scanned: rows.length,
    events: rows
      .filter((r) => wanted.has(r.type))
      .map(
        (r) =>
          ({
            id: r.id,
            type: r.type,
            occurredAt: toIso(r.occurred_at),
            actor: { type: r.actor_type, id: r.actor_id },
            payload: parseJson<Record<string, unknown>>(r.payload, {}),
          }) as OutboxEvent,
      ),
    lastId: last?.id ?? null,
    lastTs: last?.occurred_at ?? null,
  };
}

/** Live contacts having one of these emails (normalized, lowercase). */
export function contactsByEmail(
  ctx: CrmContext,
  input: { emails: string[] },
): Array<{ email: string; contactId: string }> {
  const emails = [...new Set(input.emails.map((e) => e.trim().toLowerCase()))].slice(0, 500);
  if (emails.length === 0) return [];
  return ctx.db.all<{ email: string; contactId: string }>(
    `SELECT e.email_normalized AS email, MIN(c.id) AS contactId FROM crm_contact_emails e
     JOIN crm_contacts c ON c.id = e.contact_id AND c.deleted_at IS NULL
     WHERE e.email_normalized IN (SELECT value FROM json_each(?)) GROUP BY e.email_normalized`,
    JSON.stringify(emails),
  );
}

/** Names and emails of contacts (for avatars and labels). */
export function contactsBrief(
  ctx: CrmContext,
  input: { ids: string[] },
): Array<{ id: string; name: string | null; email: string | null; deleted: boolean }> {
  const ids = [...new Set(input.ids)].slice(0, 500);
  if (ids.length === 0) return [];
  return ctx.db
    .all<{
      id: string;
      given_name: string | null;
      family_name: string | null;
      primary_email: string | null;
      deleted_at: number | null;
    }>(
      `SELECT id, given_name, family_name, primary_email, deleted_at FROM crm_contacts
       WHERE id IN (SELECT value FROM json_each(?))`,
      JSON.stringify(ids),
    )
    .map((r) => {
      const name = [r.given_name, r.family_name].filter((x) => x !== null && x !== '').join(' ');
      return { id: r.id, name: name === '' ? null : name, email: r.primary_email, deleted: r.deleted_at !== null };
    });
}

export interface CrmJourneyFacts {
  exists: boolean;
  orders: Array<{
    id: string;
    number: string;
    status: string;
    total_minor: number;
    paid_minor: number;
    refunded_minor: number;
    currency: string;
    order_date: string;
    paid_at: string | null;
  }>;
  /** Email, form and booking activities of the contact timeline (newest first). */
  activities: Array<{ id: string; type: string; occurred_at: string; data: Record<string, unknown> }>;
}

/** CRM side of a contact journey: orders and marketing touchpoints from the timeline. */
export function contactJourneyFacts(
  ctx: CrmContext,
  input: { contactId: string; limit?: number },
): CrmJourneyFacts {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const exists =
    ctx.db.all(`SELECT 1 FROM crm_contacts WHERE id = ? AND deleted_at IS NULL`, input.contactId).length > 0;
  if (!exists) return { exists: false, orders: [], activities: [] };
  const orders = ctx.db
    .all<{
      id: string;
      number: string;
      status: string;
      total_minor: number;
      paid_minor: number;
      refunded_minor: number;
      currency: string;
      order_date: number;
      paid_at: number | null;
    }>(
      `SELECT id, number, status, total_minor, paid_minor, refunded_minor, currency, order_date, paid_at FROM crm_orders
       WHERE contact_id = ? AND status <> 'draft' ORDER BY order_date DESC, id DESC LIMIT ?`,
      input.contactId,
      limit,
    )
    .map((o) => ({ ...o, order_date: toIso(o.order_date), paid_at: o.paid_at === null ? null : toIso(o.paid_at) }));
  const activities = ctx.db
    .all<{ id: string; type: string; occurred_at: number; data: string }>(
      `SELECT id, type, occurred_at, data FROM crm_activities
       WHERE contact_id = ? AND (type LIKE 'email.%' OR type IN ('form.submitted', 'appointment.booked', 'booking.created'))
       ORDER BY id DESC LIMIT ?`,
      input.contactId,
      limit,
    )
    .map((a) => ({
      id: a.id,
      type: a.type,
      occurred_at: toIso(a.occurred_at),
      data: parseJson<Record<string, unknown>>(a.data, {}),
    }));
  return { exists, orders, activities };
}

/** Succeeded payments since a date with the payer (local traffic generator, demo data). */
export function recentPayments(
  ctx: CrmContext,
  input: { since: number; limit?: number },
): Array<{ contactId: string; email: string | null; ts: number; amountMinor: number }> {
  return ctx.db.all<{ contactId: string; email: string | null; ts: number; amountMinor: number }>(
    `SELECT o.contact_id AS contactId, c.primary_email AS email, p.created_at AS ts, p.amount_minor AS amountMinor
     FROM crm_payments p JOIN crm_orders o ON o.id = p.order_id JOIN crm_contacts c ON c.id = o.contact_id
     WHERE p.status = 'succeeded' AND p.created_at >= ? ORDER BY p.created_at LIMIT ?`,
    input.since,
    Math.min(Math.max(input.limit ?? 200, 1), 1000),
  );
}

export const analyticsCrmOps = {
  'analytics.recentPayments': recentPayments,
  'analytics.outboxSince': outboxSince,
  'analytics.contactsByEmail': contactsByEmail,
  'analytics.contactsBrief': contactsBrief,
  'analytics.contactJourneyFacts': contactJourneyFacts,
} satisfies Record<string, (ctx: CrmContext, input: never) => unknown>;
