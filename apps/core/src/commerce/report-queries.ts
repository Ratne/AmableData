import type { CrmContext } from '../crm/context';
import { CONTACT_NAME, defaultCurrency, runSpec } from '../crm/report-queries';
import {
  currenciesIn,
  ensureIndexes,
  lit,
  type AggregateInput,
  type AggregateOutput,
  type AggregateRow,
  type GenericSpec,
} from '../reports/aggregate';
import { filterFragment } from '../reports/filter';
import { windowStats, type SubscriptionFact, type WindowStats } from '../reports/mrr';

/**
 * Read-only aggregates of the e-commerce tables for the report engine: sales,
 * revenue by product, payments, refunds, receivables aging, customer lifetime
 * value and subscription revenue (MRR/ARR/churn). Revenue never includes
 * drafts or cancelled orders; money is integer minor units of one currency.
 */

const COMMERCE_REPORT_INDEXES: ReadonlyArray<[string, string]> = [
  ['crm_refunds', `CREATE INDEX IF NOT EXISTS rpt_refunds_at ON crm_refunds (refunded_at)`],
  [
    'crm_subscriptions',
    `CREATE INDEX IF NOT EXISTS rpt_subscriptions_currency_started ON crm_subscriptions (currency, started_at)`,
  ],
];

const SALE = `o.deleted_at IS NULL AND o.status NOT IN ('draft', 'cancelled')`;
const DAY = 86_400_000;

function ordersSpec(): GenericSpec {
  const anchor = 'o.order_date';
  return {
    from: 'crm_orders o',
    where: [SALE],
    measures: {
      count: { expr: 'COUNT(*)', anchor },
      revenue: { expr: 'COALESCE(SUM(o.total_minor), 0)', anchor },
      paid: { expr: 'COALESCE(SUM(o.paid_minor), 0)', anchor },
      refunded: { expr: 'COALESCE(SUM(o.refunded_minor), 0)', anchor },
      net: { expr: 'COALESCE(SUM(o.paid_minor - o.refunded_minor), 0)', anchor },
      customers: { expr: 'COUNT(DISTINCT o.contact_id)', anchor },
    },
    dimensions: {
      status: { key: 'o.status' },
      source: { key: 'o.source' },
      kind: {
        key: `CASE WHEN o.subscription_id IS NULL THEN 'one_time'
                   WHEN EXISTS (SELECT 1 FROM crm_orders o2
                                 WHERE o2.subscription_id = o.subscription_id AND o2.deleted_at IS NULL
                                   AND o2.billing_period_start < o.billing_period_start) THEN 'renewal'
                   ELSE 'new_subscription' END`,
      },
      owner: { key: 'o.owner_id' },
    },
    currencyColumn: 'o.currency',
    moneyMeasures: ['revenue', 'paid', 'refunded', 'net'],
    contactColumn: 'o.contact_id',
    bounded: ['status', 'source', 'kind', 'owner'],
  };
}

function orderItemsSpec(): GenericSpec {
  const anchor = 'o.order_date';
  return {
    from: 'crm_orders o JOIN crm_order_items i ON i.order_id = o.id',
    where: [SALE],
    measures: {
      quantity: { expr: 'COALESCE(SUM(i.quantity), 0)', anchor },
      revenue: { expr: 'COALESCE(SUM(i.total_minor), 0)', anchor },
      orders: { expr: 'COUNT(DISTINCT i.order_id)', anchor },
    },
    dimensions: {
      product: {
        key: `COALESCE(i.product_id, 'line:' || i.name)`,
        label: `COALESCE((SELECT p.name FROM crm_products p WHERE p.id = i.product_id), MAX(i.name))`,
      },
    },
    currencyColumn: 'o.currency',
    moneyMeasures: ['revenue'],
    contactColumn: 'o.contact_id',
  };
}

function paymentsSpec(): GenericSpec {
  const anchor = 'p.paid_at';
  const ok = `p.status = 'succeeded'`;
  return {
    from: 'crm_payments p',
    where: [],
    measures: {
      count: { expr: `SUM(CASE WHEN ${ok} THEN 1 ELSE 0 END)`, anchor },
      amount: { expr: `SUM(CASE WHEN ${ok} THEN p.amount_minor ELSE 0 END)`, anchor },
      refunded: { expr: `SUM(CASE WHEN ${ok} THEN p.refunded_minor ELSE 0 END)`, anchor },
      net: {
        expr: `SUM(CASE WHEN ${ok} THEN p.amount_minor - p.refunded_minor ELSE 0 END)`,
        anchor,
      },
      failed: { expr: `SUM(CASE WHEN p.status = 'failed' THEN 1 ELSE 0 END)`, anchor },
    },
    dimensions: { method: { key: 'p.method' }, status: { key: 'p.status' } },
    currencyColumn: 'p.currency',
    moneyMeasures: ['amount', 'refunded', 'net'],
    contactColumn: 'p.contact_id',
    bounded: ['method', 'status'],
  };
}

function refundsSpec(): GenericSpec {
  const anchor = 'r.refunded_at';
  return {
    from: 'crm_refunds r',
    where: [],
    measures: {
      count: { expr: 'COUNT(*)', anchor },
      amount: { expr: 'COALESCE(SUM(r.amount_minor), 0)', anchor },
    },
    dimensions: { reason: { key: `COALESCE(NULLIF(TRIM(r.reason), ''), '')` } },
    currencyColumn: 'r.currency',
    moneyMeasures: ['amount'],
    contactColumn: 'r.contact_id',
  };
}

/** Aging buckets of open balances: not yet due, 1–30, 31–60, 61–90, over 90 days past due. */
export const AGING_BUCKETS = ['current', '1_30', '31_60', '61_90', '90_plus'] as const;

function receivablesSpec(now: number): GenericSpec {
  const late = `(${lit(now)} - o.due_at)`;
  const aging = `CASE WHEN o.due_at IS NULL OR o.due_at >= ${lit(now)} THEN 0
                      WHEN ${late} <= ${lit(30 * DAY)} THEN 1
                      WHEN ${late} <= ${lit(60 * DAY)} THEN 2
                      WHEN ${late} <= ${lit(90 * DAY)} THEN 3 ELSE 4 END`;
  const label = AGING_BUCKETS.map((b, i) => `WHEN ${String(i)} THEN '${b}'`).join(' ');
  return {
    from: 'crm_orders o',
    where: [
      `o.deleted_at IS NULL`,
      `o.status IN ('unpaid', 'partially_paid')`,
      `o.finalized_at IS NOT NULL`,
    ],
    measures: {
      count: { expr: 'COUNT(*)', anchor: null },
      balance: { expr: 'COALESCE(SUM(o.total_minor - o.paid_minor), 0)', anchor: null },
      overdue_balance: {
        expr: `COALESCE(SUM(CASE WHEN o.due_at < ${lit(now)} THEN o.total_minor - o.paid_minor ELSE 0 END), 0)`,
        anchor: null,
      },
    },
    dimensions: {
      aging: { key: `CASE ${aging} ${label} END`, sort: aging },
      contact: { key: 'o.contact_id', label: CONTACT_NAME('o.contact_id') },
    },
    currencyColumn: 'o.currency',
    moneyMeasures: ['balance', 'overdue_balance'],
    contactColumn: 'o.contact_id',
    bounded: ['aging'],
  };
}

function customersSpec(currency: string): GenericSpec {
  return {
    from: `(SELECT o.contact_id AS contact_id, SUM(o.paid_minor - o.refunded_minor) AS ltv,
                   COUNT(*) AS n, MIN(o.order_date) AS first_at
              FROM crm_orders o WHERE ${SALE} AND o.currency = ?
             GROUP BY o.contact_id) x`,
    fromParams: [currency],
    where: [],
    measures: {
      customers: { expr: 'COUNT(*)', anchor: 'x.first_at' },
      lifetime_value: { expr: 'COALESCE(SUM(x.ltv), 0)', anchor: 'x.first_at' },
      orders: { expr: 'COALESCE(SUM(x.n), 0)', anchor: 'x.first_at' },
    },
    dimensions: { contact: { key: 'x.contact_id', label: CONTACT_NAME('x.contact_id') } },
    currencyColumn: null,
    contactColumn: 'x.contact_id',
  };
}

interface SubscriptionRow extends SubscriptionFact {
  plan_name: string | null;
  product_name: string | null;
}

function subscriptionValues(
  stats: WindowStats,
  measures: readonly string[],
): Record<string, number> {
  const all: Record<string, number> = { ...stats };
  const values: Record<string, number> = {};
  for (const m of measures) values[m] = all[m] ?? 0;
  return values;
}

/** MRR / ARR / churn, computed in the DO from the subscriptions overlapping the range. */
function subscriptionsReport(
  ctx: CrmContext,
  input: AggregateInput,
  currency: string,
): AggregateOutput {
  const filter = filterFragment(ctx, 'contact', input.filter, 's.contact_id');
  const { from, to } = input.range;
  const subs = ctx.db.all<SubscriptionRow>(
    `SELECT s.id, s.plan_id, s.product_id, s.status, s.quantity, s.unit_price_minor, s.interval,
            s.interval_count, s.started_at, s.trial_ends_at, s.paused_at, s.ended_at,
            (SELECT pl.name FROM crm_subscription_plans pl WHERE pl.id = s.plan_id) AS plan_name,
            (SELECT pr.name FROM crm_products pr WHERE pr.id = s.product_id) AS product_name
       FROM crm_subscriptions s
      WHERE s.currency = ? AND s.started_at < ${lit(to)}
        AND (s.ended_at IS NULL OR s.ended_at >= ${lit(from - 1)})${filter === null ? '' : ` AND ${filter.sql}`}`,
    currency,
    ...(filter?.params ?? []),
  );
  const totals = subscriptionValues(windowStats(subs, from, to), input.measures);
  let rows: AggregateRow[] = [];
  let truncated = false;
  if (input.dimension === 'date') {
    const bounds = input.buckets ?? [];
    for (let i = 0; i + 1 < bounds.length; i += 1) {
      rows.push({
        key: String(i),
        label: null,
        values: subscriptionValues(
          windowStats(subs, bounds[i] ?? 0, bounds[i + 1] ?? 0),
          input.measures,
        ),
      });
    }
  } else if (input.dimension === 'plan' || input.dimension === 'product') {
    const byKey = new Map<string, { label: string | null; subs: SubscriptionRow[] }>();
    for (const sub of subs) {
      const key = input.dimension === 'plan' ? sub.plan_id : sub.product_id;
      const entry = byKey.get(key) ?? {
        label: input.dimension === 'plan' ? sub.plan_name : sub.product_name,
        subs: [],
      };
      entry.subs.push(sub);
      byKey.set(key, entry);
    }
    rows = [...byKey.entries()].map(([key, e]) => ({
      key,
      label: e.label,
      values: subscriptionValues(windowStats(e.subs, from, to), input.measures),
    }));
    const first = input.measures[0] ?? 'mrr';
    rows.sort(
      (a, b) => (b.values[first] ?? 0) - (a.values[first] ?? 0) || a.key.localeCompare(b.key),
    );
    truncated = rows.length > input.offset + input.limit;
    rows = rows.slice(input.offset, input.offset + input.limit);
  }
  const currencies = ctx.db
    .all<{ c: string }>(`SELECT DISTINCT currency AS c FROM crm_subscriptions ORDER BY 1 LIMIT 20`)
    .map((r) => r.c);
  return { rows, totals, currency, currencies, truncated };
}

export const COMMERCE_REPORT_SOURCES = [
  'orders',
  'order_items',
  'payments',
  'refunds',
  'receivables',
  'customers',
  'subscriptions',
] as const;
export type CommerceReportSource = (typeof COMMERCE_REPORT_SOURCES)[number];

export function isCommerceReportSource(source: string): source is CommerceReportSource {
  return (COMMERCE_REPORT_SOURCES as readonly string[]).includes(source);
}

/** Aggregates one e-commerce source inside the TenantDb DO. */
export function commerceReportAggregate(
  ctx: CrmContext,
  input: AggregateInput & { source: CommerceReportSource },
): AggregateOutput {
  ensureIndexes(ctx.db, 'commerce', COMMERCE_REPORT_INDEXES);
  const currency = input.currency ?? defaultCurrency(ctx);
  const saleWhere = `deleted_at IS NULL AND status NOT IN ('draft', 'cancelled')`;
  let out: AggregateOutput;
  switch (input.source) {
    case 'orders':
      out = runSpec(ctx, ordersSpec(), input, currency);
      out.currencies = currenciesIn(
        ctx.db,
        'crm_orders',
        'currency',
        'order_date',
        input.range,
        saleWhere,
      );
      break;
    case 'order_items':
      out = runSpec(ctx, orderItemsSpec(), input, currency);
      out.currencies = currenciesIn(
        ctx.db,
        'crm_orders',
        'currency',
        'order_date',
        input.range,
        saleWhere,
      );
      break;
    case 'payments':
      out = runSpec(ctx, paymentsSpec(), input, currency);
      out.currencies = currenciesIn(ctx.db, 'crm_payments', 'currency', 'paid_at', input.range);
      break;
    case 'refunds':
      out = runSpec(ctx, refundsSpec(), input, currency);
      out.currencies = currenciesIn(ctx.db, 'crm_refunds', 'currency', 'refunded_at', input.range);
      break;
    case 'receivables':
      out = runSpec(ctx, receivablesSpec(input.now), input, currency);
      out.currencies = currenciesIn(
        ctx.db,
        'crm_orders',
        'currency',
        null,
        input.range,
        `deleted_at IS NULL AND status IN ('unpaid', 'partially_paid')`,
      );
      break;
    case 'customers':
      out = runSpec(ctx, customersSpec(currency), input, currency);
      out.currency = currency;
      out.currencies = currenciesIn(ctx.db, 'crm_orders', 'currency', null, input.range, saleWhere);
      break;
    case 'subscriptions':
      out = subscriptionsReport(ctx, input, currency);
      break;
  }
  out.currencies = out.currencies.filter((c) => c !== out.currency);
  return out;
}
