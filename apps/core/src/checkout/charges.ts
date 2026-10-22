import type { Refund } from '@amable/api-types';
import type { CrmContext } from '../crm/context';
import { CrmError, invalid } from '../crm/errors';
import { getRefund, recordPayment, recordRefund } from '../commerce/payments';
import { getOrderRow } from '../commerce/rows';
import { settleOfferCharge } from './offers';
import { settleCheckoutIntent, type IntentFacts } from './sessions';

/** Automatic charges of a renewal order: the first try plus these retries. */
export const RETRY_DELAYS_MS = [3 * 86_400_000, 5 * 86_400_000] as const;
export const MAX_CHARGE_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
/** A charge picked up by the alarm is not picked up again for this long (crash safety). */
const LEASE_MS = 15 * 60_000;
const PROCESSING_RECHECK_MS = 86_400_000;

export interface DueCharge {
  orderId: string;
  number: string;
  contactId: string;
  amountMinor: number;
  currency: string;
  customerId: string;
  paymentMethodId: string;
  attempt: number;
  /** Stripe sends its receipt here. */
  receiptEmail: string | null;
}

/** Renewal orders to charge now on the saved payment method (leased while the worker charges them). */
export function chargesDue(ctx: CrmContext, input: { limit?: number } = {}): DueCharge[] {
  const now = ctx.now();
  const rows = ctx.db.all<{
    id: string;
    number: string;
    contact_id: string;
    total_minor: number;
    paid_minor: number;
    currency: string;
    status: string;
    auto_charge_attempts: number;
    customer: string | null;
    method: string | null;
    subscription_status: string | null;
    email: string | null;
  }>(
    `SELECT o.id, o.number, o.contact_id, o.total_minor, o.paid_minor, o.currency, o.status, o.auto_charge_attempts,
       s.stripe_customer_id AS customer, s.stripe_payment_method_id AS method, s.status AS subscription_status,
       c.primary_email AS email
     FROM crm_orders o LEFT JOIN crm_subscriptions s ON s.id = o.subscription_id
       LEFT JOIN crm_contacts c ON c.id = o.contact_id
     WHERE o.next_charge_at IS NOT NULL AND o.next_charge_at <= ? AND o.deleted_at IS NULL
     ORDER BY o.next_charge_at LIMIT ?`,
    now,
    input.limit ?? 25,
  );
  const out: DueCharge[] = [];
  for (const row of rows) {
    const balance = row.total_minor - row.paid_minor;
    const chargeable =
      (row.status === 'unpaid' || row.status === 'partially_paid') &&
      balance > 0 &&
      row.subscription_status !== 'paused' &&
      row.customer !== null &&
      row.method !== null &&
      row.auto_charge_attempts < MAX_CHARGE_ATTEMPTS;
    if (!chargeable || row.customer === null || row.method === null) {
      ctx.db.run(`UPDATE crm_orders SET next_charge_at = NULL WHERE id = ?`, row.id);
      continue;
    }
    ctx.db.run(`UPDATE crm_orders SET next_charge_at = ? WHERE id = ?`, now + LEASE_MS, row.id);
    out.push({
      orderId: row.id,
      number: row.number,
      contactId: row.contact_id,
      amountMinor: balance,
      currency: row.currency,
      customerId: row.customer,
      paymentMethodId: row.method,
      attempt: row.auto_charge_attempts + 1,
      receiptEmail: row.email,
    });
  }
  return out;
}

/**
 * Outcome of an automatic charge. A failure is recorded as a failed payment
 * (the subscription becomes past_due) and retried later; idempotent by the
 * intent id. `skipped`: nothing was charged (Stripe not connected), so the
 * attempt is not consumed and the charge is tried again the next day.
 */
export function chargeResult(
  ctx: CrmContext,
  input: {
    orderId: string;
    attempt: number;
    intentId: string | null;
    status: 'succeeded' | 'processing' | 'failed' | 'skipped';
    amountReceived: number;
    failureMessage: string | null;
  },
): { recorded: boolean } {
  const order = getOrderRow(ctx, input.orderId);
  const now = ctx.now();
  if (order.status === 'paid' || order.status === 'cancelled' || order.status === 'refunded') {
    ctx.db.run(`UPDATE crm_orders SET next_charge_at = NULL WHERE id = ?`, order.id);
    return { recorded: false };
  }
  if (input.status === 'skipped') {
    ctx.db.run(`UPDATE crm_orders SET next_charge_at = ? WHERE id = ?`, now + PROCESSING_RECHECK_MS, order.id);
    return { recorded: false };
  }
  if (input.status === 'processing') {
    ctx.db.run(
      `UPDATE crm_orders SET auto_charge_attempts = ?, next_charge_at = ? WHERE id = ?`,
      input.attempt,
      now + PROCESSING_RECHECK_MS,
      order.id,
    );
    return { recorded: false };
  }
  if (input.status === 'succeeded') {
    const balance = order.total_minor - order.paid_minor;
    recordPayment(ctx, {
      orderId: order.id,
      data: {
        amount_minor: Math.min(input.amountReceived, balance),
        method: 'card',
        status: 'succeeded',
        ...(input.intentId === null ? {} : { transaction_id: input.intentId }),
      },
    });
    ctx.db.run(
      `UPDATE crm_orders SET auto_charge_attempts = ?, next_charge_at = NULL WHERE id = ?`,
      input.attempt,
      order.id,
    );
    return { recorded: true };
  }
  recordPayment(ctx, {
    orderId: order.id,
    data: {
      amount_minor: order.total_minor - order.paid_minor,
      method: 'card',
      status: 'failed',
      failure_reason: (input.failureMessage ?? 'card declined').slice(0, 500),
      ...(input.intentId === null ? {} : { transaction_id: input.intentId }),
    },
  });
  const delay = RETRY_DELAYS_MS[input.attempt - 1];
  ctx.db.run(
    `UPDATE crm_orders SET auto_charge_attempts = ?, next_charge_at = ? WHERE id = ?`,
    input.attempt,
    delay === undefined ? null : now + delay,
    order.id,
  );
  return { recorded: true };
}

// ------------------------------------------------------------------- webhooks

export type StripeEventInput =
  | {
      type: 'intent';
      intent: IntentFacts;
      metadata: Record<string, string>;
    }
  | {
      type: 'charge.refunded';
      chargeId: string;
      paymentIntentId: string | null;
      amountRefunded: number;
    };

/** A verified Stripe event, dispatched by the `amable_kind` metadata the intents carry. */
export function applyStripeEvent(ctx: CrmContext, input: StripeEventInput): { handled: boolean } {
  if (input.type === 'charge.refunded') return syncRefund(ctx, input);
  const { intent, metadata } = input;
  const succeeded = intent.status === 'succeeded';
  const failed = intent.status === 'requires_payment_method' || intent.status === 'canceled';
  switch (metadata['amable_kind']) {
    case 'checkout':
      settleCheckoutIntent(ctx, intent);
      return { handled: true };
    case 'offer': {
      const sessionId = metadata['amable_session'];
      const offerKey = metadata['amable_offer'];
      if (sessionId === undefined || offerKey === undefined || (!succeeded && !failed)) return { handled: false };
      settleOfferCharge(ctx, {
        sessionId,
        offerKey,
        orderId: metadata['amable_order'] ?? null,
        intentId: intent.intentId,
        status: succeeded ? 'succeeded' : 'failed',
        amountReceived: intent.amountReceived,
        message: intent.failureMessage,
      });
      return { handled: true };
    }
    case 'renewal': {
      const orderId = metadata['amable_order'];
      const attempt = Number(metadata['amable_attempt'] ?? '1');
      if (orderId === undefined || (!succeeded && !failed)) return { handled: false };
      chargeResult(ctx, {
        orderId,
        attempt: Number.isFinite(attempt) ? attempt : 1,
        intentId: intent.intentId,
        status: succeeded ? 'succeeded' : 'failed',
        amountReceived: intent.amountReceived,
        failureMessage: intent.failureMessage,
      });
      return { handled: true };
    }
    default:
      return { handled: false };
  }
}

function syncRefund(
  ctx: CrmContext,
  input: { chargeId: string; paymentIntentId: string | null; amountRefunded: number },
): { handled: boolean } {
  if (input.paymentIntentId === null) return { handled: false };
  try {
    const { refund } = syncStripeRefund(ctx, { ...input, paymentIntentId: input.paymentIntentId, reason: 'Refunded in Stripe' });
    return { handled: refund !== null || stripePayment(ctx, input.paymentIntentId) !== undefined };
  } catch (error) {
    if (!(error instanceof CrmError)) throw error;
    return { handled: true };
  }
}

// -------------------------------------------------------------------- refunds

interface StripePaymentRow {
  id: string;
  order_id: string;
  amount_minor: number;
  refunded_minor: number;
  transaction_id: string;
}

const STRIPE_REFUND_PREFIX = 'stripe:';

/** Payments settled by a Stripe PaymentIntent (checkouts, offers, renewals). */
const STRIPE_PAYMENT_SQL = `status = 'succeeded' AND transaction_id LIKE 'pi\\_%' ESCAPE '\\'`;

function stripePayment(ctx: CrmContext, intentId: string): StripePaymentRow | undefined {
  return ctx.db.all<StripePaymentRow>(
    `SELECT id, order_id, amount_minor, refunded_minor, transaction_id FROM crm_payments
     WHERE transaction_id = ? AND ${STRIPE_PAYMENT_SQL}`,
    intentId,
  )[0];
}

/** What the CRM already recorded as refunded on Stripe for this payment (manual refunds excluded). */
function syncedFromStripe(ctx: CrmContext, paymentId: string): number {
  return (
    ctx.db.all<{ total: number | null }>(
      `SELECT SUM(amount_minor) AS total FROM crm_refunds WHERE payment_id = ? AND transaction_id LIKE ?`,
      paymentId,
      `${STRIPE_REFUND_PREFIX}%`,
    )[0]?.total ?? 0
  );
}

/**
 * Brings a payment in line with Stripe's cumulative refunded amount of its
 * charge. Both the CRM refund action and the `charge.refunded` webhook call
 * it, in any order: the transaction id `stripe:<charge>:<cumulative>` makes
 * the second call return the refund the first one recorded.
 */
export function syncStripeRefund(
  ctx: CrmContext,
  input: { chargeId: string; paymentIntentId: string; amountRefunded: number; reason: string | null },
): { refund: Refund | null } {
  const payment = stripePayment(ctx, input.paymentIntentId);
  if (payment === undefined) return { refund: null };
  const transactionId = `${STRIPE_REFUND_PREFIX}${input.chargeId}:${String(input.amountRefunded)}`;
  const existing = ctx.db.all<{ id: string }>(`SELECT id FROM crm_refunds WHERE transaction_id = ?`, transactionId)[0];
  if (existing !== undefined) return { refund: getRefund(ctx, { id: existing.id }) };
  const delta = Math.min(input.amountRefunded - syncedFromStripe(ctx, payment.id), payment.amount_minor - payment.refunded_minor);
  if (delta <= 0) return { refund: null };
  return {
    refund: recordRefund(ctx, {
      orderId: payment.order_id,
      data: {
        payment_id: payment.id,
        amount_minor: delta,
        ...(input.reason === null ? {} : { reason: input.reason }),
        transaction_id: transactionId,
      },
    }),
  };
}

export interface StripeRefundPlan {
  orderNumber: string;
  currency: string;
  /** One Stripe refund per payment, newest payment first. */
  parts: Array<{ paymentId: string; paymentIntentId: string; amountMinor: number; refundedMinor: number }>;
}

/**
 * Splits a CRM refund across the order's Stripe payments with the same rules
 * as `refunds.record` (whole refundable amount by default, or one payment).
 * Payments recorded by hand cannot be refunded on Stripe.
 */
export function stripeRefundPlan(
  ctx: CrmContext,
  input: { orderId: string; paymentId: string | null; amountMinor: number | null },
): StripeRefundPlan {
  const order = getOrderRow(ctx, input.orderId);
  const payments = ctx.db.all<StripePaymentRow>(
    `SELECT id, order_id, amount_minor, refunded_minor, transaction_id FROM crm_payments
     WHERE order_id = ? AND ${STRIPE_PAYMENT_SQL} AND amount_minor > refunded_minor ORDER BY paid_at DESC, id DESC`,
    order.id,
  );
  let targets = payments;
  if (input.paymentId !== null) {
    const payment = payments.find((p) => p.id === input.paymentId);
    if (payment === undefined) {
      throw invalid('payment_id', 'this payment was not made with Stripe or has nothing left to refund');
    }
    targets = [payment];
  }
  const available = Math.min(
    order.paid_minor - order.refunded_minor,
    targets.reduce((sum, p) => sum + p.amount_minor - p.refunded_minor, 0),
  );
  if (available <= 0) throw new CrmError('conflict', `order ${order.number} has nothing to refund on Stripe`);
  const amount = input.amountMinor ?? available;
  if (amount > available) throw invalid('amount_minor', `amount exceeds the ${String(available)} refundable on Stripe`);
  const parts: StripeRefundPlan['parts'] = [];
  let left = amount;
  for (const p of targets) {
    if (left === 0) break;
    const share = Math.min(left, p.amount_minor - p.refunded_minor);
    parts.push({ paymentId: p.id, paymentIntentId: p.transaction_id, amountMinor: share, refundedMinor: p.refunded_minor });
    left -= share;
  }
  return { orderNumber: order.number, currency: order.currency, parts };
}
