import { describe, expect, it } from 'vitest';
import { commerceWorld, DAY, eventsOf, failure, type CommerceWorld } from './helpers';

const subOrders = (w: CommerceWorld, subscriptionId: string) =>
  w.t
    .op('orders.list', { limit: 100, subscription_id: subscriptionId })
    .data.sort((a, b) => a.order_date.localeCompare(b.order_date));

const payAll = (w: CommerceWorld, subscriptionId: string) => {
  for (const order of subOrders(w, subscriptionId)) {
    if (order.status === 'unpaid') {
      w.t.op('payments.record', {
        orderId: order.id,
        data: { amount_minor: order.total_minor, method: 'card' },
      });
    }
  }
};

describe('subscriptions and billing automation', () => {
  it('bills the first period at once and renews on each due date, replay-safe', () => {
    const w = commerceWorld();
    const start = w.t.clock.now;
    const sub = w.t.op('subscriptions.create', {
      contact_id: w.contactId,
      plan_id: w.monthly,
      quantity: 2,
      analytics_visitor_id: 'v_sub',
    });
    expect(sub).toMatchObject({ status: 'active', amount_minor: 9_800, currency: 'EUR' });
    const first = subOrders(w, sub.id);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      source: 'subscription',
      subtotal_minor: 9_800,
      tax_minor: 2_156,
      total_minor: 11_956,
      analytics_visitor_id: 'v_sub',
      items: [{ name: 'CRM Pro — Monthly', quantity: 2, plan_id: w.monthly }],
    });
    expect(first[0]?.invoice).not.toBeNull();
    expect(Date.parse(sub.next_bill_at ?? '')).toBe(Date.parse(first[0]?.billing_period_end ?? ''));
    const started = eventsOf(w.t, 'subscription.started')[0]?.payload;
    expect(started).toMatchObject({
      subscriptionId: sub.id,
      contactId: w.contactId,
      amountMinor: 9_800,
      currency: 'EUR',
      interval: 'month',
      intervalCount: 1,
      trial: false,
      orderId: first[0]?.id,
      visitorId: 'v_sub',
    });
    payAll(w, sub.id);
    expect(eventsOf(w.t, 'order.paid')[0]?.payload).toMatchObject({ renewal: false });

    // Nothing is due yet.
    expect(w.t.op('billing.run', {})).toMatchObject({ processed: 0, renewals: 0 });
    // One month later the job generates the renewal.
    w.t.clock.now = Date.parse(sub.next_bill_at ?? '') + 1000;
    const run = w.t.op('billing.run', {});
    expect(run).toMatchObject({ processed: 1, renewals: 1, ended: 0 });
    expect(w.t.op('billing.run', {})).toMatchObject({ processed: 0, renewals: 0 });
    const orders = subOrders(w, sub.id);
    expect(orders).toHaveLength(2);
    expect(orders[1]?.billing_period_start).toBe(orders[0]?.billing_period_end);
    expect(orders[1]?.status).toBe('unpaid');
    expect(orders[1]?.due_at).toBe(orders[1]?.billing_period_start);
    const renewed = eventsOf(w.t, 'subscription.renewed');
    expect(renewed).toHaveLength(1);
    expect(renewed[0]?.payload).toMatchObject({
      subscriptionId: sub.id,
      orderId: orders[1]?.id,
      periodStart: orders[1]?.billing_period_start,
      periodEnd: orders[1]?.billing_period_end,
      amountMinor: 9_800,
    });
    payAll(w, sub.id);
    expect(eventsOf(w.t, 'payment.recorded').at(-1)?.payload).toMatchObject({
      renewal: true,
      subscriptionId: sub.id,
    });
    expect(eventsOf(w.t, 'order.paid').at(-1)?.payload).toMatchObject({ renewal: true });

    // Missed periods are caught up in one run.
    w.t.clock.now = start + 120 * DAY;
    expect(w.t.op('billing.run', {}).renewals).toBe(2);
    expect(subOrders(w, sub.id)).toHaveLength(4);
    const current = w.t.op('subscriptions.get', { id: sub.id });
    expect(Date.parse(current.next_bill_at ?? '')).toBeGreaterThan(w.t.clock.now);
    expect(w.t.op('billing.run', {}).next_due_at).toBe(current.next_bill_at);
  });

  it('runs trials: nothing billed until the end, then converted when the first order is paid', () => {
    const w = commerceWorld();
    const sub = w.t.op('subscriptions.create', { contact_id: w.contactId, plan_id: w.trialPlan });
    expect(sub.status).toBe('trialing');
    expect(subOrders(w, sub.id)).toHaveLength(0);
    expect(
      eventsOf(w.t, 'subscription.started', 'subscription.trial_started').map((e) => e.type),
    ).toEqual(['subscription.started', 'subscription.trial_started']);
    expect(eventsOf(w.t, 'subscription.started')[0]?.payload).toMatchObject({
      trial: true,
      orderId: null,
    });
    w.t.clock.now = Date.parse(sub.trial_ends_at ?? '') + 1;
    expect(w.t.op('billing.run', {})).toMatchObject({ trials_ended: 1, renewals: 0 });
    const after = w.t.op('subscriptions.get', { id: sub.id });
    expect(after.status).toBe('active');
    expect(eventsOf(w.t, 'subscription.renewed')).toHaveLength(0);
    payAll(w, sub.id);
    const converted = eventsOf(w.t, 'subscription.trial_converted');
    expect(converted).toHaveLength(1);
    expect(converted[0]?.payload).toMatchObject({ subscriptionId: sub.id, amountMinor: 4_900 });
    // Later renewals do not convert again.
    w.t.clock.now = Date.parse(after.next_bill_at ?? '') + 1;
    w.t.op('billing.run', {});
    payAll(w, sub.id);
    expect(eventsOf(w.t, 'subscription.trial_converted')).toHaveLength(1);
  });

  it('records failed payments (past_due) and recovers when the order is paid', () => {
    const w = commerceWorld();
    const sub = w.t.op('subscriptions.create', { contact_id: w.contactId, plan_id: w.monthly });
    const order = subOrders(w, sub.id)[0];
    if (order === undefined) throw new Error('missing order');
    const failed = w.t.op('payments.record', {
      orderId: order.id,
      data: {
        amount_minor: order.total_minor,
        method: 'card',
        status: 'failed',
        failure_reason: 'card_declined',
      },
    });
    expect(failed.status).toBe('failed');
    expect(w.t.op('orders.get', { id: order.id })).toMatchObject({
      status: 'unpaid',
      paid_minor: 0,
    });
    expect(w.t.op('subscriptions.get', { id: sub.id }).status).toBe('past_due');
    expect(eventsOf(w.t, 'payment.failed', 'subscription.past_due').map((e) => e.type)).toEqual([
      'payment.failed',
      'subscription.past_due',
    ]);
    w.t.op('payments.record', {
      orderId: order.id,
      data: { amount_minor: order.total_minor, method: 'card' },
    });
    expect(w.t.op('subscriptions.get', { id: sub.id }).status).toBe('active');
  });

  it('cancels at period end (scheduled, withdrawable) or immediately', () => {
    const w = commerceWorld();
    const sub = w.t.op('subscriptions.create', { contact_id: w.contactId, plan_id: w.monthly });
    const scheduled = w.t.op('subscriptions.cancel', { id: sub.id, data: { reason: 'budget' } });
    expect(scheduled).toMatchObject({
      status: 'active',
      cancel_at_period_end: true,
      cancel_reason: 'budget',
    });
    expect(eventsOf(w.t, 'subscription.cancel_scheduled')[0]?.payload).toMatchObject({
      endsAt: sub.next_bill_at,
    });
    const resumeAt = w.t.clock.now;
    const resumed = w.t.op('subscriptions.resume', { id: sub.id });
    expect(resumed.cancel_at_period_end).toBe(false);
    expect(eventsOf(w.t, 'subscription.reactivated')[0]?.payload).toMatchObject({
      from: 'cancel_scheduled',
    });
    w.t.op('subscriptions.cancel', { id: sub.id, data: {} });
    w.t.clock.now = Date.parse(sub.next_bill_at ?? '') + 1;
    expect(w.t.op('billing.run', {})).toMatchObject({ ended: 1, renewals: 0 });
    const ended = w.t.op('subscriptions.get', { id: sub.id });
    expect(ended).toMatchObject({
      status: 'cancelled',
      next_bill_at: null,
      ended_at: sub.next_bill_at,
    });
    expect(subOrders(w, sub.id)).toHaveLength(1);
    expect(eventsOf(w.t, 'subscription.ended')[0]?.payload).toMatchObject({ reason: 'period_end' });
    expect(failure(() => w.t.op('subscriptions.cancel', { id: sub.id, data: {} })).code).toBe(
      'conflict',
    );

    const now = w.t.op('subscriptions.create', {
      contact_id: w.otherContactId,
      plan_id: w.monthly,
    });
    const gone = w.t.op('subscriptions.cancel', { id: now.id, data: { at_period_end: false } });
    expect(gone.status).toBe('cancelled');
    expect(eventsOf(w.t, 'subscription.ended').at(-1)?.payload).toMatchObject({
      reason: 'cancelled',
    });
  });

  it('pauses billing and resumes after the paid period', () => {
    const w = commerceWorld();
    const sub = w.t.op('subscriptions.create', { contact_id: w.contactId, plan_id: w.monthly });
    const paused = w.t.op('subscriptions.pause', { id: sub.id });
    expect(paused).toMatchObject({ status: 'paused', next_bill_at: null });
    w.t.clock.now += 90 * DAY;
    expect(w.t.op('billing.run', {}).processed).toBe(0);
    expect(subOrders(w, sub.id)).toHaveLength(1);
    const resumeAt = w.t.clock.now;
    const resumed = w.t.op('subscriptions.resume', { id: sub.id });
    expect(resumed.status).toBe('active');
    // The paid period is long over: the next period starts (and is billed) now.
    const orders = subOrders(w, sub.id);
    expect(orders).toHaveLength(2);
    expect(Date.parse(orders[1]?.billing_period_start ?? '')).toBeGreaterThan(resumeAt);
    expect(
      eventsOf(w.t, 'subscription.paused', 'subscription.reactivated').map((e) => e.type),
    ).toEqual(['subscription.paused', 'subscription.reactivated']);
    expect(failure(() => w.t.op('subscriptions.resume', { id: sub.id })).code).toBe('conflict');
  });

  it('changes plan from the next period and classifies upgrades and downgrades', () => {
    const w = commerceWorld();
    const sub = w.t.op('subscriptions.create', { contact_id: w.contactId, plan_id: w.monthly });
    const yearly = w.t.op('subscriptions.changePlan', { id: sub.id, data: { plan_id: w.yearly } });
    expect(yearly).toMatchObject({ plan_id: w.yearly, interval: 'year', amount_minor: 49_000 });
    // 49000/year is cheaper per day than 4900/month.
    expect(eventsOf(w.t, 'subscription.downgraded')[0]?.payload).toMatchObject({
      fromPlanId: w.monthly,
      fromAmountMinor: 4_900,
      planId: w.yearly,
      amountMinor: 49_000,
    });
    w.t.op('subscriptions.changePlan', { id: sub.id, data: { plan_id: w.monthly, quantity: 3 } });
    expect(eventsOf(w.t, 'subscription.upgraded')).toHaveLength(1);
    w.t.op('subscriptions.changePlan', { id: sub.id, data: { plan_id: w.yearly, quantity: 1 } });
    // The next period is billed on the old due date with the new terms.
    w.t.clock.now = Date.parse(sub.next_bill_at ?? '') + 1;
    w.t.op('billing.run', {});
    const renewal = subOrders(w, sub.id)[1];
    expect(renewal?.billing_period_start).toBe(sub.next_bill_at);
    expect(renewal?.subtotal_minor).toBe(49_000);
    const days =
      (Date.parse(renewal?.billing_period_end ?? '') -
        Date.parse(renewal?.billing_period_start ?? '')) /
      DAY;
    expect(days).toBeGreaterThanOrEqual(365);
  });

  it('back-dates a subscription and anchors month-end periods without drift', () => {
    const w = commerceWorld();
    w.t.clock.now = Date.UTC(2026, 4, 15);
    const sub = w.t.op('subscriptions.create', {
      contact_id: w.contactId,
      plan_id: w.monthly,
      start_at: '2026-01-31T10:00:00.000Z',
    });
    const periods = subOrders(w, sub.id).map((o) => o.billing_period_start);
    expect(periods).toEqual([
      '2026-01-31T10:00:00.000Z',
      '2026-02-28T10:00:00.000Z',
      '2026-03-31T10:00:00.000Z',
      '2026-04-30T10:00:00.000Z',
    ]);
    expect(w.t.op('subscriptions.get', { id: sub.id }).next_bill_at).toBe(
      '2026-05-31T10:00:00.000Z',
    );
  });

  it('refuses inactive plans and keeps plan edits away from running subscriptions', () => {
    const w = commerceWorld();
    const sub = w.t.op('subscriptions.create', { contact_id: w.contactId, plan_id: w.monthly });
    w.t.op('plans.update', { id: w.monthly, data: { price_minor: 9_900, active: false } });
    expect(w.t.op('subscriptions.get', { id: sub.id }).unit_price_minor).toBe(4_900);
    expect(
      failure(() => w.t.op('subscriptions.create', { contact_id: w.contactId, plan_id: w.monthly }))
        .message,
    ).toContain('not active');
    expect(failure(() => w.t.op('plans.delete', { id: w.monthly })).code).toBe('conflict');
    expect(failure(() => w.t.op('products.delete', { id: w.software })).code).toBe('conflict');
  });
});
