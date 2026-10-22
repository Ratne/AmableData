import type { CrmContext } from '../crm/context';
import * as stripe from '../commerce/stripe/account';
import * as charges from './charges';
import * as checkouts from './checkouts';
import * as offers from './offers';
import * as sessions from './sessions';

/**
 * Checkout operations of the TenantDb (merged into `crmOps`). Synchronous,
 * one transaction per call: Stripe requests and secret decryption run in the
 * worker around them (gateway.ts, stripe/api.ts, renewals.ts).
 */
export const checkoutOps = {
  'checkouts.list': checkouts.listCheckouts,
  'checkouts.get': checkouts.getCheckout,
  'checkouts.create': checkouts.createCheckout,
  'checkouts.update': checkouts.updateCheckout,
  'checkouts.delete': checkouts.deleteCheckout,
  'checkouts.duplicate': checkouts.duplicateCheckout,
  // public purchase flow
  'checkout.public': sessions.checkoutPublic,
  'checkout.quote': sessions.checkoutQuote,
  'checkout.prepare': sessions.prepareCheckoutSession,
  'checkout.attachIntent': sessions.attachCheckoutIntent,
  'checkout.settleIntent': sessions.settleCheckoutIntent,
  'checkout.settleFree': sessions.settleFreeSession,
  'checkout.completion': sessions.checkoutCompletion,
  'checkout.expireSessions': sessions.expireCheckoutSessions,
  'checkout.offerState': offers.offerState,
  'checkout.offerPrepare': offers.prepareOfferCharge,
  'checkout.offerSettle': offers.settleOfferCharge,
  'checkout.offerDecline': offers.declineOffer,
  'checkout.offerNext': offers.offerNext,
  // Stripe account, webhooks and automatic renewals
  'stripe.account': stripe.stripeAccount,
  'stripe.settings': stripe.stripeSettings,
  'stripe.saveAccount': stripe.saveStripeAccount,
  'stripe.clearAccount': stripe.clearStripeAccount,
  'stripe.event': charges.applyStripeEvent,
  'stripe.refundPlan': charges.stripeRefundPlan,
  'stripe.refundSync': charges.syncStripeRefund,
  'commerce.chargesDue': charges.chargesDue,
  'commerce.chargeResult': charges.chargeResult,
} satisfies Record<string, (ctx: CrmContext, input: never) => unknown>;

/** Ops after which an automatic charge may have been scheduled or moved. */
export function affectsChargeSchedule(op: string): boolean {
  return op === 'commerce.chargeResult' || op === 'commerce.chargesDue' || op === 'stripe.event' || op.startsWith('checkout.');
}
