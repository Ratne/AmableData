import { formFieldSchema, formStyleSchema, FORM_LOCALES, UPDATE_POLICIES } from '@amable/forms';
import { z } from 'zod';

/**
 * Checkout definition: the JSON document edited in the commerce section,
 * stored on the checkout row. Items and offers point at catalog products or
 * subscription plans; prices come from the catalog unless overridden here.
 *
 * Purchase flow: the buyer pays the selected items (+ order bumps) on the
 * checkout, then walks the post-purchase offer chain (one-click upsells and
 * downsells charged on the saved payment method) and lands on the thank-you
 * page.
 */

export const OFFER_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

const id = z.string().min(1).max(64);
const httpUrl = z.union([z.literal(''), z.url({ protocol: /^https?$/ })]).default('');
const cssValue = (fallback: string) =>
  z
    .string()
    .trim()
    .max(200)
    .regex(/^[^{}<>;\\]*$/, 'invalid CSS value')
    .default(fallback);
const priceOverride = z.number().int().min(0).max(100_000_000_00).nullable().default(null);

export const ITEM_KINDS = ['product', 'plan'] as const;
export type CheckoutItemKind = (typeof ITEM_KINDS)[number];

export const checkoutItemSchema = z.object({
  id,
  kind: z.enum(ITEM_KINDS),
  /** Product id (`product`) or subscription plan id (`plan`). */
  ref_id: id,
  quantity: z.number().int().min(1).max(999).default(1),
  /** Price for this checkout (minor units); null = catalog price. Plans: price per period. */
  price_minor: priceOverride,
  /** Empty: catalog name. */
  label: z.string().max(200).default(''),
  description: z.string().max(1000).default(''),
  image_url: httpUrl,
  /** `item_selection: one`: the item selected when the page opens. */
  preselected: z.boolean().default(false),
});
export type CheckoutItem = z.infer<typeof checkoutItemSchema>;

export const BUMP_SKINS = ['classic', 'highlight', 'dashed', 'minimal', 'ribbon'] as const;
export type BumpSkin = (typeof BUMP_SKINS)[number];
export const BUMP_POSITIONS = ['below_items', 'above_payment', 'below_payment'] as const;

/** Order bump: one-checkbox add-on offered on the checkout itself (products only). */
export const bumpSchema = z.object({
  id,
  product_id: id,
  quantity: z.number().int().min(1).max(999).default(1),
  price_minor: priceOverride,
  title: z.string().trim().min(1).max(200),
  description: z.string().max(2000).default(''),
  image_url: httpUrl,
  skin: z.enum(BUMP_SKINS).default('classic'),
  position: z.enum(BUMP_POSITIONS).default('above_payment'),
  /** Box accent; empty: the checkout primary color. */
  color: cssValue(''),
  checked: z.boolean().default(false),
});
export type Bump = z.infer<typeof bumpSchema>;

export const OFFER_KINDS = ['upsell', 'downsell'] as const;

/**
 * Post-purchase offer. Accepting charges the saved payment method at once
 * (one click); `on_accept` / `on_decline` name the next offer (empty: the
 * thank-you page).
 */
export const offerSchema = z.object({
  key: z.string().regex(OFFER_KEY_RE, 'lowercase letters, digits, - and _'),
  kind: z.enum(OFFER_KINDS).default('upsell'),
  item_kind: z.enum(ITEM_KINDS).default('product'),
  ref_id: id,
  quantity: z.number().int().min(1).max(999).default(1),
  price_minor: priceOverride,
  title: z.string().trim().min(1).max(200),
  description: z.string().max(2000).default(''),
  image_url: httpUrl,
  /** Landing page holding the offer block; empty: the hosted offer page. */
  page_url: httpUrl,
  on_accept: z.union([z.literal(''), z.string().regex(OFFER_KEY_RE)]).default(''),
  on_decline: z.union([z.literal(''), z.string().regex(OFFER_KEY_RE)]).default(''),
});
export type Offer = z.infer<typeof offerSchema>;

export const CONTACT_FIELD_MODES = ['hidden', 'optional', 'required'] as const;
export type ContactFieldMode = (typeof CONTACT_FIELD_MODES)[number];

/** Buyer fields always present (email is always required: receipts, contact matching). */
export const checkoutContactSchema = z.object({
  name: z.enum(CONTACT_FIELD_MODES).default('required'),
  phone: z.enum(CONTACT_FIELD_MODES).default('optional'),
  company: z.enum(CONTACT_FIELD_MODES).default('hidden'),
  address: z.enum(CONTACT_FIELD_MODES).default('hidden'),
  /** Suggestions while typing the street (the CRM address lookup). */
  address_autocomplete: z.boolean().default(true),
  default_country: z
    .string()
    .regex(/^([A-Z]{2})?$/)
    .default('IT'),
});
export type CheckoutContact = z.infer<typeof checkoutContactSchema>;

export const checkoutSettingsSchema = z.object({
  /** `all`: every item is bought; `one`: the buyer picks one (e.g. plans). */
  item_selection: z.enum(['all', 'one']).default('all'),
  allow_quantity: z.boolean().default(false),
  promo_codes: z.boolean().default(true),
  /** Query parameter that applies a promo code on load (empty: disabled). */
  promo_param: z
    .string()
    .regex(/^[A-Za-z0-9_.-]{0,64}$/)
    .default('promo'),
  first_offer: z.union([z.literal(''), z.string().regex(OFFER_KEY_RE)]).default(''),
  /** Where the buyer lands at the end; empty: the built-in confirmation. */
  thank_you_url: httpUrl,
  success_message: z.string().max(2000).default(''),
  button_label: z.string().max(100).default(''),
  heading: z.string().max(200).default(''),
  terms_url: httpUrl,
  terms_label: z.string().max(300).default(''),
  locale: z.enum(FORM_LOCALES).default('auto'),
  /** Hostnames allowed to embed the checkout (empty: any). Subdomains match. */
  allowed_domains: z
    .array(
      z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9.-]{1,253}$/),
    )
    .max(50)
    .default([]),
  hosted_enabled: z.boolean().default(true),
  /** Minutes the post-purchase offers stay chargeable after the payment. */
  offer_window_minutes: z.number().int().min(5).max(24 * 60).default(60),
});
export type CheckoutSettings = z.infer<typeof checkoutSettingsSchema>;

export const checkoutStyleSchema = formStyleSchema.extend({
  layout: z.enum(['one_column', 'two_columns']).default('two_columns'),
  summary_background: cssValue('#f9fafb'),
});
export type CheckoutStyle = z.infer<typeof checkoutStyleSchema>;

export const checkoutCrmSchema = z.object({
  tag_ids: z.array(z.string().min(1).max(64)).max(50).default([]),
  lead_source_id: z.string().min(1).max(64).nullable().default(null),
  owner_id: z.string().min(1).max(64).nullable().default(null),
  update_policy: z.enum(UPDATE_POLICIES).default('fill_empty'),
});

/** Field keys of the built-in buyer fields: custom fields cannot reuse them. */
export const RESERVED_FIELD_KEYS = [
  'email',
  'given_name',
  'family_name',
  'phone',
  'company_name',
  'address_line1',
  'address_line2',
  'address_city',
  'address_postal_code',
  'address_region',
  'address_country',
] as const;

export const checkoutDefinitionSchema = z
  .object({
    items: z.array(checkoutItemSchema).max(20).default([]),
    bumps: z.array(bumpSchema).max(5).default([]),
    offers: z.array(offerSchema).max(10).default([]),
    /** Extra fields (same builder as forms); `prefill_param` reads them from the URL. */
    fields: z.array(formFieldSchema).max(50).default([]),
    contact: checkoutContactSchema.default(() => checkoutContactSchema.parse({})),
    settings: checkoutSettingsSchema.default(() => checkoutSettingsSchema.parse({})),
    style: checkoutStyleSchema.default(() => checkoutStyleSchema.parse({})),
    crm: checkoutCrmSchema.default(() => checkoutCrmSchema.parse({})),
  })
  .superRefine((d, ctx) => {
    const unique = (values: string[], path: (i: number) => (string | number)[], message: string): void => {
      const seen = new Set<string>();
      values.forEach((v, i) => {
        if (seen.has(v)) ctx.addIssue({ code: 'custom', path: path(i), message });
        seen.add(v);
      });
    };
    unique(d.items.map((i) => i.id), (i) => ['items', i, 'id'], 'duplicate item id');
    unique(d.bumps.map((b) => b.id), (i) => ['bumps', i, 'id'], 'duplicate bump id');
    unique(d.offers.map((o) => o.key), (i) => ['offers', i, 'key'], 'duplicate offer key');
    unique(d.fields.map((f) => f.key), (i) => ['fields', i, 'key'], 'duplicate field key');
    const reserved = new Set<string>(RESERVED_FIELD_KEYS);
    d.fields.forEach((f, i) => {
      if (reserved.has(f.key)) {
        ctx.addIssue({ code: 'custom', path: ['fields', i, 'key'], message: 'reserved for the buyer fields' });
      }
    });
    if (d.settings.item_selection === 'all' && d.items.filter((i) => i.kind === 'plan').length > 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['items'],
        message: 'only one subscription plan can be bought at a time (use "pick one")',
      });
    }
    const keys = new Set(d.offers.map((o) => o.key));
    const known = (key: string): boolean => key === '' || keys.has(key);
    if (!known(d.settings.first_offer)) {
      ctx.addIssue({ code: 'custom', path: ['settings', 'first_offer'], message: 'unknown offer' });
    }
    d.offers.forEach((o, i) => {
      if (!known(o.on_accept) || o.on_accept === o.key) {
        ctx.addIssue({ code: 'custom', path: ['offers', i, 'on_accept'], message: 'unknown offer' });
      }
      if (!known(o.on_decline) || o.on_decline === o.key) {
        ctx.addIssue({ code: 'custom', path: ['offers', i, 'on_decline'], message: 'unknown offer' });
      }
    });
  });
export type CheckoutDefinition = z.infer<typeof checkoutDefinitionSchema>;
export type CheckoutDefinitionInput = z.input<typeof checkoutDefinitionSchema>;

export function defaultCheckoutDefinition(): CheckoutDefinition {
  return checkoutDefinitionSchema.parse({});
}

export const CHECKOUT_STATUSES = ['draft', 'active', 'archived'] as const;
export type CheckoutStatus = (typeof CHECKOUT_STATUSES)[number];
