import { submissionMetaSchema, type FormField } from '@amable/forms';
import { z } from 'zod';
import type {
  BumpSkin,
  CheckoutContact,
  CheckoutItemKind,
  CheckoutSettings,
  CheckoutStyle,
} from './schema';

/** Recurring terms of a subscription plan line. */
export interface PublicRecurring {
  readonly interval: 'day' | 'week' | 'month' | 'year';
  readonly interval_count: number;
  readonly trial_days: number;
  /** Charged once with the first payment. */
  readonly setup_fee_minor: number;
}

export interface PublicCheckoutItem {
  readonly id: string;
  readonly kind: CheckoutItemKind;
  readonly name: string;
  readonly description: string;
  readonly image_url: string;
  readonly unit_price_minor: number;
  readonly quantity: number;
  readonly preselected: boolean;
  readonly recurring: PublicRecurring | null;
}

export interface PublicBump {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly image_url: string;
  readonly skin: BumpSkin;
  readonly position: 'below_items' | 'above_payment' | 'below_payment';
  readonly color: string;
  readonly checked: boolean;
  readonly unit_price_minor: number;
  /** Catalog price when the bump is discounted (shown struck through). */
  readonly regular_price_minor: number | null;
  readonly quantity: number;
}

/** What the widget receives: no CRM settings, no offer chain internals. */
export interface PublicCheckoutConfig {
  readonly id: string;
  readonly name: string;
  readonly tenant: string;
  readonly currency: string;
  readonly items: readonly PublicCheckoutItem[];
  readonly bumps: readonly PublicBump[];
  readonly fields: readonly FormField[];
  readonly contact: CheckoutContact;
  readonly settings: Omit<CheckoutSettings, 'allowed_domains' | 'first_offer' | 'offer_window_minutes'>;
  readonly style: CheckoutStyle;
  /** Post-purchase offers follow: the card is saved for one-click charges. */
  readonly offers_enabled: boolean;
  /** Null when the workspace has not connected Stripe: the widget shows an error. */
  readonly stripe_publishable_key: string | null;
}

// --------------------------------------------------------------- selection

export const selectionSchema = z.object({
  /** Picked item ids (`item_selection: one`: exactly one; `all`: ignored). */
  items: z.array(z.string().max(64)).max(20).default([]),
  /** Item id → quantity (`allow_quantity`). */
  quantities: z.record(z.string().max(64), z.number().int().min(1).max(999)).default({}),
  bumps: z.array(z.string().max(64)).max(5).default([]),
});
export type Selection = z.infer<typeof selectionSchema>;
export type SelectionInput = z.input<typeof selectionSchema>;

export interface QuoteLine {
  readonly name: string;
  readonly quantity: number;
  readonly subtotal_minor: number;
  readonly discount_minor: number;
  readonly total_minor: number;
  readonly kind: 'item' | 'bump' | 'setup_fee' | 'trial';
}

export interface Quote {
  readonly currency: string;
  readonly lines: readonly QuoteLine[];
  readonly subtotal_minor: number;
  readonly discount_minor: number;
  readonly tax_minor: number;
  /** Charged now. */
  readonly total_minor: number;
  /** Subscription charged after this payment (or after the trial). */
  readonly recurring: {
    readonly amount_minor: number;
    readonly interval: PublicRecurring['interval'];
    readonly interval_count: number;
    readonly trial_days: number;
    /** Renewals still discounted by the promo code (null = all of them). */
    readonly discounted_periods: number | null;
    readonly discounted_amount_minor: number | null;
  } | null;
  readonly promo: { readonly code: string; readonly applied: boolean; readonly message: string | null } | null;
}

// ----------------------------------------------------------------- session

const text = (max: number) => z.string().trim().max(max).default('');

export const buyerSchema = z.object({
  email: z.string().trim().max(254),
  given_name: text(100),
  family_name: text(100),
  phone: text(40),
  company_name: text(200),
  address: z
    .object({
      line1: text(200),
      line2: text(200),
      city: text(100),
      postal_code: text(20),
      region: text(100),
      country: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^([A-Z]{2})?$/)
        .default(''),
    })
    .default({ line1: '', line2: '', city: '', postal_code: '', region: '', country: '' }),
});
export type Buyer = z.infer<typeof buyerSchema>;
export type BuyerInput = z.input<typeof buyerSchema>;

export const sessionPayloadSchema = z.object({
  selection: selectionSchema.default({ items: [], quantities: {}, bumps: [] }),
  promo_code: z.string().trim().max(64).default(''),
  buyer: buyerSchema,
  values: z
    .record(
      z.string().max(64),
      z.union([z.string().max(10_000), z.number(), z.boolean(), z.array(z.string().max(200)).max(200), z.null()]),
    )
    .default({}),
  tracking: z.record(z.string().max(64), z.string().max(500)).default({}),
  meta: submissionMetaSchema.default(() => submissionMetaSchema.parse({})),
  terms_accepted: z.boolean().default(false),
  /** Token of the session opened by a previous attempt (keeps the same intent). */
  session_token: z.string().max(128).default(''),
  hp: z.string().max(500).default(''),
  elapsed_ms: z.number().int().min(0).max(86_400_000).default(0),
});
export type SessionPayload = z.infer<typeof sessionPayloadSchema>;
export type SessionPayloadInput = z.input<typeof sessionPayloadSchema>;

export interface SessionResult {
  readonly session_token: string;
  /** `payment`/`setup`: confirm with Stripe.js; `none`: nothing to pay, call complete. */
  readonly intent: { readonly kind: 'payment' | 'setup' | 'none'; readonly client_secret: string | null };
  readonly quote: Quote;
}

/** Where the buyer goes next. `url: null` with `offer`: the hosted offer page; with `thank_you`: the built-in confirmation. */
export interface NextStep {
  readonly kind: 'offer' | 'thank_you';
  readonly url: string | null;
}

export interface CompleteResult {
  readonly status: 'paid' | 'processing' | 'failed';
  readonly message: string | null;
  readonly next: NextStep | null;
  readonly order_number: string | null;
  readonly success_message: string;
}

// ------------------------------------------------------------------ offers

export interface OfferView {
  readonly key: string;
  readonly kind: 'upsell' | 'downsell';
  readonly title: string;
  readonly description: string;
  readonly name: string;
  readonly currency: string;
  readonly amount_minor: number;
  readonly regular_amount_minor: number | null;
  readonly quantity: number;
  readonly recurring: PublicRecurring | null;
  readonly checkout_id: string;
  readonly locale: string;
}

export type OfferState =
  | { readonly status: 'offer'; readonly offer: OfferView }
  | { readonly status: 'done'; readonly next: NextStep; readonly success_message: string };

export interface OfferActionResult {
  readonly status: 'paid' | 'requires_action' | 'failed' | 'declined';
  readonly client_secret: string | null;
  readonly publishable_key: string | null;
  readonly message: string | null;
  readonly next: NextStep | null;
}

export interface AddressSuggestion {
  readonly label: string;
  readonly line1: string;
  readonly street_number: string | null;
  readonly locality: string | null;
  readonly region: string | null;
  readonly postal_code: string | null;
  readonly country_code: string | null;
}
