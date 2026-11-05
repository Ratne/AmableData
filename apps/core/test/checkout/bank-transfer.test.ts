import type { EmailSendRequest } from '@amable/core';
import { afterEach, describe, expect, it } from 'vitest';
import { overrideAuthServices, type AuthServices } from '../../src/auth/services';
import { checkoutGatewayHandlers } from '../../src/checkout/gateway';
import type { StripeCheckoutSession } from '../../src/commerce/stripe/client';
import { overrideCommerceRuntime } from '../../src/commerce/stripe/runtime';
import { signStripePayload } from '../../src/commerce/stripe/webhook';
import type { Env } from '../../src/env';
import type { GatewayContext } from '../../src/public/context';
import { commerceWorld, type CommerceWorld } from '../commerce/helpers';

const WEBHOOK_SECRET = 'whsec_bank_test';
const BUYER = { email: 'buyer@example.com', given_name: 'Mary', family_name: 'Shelley' };
const PAGE = 'https://shop.example.com/buy';

interface Request {
  method: string;
  path: string;
  body: URLSearchParams;
  version: string | null;
}

interface FakeStripe {
  requests: Request[];
  sessions: Map<string, StripeCheckoutSession>;
}

function fakeStripe(): { stripe: FakeStripe; fetch: (url: string, init?: RequestInit) => Promise<Response> } {
  const stripe: FakeStripe = { requests: [], sessions: new Map() };
  let seq = 0;
  const fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const path = new URL(url).pathname;
    const method = init.method ?? 'GET';
    const body = new URLSearchParams(typeof init.body === 'string' ? init.body : '');
    stripe.requests.push({ method, path, body, version: new Headers(init.headers).get('stripe-version') });
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    if (method === 'POST' && path === '/v1/checkout/sessions') {
      seq += 1;
      const metadata: Record<string, string> = {};
      let amount = 0;
      for (const [k, v] of body) {
        const m = /^metadata\[(.+)\]$/.exec(k);
        if (m?.[1] !== undefined) metadata[m[1]] = v;
        if (/^line_items\[\d+\]\[price_data\]\[unit_amount\]$/.test(k)) amount += Number(v);
      }
      const created: StripeCheckoutSession = {
        id: `cs_${String(seq)}`,
        object: 'checkout.session',
        status: 'open',
        payment_status: 'unpaid',
        url: `https://checkout.stripe.com/c/pay/cs_${String(seq)}`,
        payment_intent: null,
        // Stripe adds the taxes on top of the lines.
        amount_total: amount + 100,
        currency: 'eur',
        metadata,
      };
      stripe.sessions.set(created.id, created);
      return json(created);
    }
    const one = /^\/v1\/checkout\/sessions\/([^/]+)(\/expire)?$/.exec(path);
    if (one?.[1] !== undefined) {
      const current = stripe.sessions.get(one[1]);
      if (current === undefined) return new Response('{}', { status: 404 });
      if (one[2] !== undefined) stripe.sessions.set(current.id, { ...current, status: 'expired' });
      return json(stripe.sessions.get(current.id));
    }
    return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: `unexpected ${method} ${path}` } }), {
      status: 400,
    });
  };
  return { stripe, fetch };
}

function pay(stripe: FakeStripe, id: string): StripeCheckoutSession {
  const current = stripe.sessions.get(id);
  if (current === undefined) throw new Error(`no checkout session ${id}`);
  const paid: StripeCheckoutSession = { ...current, status: 'complete', payment_status: 'paid', payment_intent: `pi_${id}` };
  stripe.sessions.set(id, paid);
  return paid;
}

function gateway(w: CommerceWorld, options: { stripe: 'none' | 'managed' }) {
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
  if (options.stripe === 'managed') {
    w.t.op('stripe.saveAccount', {
      tenantId: 'tenant_test',
      publishableKey: 'pk_test_0123456789abcdef',
      secret: { enc: 'enc:sk_test_0123456789abcdef', hint: 'cdef' },
      webhook: { enc: `enc:${WEBHOOK_SECRET}`, hint: 'test' },
    });
    w.t.op('stripe.setManaged', { managed: true, defaultTaxCode: 'txcd_10000000' });
  }
  const ctx = {
    env: { ENVIRONMENT: 'dev' } as unknown as Env,
    executionCtx: { waitUntil: () => undefined } as unknown as ExecutionContext,
    tenant: { id: 'tenant_test', slug: 'demo', name: 'Demo' },
    client: { ip: null, userAgent: null, country: null, visitorId: 'v_bank', referer: null, acceptLanguage: 'en' },
    tenantDb: () => {
      throw new Error('not used');
    },
    crm: async (op: string, input: unknown) => (w.t.op as (op: string, input: unknown) => unknown)(op, input),
  } as unknown as GatewayContext;
  const call = (op: string, input: unknown): Promise<unknown> => {
    const handler = checkoutGatewayHandlers[op];
    if (handler === undefined) throw new Error(`no handler ${op}`);
    return handler(ctx, input);
  };
  return { stripe, call };
}

async function webhook(call: (op: string, input: unknown) => Promise<unknown>, event: unknown) {
  const payload = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  return call('checkout.stripeWebhook', { payload, signature: `t=${String(t)},v1=${await signStripePayload(WEBHOOK_SECRET, t, payload)}` });
}

function bankAccount(w: CommerceWorld): string {
  return w.t.op('bankAccounts.create', {
    label: 'Main',
    holder: 'Demo Srl',
    iban: 'IT60 X054 2811 1010 0000 0123 456',
    bic: 'BPMOIT22',
    bank_name: 'Banca Demo',
    instructions: '',
  }).id;
}

function summaries(w: CommerceWorld): EmailSendRequest[] {
  return w.t.op('checkout.dueSummaries', {}).emails;
}

function bodyText(email: EmailSendRequest | undefined): string {
  return JSON.stringify(email?.content.body ?? null);
}

afterEach(() => {
  overrideCommerceRuntime(null);
  overrideAuthServices(null);
});

describe('bank transfer checkout', () => {
  it('places the order unpaid without Stripe, adds accepted offers and sends one summary at the end', async () => {
    const w = commerceWorld();
    w.t.clock.now = Date.now();
    const { stripe, call } = gateway(w, { stripe: 'none' });
    const tag = w.t.op('tags.create', { name: 'Customer' });
    const accountId = bankAccount(w);
    const c = w.t.op('checkouts.create', {
      name: 'Launch',
      status: 'active',
      definition: {
        items: [{ id: 'i1', kind: 'product', ref_id: w.course }],
        offers: [
          { key: 'sub', item_kind: 'plan', ref_id: w.monthly, title: 'Pro', on_decline: 'up' },
          { key: 'up', ref_id: w.mug, title: 'Mug' },
        ],
        settings: { first_offer: 'sub' },
        crm: { tag_ids: [tag.id] },
        payments: { card: false, bank_transfer: { enabled: true, account_id: accountId } },
      },
    });
    const config = (await call('checkout.config', { checkoutId: c.id })) as { payments: unknown };
    expect(config.payments).toEqual({ card: false, bank_transfer: true, card_flow: 'element' });

    await expect(
      call('checkout.session', { checkoutId: c.id, payload: { buyer: BUYER, payment_method: 'card' } }),
    ).rejects.toMatchObject({ shape: { code: 'validation_failed' } });

    const session = (await call('checkout.session', {
      checkoutId: c.id,
      payload: { buyer: BUYER, payment_method: 'bank_transfer' },
    })) as { session_token: string; intent: unknown };
    expect(session.intent).toEqual({ kind: 'bank_transfer', client_secret: null, redirect_url: null });
    expect(stripe.requests).toHaveLength(0);

    // The subscription offer is skipped (no saved card): the mug comes first.
    const done = (await call('checkout.complete', { token: session.session_token })) as Record<string, unknown>;
    expect(done).toMatchObject({ status: 'pending', next: { kind: 'offer' } });
    expect(done['bank_transfer']).toMatchObject({ holder: 'Demo Srl', iban: 'IT60 X054 2811 1010 0000 0123 456', total_minor: 24_278 });
    const offer = (await call('checkout.offer', { token: session.session_token })) as { offer: { key: string; payment_method: string } };
    expect(offer.offer).toMatchObject({ key: 'up', payment_method: 'bank_transfer' });

    const main = w.t.op('orders.list', { limit: 10 }).data;
    expect(main).toHaveLength(1);
    expect(main[0]).toMatchObject({ status: 'unpaid', payment_method: 'bank_transfer', paid_minor: 0 });
    const contactId = main[0]?.contact_id ?? '';
    expect(w.t.op('contacts.get', { id: contactId }).tag_ids).toEqual([]);
    // Waiting for the answer on the offer: nothing is sent yet.
    expect(summaries(w)).toHaveLength(0);

    const accepted = (await call('checkout.offerAccept', { token: session.session_token, offerKey: 'up' })) as Record<string, unknown>;
    expect(accepted).toMatchObject({ status: 'paid', next: { kind: 'thank_you' } });
    expect(stripe.requests).toHaveLength(0);
    const orders = w.t.op('orders.list', { limit: 10 }).data;
    expect(orders).toHaveLength(2);
    expect(orders.every((o) => o.status === 'unpaid' && o.payment_method === 'bank_transfer')).toBe(true);

    const [email, ...rest] = summaries(w);
    expect(rest).toHaveLength(0);
    expect(email).toMatchObject({ contactId, source: { type: 'transactional', purpose: 'checkout' } });
    for (const o of orders) expect(bodyText(email)).toContain(o.number);
    expect(bodyText(email)).toContain('IT60 X054 2811 1010 0000 0123 456');
    expect(summaries(w)).toHaveLength(0);

    const final = (await call('checkout.complete', { token: session.session_token })) as { bank_transfer: { orders: unknown[]; total_minor: number } };
    expect(final.bank_transfer.orders).toHaveLength(2);
    expect(final.bank_transfer.total_minor).toBe(orders.reduce((sum, o) => sum + o.total_minor, 0));

    // The transfer arrives: recorded by hand, the order is paid and the buyer gets the checkout tags.
    const first = orders.find((o) => o.parent_order_id === null);
    if (first === undefined) throw new Error('main order missing');
    w.t.op('payments.record', { orderId: first.id, data: { amount_minor: first.total_minor, method: 'bank_transfer' } });
    expect(w.t.op('orders.get', { id: first.id }).status).toBe('paid');
    expect(w.t.op('contacts.get', { id: contactId }).tag_ids).toEqual([tag.id]);
    expect(w.t.op('checkouts.get', { id: c.id }).stats).toMatchObject({ sessions: 1, paid: 1 });
  });

  it('sends the summary after 15 idle minutes, or right away when the page is closed', async () => {
    const w = commerceWorld();
    w.t.clock.now = Date.now();
    const { call } = gateway(w, { stripe: 'none' });
    const accountId = bankAccount(w);
    const c = w.t.op('checkouts.create', {
      name: 'Launch',
      status: 'active',
      definition: {
        items: [{ id: 'i1', kind: 'product', ref_id: w.course }],
        offers: [{ key: 'up', ref_id: w.mug, title: 'Mug' }],
        settings: { first_offer: 'up', offer_window_minutes: 60 },
        payments: { card: false, bank_transfer: { enabled: true, account_id: accountId } },
      },
    });
    const open = async () =>
      (await call('checkout.session', { checkoutId: c.id, payload: { buyer: BUYER, payment_method: 'bank_transfer' } })) as {
        session_token: string;
      };

    const idle = await open();
    expect(summaries(w)).toHaveLength(0);
    w.t.clock.now += 15 * 60_000;
    expect(summaries(w)).toHaveLength(1);

    // An offer accepted after the summary went out: one corrected summary follows.
    await call('checkout.offerAccept', { token: idle.session_token, offerKey: 'up' });
    const corrected = summaries(w);
    expect(corrected).toHaveLength(1);
    const placed = w.t.op('orders.list', { limit: 10 }).data;
    expect(placed).toHaveLength(2);
    for (const o of placed) expect(bodyText(corrected[0])).toContain(o.number);

    const closed = await open();
    expect(await call('checkout.flushSummary', { token: closed.session_token })).toEqual({ sent: true });
    expect(summaries(w)).toHaveLength(1);
    expect(await call('checkout.flushSummary', { token: closed.session_token })).toEqual({ sent: false });
  });

  it('refuses bank transfer for subscriptions', async () => {
    const w = commerceWorld();
    const accountId = bankAccount(w);
    expect(() =>
      w.t.op('checkouts.create', {
        name: 'Sub',
        definition: {
          items: [{ id: 'i1', kind: 'plan', ref_id: w.monthly }],
          payments: { card: false, bank_transfer: { enabled: true, account_id: accountId } },
        },
      }),
    ).toThrow(/card payment/);
    expect(() =>
      w.t.op('checkouts.create', {
        name: 'Missing account',
        definition: {
          items: [{ id: 'i1', kind: 'product', ref_id: w.course }],
          payments: { card: true, bank_transfer: { enabled: true, account_id: 'nope' } },
        },
      }),
    ).toThrow(/not found/);
    w.t.clock.now = Date.now();
    const { call } = gateway(w, { stripe: 'none' });
    const c = w.t.op('checkouts.create', {
      name: 'Mixed',
      status: 'active',
      definition: {
        items: [
          { id: 'i1', kind: 'plan', ref_id: w.monthly },
          { id: 'i2', kind: 'product', ref_id: w.course },
        ],
        settings: { selection: 'single' },
        payments: { card: true, bank_transfer: { enabled: true, account_id: accountId } },
      },
    });
    await expect(
      call('checkout.session', {
        checkoutId: c.id,
        payload: { buyer: BUYER, payment_method: 'bank_transfer', selection: { items: ['i1'] } },
      }),
    ).rejects.toMatchObject({ shape: { code: 'validation_failed' } });
  });
});

describe('Stripe Managed Payments checkout', () => {
  it('pays on Stripe Checkout, settles from the webhook and takes upsells through a new Checkout Session', async () => {
    const w = commerceWorld();
    w.t.clock.now = Date.now();
    const { stripe, call } = gateway(w, { stripe: 'managed' });
    const c = w.t.op('checkouts.create', {
      name: 'Launch',
      status: 'active',
      definition: {
        items: [{ id: 'i1', kind: 'product', ref_id: w.course }],
        offers: [{ key: 'up', ref_id: w.mug, title: 'Mug' }],
        settings: { first_offer: 'up' },
      },
    });
    const config = (await call('checkout.config', { checkoutId: c.id })) as { payments: { card_flow: string } };
    expect(config.payments.card_flow).toBe('redirect');

    const session = (await call('checkout.session', {
      checkoutId: c.id,
      payload: { buyer: BUYER, return_url: PAGE },
    })) as { session_token: string; intent: { kind: string; redirect_url: string } };
    expect(session.intent).toMatchObject({ kind: 'redirect', redirect_url: 'https://checkout.stripe.com/c/pay/cs_1' });
    const created = stripe.requests.find((r) => r.method === 'POST' && r.path === '/v1/checkout/sessions');
    expect(created?.version).toBe('2025-09-30.clover');
    expect(created?.body.get('managed_payments[enabled]')).toBe('true');
    expect(created?.body.get('mode')).toBe('payment');
    expect(created?.body.get('line_items[0][price_data][product_data][tax_code]')).toBe('txcd_10000000');
    expect(created?.body.get('customer_email')).toBe('buyer@example.com');
    expect(created?.body.has('automatic_tax[enabled]')).toBe(false);
    expect(new URL(created?.body.get('success_url') ?? '').searchParams.get('amb_cs')).toBe(session.session_token);
    expect(stripe.requests.some((r) => r.path === '/v1/customers' || r.path === '/v1/payment_intents')).toBe(false);

    const paid = pay(stripe, 'cs_1');
    expect(await webhook(call, { id: 'evt_1', type: 'checkout.session.completed', data: { object: paid } })).toEqual({ received: true });
    const completed = (await call('checkout.complete', { token: session.session_token })) as Record<string, unknown>;
    expect(completed).toMatchObject({ status: 'paid', next: { kind: 'offer' } });
    const [order] = w.t.op('orders.list', { limit: 10 }).data;
    // The whole order total is recorded, not Stripe's amount with its taxes.
    expect(order).toMatchObject({ status: 'paid', payment_method: 'card' });
    expect(order?.paid_minor).toBe(order?.total_minor);
    expect(w.t.op('payments.list', { order_id: order?.id ?? '', limit: 10 }).data[0]).toMatchObject({ transaction_id: 'pi_cs_1' });

    const offer = (await call('checkout.offer', { token: session.session_token })) as { offer: { card_flow: string } };
    expect(offer.offer.card_flow).toBe('redirect');
    const redirect = (await call('checkout.offerAccept', {
      token: session.session_token,
      offerKey: 'up',
      returnUrl: `${PAGE}/offer`,
    })) as Record<string, unknown>;
    expect(redirect).toMatchObject({ status: 'redirect', redirect_url: 'https://checkout.stripe.com/c/pay/cs_2' });
    const upsell = stripe.requests.filter((r) => r.method === 'POST' && r.path === '/v1/checkout/sessions')[1];
    expect(upsell?.body.get('metadata[amable_kind]')).toBe('offer');
    expect(new URL(upsell?.body.get('success_url') ?? '').searchParams.get('amb_offer')).toBe('up');

    // Back from Stripe before paying: sent to the same page again.
    const again = (await call('checkout.offerConfirm', { token: session.session_token, offerKey: 'up' })) as Record<string, unknown>;
    expect(again).toMatchObject({ status: 'redirect', redirect_url: 'https://checkout.stripe.com/c/pay/cs_2' });
    pay(stripe, 'cs_2');
    const confirmed = (await call('checkout.offerConfirm', { token: session.session_token, offerKey: 'up' })) as Record<string, unknown>;
    expect(confirmed).toMatchObject({ status: 'paid', next: { kind: 'thank_you' } });
    const orders = w.t.op('orders.list', { limit: 10 }).data;
    expect(orders).toHaveLength(2);
    expect(orders.every((o) => o.status === 'paid')).toBe(true);
  });

  it('refuses subscriptions under Managed Payments', async () => {
    const w = commerceWorld();
    w.t.clock.now = Date.now();
    const { call } = gateway(w, { stripe: 'managed' });
    const c = w.t.op('checkouts.create', {
      name: 'Sub',
      status: 'active',
      definition: { items: [{ id: 'i1', kind: 'plan', ref_id: w.monthly }] },
    });
    await expect(call('checkout.session', { checkoutId: c.id, payload: { buyer: BUYER, return_url: PAGE } })).rejects.toMatchObject({
      shape: { code: 'conflict' },
    });
  });
});
