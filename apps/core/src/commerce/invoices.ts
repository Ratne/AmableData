import type { Invoice, ListInvoicesQuery, Page } from '@amable/api-types';
import type { CrmContext } from '../crm/context';
import { notFound } from '../crm/errors';
import { decodeCursor, encodeCursor, toIso } from '../crm/util';
import { itemsOf, type OrderRow } from './rows';
import { nextCounter, getSettings } from './settings';
import { itemToApi } from './serialize';

interface InvoiceRow {
  id: string;
  number: string;
  year: number;
  sequence: number;
  order_id: string;
  contact_id: string;
  status: Invoice['status'];
  currency: string;
  total_minor: number;
  issued_at: number;
  due_at: number | null;
  paid_at: number | null;
  voided_at: number | null;
}

/** Invoice number: `<prefix><year>-<5-digit sequence>`; the sequence restarts each (UTC) year. */
export function formatInvoiceNumber(prefix: string, year: number, sequence: number): string {
  return `${prefix}${year}-${String(sequence).padStart(5, '0')}`;
}

/** Issues the invoice of a just-finalized order (one per order, gapless numbering). */
export function issueInvoice(ctx: CrmContext, order: OrderRow, issuedAt: number): void {
  const year = new Date(issuedAt).getUTCFullYear();
  const sequence = nextCounter(ctx, `invoice:${year}`);
  const now = ctx.now();
  ctx.db.run(
    `INSERT INTO crm_invoices (id, number, year, sequence, order_id, contact_id, status, currency, total_minor,
       issued_at, due_at, paid_at, voided_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    ctx.newId(),
    formatInvoiceNumber(getSettings(ctx).invoice_prefix, year, sequence),
    year,
    sequence,
    order.id,
    order.contact_id,
    order.currency,
    order.total_minor,
    issuedAt,
    order.due_at,
    now,
    now,
  );
}

/** Mirrors the order state on its invoice: paid / void / open. */
export function syncInvoice(ctx: CrmContext, order: OrderRow): void {
  const status: Invoice['status'] =
    order.status === 'cancelled'
      ? 'void'
      : order.status === 'paid' || order.status === 'refunded'
        ? 'paid'
        : 'open';
  ctx.db.run(
    `UPDATE crm_invoices SET status = ?, due_at = ?,
       paid_at = CASE WHEN ? = 'paid' THEN IFNULL(paid_at, ?) ELSE NULL END,
       voided_at = CASE WHEN ? = 'void' THEN IFNULL(voided_at, ?) ELSE NULL END,
       updated_at = ? WHERE order_id = ?`,
    status,
    order.due_at,
    status,
    order.paid_at ?? ctx.now(),
    status,
    order.cancelled_at ?? ctx.now(),
    ctx.now(),
    order.id,
  );
}

function toApi(ctx: CrmContext, row: InvoiceRow): Invoice {
  const order = ctx.db.all<OrderRow>(`SELECT * FROM crm_orders WHERE id = ?`, row.order_id)[0];
  return {
    id: row.id,
    number: row.number,
    year: row.year,
    sequence: row.sequence,
    order_id: row.order_id,
    contact_id: row.contact_id,
    status: row.status,
    currency: row.currency,
    subtotal_minor: order?.subtotal_minor ?? 0,
    discount_minor: order?.discount_minor ?? 0,
    tax_minor: order?.tax_minor ?? 0,
    shipping_minor: order?.shipping_minor ?? 0,
    total_minor: row.total_minor,
    items: itemsOf(ctx, row.order_id).map(itemToApi),
    issued_at: toIso(row.issued_at),
    due_at: toIso(row.due_at),
    paid_at: toIso(row.paid_at),
    voided_at: toIso(row.voided_at),
  };
}

export function getInvoice(ctx: CrmContext, input: { id: string }): Invoice {
  const row = ctx.db.all<InvoiceRow>(`SELECT * FROM crm_invoices WHERE id = ?`, input.id)[0];
  if (row === undefined) throw notFound('invoice', input.id);
  return toApi(ctx, row);
}

/** Newest first (year, then sequence). */
export function listInvoices(ctx: CrmContext, input: ListInvoicesQuery): Page<Invoice> {
  const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor);
  const key = cursor === null ? null : Number(cursor.v);
  const rows = ctx.db.all<InvoiceRow>(
    `SELECT * FROM crm_invoices WHERE (? IS NULL OR status = ?) AND (? IS NULL OR contact_id = ?)
       AND (? IS NULL OR year = ?) AND (? IS NULL OR (year * 1000000 + sequence) < ?)
     ORDER BY year DESC, sequence DESC LIMIT ?`,
    input.status ?? null,
    input.status ?? null,
    input.contact_id ?? null,
    input.contact_id ?? null,
    input.year ?? null,
    input.year ?? null,
    key,
    key,
    input.limit + 1,
  );
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    data: page.map((row) => toApi(ctx, row)),
    next_cursor:
      rows.length > input.limit && last !== undefined
        ? encodeCursor({ v: last.year * 1_000_000 + last.sequence, id: last.id })
        : null,
  };
}
