import type { CreatePlanInput } from '@amable/api-types';
import { createCrmContext, SYSTEM_ACTOR, type CrmContext, type SearchMode } from '../crm/context';
import type { SqlDb } from '../crm/db/sql';
import { CrmError } from '../crm/errors';
import { createCategory, createProduct } from './catalog';
import { cancelOrder, createOrderRow } from './orders';
import { recordPayment, recordRefund } from './payments';
import { createPromoCode } from './promo';
import type { OrderRow } from './rows';
import {
  cancelSubscription,
  changeSubscriptionPlan,
  createSubscription,
  pauseSubscription,
  resumeSubscription,
  runBilling,
} from './subscriptions';

export interface CommerceSeedSummary {
  seeded: boolean;
  products: number;
  plans: number;
  promoCodes: number;
  orders: number;
  payments: number;
  refunds: number;
  subscriptions: number;
  invoices: number;
}

const DAY = 86_400_000;
const EUR = (major: number): number => Math.round(major * 100);
const monthly = (name: string, price: number, trial = 0): CreatePlanInput => ({
  name,
  interval: 'month',
  price_minor: EUR(price),
  trial_days: trial,
});
const yearly = (name: string, price: number, trial = 0): CreatePlanInput => ({
  name,
  interval: 'year',
  price_minor: EUR(price),
  trial_days: trial,
});

const CATALOG: Array<{
  category: string;
  products: Array<{ name: string; sku: string; price: number; plans?: CreatePlanInput[] }>;
}> = [
  {
    category: 'Software',
    products: [
      {
        name: 'CRM Starter',
        sku: 'SW-STARTER',
        price: 29,
        plans: [monthly('Monthly', 29, 14), yearly('Yearly', 290, 14)],
      },
      {
        name: 'CRM Pro',
        sku: 'SW-PRO',
        price: 79,
        plans: [monthly('Monthly', 79, 14), yearly('Yearly', 790)],
      },
      { name: 'CRM Team', sku: 'SW-TEAM', price: 199, plans: [monthly('Monthly', 199)] },
      { name: 'Email Add-on', sku: 'SW-EMAIL', price: 15, plans: [monthly('Monthly', 15)] },
      {
        name: 'Analytics Add-on',
        sku: 'SW-ANALYTICS',
        price: 19,
        plans: [monthly('Monthly', 19), yearly('Yearly', 190)],
      },
    ],
  },
  {
    category: 'Courses',
    products: [
      { name: 'Email Marketing Masterclass', sku: 'CO-EMAIL', price: 197 },
      { name: 'Sales Pipeline Bootcamp', sku: 'CO-SALES', price: 297 },
      { name: 'Copywriting Fundamentals', sku: 'CO-COPY', price: 97 },
      { name: 'Automation Workshop', sku: 'CO-AUTO', price: 149 },
      { name: 'Analytics 101', sku: 'CO-ANALYTICS', price: 79 },
    ],
  },
  {
    category: 'Services',
    products: [
      { name: 'Onboarding Session', sku: 'SV-ONBOARD', price: 250 },
      { name: 'Strategy Consulting (1h)', sku: 'SV-CONSULT', price: 150 },
      { name: 'Custom Integration', sku: 'SV-INTEGRATION', price: 1500 },
      { name: 'Data Migration', sku: 'SV-MIGRATION', price: 800 },
      {
        name: 'Coaching Program',
        sku: 'SV-COACHING',
        price: 300,
        plans: [monthly('Monthly', 300)],
      },
    ],
  },
  {
    category: 'Merchandise',
    products: [
      { name: 'T-shirt', sku: 'MD-TSHIRT', price: 25 },
      { name: 'Hoodie', sku: 'MD-HOODIE', price: 55 },
      { name: 'Mug', sku: 'MD-MUG', price: 12 },
      { name: 'Sticker Pack', sku: 'MD-STICKERS', price: 6 },
      { name: 'Notebook', sku: 'MD-NOTEBOOK', price: 15 },
    ],
  },
];

const METHODS = ['card', 'card', 'card', 'bank_transfer', 'paypal', 'cash'] as const;

/** Deterministic PRNG (mulberry32), same as the CRM seed. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fills the tenant with a year of e-commerce history (idempotent, needs the CRM
 * seed's contacts): 20 products in 4 categories with plans, 3 promo codes,
 * ~150 one-off orders with payments, partial payments, cancellations and
 * refunds, and ~30 subscriptions billed day by day by the real billing job.
 */
export function seedCommerce(
  db: SqlDb,
  searchMode: SearchMode,
  realNow = Date.now(),
): CommerceSeedSummary {
  const empty: CommerceSeedSummary = {
    seeded: false,
    products: 0,
    plans: 0,
    promoCodes: 0,
    orders: 0,
    payments: 0,
    refunds: 0,
    subscriptions: 0,
    invoices: 0,
  };
  if (db.all(`SELECT 1 FROM tenant_meta WHERE key = 'commerce_seeded_at'`).length > 0) return empty;
  const contacts = db
    .all<{ id: string }>(`SELECT id FROM crm_contacts WHERE deleted_at IS NULL ORDER BY id`)
    .map((r) => r.id);
  if (contacts.length === 0) return empty;
  const clock = { now: realNow - 366 * DAY };
  const ctx = createCrmContext(db, SYSTEM_ACTOR, searchMode, { now: () => clock.now });
  return db.transaction(() => {
    seedInto(ctx, clock, contacts, realNow);
    db.run(
      `INSERT INTO tenant_meta (key, value) VALUES ('commerce_seeded_at', ?)`,
      String(realNow),
    );
    const count = (table: string): number =>
      db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)[0]?.n ?? 0;
    return {
      seeded: true,
      products: count('crm_products'),
      plans: count('crm_subscription_plans'),
      promoCodes: count('crm_promo_codes'),
      orders: count('crm_orders'),
      payments: count('crm_payments'),
      refunds: count('crm_refunds'),
      subscriptions: count('crm_subscriptions'),
      invoices: count('crm_invoices'),
    };
  });
}

function seedInto(
  ctx: CrmContext,
  clock: { now: number },
  contacts: string[],
  realNow: number,
): void {
  const random = rng(20261015);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
  const chance = (p: number): boolean => random() < p;
  const start = clock.now;

  // ---- catalog
  const oneOff: Array<{ id: string; price: number; merch: boolean }> = [];
  const plans: Array<{ id: string; productId: string; interval: string }> = [];
  for (const group of CATALOG) {
    const category = createCategory(ctx, { name: group.category });
    for (const p of group.products) {
      const product = createProduct(ctx, {
        name: p.name,
        sku: p.sku,
        category_id: category.id,
        price_minor: EUR(p.price),
        currency: 'EUR',
        tax_rate_bps: 2200,
        ...(p.plans === undefined ? {} : { plans: p.plans }),
      });
      if (product.plans.length === 0) {
        oneOff.push({
          id: product.id,
          price: product.price_minor,
          merch: group.category === 'Merchandise',
        });
      }
      for (const plan of product.plans)
        plans.push({ id: plan.id, productId: product.id, interval: plan.interval });
    }
  }
  createPromoCode(ctx, {
    code: 'WELCOME10',
    kind: 'percent',
    percent_bps: 1000,
    max_per_contact: 1,
  });
  createPromoCode(ctx, {
    code: 'SPRING25',
    kind: 'percent',
    percent_bps: 2500,
    max_redemptions: 40,
    starts_at: new Date(start + 150 * DAY).toISOString(),
    ends_at: new Date(start + 200 * DAY).toISOString(),
  });
  createPromoCode(ctx, {
    code: 'FLAT20',
    kind: 'fixed',
    amount_minor: EUR(20),
    currency: 'EUR',
    min_subtotal_minor: EUR(100),
  });

  // ---- schedule: one-off orders and subscription starts spread over 365 days
  const orderDays = Array.from({ length: 150 }, () => Math.floor(random() * 364) + 1).sort(
    (a, b) => a - b,
  );
  const subDays = Array.from({ length: 30 }, () => Math.floor(random() * 340) + 1).sort(
    (a, b) => a - b,
  );
  const subContacts = [...contacts].sort(() => random() - 0.5).slice(0, 30);
  const subscriptionIds: string[] = [];
  const paidOrders: OrderRow[] = [];

  const pay = (
    order: OrderRow,
    amount: number,
    at: number,
    method: string = pick(METHODS),
  ): void => {
    clock.now = at;
    recordPayment(ctx, {
      orderId: order.id,
      data: {
        amount_minor: amount,
        method: method as (typeof METHODS)[number],
        transaction_id: `seed_${order.number}_${order.paid_minor}`,
      },
    });
  };

  for (let day = 1; day <= 365; day += 1) {
    const dayStart = start + day * DAY;

    // one-off orders of the day
    const ordersToday = orderDays.filter((x) => x === day).length;
    for (let n = 0; n < ordersToday; n += 1) {
      clock.now = dayStart + Math.floor(random() * 10 * 3_600_000) + 8 * 3_600_000;
      const lineCount = 1 + Math.floor(random() * 3);
      const items = Array.from({ length: lineCount }, () => {
        const product = pick(oneOff);
        return {
          product_id: product.id,
          quantity: product.merch ? 1 + Math.floor(random() * 3) : 1,
        };
      });
      const merch = items.some((i) => oneOff.find((p) => p.id === i.product_id)?.merch === true);
      const codes = ['WELCOME10', 'SPRING25', 'FLAT20'];
      let order: OrderRow;
      const base = {
        contact_id: pick(contacts),
        items,
        shipping_minor: merch ? EUR(6.9) : 0,
        ...(chance(0.4)
          ? { analytics_visitor_id: `v_${Math.floor(random() * 1e12).toString(36)}` }
          : {}),
      };
      try {
        order = createOrderRow(ctx, chance(0.18) ? { ...base, promo_code: pick(codes) } : base);
      } catch (error) {
        if (!(error instanceof CrmError)) throw error;
        order = createOrderRow(ctx, base);
      }
      const roll = random();
      const paidAt = Math.min(clock.now + Math.floor(random() * 4 * DAY), realNow);
      if (roll < 0.05) {
        clock.now += DAY;
        cancelOrder(ctx, { id: order.id, data: { reason: 'Customer changed their mind' } });
      } else if (roll < 0.12) {
        // left unpaid
      } else if (roll < 0.2) {
        pay(order, Math.floor(order.total_minor / 2), paidAt, 'bank_transfer');
      } else {
        pay(order, order.total_minor, paidAt);
        paidOrders.push(order);
      }
    }

    // subscriptions starting today
    subDays.forEach((d, i) => {
      if (d !== day) return;
      clock.now = dayStart + 9 * 3_600_000;
      const plan = pick(plans);
      const sub = createSubscription(ctx, {
        contact_id: subContacts[i] ?? pick(contacts),
        plan_id: plan.id,
        start_at: new Date(clock.now).toISOString(),
        ...(chance(0.3)
          ? { analytics_visitor_id: `v_${Math.floor(random() * 1e12).toString(36)}` }
          : {}),
      });
      subscriptionIds.push(sub.id);
    });

    // billing job of the day, then the day's subscription payments (no gateway: recorded like an API would)
    clock.now = dayStart + 6 * 3_600_000;
    runBilling(ctx, {});
    const due = ctx.db.all<OrderRow>(
      `SELECT * FROM crm_orders WHERE subscription_id IS NOT NULL AND status = 'unpaid' AND deleted_at IS NULL
         AND order_date <= ? AND id NOT IN (SELECT order_id FROM crm_payments)`,
      dayStart + DAY,
    );
    for (const order of due) {
      const at = Math.min(Math.max(order.order_date, clock.now) + 3_600_000, realNow);
      if (chance(0.06)) {
        clock.now = at;
        recordPayment(ctx, {
          orderId: order.id,
          data: {
            amount_minor: order.total_minor,
            method: 'card',
            status: 'failed',
            failure_reason: 'card_declined',
            transaction_id: `seed_fail_${order.number}`,
          },
        });
        if (chance(0.6)) pay(order, order.total_minor, Math.min(at + 2 * DAY, realNow), 'card');
      } else if (!chance(0.03)) {
        pay(order, order.total_minor, at, 'card');
      }
    }

    // lifecycle changes on a few subscriptions
    const lifecycle = (index: number, action: (id: string) => void): void => {
      const id = subscriptionIds[index];
      if (id !== undefined && day === subDays[index]! + 60) {
        clock.now = dayStart + 12 * 3_600_000;
        try {
          action(id);
        } catch (error) {
          if (!(error instanceof CrmError)) throw error;
        }
      }
    };
    for (const index of [0, 4, 9, 15, 21]) {
      lifecycle(index, (id) => cancelSubscription(ctx, { id, data: { reason: 'Too expensive' } }));
    }
    lifecycle(2, (id) => cancelSubscription(ctx, { id, data: { at_period_end: false } }));
    lifecycle(6, (id) => pauseSubscription(ctx, { id }));
    lifecycle(11, (id) => {
      cancelSubscription(ctx, { id, data: {} });
      resumeSubscription(ctx, { id });
    });
    for (const index of [3, 7, 12]) {
      lifecycle(index, (id) => {
        const current = ctx.db.all<{ product_id: string; plan_id: string }>(
          `SELECT product_id, plan_id FROM crm_subscriptions WHERE id = ?`,
          id,
        )[0];
        const other = plans.find(
          (p) => p.productId === current?.product_id && p.id !== current.plan_id,
        );
        if (other !== undefined) changeSubscriptionPlan(ctx, { id, data: { plan_id: other.id } });
      });
    }
  }

  // ---- refunds on ~6% of paid one-off orders (half full, half partial)
  paidOrders
    .filter(() => chance(0.06))
    .forEach((order, i) => {
      clock.now = Math.min(order.order_date + 10 * DAY, realNow);
      recordRefund(ctx, {
        orderId: order.id,
        data:
          i % 2 === 0
            ? { reason: 'Requested by customer', transaction_id: `seed_refund_${order.number}` }
            : {
                amount_minor: Math.max(1, Math.floor(order.total_minor / 3)),
                reason: 'Partial refund: damaged item',
                transaction_id: `seed_refund_${order.number}`,
              },
      });
    });
  clock.now = realNow;
}
