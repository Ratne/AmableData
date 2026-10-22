import { describe, expect, it } from 'vitest';
import { signStripePayload, verifyStripeSignature, WEBHOOK_TOLERANCE_MS } from '../../src/commerce/stripe/webhook';
import { commerceWorld, DAY, failure, type CommerceWorld } from '../commerce/helpers';

const BUYER = { email: 'buyer@example.com', given_name: 'Mary', family_name: 'Shelley' };

function connectStripe(w: CommerceWorld): void {
  w.t.op('stripe.saveAccount', {
    tenantId: 'tenant_test',
    publishableKey: 'pk_test_0123456789abcdef',
    secret: { enc: 'enc:secret', hint: 'cdef' },
    webhook: { enc: 'enc:webhook', hint: 'wxyz' },
  });
}

function checkout(w: CommerceWorld, definition: Record<string, unknown>) {
  return w.t.op('checkouts.create', { name: 'Launch', status: 'active', definition });
}

function prepare(
  w: CommerceWorld,
  checkoutId: string,
  token: string,
  payload: Record<string, unknown> = {},
  existing: string | null = null,
) {
  return w.t.op('checkout.prepare', {
    checkoutId,
    payload: { buyer: BUYER, ...payload },
    tokenHash: token,
    existingTokenHash: existing,
  });
}

function succeed(w: CommerceWorld, intentId: string, amount: number, paymentMethodId: string | null = 'pm_1') {
  return w.t.op('checkout.settleIntent', {
    intentId,
    kind: 'payment',
    status: 'succeeded',
    amountReceived: amount,
    customerId: 'cus_1',
    paymentMethodId,
    failureMessage: null,
  });
}

function attach(w: CommerceWorld, prepared: { sessionId: string; contactId: string }, intentId: string, kind: 'payment' | 'setup' = 'payment') {
  w.t.op('checkout.attachIntent', {
    sessionId: prepared.sessionId,
    contactId: prepared.contactId,
    customerId: 'cus_1',
    intentKind: kind,
    intentId,
  });
}

describe('stripe webhook signature', () => {
  it('accepts a signed payload within the tolerance and rejects tampering or replays', async () => {
    const secret = 'whsec_test_secret';
    const payload = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded', data: { object: {} } });
    const now = Date.UTC(2026, 9, 15, 12, 0, 0);
    const t = Math.floor(now / 1000);
    const v1 = await signStripePayload(secret, t, payload);
    expect(await verifyStripeSignature(payload, `t=${String(t)},v1=${v1}`, secret, now)).toBe(true);
    // rotated secrets: any matching v1 is enough
    expect(await verifyStripeSignature(payload, `t=${String(t)},v1=deadbeef,v1=${v1}`, secret, now)).toBe(true);
    expect(await verifyStripeSignature(`${payload} `, `t=${String(t)},v1=${v1}`, secret, now)).toBe(false);
    expect(await verifyStripeSignature(payload, `t=${String(t)},v1=${v1}`, 'whsec_other', now)).toBe(false);
    expect(await verifyStripeSignature(payload, `t=${String(t)},v1=${v1}`, secret, now + WEBHOOK_TOLERANCE_MS + 1_000)).toBe(false);
    expect(await verifyStripeSignature(payload, null, secret, now)).toBe(false);
    expect(await verifyStripeSignature(payload, `v1=${v1}`, secret, now)).toBe(false);
  });
});

describe('checkout sessions', () => {
  it('refuses to sell before Stripe is connected', () => {
    const w = commerceWorld();
    const c = checkout(w, { items: [{ id: 'i1', kind: 'product', ref_id: w.course }] });
    expect(failure(() => prepare(w, c.id, 'h1')).code).toBe('conflict');
  });

  it('drafts the order with bumps, promo and attribution, and settles it once', () => {
    const w = commerceWorld();
    connectStripe(w);
    w.t.op('promoCodes.create', { code: 'save10', kind: 'percent', percent_bps: 1000 });
    const c = checkout(w, {
      items: [{ id: 'i1', kind: 'product', ref_id: w.course }],
      bumps: [{ id: 'b1', product_id: w.mug, title: 'Add a mug' }],
    });
    const prepared = prepare(w, c.id, 'h1', {
      selection: { bumps: ['b1'] },
      promo_code: 'SAVE10',
      tracking: { utm_source: 'newsletter', utm_campaign: 'launch', ignored: 'x' },
    });
    expect(prepared).toMatchObject({ reused: false, intentKind: 'payment', save: false, currency: 'EUR' });
    const draft = w.t.op('orders.get', { id: prepared.orderId ?? '' });
    expect(draft).toMatchObject({
      status: 'draft',
      source: 'checkout',
      checkout_id: c.id,
      promo_code: 'SAVE10',
      discount_minor: 2_115,
      attribution: { utm_source: 'newsletter', utm_campaign: 'launch' },
    });
    // The bump headline is shown on the page; the order line keeps the product name.
    expect(draft.items.map((i) => i.name)).toEqual(['Analytics Course', 'Mug']);
    expect(w.t.op('checkout.public', { checkoutId: c.id }).config.bumps[0]).toMatchObject({ title: 'Add a mug', unit_price_minor: 1_250 });
    expect(prepared.amountMinor).toBe(draft.total_minor);
    const contact = w.t.op('contacts.get', { id: prepared.contactId });
    expect(contact).toMatchObject({ source_type: 'checkout' });

    // A retry with the session token keeps the same session and draft.
    const retry = prepare(w, c.id, 'h2', { selection: { bumps: ['b1'] }, promo_code: 'SAVE10' }, 'h1');
    expect(retry).toMatchObject({ reused: true, sessionId: prepared.sessionId, orderId: prepared.orderId });

    attach(w, prepared, 'pi_1');
    // The browser and the webhook both report the payment.
    succeed(w, 'pi_1', prepared.amountMinor, null);
    succeed(w, 'pi_1', prepared.amountMinor, null);
    const paid = w.t.op('orders.get', { id: prepared.orderId ?? '' });
    expect(paid).toMatchObject({ status: 'paid', paid_minor: prepared.amountMinor });
    expect(w.t.op('checkout.completion', { tokenHash: 'h1' })).toMatchObject({
      status: 'paid',
      order_number: paid.number,
      next: { kind: 'thank_you', url: null },
    });
    // Paid sessions cannot be reopened.
    expect(failure(() => prepare(w, c.id, 'h3', {}, 'h1')).code).toBe('conflict');

    // Refunds made in the Stripe dashboard: the cumulative amount, applied once per delta.
    const refund = (amount: number) =>
      w.t.op('stripe.event', { type: 'charge.refunded', chargeId: 'ch_1', paymentIntentId: 'pi_1', amountRefunded: amount });
    expect(refund(1_000)).toEqual({ handled: true });
    refund(1_000);
    expect(w.t.op('orders.get', { id: paid.id }).refunded_minor).toBe(1_000);
    refund(paid.total_minor);
    expect(w.t.op('orders.get', { id: paid.id })).toMatchObject({ status: 'refunded', refunded_minor: paid.total_minor });
  });

  it('keeps the session open with the error after a declined card', () => {
    const w = commerceWorld();
    connectStripe(w);
    const c = checkout(w, { items: [{ id: 'i1', kind: 'product', ref_id: w.course }] });
    const prepared = prepare(w, c.id, 'h1');
    attach(w, prepared, 'pi_1');
    w.t.op('checkout.settleIntent', {
      intentId: 'pi_1',
      kind: 'payment',
      status: 'requires_payment_method',
      amountReceived: 0,
      customerId: 'cus_1',
      paymentMethodId: null,
      failureMessage: 'Your card was declined.',
    });
    expect(w.t.op('checkout.completion', { tokenHash: 'h1' })).toMatchObject({
      status: 'failed',
      message: 'Your card was declined.',
    });
    expect(prepare(w, c.id, 'h2', {}, 'h1')).toMatchObject({ reused: true, intentId: 'pi_1' });
  });

  it('opens a setup intent and no order for a free trial', () => {
    const w = commerceWorld();
    connectStripe(w);
    const c = checkout(w, { items: [{ id: 'i1', kind: 'plan', ref_id: w.trialPlan }] });
    const prepared = prepare(w, c.id, 'h1');
    expect(prepared).toMatchObject({ intentKind: 'setup', save: true, orderId: null, amountMinor: 0 });
    attach(w, prepared, 'seti_1', 'setup');
    w.t.op('checkout.settleIntent', {
      intentId: 'seti_1',
      kind: 'setup',
      status: 'succeeded',
      amountReceived: 0,
      customerId: 'cus_1',
      paymentMethodId: 'pm_1',
      failureMessage: null,
    });
    const subs = w.t.op('subscriptions.list', { limit: 10, contact_id: prepared.contactId }).data;
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ status: 'trialing', autopay: true });
  });
});

describe('refunds through Stripe', () => {
  function paidOrder() {
    const w = commerceWorld();
    connectStripe(w);
    const c = checkout(w, { items: [{ id: 'i1', kind: 'product', ref_id: w.course }] });
    const prepared = prepare(w, c.id, 'h1');
    attach(w, prepared, 'pi_1');
    succeed(w, 'pi_1', prepared.amountMinor, null);
    const orderId = prepared.orderId ?? '';
    return { w, orderId, total: prepared.amountMinor };
  }
  const sync = (w: CommerceWorld, cumulative: number, reason: string | null = 'Damaged') =>
    w.t.op('stripe.refundSync', { chargeId: 'ch_1', paymentIntentId: 'pi_1', amountRefunded: cumulative, reason });
  const webhook = (w: CommerceWorld, cumulative: number) =>
    w.t.op('stripe.event', { type: 'charge.refunded', chargeId: 'ch_1', paymentIntentId: 'pi_1', amountRefunded: cumulative });

  it('plans a partial or full refund on the Stripe payment', () => {
    const { w, orderId, total } = paidOrder();
    const full = w.t.op('stripe.refundPlan', { orderId, paymentId: null, amountMinor: null });
    expect(full.parts).toEqual([
      expect.objectContaining({ paymentIntentId: 'pi_1', amountMinor: total, refundedMinor: 0 }),
    ]);
    expect(w.t.op('stripe.refundPlan', { orderId, paymentId: null, amountMinor: 1_000 }).parts[0]?.amountMinor).toBe(1_000);
    expect(failure(() => w.t.op('stripe.refundPlan', { orderId, paymentId: null, amountMinor: total + 1 })).code).toBe('validation_failed');
  });

  it('records the refund once whether the CRM action or the webhook comes first', () => {
    const { w, orderId, total } = paidOrder();
    // CRM action first, then the webhook of the same refund.
    const first = sync(w, 1_000).refund;
    expect(first).toMatchObject({ amount_minor: 1_000, reason: 'Damaged' });
    webhook(w, 1_000);
    expect(sync(w, 1_000).refund?.id).toBe(first?.id);
    // Webhook first for the second refund, then the CRM action.
    webhook(w, total);
    expect(sync(w, total).refund?.amount_minor).toBe(total - 1_000);
    const order = w.t.op('orders.get', { id: orderId });
    expect(order).toMatchObject({ status: 'refunded', refunded_minor: total });
    expect(w.t.op('refunds.list', { order_id: orderId, limit: 10 }).data).toHaveLength(2);
    expect(failure(() => w.t.op('stripe.refundPlan', { orderId, paymentId: null, amountMinor: null })).code).toBe('conflict');
  });

  it('keeps manual CRM refunds apart from the Stripe totals', () => {
    const { w, orderId, total } = paidOrder();
    w.t.op('refunds.record', { orderId, data: { amount_minor: 500, reason: 'Cash back' } });
    expect(w.t.op('stripe.refundPlan', { orderId, paymentId: null, amountMinor: null }).parts[0]?.amountMinor).toBe(total - 500);
    expect(sync(w, 2_000).refund?.amount_minor).toBe(2_000);
    expect(w.t.op('orders.get', { id: orderId }).refunded_minor).toBe(2_500);
  });

  it('refuses payments recorded by hand', () => {
    const w = commerceWorld();
    const order = w.t.op('orders.create', { contact_id: w.contactId, items: [{ product_id: w.mug }] });
    const payment = w.t.op('payments.record', { orderId: order.id, data: { amount_minor: order.total_minor, method: 'bank_transfer' } });
    expect(failure(() => w.t.op('stripe.refundPlan', { orderId: order.id, paymentId: null, amountMinor: null })).code).toBe('conflict');
    expect(failure(() => w.t.op('stripe.refundPlan', { orderId: order.id, paymentId: payment.id, amountMinor: null })).code).toBe(
      'validation_failed',
    );
  });
});

describe('subscriptions bought through a checkout', () => {
  it('charges the setup fee once and the repeating promo on the next renewals, off-session', () => {
    const w = commerceWorld();
    connectStripe(w);
    const product = w.t.op('products.create', {
      name: 'Coaching',
      price_minor: 10_000,
      currency: 'EUR',
      tax_rate_bps: 0,
      plans: [{ name: 'Monthly', interval: 'month', price_minor: 10_000, setup_fee_minor: 5_000 }],
    });
    const planId = product.plans[0]?.id ?? '';
    w.t.op('promoCodes.create', { code: 'HALF3', kind: 'percent', percent_bps: 5000, duration: 'repeating', duration_periods: 3 });
    const c = checkout(w, { items: [{ id: 'i1', kind: 'plan', ref_id: planId }] });
    const prepared = prepare(w, c.id, 'h1', { promo_code: 'HALF3' });
    expect(prepared.save).toBe(true);
    expect(prepared.quote.lines.map((l) => l.kind)).toEqual(['item', 'setup_fee']);
    expect(prepared.quote.recurring).toMatchObject({ amount_minor: 10_000, discounted_periods: 2, discounted_amount_minor: 5_000 });
    attach(w, prepared, 'pi_1');
    succeed(w, 'pi_1', prepared.amountMinor);

    const sub = w.t.op('subscriptions.list', { limit: 10, contact_id: prepared.contactId }).data[0];
    expect(sub).toMatchObject({ status: 'active', autopay: true, discount: { periods_left: 2 } });
    const renewalTotals: number[] = [];
    for (let period = 1; period <= 3; period += 1) {
      w.t.clock.now += 32 * DAY;
      w.t.op('billing.run', {});
      const due = w.t.op('commerce.chargesDue', {});
      expect(due).toHaveLength(1);
      const charge = due[0];
      if (charge === undefined) throw new Error('no charge due');
      expect(charge).toMatchObject({ customerId: 'cus_1', paymentMethodId: 'pm_1', attempt: 1 });
      // Leased: the next alarm does not pick it up again.
      expect(w.t.op('commerce.chargesDue', {})).toHaveLength(0);
      renewalTotals.push(charge.amountMinor);
      w.t.op('commerce.chargeResult', {
        orderId: charge.orderId,
        attempt: 1,
        intentId: `pi_r${String(period)}`,
        status: 'succeeded',
        amountReceived: charge.amountMinor,
        failureMessage: null,
      });
      expect(w.t.op('orders.get', { id: charge.orderId }).status).toBe('paid');
    }
    // Two discounted renewals, then the full price; no setup fee on renewals.
    expect(renewalTotals).toEqual([5_000, 5_000, 10_000]);
  });

  it('retries a declined renewal and settles it from the webhook', () => {
    const w = commerceWorld();
    connectStripe(w);
    const c = checkout(w, { items: [{ id: 'i1', kind: 'plan', ref_id: w.monthly }] });
    const prepared = prepare(w, c.id, 'h1');
    attach(w, prepared, 'pi_1');
    succeed(w, 'pi_1', prepared.amountMinor);
    w.t.clock.now += 32 * DAY;
    w.t.op('billing.run', {});
    const [charge] = w.t.op('commerce.chargesDue', {});
    if (charge === undefined) throw new Error('no charge due');
    w.t.op('commerce.chargeResult', {
      orderId: charge.orderId,
      attempt: 1,
      intentId: 'pi_r1',
      status: 'failed',
      amountReceived: 0,
      failureMessage: 'insufficient_funds',
    });
    expect(w.t.op('subscriptions.list', { limit: 10, contact_id: prepared.contactId }).data[0]?.status).toBe('past_due');
    expect(w.t.op('commerce.chargesDue', {})).toHaveLength(0);
    w.t.clock.now += 3 * DAY + 1;
    const [retry] = w.t.op('commerce.chargesDue', {});
    expect(retry).toMatchObject({ orderId: charge.orderId, attempt: 2 });
    const event = {
      type: 'intent' as const,
      intent: {
        intentId: 'pi_r2',
        kind: 'payment' as const,
        status: 'succeeded',
        amountReceived: charge.amountMinor,
        customerId: 'cus_1',
        paymentMethodId: 'pm_1',
        failureMessage: null,
      },
      metadata: { amable_kind: 'renewal', amable_order: charge.orderId, amable_attempt: '2' },
    };
    expect(w.t.op('stripe.event', event)).toEqual({ handled: true });
    w.t.op('stripe.event', event);
    const order = w.t.op('orders.get', { id: charge.orderId });
    expect(order).toMatchObject({ status: 'paid', paid_minor: charge.amountMinor });
    expect(w.t.op('subscriptions.list', { limit: 10, contact_id: prepared.contactId }).data[0]?.status).toBe('active');
  });
});

describe('post-purchase offers', () => {
  function offerWorld() {
    const w = commerceWorld();
    connectStripe(w);
    const c = checkout(w, {
      items: [{ id: 'i1', kind: 'product', ref_id: w.course }],
      offers: [
        { key: 'up', kind: 'upsell', ref_id: w.mug, title: 'Mug', on_decline: 'down' },
        { key: 'down', kind: 'downsell', ref_id: w.mug, price_minor: 500, title: 'Cheaper mug' },
      ],
      settings: { first_offer: 'up' },
    });
    const prepared = prepare(w, c.id, 'h1');
    expect(prepared.save).toBe(true);
    attach(w, prepared, 'pi_1');
    succeed(w, 'pi_1', prepared.amountMinor);
    return { w, c, prepared };
  }

  it('shows the first offer after the payment and charges it once', () => {
    const { w, prepared } = offerWorld();
    expect(w.t.op('checkout.completion', { tokenHash: 'h1' }).next).toEqual({ kind: 'offer', url: null });
    expect(w.t.op('checkout.offerState', { tokenHash: 'h1' })).toMatchObject({ status: 'offer', offer: { key: 'up', currency: 'EUR' } });

    const first = w.t.op('checkout.offerPrepare', { tokenHash: 'h1', offerKey: 'up' });
    expect(first).toMatchObject({ action: 'charge', customerId: 'cus_1', paymentMethodId: 'pm_1', attempt: 1 });
    // A double click before Stripe answers reuses the same draft order.
    const again = w.t.op('checkout.offerPrepare', { tokenHash: 'h1', offerKey: 'up' });
    expect(again).toMatchObject({ action: 'charge', orderId: first.orderId });

    // 3-D Secure: further clicks only check the pending intent.
    w.t.op('checkout.offerSettle', {
      sessionId: first.sessionId,
      offerKey: 'up',
      orderId: first.orderId,
      intentId: 'pi_up',
      status: 'requires_action',
      amountReceived: 0,
      message: null,
    });
    expect(w.t.op('checkout.offerPrepare', { tokenHash: 'h1', offerKey: 'up' })).toMatchObject({ action: 'check', pendingIntentId: 'pi_up' });

    const settle = {
      sessionId: first.sessionId,
      offerKey: 'up',
      orderId: first.orderId,
      intentId: 'pi_up',
      status: 'succeeded' as const,
      amountReceived: first.amountMinor,
      message: null,
    };
    expect(w.t.op('checkout.offerSettle', settle)).toEqual({ state: 'accepted' });
    // The webhook arriving later does not record the payment twice.
    expect(w.t.op('checkout.offerSettle', settle)).toEqual({ state: 'stale' });
    const upsell = w.t.op('orders.get', { id: first.orderId ?? '' });
    expect(upsell).toMatchObject({ status: 'paid', paid_minor: first.amountMinor, parent_order_id: prepared.orderId, source: 'checkout' });
    expect(w.t.op('checkout.offerState', { tokenHash: 'h1' })).toMatchObject({ status: 'done', next: { kind: 'thank_you' } });
    expect(w.t.op('checkout.offerPrepare', { tokenHash: 'h1', offerKey: 'up' }).action).toBe('none');
  });

  it('routes a decline to the downsell and ends the chain', () => {
    const { w } = offerWorld();
    expect(w.t.op('checkout.offerDecline', { tokenHash: 'h1', offerKey: 'up' })).toEqual({ declined: true });
    expect(w.t.op('checkout.offerDecline', { tokenHash: 'h1', offerKey: 'up' })).toEqual({ declined: false });
    expect(w.t.op('checkout.offerState', { tokenHash: 'h1' })).toMatchObject({
      status: 'offer',
      offer: { key: 'down', kind: 'downsell' },
    });
    const down = w.t.op('checkout.offerPrepare', { tokenHash: 'h1', offerKey: 'down' });
    expect(down.action).toBe('charge');
    w.t.op('checkout.offerSettle', {
      sessionId: down.sessionId,
      offerKey: 'down',
      orderId: down.orderId,
      intentId: 'pi_down',
      status: 'failed',
      amountReceived: 0,
      message: 'card declined',
    });
    // The failed draft is removed; declining now ends the chain.
    expect(failure(() => w.t.op('orders.get', { id: down.orderId ?? '' })).code).toBe('not_found');
    expect(w.t.op('checkout.offerDecline', { tokenHash: 'h1', offerKey: 'down' })).toEqual({ declined: true });
    expect(w.t.op('checkout.offerState', { tokenHash: 'h1' })).toMatchObject({ status: 'done' });
  });

  it('expires the one-click window', () => {
    const { w } = offerWorld();
    w.t.clock.now += 61 * 60_000;
    expect(w.t.op('checkout.offerState', { tokenHash: 'h1' })).toMatchObject({ status: 'done' });
    expect(w.t.op('checkout.offerPrepare', { tokenHash: 'h1', offerKey: 'up' }).action).toBe('none');
  });
});
