import {
  CHECKOUT_STRINGS,
  type AutoDiscount,
  type CheckoutDefinition,
  type CheckoutLocale,
  type Offer,
  type PublicRecurring,
  type Quote,
  type QuoteLine,
  type Selection,
} from '@amable/checkout';
import type { CrmContext } from '../crm/context';
import { CrmError, invalid } from '../crm/errors';
import type { PlanRow, ProductRow } from '../commerce/catalog';
import { allocate, computeTotals, mulDivRound, type DiscountRule } from '../commerce/money';
import { quoteLines, type LineDraft } from '../commerce/orders';
import { evaluatePromo, type AppliedPromo } from '../commerce/promo';

/** A checkout item, bump or offer resolved against the catalog. */
export interface ResolvedEntry {
  id: string;
  product: ProductRow;
  plan: PlanRow | null;
  name: string;
  description: string;
  imageUrl: string;
  unitPriceMinor: number;
  regularPriceMinor: number;
  quantity: number;
  preselected: boolean;
}

export interface ResolvedCatalog {
  currency: string;
  items: ResolvedEntry[];
  bumps: ResolvedEntry[];
}

/** A line of the cart, with what it stands for. */
export interface CartLine extends LineDraft {
  kind: QuoteLine['kind'];
  /** Checkout item or bump id the line comes from. */
  entryId: string;
}

export interface Cart {
  lines: CartLine[];
  /** The subscription plan bought, if any (at most one per checkout). */
  plan: ResolvedEntry | null;
  planQuantity: number;
}

function productRow(ctx: CrmContext, id: string): ProductRow | null {
  return (
    ctx.db.all<ProductRow>(
      `SELECT * FROM crm_products WHERE id = ? AND deleted_at IS NULL AND active = 1`,
      id,
    )[0] ?? null
  );
}

function planRow(ctx: CrmContext, id: string): PlanRow | null {
  return (
    ctx.db.all<PlanRow>(
      `SELECT * FROM crm_subscription_plans WHERE id = ? AND deleted_at IS NULL AND active = 1`,
      id,
    )[0] ?? null
  );
}

/** Resolves one reference; inactive or deleted catalog entries are skipped. */
export function resolveEntry(
  ctx: CrmContext,
  entry: {
    id: string;
    kind: 'product' | 'plan';
    refId: string;
    quantity: number;
    priceMinor: number | null;
    label: string;
    description: string;
    imageUrl: string;
    preselected: boolean;
  },
): ResolvedEntry | null {
  let plan: PlanRow | null = null;
  let product: ProductRow | null;
  if (entry.kind === 'plan') {
    plan = planRow(ctx, entry.refId);
    if (plan === null) return null;
    product = productRow(ctx, plan.product_id);
  } else {
    product = productRow(ctx, entry.refId);
  }
  if (product === null) return null;
  const regular = plan?.price_minor ?? product.price_minor;
  return {
    id: entry.id,
    product,
    plan,
    name: entry.label !== '' ? entry.label : plan === null ? product.name : `${product.name} — ${plan.name}`,
    description: entry.description !== '' ? entry.description : (product.description ?? ''),
    imageUrl: entry.imageUrl,
    unitPriceMinor: entry.priceMinor ?? regular,
    regularPriceMinor: regular,
    quantity: entry.quantity,
    preselected: entry.preselected,
  };
}

export function resolveCatalog(ctx: CrmContext, d: CheckoutDefinition, fallbackCurrency: string): ResolvedCatalog {
  const items = d.items
    .map((item) =>
      resolveEntry(ctx, {
        id: item.id,
        kind: item.kind,
        refId: item.ref_id,
        quantity: item.quantity,
        priceMinor: item.price_minor,
        label: item.label,
        description: item.description,
        imageUrl: item.image_url,
        preselected: item.preselected,
      }),
    )
    .filter((e): e is ResolvedEntry => e !== null);
  const bumps = d.bumps
    .map((bump) =>
      resolveEntry(ctx, {
        id: bump.id,
        kind: 'product',
        refId: bump.product_id,
        quantity: bump.quantity,
        priceMinor: bump.price_minor,
        label: '',
        description: bump.description,
        imageUrl: bump.image_url,
        preselected: bump.checked,
      }),
    )
    .filter((e): e is ResolvedEntry => e !== null);
  const currency = items[0]?.product.currency ?? bumps[0]?.product.currency ?? fallbackCurrency;
  return { currency, items, bumps };
}

export function resolveOffer(ctx: CrmContext, offer: Offer): ResolvedEntry | null {
  return resolveEntry(ctx, {
    id: offer.key,
    kind: offer.item_kind,
    refId: offer.ref_id,
    quantity: offer.quantity,
    priceMinor: offer.price_minor,
    label: '',
    description: offer.description,
    imageUrl: '',
    preselected: false,
  });
}

export function recurringOf(entry: ResolvedEntry): PublicRecurring | null {
  if (entry.plan === null) return null;
  return {
    interval: entry.plan.interval,
    interval_count: entry.plan.interval_count,
    trial_days: entry.plan.trial_days,
    setup_fee_minor: entry.plan.setup_fee_minor,
  };
}

function line(entry: ResolvedEntry, quantity: number, kind: CartLine['kind']): CartLine {
  return {
    kind,
    entryId: entry.id,
    productId: entry.product.id,
    planId: entry.plan?.id ?? null,
    name: entry.name,
    sku: entry.product.sku,
    description: null,
    quantity,
    unitPriceMinor: entry.unitPriceMinor,
    taxRateBps: entry.product.tax_rate_bps,
  };
}

/**
 * Lines a purchase charges now. A plan without trial bills its first period
 * here; with a trial only the setup fee (if any) is due now.
 */
export function entryLines(entry: ResolvedEntry, quantity: number, locale: CheckoutLocale, kind: CartLine['kind']): CartLine[] {
  if (entry.plan === null) return [line(entry, quantity, kind)];
  const out: CartLine[] = [];
  if (entry.plan.trial_days === 0) out.push(line(entry, quantity, kind));
  if (entry.plan.setup_fee_minor > 0) {
    out.push({
      ...line(entry, 1, 'setup_fee'),
      planId: null,
      name: `${entry.name} — ${CHECKOUT_STRINGS[locale].setupFee}`,
      unitPriceMinor: entry.plan.setup_fee_minor,
    });
  }
  return out;
}

/** The selection applied to the checkout (unknown ids are ignored, never trusted). */
export function buildCart(
  d: CheckoutDefinition,
  catalog: ResolvedCatalog,
  selection: Selection,
  locale: CheckoutLocale,
): Cart {
  let chosen: ResolvedEntry[];
  if (d.settings.item_selection === 'any') {
    const picked = new Set(selection.items);
    chosen = catalog.items.filter((i) => picked.has(i.id));
    if (chosen.length === 0 && catalog.items.length > 0) throw invalid('selection.items', 'pick at least one item');
  } else if (d.settings.item_selection === 'one') {
    const picked =
      catalog.items.find((i) => i.id === selection.items[0]) ??
      catalog.items.find((i) => i.preselected) ??
      catalog.items[0];
    chosen = picked === undefined ? [] : [picked];
  } else {
    chosen = catalog.items;
  }
  if (chosen.length === 0) throw new CrmError('conflict', 'nothing can be bought on this checkout right now');
  const quantityOf = (entry: ResolvedEntry): number =>
    d.settings.allow_quantity ? (selection.quantities[entry.id] ?? entry.quantity) : entry.quantity;
  const lines: CartLine[] = [];
  let plan: ResolvedEntry | null = null;
  let planQuantity = 1;
  for (const entry of chosen) {
    const quantity = quantityOf(entry);
    if (entry.plan !== null) {
      plan = entry;
      planQuantity = quantity;
    }
    lines.push(...entryLines(entry, quantity, locale, 'item'));
  }
  const bumpIds = new Set(selection.bumps);
  for (const bump of catalog.bumps) {
    if (bumpIds.has(bump.id)) lines.push(line(bump, bump.quantity, 'bump'));
  }
  return { lines, plan, planQuantity };
}

export interface AppliedAutoDiscount {
  id: string;
  label: string;
  amountMinor: number;
}

/**
 * Applies the automatic discount rules to the cart lines: of the rules whose
 * conditions the cart meets, the one worth the most is spread over its lines
 * (`discountMinor`). Plan lines, setup fees and trials are never discounted.
 */
export function applyAutoDiscounts(
  rules: readonly AutoDiscount[],
  lines: readonly CartLine[],
): { lines: CartLine[]; applied: AppliedAutoDiscount | null } {
  const quantities = new Map<string, number>();
  for (const l of lines) {
    if (l.kind === 'item' && l.planId === null) quantities.set(l.entryId, (quantities.get(l.entryId) ?? 0) + l.quantity);
  }
  let best: { rule: AutoDiscount; amount: number; shares: number[] } | null = null;
  for (const rule of rules) {
    if (!rule.conditions.every((c) => (quantities.get(c.item_id) ?? 0) >= c.min_quantity)) continue;
    const listed = new Set(rule.conditions.map((c) => c.item_id));
    const weights = lines.map((l) => {
      const product = l.planId === null && (l.kind === 'item' || l.kind === 'bump');
      const inScope = rule.scope === 'order' || (l.kind === 'item' && listed.has(l.entryId));
      return product && inScope ? l.quantity * l.unitPriceMinor : 0;
    });
    const base = weights.reduce((a, b) => a + b, 0);
    const amount =
      rule.kind === 'percent' ? mulDivRound(base, rule.percent_bps ?? 0, 10_000) : Math.min(rule.amount_minor ?? 0, base);
    if (amount > 0 && (best === null || amount > best.amount)) best = { rule, amount, shares: allocate(amount, weights) };
  }
  if (best === null) return { lines: [...lines], applied: null };
  const { rule, amount, shares } = best;
  return {
    lines: lines.map((l, i) => ({ ...l, discountMinor: shares[i] ?? 0 })),
    applied: { id: rule.id, label: rule.label, amountMinor: amount },
  };
}

export interface PricedCart {
  quote: Quote;
  /** The lines as priced (automatic discounts included): what the order is written with. */
  lines: CartLine[];
  promo: AppliedPromo | null;
  /** Promo discount the subscription keeps on its renewals. */
  subscriptionDiscount: { rule: DiscountRule; periodsLeft: number | null; promo: AppliedPromo } | null;
}

/**
 * Prices a cart. An invalid promo code never fails the quote: it comes back with its reason.
 * A valid promo code adds to the automatic discounts when `stackPromo`, otherwise replaces them.
 */
export function priceCart(
  ctx: CrmContext,
  input: {
    cart: Cart;
    currency: string;
    contactId: string;
    promoCode: string;
    at: number;
    strictPromo: boolean;
    discounts: readonly AutoDiscount[];
    stackPromo: boolean;
  },
): PricedCart {
  const code = input.promoCode.trim();
  const auto = applyAutoDiscounts(input.discounts, input.cart.lines);
  const price = (lines: CartLine[], promoCode: string | null) =>
    quoteLines(ctx, { lines, currency: input.currency, contactId: input.contactId, promoCode, at: input.at });
  let promoNote: Quote['promo'] = null;
  let pricedLines = auto.lines;
  let autoApplied = auto.applied;
  let priced;
  if (code === '') {
    priced = price(pricedLines, null);
  } else {
    const promoLines = input.stackPromo ? auto.lines : input.cart.lines;
    try {
      priced = price(promoLines, code);
      pricedLines = promoLines;
      if (!input.stackPromo) autoApplied = null;
      promoNote = { code: priced.promo?.code ?? code.toUpperCase(), applied: true, message: null };
    } catch (error) {
      if (!(error instanceof CrmError) || input.strictPromo) throw error;
      promoNote = { code: code.toUpperCase(), applied: false, message: error.message };
      priced = price(pricedLines, null);
    }
  }
  const { totals } = priced;
  let promo = priced.promo;
  const plan = input.cart.plan;
  if (promo === null && code !== '' && plan !== null) {
    // Nothing is charged for the plan now (trial): the code still discounts the renewals.
    try {
      promo = evaluatePromo(ctx, {
        code,
        contactId: input.contactId,
        currency: input.currency,
        orderId: null,
        lines: [{ productId: plan.product.id, subtotalMinor: plan.unitPriceMinor * input.cart.planQuantity }],
        at: input.at,
      });
      promoNote = { code: promo.code, applied: true, message: null };
    } catch (error) {
      if (!(error instanceof CrmError) || input.strictPromo) throw error;
    }
  }
  const lines: QuoteLine[] = input.cart.lines.map((l, i) => {
    const t = totals.lines[i];
    return {
      name: l.name,
      quantity: l.quantity,
      kind: l.kind,
      subtotal_minor: t?.subtotalMinor ?? 0,
      discount_minor: t?.discountMinor ?? 0,
      total_minor: t?.totalMinor ?? 0,
    };
  });
  let recurring: Quote['recurring'] = null;
  let subscriptionDiscount: PricedCart['subscriptionDiscount'] = null;
  if (plan !== null && plan.plan !== null) {
    const renewal = (rule: DiscountRule | null): number =>
      computeTotals(
        [
          {
            quantity: input.cart.planQuantity,
            unitPriceMinor: plan.unitPriceMinor,
            taxRateBps: plan.product.tax_rate_bps,
            discountable: rule !== null,
          },
        ],
        rule,
        0,
      ).totalMinor;
    if (promo !== null && promo.appliesTo(plan.product.id)) {
      const firstBilledHere = plan.plan.trial_days === 0;
      const periodsLeft = promo.periods === null ? null : promo.periods - (firstBilledHere ? 1 : 0);
      if (periodsLeft === null || periodsLeft > 0) {
        subscriptionDiscount = { rule: promo.rule, periodsLeft, promo };
      }
    }
    recurring = {
      amount_minor: renewal(null),
      interval: plan.plan.interval,
      interval_count: plan.plan.interval_count,
      trial_days: plan.plan.trial_days,
      discounted_periods: subscriptionDiscount === null ? null : subscriptionDiscount.periodsLeft,
      discounted_amount_minor: subscriptionDiscount === null ? null : renewal(subscriptionDiscount.rule),
    };
    if (plan.plan.trial_days > 0) {
      lines.unshift({
        name: plan.name,
        quantity: input.cart.planQuantity,
        kind: 'trial',
        subtotal_minor: 0,
        discount_minor: 0,
        total_minor: 0,
      });
    }
  }
  return {
    quote: {
      currency: input.currency,
      lines,
      subtotal_minor: totals.subtotalMinor,
      discount_minor: totals.discountMinor,
      tax_minor: totals.taxMinor,
      total_minor: totals.totalMinor,
      recurring,
      promo: promoNote,
      discounts: autoApplied === null ? [] : [{ label: autoApplied.label, amount_minor: autoApplied.amountMinor }],
    },
    lines: pricedLines,
    promo,
    subscriptionDiscount,
  };
}

export function assertSameCurrency(catalog: ResolvedCatalog): void {
  for (const entry of [...catalog.items, ...catalog.bumps]) {
    if (entry.product.currency !== catalog.currency) {
      throw invalid('checkout', 'checkout items are priced in different currencies');
    }
  }
}
