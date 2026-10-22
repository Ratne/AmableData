import type {
  AddressSuggestion,
  CompleteResult,
  OfferActionResult,
  OfferState,
  PublicCheckoutConfig,
  Quote,
  SelectionInput,
  SessionPayloadInput,
  SessionResult,
} from './public';

/**
 * Edge ↔ core gateway ops of checkouts (structurally a `GatewayOpMap` of
 * @amable/api-types). The edge serves `/checkout.js` and `/c/:tenant/…`; the
 * core worker talks to Stripe and records the purchase in the TenantDb.
 */
export type CheckoutGatewayOps = {
  /** Public widget configuration of an active checkout (404 otherwise). */
  'checkout.config': {
    input: { checkoutId: string };
    output: PublicCheckoutConfig;
  };
  'checkout.hosted': {
    input: { checkoutId: string };
    output: { config: PublicCheckoutConfig; tenantName: string };
  };
  /** Prices of a selection (taxes, promo code, recurring terms). */
  'checkout.quote': {
    input: { checkoutId: string; selection: SelectionInput; promoCode: string };
    output: Quote;
  };
  /** Validates the buyer, upserts the contact, drafts the order and opens the Stripe intent. */
  'checkout.session': {
    input: { checkoutId: string; payload: SessionPayloadInput };
    output: SessionResult;
  };
  /** After Stripe.js confirmed: settles the purchase (the webhook does the same, whichever comes first). */
  'checkout.complete': {
    input: { token: string };
    output: CompleteResult;
  };
  /** Current post-purchase offer of a session. */
  'checkout.offer': {
    input: { token: string };
    output: OfferState;
  };
  /** One click: charges the saved payment method for the offer. */
  'checkout.offerAccept': {
    input: { token: string; offerKey: string };
    output: OfferActionResult;
  };
  /** After 3-D Secure of an accepted offer. */
  'checkout.offerConfirm': {
    input: { token: string; offerKey: string };
    output: OfferActionResult;
  };
  'checkout.offerDecline': {
    input: { token: string; offerKey: string };
    output: OfferActionResult;
  };
  /** Address suggestions for the buyer fields. */
  'checkout.address': {
    input: { checkoutId: string; q: string; country: string; lang: string };
    output: { data: AddressSuggestion[] };
  };
  /** Stripe webhook (raw body + `Stripe-Signature`). */
  'checkout.stripeWebhook': {
    input: { payload: string; signature: string | null };
    output: { received: true };
  };
};

export const CHECKOUT_GATEWAY_OPS = [
  'checkout.config',
  'checkout.hosted',
  'checkout.quote',
  'checkout.session',
  'checkout.complete',
  'checkout.offer',
  'checkout.offerAccept',
  'checkout.offerConfirm',
  'checkout.offerDecline',
  'checkout.address',
  'checkout.stripeWebhook',
] as const satisfies ReadonlyArray<keyof CheckoutGatewayOps>;

/** Query parameter carrying the session token across post-purchase pages. */
export const SESSION_PARAM = 'amb_cs';
