/**
 * Stripe payment methods a checkout may restrict the Payment Element to.
 * Zod-free: the widget imports it too. Apple Pay and Google Pay are wallets
 * of `card` (the `wallets` switch), not types of their own.
 */

export const STRIPE_PAYMENT_METHOD_TYPES = [
  'card',
  'link',
  'paypal',
  'klarna',
  'bancontact',
  'ideal',
  'eps',
  'sepa_debit',
  'revolut_pay',
  'amazon_pay',
] as const;
export type StripePaymentMethodType = (typeof STRIPE_PAYMENT_METHOD_TYPES)[number];

/** Methods Stripe can save for later off-session charges (renewals, one-click offers). */
export const REUSABLE_PAYMENT_METHOD_TYPES: readonly StripePaymentMethodType[] = [
  'card',
  'link',
  'sepa_debit',
];

export const STRIPE_METHOD_MODES = ['automatic', 'custom'] as const;

export interface StripeMethodChoice {
  /** `automatic`: every method enabled in the Stripe dashboard; `custom`: only `types`. */
  readonly mode: (typeof STRIPE_METHOD_MODES)[number];
  readonly types: readonly StripePaymentMethodType[];
  /** Apple Pay / Google Pay buttons in the Payment Element. */
  readonly wallets: boolean;
}

/**
 * Explicit `payment_method_types` of the intent, or null to let Stripe pick
 * (`automatic`). When the method is saved (`save`) only reusable ones stay.
 * Card is always offered, in a fixed order whatever the stored order.
 */
export function paymentMethodTypesFor(
  choice: StripeMethodChoice,
  save: boolean,
): StripePaymentMethodType[] | null {
  if (choice.mode === 'automatic') return null;
  const wanted = new Set<StripePaymentMethodType>(['card', ...choice.types]);
  return STRIPE_PAYMENT_METHOD_TYPES.filter(
    (t) => wanted.has(t) && (!save || REUSABLE_PAYMENT_METHOD_TYPES.includes(t)),
  );
}
