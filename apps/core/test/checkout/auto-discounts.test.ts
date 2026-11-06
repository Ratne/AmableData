import { describe, expect, it } from 'vitest';
import { commerceWorld, failure, type CommerceWorld } from '../commerce/helpers';

// Catalog: course 199.00 (22% VAT), mug 12.50 (10% VAT).

function connectStripe(w: CommerceWorld): void {
  w.t.op('stripe.saveAccount', {
    tenantId: 'tenant_test',
    publishableKey: 'pk_test_0123456789abcdef',
    secret: { enc: 'enc:secret', hint: 'cdef' },
    webhook: { enc: 'enc:webhook', hint: 'wxyz' },
  });
}

function bundleCheckout(w: CommerceWorld, settings: Record<string, unknown> = {}) {
  return w.t.op('checkouts.create', {
    name: 'Bundle',
    status: 'active',
    definition: {
      items: [
        { id: 'course', kind: 'product', ref_id: w.course, preselected: true },
        { id: 'mug', kind: 'product', ref_id: w.mug },
      ],
      settings: { item_selection: 'any', allow_quantity: true, ...settings },
      discounts: [
        { id: 'pair', label: 'Course + mug', conditions: [{ item_id: 'course' }, { item_id: 'mug' }], percent_bps: 1000 },
        {
          id: 'two_mugs',
          label: 'Course + 2 mugs',
          conditions: [{ item_id: 'course' }, { item_id: 'mug', min_quantity: 2 }],
          percent_bps: 2000,
        },
        { id: 'mug_order', label: '3 mugs', conditions: [{ item_id: 'mug', min_quantity: 3 }], kind: 'fixed', amount_minor: 500, scope: 'order' },
      ],
    },
  });
}

function quote(w: CommerceWorld, checkoutId: string, selection: Record<string, unknown>, promoCode = '') {
  return w.t.op('checkout.quote', { checkoutId, selection, promoCode, locale: 'en' });
}

describe('free item selection', () => {
  it('buys only the checked items and refuses an empty cart', () => {
    const w = commerceWorld();
    const c = bundleCheckout(w);
    expect(quote(w, c.id, { items: ['course'] })).toMatchObject({ subtotal_minor: 19_900, discount_minor: 0, discounts: [] });
    expect(quote(w, c.id, { items: ['mug'], quantities: { mug: 2 } }).subtotal_minor).toBe(2_500);
    expect(quote(w, c.id, { items: ['course', 'mug', 'unknown'] }).lines.map((l) => l.name)).toEqual(['Analytics Course', 'Mug']);
    expect(failure(() => quote(w, c.id, { items: [] })).code).toBe('validation_failed');
  });
});

describe('automatic discounts', () => {
  it('applies the largest matching rule to its products', () => {
    const w = commerceWorld();
    const c = bundleCheckout(w);
    const pair = quote(w, c.id, { items: ['course', 'mug'] });
    expect(pair).toMatchObject({ discount_minor: 2_115, discounts: [{ label: 'Course + mug', amount_minor: 2_115 }] });
    // 2 mugs meet both rules: 20% of 199.00 + 25.00 beats 10%.
    const two = quote(w, c.id, { items: ['course', 'mug'], quantities: { mug: 2 } });
    expect(two).toMatchObject({ discount_minor: 4_480, discounts: [{ label: 'Course + 2 mugs', amount_minor: 4_480 }] });
    expect(two.lines.map((l) => l.discount_minor)).toEqual([3_980, 500]);
    // Tax on the discounted lines: (19900-3980)*22% = 3502.4; (2500-500)*10% = 200.
    expect(two.tax_minor).toBe(3_502 + 200);
    expect(two.total_minor).toBe(22_400 - 4_480 + 3_702);
    // A fixed amount on the whole order, without the course.
    expect(quote(w, c.id, { items: ['mug'], quantities: { mug: 3 } })).toMatchObject({
      discount_minor: 500,
      discounts: [{ label: '3 mugs', amount_minor: 500 }],
    });
  });

  it('lets a promo code replace the automatic discounts, or add to them when stacking', () => {
    const w = commerceWorld();
    w.t.op('promoCodes.create', { code: 'save10', kind: 'percent', percent_bps: 1000 });
    const selection = { items: ['course', 'mug'], quantities: { mug: 2 } };

    const replaced = quote(w, bundleCheckout(w).id, selection, 'SAVE10');
    expect(replaced).toMatchObject({ discount_minor: 2_240, discounts: [], promo: { code: 'SAVE10', applied: true } });
    // An invalid code keeps the automatic discount.
    expect(quote(w, bundleCheckout(w).id, selection, 'NOPE')).toMatchObject({
      discount_minor: 4_480,
      promo: { code: 'NOPE', applied: false },
    });

    const stacked = quote(w, bundleCheckout(w, { discounts_stack_promo: true }).id, selection, 'SAVE10');
    // 4480 automatic, then 10% of the 17920 left.
    expect(stacked).toMatchObject({ discount_minor: 4_480 + 1_792, discounts: [{ amount_minor: 4_480 }] });
  });

  it('writes the discounted lines on the draft order', () => {
    const w = commerceWorld();
    connectStripe(w);
    const c = bundleCheckout(w);
    const selection = { items: ['course', 'mug'], quantities: { mug: 2 } };
    const prepared = w.t.op('checkout.prepare', {
      checkoutId: c.id,
      payload: { buyer: { email: 'buyer@example.com', given_name: 'Mary', family_name: 'Shelley' }, selection },
      tokenHash: 'h1',
      existingTokenHash: null,
    });
    const expected = quote(w, c.id, selection);
    expect(prepared.quote).toMatchObject({ discount_minor: 4_480, total_minor: expected.total_minor });
    const draft = w.t.op('orders.get', { id: prepared.orderId ?? '' });
    expect(draft).toMatchObject({ discount_minor: 4_480, total_minor: expected.total_minor, promo_code: null });
    expect(draft.items.map((i) => i.discount_minor)).toEqual([3_980, 500]);
    expect(prepared.amountMinor).toBe(expected.total_minor);
  });
});
