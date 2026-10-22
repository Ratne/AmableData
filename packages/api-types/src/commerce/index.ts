import { z } from 'zod';
import { dateTimeSchema, idSchema, optText, timestampSchema } from '../crm/common';
import { customFieldValuesSchema } from '../crm/custom-fields';
import { isCurrencyCode } from './currencies';

export * from './currencies';

/**
 * E-commerce REST v2 schemas: catalog, plans, promo codes, orders, payments,
 * refunds, subscriptions and invoices. Money is always an integer amount of
 * minor units (cents) next to an ISO 4217 currency; tax rates are basis points
 * (2200 = 22%).
 */

/** Upper bound for any amount (1 billion in major units) — keeps integer math exact. */
export const MAX_MONEY_MINOR = 100_000_000_000;

export const currencySchema = z
  .string()
  .regex(/^[A-Z]{3}$/, 'expected an ISO 4217 code')
  .refine((code: string): boolean => isCurrencyCode(code), 'unknown or withdrawn ISO 4217 currency');
export const moneySchema = z.number().int().min(0).max(MAX_MONEY_MINOR);
export const taxRateBpsSchema = z.number().int().min(0).max(10_000);

const listQuery = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
};
const boolQuery = z.enum(['true', 'false']).optional();

// ------------------------------------------------------------- categories

export const createProductCategorySchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  description: optText(2000),
  position: z.number().int().min(0).optional(),
});
export const updateProductCategorySchema = createProductCategorySchema.partial();
export type CreateProductCategoryInput = z.infer<typeof createProductCategorySchema>;
export type UpdateProductCategoryInput = z.infer<typeof updateProductCategorySchema>;

export const productCategorySchema = z.object({
  id: idSchema,
  name: z.string(),
  description: z.string().nullable(),
  position: z.number().int(),
  product_count: z.number().int(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type ProductCategory = z.infer<typeof productCategorySchema>;

// ------------------------------------------------------------------ plans

export const BILLING_INTERVALS = ['day', 'week', 'month', 'year'] as const;
export const billingIntervalSchema = z.enum(BILLING_INTERVALS);
export type BillingInterval = z.infer<typeof billingIntervalSchema>;

export const createPlanSchema = z.strictObject({
  name: z.string().trim().min(1).max(255),
  interval: billingIntervalSchema,
  interval_count: z.number().int().min(1).max(36).optional(),
  trial_days: z.number().int().min(0).max(730).optional(),
  /** Price of one billing period; currency is the product's. */
  price_minor: moneySchema,
  /** One-off fee charged with the first order of the subscription (activation). */
  setup_fee_minor: moneySchema.optional(),
  active: z.boolean().optional(),
  position: z.number().int().min(0).optional(),
});
export const updatePlanSchema = createPlanSchema.partial();
export type CreatePlanInput = z.infer<typeof createPlanSchema>;
export type UpdatePlanInput = z.infer<typeof updatePlanSchema>;

export const planSchema = z.object({
  id: idSchema,
  product_id: idSchema,
  name: z.string(),
  interval: billingIntervalSchema,
  interval_count: z.number().int(),
  trial_days: z.number().int(),
  price_minor: z.number().int(),
  setup_fee_minor: z.number().int(),
  currency: z.string(),
  active: z.boolean(),
  position: z.number().int(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type Plan = z.infer<typeof planSchema>;

export const listPlansQuerySchema = z.object({
  ...listQuery,
  product_id: idSchema.optional(),
  active: boolQuery,
});
export type ListPlansQuery = z.infer<typeof listPlansQuerySchema>;

// --------------------------------------------------------------- products

export const createProductSchema = z.strictObject({
  name: z.string().trim().min(1).max(255),
  description: optText(10_000),
  sku: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[\w.\-/]+$/, 'letters, digits, _ . - / only')
    .nullable()
    .optional(),
  category_id: idSchema.nullable().optional(),
  price_minor: moneySchema,
  /** Defaults to the tenant default currency. */
  currency: currencySchema.optional(),
  /** Default tax rate of order lines using this product. */
  tax_rate_bps: taxRateBpsSchema.optional(),
  active: z.boolean().optional(),
  /** Subscription plans created together with the product. */
  plans: z.array(createPlanSchema).max(20).optional(),
});
export const updateProductSchema = createProductSchema.omit({ plans: true }).partial();
export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;

export const productSchema = z.object({
  id: idSchema,
  name: z.string(),
  description: z.string().nullable(),
  sku: z.string().nullable(),
  category_id: idSchema.nullable(),
  price_minor: z.number().int(),
  currency: z.string(),
  tax_rate_bps: z.number().int(),
  active: z.boolean(),
  plans: z.array(planSchema),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type Product = z.infer<typeof productSchema>;

export const listProductsQuerySchema = z.object({
  ...listQuery,
  q: z.string().trim().max(200).optional(),
  category_id: idSchema.optional(),
  active: boolQuery,
});
export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;

// ------------------------------------------------------------ promo codes

export const PROMO_KINDS = ['percent', 'fixed'] as const;
/**
 * How long the discount lasts on a subscription: the first billed period only,
 * the first `duration_periods` periods, or every renewal.
 */
export const PROMO_DURATIONS = ['once', 'repeating', 'forever'] as const;
export type PromoDuration = (typeof PROMO_DURATIONS)[number];

export const createPromoCodeSchema = z.strictObject({
  /** Case-insensitive; stored upper-case. */
  code: z
    .string()
    .trim()
    .min(3)
    .max(40)
    .regex(/^[A-Za-z0-9_-]+$/, 'letters, digits, _ and - only'),
  description: optText(500),
  kind: z.enum(PROMO_KINDS),
  /** percent: 1..10000 basis points (1000 = 10%). */
  percent_bps: z.number().int().min(1).max(10_000).nullable().optional(),
  /** fixed: amount off the eligible subtotal, in `currency`. */
  amount_minor: moneySchema.nullable().optional(),
  currency: currencySchema.nullable().optional(),
  min_subtotal_minor: moneySchema.nullable().optional(),
  /** Restricts the discount to these products (default: every line). */
  product_ids: z.array(idSchema).max(100).nullable().optional(),
  max_redemptions: z.number().int().min(1).nullable().optional(),
  max_per_contact: z.number().int().min(1).nullable().optional(),
  starts_at: dateTimeSchema.nullable().optional(),
  ends_at: dateTimeSchema.nullable().optional(),
  active: z.boolean().optional(),
  /** Subscriptions only; default `once`. */
  duration: z.enum(PROMO_DURATIONS).optional(),
  /** `repeating`: number of billed periods the discount covers. */
  duration_periods: z.number().int().min(1).max(120).nullable().optional(),
});
export const updatePromoCodeSchema = createPromoCodeSchema
  .omit({ code: true, kind: true })
  .partial();
export type CreatePromoCodeInput = z.infer<typeof createPromoCodeSchema>;
export type UpdatePromoCodeInput = z.infer<typeof updatePromoCodeSchema>;

export const promoCodeSchema = z.object({
  id: idSchema,
  code: z.string(),
  description: z.string().nullable(),
  kind: z.enum(PROMO_KINDS),
  percent_bps: z.number().int().nullable(),
  amount_minor: z.number().int().nullable(),
  currency: z.string().nullable(),
  min_subtotal_minor: z.number().int().nullable(),
  product_ids: z.array(idSchema).nullable(),
  max_redemptions: z.number().int().nullable(),
  max_per_contact: z.number().int().nullable(),
  redemptions: z.number().int(),
  starts_at: timestampSchema.nullable(),
  ends_at: timestampSchema.nullable(),
  active: z.boolean(),
  duration: z.enum(PROMO_DURATIONS),
  duration_periods: z.number().int().nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type PromoCode = z.infer<typeof promoCodeSchema>;

// ----------------------------------------------------------------- orders

export const ORDER_STATUSES = [
  'draft',
  'unpaid',
  'partially_paid',
  'paid',
  'refunded',
  'cancelled',
] as const;
export const orderStatusSchema = z.enum(ORDER_STATUSES);
export type OrderStatus = z.infer<typeof orderStatusSchema>;
export const ORDER_SOURCES = ['manual', 'api', 'subscription', 'checkout'] as const;

export const orderItemInputSchema = z.strictObject({
  /** Catalog product: name, SKU, price and tax rate default from it. */
  product_id: idSchema.nullable().optional(),
  /** Required without `product_id`. */
  name: z.string().trim().min(1).max(255).optional(),
  sku: z.string().trim().max(64).nullable().optional(),
  description: optText(2000),
  quantity: z.number().int().min(1).max(100_000).default(1),
  unit_price_minor: moneySchema.optional(),
  tax_rate_bps: taxRateBpsSchema.optional(),
});
export type OrderItemInput = z.input<typeof orderItemInputSchema>;

const orderEditable = {
  company_id: idSchema.nullable().optional(),
  owner_id: idSchema.nullable().optional(),
  notes: optText(10_000),
  due_at: dateTimeSchema.nullable().optional(),
  /** Analytics visitor id (revenue attribution); copied into every money event. */
  analytics_visitor_id: z.string().trim().max(128).nullable().optional(),
  custom_fields: customFieldValuesSchema.optional(),
};

export const createOrderSchema = z.strictObject({
  contact_id: idSchema,
  /** `draft` orders stay editable; `unpaid` (default) finalizes and issues the invoice. */
  status: z.enum(['draft', 'unpaid']).optional(),
  /** Defaults to the first product's currency, then the tenant default. */
  currency: currencySchema.optional(),
  items: z.array(orderItemInputSchema).min(1).max(200),
  promo_code: z.string().trim().min(1).max(40).nullable().optional(),
  shipping_minor: moneySchema.optional(),
  /** Back-dating for imports; defaults to now. */
  order_date: dateTimeSchema.optional(),
  ...orderEditable,
});
export type CreateOrderInput = z.input<typeof createOrderSchema>;

/** Drafts accept every field; finalized orders only `orderEditable` fields. */
export const updateOrderSchema = z.strictObject({
  currency: currencySchema.optional(),
  items: z.array(orderItemInputSchema).min(1).max(200).optional(),
  promo_code: z.string().trim().min(1).max(40).nullable().optional(),
  shipping_minor: moneySchema.optional(),
  order_date: dateTimeSchema.optional(),
  ...orderEditable,
});
export type UpdateOrderInput = z.input<typeof updateOrderSchema>;

export const orderItemSchema = z.object({
  id: idSchema,
  product_id: idSchema.nullable(),
  plan_id: idSchema.nullable(),
  name: z.string(),
  sku: z.string().nullable(),
  description: z.string().nullable(),
  quantity: z.number().int(),
  unit_price_minor: z.number().int(),
  /** quantity × unit price. */
  subtotal_minor: z.number().int(),
  /** Share of the order discount allocated to this line. */
  discount_minor: z.number().int(),
  tax_rate_bps: z.number().int(),
  /** Tax on (subtotal − discount), rounded half up. */
  tax_minor: z.number().int(),
  total_minor: z.number().int(),
});
export type OrderItem = z.infer<typeof orderItemSchema>;

export const orderSchema = z.object({
  id: idSchema,
  number: z.string(),
  contact_id: idSchema,
  company_id: idSchema.nullable(),
  owner_id: idSchema.nullable(),
  status: orderStatusSchema,
  source: z.enum(ORDER_SOURCES),
  currency: z.string(),
  subtotal_minor: z.number().int(),
  discount_minor: z.number().int(),
  tax_minor: z.number().int(),
  shipping_minor: z.number().int(),
  total_minor: z.number().int(),
  paid_minor: z.number().int(),
  refunded_minor: z.number().int(),
  /** Amount still collectable: total − paid (0 for cancelled/refunded orders). */
  balance_minor: z.number().int(),
  promo_code: z.string().nullable(),
  notes: z.string().nullable(),
  subscription_id: idSchema.nullable(),
  billing_period_start: timestampSchema.nullable(),
  billing_period_end: timestampSchema.nullable(),
  analytics_visitor_id: z.string().nullable(),
  /** Checkout the order was bought through (with `parent_order_id` for post-purchase offers). */
  checkout_id: idSchema.nullable(),
  parent_order_id: idSchema.nullable(),
  /** utm_* and click ids of the purchase (checkout orders). */
  attribution: z.record(z.string(), z.string()).nullable(),
  items: z.array(orderItemSchema),
  invoice: z.object({ id: idSchema, number: z.string() }).nullable(),
  custom_fields: customFieldValuesSchema,
  order_date: timestampSchema,
  due_at: timestampSchema.nullable(),
  finalized_at: timestampSchema.nullable(),
  paid_at: timestampSchema.nullable(),
  cancelled_at: timestampSchema.nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type Order = z.infer<typeof orderSchema>;

export const listOrdersQuerySchema = z.object({
  ...listQuery,
  q: z.string().trim().max(200).optional(),
  status: orderStatusSchema.optional(),
  contact_id: idSchema.optional(),
  subscription_id: idSchema.optional(),
  source: z.enum(ORDER_SOURCES).optional(),
});
export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;

export const cancelOrderSchema = z.strictObject({ reason: optText(500) });
export type CancelOrderInput = z.infer<typeof cancelOrderSchema>;

export const orderItemParamSchema = z.object({ id: idSchema, itemId: idSchema });

// --------------------------------------------------------------- payments

export const PAYMENT_METHODS = [
  'card',
  'bank_transfer',
  'cash',
  'check',
  'paypal',
  'direct_debit',
  'other',
] as const;
export const PAYMENT_STATUSES = ['succeeded', 'failed'] as const;

export const createPaymentSchema = z.strictObject({
  amount_minor: z.number().int().min(1).max(MAX_MONEY_MINOR),
  method: z.enum(PAYMENT_METHODS),
  /** `failed` records a declined charge (no money moves; subscriptions go past_due). */
  status: z.enum(PAYMENT_STATUSES).optional(),
  /** External reference; recording the same id twice returns the first payment. */
  transaction_id: z.string().trim().min(1).max(255).nullable().optional(),
  paid_at: dateTimeSchema.optional(),
  failure_reason: optText(500),
  notes: optText(2000),
});
export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;

export const paymentSchema = z.object({
  id: idSchema,
  order_id: idSchema,
  contact_id: idSchema,
  status: z.enum(PAYMENT_STATUSES),
  method: z.enum(PAYMENT_METHODS),
  amount_minor: z.number().int(),
  currency: z.string(),
  refunded_minor: z.number().int(),
  transaction_id: z.string().nullable(),
  failure_reason: z.string().nullable(),
  notes: z.string().nullable(),
  paid_at: timestampSchema,
  created_at: timestampSchema,
});
export type Payment = z.infer<typeof paymentSchema>;

export const listPaymentsQuerySchema = z.object({
  ...listQuery,
  order_id: idSchema.optional(),
  contact_id: idSchema.optional(),
  status: z.enum(PAYMENT_STATUSES).optional(),
  from: dateTimeSchema.optional(),
  to: dateTimeSchema.optional(),
});
export type ListPaymentsQuery = z.infer<typeof listPaymentsQuerySchema>;

// ---------------------------------------------------------------- refunds

export const createRefundSchema = z.strictObject({
  /** Defaults to the whole refundable amount (full refund). */
  amount_minor: z.number().int().min(1).max(MAX_MONEY_MINOR).optional(),
  /** Refund against one payment (bounded by its unrefunded amount). */
  payment_id: idSchema.nullable().optional(),
  reason: optText(500),
  /** External reference; recording the same id twice returns the first refund. */
  transaction_id: z.string().trim().min(1).max(255).nullable().optional(),
  refunded_at: dateTimeSchema.optional(),
  /**
   * Also sends the money back through Stripe (payments settled by the
   * workspace Stripe account only). Stripe sets the transaction id and date.
   */
  stripe: z.boolean().optional(),
});
export type CreateRefundInput = z.infer<typeof createRefundSchema>;

export const refundSchema = z.object({
  id: idSchema,
  order_id: idSchema,
  payment_id: idSchema.nullable(),
  contact_id: idSchema,
  amount_minor: z.number().int(),
  currency: z.string(),
  reason: z.string().nullable(),
  transaction_id: z.string().nullable(),
  refunded_at: timestampSchema,
  created_at: timestampSchema,
});
export type Refund = z.infer<typeof refundSchema>;

export const listRefundsQuerySchema = z.object({
  ...listQuery,
  order_id: idSchema.optional(),
  contact_id: idSchema.optional(),
});
export type ListRefundsQuery = z.infer<typeof listRefundsQuerySchema>;

// ---------------------------------------------------------- subscriptions

export const SUBSCRIPTION_STATUSES = [
  'trialing',
  'active',
  'past_due',
  'paused',
  'cancelled',
] as const;
export const subscriptionStatusSchema = z.enum(SUBSCRIPTION_STATUSES);
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;

export const createSubscriptionSchema = z.strictObject({
  contact_id: idSchema,
  plan_id: idSchema,
  quantity: z.number().int().min(1).max(10_000).optional(),
  /** Overrides the plan price (per unit, per period). */
  unit_price_minor: moneySchema.optional(),
  /** Overrides the plan trial; 0 starts billing immediately. */
  trial_days: z.number().int().min(0).max(730).optional(),
  tax_rate_bps: taxRateBpsSchema.optional(),
  /** Back-dating for imports; defaults to now. */
  start_at: dateTimeSchema.optional(),
  analytics_visitor_id: z.string().trim().max(128).nullable().optional(),
});
export type CreateSubscriptionInput = z.infer<typeof createSubscriptionSchema>;

export const cancelSubscriptionSchema = z.strictObject({
  /** Default true: keep the subscription until the end of the paid period. */
  at_period_end: z.boolean().optional(),
  reason: optText(500),
});
export type CancelSubscriptionInput = z.infer<typeof cancelSubscriptionSchema>;

export const changePlanSchema = z.strictObject({
  plan_id: idSchema,
  quantity: z.number().int().min(1).max(10_000).optional(),
  unit_price_minor: moneySchema.optional(),
});
export type ChangePlanInput = z.infer<typeof changePlanSchema>;

export const subscriptionSchema = z.object({
  id: idSchema,
  contact_id: idSchema,
  product_id: idSchema,
  plan_id: idSchema,
  status: subscriptionStatusSchema,
  quantity: z.number().int(),
  unit_price_minor: z.number().int(),
  /** unit price × quantity, before tax. */
  amount_minor: z.number().int(),
  currency: z.string(),
  interval: billingIntervalSchema,
  interval_count: z.number().int(),
  tax_rate_bps: z.number().int(),
  started_at: timestampSchema,
  trial_ends_at: timestampSchema.nullable(),
  current_period_start: timestampSchema.nullable(),
  current_period_end: timestampSchema.nullable(),
  next_bill_at: timestampSchema.nullable(),
  cancel_at_period_end: z.boolean(),
  cancel_reason: z.string().nullable(),
  cancelled_at: timestampSchema.nullable(),
  paused_at: timestampSchema.nullable(),
  ended_at: timestampSchema.nullable(),
  analytics_visitor_id: z.string().nullable(),
  /** Promo discount still applied to renewals; `periods_left: null` = forever. */
  discount: z
    .object({
      promo_code: z.string().nullable(),
      kind: z.enum(PROMO_KINDS),
      percent_bps: z.number().int().nullable(),
      amount_minor: z.number().int().nullable(),
      periods_left: z.number().int().nullable(),
    })
    .nullable(),
  /** Renewals are charged automatically on the saved Stripe payment method. */
  autopay: z.boolean(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type Subscription = z.infer<typeof subscriptionSchema>;

export const listSubscriptionsQuerySchema = z.object({
  ...listQuery,
  status: subscriptionStatusSchema.optional(),
  contact_id: idSchema.optional(),
  plan_id: idSchema.optional(),
  product_id: idSchema.optional(),
});
export type ListSubscriptionsQuery = z.infer<typeof listSubscriptionsQuerySchema>;

// --------------------------------------------------------------- invoices

export const INVOICE_STATUSES = ['open', 'paid', 'void'] as const;

export const invoiceSchema = z.object({
  id: idSchema,
  /** `<prefix><year>-<sequence>`; the sequence restarts every year, gapless per tenant. */
  number: z.string(),
  year: z.number().int(),
  sequence: z.number().int(),
  order_id: idSchema,
  contact_id: idSchema,
  status: z.enum(INVOICE_STATUSES),
  currency: z.string(),
  subtotal_minor: z.number().int(),
  discount_minor: z.number().int(),
  tax_minor: z.number().int(),
  shipping_minor: z.number().int(),
  total_minor: z.number().int(),
  items: z.array(orderItemSchema),
  issued_at: timestampSchema,
  due_at: timestampSchema.nullable(),
  paid_at: timestampSchema.nullable(),
  voided_at: timestampSchema.nullable(),
});
export type Invoice = z.infer<typeof invoiceSchema>;

export const listInvoicesQuerySchema = z.object({
  ...listQuery,
  status: z.enum(INVOICE_STATUSES).optional(),
  contact_id: idSchema.optional(),
  year: z.coerce.number().int().min(2000).max(9999).optional(),
});
export type ListInvoicesQuery = z.infer<typeof listInvoicesQuerySchema>;

// --------------------------------------------------------------- settings

export const commerceSettingsSchema = z.object({
  default_currency: z.string(),
  order_prefix: z.string(),
  invoice_prefix: z.string(),
  /** Days between invoice issue and due date for manual/API orders. */
  payment_terms_days: z.number().int(),
  /** Tax rate of new products created without `tax_rate_bps`. */
  default_tax_rate_bps: z.number().int(),
});
export type CommerceSettings = z.infer<typeof commerceSettingsSchema>;

export const updateCommerceSettingsSchema = z.strictObject({
  default_currency: currencySchema.optional(),
  order_prefix: z
    .string()
    .max(12)
    .regex(/^[A-Za-z0-9_-]*$/)
    .optional(),
  invoice_prefix: z
    .string()
    .max(12)
    .regex(/^[A-Za-z0-9_-]*$/)
    .optional(),
  payment_terms_days: z.number().int().min(0).max(365).optional(),
  default_tax_rate_bps: taxRateBpsSchema.optional(),
});
export type UpdateCommerceSettingsInput = z.infer<typeof updateCommerceSettingsSchema>;

// --------------------------------------------------------------- checkouts

export const CHECKOUT_STATUSES = ['draft', 'active', 'archived'] as const;

/**
 * Checkout page. `definition` is the document of `@amable/checkout`
 * (`checkoutDefinitionSchema`: items, custom fields, bumps, offer chain,
 * design), validated by the server on write.
 */
export const checkoutSchema = z.object({
  id: idSchema,
  name: z.string(),
  status: z.enum(CHECKOUT_STATUSES),
  definition: z.record(z.string(), z.unknown()),
  revision: z.number().int(),
  stats: z.object({
    sessions: z.number().int(),
    paid: z.number().int(),
    revenue_minor: z.number().int(),
    offers_accepted: z.number().int(),
  }),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type Checkout = z.infer<typeof checkoutSchema>;

export const checkoutSummarySchema = checkoutSchema.omit({ definition: true }).extend({
  item_count: z.number().int(),
  bump_count: z.number().int(),
  offer_count: z.number().int(),
});
export type CheckoutSummary = z.infer<typeof checkoutSummarySchema>;

export const createCheckoutSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  status: z.enum(CHECKOUT_STATUSES).optional(),
  definition: z.record(z.string(), z.unknown()).optional(),
});
export type CreateCheckoutInput = z.infer<typeof createCheckoutSchema>;

export const updateCheckoutSchema = createCheckoutSchema.partial().extend({
  /** Optimistic concurrency: the revision the edit started from. */
  revision: z.number().int().optional(),
});
export type UpdateCheckoutInput = z.infer<typeof updateCheckoutSchema>;

export const listCheckoutsQuerySchema = z.object({
  ...listQuery,
  status: z.enum(CHECKOUT_STATUSES).optional(),
  q: z.string().max(200).optional(),
});
export type ListCheckoutsQuery = z.infer<typeof listCheckoutsQuerySchema>;

export const checkoutEmbedSchema = z.object({
  checkout_id: idSchema,
  tenant: z.string(),
  script_url: z.string(),
  hosted_url: z.string(),
  snippet: z.string(),
  offer_snippet: z.string(),
});
export type CheckoutEmbed = z.infer<typeof checkoutEmbedSchema>;

// ----------------------------------------------------------------- stripe

/**
 * Stripe account of the workspace (its own API keys). Secrets never come
 * back: only their last characters, to recognize them.
 */
export const stripeSettingsSchema = z.object({
  configured: z.boolean(),
  /** From the key prefix (`pk_test_` / `pk_live_`). */
  mode: z.enum(['test', 'live']).nullable(),
  publishable_key: z.string().nullable(),
  secret_key_hint: z.string().nullable(),
  webhook_secret_hint: z.string().nullable(),
  /** Endpoint to register in the Stripe dashboard (events: payment_intent.*, setup_intent.succeeded, charge.refunded). */
  webhook_url: z.string().nullable(),
  updated_at: timestampSchema.nullable(),
});
export type StripeSettings = z.infer<typeof stripeSettingsSchema>;

export const updateStripeSettingsSchema = z.strictObject({
  publishable_key: z
    .string()
    .trim()
    .regex(/^pk_(test|live)_[A-Za-z0-9]{10,250}$/, 'expected a publishable key (pk_test_… / pk_live_…)'),
  /** Secret or restricted key; omitted keeps the stored one. */
  secret_key: z
    .string()
    .trim()
    .regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]{10,250}$/, 'expected a secret key (sk_… / rk_…)')
    .optional(),
  /** Signing secret of the webhook endpoint (`whsec_…`); omitted keeps the stored one. */
  webhook_secret: z
    .string()
    .trim()
    .regex(/^whsec_[A-Za-z0-9+/=]{10,250}$/, 'expected a webhook signing secret (whsec_…)')
    .optional(),
});
export type UpdateStripeSettingsInput = z.infer<typeof updateStripeSettingsSchema>;

export const stripeCheckResultSchema = z.object({
  ok: z.boolean(),
  /** Stripe error message when the key is rejected. */
  message: z.string().nullable(),
});
export type StripeCheckResult = z.infer<typeof stripeCheckResultSchema>;

export const billingRunResultSchema = z.object({
  processed: z.number().int(),
  renewals: z.number().int(),
  ended: z.number().int(),
  /** Trials that reached their end and produced their first order. */
  trials_ended: z.number().int(),
  /** Earliest pending bill date after the run (drives the DO alarm). */
  next_due_at: timestampSchema.nullable(),
});
export type BillingRunResult = z.infer<typeof billingRunResultSchema>;
