import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { STRIPE_WEBHOOK_EVENTS } from '../../src/commerce/stripe/client';
import { overrideCommerceRuntime } from '../../src/commerce/stripe/runtime';
import { fakeTenantDbNamespace } from '../crm/helpers';
import { addMember, createHarness, login, seedTenant, seedUser, stepUp, type Harness, type TestClient } from '../helpers/harness';

const BASE = '/api/v2/t/shop';
const EDGE = 'https://edge.example.com';
const WEBHOOK_URL = `${EDGE}/c/shop/stripe/webhook`;

const KEYS = {
  a: 'sk_test_accountA0000000000',
  b: 'sk_test_accountB0000000000',
  restricted: 'rk_test_noWebhooks000000',
};

interface Endpoint {
  id: string;
  url: string;
  events: string[];
  apiVersion: string | null;
}

/** One fake Stripe account per secret key. */
const accounts = new Map<string, { id: string; endpoints: Endpoint[] }>([
  [KEYS.a, { id: 'acct_A', endpoints: [] }],
  [KEYS.b, { id: 'acct_B', endpoints: [] }],
  [KEYS.restricted, { id: 'acct_A', endpoints: [] }],
]);
let created = 0;

async function fakeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const path = new URL(url).pathname;
  const method = init.method ?? 'GET';
  const body = new URLSearchParams(typeof init.body === 'string' ? init.body : '');
  const key = (new Headers(init.headers).get('authorization') ?? '').replace('Bearer ', '');
  const account = accounts.get(key);
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  if (account === undefined) return json({ error: { type: 'authentication_error', message: 'Invalid API Key' } }, 401);
  if (method === 'GET' && path === '/v1/balance') return json({ object: 'balance' });
  if (method === 'GET' && path === '/v1/account') return json({ id: account.id });
  if (path.startsWith('/v1/webhook_endpoints') && key === KEYS.restricted) {
    return json({ error: { type: 'invalid_request_error', message: 'The provided key does not have the required permissions' } }, 403);
  }
  if (method === 'GET' && path === '/v1/webhook_endpoints') {
    return json({ data: account.endpoints.map((e) => ({ id: e.id, object: 'webhook_endpoint', url: e.url })) });
  }
  if (method === 'POST' && path === '/v1/webhook_endpoints') {
    created += 1;
    const endpoint: Endpoint = {
      id: `we_${String(created)}`,
      url: body.get('url') ?? '',
      events: [...body.entries()].filter(([k]) => k.startsWith('enabled_events[')).map(([, v]) => v),
      apiVersion: body.get('api_version'),
    };
    account.endpoints.push(endpoint);
    return json({ id: endpoint.id, object: 'webhook_endpoint', url: endpoint.url, secret: `whsec_secret${String(created)}` });
  }
  const del = /^\/v1\/webhook_endpoints\/(.+)$/.exec(path);
  if (method === 'DELETE' && del !== null) {
    const index = account.endpoints.findIndex((e) => e.id === del[1]);
    if (index === -1) return json({ error: { type: 'invalid_request_error', message: 'No such webhook endpoint' } }, 404);
    account.endpoints.splice(index, 1);
    return json({ id: del[1], deleted: true });
  }
  return json({ error: { type: 'invalid_request_error', message: `unexpected ${method} ${path}` } }, 400);
}

let h: Harness;
let owner: TestClient;

beforeAll(async () => {
  h = await createHarness();
  h.env.TENANT_DB = fakeTenantDbNamespace();
  h.env.EDGE_ORIGIN = EDGE;
  overrideCommerceRuntime((base) => ({ ...base, fetch: fakeFetch }));
  const shop = await seedTenant(h, 'shop');
  const user = await seedUser(h, { email: 'owner@shop.test' });
  await addMember(h, user.id, shop.id, 'owner');
  owner = await login(h, user.email);
});

beforeEach(async () => {
  await stepUp(h, owner);
});

afterAll(() => overrideCommerceRuntime(null));

const endpointsOf = (key: string) => accounts.get(key)?.endpoints ?? [];

describe('Stripe webhook set up from the secret key', () => {
  it('creates the endpoint with the handled events and stores its signing secret', async () => {
    endpointsOf(KEYS.a).push({ id: 'we_manual', url: WEBHOOK_URL, events: ['*'], apiVersion: null });
    endpointsOf(KEYS.a).push({ id: 'we_other', url: 'https://other.example.com/hook', events: ['*'], apiVersion: null });
    const res = await owner.request('PUT', `${BASE}/commerce/stripe`, {
      publishable_key: 'pk_test_0123456789abcdef',
      secret_key: KEYS.a,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      webhook_managed: true,
      webhook_secret_hint: '…ret1',
      webhook_setup_error: null,
      webhook_url: WEBHOOK_URL,
    });
    const endpoints = endpointsOf(KEYS.a);
    expect(endpoints.map((e) => e.id)).toEqual(['we_other', 'we_1']);
    expect(endpoints[1]?.url).toBe(WEBHOOK_URL);
    expect(endpoints[1]?.events).toEqual([...STRIPE_WEBHOOK_EVENTS]);
    expect(endpoints[1]?.apiVersion).toBe('2024-06-20');
  });

  it('keeps the endpoint when only the publishable key is saved again', async () => {
    const res = await owner.request('PUT', `${BASE}/commerce/stripe`, { publishable_key: 'pk_test_0123456789abcdef' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ webhook_managed: true, webhook_secret_hint: '…ret1' });
    expect(endpointsOf(KEYS.a).map((e) => e.id)).toEqual(['we_other', 'we_1']);
  });

  it('moves the endpoint to the new account and removes it from the old one', async () => {
    const res = await owner.request('PUT', `${BASE}/commerce/stripe`, {
      publishable_key: 'pk_test_0123456789abcdef',
      secret_key: KEYS.b,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ account_changed: true, webhook_managed: true, webhook_secret_hint: '…ret2' });
    expect(endpointsOf(KEYS.a).map((e) => e.id)).toEqual(['we_other']);
    expect(endpointsOf(KEYS.b).map((e) => e.id)).toEqual(['we_2']);
  });

  it('falls back to the manual secret when the key may not manage webhooks', async () => {
    const res = await owner.request('PUT', `${BASE}/commerce/stripe`, {
      publishable_key: 'pk_test_0123456789abcdef',
      secret_key: KEYS.restricted,
    });
    expect(res.status).toBe(200);
    expect(res.body['webhook_managed']).toBe(false);
    expect(res.body['webhook_secret_hint']).toBeNull();
    expect(String(res.body['webhook_setup_error'])).toContain('permissions');

    await stepUp(h, owner);
    const manual = await owner.request('PUT', `${BASE}/commerce/stripe`, {
      publishable_key: 'pk_test_0123456789abcdef',
      webhook_secret: 'whsec_byhand1234',
    });
    expect(manual.status).toBe(200);
    expect(manual.body).toMatchObject({ webhook_managed: false, webhook_secret_hint: '…1234' });
  });

  it('deletes the managed endpoint when Stripe is disconnected', async () => {
    await owner.request('PUT', `${BASE}/commerce/stripe`, {
      publishable_key: 'pk_test_0123456789abcdef',
      secret_key: KEYS.b,
    });
    expect(endpointsOf(KEYS.b)).toHaveLength(1);
    await stepUp(h, owner);
    const res = await owner.request('DELETE', `${BASE}/commerce/stripe`);
    expect(res.status).toBe(200);
    expect(res.body['configured']).toBe(false);
    expect(endpointsOf(KEYS.b)).toHaveLength(0);
  });

  it('does not create an endpoint Stripe cannot reach', async () => {
    h.env.EDGE_ORIGIN = 'http://localhost:8788';
    try {
      const res = await owner.request('PUT', `${BASE}/commerce/stripe`, {
        publishable_key: 'pk_test_0123456789abcdef',
        secret_key: KEYS.b,
      });
      expect(res.status).toBe(200);
      expect(res.body['webhook_managed']).toBe(false);
      expect(String(res.body['webhook_setup_error'])).toContain('localhost');
      expect(endpointsOf(KEYS.b)).toHaveLength(0);
    } finally {
      h.env.EDGE_ORIGIN = EDGE;
    }
  });
});
