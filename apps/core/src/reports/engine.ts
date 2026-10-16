import {
  REPORT_SOURCE_SPECS,
  reportDefinitionSchema,
  type ReportDefinition,
  type ReportOverrides,
  type ReportResult,
  type ReportRow,
  type ReportSource,
  type ReportValues,
} from '@amable/api-types/reports';
import { CrmError } from '../crm/errors';
import type { AggregateInput, AggregateOutput } from './aggregate';
import { queryAnalytics, type AnalyticsPort } from './analytics-source';
import {
  buildBuckets,
  compareRange,
  formatDate,
  rangeMs,
  resolveRange,
  type Buckets,
  type DayRange,
} from './time';

/**
 * The report engine (worker side). Validates a definition against its source
 * spec, resolves the date range / comparison period / buckets in the report
 * time zone, asks the source adapter for grouped base measures (aggregated
 * inside the owning Durable Object), then derives ratios and averages, fills
 * empty buckets and labels the rows.
 */

export type AggregateTarget = 'tenant' | 'mail' | 'engine';

export interface ReportPorts {
  tenantId: string;
  aggregate(target: AggregateTarget, input: AggregateInput): Promise<AggregateOutput>;
  analytics: AnalyticsPort | null;
  /** Display names of user ids (owner / assignee dimensions). */
  userLabels(ids: string[]): Promise<Map<string, string>>;
  now(): number;
}

const TARGET: Readonly<Record<ReportSource, AggregateTarget | 'analytics'>> = {
  contacts: 'tenant',
  companies: 'tenant',
  tags: 'tenant',
  lead_sources: 'tenant',
  opportunities: 'tenant',
  tasks: 'tenant',
  forms: 'tenant',
  orders: 'tenant',
  order_items: 'tenant',
  payments: 'tenant',
  refunds: 'tenant',
  receivables: 'tenant',
  customers: 'tenant',
  subscriptions: 'tenant',
  emails: 'mail',
  broadcasts: 'mail',
  broadcast_links: 'mail',
  automations: 'engine',
  automation_nodes: 'engine',
  analytics: 'analytics',
  ad_campaigns: 'analytics',
};

type Values = Readonly<Record<string, number | undefined>>;

interface Derived {
  deps: readonly string[];
  fn: (v: Values) => number | null;
}

const DAY_MS = 86_400_000;

function n(v: Values, key: string): number {
  return v[key] ?? 0;
}

/** Ratio rounded to 4 decimals; null when the denominator is 0. */
export function ratio(num: number, den: number): number | null {
  return den === 0 ? null : Math.round((num / den) * 10_000) / 10_000;
}

/** Money average in minor units (half-up); null when the denominator is 0. */
function moneyDiv(num: number, den: number): number | null {
  return den === 0 ? null : Math.round(num / den);
}

const rate = (key: string): Derived => ({
  deps: [key, 'sent'],
  fn: (v) => ratio(n(v, key), n(v, 'sent')),
});

const DERIVED: Partial<Record<ReportSource, Readonly<Record<string, Derived>>>> = {
  lead_sources: {
    conversion_rate: {
      deps: ['customers', 'contacts'],
      fn: (v) => ratio(n(v, 'customers'), n(v, 'contacts')),
    },
    revenue_per_contact: {
      deps: ['revenue', 'contacts'],
      fn: (v) => moneyDiv(n(v, 'revenue'), n(v, 'contacts')),
    },
  },
  opportunities: {
    win_rate: { deps: ['won', 'lost'], fn: (v) => ratio(n(v, 'won'), n(v, 'won') + n(v, 'lost')) },
    avg_cycle_days: {
      deps: ['cycle_ms_won', 'won'],
      fn: (v) =>
        n(v, 'won') === 0
          ? null
          : Math.round((n(v, 'cycle_ms_won') / n(v, 'won') / DAY_MS) * 10) / 10,
    },
    velocity_per_day: {
      deps: ['open_count', 'won_value', 'won', 'lost', 'cycle_ms_won'],
      fn: (v) => {
        const won = n(v, 'won');
        const closed = won + n(v, 'lost');
        const cycleDays = won === 0 ? 0 : n(v, 'cycle_ms_won') / won / DAY_MS;
        if (won === 0 || closed === 0 || cycleDays <= 0) return null;
        return Math.round(
          (n(v, 'open_count') * (n(v, 'won_value') / won) * (won / closed)) /
            Math.max(cycleDays, 1),
        );
      },
    },
  },
  orders: {
    avg_order_value: {
      deps: ['revenue', 'count'],
      fn: (v) => moneyDiv(n(v, 'revenue'), n(v, 'count')),
    },
  },
  customers: {
    avg_lifetime_value: {
      deps: ['lifetime_value', 'customers'],
      fn: (v) => moneyDiv(n(v, 'lifetime_value'), n(v, 'customers')),
    },
  },
  subscriptions: {
    arr: { deps: ['mrr'], fn: (v) => n(v, 'mrr') * 12 },
    churn_rate: {
      deps: ['churned', 'active_start'],
      fn: (v) => ratio(n(v, 'churned'), n(v, 'active_start')),
    },
    revenue_churn_rate: {
      deps: ['churned_mrr', 'mrr_start'],
      fn: (v) => ratio(n(v, 'churned_mrr'), n(v, 'mrr_start')),
    },
  },
  emails: {
    open_rate: rate('opened'),
    click_rate: rate('clicked'),
    bounce_rate: rate('bounced'),
    unsubscribe_rate: rate('unsubscribed'),
  },
  broadcasts: {
    open_rate: rate('opened'),
    click_rate: rate('clicked'),
    bounce_rate: rate('bounced'),
    unsubscribe_rate: rate('unsubscribed'),
  },
  automations: {
    completion_rate: {
      deps: ['completed', 'entered'],
      fn: (v) => ratio(n(v, 'completed'), n(v, 'entered')),
    },
  },
  analytics: {
    revenue_per_visitor: {
      deps: ['revenue', 'visitors'],
      fn: (v) => moneyDiv(n(v, 'revenue'), n(v, 'visitors')),
    },
  },
  ad_campaigns: {
    roas: { deps: ['revenue', 'spend'], fn: (v) => ratio(n(v, 'revenue'), n(v, 'spend')) },
    cost_per_acquisition: {
      deps: ['spend', 'customers'],
      fn: (v) => moneyDiv(n(v, 'spend'), n(v, 'customers')),
    },
  },
};

/** Base measures the adapter must return for the requested ones. */
export function baseMeasures(source: ReportSource, measures: readonly string[]): string[] {
  const derived = DERIVED[source] ?? {};
  const out = new Set<string>();
  for (const m of measures) {
    const d = derived[m];
    if (d === undefined) out.add(m);
    else for (const dep of d.deps) out.add(dep);
  }
  return [...out];
}

export function deriveValues(
  source: ReportSource,
  measures: readonly string[],
  base: Values,
): ReportValues {
  const derived = DERIVED[source] ?? {};
  const out: ReportValues = {};
  for (const m of measures) {
    const d = derived[m];
    out[m] = d === undefined ? (base[m] ?? 0) : d.fn(base);
  }
  return out;
}

function invalid(message: string): CrmError {
  return new CrmError('validation_failed', message);
}

/** Checks measures, dimension and filter against the source spec. */
export function validateDefinition(def: ReportDefinition): void {
  const spec = REPORT_SOURCE_SPECS[def.source];
  for (const m of def.measures) {
    if (!(m in spec.measures)) throw invalid(`measures: ${m} is not a measure of ${def.source}`);
  }
  if (def.dimension !== null && !spec.dimensions.includes(def.dimension)) {
    throw invalid(`dimension: ${def.dimension} is not a dimension of ${def.source}`);
  }
  if (def.filter !== undefined && def.filter.conditions.length > 0 && spec.filter === null) {
    throw invalid(`filter: ${def.source} cannot be filtered by contacts`);
  }
}

/** Applies run-time overrides to a stored definition (re-validated). */
export function applyOverrides(
  def: ReportDefinition,
  overrides: ReportOverrides | undefined,
): ReportDefinition {
  if (overrides === undefined) return def;
  const merged = {
    ...def,
    ...(overrides.date_range === undefined ? {} : { date_range: overrides.date_range }),
    ...(overrides.compare === undefined ? {} : { compare: overrides.compare }),
    ...(overrides.granularity === undefined ? {} : { granularity: overrides.granularity }),
    ...(overrides.dimension === undefined ? {} : { dimension: overrides.dimension }),
    ...(overrides.measures === undefined ? {} : { measures: overrides.measures }),
    ...(overrides.currency === undefined ? {} : { currency: overrides.currency }),
    ...(overrides.timezone === undefined ? {} : { timezone: overrides.timezone }),
    ...(overrides.limit === undefined ? {} : { limit: overrides.limit }),
    ...(overrides.params === undefined ? {} : { params: { ...def.params, ...overrides.params } }),
    ...(overrides.filter === undefined ? {} : { filter: overrides.filter }),
  };
  const parsed = reportDefinitionSchema.safeParse(merged);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? 'invalid overrides');
  return parsed.data;
}

interface Fetched {
  out: AggregateOutput;
  reason: ReportResult['meta']['empty_reason'];
  /** Rows keyed by bucket index (TenantDb/MailDb/Engine date dimension). */
  bucketed: boolean;
}

async function fetchSource(
  ports: ReportPorts,
  def: ReportDefinition,
  days: DayRange,
  buckets: Buckets | null,
  base: string[],
  page: { offset: number; limit: number },
  timeZone: string,
): Promise<Fetched> {
  const target = TARGET[def.source];
  if (target === 'analytics') {
    const out = await queryAnalytics(ports.analytics, {
      tenantId: ports.tenantId,
      source: def.source === 'ad_campaigns' ? 'ad_campaigns' : 'analytics',
      measures: base,
      dimension: def.dimension,
      granularity: def.granularity,
      range: { from: formatDate(days.from), to: formatDate(days.to), timezone: timeZone },
      limit: page.limit,
      params: def.params ?? {},
    });
    const { reason, ...rest } = out;
    return { out: rest, reason: reason ?? null, bucketed: false };
  }
  const out = await ports.aggregate(target, {
    source: def.source,
    measures: base,
    dimension: def.dimension,
    range: rangeMs(days, timeZone),
    buckets: buckets?.bounds ?? null,
    ...(def.filter === undefined ? {} : { filter: def.filter }),
    ...(def.currency === undefined ? {} : { currency: def.currency }),
    limit: page.limit,
    offset: page.offset,
    ...(def.params === undefined ? {} : { params: def.params }),
    now: ports.now(),
  });
  return { out, reason: out.emptyReason ?? null, bucketed: buckets !== null };
}

const USER_DIMENSIONS = new Set(['owner', 'assignee']);

async function shapeRows(
  ports: ReportPorts,
  def: ReportDefinition,
  fetched: Fetched,
  buckets: Buckets | null,
): Promise<ReportRow[]> {
  const { out } = fetched;
  if (fetched.bucketed && buckets !== null) {
    const byIndex = new Map(out.rows.map((r) => [r.key, r.values]));
    return buckets.keys.map((key, i) => ({
      key,
      label: key,
      values: deriveValues(def.source, def.measures, byIndex.get(String(i)) ?? {}),
    }));
  }
  const users =
    def.dimension !== null && USER_DIMENSIONS.has(def.dimension)
      ? await ports.userLabels(out.rows.map((r) => r.key).filter((k) => k !== ''))
      : new Map<string, string>();
  return out.rows.map((r) => ({
    key: r.key,
    label: users.get(r.key) ?? r.label ?? r.key,
    values: deriveValues(def.source, def.measures, r.values),
  }));
}

export interface RunOptions {
  reportId: string | null;
  /** Export pages: offset into the grouped rows and page size (up to 5000). */
  offset?: number;
  pageLimit?: number;
}

export async function runReport(
  ports: ReportPorts,
  def: ReportDefinition,
  options: RunOptions,
): Promise<ReportResult> {
  validateDefinition(def);
  const spec = REPORT_SOURCE_SPECS[def.source];
  const timeZone = def.timezone ?? 'UTC';
  let days: DayRange;
  let buckets: Buckets | null;
  try {
    days = resolveRange(def.date_range, ports.now(), timeZone);
    buckets = def.dimension === 'date' ? buildBuckets(days, def.granularity, timeZone) : null;
  } catch (error) {
    if (error instanceof RangeError) throw invalid(error.message);
    throw error;
  }
  const base = baseMeasures(def.source, def.measures);
  const page = { offset: options.offset ?? 0, limit: options.pageLimit ?? def.limit };
  const main = await fetchSource(ports, def, days, buckets, base, page, timeZone);
  const rows = await shapeRows(ports, def, main, buckets);

  let compare: ReportResult['compare'] = null;
  let compareDays: DayRange | null = null;
  if (!spec.snapshot) compareDays = compareRange(days, def.compare);
  if (compareDays !== null) {
    let compareBuckets: Buckets | null;
    try {
      compareBuckets =
        def.dimension === 'date' ? buildBuckets(compareDays, def.granularity, timeZone) : null;
    } catch (error) {
      if (error instanceof RangeError) throw invalid(error.message);
      throw error;
    }
    const prev = await fetchSource(ports, def, compareDays, compareBuckets, base, page, timeZone);
    const prevRows = await shapeRows(ports, def, prev, compareBuckets);
    const aligned =
      def.dimension === 'date'
        ? prevRows
        : rows.map((r) => {
            const match = prevRows.find((p) => p.key === r.key);
            return (
              match ?? {
                key: r.key,
                label: r.label,
                values: deriveValues(def.source, def.measures, {}),
              }
            );
          });
    compare = { rows: aligned, totals: deriveValues(def.source, def.measures, prev.out.totals) };
  }

  const totals = deriveValues(def.source, def.measures, main.out.totals);
  const hasData = main.out.rows.length > 0 || Object.values(main.out.totals).some((v) => v !== 0);
  return {
    report_id: options.reportId,
    source: def.source,
    measures: def.measures.map((key) => ({ key, kind: spec.measures[key] ?? 'number' })),
    dimension: def.dimension,
    granularity: def.granularity,
    timezone: timeZone,
    range: { from: formatDate(days.from), to: formatDate(days.to) },
    compare_range:
      compareDays === null
        ? null
        : { from: formatDate(compareDays.from), to: formatDate(compareDays.to) },
    currency: main.out.currency,
    rows,
    totals,
    compare,
    meta: {
      currencies: main.out.currencies,
      empty_reason: main.reason ?? (hasData ? null : 'no_data'),
      notes: main.out.notes ?? [],
      options: main.out.options ?? {},
      truncated: main.out.truncated,
    },
  };
}
