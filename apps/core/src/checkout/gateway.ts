import { randomToken, sha256Hex } from '@amable/auth';
import {
  selectionSchema,
  sessionPayloadSchema,
  type CheckoutGatewayOps,
  type OfferActionResult,
  type PublicCheckoutConfig,
} from '@amable/checkout';
import { z } from 'zod';
import { suggestAddresses } from '../crm/api/address-lookup';
import { GatewayError, type GatewayContext, type GatewayHandlers } from '../public/context';
import type { StoredStripeAccount } from '../commerce/stripe/account';
import { StripeApiError, type StripePaymentIntent, type StripeSetupIntent } from '../commerce/stripe/client';
import { commerceRuntime, openStripe, type OpenStripe } from '../commerce/stripe/runtime';
import {
  asCharge,
  asPaymentIntent,
  asSetupIntent,
  parseStripeEvent,
  verifyStripeSignature,
} from '../commerce/stripe/webhook';
import type { IntentFacts } from './sessions';

type Output<K extends keyof CheckoutGatewayOps> = CheckoutGatewayOps[K]['output'];

const id = z.string().min(1).max(64);
const token = z.string().min(16).max(128);
const refSchema = z.strictObject({ checkoutId: id });
const quoteSchema = z.strictObject({ checkoutId: id, selection: selectionSchema, promoCode: z.string().max(64).default('') });
const sessionSchema = z.strictObject({ checkoutId: id, payload: z.unknown() });
const tokenSchema = z.strictObject({ token });
const offerSchema = z.strictObject({ token, offerKey: z.string().min(1).max(40) });
const addressSchema = z.strictObject({
  checkoutId: id,
  q: z.string().trim().min(3).max(200),
  country: z.string().regex(/^([A-Za-z]{2})?$/).default(''),
  lang: z.string().max(16).default(''),
});
const webhookSchema = z.strictObject({ payload: z.string().max(512 * 1024), signature: z.string().max(2048).nullable() });

const SESSION_RATE = { name: 'checkout:session:ip', limit: 20, windowMs: 10 * 60_000 } as const;
const QUOTE_RATE = { name: 'checkout:quote:ip', limit: 120, windowMs: 10 * 60_000 } as const;
const ADDRESS_RATE = { name: 'checkout:address:ip', limit: 60, windowMs: 5 * 60_000 } as const;
const OFFER_RATE = { name: 'checkout:offer:ip', limit: 30, windowMs: 10 * 60_000 } as const;

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new GatewayError(
      422,
      'validation_failed',
      'invalid input',
      result.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
    );
  }
  return result.data;
}

async function limit(ctx: GatewayContext, rate: { name: string; limit: number; windowMs: number }): Promise<void> {
  if (ctx.client.ip === null) return;
  const runtime = await commerceRuntime(ctx.env);
  const result = await runtime.limiter.consume(rate, `${ctx.tenant.id}:${ctx.client.ip}`);
  if (!result.allowed) throw new GatewayError(429, 'rate_limited', 'too many requests, retry later');
}

async function stripeOf(ctx: GatewayContext): Promise<OpenStripe> {
  const account = await ctx.crm('stripe.account', {});
  if (account === null) throw new GatewayError(409, 'stripe_not_configured', 'payments are not configured');
  return openStripe(await commerceRuntime(ctx.env), account);
}

/** Stripe failures shown to the buyer keep Stripe's message (card errors are meant for them). */
function stripeFailure(error: unknown): GatewayError {
  if (error instanceof StripeApiError) {
    const status = error.error.type === 'card_error' ? 402 : 502;
    return new GatewayError(status, error.error.code ?? 'stripe_error', error.message);
  }
  return new GatewayError(502, 'stripe_unreachable', 'the payment provider is not answering');
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function domainAllowed(allowed: readonly string[], pageUrl: string, referer: string | null, hostedPath: string): boolean {
  if (allowed.length === 0) return true;
  const source = pageUrl !== '' ? pageUrl : (referer ?? '');
  try {
    if (new URL(source).pathname.startsWith(hostedPath)) return true;
  } catch {
    return false;
  }
  const host = hostOf(source);
  return host !== null && allowed.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

async function publicConfig(ctx: GatewayContext, checkoutId: string): Promise<{ config: PublicCheckoutConfig; allowedDomains: string[] }> {
  const { config, allowedDomains } = await ctx.crm('checkout.public', { checkoutId });
  return { config: { ...config, tenant: ctx.tenant.slug }, allowedDomains };
}

async function config(ctx: GatewayContext, input: unknown): Promise<Output<'checkout.config'>> {
  const { checkoutId } = parse(refSchema, input);
  return (await publicConfig(ctx, checkoutId)).config;
}

async function hosted(ctx: GatewayContext, input: unknown): Promise<Output<'checkout.hosted'>> {
  const { checkoutId } = parse(refSchema, input);
  const { config: cfg } = await publicConfig(ctx, checkoutId);
  if (!cfg.settings.hosted_enabled) throw new GatewayError(404, 'not_found', 'checkout not found');
  return { config: cfg, tenantName: ctx.tenant.name };
}

async function quote(ctx: GatewayContext, input: unknown): Promise<Output<'checkout.quote'>> {
  const { checkoutId, selection, promoCode } = parse(quoteSchema, input);
  await limit(ctx, QUOTE_RATE);
  return ctx.crm('checkout.quote', {
    checkoutId,
    selection,
    promoCode,
    locale: ctx.client.acceptLanguage?.split(',')[0]?.trim() ?? null,
  });
}

function intentMetadata(sessionId: string, checkoutId: string, orderId: string | null): Record<string, string> {
  return {
    amable_kind: 'checkout',
    amable_session: sessionId,
    amable_checkout: checkoutId,
    ...(orderId === null ? {} : { amable_order: orderId }),
  };
}

/**
 * Opens (or refreshes) the purchase: the TenantDb validates and drafts the
 * order, the worker creates the Stripe customer and intent. A re-submit with
 * the same session token keeps the same intent (amount updated).
 */
async function session(ctx: GatewayContext, input: unknown): Promise<Output<'checkout.session'>> {
  const { checkoutId, payload: raw } = parse(sessionSchema, input);
  const payload = parse(sessionPayloadSchema, raw);
  if (payload.hp !== '') throw new GatewayError(422, 'validation_failed', 'invalid input');
  await limit(ctx, SESSION_RATE);
  const { config: cfg, allowedDomains } = await publicConfig(ctx, checkoutId);
  if (!domainAllowed(allowedDomains, payload.meta.page_url, ctx.client.referer, `/c/${ctx.tenant.slug}/${cfg.id}`)) {
    throw new GatewayError(403, 'domain_not_allowed', 'this checkout cannot be used on this website');
  }
  const stripe = await stripeOf(ctx);
  const reuse = payload.session_token === '' ? null : await sha256Hex(payload.session_token);
  const freshToken = randomToken(32);
  const prepared = await ctx.crm('checkout.prepare', {
    checkoutId,
    payload: {
      ...payload,
      meta: {
        ...payload.meta,
        visitor_id: payload.meta.visitor_id !== '' ? payload.meta.visitor_id : (ctx.client.visitorId ?? ''),
      },
    },
    tokenHash: await sha256Hex(freshToken),
    existingTokenHash: reuse,
  });
  const activeToken = prepared.reused ? payload.session_token : freshToken;
  try {
    let customerId = prepared.customerId;
    if (customerId === null) {
      const customer = await stripe.client.createCustomer(
        { email: prepared.email, name: prepared.name === '' ? null : prepared.name, metadata: { amable_contact: prepared.contactId } },
        `customer:${ctx.tenant.id}:${prepared.contactId}`,
      );
      customerId = customer.id;
    }
    const metadata = intentMetadata(prepared.sessionId, checkoutId, prepared.orderId);
    let clientSecret: string | null = null;
    let intentId: string | null = null;
    if (prepared.intentKind === 'payment') {
      let intent: StripePaymentIntent | null = null;
      if (prepared.intentId !== null && prepared.previousIntentKind === 'payment') {
        const current = await stripe.client.retrievePaymentIntent(prepared.intentId);
        if (current.status === 'requires_payment_method' || current.status === 'requires_confirmation') {
          intent =
            current.amount === prepared.amountMinor
              ? current
              : await stripe.client.updatePaymentIntent(current.id, {
                  amount: prepared.amountMinor,
                  save: prepared.save,
                  receiptEmail: prepared.email,
                  description: prepared.description,
                  metadata,
                });
        }
      }
      intent ??= await stripe.client.createPaymentIntent(
        {
          amount: prepared.amountMinor,
          currency: prepared.currency,
          customer: customerId,
          save: prepared.save,
          receiptEmail: prepared.email,
          description: prepared.description,
          metadata,
        },
        `checkout:${prepared.sessionId}:${String(prepared.amountMinor)}:${randomToken(6)}`,
      );
      clientSecret = intent.client_secret;
      intentId = intent.id;
    } else if (prepared.intentKind === 'setup') {
      let intent: StripeSetupIntent | null = null;
      if (prepared.intentId !== null && prepared.previousIntentKind === 'setup') {
        const current = await stripe.client.retrieveSetupIntent(prepared.intentId);
        if (current.status === 'requires_payment_method' || current.status === 'requires_confirmation') intent = current;
      }
      intent ??= await stripe.client.createSetupIntent(
        { customer: customerId, metadata },
        `checkout-setup:${prepared.sessionId}:${randomToken(6)}`,
      );
      clientSecret = intent.client_secret;
      intentId = intent.id;
    }
    await ctx.crm('checkout.attachIntent', {
      sessionId: prepared.sessionId,
      contactId: prepared.contactId,
      customerId,
      intentKind: prepared.intentKind === 'none' ? null : prepared.intentKind,
      intentId,
    });
    if (prepared.intentKind === 'none') await ctx.crm('checkout.settleFree', { sessionId: prepared.sessionId });
    return {
      session_token: activeToken,
      intent: { kind: prepared.intentKind, client_secret: clientSecret },
      quote: prepared.quote,
    };
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw stripeFailure(error);
  }
}

function paymentFacts(intent: StripePaymentIntent): IntentFacts {
  return {
    intentId: intent.id,
    kind: 'payment',
    status: intent.status,
    amountReceived: intent.amount_received,
    customerId: intent.customer,
    paymentMethodId: intent.payment_method,
    failureMessage: intent.last_payment_error?.message ?? null,
  };
}

function setupFacts(intent: StripeSetupIntent): IntentFacts {
  return {
    intentId: intent.id,
    kind: 'setup',
    status: intent.status,
    amountReceived: 0,
    customerId: intent.customer,
    paymentMethodId: intent.payment_method,
    failureMessage: intent.last_setup_error?.message ?? null,
  };
}

/** The browser says Stripe.js confirmed: read the intent from Stripe (never trust the browser) and settle. */
async function complete(ctx: GatewayContext, input: unknown): Promise<Output<'checkout.complete'>> {
  const { token: raw } = parse(tokenSchema, input);
  const tokenHash = await sha256Hex(raw);
  const state = await ctx.crm('checkout.completion', { tokenHash });
  if (state.status !== 'paid' && state.intentId !== null && state.intentKind !== null) {
    const stripe = await stripeOf(ctx);
    try {
      const facts =
        state.intentKind === 'payment'
          ? paymentFacts(await stripe.client.retrievePaymentIntent(state.intentId))
          : setupFacts(await stripe.client.retrieveSetupIntent(state.intentId));
      await ctx.crm('checkout.settleIntent', facts);
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw stripeFailure(error);
    }
  }
  const { intentId: _id, intentKind: _kind, ...result } = await ctx.crm('checkout.completion', { tokenHash });
  return result;
}

async function offer(ctx: GatewayContext, input: unknown): Promise<Output<'checkout.offer'>> {
  const { token: raw } = parse(tokenSchema, input);
  return ctx.crm('checkout.offerState', { tokenHash: await sha256Hex(raw) });
}

async function offerOutcome(
  ctx: GatewayContext,
  sessionId: string,
  status: OfferActionResult['status'],
  extra: { clientSecret?: string | null; publishableKey?: string | null; message?: string | null } = {},
): Promise<OfferActionResult> {
  const done = status === 'paid' || status === 'declined';
  return {
    status,
    client_secret: extra.clientSecret ?? null,
    publishable_key: extra.publishableKey ?? null,
    message: extra.message ?? null,
    next: done ? await ctx.crm('checkout.offerNext', { sessionId }) : null,
  };
}

async function settleIntent(
  ctx: GatewayContext,
  stripe: OpenStripe,
  charge: { sessionId: string; orderId: string | null },
  offerKey: string,
  intent: StripePaymentIntent,
): Promise<OfferActionResult> {
  const status =
    intent.status === 'succeeded'
      ? ('succeeded' as const)
      : intent.status === 'requires_action' || intent.status === 'processing'
        ? ('requires_action' as const)
        : ('failed' as const);
  const result = await ctx.crm('checkout.offerSettle', {
    sessionId: charge.sessionId,
    offerKey,
    orderId: charge.orderId ?? intent.metadata['amable_order'] ?? null,
    intentId: intent.id,
    status,
    amountReceived: intent.amount_received,
    message: intent.last_payment_error?.message ?? null,
  });
  if (result.state === 'accepted') return offerOutcome(ctx, charge.sessionId, 'paid');
  if (result.state === 'requires_action') {
    return offerOutcome(ctx, charge.sessionId, 'requires_action', {
      clientSecret: intent.client_secret,
      publishableKey: stripe.publishableKey,
    });
  }
  if (result.state === 'stale') return offerOutcome(ctx, charge.sessionId, 'paid');
  return offerOutcome(ctx, charge.sessionId, 'failed', { message: intent.last_payment_error?.message ?? null });
}

/**
 * One click: charge the saved payment method on session (the buyer is
 * present, so 3-D Secure can be asked back). The idempotency key per
 * session, offer and attempt makes double clicks and retries harmless.
 */
async function offerAccept(ctx: GatewayContext, input: unknown): Promise<Output<'checkout.offerAccept'>> {
  const { token: raw, offerKey } = parse(offerSchema, input);
  await limit(ctx, OFFER_RATE);
  const tokenHash = await sha256Hex(raw);
  const charge = await ctx.crm('checkout.offerPrepare', { tokenHash, offerKey });
  if (charge.action === 'none') {
    return offerOutcome(ctx, charge.sessionId, 'failed', { message: 'this offer is no longer available' });
  }
  if (charge.action === 'free') {
    await ctx.crm('checkout.offerSettle', {
      sessionId: charge.sessionId,
      offerKey,
      orderId: charge.orderId,
      intentId: null,
      status: 'succeeded',
      amountReceived: 0,
      message: null,
    });
    return offerOutcome(ctx, charge.sessionId, 'paid');
  }
  const stripe = await stripeOf(ctx);
  try {
    if (charge.action === 'check' && charge.pendingIntentId !== null) {
      const intent = await stripe.client.retrievePaymentIntent(charge.pendingIntentId);
      return await settleIntent(ctx, stripe, { sessionId: charge.sessionId, orderId: null }, offerKey, intent);
    }
    if (charge.customerId === null || charge.paymentMethodId === null) {
      throw new GatewayError(409, 'no_payment_method', 'no saved payment method for this purchase');
    }
    let intent: StripePaymentIntent;
    try {
      intent = await stripe.client.chargeSavedMethod(
        {
          amount: charge.amountMinor,
          currency: charge.currency,
          customer: charge.customerId,
          paymentMethod: charge.paymentMethodId,
          offSession: false,
          receiptEmail: charge.receiptEmail,
          description: charge.description,
          metadata: {
            amable_kind: 'offer',
            amable_session: charge.sessionId,
            amable_offer: offerKey,
            ...(charge.orderId === null ? {} : { amable_order: charge.orderId }),
          },
        },
        `offer:${charge.sessionId}:${offerKey}:${String(charge.attempt)}`,
      );
    } catch (error) {
      if (error instanceof StripeApiError && error.error.payment_intent !== null) {
        intent = error.error.payment_intent;
      } else if (error instanceof StripeApiError && error.error.type === 'card_error') {
        await ctx.crm('checkout.offerSettle', {
          sessionId: charge.sessionId,
          offerKey,
          orderId: charge.orderId,
          intentId: null,
          status: 'failed',
          amountReceived: 0,
          message: error.message,
        });
        return await offerOutcome(ctx, charge.sessionId, 'failed', { message: error.message });
      } else {
        throw error;
      }
    }
    return await settleIntent(ctx, stripe, { sessionId: charge.sessionId, orderId: charge.orderId }, offerKey, intent);
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw stripeFailure(error);
  }
}

/** After `handleNextAction` (3-D Secure) in the browser. */
async function offerConfirm(ctx: GatewayContext, input: unknown): Promise<Output<'checkout.offerConfirm'>> {
  const { token: raw, offerKey } = parse(offerSchema, input);
  const charge = await ctx.crm('checkout.offerPrepare', { tokenHash: await sha256Hex(raw), offerKey });
  if (charge.action !== 'check' || charge.pendingIntentId === null) {
    return offerOutcome(ctx, charge.sessionId, charge.action === 'none' ? 'paid' : 'failed');
  }
  const stripe = await stripeOf(ctx);
  try {
    const intent = await stripe.client.retrievePaymentIntent(charge.pendingIntentId);
    return await settleIntent(ctx, stripe, { sessionId: charge.sessionId, orderId: null }, offerKey, intent);
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw stripeFailure(error);
  }
}

async function offerDecline(ctx: GatewayContext, input: unknown): Promise<Output<'checkout.offerDecline'>> {
  const { token: raw, offerKey } = parse(offerSchema, input);
  const tokenHash = await sha256Hex(raw);
  await ctx.crm('checkout.offerDecline', { tokenHash, offerKey });
  const state = await ctx.crm('checkout.offerState', { tokenHash });
  return {
    status: 'declined',
    client_secret: null,
    publishable_key: null,
    message: null,
    next: state.status === 'done' ? state.next : { kind: 'offer', url: null },
  };
}

async function address(ctx: GatewayContext, input: unknown): Promise<Output<'checkout.address'>> {
  const { checkoutId, q, country, lang } = parse(addressSchema, input);
  await limit(ctx, ADDRESS_RATE);
  const { config: cfg } = await publicConfig(ctx, checkoutId);
  if (cfg.contact.address === 'hidden' || !cfg.contact.address_autocomplete) return { data: [] };
  const data = await suggestAddresses(ctx.env, ctx.tenant.id, {
    q,
    ...(country === '' ? {} : { country: country.toUpperCase() }),
    ...(lang === '' ? {} : { lang: lang.slice(0, 2).toLowerCase() }),
  });
  return { data };
}

/**
 * Stripe webhook of the workspace account: verified with its signing secret,
 * then dispatched to the TenantDb (idempotent: Stripe retries, the browser
 * may have settled first).
 */
async function stripeWebhook(ctx: GatewayContext, input: unknown): Promise<Output<'checkout.stripeWebhook'>> {
  const { payload, signature } = parse(webhookSchema, input);
  const account: StoredStripeAccount | null = await ctx.crm('stripe.account', {});
  if (account === null || account.webhook_enc === null) {
    throw new GatewayError(404, 'not_found', 'no webhook endpoint configured');
  }
  const runtime = await commerceRuntime(ctx.env);
  const stripe = await openStripe(runtime, account);
  if (stripe.webhookSecret === null || !(await verifyStripeSignature(payload, signature, stripe.webhookSecret, runtime.now()))) {
    throw new GatewayError(400, 'invalid_signature', 'invalid Stripe signature');
  }
  const event = parseStripeEvent(payload);
  if (event === null) throw new GatewayError(400, 'bad_request', 'invalid event');
  if (event.type.startsWith('payment_intent.')) {
    const intent = asPaymentIntent(event);
    await ctx.crm('stripe.event', { type: 'intent', intent: paymentFacts(intent), metadata: intent.metadata ?? {} });
  } else if (event.type.startsWith('setup_intent.')) {
    const intent = asSetupIntent(event);
    await ctx.crm('stripe.event', { type: 'intent', intent: setupFacts(intent), metadata: intent.metadata ?? {} });
  } else if (event.type === 'charge.refunded') {
    const charge = asCharge(event);
    await ctx.crm('stripe.event', {
      type: 'charge.refunded',
      chargeId: charge.id,
      paymentIntentId: charge.payment_intent,
      amountRefunded: charge.amount_refunded,
    });
  }
  return { received: true };
}

/** Public ops reachable from the edge worker (see `CheckoutGatewayOps` in @amable/checkout). */
export const checkoutGatewayHandlers: GatewayHandlers = {
  'checkout.config': config,
  'checkout.hosted': hosted,
  'checkout.quote': quote,
  'checkout.session': session,
  'checkout.complete': complete,
  'checkout.offer': offer,
  'checkout.offerAccept': offerAccept,
  'checkout.offerConfirm': offerConfirm,
  'checkout.offerDecline': offerDecline,
  'checkout.address': address,
  'checkout.stripeWebhook': stripeWebhook,
};
