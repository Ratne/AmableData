import type {
  CreatePaymentInput,
  CreateRefundInput,
  ListPaymentsQuery,
  ListRefundsQuery,
  Page,
  Payment,
  Refund,
} from '@amable/api-types';
import type { CrmContext } from '../crm/context';
import { CrmError, invalid, notFound } from '../crm/errors';
import { emit } from '../crm/events';
import { decodeCursor, encodeCursor, parseIsoMs, toIso } from '../crm/util';
import { applyStatus } from './orders';
import { getOrderRow, orderFacts } from './rows';
import { isRenewalOrder, onSubscriptionPaymentFailed } from './sub-hooks';

interface PaymentRow {
  id: string;
  order_id: string;
  contact_id: string;
  status: Payment['status'];
  method: Payment['method'];
  amount_minor: number;
  currency: string;
  refunded_minor: number;
  transaction_id: string | null;
  failure_reason: string | null;
  notes: string | null;
  paid_at: number;
  created_at: number;
}

interface RefundRow {
  id: string;
  order_id: string;
  payment_id: string | null;
  contact_id: string;
  amount_minor: number;
  currency: string;
  reason: string | null;
  transaction_id: string | null;
  refunded_at: number;
  created_at: number;
}

function paymentToApi(row: PaymentRow): Payment {
  return {
    id: row.id,
    order_id: row.order_id,
    contact_id: row.contact_id,
    status: row.status,
    method: row.method,
    amount_minor: row.amount_minor,
    currency: row.currency,
    refunded_minor: row.refunded_minor,
    transaction_id: row.transaction_id,
    failure_reason: row.failure_reason,
    notes: row.notes,
    paid_at: toIso(row.paid_at),
    created_at: toIso(row.created_at),
  };
}

function refundToApi(row: RefundRow): Refund {
  return {
    id: row.id,
    order_id: row.order_id,
    payment_id: row.payment_id,
    contact_id: row.contact_id,
    amount_minor: row.amount_minor,
    currency: row.currency,
    reason: row.reason,
    transaction_id: row.transaction_id,
    refunded_at: toIso(row.refunded_at),
    created_at: toIso(row.created_at),
  };
}

function getPaymentRow(ctx: CrmContext, id: string): PaymentRow {
  const row = ctx.db.all<PaymentRow>(`SELECT * FROM crm_payments WHERE id = ?`, id)[0];
  if (row === undefined) throw notFound('payment', id);
  return row;
}

export function getPayment(ctx: CrmContext, input: { id: string }): Payment {
  return paymentToApi(getPaymentRow(ctx, input.id));
}

export function getRefund(ctx: CrmContext, input: { id: string }): Refund {
  const row = ctx.db.all<RefundRow>(`SELECT * FROM crm_refunds WHERE id = ?`, input.id)[0];
  if (row === undefined) throw notFound('refund', input.id);
  return refundToApi(row);
}

/**
 * Records a payment (manual or API — there is no gateway). Idempotent by
 * `transaction_id`: the same reference for the same order and amount returns
 * the first payment without side effects; for anything else it is a 409.
 * Succeeded payments cannot exceed the open balance; failed ones move money
 * nowhere but mark the order's subscription past_due.
 */
export function recordPayment(
  ctx: CrmContext,
  input: { orderId: string; data: CreatePaymentInput },
): Payment {
  const order = getOrderRow(ctx, input.orderId);
  const d = input.data;
  const status = d.status ?? 'succeeded';
  const transactionId = d.transaction_id ?? null;
  if (transactionId !== null) {
    const existing = ctx.db.all<PaymentRow>(
      `SELECT * FROM crm_payments WHERE transaction_id = ?`,
      transactionId,
    )[0];
    if (existing !== undefined) {
      if (
        existing.order_id === order.id &&
        existing.amount_minor === d.amount_minor &&
        existing.status === status
      ) {
        return paymentToApi(existing);
      }
      throw new CrmError(
        'conflict',
        `transaction ${transactionId} is already recorded on another payment`,
      );
    }
  }
  if (order.status === 'draft')
    throw new CrmError('conflict', `order ${order.number} is a draft; finalize it first`);
  if (order.status === 'cancelled' || order.status === 'refunded') {
    throw new CrmError('conflict', `order ${order.number} is ${order.status}`);
  }
  const balance = order.total_minor - order.paid_minor;
  if (status === 'succeeded') {
    if (balance <= 0) throw new CrmError('conflict', `order ${order.number} is already paid`);
    if (d.amount_minor > balance) {
      throw invalid('amount_minor', `amount exceeds the open balance of ${balance}`);
    }
  }
  const id = ctx.newId();
  const now = ctx.now();
  ctx.db.run(
    `INSERT INTO crm_payments (id, order_id, contact_id, status, method, amount_minor, currency, refunded_minor,
       transaction_id, failure_reason, notes, paid_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
    id,
    order.id,
    order.contact_id,
    status,
    d.method,
    d.amount_minor,
    order.currency,
    transactionId,
    status === 'failed' ? (d.failure_reason ?? null) : null,
    d.notes ?? null,
    d.paid_at === undefined ? now : parseIsoMs(d.paid_at, 'paid_at'),
    ctx.actor.id,
    now,
  );
  const facts = orderFacts(ctx, order);
  const money = {
    contactId: order.contact_id,
    amountMinor: d.amount_minor,
    currency: order.currency,
    visitorId: order.analytics_visitor_id,
    paymentId: id,
    orderId: order.id,
    method: d.method,
    transactionId,
    subscriptionId: facts.subscriptionId,
  };
  if (status === 'failed') {
    emit(ctx, 'payment.failed', money, { number: order.number });
    onSubscriptionPaymentFailed(ctx, order);
    return getPayment(ctx, { id });
  }
  ctx.db.run(
    `UPDATE crm_orders SET paid_minor = paid_minor + ?, updated_at = ? WHERE id = ?`,
    d.amount_minor,
    now,
    order.id,
  );
  emit(
    ctx,
    'payment.recorded',
    { ...money, renewal: isRenewalOrder(ctx, order) },
    {
      number: order.number,
    },
  );
  applyStatus(ctx, order.id);
  return getPayment(ctx, { id });
}

/**
 * Records a full or partial refund (default: everything still refundable).
 * Against a payment it is bounded by that payment's unrefunded amount;
 * otherwise it is spread over the order's payments, newest first. Idempotent
 * by `transaction_id` like payments.
 */
export function recordRefund(
  ctx: CrmContext,
  input: { orderId: string; data: CreateRefundInput },
): Refund {
  const order = getOrderRow(ctx, input.orderId);
  const d = input.data;
  const transactionId = d.transaction_id ?? null;
  if (transactionId !== null) {
    const existing = ctx.db.all<RefundRow>(
      `SELECT * FROM crm_refunds WHERE transaction_id = ?`,
      transactionId,
    )[0];
    if (existing !== undefined) {
      if (
        existing.order_id === order.id &&
        (d.amount_minor === undefined || existing.amount_minor === d.amount_minor)
      ) {
        return refundToApi(existing);
      }
      throw new CrmError(
        'conflict',
        `transaction ${transactionId} is already recorded on another refund`,
      );
    }
  }
  const refundable = order.paid_minor - order.refunded_minor;
  if (refundable <= 0)
    throw new CrmError('conflict', `order ${order.number} has nothing to refund`);
  const payments = ctx.db.all<PaymentRow>(
    `SELECT * FROM crm_payments WHERE order_id = ? AND status = 'succeeded' AND amount_minor > refunded_minor
     ORDER BY paid_at DESC, id DESC`,
    order.id,
  );
  let targets = payments;
  let limit = refundable;
  if (d.payment_id !== undefined && d.payment_id !== null) {
    const payment = payments.find((p) => p.id === d.payment_id);
    if (payment === undefined) {
      throw invalid('payment_id', `payment ${d.payment_id} has nothing refundable on this order`);
    }
    targets = [payment];
    limit = payment.amount_minor - payment.refunded_minor;
  }
  const amount = d.amount_minor ?? limit;
  if (amount > limit) throw invalid('amount_minor', `amount exceeds the refundable ${limit}`);

  let left = amount;
  for (const payment of targets) {
    if (left === 0) break;
    const share = Math.min(left, payment.amount_minor - payment.refunded_minor);
    ctx.db.run(
      `UPDATE crm_payments SET refunded_minor = refunded_minor + ? WHERE id = ?`,
      share,
      payment.id,
    );
    left -= share;
  }
  const id = ctx.newId();
  const now = ctx.now();
  ctx.db.run(
    `INSERT INTO crm_refunds (id, order_id, payment_id, contact_id, amount_minor, currency, reason, transaction_id,
       refunded_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    order.id,
    d.payment_id ?? null,
    order.contact_id,
    amount,
    order.currency,
    d.reason ?? null,
    transactionId,
    d.refunded_at === undefined ? now : parseIsoMs(d.refunded_at, 'refunded_at'),
    ctx.actor.id,
    now,
  );
  ctx.db.run(
    `UPDATE crm_orders SET refunded_minor = refunded_minor + ?, updated_at = ? WHERE id = ?`,
    amount,
    now,
    order.id,
  );
  emit(
    ctx,
    'refund.recorded',
    {
      contactId: order.contact_id,
      amountMinor: amount,
      currency: order.currency,
      visitorId: order.analytics_visitor_id,
      refundId: id,
      orderId: order.id,
      paymentId: d.payment_id ?? null,
      transactionId,
      full: refundable - amount === 0,
    },
    { number: order.number },
  );
  applyStatus(ctx, order.id);
  return getRefund(ctx, { id });
}

export function listPayments(ctx: CrmContext, input: ListPaymentsQuery): Page<Payment> {
  const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor);
  const at = cursor === null ? null : Number(cursor.v);
  const from = input.from === undefined ? null : parseIsoMs(input.from, 'from');
  const to = input.to === undefined ? null : parseIsoMs(input.to, 'to');
  const rows = ctx.db.all<PaymentRow>(
    `SELECT * FROM crm_payments WHERE (? IS NULL OR order_id = ?) AND (? IS NULL OR contact_id = ?)
       AND (? IS NULL OR status = ?) AND (? IS NULL OR paid_at >= ?) AND (? IS NULL OR paid_at < ?)
       AND (? IS NULL OR paid_at < ? OR (paid_at = ? AND id < ?))
     ORDER BY paid_at DESC, id DESC LIMIT ?`,
    input.order_id ?? null,
    input.order_id ?? null,
    input.contact_id ?? null,
    input.contact_id ?? null,
    input.status ?? null,
    input.status ?? null,
    from,
    from,
    to,
    to,
    at,
    at,
    at,
    cursor?.id ?? null,
    input.limit + 1,
  );
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    data: page.map(paymentToApi),
    next_cursor:
      rows.length > input.limit && last !== undefined
        ? encodeCursor({ v: last.paid_at, id: last.id })
        : null,
  };
}

export function listRefunds(ctx: CrmContext, input: ListRefundsQuery): Page<Refund> {
  const before = input.cursor === undefined ? null : decodeCursor(input.cursor).id;
  const rows = ctx.db.all<RefundRow>(
    `SELECT * FROM crm_refunds WHERE (? IS NULL OR order_id = ?) AND (? IS NULL OR contact_id = ?)
       AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`,
    input.order_id ?? null,
    input.order_id ?? null,
    input.contact_id ?? null,
    input.contact_id ?? null,
    before,
    before,
    input.limit + 1,
  );
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    data: page.map(refundToApi),
    next_cursor:
      rows.length > input.limit && last !== undefined
        ? encodeCursor({ v: null, id: last.id })
        : null,
  };
}
