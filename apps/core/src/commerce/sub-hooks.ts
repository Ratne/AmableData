import type { CrmContext } from '../crm/context';
import { emit } from '../crm/events';
import { getSubscriptionRow, subscriptionFacts, type OrderRow } from './rows';

/** True when an earlier billing period of the same subscription was already invoiced. */
export function isRenewalOrder(ctx: CrmContext, order: OrderRow): boolean {
  if (order.subscription_id === null || order.billing_period_start === null) return false;
  return (
    ctx.db.all(
      `SELECT 1 FROM crm_orders WHERE subscription_id = ? AND billing_period_start < ?
         AND deleted_at IS NULL LIMIT 1`,
      order.subscription_id,
      order.billing_period_start,
    ).length > 0
  );
}

/**
 * A subscription order became fully paid: a past_due subscription is active
 * again, and the first paid order after a trial converts the trial.
 */
export function onSubscriptionOrderPaid(ctx: CrmContext, order: OrderRow): void {
  if (order.subscription_id === null) return;
  const sub = getSubscriptionRow(ctx, order.subscription_id);
  const now = ctx.now();
  if (sub.status === 'past_due') {
    const unpaid = ctx.db.all(
      `SELECT 1 FROM crm_orders WHERE subscription_id = ? AND id <> ? AND deleted_at IS NULL
         AND status IN ('unpaid', 'partially_paid') AND due_at IS NOT NULL AND due_at < ? LIMIT 1`,
      sub.id,
      order.id,
      now,
    );
    if (unpaid.length === 0) {
      ctx.db.run(
        `UPDATE crm_subscriptions SET status = 'active', updated_at = ? WHERE id = ?`,
        now,
        sub.id,
      );
    }
  }
  if (
    sub.trial_ends_at !== null &&
    sub.trial_converted_at === null &&
    !isRenewalOrder(ctx, order)
  ) {
    ctx.db.run(
      `UPDATE crm_subscriptions SET trial_converted_at = ?, updated_at = ? WHERE id = ?`,
      now,
      now,
      sub.id,
    );
    emit(ctx, 'subscription.trial_converted', { ...subscriptionFacts(sub), orderId: order.id });
  }
}

/** A charge for a subscription order failed: the subscription becomes past_due. */
export function onSubscriptionPaymentFailed(ctx: CrmContext, order: OrderRow): void {
  if (order.subscription_id === null) return;
  const sub = getSubscriptionRow(ctx, order.subscription_id);
  if (sub.status !== 'active' && sub.status !== 'trialing') return;
  ctx.db.run(
    `UPDATE crm_subscriptions SET status = 'past_due', updated_at = ? WHERE id = ?`,
    ctx.now(),
    sub.id,
  );
  emit(ctx, 'subscription.past_due', {
    ...subscriptionFacts({ ...sub, status: 'past_due' }),
    orderId: order.id,
  });
}
