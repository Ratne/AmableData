import type { Order, OrderItem } from '@amable/api-types';
import type { CrmContext } from '../crm/context';
import { placeholders } from '../crm/db/sql';
import { readValues } from '../crm/custom-fields/repo';
import { toIso } from '../crm/util';
import type { OrderItemRow, OrderRow } from './rows';

export function itemToApi(row: OrderItemRow): OrderItem {
  return {
    id: row.id,
    product_id: row.product_id,
    plan_id: row.plan_id,
    name: row.name,
    sku: row.sku,
    description: row.description,
    quantity: row.quantity,
    unit_price_minor: row.unit_price_minor,
    subtotal_minor: row.subtotal_minor,
    discount_minor: row.discount_minor,
    tax_rate_bps: row.tax_rate_bps,
    tax_minor: row.tax_minor,
    total_minor: row.total_minor,
  };
}

export function ordersToApi(ctx: CrmContext, rows: OrderRow[]): Order[] {
  const ids = rows.map((r) => r.id);
  const items = new Map<string, OrderItem[]>(ids.map((id) => [id, []]));
  const invoices = new Map<string, { id: string; number: string }>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const item of ctx.db.all<OrderItemRow>(
      `SELECT * FROM crm_order_items WHERE order_id IN (${placeholders(chunk.length)}) ORDER BY position, id`,
      ...chunk,
    )) {
      items.get(item.order_id)?.push(itemToApi(item));
    }
    for (const invoice of ctx.db.all<{ id: string; number: string; order_id: string }>(
      `SELECT id, number, order_id FROM crm_invoices WHERE order_id IN (${placeholders(chunk.length)})`,
      ...chunk,
    )) {
      invoices.set(invoice.order_id, { id: invoice.id, number: invoice.number });
    }
  }
  const custom = readValues(ctx, 'order', ids);
  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    contact_id: row.contact_id,
    company_id: row.company_id,
    owner_id: row.owner_id,
    status: row.status,
    source: row.source,
    currency: row.currency,
    subtotal_minor: row.subtotal_minor,
    discount_minor: row.discount_minor,
    tax_minor: row.tax_minor,
    shipping_minor: row.shipping_minor,
    total_minor: row.total_minor,
    paid_minor: row.paid_minor,
    refunded_minor: row.refunded_minor,
    balance_minor:
      row.status === 'cancelled' || row.status === 'refunded'
        ? 0
        : Math.max(0, row.total_minor - row.paid_minor),
    promo_code: row.promo_code,
    notes: row.notes,
    subscription_id: row.subscription_id,
    billing_period_start: toIso(row.billing_period_start),
    billing_period_end: toIso(row.billing_period_end),
    analytics_visitor_id: row.analytics_visitor_id,
    items: items.get(row.id) ?? [],
    invoice: invoices.get(row.id) ?? null,
    custom_fields: custom.get(row.id) ?? {},
    order_date: toIso(row.order_date),
    due_at: toIso(row.due_at),
    finalized_at: toIso(row.finalized_at),
    paid_at: toIso(row.paid_at),
    cancelled_at: toIso(row.cancelled_at),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  }));
}
