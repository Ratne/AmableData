import type { Order } from '@amable/api-types';
import { describe, expect, it } from 'vitest';
import {
  buildDraftCreate,
  buildDraftUpdate,
  buildSubscriptionInputs,
  canPriceOrder,
  draftSignature,
  EMPTY_WIZARD,
  previewFromOrder,
  type WizardState,
} from '../../src/features/commerce/lib/order-draft';

const state: WizardState = {
  contactId: 'c1',
  lines: [
    {
      key: 'a',
      kind: 'product',
      productId: 'p1',
      name: 'Course',
      quantity: 2,
      unitPriceMinor: null,
      taxRateBps: null,
    },
    {
      key: 'b',
      kind: 'product',
      productId: 'p2',
      name: 'Mug',
      quantity: 1,
      unitPriceMinor: 900,
      taxRateBps: 400,
    },
    {
      key: 'c',
      kind: 'custom',
      name: '  Gift wrap ',
      quantity: 1,
      unitPriceMinor: 199,
      taxRateBps: 0,
    },
  ],
  plans: [
    { key: 'p', planId: 'plan1', name: 'Pro — monthly', quantity: 1 },
    { key: 'q', planId: 'plan2', name: 'Seats', quantity: 3 },
  ],
  promoCode: ' save10 ',
  shippingMinor: 690,
  notes: '',
};

describe('wizard state → API input', () => {
  it('creates a draft with catalog defaults and explicit overrides', () => {
    expect(buildDraftCreate(state)).toEqual({
      contact_id: 'c1',
      status: 'draft',
      items: [
        { product_id: 'p1', quantity: 2 },
        { product_id: 'p2', quantity: 1, unit_price_minor: 900, tax_rate_bps: 400 },
        { name: 'Gift wrap', quantity: 1, unit_price_minor: 199, tax_rate_bps: 0 },
      ],
      promo_code: 'save10',
      shipping_minor: 690,
    });
  });

  it('re-prices a draft, clearing promo and notes when emptied', () => {
    const update = buildDraftUpdate({ ...state, promoCode: '  ', notes: '' });
    expect(update.promo_code).toBeNull();
    expect(update.notes).toBeNull();
    expect(update.items).toHaveLength(3);
    expect(buildDraftUpdate({ ...state, notes: ' call first ' }).notes).toBe('call first');
  });

  it('maps plans to subscriptions (quantity only when not 1)', () => {
    expect(buildSubscriptionInputs(state)).toEqual([
      { contact_id: 'c1', plan_id: 'plan1' },
      { contact_id: 'c1', plan_id: 'plan2', quantity: 3 },
    ]);
    expect(buildSubscriptionInputs({ ...state, contactId: null })).toEqual([]);
  });

  it('needs a contact and at least one line to price', () => {
    expect(canPriceOrder(EMPTY_WIZARD)).toBe(false);
    expect(canPriceOrder({ ...EMPTY_WIZARD, contactId: 'c1' })).toBe(false);
    expect(canPriceOrder(state)).toBe(true);
    expect(() => buildDraftCreate({ ...state, contactId: null })).toThrow();
  });

  it('signature changes with pricing inputs only', () => {
    const base = draftSignature(state);
    expect(draftSignature({ ...state, promoCode: 'SAVE10' })).toBe(base);
    expect(draftSignature({ ...state, plans: [] })).toBe(base);
    expect(draftSignature({ ...state, shippingMinor: 0 })).not.toBe(base);
    expect(draftSignature({ ...state, lines: state.lines.slice(1) })).not.toBe(base);
  });
});

const item = (over: Partial<Order['items'][number]>): Order['items'][number] => ({
  id: 'i',
  product_id: null,
  plan_id: null,
  name: 'x',
  sku: null,
  description: null,
  quantity: 1,
  unit_price_minor: 0,
  subtotal_minor: 0,
  discount_minor: 0,
  tax_rate_bps: 0,
  tax_minor: 0,
  total_minor: 0,
  ...over,
});

describe('API order → totals preview', () => {
  it('copies the server totals and groups tax by rate', () => {
    const order = {
      currency: 'EUR',
      subtotal_minor: 23_849,
      discount_minor: 2_385,
      tax_minor: 4_438,
      shipping_minor: 690,
      total_minor: 26_592,
      promo_code: 'SAVE10',
      items: [
        item({
          id: 'a',
          name: 'Course',
          sku: 'CO-1',
          quantity: 2,
          unit_price_minor: 9_950,
          subtotal_minor: 19_900,
          discount_minor: 1_990,
          tax_rate_bps: 2200,
          tax_minor: 3_940,
        }),
        item({
          id: 'b',
          name: 'Mug',
          quantity: 3,
          unit_price_minor: 1_250,
          subtotal_minor: 3_750,
          discount_minor: 375,
          tax_rate_bps: 2200,
          tax_minor: 743,
        }),
        item({
          id: 'c',
          name: 'Book',
          quantity: 1,
          unit_price_minor: 199,
          subtotal_minor: 199,
          discount_minor: 20,
          tax_rate_bps: 400,
          tax_minor: 7,
        }),
        item({ id: 'd', name: 'Gift wrap', subtotal_minor: 0 }),
      ],
    } satisfies Parameters<typeof previewFromOrder>[0];

    const preview = previewFromOrder(order);
    expect(preview).toMatchObject({
      currency: 'EUR',
      subtotalMinor: 23_849,
      discountMinor: 2_385,
      promoCode: 'SAVE10',
      taxMinor: 4_438,
      shippingMinor: 690,
      totalMinor: 26_592,
    });
    expect(
      preview.lines.map((l) => [l.name, l.quantity, l.unitPriceMinor, l.discountMinor]),
    ).toEqual([
      ['Course', 2, 9_950, 1_990],
      ['Mug', 3, 1_250, 375],
      ['Book', 1, 199, 20],
      ['Gift wrap', 1, 0, 0],
    ]);
    // Highest rate first; zero-rate lines produce no tax row.
    expect(preview.taxes).toEqual([
      { rateBps: 2200, baseMinor: 19_900 - 1_990 + 3_750 - 375, taxMinor: 3_940 + 743 },
      { rateBps: 400, baseMinor: 179, taxMinor: 7 },
    ]);
  });

  it('works for invoices (no promo code field)', () => {
    const preview = previewFromOrder({
      currency: 'USD',
      subtotal_minor: 100,
      discount_minor: 0,
      tax_minor: 0,
      shipping_minor: 0,
      total_minor: 100,
      items: [item({ subtotal_minor: 100, total_minor: 100 })],
    });
    expect(preview.promoCode).toBeNull();
    expect(preview.taxes).toEqual([]);
  });
});
