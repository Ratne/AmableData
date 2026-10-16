import type { RealtimeEvent } from '@amable/api-types';
import { first, type SqlDb } from '../db/sql';
import { afterGoal, markDirty, newBatchState, refundPayment, type BatchState } from './ingest';

/**
 * Facts the core pushes into a site from the CRM (TenantDb outbox events,
 * identity resolution): visitor ↔ contact links, payments and refunds of CRM
 * orders, lifecycle goals of subscriptions and contact merges. Each fact has a
 * stable `id` (outbox event id + suffix): applying a fact twice is a no-op.
 */
export type CrmLinkSource = 'form' | 'booking' | 'email' | 'identify' | 'order' | 'api';

export type CrmFact =
  | {
      kind: 'link';
      id: string;
      contactId: string;
      visitorId: string;
      source: CrmLinkSource;
      ts: number;
    }
  | {
      kind: 'payment';
      id: string;
      transactionId: string;
      contactId: string | null;
      visitorId: string | null;
      orderId: string | null;
      amountMinor: number;
      currency: string;
      renewal: boolean;
      ts: number;
    }
  | {
      kind: 'refund';
      id: string;
      /** Refunded payment; null = spread over the order's payments, newest first. */
      transactionId: string | null;
      orderId: string | null;
      amountMinor: number;
      ts: number;
    }
  | {
      kind: 'goal';
      id: string;
      name: string;
      contactId: string | null;
      visitorId: string;
      params: Record<string, string | number | boolean> | null;
      ts: number;
    }
  | { kind: 'merge'; id: string; fromContactIds: string[]; toContactId: string; ts: number };

export interface CrmApplyResult {
  applied: number;
  duplicates: number;
  skipped: number;
  /** Visitors newly linked (site id implied) — the core mirrors them in the tenant registry. */
  linked: Array<{ visitorId: string; contactId: string; source: CrmLinkSource; ts: number }>;
  pending: boolean;
  live: RealtimeEvent[];
}

/** Payments of CRM orders: `crm_<payment id>`. */
export function crmTransactionId(paymentId: string): string {
  return `crm_${paymentId}`;
}

function visitorExists(db: SqlDb, id: string): boolean {
  return first<{ id: string }>(db, `SELECT id FROM visitors WHERE id = ?`, id) !== undefined;
}

/** Most recently seen visitor of a contact in this site. */
export function latestVisitorOf(db: SqlDb, contactId: string): string | null {
  return (
    first<{ id: string }>(
      db,
      `SELECT id FROM visitors WHERE contact_id = ? ORDER BY last_seen DESC, id LIMIT 1`,
      contactId,
    )?.id ?? null
  );
}

/** Session a server-side fact belongs to: the visitor's last session started before it (≤ 24 h). */
function sessionAround(db: SqlDb, visitorId: string, ts: number): string | null {
  return (
    first<{ id: string }>(
      db,
      `SELECT id FROM sessions WHERE visitor_id = ? AND started_at <= ? AND last_seen >= ?
       ORDER BY started_at DESC LIMIT 1`,
      visitorId,
      ts,
      ts - 24 * 3_600_000,
    )?.id ?? null
  );
}

/** Links a visitor to a contact (the most recent identification wins) and adopts its orphan payments. */
export function linkVisitor(
  db: SqlDb,
  visitorId: string,
  contactId: string,
  source: CrmLinkSource,
  ts: number,
): boolean {
  const row = first<{ contact_id: string | null }>(db, `SELECT contact_id FROM visitors WHERE id = ?`, visitorId);
  if (row === undefined) return false;
  if (row.contact_id === contactId) return false;
  db.run(
    `UPDATE visitors SET contact_id = ?, linked_at = ?, link_source = ? WHERE id = ?`,
    contactId,
    ts,
    source,
    visitorId,
  );
  db.run(`UPDATE payments SET visitor_id = ? WHERE contact_id = ? AND visitor_id IS NULL`, visitorId, contactId);
  return true;
}

function applyPayment(
  db: SqlDb,
  f: Extract<CrmFact, { kind: 'payment' }>,
  currency: string,
  out: BatchState,
): boolean {
  let visitor = f.visitorId !== null && visitorExists(db, f.visitorId) ? f.visitorId : null;
  if (visitor === null && f.contactId !== null) visitor = latestVisitorOf(db, f.contactId);
  if (visitor !== null && f.contactId !== null && f.visitorId === visitor) {
    // The order carried the visitor id: that is an identification too.
    linkVisitor(db, visitor, f.contactId, 'order', f.ts);
  }
  const session = visitor === null ? null : sessionAround(db, visitor, f.ts);
  const inserted = db.all<{ id: number }>(
    `INSERT INTO payments (transaction_id, visitor_id, session_id, ts, amount_minor, currency, email, customer_id,
       renewal, refunded, free_trial, refunded_minor, source, order_id, contact_id)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, 0, 0, 'crm', ?, ?)
     ON CONFLICT (transaction_id) DO NOTHING RETURNING id`,
    f.transactionId,
    visitor,
    session,
    f.ts,
    f.amountMinor,
    f.currency,
    f.contactId,
    f.renewal ? 1 : 0,
    f.orderId,
    f.contactId,
  );
  if (inserted.length === 0) return false;
  markDirty(db, f.ts);
  if (visitor !== null) {
    db.run(
      `INSERT INTO goals (session_id, visitor_id, ts, name, path, params) VALUES (?, ?, ?, 'payment', NULL, ?)`,
      session,
      visitor,
      f.ts,
      JSON.stringify({ transaction_id: f.transactionId, order_id: f.orderId ?? '' }),
    );
    // CRM payments already reach automations through the outbox: alerts only.
    afterGoal(db, out, { vid: visitor, ts: f.ts, name: 'payment', path: null, hostname: null, data: null }, null, null, false);
  }
  if (session !== null) {
    db.run(
      `UPDATE sessions SET goals = goals + 1, bounce = 0, revenue_minor = revenue_minor + ? WHERE id = ?`,
      f.currency === currency ? f.amountMinor : 0,
      session,
    );
  }
  return true;
}

function applyRefund(db: SqlDb, f: Extract<CrmFact, { kind: 'refund' }>, currency: string): boolean {
  const inserted = db.all<{ refund_key: string }>(
    `INSERT INTO payment_refunds (refund_key, transaction_id, order_id, amount_minor, ts) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (refund_key) DO NOTHING RETURNING refund_key`,
    f.id,
    f.transactionId,
    f.orderId,
    f.amountMinor,
    f.ts,
  );
  if (inserted.length === 0) return false;
  if (f.transactionId !== null) {
    const known = first<{ id: number }>(db, `SELECT id FROM payments WHERE transaction_id = ?`, f.transactionId);
    if (known !== undefined) {
      refundPayment(db, f.transactionId, f.amountMinor, currency);
      return true;
    }
  }
  if (f.orderId === null) return false;
  let left = f.amountMinor;
  for (const p of db.all<{ transaction_id: string }>(
    `SELECT transaction_id FROM payments WHERE order_id = ? AND refunded = 0 ORDER BY ts DESC, id DESC`,
    f.orderId,
  )) {
    if (left <= 0) break;
    left -= refundPayment(db, p.transaction_id, left, currency);
  }
  return left < f.amountMinor;
}

function applyGoal(db: SqlDb, f: Extract<CrmFact, { kind: 'goal' }>, out: BatchState): boolean {
  if (!visitorExists(db, f.visitorId)) return false;
  const session = sessionAround(db, f.visitorId, f.ts);
  db.run(
    `INSERT INTO goals (session_id, visitor_id, ts, name, path, params) VALUES (?, ?, ?, ?, NULL, ?)`,
    session,
    f.visitorId,
    f.ts,
    f.name,
    f.params === null ? null : JSON.stringify(f.params),
  );
  if (session !== null) db.run(`UPDATE sessions SET goals = goals + 1, bounce = 0 WHERE id = ?`, session);
  markDirty(db, f.ts);
  // Lifecycle goals come from outbox events the engine already receives: alerts only.
  afterGoal(db, out, { vid: f.visitorId, ts: f.ts, name: f.name, path: null, hostname: null, data: f.params }, null, null, false);
  return true;
}

export function applyCrmFacts(db: SqlDb, facts: readonly CrmFact[], currency: string): CrmApplyResult {
  return db.transaction(() => {
    const out = newBatchState();
    const result: CrmApplyResult = { applied: 0, duplicates: 0, skipped: 0, linked: [], pending: false, live: out.live };
    for (const f of [...facts].sort((a, b) => a.ts - b.ts)) {
      const fresh = db.all<{ eid: string }>(
        `INSERT INTO ingested_events (eid, ts) VALUES (?, ?) ON CONFLICT (eid) DO NOTHING RETURNING eid`,
        `crm:${f.id}`,
        f.ts,
      );
      if (fresh.length === 0) {
        result.duplicates += 1;
        continue;
      }
      let ok = false;
      switch (f.kind) {
        case 'link':
          ok = linkVisitor(db, f.visitorId, f.contactId, f.source, f.ts);
          if (ok) result.linked.push({ visitorId: f.visitorId, contactId: f.contactId, source: f.source, ts: f.ts });
          break;
        case 'payment':
          ok = applyPayment(db, f, currency, out);
          break;
        case 'refund':
          ok = applyRefund(db, f, currency);
          break;
        case 'goal':
          ok = applyGoal(db, f, out);
          break;
        case 'merge':
          for (const from of f.fromContactIds) {
            db.run(`UPDATE visitors SET contact_id = ? WHERE contact_id = ?`, f.toContactId, from);
            db.run(`UPDATE payments SET contact_id = ? WHERE contact_id = ?`, f.toContactId, from);
          }
          ok = true;
          break;
      }
      if (ok) result.applied += 1;
      else result.skipped += 1;
    }
    result.pending = out.pending;
    return result;
  });
}

/** Which of these visitor ids exist in the site. */
export function knownVisitors(db: SqlDb, ids: readonly string[]): string[] {
  if (ids.length === 0) return [];
  return db
    .all<{ id: string }>(`SELECT id FROM visitors WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids))
    .map((r) => r.id);
}

// ---------------------------------------------------------------- core queues

export interface IdentityItem {
  id: number;
  visitorId: string;
  kind: 'email' | 'contact_token';
  value: string;
  ts: number;
}

export interface AutomationItem {
  id: number;
  kind: 'goal' | 'pageview';
  visitorId: string;
  contactId: string;
  sessionId: string | null;
  name: string | null;
  hostname: string | null;
  path: string | null;
  params: Record<string, string | number | boolean> | null;
  ts: number;
}

export interface AlertItem {
  id: number;
  alertId: string;
  goal: string;
  visitorId: string | null;
  test: boolean;
  ts: number;
}

export interface AlertTarget {
  id: string;
  name: string;
  goal: string;
  enabled: boolean;
  emailRecipients: string[];
  webhookUrl: string | null;
  webhookSecret: string | null;
  lastTriggeredAt: number | null;
}

export interface CoreWork {
  identities: IdentityItem[];
  automation: AutomationItem[];
  alerts: AlertItem[];
  alertTargets: AlertTarget[];
}

function parseRecord(raw: string | null): Record<string, string | number | boolean> | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, string | number | boolean>)
      : null;
  } catch {
    return null;
  }
}

export function pullCoreWork(db: SqlDb, limit: number): CoreWork {
  const identities = db
    .all<{ id: number; visitor_id: string; kind: string; value: string; ts: number }>(
      `SELECT id, visitor_id, kind, value, ts FROM identity_queue ORDER BY id LIMIT ?`,
      limit,
    )
    .map((r) => ({
      id: r.id,
      visitorId: r.visitor_id,
      kind: r.kind === 'email' ? ('email' as const) : ('contact_token' as const),
      value: r.value,
      ts: r.ts,
    }));
  const automation = db
    .all<{
      id: number;
      kind: string;
      visitor_id: string;
      contact_id: string;
      session_id: string | null;
      name: string | null;
      hostname: string | null;
      path: string | null;
      params: string | null;
      ts: number;
    }>(`SELECT * FROM automation_queue ORDER BY id LIMIT ?`, limit)
    .map((r) => ({
      id: r.id,
      kind: r.kind === 'goal' ? ('goal' as const) : ('pageview' as const),
      visitorId: r.visitor_id,
      contactId: r.contact_id,
      sessionId: r.session_id,
      name: r.name,
      hostname: r.hostname,
      path: r.path,
      params: parseRecord(r.params),
      ts: r.ts,
    }));
  const alerts = db
    .all<{ id: number; alert_id: string; goal: string; visitor_id: string | null; test: number; ts: number }>(
      `SELECT * FROM alert_queue ORDER BY id LIMIT ?`,
      limit,
    )
    .map((r) => ({ id: r.id, alertId: r.alert_id, goal: r.goal, visitorId: r.visitor_id, test: r.test === 1, ts: r.ts }));
  const ids = [...new Set(alerts.map((a) => a.alertId))];
  const alertTargets =
    ids.length === 0
      ? []
      : db
          .all<{
            id: string;
            name: string;
            goal: string;
            enabled: number;
            email_recipients: string;
            webhook_url: string | null;
            webhook_secret: string | null;
            last_triggered_at: number | null;
          }>(`SELECT * FROM alerts WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids))
          .map((a) => ({
            id: a.id,
            name: a.name,
            goal: a.goal,
            enabled: a.enabled === 1,
            emailRecipients: (JSON.parse(a.email_recipients) as unknown[]).filter((x): x is string => typeof x === 'string'),
            webhookUrl: a.webhook_url,
            webhookSecret: a.webhook_secret,
            lastTriggeredAt: a.last_triggered_at,
          }));
  return { identities, automation, alerts, alertTargets };
}

export function ackCoreWork(
  db: SqlDb,
  ack: { identities?: number[]; automation?: number[]; alerts?: number[] },
): void {
  db.transaction(() => {
    const del = (table: string, ids: number[] | undefined): void => {
      if (ids === undefined || ids.length === 0) return;
      db.run(`DELETE FROM ${table} WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids));
    };
    del('identity_queue', ack.identities);
    del('automation_queue', ack.automation);
    del('alert_queue', ack.alerts);
  });
}

export function recordAlertDelivery(
  db: SqlDb,
  alertId: string,
  deliveries: ReadonlyArray<{ channel: 'email' | 'webhook'; ok: boolean }>,
  now: number,
): void {
  db.transaction(() => {
    db.run(`UPDATE alerts SET last_triggered_at = ? WHERE id = ?`, now, alertId);
    for (const d of deliveries) {
      db.run(
        `INSERT INTO alert_deliveries (alert_id, channel, ok, ts) VALUES (?, ?, ?, ?)`,
        alertId,
        d.channel,
        d.ok ? 1 : 0,
        now,
      );
    }
    db.run(`DELETE FROM alert_deliveries WHERE ts < ?`, now - 30 * 86_400_000);
  });
}

export function pendingCoreWork(db: SqlDb): boolean {
  const n = (table: string): number => first<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0;
  return n('identity_queue') + n('automation_queue') + n('alert_queue') > 0;
}
