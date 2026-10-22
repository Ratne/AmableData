import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { overrideCommerceRuntime } from '../../src/commerce/stripe/runtime';
import { fakeTenantDbNamespace } from '../crm/helpers';
import { addMember, createHarness, login, seedTenant, seedUser, stepUp, type Harness, type TestClient } from '../helpers/harness';

const BASE = '/api/v2/t/shop';

interface FakeStripe {
  refunded: number;
  requests: Array<{ method: string; path: string; body: URLSearchParams; idempotencyKey: string | null }>;
  /** Next refund answers this Stripe error instead. */
  failNext: string | null;
}

const stripe: FakeStripe = { refunded: 0, requests: [], failNext: null };
const CHARGE_AMOUNT = 12_200;
const seenKeys = new Map<string, unknown>();

async function fakeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const path = new URL(url).pathname;
  const method = init.method ?? 'GET';
  const body = new URLSearchParams(typeof init.body === 'string' ? init.body : '');
  const idempotencyKey = new Headers(init.headers).get('idempotency-key');
  stripe.requests.push({ method, path, body, idempotencyKey });
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  if (method === 'GET' && path === '/v1/balance') return json({ object: 'balance' });
  if (method === 'POST' && path === '/v1/refunds') {
    if (stripe.failNext !== null) {
      const message = stripe.failNext;
      stripe.failNext = null;
      return json({ error: { type: 'invalid_request_error', message } }, 400);
    }
    if (idempotencyKey !== null && seenKeys.has(idempotencyKey)) return json(seenKeys.get(idempotencyKey));
    const amount = Number(body.get('amount'));
    stripe.refunded += amount;
    const refund = { id: `re_${String(stripe.requests.length)}`, status: 'succeeded', amount, charge: 'ch_1', payment_intent: 'pi_1' };
    if (idempotencyKey !== null) seenKeys.set(idempotencyKey, refund);
    return json(refund);
  }
  if (method === 'GET' && path === '/v1/charges/ch_1') {
    return json({ id: 'ch_1', amount: CHARGE_AMOUNT, amount_refunded: stripe.refunded });
  }
  return json({ error: { type: 'invalid_request_error', message: `unexpected ${method} ${path}` } }, 400);
}

let h: Harness;
let owner: TestClient;
let orderId = '';

beforeAll(async () => {
  h = await createHarness();
  h.env.TENANT_DB = fakeTenantDbNamespace();
  overrideCommerceRuntime((base) => ({ ...base, fetch: fakeFetch }));
  const shop = await seedTenant(h, 'shop');
  const user = await seedUser(h, { email: 'owner@shop.test' });
  await addMember(h, user.id, shop.id, 'owner');
  owner = await login(h, user.email);
  await stepUp(h, owner);
  const connect = await owner.request('PUT', `${BASE}/commerce/stripe`, {
    publishable_key: 'pk_test_0123456789abcdef',
    secret_key: 'sk_test_0123456789abcdef',
  });
  expect(connect.status).toBe(200);

  const contact = await owner.post(`${BASE}/contacts`, { given_name: 'Buyer' });
  const product = await owner.post(`${BASE}/products`, {
    name: 'Course',
    sku: 'C-1',
    price_minor: 10_000,
    currency: 'EUR',
    tax_rate_bps: 2200,
  });
  const order = await owner.post(`${BASE}/orders`, {
    contact_id: contact.body['id'],
    items: [{ product_id: product.body['id'] }],
  });
  expect(order.body['total_minor']).toBe(CHARGE_AMOUNT);
  orderId = String(order.body['id']);
  await owner.post(`${BASE}/orders/${orderId}/finalize`);
  const paid = await owner.post(`${BASE}/orders/${orderId}/payments`, {
    amount_minor: CHARGE_AMOUNT,
    method: 'card',
    transaction_id: 'pi_1',
  });
  expect(paid.status).toBe(201);
});

afterAll(() => overrideCommerceRuntime(null));

describe('POST /orders/{id}/refunds with stripe: true', () => {
  it('refunds part of the payment on Stripe and records it on the order', async () => {
    const res = await owner.post(`${BASE}/orders/${orderId}/refunds`, { amount_minor: 2_000, reason: 'Damaged', stripe: true });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ amount_minor: 2_000, reason: 'Damaged' });
    const call = stripe.requests.find((r) => r.path === '/v1/refunds');
    expect(call?.body.get('payment_intent')).toBe('pi_1');
    expect(call?.body.get('amount')).toBe('2000');
    expect(call?.idempotencyKey).toMatch(/^refund:/);
    const order = await owner.get(`${BASE}/orders/${orderId}`);
    expect(order.body).toMatchObject({ status: 'paid', refunded_minor: 2_000 });
  });

  it('records nothing when Stripe refuses the refund', async () => {
    stripe.failNext = 'Charge already disputed';
    const res = await owner.post(`${BASE}/orders/${orderId}/refunds`, { amount_minor: 1_000, stripe: true });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('Charge already disputed');
    const order = await owner.get(`${BASE}/orders/${orderId}`);
    expect(order.body['refunded_minor']).toBe(2_000);
  });

  it('refunds the rest when no amount is given, and stops there', async () => {
    const res = await owner.post(`${BASE}/orders/${orderId}/refunds`, { stripe: true });
    expect(res.status).toBe(201);
    expect(res.body['amount_minor']).toBe(CHARGE_AMOUNT - 2_000);
    expect(stripe.refunded).toBe(CHARGE_AMOUNT);
    const order = await owner.get(`${BASE}/orders/${orderId}`);
    expect(order.body).toMatchObject({ status: 'refunded', refunded_minor: CHARGE_AMOUNT });
    const again = await owner.post(`${BASE}/orders/${orderId}/refunds`, { stripe: true });
    expect(again.status).toBe(409);
  });
});
