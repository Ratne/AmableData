/**
 * Subscription revenue math (MRR, ARR, churn) over subscription facts. Money is
 * integer minor units; each subscription's monthly amount is rounded half-up
 * once, then summed (so totals always equal the sum of the parts).
 *
 * - A subscription contributes MRR from the end of its trial (or its start)
 *   until `ended_at`; a currently paused one stops contributing at `paused_at`.
 * - Churn of a window: subscriptions that ended inside it after contributing
 *   (trials cancelled before converting are not churn).
 * - churn rate = churned / active at window start; revenue churn = churned MRR
 *   / MRR at window start.
 */

export type BillingInterval = 'day' | 'week' | 'month' | 'year';

export interface SubscriptionFact {
  id: string;
  plan_id: string;
  product_id: string;
  status: string;
  quantity: number;
  unit_price_minor: number;
  interval: BillingInterval;
  interval_count: number;
  started_at: number;
  trial_ends_at: number | null;
  paused_at: number | null;
  ended_at: number | null;
}

/** Monthly-normalized amount (minor units, half-up). */
export function monthlyMinor(
  sub: Pick<SubscriptionFact, 'quantity' | 'unit_price_minor' | 'interval' | 'interval_count'>,
): number {
  const amount = sub.unit_price_minor * sub.quantity;
  const count = Math.max(1, sub.interval_count);
  const [num, den] =
    sub.interval === 'month'
      ? [1, count]
      : sub.interval === 'year'
        ? [1, 12 * count]
        : sub.interval === 'week'
          ? [52, 12 * count]
          : [365, 12 * count];
  if (amount <= 0) return 0;
  return Math.floor((amount * num * 2 + den) / (2 * den));
}

/** Instant the subscription starts producing recurring revenue. */
export function revenueStart(sub: SubscriptionFact): number {
  return sub.trial_ends_at !== null && sub.trial_ends_at > sub.started_at
    ? sub.trial_ends_at
    : sub.started_at;
}

/** End of the contribution (exclusive), or null when still contributing. */
export function revenueEnd(sub: SubscriptionFact): number | null {
  const pausedEnd = sub.status === 'paused' && sub.paused_at !== null ? sub.paused_at : null;
  if (sub.ended_at === null) return pausedEnd;
  return pausedEnd === null ? sub.ended_at : Math.min(pausedEnd, sub.ended_at);
}

export function contributesAt(sub: SubscriptionFact, t: number): boolean {
  const start = revenueStart(sub);
  const end = revenueEnd(sub);
  return start <= t && (end === null || end > t);
}

export interface MrrSnapshot {
  mrr: number;
  active: number;
}

export function mrrAt(subs: readonly SubscriptionFact[], t: number): MrrSnapshot {
  let mrr = 0;
  let active = 0;
  for (const sub of subs) {
    if (!contributesAt(sub, t)) continue;
    mrr += monthlyMinor(sub);
    active += 1;
  }
  return { mrr, active };
}

export interface WindowStats {
  /** MRR and subscriptions at the window end (last instant). */
  mrr: number;
  active: number;
  active_start: number;
  mrr_start: number;
  new: number;
  new_mrr: number;
  churned: number;
  churned_mrr: number;
}

/** Stats of the half-open window `[from, to)`. */
export function windowStats(
  subs: readonly SubscriptionFact[],
  from: number,
  to: number,
): WindowStats {
  const start = mrrAt(subs, from - 1);
  const end = mrrAt(subs, to - 1);
  let added = 0;
  let addedMrr = 0;
  let churned = 0;
  let churnedMrr = 0;
  for (const sub of subs) {
    const rs = revenueStart(sub);
    const ended = sub.ended_at;
    if (rs >= from && rs < to && (ended === null || ended > rs)) {
      added += 1;
      addedMrr += monthlyMinor(sub);
    }
    if (ended !== null && ended >= from && ended < to && rs < ended) {
      churned += 1;
      churnedMrr += monthlyMinor(sub);
    }
  }
  return {
    mrr: end.mrr,
    active: end.active,
    active_start: start.active,
    mrr_start: start.mrr,
    new: added,
    new_mrr: addedMrr,
    churned,
    churned_mrr: churnedMrr,
  };
}
