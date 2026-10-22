import type { Order, Subscription } from '@amable/api-types';
import type { CrmContext } from '../crm/context';
import { notFound } from '../crm/errors';

/** Raw `crm_orders` row. */
export interface OrderRow {
  id: string;
  number: string;
  contact_id: string;
  company_id: string | null;
  owner_id: string | null;
  status: Order['status'];
  source: Order['source'];
  currency: string;
  subtotal_minor: number;
  discount_minor: number;
  tax_minor: number;
  shipping_minor: number;
  total_minor: number;
  paid_minor: number;
  refunded_minor: number;
  promo_code_id: string | null;
  promo_code: string | null;
  notes: string | null;
  subscription_id: string | null;
  billing_period_start: number | null;
  billing_period_end: number | null;
  analytics_visitor_id: string | null;
  order_date: number;
  due_at: number | null;
  checkout_id: string | null;
  checkout_session_id: string | null;
  parent_order_id: string | null;
  attribution: string | null;
  auto_charge_attempts: number;
  next_charge_at: number | null;
  finalized_at: number | null;
  paid_at: number | null;
  cancelled_at: number | null;
  created_at: number;
  updated_at: number;
}

/** Raw `crm_order_items` row. */
export interface OrderItemRow {
  id: string;
  order_id: string;
  product_id: string | null;
  plan_id: string | null;
  name: string;
  sku: string | null;
  description: string | null;
  quantity: number;
  unit_price_minor: number;
  subtotal_minor: number;
  discount_minor: number;
  tax_rate_bps: number;
  tax_minor: number;
  total_minor: number;
  position: number;
}

/** Raw `crm_subscriptions` row. */
export interface SubscriptionRow {
  id: string;
  contact_id: string;
  product_id: string;
  plan_id: string;
  status: Subscription['status'];
  quantity: number;
  unit_price_minor: number;
  currency: string;
  interval: Subscription['interval'];
  interval_count: number;
  tax_rate_bps: number;
  started_at: number;
  trial_ends_at: number | null;
  trial_converted_at: number | null;
  current_period_start: number | null;
  current_period_end: number | null;
  next_bill_at: number | null;
  billing_anchor: number;
  periods_billed: number;
  cancel_at_period_end: number;
  cancel_reason: string | null;
  cancelled_at: number | null;
  paused_at: number | null;
  ended_at: number | null;
  analytics_visitor_id: string | null;
  promo_code_id: string | null;
  promo_code: string | null;
  discount_kind: 'percent' | 'fixed' | null;
  discount_percent_bps: number | null;
  discount_amount_minor: number | null;
  discount_periods_left: number | null;
  stripe_customer_id: string | null;
  stripe_payment_method_id: string | null;
  created_at: number;
  updated_at: number;
}

export function getOrderRow(ctx: CrmContext, id: string): OrderRow {
  const row = ctx.db.all<OrderRow>(
    `SELECT * FROM crm_orders WHERE id = ? AND deleted_at IS NULL`,
    id,
  )[0];
  if (row === undefined) throw notFound('order', id);
  return row;
}

export function getSubscriptionRow(ctx: CrmContext, id: string): SubscriptionRow {
  const row = ctx.db.all<SubscriptionRow>(`SELECT * FROM crm_subscriptions WHERE id = ?`, id)[0];
  if (row === undefined) throw notFound('subscription', id);
  return row;
}

export function itemsOf(ctx: CrmContext, orderId: string): OrderItemRow[] {
  return ctx.db.all<OrderItemRow>(
    `SELECT * FROM crm_order_items WHERE order_id = ? ORDER BY position, id`,
    orderId,
  );
}

/** Money facts of an order for event payloads. */
export function orderFacts(
  ctx: CrmContext,
  row: OrderRow,
): {
  orderId: string;
  orderNumber: string;
  contactId: string;
  amountMinor: number;
  currency: string;
  visitorId: string | null;
  productIds: string[];
  subscriptionId: string | null;
  source: OrderRow['source'];
} {
  const productIds = ctx.db
    .all<{ product_id: string }>(
      `SELECT DISTINCT product_id FROM crm_order_items WHERE order_id = ? AND product_id IS NOT NULL
       ORDER BY product_id`,
      row.id,
    )
    .map((r) => r.product_id);
  return {
    orderId: row.id,
    orderNumber: row.number,
    contactId: row.contact_id,
    amountMinor: row.total_minor,
    currency: row.currency,
    visitorId: row.analytics_visitor_id,
    productIds,
    subscriptionId: row.subscription_id,
    source: row.source,
  };
}

/** Money facts of a subscription for event payloads. */
export function subscriptionFacts(row: SubscriptionRow): {
  subscriptionId: string;
  contactId: string;
  productId: string;
  planId: string;
  amountMinor: number;
  currency: string;
  interval: SubscriptionRow['interval'];
  intervalCount: number;
  visitorId: string | null;
} {
  return {
    subscriptionId: row.id,
    contactId: row.contact_id,
    productId: row.product_id,
    planId: row.plan_id,
    amountMinor: row.unit_price_minor * row.quantity,
    currency: row.currency,
    interval: row.interval,
    intervalCount: row.interval_count,
    visitorId: row.analytics_visitor_id,
  };
}
