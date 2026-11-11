import type { CrmContext } from '../crm/context';
import { CrmError } from '../crm/errors';

/**
 * Sales of the server API (TenantDb operations, spread into `crmOps`). The
 * routing decision is part of the first write and never changes afterwards:
 * a retry re-reads it, so the same sale can never land on two sites.
 */

export type SaleDecision = 'existing' | 'forced' | 'visitor' | 'last_touch' | 'unattributed';

export interface WebSale {
  transaction_id: string;
  contact_id: string | null;
  site_id: string | null;
  visitor_id: string | null;
  decided_by: SaleDecision;
  amount_minor: number;
  currency: string;
  order_id: string | null;
  renewal: number;
  refunded_minor: number;
  occurred_at: number;
  dispatched_at: number | null;
}

export interface WebRefund {
  refund_id: string;
  transaction_id: string;
  amount_minor: number;
  occurred_at: number;
  dispatched_at: number | null;
}

function getSale(ctx: CrmContext, input: { transactionId: string }): WebSale | null {
  return (
    ctx.db.all<WebSale>(
      `SELECT * FROM crm_web_sales WHERE transaction_id = ?`,
      input.transactionId,
    )[0] ?? null
  );
}

function recordSale(
  ctx: CrmContext,
  input: {
    transactionId: string;
    contactId: string | null;
    amountMinor: number;
    currency: string;
    orderId: string | null;
    renewal: boolean;
    occurredAt: number;
    siteId: string | null;
    visitorId: string | null;
    decidedBy: SaleDecision;
  },
): { sale: WebSale; created: boolean; conflict: boolean } {
  const inserted = ctx.db.all<{ transaction_id: string }>(
    `INSERT INTO crm_web_sales (transaction_id, contact_id, site_id, visitor_id, decided_by, amount_minor, currency,
       order_id, renewal, occurred_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (transaction_id) DO NOTHING RETURNING transaction_id`,
    input.transactionId,
    input.contactId,
    input.siteId,
    input.visitorId,
    input.decidedBy,
    input.amountMinor,
    input.currency,
    input.orderId,
    input.renewal ? 1 : 0,
    input.occurredAt,
    ctx.now(),
  );
  const sale = getSale(ctx, input) as WebSale;
  const created = inserted.length > 0;
  return {
    sale,
    created,
    conflict:
      !created && (sale.amount_minor !== input.amountMinor || sale.currency !== input.currency),
  };
}

function markSaleDispatched(ctx: CrmContext, input: { transactionId: string }): void {
  ctx.db.run(
    `UPDATE crm_web_sales SET dispatched_at = ? WHERE transaction_id = ? AND dispatched_at IS NULL`,
    ctx.now(),
    input.transactionId,
  );
}

/** The site of a sale no longer exists: the sale stays in the workspace, unattributed. */
function unplaceSale(ctx: CrmContext, input: { transactionId: string }): void {
  ctx.db.run(
    `UPDATE crm_web_sales SET site_id = NULL, visitor_id = NULL, decided_by = 'unattributed', dispatched_at = ?
     WHERE transaction_id = ?`,
    ctx.now(),
    input.transactionId,
  );
}

/** Records a refund once (refund id); the amount defaults to, and is capped at, what is left to refund. */
function recordRefund(
  ctx: CrmContext,
  input: {
    refundId: string;
    transactionId: string;
    amountMinor: number | null;
    occurredAt: number;
  },
): { refund: WebRefund; sale: WebSale; created: boolean } {
  const sale = getSale(ctx, input);
  if (sale === null) throw new CrmError('not_found', `sale ${input.transactionId} not found`);
  const existing = ctx.db.all<WebRefund>(
    `SELECT * FROM crm_web_refunds WHERE refund_id = ?`,
    input.refundId,
  )[0];
  if (existing !== undefined) {
    if (existing.transaction_id !== sale.transaction_id) {
      throw new CrmError('conflict', `refund ${input.refundId} belongs to another sale`);
    }
    return { refund: existing, sale, created: false };
  }
  const left = sale.amount_minor - sale.refunded_minor;
  const amount = Math.min(input.amountMinor ?? left, left);
  if (amount <= 0)
    throw new CrmError('conflict', `sale ${sale.transaction_id} is already fully refunded`);
  ctx.db.run(
    `INSERT INTO crm_web_refunds (refund_id, transaction_id, amount_minor, occurred_at, created_at) VALUES (?, ?, ?, ?, ?)`,
    input.refundId,
    sale.transaction_id,
    amount,
    input.occurredAt,
    ctx.now(),
  );
  ctx.db.run(
    `UPDATE crm_web_sales SET refunded_minor = refunded_minor + ? WHERE transaction_id = ?`,
    amount,
    sale.transaction_id,
  );
  return {
    refund: ctx.db.all<WebRefund>(
      `SELECT * FROM crm_web_refunds WHERE refund_id = ?`,
      input.refundId,
    )[0] as WebRefund,
    sale: getSale(ctx, input) as WebSale,
    created: true,
  };
}

function markRefundDispatched(ctx: CrmContext, input: { refundId: string }): void {
  ctx.db.run(
    `UPDATE crm_web_refunds SET dispatched_at = ? WHERE refund_id = ? AND dispatched_at IS NULL`,
    ctx.now(),
    input.refundId,
  );
}

function getRefund(ctx: CrmContext, input: { refundId: string }): WebRefund | null {
  return (
    ctx.db.all<WebRefund>(`SELECT * FROM crm_web_refunds WHERE refund_id = ?`, input.refundId)[0] ??
    null
  );
}

/** Placed sales and refunds not yet applied by their site, recorded before `before`. */
function undispatchedSales(
  ctx: CrmContext,
  input: { before: number; limit: number },
): { sales: string[]; refunds: string[] } {
  return {
    sales: ctx.db
      .all<{ transaction_id: string }>(
        `SELECT transaction_id FROM crm_web_sales
         WHERE dispatched_at IS NULL AND site_id IS NOT NULL AND created_at < ? ORDER BY created_at LIMIT ?`,
        input.before,
        input.limit,
      )
      .map((r) => r.transaction_id),
    refunds: ctx.db
      .all<{ refund_id: string }>(
        `SELECT r.refund_id FROM crm_web_refunds r JOIN crm_web_sales s ON s.transaction_id = r.transaction_id
         WHERE r.dispatched_at IS NULL AND s.site_id IS NOT NULL AND r.created_at < ? ORDER BY r.created_at LIMIT ?`,
        input.before,
        input.limit,
      )
      .map((r) => r.refund_id),
  };
}

export const salesCrmOps = {
  'analytics.getSale': getSale,
  'analytics.recordSale': recordSale,
  'analytics.markSaleDispatched': markSaleDispatched,
  'analytics.unplaceSale': unplaceSale,
  'analytics.recordRefund': recordRefund,
  'analytics.markRefundDispatched': markRefundDispatched,
  'analytics.getRefund': getRefund,
  'analytics.undispatchedSales': undispatchedSales,
};
