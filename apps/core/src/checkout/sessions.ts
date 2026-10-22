import {
  CHECKOUT_STRINGS,
  RESERVED_FIELD_KEYS,
  resolveCheckoutLocale,
  selectionSchema,
  sessionPayloadSchema,
  type CheckoutContact,
  type CheckoutDefinition,
  type CheckoutLocale,
  type CompleteResult,
  type NextStep,
  type PublicCheckoutConfig,
  type Quote,
  type Selection,
  type SelectionInput,
  type SessionPayloadInput,
} from '@amable/checkout';
import {
  formDefinitionSchema,
  formFieldSchema,
  TRACKING_PARAMS,
  validateSubmission,
  type FormField,
  type FormFieldInput,
  type SubmissionValues,
} from '@amable/forms';
import type { CrmContext } from '../crm/context';
import { CrmError, invalidMany } from '../crm/errors';
import { parseJson } from '../crm/util';
import { getSettings } from '../commerce/settings';
import { createOrderRow, deleteOrder, finalizeDraftRow, replaceDraftLines } from '../commerce/orders';
import { recordPayment } from '../commerce/payments';
import { getOrderRow } from '../commerce/rows';
import { startCheckoutSubscription } from '../commerce/subscriptions';
import { readStripeAccount } from '../commerce/stripe/account';
import { applyToContact } from '../forms/mapping';
import { activeCheckoutRow, getCheckoutRow, storedCheckoutDefinition, type CheckoutRow } from './checkouts';
import { buildCart, priceCart, recurringOf, resolveCatalog, type Cart, type PricedCart } from './pricing';

/** Unpaid sessions can be resumed for this long. */
export const OPEN_SESSION_TTL_MS = 2 * 3_600_000;

export type SessionStatus = 'open' | 'processing' | 'paid' | 'completed' | 'expired';

export interface SessionRow {
  id: string;
  checkout_id: string;
  token_hash: string;
  status: SessionStatus;
  contact_id: string | null;
  order_id: string | null;
  currency: string;
  amount_minor: number;
  selection: string;
  field_values: string;
  tracking: string;
  visitor_id: string | null;
  page_url: string | null;
  locale: string | null;
  intent_kind: 'payment' | 'setup' | null;
  intent_id: string | null;
  stripe_customer_id: string | null;
  stripe_payment_method_id: string | null;
  current_offer: string | null;
  pending_offer: string | null;
  pending_intent_id: string | null;
  offer_attempts: number;
  offers: string;
  last_error: string | null;
  expires_at: number;
  paid_at: number | null;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
}

/** What the purchase will create once paid (kept on the session between the steps). */
export interface SessionPlan {
  selection: Selection;
  promoCode: string;
  subscription: {
    planId: string;
    quantity: number;
    unitPriceMinor: number;
    discount: {
      promoId: string;
      code: string;
      kind: 'percent' | 'fixed';
      percentBps: number | null;
      amountMinor: number | null;
      periodsLeft: number | null;
    } | null;
  } | null;
}

export interface OfferRecord {
  key: string;
  outcome: 'accepted' | 'declined' | 'failed';
  order_id: string | null;
  at: number;
}

export function sessionPlanOf(row: SessionRow): SessionPlan {
  return parseJson<SessionPlan>(row.selection, {
    selection: { items: [], quantities: {}, bumps: [] },
    promoCode: '',
    subscription: null,
  });
}

export function offersOf(row: SessionRow): OfferRecord[] {
  return parseJson<OfferRecord[]>(row.offers, []);
}

export function trackingOf(row: SessionRow): Record<string, string> {
  return parseJson<Record<string, string>>(row.tracking, {});
}

export function sessionByToken(ctx: CrmContext, tokenHash: string): SessionRow {
  const row = ctx.db.all<SessionRow>(
    `SELECT * FROM crm_checkout_sessions WHERE token_hash = ?`,
    tokenHash,
  )[0];
  if (row === undefined) throw new CrmError('not_found', 'checkout session not found');
  return row;
}

export function sessionById(ctx: CrmContext, id: string): SessionRow {
  const row = ctx.db.all<SessionRow>(`SELECT * FROM crm_checkout_sessions WHERE id = ?`, id)[0];
  if (row === undefined) throw new CrmError('not_found', 'checkout session not found');
  return row;
}

export function localeOf(d: CheckoutDefinition, browserLocale: string | null): CheckoutLocale {
  return resolveCheckoutLocale(d.settings.locale, browserLocale === null || browserLocale === '' ? [] : [browserLocale]);
}

// --------------------------------------------------------------- buyer fields

const ADDRESS_TARGETS = {
  address_line1: 'address.line1',
  address_line2: 'address.line2',
  address_city: 'address.locality',
  address_postal_code: 'address.postal_code',
  address_region: 'address.region',
  address_country: 'address.country_code',
} as const;

/** Built-in buyer fields as form fields: one validator and one contact mapping for everything. */
export function buyerFields(contact: CheckoutContact, locale: CheckoutLocale): FormField[] {
  const s = CHECKOUT_STRINGS[locale];
  const out: FormFieldInput[] = [{ id: 'b_email', kind: 'email', key: 'email', label: s.email, required: true, map_to: 'email' }];
  const add = (mode: CheckoutContact['name'], field: FormFieldInput): void => {
    if (mode !== 'hidden') out.push({ ...field, required: mode === 'required' });
  };
  add(contact.name, { id: 'b_given', kind: 'text', key: 'given_name', label: s.firstName, map_to: 'given_name', max_length: 100 });
  add(contact.name, { id: 'b_family', kind: 'text', key: 'family_name', label: s.lastName, map_to: 'family_name', max_length: 100 });
  add(contact.phone, { id: 'b_phone', kind: 'phone', key: 'phone', label: s.phone, map_to: 'phone' });
  add(contact.company, { id: 'b_company', kind: 'text', key: 'company_name', label: s.company, map_to: 'company_name', max_length: 200 });
  if (contact.address !== 'hidden') {
    const required = contact.address === 'required';
    out.push(
      { id: 'b_line1', kind: 'text', key: 'address_line1', label: s.addressLine1, required, map_to: ADDRESS_TARGETS.address_line1 },
      { id: 'b_line2', kind: 'text', key: 'address_line2', label: s.addressLine2, map_to: ADDRESS_TARGETS.address_line2 },
      { id: 'b_city', kind: 'text', key: 'address_city', label: s.city, required, map_to: ADDRESS_TARGETS.address_city },
      { id: 'b_zip', kind: 'text', key: 'address_postal_code', label: s.postalCode, required, map_to: ADDRESS_TARGETS.address_postal_code, max_length: 20 },
      { id: 'b_region', kind: 'text', key: 'address_region', label: s.region, map_to: ADDRESS_TARGETS.address_region },
      { id: 'b_country', kind: 'text', key: 'address_country', label: s.country, required, map_to: ADDRESS_TARGETS.address_country, max_length: 2 },
    );
  }
  return out.map((f) => formFieldSchema.parse(f));
}

/** Custom fields may not write the attributes the buyer fields already write. */
function customFields(d: CheckoutDefinition, builtins: FormField[]): FormField[] {
  const taken = new Set(builtins.map((f) => f.map_to).filter((t): t is NonNullable<typeof t> => t !== null));
  const reserved = new Set<string>(RESERVED_FIELD_KEYS);
  return d.fields
    .filter((f) => !reserved.has(f.key))
    .map((f) => (f.map_to !== null && taken.has(f.map_to) ? { ...f, map_to: null } : f));
}

// --------------------------------------------------------------- public config

export function checkoutPublic(
  ctx: CrmContext,
  input: { checkoutId: string },
): { config: Omit<PublicCheckoutConfig, 'tenant'>; allowedDomains: string[] } {
  const row = activeCheckoutRow(ctx, input.checkoutId);
  const d = storedCheckoutDefinition(row);
  const catalog = resolveCatalog(ctx, d, getSettings(ctx).default_currency);
  const { allowed_domains, first_offer: _first, offer_window_minutes: _window, ...settings } = d.settings;
  return {
    config: {
      id: row.id,
      name: row.name,
      currency: catalog.currency,
      items: catalog.items.map((e) => ({
        id: e.id,
        kind: e.plan === null ? 'product' : 'plan',
        name: e.name,
        description: e.description,
        image_url: e.imageUrl,
        unit_price_minor: e.unitPriceMinor,
        quantity: e.quantity,
        preselected: e.preselected,
        recurring: recurringOf(e),
      })),
      bumps: catalog.bumps.map((e) => {
        const bump = d.bumps.find((b) => b.id === e.id);
        return {
          id: e.id,
          title: bump?.title ?? e.name,
          description: e.description,
          image_url: e.imageUrl,
          skin: bump?.skin ?? 'classic',
          position: bump?.position ?? 'above_payment',
          color: bump?.color ?? '',
          checked: e.preselected,
          unit_price_minor: e.unitPriceMinor,
          regular_price_minor: e.regularPriceMinor > e.unitPriceMinor ? e.regularPriceMinor : null,
          quantity: e.quantity,
        };
      }),
      fields: customFields(d, buyerFields(d.contact, 'en')),
      contact: d.contact,
      settings,
      style: d.style,
      offers_enabled: d.settings.first_offer !== '',
      stripe_publishable_key: readStripeAccount(ctx)?.publishable_key ?? null,
    },
    allowedDomains: allowed_domains,
  };
}

function cartOf(ctx: CrmContext, row: CheckoutRow, selection: Selection, locale: CheckoutLocale) {
  const d = storedCheckoutDefinition(row);
  const catalog = resolveCatalog(ctx, d, getSettings(ctx).default_currency);
  return { d, catalog, cart: buildCart(d, catalog, selection, locale) };
}

export function checkoutQuote(
  ctx: CrmContext,
  input: { checkoutId: string; selection: SelectionInput; promoCode: string; locale: string | null },
): Quote {
  const row = activeCheckoutRow(ctx, input.checkoutId);
  const selection = selectionSchema.parse(input.selection);
  const d = storedCheckoutDefinition(row);
  const locale = localeOf(d, input.locale);
  const { catalog, cart } = cartOf(ctx, row, selection, locale);
  return priceCart(ctx, {
    cart,
    currency: catalog.currency,
    contactId: '',
    promoCode: d.settings.promo_codes ? input.promoCode : '',
    at: ctx.now(),
    strictPromo: false,
  }).quote;
}

// ------------------------------------------------------------------- session

export interface PrepareResult {
  sessionId: string;
  /** The session of the previous attempt was reused (its token stays valid). */
  reused: boolean;
  contactId: string;
  email: string;
  name: string;
  orderId: string | null;
  orderNumber: string | null;
  amountMinor: number;
  currency: string;
  intentKind: 'payment' | 'setup' | 'none';
  /** The payment method is kept for renewals or one-click offers. */
  save: boolean;
  customerId: string | null;
  intentId: string | null;
  previousIntentKind: 'payment' | 'setup' | null;
  description: string;
  quote: Quote;
}

function tidyValues(values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) if (v !== null) out[k] = v;
  return out;
}

function trackingFrom(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of TRACKING_PARAMS) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim() !== '') out[key] = value.trim().slice(0, 255);
  }
  return out;
}

function upsertBuyer(
  ctx: CrmContext,
  d: CheckoutDefinition,
  fields: FormField[],
  values: SubmissionValues,
  tracking: Record<string, string>,
): string {
  const definition = formDefinitionSchema.parse({
    fields,
    crm: {
      create_contacts: true,
      tag_ids: d.crm.tag_ids,
      lead_source_id: d.crm.lead_source_id,
      owner_id: d.crm.owner_id,
      update_policy: d.crm.update_policy,
    },
  });
  const result = applyToContact(ctx, definition, values, tracking);
  if (result.contactId === null) {
    throw invalidMany([{ path: 'buyer.email', message: 'the email is required' }]);
  }
  if (result.created) {
    ctx.db.run(`UPDATE crm_contacts SET source_type = 'checkout' WHERE id = ?`, result.contactId);
  }
  return result.contactId;
}

/**
 * Validates the buyer and the selection, upserts the contact (with the
 * attribution of the visit), drafts the order and opens (or reuses) the
 * session. The worker then creates the Stripe intent for `amountMinor`.
 */
export function prepareCheckoutSession(
  ctx: CrmContext,
  input: {
    checkoutId: string;
    payload: SessionPayloadInput;
    tokenHash: string;
    existingTokenHash: string | null;
  },
): PrepareResult {
  const payload = sessionPayloadSchema.parse(input.payload);
  const row = activeCheckoutRow(ctx, input.checkoutId);
  const d = storedCheckoutDefinition(row);
  if (readStripeAccount(ctx) === null) throw new CrmError('conflict', 'payments are not configured');
  const locale = localeOf(d, payload.meta.locale);
  const now = ctx.now();

  let existing: SessionRow | null = null;
  if (input.existingTokenHash !== null) {
    existing =
      ctx.db.all<SessionRow>(`SELECT * FROM crm_checkout_sessions WHERE token_hash = ?`, input.existingTokenHash)[0] ??
      null;
    if (existing !== null && (existing.checkout_id !== row.id || existing.status !== 'open' || existing.expires_at < now)) {
      if (existing.status === 'paid' || existing.status === 'completed') {
        throw new CrmError('conflict', 'this purchase is already paid');
      }
      existing = null;
    }
  }

  const builtins = buyerFields(d.contact, locale);
  const fields = [...builtins, ...customFields(d, builtins)];
  const b = payload.buyer;
  const raw: Record<string, unknown> = {
    ...tidyValues(payload.values),
    email: b.email,
    given_name: b.given_name,
    family_name: b.family_name,
    phone: b.phone,
    company_name: b.company_name,
    address_line1: b.address.line1,
    address_line2: b.address.line2,
    address_city: b.address.city,
    address_postal_code: b.address.postal_code,
    address_region: b.address.region,
    address_country: b.address.country,
  };
  const checked = validateSubmission({ fields }, raw);
  const issues = checked.ok ? [] : Object.entries(checked.errors).map(([key, code]) => ({ path: `values.${key}`, message: code }));
  if (d.settings.terms_url !== '' && !payload.terms_accepted) {
    issues.push({ path: 'terms_accepted', message: 'required' });
  }
  if (!checked.ok || issues.length > 0) throw invalidMany(issues);

  const tracking = trackingFrom(payload.tracking);
  const { catalog, cart } = cartOf(ctx, row, payload.selection, locale);
  const contactId = upsertBuyer(ctx, d, fields, checked.values, tracking);
  const promoCode = d.settings.promo_codes ? payload.promo_code : '';
  const priced = priceCart(ctx, { cart, currency: catalog.currency, contactId, promoCode, at: now, strictPromo: true });

  const sessionId = existing?.id ?? ctx.newId();
  const orderId = writeDraft(ctx, { row, cart, priced, contactId, sessionId, existing, payload, promoCode, tracking });
  const order = orderId === null ? null : getOrderRow(ctx, orderId);
  const amount = order?.total_minor ?? 0;
  const plan = sessionPlan(payload.selection, promoCode, cart, priced);
  const save = plan.subscription !== null || d.settings.first_offer !== '';
  const intentKind: PrepareResult['intentKind'] = amount > 0 ? 'payment' : plan.subscription !== null ? 'setup' : 'none';

  const customerId =
    ctx.db.all<{ customer_id: string }>(`SELECT customer_id FROM crm_stripe_customers WHERE contact_id = ?`, contactId)[0]
      ?.customer_id ?? null;
  const columns = {
    contact_id: contactId,
    order_id: orderId,
    currency: catalog.currency,
    amount_minor: amount,
    selection: JSON.stringify(plan),
    field_values: JSON.stringify(checked.values),
    tracking: JSON.stringify(tracking),
    visitor_id: payload.meta.visitor_id === '' ? null : payload.meta.visitor_id,
    page_url: payload.meta.page_url === '' ? null : payload.meta.page_url,
    locale,
  };
  if (existing === null) {
    ctx.db.run(
      `INSERT INTO crm_checkout_sessions (id, checkout_id, token_hash, status, contact_id, order_id, currency, amount_minor,
         selection, field_values, tracking, visitor_id, page_url, locale, stripe_customer_id, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      sessionId,
      row.id,
      input.tokenHash,
      columns.contact_id,
      columns.order_id,
      columns.currency,
      columns.amount_minor,
      columns.selection,
      columns.field_values,
      columns.tracking,
      columns.visitor_id,
      columns.page_url,
      columns.locale,
      customerId,
      now + OPEN_SESSION_TTL_MS,
      now,
      now,
    );
  } else {
    ctx.db.run(
      `UPDATE crm_checkout_sessions SET contact_id = ?, order_id = ?, currency = ?, amount_minor = ?, selection = ?,
         field_values = ?, tracking = ?, visitor_id = ?, page_url = ?, locale = ?, last_error = NULL, expires_at = ?,
         updated_at = ? WHERE id = ?`,
      columns.contact_id,
      columns.order_id,
      columns.currency,
      columns.amount_minor,
      columns.selection,
      columns.field_values,
      columns.tracking,
      columns.visitor_id,
      columns.page_url,
      columns.locale,
      now + OPEN_SESSION_TTL_MS,
      now,
      sessionId,
    );
  }
  const name = [b.given_name, b.family_name].filter((v) => v !== '').join(' ');
  return {
    sessionId,
    reused: existing !== null,
    contactId,
    email: b.email,
    name,
    orderId,
    orderNumber: order?.number ?? null,
    amountMinor: amount,
    currency: catalog.currency,
    intentKind,
    save,
    customerId: customerId ?? existing?.stripe_customer_id ?? null,
    intentId: existing?.intent_id ?? null,
    previousIntentKind: existing?.intent_kind ?? null,
    description: order === null ? row.name : `${row.name} — ${order.number}`,
    quote: priced.quote,
  };
}

function sessionPlan(selection: Selection, promoCode: string, cart: Cart, priced: PricedCart): SessionPlan {
  const plan = cart.plan;
  const discount = priced.subscriptionDiscount;
  return {
    selection,
    promoCode,
    subscription:
      plan === null || plan.plan === null
        ? null
        : {
            planId: plan.plan.id,
            quantity: cart.planQuantity,
            unitPriceMinor: plan.unitPriceMinor,
            discount:
              discount === null
                ? null
                : {
                    promoId: discount.promo.id,
                    code: discount.promo.code,
                    kind: discount.rule.kind,
                    percentBps: discount.rule.percentBps,
                    amountMinor: discount.rule.amountMinor,
                    periodsLeft: discount.periodsLeft,
                  },
          },
  };
}

/** Draft order of the session (null when nothing is charged: a free trial alone). */
function writeDraft(
  ctx: CrmContext,
  input: {
    row: CheckoutRow;
    cart: Cart;
    priced: PricedCart;
    contactId: string;
    sessionId: string;
    existing: SessionRow | null;
    payload: { meta: { visitor_id: string } };
    promoCode: string;
    tracking: Record<string, string>;
  },
): string | null {
  const promo = input.priced.promo === null ? null : input.promoCode;
  const previous = input.existing?.order_id ?? null;
  if (input.cart.lines.length === 0) {
    if (previous !== null && getOrderRow(ctx, previous).status === 'draft') deleteOrder(ctx, { id: previous });
    return null;
  }
  if (previous !== null) {
    const draft = getOrderRow(ctx, previous);
    if (draft.status === 'draft') {
      return replaceDraftLines(ctx, draft, { lines: input.cart.lines, promoCode: promo, contactId: input.contactId }).id;
    }
  }
  return createOrderRow(
    ctx,
    {
      contact_id: input.contactId,
      currency: input.priced.quote.currency,
      items: [],
      status: 'draft',
      ...(promo === null ? {} : { promo_code: promo }),
      ...(input.payload.meta.visitor_id === '' ? {} : { analytics_visitor_id: input.payload.meta.visitor_id }),
    },
    {
      source: 'checkout',
      lines: input.cart.lines,
      checkout: {
        checkoutId: input.row.id,
        sessionId: input.sessionId,
        parentOrderId: null,
        attribution: input.tracking,
      },
    },
  ).id;
}

export function attachCheckoutIntent(
  ctx: CrmContext,
  input: { sessionId: string; contactId: string; customerId: string; intentKind: 'payment' | 'setup' | null; intentId: string | null },
): { ok: true } {
  const now = ctx.now();
  ctx.db.run(
    `INSERT OR IGNORE INTO crm_stripe_customers (contact_id, customer_id, created_at) VALUES (?, ?, ?)`,
    input.contactId,
    input.customerId,
    now,
  );
  ctx.db.run(
    `UPDATE crm_checkout_sessions SET stripe_customer_id = ?, intent_kind = ?, intent_id = ?, updated_at = ? WHERE id = ?`,
    input.customerId,
    input.intentKind,
    input.intentId,
    now,
    input.sessionId,
  );
  return { ok: true };
}

// ----------------------------------------------------------------- settlement

export interface IntentFacts {
  intentId: string;
  kind: 'payment' | 'setup';
  status: string;
  amountReceived: number;
  customerId: string | null;
  paymentMethodId: string | null;
  failureMessage: string | null;
}

/** First offer still to show, skipping the ones already answered. */
export function nextOfferKey(d: CheckoutDefinition, from: string, seen: readonly OfferRecord[]): string | null {
  const done = new Set(seen.map((o) => o.key));
  if (from === '' || done.has(from)) return null;
  return d.offers.some((o) => o.key === from) ? from : null;
}

export function nextStepOf(d: CheckoutDefinition, row: Pick<SessionRow, 'current_offer'>): NextStep {
  if (row.current_offer !== null) {
    const offer = d.offers.find((o) => o.key === row.current_offer);
    if (offer !== undefined) return { kind: 'offer', url: offer.page_url === '' ? null : offer.page_url };
  }
  return { kind: 'thank_you', url: d.settings.thank_you_url === '' ? null : d.settings.thank_you_url };
}

function settleRow(ctx: CrmContext, session: SessionRow, facts: IntentFacts): void {
  const row = getCheckoutRow(ctx, session.checkout_id);
  const d = storedCheckoutDefinition(row);
  const now = ctx.now();
  const plan = sessionPlanOf(session);
  if (session.order_id !== null) {
    const order = finalizeDraftRow(ctx, getOrderRow(ctx, session.order_id));
    const balance = order.total_minor - order.paid_minor;
    if (facts.kind === 'payment' && balance > 0 && facts.amountReceived > 0) {
      recordPayment(ctx, {
        orderId: order.id,
        data: {
          amount_minor: Math.min(facts.amountReceived, balance),
          method: 'card',
          status: 'succeeded',
          transaction_id: facts.intentId,
        },
      });
    }
  }
  const paymentMethod = facts.paymentMethodId ?? session.stripe_payment_method_id;
  const customer = facts.customerId ?? session.stripe_customer_id;
  if (plan.subscription !== null && session.contact_id !== null) {
    const s = plan.subscription;
    startCheckoutSubscription(ctx, {
      contactId: session.contact_id,
      planId: s.planId,
      quantity: s.quantity,
      unitPriceMinor: s.unitPriceMinor,
      firstOrderId: session.order_id,
      discount:
        s.discount === null
          ? null
          : {
              promoId: s.discount.promoId,
              code: s.discount.code,
              rule: { kind: s.discount.kind, percentBps: s.discount.percentBps, amountMinor: s.discount.amountMinor },
              periodsLeft: s.discount.periodsLeft,
            },
      stripeCustomerId: customer,
      stripePaymentMethodId: paymentMethod,
      visitorId: session.visitor_id,
    });
  }
  const firstOffer = paymentMethod === null ? null : nextOfferKey(d, d.settings.first_offer, []);
  ctx.db.run(
    `UPDATE crm_checkout_sessions SET status = ?, paid_at = ?, completed_at = ?, stripe_payment_method_id = ?,
       stripe_customer_id = ?, current_offer = ?, last_error = NULL, expires_at = ?, updated_at = ? WHERE id = ?`,
    firstOffer === null ? 'completed' : 'paid',
    now,
    firstOffer === null ? now : null,
    paymentMethod,
    customer,
    firstOffer,
    now + d.settings.offer_window_minutes * 60_000,
    now,
    session.id,
  );
}

/**
 * Records the outcome of the checkout intent; idempotent (the browser and
 * the webhook both report it, in any order).
 */
export function settleCheckoutIntent(ctx: CrmContext, input: IntentFacts): { sessionId: string | null } {
  const session = ctx.db.all<SessionRow>(
    `SELECT * FROM crm_checkout_sessions WHERE intent_id = ?`,
    input.intentId,
  )[0];
  if (session === undefined) return { sessionId: null };
  if (session.status !== 'open' && session.status !== 'processing') return { sessionId: session.id };
  const now = ctx.now();
  if (input.status === 'succeeded') {
    settleRow(ctx, session, input);
  } else if (input.status === 'processing') {
    ctx.db.run(`UPDATE crm_checkout_sessions SET status = 'processing', updated_at = ? WHERE id = ?`, now, session.id);
  } else if (input.failureMessage !== null) {
    ctx.db.run(
      `UPDATE crm_checkout_sessions SET status = 'open', last_error = ?, updated_at = ? WHERE id = ?`,
      input.failureMessage.slice(0, 500),
      now,
      session.id,
    );
  }
  return { sessionId: session.id };
}

/** A purchase with nothing to pay and nothing to save (100% discount on one-time items). */
export function settleFreeSession(ctx: CrmContext, input: { sessionId: string }): { ok: true } {
  const session = sessionById(ctx, input.sessionId);
  if (session.status === 'open') {
    settleRow(ctx, session, {
      intentId: '',
      kind: 'setup',
      status: 'succeeded',
      amountReceived: 0,
      customerId: null,
      paymentMethodId: null,
      failureMessage: null,
    });
  }
  return { ok: true };
}

export function checkoutCompletion(ctx: CrmContext, input: { tokenHash: string }): CompleteResult & { intentId: string | null; intentKind: 'payment' | 'setup' | null } {
  const session = sessionByToken(ctx, input.tokenHash);
  const d = storedCheckoutDefinition(getCheckoutRow(ctx, session.checkout_id));
  const locale = (session.locale === 'it' ? 'it' : 'en') as CheckoutLocale;
  const success = d.settings.success_message !== '' ? d.settings.success_message : CHECKOUT_STRINGS[locale].success;
  const orderNumber = session.order_id === null ? null : getOrderRow(ctx, session.order_id).number;
  const base = { intentId: session.intent_id, intentKind: session.intent_kind, order_number: orderNumber, success_message: success };
  if (session.status === 'paid' || session.status === 'completed') {
    return { ...base, status: 'paid', message: null, next: nextStepOf(d, session) };
  }
  if (session.status === 'processing') {
    return { ...base, status: 'processing', message: null, next: { kind: 'thank_you', url: d.settings.thank_you_url === '' ? null : d.settings.thank_you_url } };
  }
  return { ...base, status: 'failed', message: session.last_error, next: null };
}
