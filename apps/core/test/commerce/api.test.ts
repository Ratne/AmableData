import { ROLES, type Role } from '@amable/core';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  createHarness,
  login,
  seedTenant,
  seedUser,
  type Harness,
  type TestClient,
} from '../helpers/harness';
import { fakeTenantDbNamespace } from '../crm/helpers';

const BASE = '/api/v2/t/shop';

let h: Harness;
const clients = {} as Record<Role, TestClient>;
let contactId = '';
let productId = '';
let planId = '';

beforeAll(async () => {
  h = await createHarness();
  h.env.TENANT_DB = fakeTenantDbNamespace();
  const shop = await seedTenant(h, 'shop');
  for (const role of ROLES) {
    const user = await seedUser(h, { email: `${role}@shop.test` });
    await addMember(h, user.id, shop.id, role);
    clients[role] = await login(h, user.email);
  }
  const owner = clients.owner;
  contactId = String((await owner.post(`${BASE}/contacts`, { given_name: 'Buyer' })).body['id']);
  const product = await owner.post(`${BASE}/products`, {
    name: 'Course',
    sku: 'C-1',
    price_minor: 10_000,
    currency: 'EUR',
    tax_rate_bps: 2200,
    plans: [{ name: 'Monthly', interval: 'month', price_minor: 2_900 }],
  });
  expect(product.status).toBe(201);
  productId = String(product.body['id']);
  planId = String((product.body['plans'] as Array<{ id: string }>)[0]?.id);
});

describe('e-commerce REST v2 permissions by role', () => {
  it('lets every role read the catalog, orders, subscriptions and invoices', async () => {
    for (const role of ROLES) {
      for (const path of [
        '/products',
        '/orders',
        '/subscriptions',
        '/invoices',
        '/payments',
        '/promoCodes',
      ]) {
        const res = await clients[role].get(`${BASE}${path}`);
        expect([role, path, res.status]).toEqual([role, path, 200]);
      }
    }
  });

  it('allows catalog writes to owner and admin only', async () => {
    const expected: Record<Role, number> = {
      owner: 201,
      admin: 201,
      marketer: 403,
      sales: 403,
      analyst: 403,
      viewer: 403,
    };
    for (const role of ROLES) {
      const res = await clients[role].post(`${BASE}/products`, {
        name: `Product by ${role}`,
        price_minor: 100,
      });
      expect([role, res.status]).toEqual([role, expected[role]]);
    }
  });

  it('lets sales create manual orders and payments, but not refunds or subscriptions', async () => {
    const sales = clients.sales;
    const order = await sales.post(`${BASE}/orders`, {
      contact_id: contactId,
      items: [{ product_id: productId }],
    });
    expect(order.status).toBe(201);
    expect(order.body).toMatchObject({ source: 'manual', total_minor: 12_200, status: 'unpaid' });
    const orderId = String(order.body['id']);
    const payment = await sales.post(`${BASE}/orders/${orderId}/payments`, {
      amount_minor: 12_200,
      method: 'bank_transfer',
      transaction_id: 'wire-42',
    });
    expect(payment.status).toBe(201);
    expect((await sales.get(`${BASE}/orders/${orderId}`)).body['status']).toBe('paid');
    expect((await sales.post(`${BASE}/orders/${orderId}/refunds`, {})).status).toBe(403);
    expect(
      (await sales.post(`${BASE}/subscriptions`, { contact_id: contactId, plan_id: planId }))
        .status,
    ).toBe(403);

    for (const role of ['marketer', 'analyst', 'viewer'] as const) {
      const denied = await clients[role].post(`${BASE}/orders`, {
        contact_id: contactId,
        items: [{ product_id: productId }],
      });
      expect([role, denied.status]).toEqual([role, 403]);
      expect(
        (
          await clients[role].post(`${BASE}/orders/${orderId}/payments`, {
            amount_minor: 1,
            method: 'cash',
          })
        ).status,
      ).toBe(403);
    }

    const refund = await clients.admin.post(`${BASE}/orders/${orderId}/refunds`, {
      amount_minor: 2_200,
    });
    expect(refund.status).toBe(201);
    const refunds = await clients.viewer.get(`${BASE}/orders/${orderId}/refunds`);
    expect(refunds.body['data']).toHaveLength(1);
  });

  it('runs subscriptions end to end for owners, with errors in the standard format', async () => {
    const owner = clients.owner;
    const sub = await owner.post(`${BASE}/subscriptions`, {
      contact_id: contactId,
      plan_id: planId,
    });
    expect(sub.status).toBe(201);
    const id = String(sub.body['id']);
    expect((await owner.post(`${BASE}/subscriptions/${id}/pause`, {})).body['status']).toBe(
      'paused',
    );
    expect((await owner.post(`${BASE}/subscriptions/${id}/resume`, {})).body['status']).toBe(
      'active',
    );
    const cancel = await owner.post(`${BASE}/subscriptions/${id}/cancel`, { at_period_end: true });
    expect(cancel.body['cancel_at_period_end']).toBe(true);
    expect((await clients.marketer.post(`${BASE}/subscriptions/${id}/resume`, {})).status).toBe(
      403,
    );
    const run = await owner.post(`${BASE}/billing/run`, {});
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ processed: 0 });

    const bad = await owner.post(`${BASE}/orders`, {
      contact_id: contactId,
      items: [{ product_id: productId }],
      promo_code: 'NOPE',
    });
    expect(bad.status).toBe(422);
    expect(bad.body).toMatchObject({
      error: 'validation_failed',
      details: [{ path: 'promo_code' }],
    });
    const empty = await owner.post(`${BASE}/orders`, { contact_id: contactId, items: [] });
    expect(empty.status).toBe(422);
    const missing = await owner.get(`${BASE}/orders/01MISSING`);
    expect(missing.status).toBe(404);
  });

  it('replays order creation with the same Idempotency-Key', async () => {
    const headers = { 'idempotency-key': 'order-once' };
    const body = { contact_id: contactId, items: [{ product_id: productId }] };
    const first = await clients.owner.post(`${BASE}/orders`, body, headers);
    const second = await clients.owner.post(`${BASE}/orders`, body, headers);
    expect(second.body['id']).toBe(first.body['id']);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
  });

  it('publishes the e-commerce operations in the OpenAPI document', async () => {
    const res = await h.client().get('/api/v2/openapi.json');
    const paths = res.body['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    expect(Object.keys(paths)).toEqual(
      expect.arrayContaining([
        '/products',
        '/productCategories',
        '/plans',
        '/products/{id}/plans',
        '/promoCodes',
        '/orders',
        '/orders/{id}/items',
        '/orders/{id}/payments',
        '/orders/{id}/refunds',
        '/subscriptions/{id}/changePlan',
        '/invoices',
        '/billing/run',
      ]),
    );
    expect(paths['/orders/{id}/refunds']?.['post']?.['x-amable-permission']).toBe('orders:refund');
    expect(paths['/orders']?.['post']?.['x-amable-permission']).toBe('orders:write');
  });
});
