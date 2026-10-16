import type {
  CreateOrderInput,
  CreateSubscriptionInput,
  Order,
  OrderItemInput,
  UpdateOrderInput,
} from '@amable/api-types';

/**
 * Manual order wizard model. The browser never computes money: the wizard
 * state is mapped to a `draft` order, the API prices it (promo, per-line tax,
 * shipping) and the returned order is mapped back to the totals preview shown
 * before finalizing.
 */

export interface WizardProductLine {
  readonly key: string;
  readonly kind: 'product';
  readonly productId: string;
  readonly name: string;
  readonly quantity: number;
  /** Override of the catalog price; `null` keeps the catalog price. */
  readonly unitPriceMinor: number | null;
  /** Override of the catalog tax rate; `null` keeps the product default. */
  readonly taxRateBps: number | null;
}

export interface WizardCustomLine {
  readonly key: string;
  readonly kind: 'custom';
  readonly name: string;
  readonly quantity: number;
  readonly unitPriceMinor: number;
  readonly taxRateBps: number;
}

export type WizardLine = WizardProductLine | WizardCustomLine;

/** A plan to subscribe the contact to when the order is confirmed. */
export interface WizardPlanLine {
  readonly key: string;
  readonly planId: string;
  readonly name: string;
  readonly quantity: number;
}

export interface WizardState {
  readonly contactId: string | null;
  readonly lines: readonly WizardLine[];
  readonly plans: readonly WizardPlanLine[];
  readonly promoCode: string;
  readonly shippingMinor: number;
  readonly notes: string;
}

export const EMPTY_WIZARD: WizardState = {
  contactId: null,
  lines: [],
  plans: [],
  promoCode: '',
  shippingMinor: 0,
  notes: '',
};

export function toItemInput(line: WizardLine): OrderItemInput {
  if (line.kind === 'product') {
    return {
      product_id: line.productId,
      quantity: line.quantity,
      ...(line.unitPriceMinor !== null ? { unit_price_minor: line.unitPriceMinor } : {}),
      ...(line.taxRateBps !== null ? { tax_rate_bps: line.taxRateBps } : {}),
    };
  }
  return {
    name: line.name.trim(),
    quantity: line.quantity,
    unit_price_minor: line.unitPriceMinor,
    tax_rate_bps: line.taxRateBps,
  };
}

/** True when the state can be priced as an order (contact + at least one line). */
export function canPriceOrder(state: WizardState): boolean {
  return state.contactId !== null && state.lines.length > 0;
}

/** `POST /orders` body for the draft that the API prices. */
export function buildDraftCreate(state: WizardState): CreateOrderInput {
  if (state.contactId === null) throw new Error('contact required');
  const promo = state.promoCode.trim();
  const notes = state.notes.trim();
  return {
    contact_id: state.contactId,
    status: 'draft',
    items: state.lines.map(toItemInput),
    promo_code: promo === '' ? null : promo,
    shipping_minor: state.shippingMinor,
    ...(notes ? { notes } : {}),
  };
}

/** `PATCH /orders/{id}` body re-pricing an existing draft of the same contact. */
export function buildDraftUpdate(state: WizardState): UpdateOrderInput {
  const promo = state.promoCode.trim();
  const notes = state.notes.trim();
  return {
    items: state.lines.map(toItemInput),
    promo_code: promo === '' ? null : promo,
    shipping_minor: state.shippingMinor,
    notes: notes === '' ? null : notes,
  };
}

/** Stable fingerprint of everything stored on the draft (detects a stale preview). */
export function draftSignature(state: WizardState): string {
  return JSON.stringify([
    state.contactId,
    state.lines.map(toItemInput),
    state.promoCode.trim().toUpperCase(),
    state.shippingMinor,
    state.notes.trim(),
  ]);
}

export function buildSubscriptionInputs(state: WizardState): CreateSubscriptionInput[] {
  if (state.contactId === null) return [];
  const contactId = state.contactId;
  return state.plans.map((plan) => ({
    contact_id: contactId,
    plan_id: plan.planId,
    ...(plan.quantity !== 1 ? { quantity: plan.quantity } : {}),
  }));
}

export interface PreviewLine {
  readonly id: string;
  readonly name: string;
  readonly sku: string | null;
  readonly quantity: number;
  readonly unitPriceMinor: number;
  readonly subtotalMinor: number;
  readonly discountMinor: number;
  readonly taxRateBps: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
}

export interface TaxBucket {
  readonly rateBps: number;
  /** Taxable base: line subtotals minus their discount share. */
  readonly baseMinor: number;
  readonly taxMinor: number;
}

export interface TotalsPreview {
  readonly currency: string;
  readonly lines: readonly PreviewLine[];
  readonly subtotalMinor: number;
  readonly discountMinor: number;
  readonly promoCode: string | null;
  readonly taxMinor: number;
  readonly taxes: readonly TaxBucket[];
  readonly shippingMinor: number;
  readonly totalMinor: number;
}

/** Anything the API priced: an order (draft or final) or its invoice. */
export type PricedDocument = Pick<
  Order,
  | 'currency'
  | 'items'
  | 'subtotal_minor'
  | 'discount_minor'
  | 'tax_minor'
  | 'shipping_minor'
  | 'total_minor'
> & { readonly promo_code?: string | null };

/** API-priced document → the totals table, with tax grouped by rate. */
export function previewFromOrder(order: PricedDocument): TotalsPreview {
  const buckets = new Map<number, { baseMinor: number; taxMinor: number }>();
  for (const item of order.items) {
    const bucket = buckets.get(item.tax_rate_bps) ?? { baseMinor: 0, taxMinor: 0 };
    bucket.baseMinor += item.subtotal_minor - item.discount_minor;
    bucket.taxMinor += item.tax_minor;
    buckets.set(item.tax_rate_bps, bucket);
  }
  return {
    currency: order.currency,
    lines: order.items.map((item) => ({
      id: item.id,
      name: item.name,
      sku: item.sku,
      quantity: item.quantity,
      unitPriceMinor: item.unit_price_minor,
      subtotalMinor: item.subtotal_minor,
      discountMinor: item.discount_minor,
      taxRateBps: item.tax_rate_bps,
      taxMinor: item.tax_minor,
      totalMinor: item.total_minor,
    })),
    subtotalMinor: order.subtotal_minor,
    discountMinor: order.discount_minor,
    promoCode: order.promo_code ?? null,
    taxMinor: order.tax_minor,
    taxes: [...buckets.entries()]
      .filter(([rate]) => rate > 0)
      .sort(([a], [b]) => b - a)
      .map(([rateBps, bucket]) => ({ rateBps, ...bucket })),
    shippingMinor: order.shipping_minor,
    totalMinor: order.total_minor,
  };
}
