import { describe, expect, it } from 'vitest';
import { seedCommerce } from '../../src/commerce/seed';
import { seedCrm } from '../../src/crm/seed';
import { createTestTenant } from '../crm/helpers';

describe('commerce dev seed', () => {
  it('creates a consistent year of orders, payments, refunds and subscriptions (idempotent)', () => {
    const t = createTestTenant();
    expect(seedCommerce(t.db, t.mode).seeded).toBe(false); // needs CRM contacts first
    seedCrm(t.db, t.mode);
    const realNow = Date.UTC(2026, 9, 15, 12);
    const summary = seedCommerce(t.db, t.mode, realNow);
    expect(summary).toMatchObject({ seeded: true, products: 20, promoCodes: 3, subscriptions: 30 });
    expect(summary.plans).toBeGreaterThanOrEqual(8);
    expect(summary.orders).toBeGreaterThanOrEqual(150);
    expect(summary.refunds).toBeGreaterThan(0);
    expect(seedCommerce(t.db, t.mode, realNow).seeded).toBe(false);

    // Money invariants hold for every order.
    const broken = t.db.all(
      `SELECT o.id FROM crm_orders o WHERE
         o.paid_minor <> (SELECT IFNULL(SUM(amount_minor), 0) FROM crm_payments p WHERE p.order_id = o.id AND p.status = 'succeeded')
         OR o.refunded_minor <> (SELECT IFNULL(SUM(amount_minor), 0) FROM crm_refunds r WHERE r.order_id = o.id)
         OR o.total_minor <> o.subtotal_minor - o.discount_minor + o.tax_minor + o.shipping_minor
         OR o.paid_minor > o.total_minor`,
    );
    expect(broken).toEqual([]);
    const statuses = t.db
      .all<{ status: string }>(`SELECT DISTINCT status FROM crm_orders ORDER BY status`)
      .map((r) => r.status);
    expect(statuses).toEqual(
      expect.arrayContaining(['cancelled', 'paid', 'partially_paid', 'refunded', 'unpaid']),
    );
    const subStatuses = t.db
      .all<{ status: string }>(`SELECT DISTINCT status FROM crm_subscriptions`)
      .map((r) => r.status);
    expect(subStatuses).toEqual(expect.arrayContaining(['active', 'cancelled']));
    // Every finalized order has exactly one invoice; history spans the last year.
    expect(
      t.db.all(
        `SELECT 1 FROM crm_orders o WHERE NOT EXISTS (SELECT 1 FROM crm_invoices i WHERE i.order_id = o.id)`,
      ),
    ).toEqual([]);
    const span = t.db.all<{ first: number; last: number }>(
      `SELECT MIN(order_date) AS first, MAX(order_date) AS last FROM crm_orders`,
    )[0];
    expect((span?.last ?? 0) - (span?.first ?? 0)).toBeGreaterThan(300 * 86_400_000);
    expect((span?.last ?? 0) <= realNow).toBe(true);
    const renewals = t.db.all(`SELECT 1 FROM crm_outbox WHERE type = 'subscription.renewed'`);
    expect(renewals.length).toBeGreaterThan(50);
  });
});
