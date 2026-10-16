import type {
  CancelOrderInput,
  CreateOrderInput,
  ListOrdersQuery,
  Order,
  OrderItem,
  OrderItemInput,
  Page,
  UpdateOrderInput,
} from '@amable/api-types';
import type { FilterLeaf } from '@amable/api-types';
import type { CrmContext } from '../crm/context';
import { CrmError, invalid, notFound } from '../crm/errors';
import { emit } from '../crm/events';
import { assertRef } from '../crm/refs';
import { prepareValues, searchableValues, writeValues } from '../crm/custom-fields/repo';
import { indexDocument, removeDocument } from '../crm/search/index-store';
import { executeSearch } from '../crm/search/query-builder';
import { parseIsoMs } from '../crm/util';
import { getProductRow } from './catalog';
import { issueInvoice, syncInvoice } from './invoices';
import { computeTotals, type OrderTotals } from './money';
import { evaluatePromo, redeemPromo, releasePromo, type AppliedPromo } from './promo';
import { getOrderRow, itemsOf, orderFacts, type OrderRow } from './rows';
import { ordersToApi } from './serialize';
import { getSettings, nextCounter } from './settings';
import { isRenewalOrder, onSubscriptionOrderPaid } from './sub-hooks';

const DAY_MS = 86_400_000;

/** One resolved order line before pricing. */
export interface LineDraft {
  productId: string | null;
  planId: string | null;
  name: string;
  sku: string | null;
  description: string | null;
  quantity: number;
  unitPriceMinor: number;
  taxRateBps: number;
}

/** Internal options for orders not created through the REST surface. */
export interface CreateOrderOptions {
  source?: OrderRow['source'];
  subscriptionId?: string;
  billingPeriod?: { start: number; end: number };
  /** Pre-resolved lines (subscription renewals bill a plan snapshot, not the catalog price). */
  lines?: LineDraft[];
  dueAt?: number;
}

// ------------------------------------------------------------------ pricing

function resolveLines(
  ctx: CrmContext,
  items: OrderItemInput[],
  explicitCurrency: string | undefined,
): { lines: LineDraft[]; currency: string } {
  let currency = explicitCurrency;
  const lines: LineDraft[] = items.map((item, i) => {
    const path = `items[${i}]`;
    if (item.product_id === null || item.product_id === undefined) {
      if (item.name === undefined)
        throw invalid(`${path}.name`, 'name is required without product_id');
      if (item.unit_price_minor === undefined) {
        throw invalid(
          `${path}.unit_price_minor`,
          'unit_price_minor is required without product_id',
        );
      }
      return {
        productId: null,
        planId: null,
        name: item.name,
        sku: item.sku ?? null,
        description: item.description ?? null,
        quantity: item.quantity ?? 1,
        unitPriceMinor: item.unit_price_minor,
        taxRateBps: item.tax_rate_bps ?? 0,
      };
    }
    let product;
    try {
      product = getProductRow(ctx, item.product_id);
    } catch {
      throw invalid(`${path}.product_id`, `product ${item.product_id} not found`);
    }
    if (product.active !== 1)
      throw invalid(`${path}.product_id`, `product ${product.name} is not active`);
    currency ??= product.currency;
    if (product.currency !== currency) {
      throw invalid(
        `${path}.product_id`,
        `product ${product.name} is priced in ${product.currency}, the order in ${currency}`,
      );
    }
    return {
      productId: product.id,
      planId: null,
      name: item.name ?? product.name,
      sku: item.sku === undefined ? product.sku : item.sku,
      description: item.description === undefined ? null : item.description,
      quantity: item.quantity ?? 1,
      unitPriceMinor: item.unit_price_minor ?? product.price_minor,
      taxRateBps: item.tax_rate_bps ?? product.tax_rate_bps,
    };
  });
  return { lines, currency: currency ?? getSettings(ctx).default_currency };
}

function priceLines(
  ctx: CrmContext,
  input: {
    lines: LineDraft[];
    currency: string;
    contactId: string;
    promoCode: string | null;
    shippingMinor: number;
    orderId: string | null;
    at: number;
  },
): { totals: OrderTotals; promo: AppliedPromo | null } {
  const promo =
    input.promoCode === null
      ? null
      : evaluatePromo(ctx, {
          code: input.promoCode,
          contactId: input.contactId,
          currency: input.currency,
          orderId: input.orderId,
          lines: input.lines.map((l) => ({
            productId: l.productId,
            subtotalMinor: l.quantity * l.unitPriceMinor,
          })),
          at: input.at,
        });
  const totals = computeTotals(
    input.lines.map((l) => ({
      quantity: l.quantity,
      unitPriceMinor: l.unitPriceMinor,
      taxRateBps: l.taxRateBps,
      discountable: promo === null ? false : promo.appliesTo(l.productId),
    })),
    promo === null ? null : promo.rule,
    input.shippingMinor,
  );
  return { totals, promo };
}

function writeItems(
  ctx: CrmContext,
  orderId: string,
  lines: LineDraft[],
  totals: OrderTotals,
): void {
  ctx.db.run(`DELETE FROM crm_order_items WHERE order_id = ?`, orderId);
  lines.forEach((line, i) => {
    const t = totals.lines[i];
    if (t === undefined) return;
    ctx.db.run(
      `INSERT INTO crm_order_items (id, order_id, product_id, plan_id, name, sku, description, quantity,
         unit_price_minor, subtotal_minor, discount_minor, tax_rate_bps, tax_minor, total_minor, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ctx.newId(),
      orderId,
      line.productId,
      line.planId,
      line.name,
      line.sku,
      line.description,
      line.quantity,
      line.unitPriceMinor,
      t.subtotalMinor,
      t.discountMinor,
      line.taxRateBps,
      t.taxMinor,
      t.totalMinor,
      i,
    );
  });
}

function linesOf(ctx: CrmContext, orderId: string): LineDraft[] {
  return itemsOf(ctx, orderId).map((item) => ({
    productId: item.product_id,
    planId: item.plan_id,
    name: item.name,
    sku: item.sku,
    description: item.description,
    quantity: item.quantity,
    unitPriceMinor: item.unit_price_minor,
    taxRateBps: item.tax_rate_bps,
  }));
}

// ------------------------------------------------------------------- status

/**
 * Payment status of a finalized order from its gross amounts:
 * refunded = every collected cent was returned; paid = collected ≥ total
 * (a partial refund keeps `paid`, see `refunded_minor`); partially_paid; unpaid.
 */
export function derivedStatus(
  row: Pick<OrderRow, 'status' | 'total_minor' | 'paid_minor' | 'refunded_minor'>,
): OrderRow['status'] {
  if (row.status === 'draft' || row.status === 'cancelled') return row.status;
  if (row.paid_minor > 0 && row.refunded_minor >= row.paid_minor) return 'refunded';
  if (row.paid_minor >= row.total_minor) return 'paid';
  if (row.paid_minor > 0) return 'partially_paid';
  return 'unpaid';
}

/**
 * Re-derives the status after a money change, keeps the invoice in sync and
 * emits `order.paid` the first time the order becomes fully paid.
 */
export function applyStatus(ctx: CrmContext, orderId: string): OrderRow {
  const before = getOrderRow(ctx, orderId);
  const status = derivedStatus(before);
  const now = ctx.now();
  const becamePaid = status === 'paid' && before.paid_at === null;
  if (status !== before.status || becamePaid) {
    ctx.db.run(
      `UPDATE crm_orders SET status = ?, paid_at = ?, updated_at = ? WHERE id = ?`,
      status,
      becamePaid ? now : before.paid_at,
      now,
      orderId,
    );
  }
  const row = getOrderRow(ctx, orderId);
  syncInvoice(ctx, row);
  if (becamePaid) {
    emit(
      ctx,
      'order.paid',
      { ...orderFacts(ctx, row), renewal: isRenewalOrder(ctx, row) },
      {
        number: row.number,
      },
    );
    onSubscriptionOrderPaid(ctx, row);
  }
  indexOrder(ctx, row.id);
  return row;
}

// ------------------------------------------------------------------- search

/** Search document of an order: number; contact, items, SKUs, promo code, notes, custom fields. */
export function indexOrder(ctx: CrmContext, orderId: string): void {
  const row = getOrderRow(ctx, orderId);
  const contact = ctx.db.all<{ name: string; email: string | null }>(
    `SELECT TRIM(IFNULL(given_name, '') || ' ' || IFNULL(family_name, '')) AS name, primary_email AS email
     FROM crm_contacts WHERE id = ?`,
    row.contact_id,
  )[0];
  const items = itemsOf(ctx, orderId);
  indexDocument(ctx, 'order', orderId, row.number, [
    contact?.name,
    contact?.email,
    ...items.map((i) => i.name),
    ...items.map((i) => i.sku),
    row.promo_code,
    row.notes,
    ...searchableValues(ctx, 'order', orderId),
  ]);
}

// --------------------------------------------------------------- lifecycle

/**
 * Creates an order. Without `status: 'draft'` the order is finalized at once:
 * promo redemption recorded, invoice issued, `order.created` emitted.
 */
export function createOrderRow(
  ctx: CrmContext,
  input: CreateOrderInput,
  options: CreateOrderOptions = {},
): OrderRow {
  assertRef(ctx, 'contact', input.contact_id, 'contact_id');
  assertRef(ctx, 'company', input.company_id, 'company_id');
  const custom = prepareValues(ctx, 'order', input.custom_fields, { requireAll: true });
  const resolved =
    options.lines === undefined
      ? resolveLines(ctx, input.items, input.currency)
      : { lines: options.lines, currency: input.currency ?? getSettings(ctx).default_currency };
  const now = ctx.now();
  const orderDate =
    input.order_date === undefined ? now : parseIsoMs(input.order_date, 'order_date');
  const shippingMinor = input.shipping_minor ?? 0;
  const { totals, promo } = priceLines(ctx, {
    lines: resolved.lines,
    currency: resolved.currency,
    contactId: input.contact_id,
    promoCode: input.promo_code ?? null,
    shippingMinor,
    orderId: null,
    at: orderDate,
  });
  const settings = getSettings(ctx);
  const id = ctx.newId();
  const number = `${settings.order_prefix}${String(nextCounter(ctx, 'order')).padStart(6, '0')}`;
  const source = options.source ?? (ctx.actor.type === 'api_key' ? 'api' : 'manual');
  ctx.db.run(
    `INSERT INTO crm_orders (id, number, contact_id, company_id, owner_id, status, source, currency,
       subtotal_minor, discount_minor, tax_minor, shipping_minor, total_minor, promo_code_id, promo_code,
       notes, subscription_id, billing_period_start, billing_period_end, analytics_visitor_id, order_date,
       due_at, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    number,
    input.contact_id,
    input.company_id ?? null,
    input.owner_id === undefined ? ctx.actor.id : input.owner_id,
    source,
    resolved.currency,
    totals.subtotalMinor,
    totals.discountMinor,
    totals.taxMinor,
    totals.shippingMinor,
    totals.totalMinor,
    promo?.id ?? null,
    promo?.code ?? null,
    input.notes ?? null,
    options.subscriptionId ?? null,
    options.billingPeriod?.start ?? null,
    options.billingPeriod?.end ?? null,
    input.analytics_visitor_id ?? null,
    orderDate,
    input.due_at === undefined || input.due_at === null
      ? (options.dueAt ?? null)
      : parseIsoMs(input.due_at, 'due_at'),
    ctx.actor.id,
    now,
    now,
  );
  writeItems(ctx, id, resolved.lines, totals);
  writeValues(ctx, id, custom);
  if (input.status === 'draft') {
    indexOrder(ctx, id);
    return getOrderRow(ctx, id);
  }
  return finalizeRow(ctx, getOrderRow(ctx, id));
}

function finalizeRow(ctx: CrmContext, draft: OrderRow): OrderRow {
  const now = ctx.now();
  if (draft.promo_code_id !== null && draft.promo_code !== null) {
    // Limits are re-checked at finalization: a draft never reserves a redemption.
    evaluatePromo(ctx, {
      code: draft.promo_code,
      contactId: draft.contact_id,
      currency: draft.currency,
      orderId: draft.id,
      lines: itemsOf(ctx, draft.id).map((i) => ({
        productId: i.product_id,
        subtotalMinor: i.subtotal_minor,
      })),
      at: draft.order_date,
    });
    redeemPromo(ctx, draft.promo_code_id, draft.id, draft.contact_id);
  }
  const dueAt = draft.due_at ?? now + getSettings(ctx).payment_terms_days * DAY_MS;
  ctx.db.run(
    `UPDATE crm_orders SET status = 'unpaid', finalized_at = ?, due_at = ?, updated_at = ? WHERE id = ?`,
    now,
    dueAt,
    now,
    draft.id,
  );
  const row = getOrderRow(ctx, draft.id);
  issueInvoice(ctx, row, now);
  emit(
    ctx,
    'order.created',
    { ...orderFacts(ctx, row), status: derivedStatus(row) },
    {
      number: row.number,
    },
  );
  return applyStatus(ctx, row.id);
}

export function getOrder(ctx: CrmContext, input: { id: string }): Order {
  const [order] = ordersToApi(ctx, [getOrderRow(ctx, input.id)]);
  if (order === undefined) throw notFound('order', input.id);
  return order;
}

export function createOrder(ctx: CrmContext, input: CreateOrderInput): Order {
  return getOrder(ctx, { id: createOrderRow(ctx, input).id });
}

export function finalizeOrder(ctx: CrmContext, input: { id: string }): Order {
  const row = getOrderRow(ctx, input.id);
  if (row.status !== 'draft')
    throw new CrmError('conflict', `order ${row.number} is already finalized`);
  return getOrder(ctx, { id: finalizeRow(ctx, row).id });
}

const DRAFT_ONLY = ['currency', 'items', 'promo_code', 'shipping_minor', 'order_date'] as const;

/**
 * Drafts accept every field (lines are re-priced); finalized orders only
 * notes, owner, company, due date, visitor id and custom fields.
 */
export function updateOrder(ctx: CrmContext, input: { id: string; data: UpdateOrderInput }): Order {
  const row = getOrderRow(ctx, input.id);
  const d = input.data;
  if (row.status !== 'draft') {
    const locked = DRAFT_ONLY.filter((key) => d[key] !== undefined);
    if (locked.length > 0) {
      throw new CrmError(
        'conflict',
        `order ${row.number} is finalized; ${locked.join(', ')} can only change on drafts`,
      );
    }
  }
  assertRef(ctx, 'company', d.company_id, 'company_id');
  const custom = prepareValues(ctx, 'order', d.custom_fields);
  const now = ctx.now();
  if (row.status === 'draft' && DRAFT_ONLY.some((key) => d[key] !== undefined)) {
    const resolved =
      d.items === undefined
        ? { lines: linesOf(ctx, row.id), currency: d.currency ?? row.currency }
        : resolveLines(ctx, d.items, d.currency ?? row.currency);
    const orderDate =
      d.order_date === undefined ? row.order_date : parseIsoMs(d.order_date, 'order_date');
    const promoCode = d.promo_code === undefined ? row.promo_code : d.promo_code;
    const { totals, promo } = priceLines(ctx, {
      lines: resolved.lines,
      currency: resolved.currency,
      contactId: row.contact_id,
      promoCode,
      shippingMinor: d.shipping_minor ?? row.shipping_minor,
      orderId: row.id,
      at: orderDate,
    });
    ctx.db.run(
      `UPDATE crm_orders SET currency = ?, subtotal_minor = ?, discount_minor = ?, tax_minor = ?, shipping_minor = ?,
         total_minor = ?, promo_code_id = ?, promo_code = ?, order_date = ?, updated_at = ? WHERE id = ?`,
      resolved.currency,
      totals.subtotalMinor,
      totals.discountMinor,
      totals.taxMinor,
      totals.shippingMinor,
      totals.totalMinor,
      promo?.id ?? null,
      promo?.code ?? null,
      orderDate,
      now,
      row.id,
    );
    writeItems(ctx, row.id, resolved.lines, totals);
  }
  const keep = <T>(value: T | undefined, current: T): T => (value === undefined ? current : value);
  ctx.db.run(
    `UPDATE crm_orders SET company_id = ?, owner_id = ?, notes = ?, due_at = ?, analytics_visitor_id = ?,
       updated_at = ? WHERE id = ?`,
    keep(d.company_id, row.company_id),
    keep(d.owner_id, row.owner_id),
    keep(d.notes, row.notes),
    d.due_at === undefined ? row.due_at : d.due_at === null ? null : parseIsoMs(d.due_at, 'due_at'),
    keep(d.analytics_visitor_id, row.analytics_visitor_id),
    now,
    row.id,
  );
  writeValues(ctx, row.id, custom);
  const updated = getOrderRow(ctx, row.id);
  if (updated.status !== 'draft') syncInvoice(ctx, updated);
  indexOrder(ctx, row.id);
  return getOrder(ctx, { id: row.id });
}

/** Adds a line to a draft order (re-prices it). */
export function addOrderItem(ctx: CrmContext, input: { id: string; data: OrderItemInput }): Order {
  const row = getOrderRow(ctx, input.id);
  if (row.status !== 'draft') throw new CrmError('conflict', `order ${row.number} is finalized`);
  const added = resolveLines(ctx, [input.data], row.currency).lines;
  return repriceDraft(ctx, row, [...linesOf(ctx, row.id), ...added]);
}

/** Removes a line from a draft order (at least one line must remain). */
export function removeOrderItem(ctx: CrmContext, input: { id: string; itemId: string }): Order {
  const row = getOrderRow(ctx, input.id);
  if (row.status !== 'draft') throw new CrmError('conflict', `order ${row.number} is finalized`);
  const items = itemsOf(ctx, row.id);
  const index = items.findIndex((i) => i.id === input.itemId);
  if (index === -1) throw notFound('order item', input.itemId);
  if (items.length === 1) throw new CrmError('conflict', 'an order needs at least one item');
  const lines = linesOf(ctx, row.id).filter((_, i) => i !== index);
  return repriceDraft(ctx, row, lines);
}

function repriceDraft(ctx: CrmContext, row: OrderRow, lines: LineDraft[]): Order {
  const { totals, promo } = priceLines(ctx, {
    lines,
    currency: row.currency,
    contactId: row.contact_id,
    promoCode: row.promo_code,
    shippingMinor: row.shipping_minor,
    orderId: row.id,
    at: row.order_date,
  });
  ctx.db.run(
    `UPDATE crm_orders SET subtotal_minor = ?, discount_minor = ?, tax_minor = ?, total_minor = ?,
       promo_code_id = ?, updated_at = ? WHERE id = ?`,
    totals.subtotalMinor,
    totals.discountMinor,
    totals.taxMinor,
    totals.totalMinor,
    promo?.id ?? null,
    ctx.now(),
    row.id,
  );
  writeItems(ctx, row.id, lines, totals);
  indexOrder(ctx, row.id);
  return getOrder(ctx, { id: row.id });
}

export function listOrderItems(ctx: CrmContext, input: { id: string }): { data: OrderItem[] } {
  getOrderRow(ctx, input.id);
  return { data: getOrder(ctx, input).items };
}

/**
 * Cancels an order that holds no money (unpaid, or fully refunded): the
 * invoice is voided and the promo redemption released.
 */
export function cancelOrder(ctx: CrmContext, input: { id: string; data: CancelOrderInput }): Order {
  const row = getOrderRow(ctx, input.id);
  if (row.status === 'cancelled')
    throw new CrmError('conflict', `order ${row.number} is already cancelled`);
  if (row.paid_minor - row.refunded_minor > 0) {
    throw new CrmError(
      'conflict',
      `order ${row.number} has payments; refund them before cancelling`,
    );
  }
  const now = ctx.now();
  const reason = input.data.reason ?? null;
  ctx.db.run(
    `UPDATE crm_orders SET status = 'cancelled', cancelled_at = ?,
       notes = CASE WHEN ? IS NULL THEN notes ELSE TRIM(IFNULL(notes, '') || char(10) || 'Cancelled: ' || ?) END,
       updated_at = ? WHERE id = ?`,
    now,
    reason,
    reason,
    now,
    row.id,
  );
  if (row.promo_code_id !== null) releasePromo(ctx, row.promo_code_id, row.id);
  const updated = getOrderRow(ctx, row.id);
  syncInvoice(ctx, updated);
  if (row.status !== 'draft') {
    emit(ctx, 'order.cancelled', orderFacts(ctx, updated), { number: updated.number });
  }
  indexOrder(ctx, row.id);
  return getOrder(ctx, { id: row.id });
}

/** Only drafts can be deleted; finalized orders are cancelled instead (they have an invoice number). */
export function deleteOrder(ctx: CrmContext, input: { id: string }): { id: string; deleted: true } {
  const row = getOrderRow(ctx, input.id);
  if (row.status !== 'draft') {
    throw new CrmError('conflict', `order ${row.number} is finalized; cancel it instead`);
  }
  ctx.db.run(`UPDATE crm_orders SET deleted_at = ? WHERE id = ?`, ctx.now(), row.id);
  removeDocument(ctx, 'order', row.id);
  return { id: row.id, deleted: true };
}

/** Orders list on the query-builder compiler (same filters, FTS and cursor as `/search`). */
export function listOrders(ctx: CrmContext, input: ListOrdersQuery): Page<Order> {
  const extra: FilterLeaf[] = [];
  const eq = (field: string, value: string | undefined): void => {
    if (value !== undefined) extra.push({ type: 'field', field, operator: 'equals', value });
  };
  eq('status', input.status);
  eq('contact_id', input.contact_id);
  eq('subscription_id', input.subscription_id);
  eq('source', input.source);
  const result = executeSearch(
    ctx,
    {
      entity: 'order',
      ...(input.q === undefined ? {} : { q: input.q }),
      columns: ['id'],
      sort: { field: 'order_date', direction: 'desc' },
      limit: input.limit,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    },
    { extra },
  );
  const ids = result.data.map((row) => String(row['id']));
  const rows = ids.map((id) => getOrderRow(ctx, id));
  return { data: ordersToApi(ctx, rows), next_cursor: result.next_cursor };
}
