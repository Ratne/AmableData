import type { CheckoutConnection, CheckoutConnectionType, DeliveryStatus } from '@amable/api-types';
import type { CrmContext } from '../crm/context';
import type { SqlValue } from '../crm/db/sql';
import { notFound } from '../crm/errors';
import { parseJson, toIso } from '../crm/util';
import type { OrderRow } from '../commerce/rows';
import { getCheckoutRow } from './checkouts';
import type { AdMeta } from './sessions';

/**
 * Per-checkout integrations (server-side conversions for paid orders).
 * Configs arrive validated and secrets already encrypted by the worker; the
 * ciphertext is only returned to the delivering worker.
 */

export interface CheckoutConnectionRow {
  id: string;
  checkout_id: string;
  type: CheckoutConnectionType;
  name: string;
  enabled: number;
  config: string;
  secret_ciphertext: string | null;
  secret_hint: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

function connectionRow(ctx: CrmContext, checkoutId: string, id: string): CheckoutConnectionRow {
  const row = ctx.db.all<CheckoutConnectionRow>(
    `SELECT * FROM checkout_connections WHERE id = ? AND checkout_id = ? AND deleted_at IS NULL`,
    id,
    checkoutId,
  )[0];
  if (row === undefined) throw notFound('connection', id);
  return row;
}

function serialize(ctx: CrmContext, rows: CheckoutConnectionRow[]): CheckoutConnection[] {
  const ids = rows.map((r) => r.id);
  const last = new Map(
    ids.length === 0
      ? []
      : ctx.db
          .all<{ connection_id: string; status: DeliveryStatus; updated_at: number }>(
            `SELECT connection_id, status, MAX(updated_at) AS updated_at FROM checkout_deliveries
             WHERE connection_id IN (${ids.map(() => '?').join(', ')}) GROUP BY connection_id`,
            ...ids,
          )
          .map((r) => [r.connection_id, { status: r.status, at: toIso(r.updated_at) }] as const),
  );
  return rows.map((row) => ({
    id: row.id,
    checkout_id: row.checkout_id,
    type: row.type,
    name: row.name,
    enabled: row.enabled === 1,
    config: parseJson<Record<string, unknown>>(row.config, {}),
    has_secret: row.secret_ciphertext !== null,
    secret_hint: row.secret_hint,
    last_delivery: last.get(row.id) ?? null,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  }));
}

export function listCheckoutConnections(ctx: CrmContext, input: { checkoutId: string }): CheckoutConnection[] {
  getCheckoutRow(ctx, input.checkoutId);
  const rows = ctx.db.all<CheckoutConnectionRow>(
    `SELECT * FROM checkout_connections WHERE checkout_id = ? AND deleted_at IS NULL ORDER BY created_at, id`,
    input.checkoutId,
  );
  return serialize(ctx, rows);
}

export function getCheckoutConnection(ctx: CrmContext, input: { checkoutId: string; id: string }): CheckoutConnection {
  const [connection] = serialize(ctx, [connectionRow(ctx, input.checkoutId, input.id)]);
  if (connection === undefined) throw notFound('connection', input.id);
  return connection;
}

/** Row with the encrypted secret, for the worker (test). */
export function checkoutConnectionForWorker(ctx: CrmContext, input: { checkoutId: string; id: string }): CheckoutConnectionRow {
  return connectionRow(ctx, input.checkoutId, input.id);
}

export interface CreateCheckoutConnectionOpInput {
  id: string;
  checkoutId: string;
  type: CheckoutConnectionType;
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  secretCiphertext: string;
  secretHint: string;
}

export function createCheckoutConnection(ctx: CrmContext, input: CreateCheckoutConnectionOpInput): CheckoutConnection {
  getCheckoutRow(ctx, input.checkoutId);
  const now = ctx.now();
  ctx.db.run(
    `INSERT INTO checkout_connections
       (id, checkout_id, type, name, enabled, config, secret_ciphertext, secret_hint, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.id,
    input.checkoutId,
    input.type,
    input.name,
    input.enabled ? 1 : 0,
    JSON.stringify(input.config),
    input.secretCiphertext,
    input.secretHint,
    ctx.actor.id,
    now,
    now,
  );
  return getCheckoutConnection(ctx, { checkoutId: input.checkoutId, id: input.id });
}

export interface UpdateCheckoutConnectionOpInput {
  checkoutId: string;
  id: string;
  name?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
  secretCiphertext?: string;
  secretHint?: string;
}

export function updateCheckoutConnection(ctx: CrmContext, input: UpdateCheckoutConnectionOpInput): CheckoutConnection {
  const row = connectionRow(ctx, input.checkoutId, input.id);
  const sets: string[] = [];
  const values: SqlValue[] = [];
  if (input.name !== undefined) {
    sets.push('name = ?');
    values.push(input.name);
  }
  if (input.enabled !== undefined) {
    sets.push('enabled = ?');
    values.push(input.enabled ? 1 : 0);
  }
  if (input.config !== undefined) {
    sets.push('config = ?');
    values.push(JSON.stringify(input.config));
  }
  if (input.secretCiphertext !== undefined) {
    sets.push('secret_ciphertext = ?', 'secret_hint = ?');
    values.push(input.secretCiphertext, input.secretHint ?? null);
  }
  if (sets.length > 0) {
    sets.push('updated_at = ?');
    values.push(ctx.now());
    ctx.db.run(`UPDATE checkout_connections SET ${sets.join(', ')} WHERE id = ?`, ...values, row.id);
  }
  return getCheckoutConnection(ctx, { checkoutId: input.checkoutId, id: input.id });
}

export function deleteCheckoutConnection(
  ctx: CrmContext,
  input: { checkoutId: string; id: string },
): { id: string; deleted: true } {
  const row = connectionRow(ctx, input.checkoutId, input.id);
  const now = ctx.now();
  ctx.db.run(
    `UPDATE checkout_connections SET deleted_at = ?, updated_at = ?, secret_ciphertext = NULL WHERE id = ?`,
    now,
    now,
    row.id,
  );
  return { id: row.id, deleted: true };
}

/** What the worker needs to send a paid checkout order to the ad platforms. */
export interface PaidCheckoutOrder {
  order: {
    id: string;
    number: string;
    totalMinor: number;
    currency: string;
    /** Epoch ms. */
    paidAt: number;
  };
  email: string | null;
  phone: string | null;
  tracking: Record<string, string>;
  adMeta: AdMeta | null;
  pageUrl: string | null;
  /** Enabled connections without a successful (or skipped) delivery for this order. */
  pending: CheckoutConnectionRow[];
  attempts: Record<string, number>;
}

/**
 * Paid checkout order with its pending conversions; null when the order is
 * not a paid checkout order or every connection already delivered it.
 */
export function paidCheckoutOrder(ctx: CrmContext, input: { orderId: string }): PaidCheckoutOrder | null {
  const order = ctx.db.all<OrderRow>(`SELECT * FROM crm_orders WHERE id = ?`, input.orderId)[0];
  if (order === undefined || order.checkout_id === null || order.paid_at === null) return null;
  const connections = ctx.db.all<CheckoutConnectionRow>(
    `SELECT * FROM checkout_connections WHERE checkout_id = ? AND enabled = 1 AND deleted_at IS NULL ORDER BY created_at, id`,
    order.checkout_id,
  );
  if (connections.length === 0) return null;
  const deliveries = ctx.db.all<{ connection_id: string; status: DeliveryStatus; attempts: number }>(
    `SELECT connection_id, status, attempts FROM checkout_deliveries WHERE order_id = ?`,
    order.id,
  );
  const done = new Set(deliveries.filter((d) => d.status === 'success' || d.status === 'skipped').map((d) => d.connection_id));
  const pending = connections.filter((c) => !done.has(c.id));
  if (pending.length === 0) return null;
  const contact = ctx.db.all<{ primary_email: string | null; primary_phone: string | null }>(
    `SELECT primary_email, primary_phone FROM crm_contacts WHERE id = ?`,
    order.contact_id,
  )[0];
  const session =
    order.checkout_session_id === null
      ? undefined
      : ctx.db.all<{ tracking: string; ad_meta: string | null; page_url: string | null }>(
          `SELECT tracking, ad_meta, page_url FROM crm_checkout_sessions WHERE id = ?`,
          order.checkout_session_id,
        )[0];
  return {
    order: { id: order.id, number: order.number, totalMinor: order.total_minor, currency: order.currency, paidAt: order.paid_at },
    email: contact?.primary_email ?? null,
    phone: contact?.primary_phone ?? null,
    tracking: session === undefined ? {} : parseJson<Record<string, string>>(session.tracking, {}),
    adMeta: session?.ad_meta == null ? null : parseJson<AdMeta | null>(session.ad_meta, null),
    pageUrl: session?.page_url ?? null,
    pending,
    attempts: Object.fromEntries(deliveries.map((d) => [d.connection_id, d.attempts])),
  };
}

export interface RecordCheckoutDeliveryInput {
  orderId: string;
  connectionId: string;
  status: DeliveryStatus;
  statusCode: number | null;
  request: string | null;
  response: string | null;
}

export function recordCheckoutDelivery(ctx: CrmContext, input: RecordCheckoutDeliveryInput): { attempts: number } {
  const now = ctx.now();
  const request = input.request === null ? null : input.request.slice(0, 2000);
  const response = input.response === null ? null : input.response.slice(0, 2000);
  const existing = ctx.db.all<{ id: string; attempts: number }>(
    `SELECT id, attempts FROM checkout_deliveries WHERE order_id = ? AND connection_id = ?`,
    input.orderId,
    input.connectionId,
  )[0];
  if (existing === undefined) {
    ctx.db.run(
      `INSERT INTO checkout_deliveries
         (id, order_id, connection_id, status, attempts, status_code, request, response, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      ctx.newId(),
      input.orderId,
      input.connectionId,
      input.status,
      input.statusCode,
      request,
      response,
      now,
      now,
    );
    return { attempts: 1 };
  }
  ctx.db.run(
    `UPDATE checkout_deliveries SET status = ?, attempts = attempts + 1, status_code = ?, request = ?, response = ?, updated_at = ?
     WHERE id = ?`,
    input.status,
    input.statusCode,
    request,
    response,
    now,
    existing.id,
  );
  return { attempts: existing.attempts + 1 };
}
