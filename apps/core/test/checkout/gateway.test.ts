import { afterEach, describe, expect, it } from 'vitest';
import { overrideAuthServices, type AuthServices } from '../../src/auth/services';
import { checkoutGatewayHandlers } from '../../src/checkout/gateway';
import type { StripePaymentIntent } from '../../src/commerce/stripe/client';
import { overrideCommerceRuntime } from '../../src/commerce/stripe/runtime';
import { signStripePayload } from '../../src/commerce/stripe/webhook';
import type { Env } from '../../src/env';
import type { GatewayContext } from '../../src/public/context';
import { commerceWorld, type CommerceWorld } from '../commerce/helpers';

const WEBHOOK_SECRET = 'whsec_gateway_test';

interface FakeStripe {
  intents: Map<string, StripePaymentIntent>;
  requests: Array<{ method: string; path: string; body: URLSearchParams; idempotencyKey: string | null }>;
  /** What a confirmed saved-method charge answers. */
  chargeStatus: StripePaymentIntent['status'];
}

function intent(id: string, fields: Partial<StripePaymentIntent>): StripePaymentIntent {
  return {
    id,
    status: 'requires_payment_method',
    amount: 0,
    amount_received: 0,
    currency: 'eur',
    customer: 'cus_1',
    payment_method: null,
    client_secret: `${id}_secret`,
    metadata: {},
    last_payment_error: null,
    ...fields,
  } as StripePaymentIntent;
}

function fakeStripe(): { stripe: FakeStripe; fetch: (url: string, init?: RequestInit) => Promise<Response> } {
  const stripe: FakeStripe = { intents: new Map(), requests: [], chargeStatus: 'succeeded' };
  let seq = 0;
  const fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const path = new URL(url).pathname;
    const method = init.method ?? 'GET';
    const body = new URLSearchParams(typeof init.body === 'string' ? init.body : '');
    const headers = new Headers(init.headers);
    stripe.requests.push({ method, path, body, idempotencyKey: headers.get('idempotency-key') });
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    const metadata: Record<string, string> = {};
    for (const [k, v] of body) {
      const m = /^metadata\[(.+)\]$/.exec(k);
      if (m?.[1] !== undefined) metadata[m[1]] = v;
    }
    if (method === 'POST' && path === '/v1/customers') return json({ id: 'cus_1', email: body.get('email') });
    if (method === 'POST' && path === '/v1/payment_intents') {
      seq += 1;
      const id = `pi_${String(seq)}`;
      const amount = Number(body.get('amount'));
      const confirmed = body.get('confirm') === 'true';
      const status = confirmed ? stripe.chargeStatus : 'requires_payment_method';
      const created = intent(id, {
        amount,
        status,
        amount_received: status === 'succeeded' ? amount : 0,
        payment_method: body.get('payment_method'),
        metadata,
      });
      stripe.intents.set(id, created);
      return json(created);
    }
    const one = /^\/v1\/payment_intents\/([^/]+)$/.exec(path);
    if (one?.[1] !== undefined) {
      const current = stripe.intents.get(one[1]);
      if (current === undefined) return new Response('{}', { status: 404 });
      if (method === 'POST') {
        const updated = { ...current, amount: Number(body.get('amount') ?? current.amount), metadata: { ...current.metadata, ...metadata } };
        stripe.intents.set(current.id, updated);
        return json(updated);
      }
      return json(current);
    }
    return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: `unexpected ${method} ${path}` } }), { status: 400 });
  };
  return { stripe, fetch };
}

function gateway(w: CommerceWorld): { stripe: FakeStripe; call: (op: string, input: unknown) => Promise<unknown> } {
  const { stripe, fetch } = fakeStripe();
  overrideAuthServices(async () => ({ now: () => w.t.clock.now }) as unknown as AuthServices);
  overrideCommerceRuntime(() => ({
    now: () => w.t.clock.now,
    secretBox: {
      encrypt: async (plain: string) => `enc:${plain}`,
      decrypt: async (enc: string) => enc.replace(/^enc:/, ''),
    } as never,
    fetch,
    limiter: { consume: async () => ({ allowed: true }) } as never,
  }));
  w.t.op('stripe.saveAccount', {
    tenantId: 'tenant_test',
    publishableKey: 'pk_test_0123456789abcdef',
    secret: { enc: 'enc:sk_test_0123456789abcdef', hint: 'cdef' },
    webhook: { enc: `enc:${WEBHOOK_SECRET}`, hint: 'test' },
  });
  const ctx = {
    env: { ENVIRONMENT: 'dev' } as unknown as Env,
    executionCtx: { waitUntil: () => undefined } as unknown as ExecutionContext,
    tenant: { id: 'tenant_test', slug: 'demo', name: 'Demo' },
    client: { ip: null, userAgent: null, country: null, visitorId: 'v_gw', referer: null, acceptLanguage: 'en' },
    tenantDb: () => {
      throw new Error('not used');
    },
    crm: async (op: string, input: unknown) => (w.t.op as (op: string, input: unknown) => unknown)(op, input),
  } as unknown as GatewayContext;
  return {
    stripe,
    call: (op, input) => {
      const handler = checkoutGatewayHandlers[op];
      if (handler === undefined) throw new Error(`no handler ${op}`);
      return handler(ctx, input);
    },
  };
}

async function webhook(call: (op: string, input: unknown) => Promise<unknown>, event: unknown, secret = WEBHOOK_SECRET, at = Date.now()) {
  const payload = JSON.stringify(event);
  const t = Math.floor(at / 1000);
  const signature = `t=${String(t)},v1=${await signStripePayload(secret, t, payload)}`;
  return call('checkout.stripeWebhook', { payload, signature });
}

afterEach(() => {
  overrideCommerceRuntime(null);
  overrideAuthServices(null);
});

describe('checkout gateway', () => {
  it('opens the intent, settles it from a signed webhook and charges an upsell with one click', async () => {
    const w = commerceWorld();
    w.t.clock.now = Date.now();
    const { stripe, call } = gateway(w);
    const c = w.t.op('checkouts.create', {
      name: 'Launch',
      status: 'active',
      definition: {
        items: [{ id: 'i1', kind: 'product', ref_id: w.course }],
        offers: [{ key: 'up', ref_id: w.mug, title: 'Mug' }],
        settings: { first_offer: 'up' },
      },
    });
    const session = (await call('checkout.session', {
      checkoutId: c.id,
      payload: { buyer: { email: 'buyer@example.com', given_name: 'Mary', family_name: 'Shelley' }, tracking: { utm_source: 'ads' } },
    })) as { session_token: string; intent: { kind: string; client_secret: string } };
    expect(session.intent).toEqual({ kind: 'payment', client_secret: 'pi_1_secret' });
    const created = stripe.requests.find((r) => r.path === '/v1/payment_intents');
    expect(created?.body.get('setup_future_usage')).toBe('off_session');
    expect(created?.body.get('metadata[amable_kind]')).toBe('checkout');

    // A re-submit keeps the same token and the same intent.
    const again = (await call('checkout.session', {
      checkoutId: c.id,
      payload: { buyer: { email: 'buyer@example.com', given_name: 'Mary', family_name: 'Shelley' }, session_token: session.session_token },
    })) as { session_token: string; intent: { client_secret: string } };
    expect(again.session_token).toBe(session.session_token);
    expect(again.intent.client_secret).toBe('pi_1_secret');
    expect(stripe.requests.filter((r) => r.method === 'POST' && r.path === '/v1/payment_intents')).toHaveLength(1);

    const pi = stripe.intents.get('pi_1');
    if (pi === undefined) throw new Error('intent missing');
    const paidIntent = { ...pi, status: 'succeeded', amount_received: pi.amount, payment_method: 'pm_1' };
    stripe.intents.set('pi_1', paidIntent as StripePaymentIntent);
    const event = { id: 'evt_1', type: 'payment_intent.succeeded', data: { object: paidIntent } };
    await expect(webhook(call, event, 'whsec_wrong')).rejects.toMatchObject({ status: 400, code: 'invalid_signature' });
    expect(await webhook(call, event)).toEqual({ received: true });
    expect(await webhook(call, event)).toEqual({ received: true });

    const completed = (await call('checkout.complete', { token: session.session_token })) as { status: string; next: unknown };
    expect(completed).toMatchObject({ status: 'paid', next: { kind: 'offer', url: null } });
    const orders = w.t.op('orders.list', { limit: 10 }).data;
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ status: 'paid', source: 'checkout', analytics_visitor_id: 'v_gw' });

    const accepted = (await call('checkout.offerAccept', { token: session.session_token, offerKey: 'up' })) as { status: string; next: unknown };
    expect(accepted).toMatchObject({ status: 'paid', next: { kind: 'thank_you' } });
    const charge = stripe.requests.filter((r) => r.method === 'POST' && r.path === '/v1/payment_intents')[1];
    expect(charge?.body.get('payment_method')).toBe('pm_1');
    expect(charge?.body.get('confirm')).toBe('true');
    expect(charge?.idempotencyKey).toMatch(/^offer:.+:up:1$/);
    // A second click after the payment does not charge again.
    const twice = (await call('checkout.offerAccept', { token: session.session_token, offerKey: 'up' })) as { status: string };
    expect(twice.status).toBe('failed');
    expect(stripe.requests.filter((r) => r.method === 'POST' && r.path === '/v1/payment_intents')).toHaveLength(2);
    expect(w.t.op('orders.list', { limit: 10 }).data.filter((o) => o.status === 'paid')).toHaveLength(2);
  });

  it('asks the buyer back for 3-D Secure on an upsell, then confirms it', async () => {
    const w = commerceWorld();
    w.t.clock.now = Date.now();
    const { stripe, call } = gateway(w);
    const c = w.t.op('checkouts.create', {
      name: 'Launch',
      status: 'active',
      definition: {
        items: [{ id: 'i1', kind: 'product', ref_id: w.course }],
        offers: [{ key: 'up', ref_id: w.mug, title: 'Mug' }],
        settings: { first_offer: 'up' },
      },
    });
    const session = (await call('checkout.session', {
      checkoutId: c.id,
      payload: { buyer: { email: 'buyer@example.com', given_name: 'Mary', family_name: 'Shelley' } },
    })) as { session_token: string };
    const pi = stripe.intents.get('pi_1');
    if (pi === undefined) throw new Error('intent missing');
    stripe.intents.set('pi_1', { ...pi, status: 'succeeded', amount_received: pi.amount, payment_method: 'pm_1' } as StripePaymentIntent);
    await call('checkout.complete', { token: session.session_token });

    stripe.chargeStatus = 'requires_action';
    const pending = (await call('checkout.offerAccept', { token: session.session_token, offerKey: 'up' })) as Record<string, unknown>;
    expect(pending).toMatchObject({ status: 'requires_action', client_secret: 'pi_2_secret', publishable_key: 'pk_test_0123456789abcdef' });
    const upsell = stripe.intents.get('pi_2');
    if (upsell === undefined) throw new Error('upsell intent missing');
    stripe.intents.set('pi_2', { ...upsell, status: 'succeeded', amount_received: upsell.amount } as StripePaymentIntent);
    const confirmed = (await call('checkout.offerConfirm', { token: session.session_token, offerKey: 'up' })) as Record<string, unknown>;
    expect(confirmed).toMatchObject({ status: 'paid', next: { kind: 'thank_you' } });
    expect(stripe.requests.filter((r) => r.method === 'POST' && r.path === '/v1/payment_intents')).toHaveLength(2);
  });
});
