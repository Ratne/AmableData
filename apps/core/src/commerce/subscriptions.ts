import type {
  BillingRunResult,
  CancelSubscriptionInput,
  ChangePlanInput,
  CreateSubscriptionInput,
  ListSubscriptionsQuery,
  Page,
  Subscription,
} from '@amable/api-types';
import type { CrmContext } from '../crm/context';
import type { SqlDb } from '../crm/db/sql';
import { CrmError, invalid } from '../crm/errors';
import { emit } from '../crm/events';
import { assertRef } from '../crm/refs';
import { decodeCursor, encodeCursor, parseIsoMs, toIso } from '../crm/util';
import { getPlanRow, getProductRow } from './catalog';
import { addInterval, periodDays, type DiscountRule } from './money';
import { createOrderRow } from './orders';
import { getSubscriptionRow, subscriptionFacts, type OrderRow, type SubscriptionRow } from './rows';

const DAY_MS = 86_400_000;
/** Statuses the billing job generates orders for. */
const BILLABLE = `('active', 'trialing', 'past_due')`;
/** Safety bound when catching up many missed periods of one subscription. */
const MAX_PERIODS_PER_RUN = 36;
const MAX_SUBSCRIPTIONS_PER_RUN = 200;

function toApi(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    contact_id: row.contact_id,
    product_id: row.product_id,
    plan_id: row.plan_id,
    status: row.status,
    quantity: row.quantity,
    unit_price_minor: row.unit_price_minor,
    amount_minor: row.unit_price_minor * row.quantity,
    currency: row.currency,
    interval: row.interval,
    interval_count: row.interval_count,
    tax_rate_bps: row.tax_rate_bps,
    started_at: toIso(row.started_at),
    trial_ends_at: toIso(row.trial_ends_at),
    current_period_start: toIso(row.current_period_start),
    current_period_end: toIso(row.current_period_end),
    next_bill_at: toIso(row.next_bill_at),
    cancel_at_period_end: row.cancel_at_period_end === 1,
    cancel_reason: row.cancel_reason,
    cancelled_at: toIso(row.cancelled_at),
    paused_at: toIso(row.paused_at),
    ended_at: toIso(row.ended_at),
    analytics_visitor_id: row.analytics_visitor_id,
    discount:
      row.discount_kind === null
        ? null
        : {
            promo_code: row.promo_code,
            kind: row.discount_kind,
            percent_bps: row.discount_percent_bps,
            amount_minor: row.discount_amount_minor,
            periods_left: row.discount_periods_left,
          },
    autopay: row.stripe_payment_method_id !== null,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

/** Promo discount the next renewal still gets. */
function renewalDiscount(sub: SubscriptionRow): { rule: DiscountRule; code: string | null } | undefined {
  if (sub.discount_kind === null) return undefined;
  if (sub.discount_periods_left !== null && sub.discount_periods_left <= 0) return undefined;
  return {
    rule: {
      kind: sub.discount_kind,
      percentBps: sub.discount_percent_bps,
      amountMinor: sub.discount_amount_minor,
    },
    code: sub.promo_code,
  };
}

export function getSubscription(ctx: CrmContext, input: { id: string }): Subscription {
  return toApi(getSubscriptionRow(ctx, input.id));
}

export function listSubscriptions(
  ctx: CrmContext,
  input: ListSubscriptionsQuery,
): Page<Subscription> {
  const before = input.cursor === undefined ? null : decodeCursor(input.cursor).id;
  const rows = ctx.db.all<SubscriptionRow>(
    `SELECT * FROM crm_subscriptions WHERE (? IS NULL OR status = ?) AND (? IS NULL OR contact_id = ?)
       AND (? IS NULL OR plan_id = ?) AND (? IS NULL OR product_id = ?) AND (? IS NULL OR id < ?)
     ORDER BY id DESC LIMIT ?`,
    input.status ?? null,
    input.status ?? null,
    input.contact_id ?? null,
    input.contact_id ?? null,
    input.plan_id ?? null,
    input.plan_id ?? null,
    input.product_id ?? null,
    input.product_id ?? null,
    before,
    before,
    input.limit + 1,
  );
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    data: page.map(toApi),
    next_cursor:
      rows.length > input.limit && last !== undefined
        ? encodeCursor({ v: null, id: last.id })
        : null,
  };
}

// ------------------------------------------------------------------ billing

/** Boundaries of the next period to bill: anchor + n intervals (no end-of-month drift). */
function nextPeriod(sub: SubscriptionRow): { start: number; end: number } {
  const n = sub.periods_billed * sub.interval_count;
  return {
    start: addInterval(sub.billing_anchor, sub.interval, n),
    end: addInterval(sub.billing_anchor, sub.interval, n + sub.interval_count),
  };
}

/**
 * Generates the order (and invoice) of the subscription's next period and
 * advances the schedule. The unique (subscription_id, billing_period_start)
 * index makes a duplicate impossible even if a run is replayed.
 */
function billNextPeriod(ctx: CrmContext, sub: SubscriptionRow): OrderRow {
  const period = nextPeriod(sub);
  const product = getProductRow(ctx, sub.product_id);
  const plan = getPlanRow(ctx, sub.plan_id);
  const discount = renewalDiscount(sub);
  const order = createOrderRow(
    ctx,
    {
      contact_id: sub.contact_id,
      currency: sub.currency,
      items: [],
      order_date: new Date(period.start).toISOString(),
      analytics_visitor_id: sub.analytics_visitor_id,
    },
    {
      source: 'subscription',
      subscriptionId: sub.id,
      billingPeriod: period,
      dueAt: period.start,
      ...(discount === undefined ? {} : { discount }),
      lines: [
        {
          productId: product.id,
          planId: plan.id,
          name: `${product.name} — ${plan.name}`,
          sku: product.sku,
          description: null,
          quantity: sub.quantity,
          unitPriceMinor: sub.unit_price_minor,
          taxRateBps: sub.tax_rate_bps,
        },
      ],
    },
  );
  ctx.db.run(
    `UPDATE crm_subscriptions SET status = CASE WHEN status = 'trialing' THEN 'active' ELSE status END,
       periods_billed = periods_billed + 1, current_period_start = ?, current_period_end = ?, next_bill_at = ?,
       updated_at = ? WHERE id = ?`,
    period.start,
    period.end,
    period.end,
    ctx.now(),
    sub.id,
  );
  if (discount !== undefined && sub.discount_periods_left !== null) {
    const left = sub.discount_periods_left - 1;
    ctx.db.run(
      `UPDATE crm_subscriptions SET discount_periods_left = ?, discount_kind = CASE WHEN ? <= 0 THEN NULL ELSE discount_kind END
       WHERE id = ?`,
      left,
      left,
      sub.id,
    );
  }
  if (sub.stripe_payment_method_id !== null && order.total_minor > 0) {
    // Charged on the saved card by the TenantDb alarm.
    ctx.db.run(`UPDATE crm_orders SET next_charge_at = ? WHERE id = ?`, Math.max(period.start, ctx.now()), order.id);
  }
  return order;
}

function endSubscription(
  ctx: CrmContext,
  sub: SubscriptionRow,
  at: number,
  reason: 'cancelled' | 'period_end',
): void {
  ctx.db.run(
    `UPDATE crm_subscriptions SET status = 'cancelled', ended_at = ?, next_bill_at = NULL,
       cancelled_at = IFNULL(cancelled_at, ?), cancel_at_period_end = 0, updated_at = ? WHERE id = ?`,
    at,
    ctx.now(),
    ctx.now(),
    sub.id,
  );
  emit(ctx, 'subscription.ended', { ...subscriptionFacts(sub), reason });
}

interface RunTally {
  processed: number;
  renewals: number;
  ended: number;
  trials_ended: number;
}

/** Bills every period of one subscription that is due at `now`. */
function processDue(ctx: CrmContext, id: string, now: number, tally: RunTally): void {
  tally.processed += 1;
  for (let i = 0; i < MAX_PERIODS_PER_RUN; i += 1) {
    const sub = getSubscriptionRow(ctx, id);
    if (sub.next_bill_at === null || sub.next_bill_at > now) return;
    if (sub.status !== 'active' && sub.status !== 'trialing' && sub.status !== 'past_due') return;
    if (sub.cancel_at_period_end === 1) {
      endSubscription(ctx, sub, sub.next_bill_at, 'period_end');
      tally.ended += 1;
      return;
    }
    const wasTrial = sub.status === 'trialing';
    const order = billNextPeriod(ctx, sub);
    if (wasTrial) {
      tally.trials_ended += 1;
    } else {
      tally.renewals += 1;
      const after = getSubscriptionRow(ctx, id);
      emit(ctx, 'subscription.renewed', {
        ...subscriptionFacts(after),
        orderId: order.id,
        periodStart: toIso(order.billing_period_start ?? sub.next_bill_at),
        periodEnd: toIso(order.billing_period_end ?? sub.next_bill_at),
      });
    }
  }
}

/** Earliest pending bill date (null when nothing is billable). */
export function nextBillingDue(db: SqlDb): number | null {
  return (
    db.all<{ due: number | null }>(
      `SELECT MIN(next_bill_at) AS due FROM crm_subscriptions WHERE status IN ${BILLABLE}`,
    )[0]?.due ?? null
  );
}

/**
 * Billing automation: for every subscription whose `next_bill_at` has passed,
 * generate the renewal order + invoice (unpaid, due on the period start) and
 * emit `subscription.renewed`, end subscriptions scheduled to cancel, and turn
 * finished trials into their first paid period. Payments arrive later via the
 * API (there is no gateway); a failed one moves the subscription to past_due.
 * Driven by the TenantDb alarm; safe to run any number of times.
 */
export function runBilling(ctx: CrmContext, _input: Record<string, never> = {}): BillingRunResult {
  const now = ctx.now();
  const tally: RunTally = { processed: 0, renewals: 0, ended: 0, trials_ended: 0 };
  const due = ctx.db.all<{ id: string }>(
    `SELECT id FROM crm_subscriptions WHERE status IN ${BILLABLE} AND next_bill_at <= ?
     ORDER BY next_bill_at, id LIMIT ?`,
    now,
    MAX_SUBSCRIPTIONS_PER_RUN,
  );
  for (const { id } of due) processDue(ctx, id, now, tally);
  return { ...tally, next_due_at: toIso(nextBillingDue(ctx.db)) };
}

// ---------------------------------------------------------------- lifecycle

/**
 * Starts a subscription on a plan. With a trial (plan default or override)
 * nothing is billed until the trial ends; otherwise the first period's order
 * is generated immediately.
 */
export function createSubscription(ctx: CrmContext, input: CreateSubscriptionInput): Subscription {
  assertRef(ctx, 'contact', input.contact_id, 'contact_id');
  let plan;
  try {
    plan = getPlanRow(ctx, input.plan_id);
  } catch {
    throw invalid('plan_id', `plan ${input.plan_id} not found`);
  }
  if (plan.active !== 1) throw invalid('plan_id', `plan ${plan.name} is not active`);
  const product = getProductRow(ctx, plan.product_id);
  const now = ctx.now();
  const start = input.start_at === undefined ? now : parseIsoMs(input.start_at, 'start_at');
  const trialDays = input.trial_days ?? plan.trial_days;
  const trialEnds = trialDays > 0 ? start + trialDays * DAY_MS : null;
  const id = ctx.newId();
  ctx.db.run(
    `INSERT INTO crm_subscriptions (id, contact_id, product_id, plan_id, status, quantity, unit_price_minor,
       currency, interval, interval_count, tax_rate_bps, started_at, trial_ends_at, current_period_start,
       current_period_end, next_bill_at, billing_anchor, periods_billed, analytics_visitor_id, created_by,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    id,
    input.contact_id,
    product.id,
    plan.id,
    trialEnds === null ? 'active' : 'trialing',
    input.quantity ?? 1,
    input.unit_price_minor ?? plan.price_minor,
    plan.currency,
    plan.interval,
    plan.interval_count,
    input.tax_rate_bps ?? product.tax_rate_bps,
    start,
    trialEnds,
    trialEnds === null ? null : start,
    trialEnds,
    trialEnds ?? start,
    trialEnds ?? start,
    input.analytics_visitor_id ?? null,
    ctx.actor.id,
    now,
    now,
  );
  let orderId: string | null = null;
  if (trialEnds === null) orderId = billNextPeriod(ctx, getSubscriptionRow(ctx, id)).id;
  const sub = getSubscriptionRow(ctx, id);
  emit(ctx, 'subscription.started', {
    ...subscriptionFacts(sub),
    trial: trialEnds !== null,
    orderId,
  });
  if (trialEnds !== null) {
    emit(ctx, 'subscription.trial_started', {
      ...subscriptionFacts(sub),
      trialEndsAt: toIso(trialEnds),
    });
  }
  // A back-dated start catches up on every period already elapsed.
  processDue(ctx, id, now, { processed: 0, renewals: 0, ended: 0, trials_ended: 0 });
  return getSubscription(ctx, { id });
}

export interface CheckoutSubscriptionInput {
  contactId: string;
  planId: string;
  quantity: number;
  unitPriceMinor: number;
  /** Paid checkout order holding the first period (null with a trial: nothing billed yet). */
  firstOrderId: string | null;
  discount: {
    promoId: string;
    code: string;
    rule: DiscountRule;
    /** Renewals still discounted (null = all). */
    periodsLeft: number | null;
  } | null;
  stripeCustomerId: string | null;
  stripePaymentMethodId: string | null;
  visitorId: string | null;
}

/**
 * Subscription bought on a checkout. Without a trial the first period was
 * paid with the checkout order (linked to the subscription as its period 1);
 * with a trial nothing is billed until it ends. Renewals are charged on the
 * saved payment method.
 */
export function startCheckoutSubscription(ctx: CrmContext, input: CheckoutSubscriptionInput): SubscriptionRow {
  const plan = getPlanRow(ctx, input.planId);
  const product = getProductRow(ctx, plan.product_id);
  const now = ctx.now();
  const trialEnds = plan.trial_days > 0 ? now + plan.trial_days * DAY_MS : null;
  const firstEnd = addInterval(now, plan.interval, plan.interval_count);
  const billed = trialEnds === null && input.firstOrderId !== null;
  const id = ctx.newId();
  ctx.db.run(
    `INSERT INTO crm_subscriptions (id, contact_id, product_id, plan_id, status, quantity, unit_price_minor,
       currency, interval, interval_count, tax_rate_bps, started_at, trial_ends_at, current_period_start,
       current_period_end, next_bill_at, billing_anchor, periods_billed, analytics_visitor_id, promo_code_id,
       promo_code, discount_kind, discount_percent_bps, discount_amount_minor, discount_periods_left,
       stripe_customer_id, stripe_payment_method_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.contactId,
    product.id,
    plan.id,
    trialEnds === null ? 'active' : 'trialing',
    input.quantity,
    input.unitPriceMinor,
    plan.currency,
    plan.interval,
    plan.interval_count,
    product.tax_rate_bps,
    now,
    trialEnds,
    billed ? now : trialEnds === null ? null : now,
    billed ? firstEnd : trialEnds,
    billed ? firstEnd : (trialEnds ?? now),
    trialEnds ?? now,
    billed ? 1 : 0,
    input.visitorId,
    input.discount?.promoId ?? null,
    input.discount?.code ?? null,
    input.discount?.rule.kind ?? null,
    input.discount?.rule.percentBps ?? null,
    input.discount?.rule.amountMinor ?? null,
    input.discount?.periodsLeft ?? null,
    input.stripeCustomerId,
    input.stripePaymentMethodId,
    ctx.actor.id,
    now,
    now,
  );
  if (billed && input.firstOrderId !== null) {
    ctx.db.run(
      `UPDATE crm_orders SET subscription_id = ?, billing_period_start = ?, billing_period_end = ?, updated_at = ?
       WHERE id = ?`,
      id,
      now,
      firstEnd,
      now,
      input.firstOrderId,
    );
  }
  const sub = getSubscriptionRow(ctx, id);
  emit(ctx, 'subscription.started', {
    ...subscriptionFacts(sub),
    trial: trialEnds !== null,
    orderId: billed ? input.firstOrderId : null,
  });
  if (trialEnds !== null) {
    emit(ctx, 'subscription.trial_started', { ...subscriptionFacts(sub), trialEndsAt: toIso(trialEnds) });
  }
  return sub;
}

/** Earliest automatic charge of a renewal order on a saved payment method. */
export function nextChargeDue(db: SqlDb): number | null {
  return (
    db.all<{ due: number | null }>(
      `SELECT MIN(next_charge_at) AS due FROM crm_orders WHERE next_charge_at IS NOT NULL AND deleted_at IS NULL`,
    )[0]?.due ?? null
  );
}

/**
 * Cancels at the end of the current period (default: `subscription.cancel_scheduled`,
 * then `subscription.ended` from the billing job) or immediately (`subscription.ended`).
 */
export function cancelSubscription(
  ctx: CrmContext,
  input: { id: string; data: CancelSubscriptionInput },
): Subscription {
  const sub = getSubscriptionRow(ctx, input.id);
  if (sub.status === 'cancelled')
    throw new CrmError('conflict', 'subscription is already cancelled');
  const atPeriodEnd = input.data.at_period_end ?? true;
  const now = ctx.now();
  ctx.db.run(
    `UPDATE crm_subscriptions SET cancel_reason = ?, updated_at = ? WHERE id = ?`,
    input.data.reason ?? sub.cancel_reason,
    now,
    sub.id,
  );
  if (atPeriodEnd && sub.status !== 'paused' && sub.next_bill_at !== null) {
    if (sub.cancel_at_period_end === 1) return getSubscription(ctx, { id: sub.id });
    ctx.db.run(
      `UPDATE crm_subscriptions SET cancel_at_period_end = 1, cancelled_at = ? WHERE id = ?`,
      now,
      sub.id,
    );
    emit(ctx, 'subscription.cancel_scheduled', {
      ...subscriptionFacts(sub),
      endsAt: toIso(sub.next_bill_at),
    });
  } else {
    endSubscription(ctx, sub, now, 'cancelled');
  }
  return getSubscription(ctx, { id: sub.id });
}

/** Pauses billing (no orders while paused). Trials cannot be paused. */
export function pauseSubscription(ctx: CrmContext, input: { id: string }): Subscription {
  const sub = getSubscriptionRow(ctx, input.id);
  if (sub.status !== 'active' && sub.status !== 'past_due') {
    throw new CrmError('conflict', `a ${sub.status} subscription cannot be paused`);
  }
  const now = ctx.now();
  ctx.db.run(
    `UPDATE crm_subscriptions SET status = 'paused', paused_at = ?, next_bill_at = NULL,
       cancel_at_period_end = 0, updated_at = ? WHERE id = ?`,
    now,
    now,
    sub.id,
  );
  emit(ctx, 'subscription.paused', subscriptionFacts(sub));
  return getSubscription(ctx, { id: sub.id });
}

/**
 * Reactivates a paused subscription (billing restarts at the end of the
 * already-billed period, or now) or withdraws a scheduled cancellation.
 */
export function resumeSubscription(ctx: CrmContext, input: { id: string }): Subscription {
  const sub = getSubscriptionRow(ctx, input.id);
  const now = ctx.now();
  if (sub.status === 'paused') {
    const restart = Math.max(now, sub.current_period_end ?? now);
    ctx.db.run(
      `UPDATE crm_subscriptions SET status = 'active', paused_at = NULL, billing_anchor = ?, periods_billed = 0,
         next_bill_at = ?, updated_at = ? WHERE id = ?`,
      restart,
      restart,
      now,
      sub.id,
    );
    emit(ctx, 'subscription.reactivated', { ...subscriptionFacts(sub), from: 'paused' });
    processDue(ctx, sub.id, now, { processed: 0, renewals: 0, ended: 0, trials_ended: 0 });
  } else if (sub.cancel_at_period_end === 1) {
    ctx.db.run(
      `UPDATE crm_subscriptions SET cancel_at_period_end = 0, cancelled_at = NULL, cancel_reason = NULL,
         updated_at = ? WHERE id = ?`,
      now,
      sub.id,
    );
    emit(ctx, 'subscription.reactivated', { ...subscriptionFacts(sub), from: 'cancel_scheduled' });
  } else {
    throw new CrmError('conflict', 'subscription is neither paused nor scheduled for cancellation');
  }
  return getSubscription(ctx, { id: sub.id });
}

/**
 * Switches plan (and optionally quantity/price) from the next billing period on;
 * no proration. Emits `subscription.upgraded` / `downgraded` comparing the
 * price per day of the old and new terms.
 */
export function changeSubscriptionPlan(
  ctx: CrmContext,
  input: { id: string; data: ChangePlanInput },
): Subscription {
  const sub = getSubscriptionRow(ctx, input.id);
  if (sub.status === 'cancelled') throw new CrmError('conflict', 'subscription is cancelled');
  let plan;
  try {
    plan = getPlanRow(ctx, input.data.plan_id);
  } catch {
    throw invalid('plan_id', `plan ${input.data.plan_id} not found`);
  }
  if (plan.active !== 1) throw invalid('plan_id', `plan ${plan.name} is not active`);
  if (plan.currency !== sub.currency) {
    throw invalid(
      'plan_id',
      `plan is priced in ${plan.currency}, the subscription in ${sub.currency}`,
    );
  }
  const product = getProductRow(ctx, plan.product_id);
  const quantity = input.data.quantity ?? sub.quantity;
  const unitPrice = input.data.unit_price_minor ?? plan.price_minor;
  const oldAmount = sub.unit_price_minor * sub.quantity;
  const newAmount = unitPrice * quantity;
  const oldRate = oldAmount / periodDays(sub.interval, sub.interval_count);
  const newRate = newAmount / periodDays(plan.interval, plan.interval_count);
  const intervalChanged =
    plan.interval !== sub.interval || plan.interval_count !== sub.interval_count;
  const now = ctx.now();
  const anchor = sub.next_bill_at ?? sub.current_period_end ?? now;
  ctx.db.run(
    `UPDATE crm_subscriptions SET plan_id = ?, product_id = ?, quantity = ?, unit_price_minor = ?, interval = ?,
       interval_count = ?, tax_rate_bps = ?, billing_anchor = ?, periods_billed = ?, updated_at = ? WHERE id = ?`,
    plan.id,
    product.id,
    quantity,
    unitPrice,
    plan.interval,
    plan.interval_count,
    product.tax_rate_bps,
    intervalChanged ? anchor : sub.billing_anchor,
    intervalChanged ? 0 : sub.periods_billed,
    now,
    sub.id,
  );
  const after = getSubscriptionRow(ctx, sub.id);
  const change = {
    ...subscriptionFacts(after),
    fromPlanId: sub.plan_id,
    fromAmountMinor: oldAmount,
  };
  if (newRate > oldRate) emit(ctx, 'subscription.upgraded', change);
  else if (newRate < oldRate) emit(ctx, 'subscription.downgraded', change);
  return getSubscription(ctx, { id: sub.id });
}
