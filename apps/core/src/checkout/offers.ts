import { CHECKOUT_STRINGS, type CheckoutDefinition, type CheckoutLocale, type Offer, type OfferState } from '@amable/checkout';
import type { CrmContext } from '../crm/context';
import { CrmError } from '../crm/errors';
import { createOrderRow, deleteOrder, finalizeDraftRow, restoreDraft } from '../commerce/orders';
import { recordPayment } from '../commerce/payments';
import { getOrderRow } from '../commerce/rows';
import { startCheckoutSubscription } from '../commerce/subscriptions';
import { getCheckoutRow, storedCheckoutDefinition } from './checkouts';
import type { CheckoutLine } from '../commerce/stripe/client';
import { scheduleSummary } from './bank-transfer';
import { entryLines, recurringOf, resolveOffer, type ResolvedEntry } from './pricing';
import {
  checkoutLinesOf,
  nextOfferKey,
  nextStepOf,
  offersOf,
  sessionById,
  sessionByToken,
  trackingOf,
  type OfferRecord,
  type SessionRow,
  withoutSavedCard,
} from './sessions';

/** Charge attempts per offer (a declined card, a failed 3-D Secure). */
const MAX_OFFER_ATTEMPTS = 3;

function localeOf(session: SessionRow): CheckoutLocale {
  return session.locale === 'it' ? 'it' : 'en';
}

function successMessage(d: CheckoutDefinition, session: SessionRow): string {
  return d.settings.success_message !== '' ? d.settings.success_message : CHECKOUT_STRINGS[localeOf(session)].success;
}

function live(session: SessionRow, now: number): boolean {
  return session.status === 'paid' && session.current_offer !== null && session.expires_at > now;
}

function context(ctx: CrmContext, session: SessionRow): { d: CheckoutDefinition; offer: Offer | null; entry: ResolvedEntry | null } {
  const d = storedCheckoutDefinition(getCheckoutRow(ctx, session.checkout_id));
  const offer = d.offers.find((o) => o.key === session.current_offer) ?? null;
  const entry = offer === null ? null : resolveOffer(ctx, offer);
  return { d, offer, entry };
}

/** Ends the offer chain: the buyer goes to the thank-you page. */
function finish(ctx: CrmContext, session: SessionRow): void {
  const now = ctx.now();
  ctx.db.run(
    `UPDATE crm_checkout_sessions SET status = 'completed', current_offer = NULL, pending_offer = NULL,
       pending_intent_id = NULL, completed_at = ?, updated_at = ? WHERE id = ?`,
    now,
    now,
    session.id,
  );
  scheduleSummary(ctx, session.id, 'now', false);
}

function amountOf(entry: ResolvedEntry, locale: CheckoutLocale): number {
  return entryLines(entry, entry.quantity, locale, 'item').reduce((sum, l) => sum + l.quantity * l.unitPriceMinor, 0);
}

export function offerState(ctx: CrmContext, input: { tokenHash: string }): OfferState {
  const session = sessionByToken(ctx, input.tokenHash);
  const { d, offer, entry } = context(ctx, session);
  const now = ctx.now();
  if (!live(session, now) || offer === null || entry === null) {
    if (session.status === 'paid') finish(ctx, session);
    return { status: 'done', next: nextStepOf(d, { current_offer: null }), success_message: successMessage(d, session) };
  }
  return {
    status: 'offer',
    offer: {
      key: offer.key,
      kind: offer.kind,
      title: offer.title,
      description: offer.description !== '' ? offer.description : entry.description,
      image_url: offer.image_url !== '' ? offer.image_url : entry.imageUrl,
      name: entry.name,
      currency: entry.product.currency,
      amount_minor: amountOf(entry, localeOf(session)),
      regular_amount_minor: entry.regularPriceMinor > entry.unitPriceMinor ? entry.regularPriceMinor * entry.quantity : null,
      quantity: entry.quantity,
      recurring: recurringOf(entry),
      checkout_id: session.checkout_id,
      locale: localeOf(session),
      payment_method: session.payment_method,
      card_flow: session.intent_kind === 'checkout' ? 'redirect' : 'element',
    },
  };
}

/**
 * `accepted`: bank transfer purchase, the offer order was placed unpaid
 * (nothing to charge); `redirect`: Managed Payments, the worker opens a
 * Stripe Checkout Session for `lines`.
 */
export interface OfferCharge {
  action: 'charge' | 'check' | 'free' | 'none' | 'accepted' | 'redirect';
  lines: CheckoutLine[];
  sessionId: string;
  orderId: string | null;
  amountMinor: number;
  currency: string;
  customerId: string | null;
  paymentMethodId: string | null;
  attempt: number;
  pendingIntentId: string | null;
  description: string;
  receiptEmail: string | null;
}

function emailOf(ctx: CrmContext, contactId: string | null): string | null {
  if (contactId === null) return null;
  return ctx.db.all<{ email: string | null }>(`SELECT primary_email AS email FROM crm_contacts WHERE id = ?`, contactId)[0]?.email ?? null;
}

/**
 * Accepting an offer: drafts its order and tells the worker what to charge.
 * A second click while a charge is pending returns `check` (the worker reads
 * the intent instead of charging again).
 */
export function prepareOfferCharge(ctx: CrmContext, input: { tokenHash: string; offerKey: string }): OfferCharge {
  const session = sessionByToken(ctx, input.tokenHash);
  const now = ctx.now();
  const base = {
    sessionId: session.id,
    currency: session.currency,
    customerId: session.stripe_customer_id,
    paymentMethodId: session.stripe_payment_method_id,
    attempt: session.offer_attempts,
    pendingIntentId: session.pending_intent_id,
    description: '',
    receiptEmail: emailOf(ctx, session.contact_id),
    lines: [],
  };
  if (!live(session, now) || session.current_offer !== input.offerKey) {
    return { ...base, action: 'none', orderId: null, amountMinor: 0 };
  }
  if (session.pending_offer === input.offerKey && session.pending_intent_id !== null) {
    return { ...base, action: 'check', orderId: null, amountMinor: 0 };
  }
  const { offer, entry } = context(ctx, session);
  if (offer === null || entry === null || session.contact_id === null) {
    throw new CrmError('conflict', 'this offer is no longer available');
  }
  if (session.offer_attempts >= MAX_OFFER_ATTEMPTS) {
    throw new CrmError('conflict', 'too many attempts on this offer');
  }
  const lines = entryLines(entry, entry.quantity, localeOf(session), 'item');
  let orderId: string | null = null;
  let amount = 0;
  let number = '';
  if (lines.length > 0) {
    const existing =
      session.pending_offer === input.offerKey
        ? ctx.db.all<{ id: string }>(
            `SELECT id FROM crm_orders WHERE checkout_session_id = ? AND parent_order_id IS NOT NULL AND status = 'draft'
               AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
            session.id,
          )[0]
        : undefined;
    const order =
      existing === undefined
        ? createOrderRow(
            ctx,
            {
              contact_id: session.contact_id,
              currency: entry.product.currency,
              items: [],
              status: 'draft',
              ...(session.visitor_id === null ? {} : { analytics_visitor_id: session.visitor_id }),
            },
            {
              source: 'checkout',
              lines,
              checkout: {
                checkoutId: session.checkout_id,
                sessionId: session.id,
                parentOrderId: session.order_id,
                attribution: trackingOf(session),
              },
            },
          )
        : getOrderRow(ctx, existing.id);
    orderId = order.id;
    amount = order.total_minor;
    number = order.number;
  }
  ctx.db.run(
    `UPDATE crm_checkout_sessions SET pending_offer = ?, offer_attempts = offer_attempts + 1, updated_at = ? WHERE id = ?`,
    input.offerKey,
    now,
    session.id,
  );
  const description = number === '' ? offer.title : `${offer.title} — ${number}`;
  const result = { ...base, orderId, amountMinor: amount, attempt: session.offer_attempts + 1, description };
  if (amount > 0 && orderId !== null && session.payment_method === 'bank_transfer') {
    acceptBankOffer(ctx, session, offer, orderId);
    return { ...result, action: 'accepted' };
  }
  if (amount > 0 && orderId !== null && session.intent_kind === 'checkout') {
    return { ...result, action: 'redirect', lines: checkoutLinesOf(ctx, orderId, description) };
  }
  return { ...result, action: amount > 0 ? 'charge' : 'free' };
}

/** Bank transfer purchase: the offer order joins the transfer to make, nothing is charged. */
function acceptBankOffer(ctx: CrmContext, session: SessionRow, offer: Offer, orderId: string): void {
  ctx.db.run(`UPDATE crm_orders SET payment_method = 'bank_transfer' WHERE id = ? AND status = 'draft'`, orderId);
  finalizeDraftRow(ctx, getOrderRow(ctx, orderId));
  const d = storedCheckoutDefinition(getCheckoutRow(ctx, session.checkout_id));
  const outcome: OfferRecord = { key: offer.key, outcome: 'accepted', order_id: orderId, at: ctx.now() };
  record(ctx, session, outcome, nextAfter(d, session, offer, true, [...offersOf(session), outcome]));
}

function record(ctx: CrmContext, session: SessionRow, entry: OfferRecord, next: string | null): void {
  const history = [...offersOf(session), entry];
  ctx.db.run(
    `UPDATE crm_checkout_sessions SET offers = ?, current_offer = ?, pending_offer = NULL, pending_intent_id = NULL,
       offer_attempts = 0, status = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
    JSON.stringify(history),
    next,
    next === null ? 'completed' : 'paid',
    next === null ? ctx.now() : null,
    ctx.now(),
    session.id,
  );
  // An offer accepted after the summary went out adds to the transfer: one corrected summary follows.
  scheduleSummary(ctx, session.id, next === null ? 'now' : 'idle', entry.outcome === 'accepted');
}

function nextAfter(
  d: CheckoutDefinition,
  session: SessionRow,
  offer: Offer,
  accepted: boolean,
  history: OfferRecord[],
): string | null {
  return nextOfferKey(d, accepted ? offer.on_accept : offer.on_decline, history, withoutSavedCard(session));
}

/**
 * Outcome of the offer charge (from the worker, after 3-D Secure, or from
 * the webhook). Idempotent per order: a paid offer order is never charged or
 * recorded twice.
 */
export function settleOfferCharge(
  ctx: CrmContext,
  input: {
    sessionId: string;
    offerKey: string;
    orderId: string | null;
    intentId: string | null;
    status: 'succeeded' | 'requires_action' | 'failed';
    amountReceived: number;
    message: string | null;
  },
): { state: 'accepted' | 'requires_action' | 'failed' | 'stale' } {
  const session = sessionById(ctx, input.sessionId);
  const { d, offer, entry } = context(ctx, session);
  if (offer === null || offer.key !== input.offerKey || session.status !== 'paid') {
    // Paid after the buyer moved on (late webhook): the money is still recorded
    // on its order and a plan still starts its subscription, once.
    if (input.status === 'succeeded' && input.orderId !== null) {
      const recorded = recordOfferPayment(ctx, input.orderId, input.intentId, input.amountReceived);
      const late = d.offers.find((o) => o.key === input.offerKey);
      const lateEntry = recorded && late !== undefined ? resolveOffer(ctx, late) : null;
      if (lateEntry !== null) startOfferSubscription(ctx, session, lateEntry, input.orderId);
    }
    return { state: 'stale' };
  }
  const now = ctx.now();
  if (input.status === 'requires_action') {
    ctx.db.run(
      `UPDATE crm_checkout_sessions SET pending_intent_id = ?, updated_at = ? WHERE id = ?`,
      input.intentId,
      now,
      session.id,
    );
    return { state: 'requires_action' };
  }
  if (input.status === 'failed') {
    if (input.orderId !== null && getOrderRow(ctx, input.orderId).status === 'draft') deleteOrder(ctx, { id: input.orderId });
    ctx.db.run(
      `UPDATE crm_checkout_sessions SET pending_offer = NULL, pending_intent_id = NULL, last_error = ?, updated_at = ?
       WHERE id = ?`,
      input.message?.slice(0, 500) ?? null,
      now,
      session.id,
    );
    return { state: 'failed' };
  }
  if (input.orderId !== null) recordOfferPayment(ctx, input.orderId, input.intentId, input.amountReceived);
  if (entry !== null) startOfferSubscription(ctx, session, entry, input.orderId);
  const history = offersOf(session);
  const outcome: OfferRecord = { key: offer.key, outcome: 'accepted', order_id: input.orderId, at: now };
  record(ctx, session, outcome, nextAfter(d, session, offer, true, [...history, outcome]));
  return { state: 'accepted' };
}

function startOfferSubscription(ctx: CrmContext, session: SessionRow, entry: ResolvedEntry, orderId: string | null): void {
  if (entry.plan === null || session.contact_id === null) return;
  startCheckoutSubscription(ctx, {
    contactId: session.contact_id,
    planId: entry.plan.id,
    quantity: entry.quantity,
    unitPriceMinor: entry.unitPriceMinor,
    firstOrderId: orderId,
    discount: null,
    stripeCustomerId: session.stripe_customer_id,
    stripePaymentMethodId: session.stripe_payment_method_id,
    visitorId: session.visitor_id,
  });
}

/** True when this call recorded the payment (false: already recorded, or nothing received). */
function recordOfferPayment(ctx: CrmContext, orderId: string, intentId: string | null, amount: number): boolean {
  if (amount <= 0) return false;
  // A draft discarded while its charge was pending (declined offer, failed retry) comes back: it was paid.
  restoreDraft(ctx, orderId);
  ctx.db.run(`UPDATE crm_orders SET payment_method = 'card' WHERE id = ? AND status = 'draft'`, orderId);
  const order = finalizeDraftRow(ctx, getOrderRow(ctx, orderId));
  const balance = order.total_minor - order.paid_minor;
  if (balance <= 0) return false;
  recordPayment(ctx, {
    orderId: order.id,
    data: {
      amount_minor: Math.min(amount, balance),
      method: 'card',
      status: 'succeeded',
      ...(intentId === null ? {} : { transaction_id: intentId }),
    },
  });
  return true;
}

export function declineOffer(ctx: CrmContext, input: { tokenHash: string; offerKey: string }): { declined: boolean } {
  const session = sessionByToken(ctx, input.tokenHash);
  if (!live(session, ctx.now()) || session.current_offer !== input.offerKey) return { declined: false };
  const { d, offer } = context(ctx, session);
  if (offer === null) return { declined: false };
  const pending = ctx.db.all<{ id: string }>(
    `SELECT id FROM crm_orders WHERE checkout_session_id = ? AND parent_order_id IS NOT NULL AND status = 'draft'
       AND deleted_at IS NULL`,
    session.id,
  );
  for (const order of pending) deleteOrder(ctx, { id: order.id });
  const history = offersOf(session);
  const outcome: OfferRecord = { key: offer.key, outcome: 'declined', order_id: null, at: ctx.now() };
  record(ctx, session, outcome, nextAfter(d, session, offer, false, [...history, outcome]));
  return { declined: true };
}

/** Where the buyer goes after an offer action. */
export function offerNext(ctx: CrmContext, input: { sessionId: string }): ReturnType<typeof nextStepOf> {
  const session = sessionById(ctx, input.sessionId);
  const d = storedCheckoutDefinition(getCheckoutRow(ctx, session.checkout_id));
  return nextStepOf(d, session);
}
