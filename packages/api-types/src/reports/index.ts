import { z } from 'zod';
import { filterGroupSchema } from '../crm/search';

/**
 * Report engine REST v2 schemas. A report is a JSON definition (data source,
 * measures, one dimension, contact filter in query-builder JSON, date range,
 * comparison period, bucket granularity, currency) executed by a per-source
 * adapter that aggregates inside the Durable Object owning the data.
 */

// ------------------------------------------------------------------ sources

export const REPORT_SOURCES = [
  'contacts',
  'companies',
  'tags',
  'lead_sources',
  'opportunities',
  'tasks',
  'forms',
  'orders',
  'order_items',
  'payments',
  'refunds',
  'receivables',
  'customers',
  'subscriptions',
  'emails',
  'broadcasts',
  'broadcast_links',
  'automations',
  'automation_nodes',
  'analytics',
  'ad_campaigns',
] as const;
export type ReportSource = (typeof REPORT_SOURCES)[number];

/** How a measure is formatted: money values are integer minor units of `currency`. */
export const MEASURE_KINDS = ['count', 'money', 'ratio', 'number', 'days'] as const;
export type MeasureKind = (typeof MEASURE_KINDS)[number];

export type ReportPermission =
  | 'contacts:read'
  | 'opportunities:read'
  | 'tasks:read'
  | 'forms:read'
  | 'orders:read'
  | 'subscriptions:read'
  | 'broadcasts:read'
  | 'automations:read'
  | 'analytics:read';

export interface ReportSourceSpec {
  /** Module permission needed to read the source (on top of the report permission). */
  readonly permission: ReportPermission;
  /** Sales reports are readable with `reports:sales_read` (sales role). */
  readonly sales: boolean;
  readonly measures: Readonly<Record<string, MeasureKind>>;
  /** `date` buckets by the source's date anchor; the rest are categories. */
  readonly dimensions: readonly string[];
  /** The query-builder filter (on contacts, or companies) is supported. */
  readonly filter: 'contact' | 'company' | null;
  /** Money measures follow one currency (default: the tenant's commerce currency). */
  readonly currency: boolean;
  /** The date range is ignored (snapshot of the current state). */
  readonly snapshot?: boolean;
  /** Extra parameters (`params`) the source understands. */
  readonly params?: readonly string[];
}

const RATES = {
  open_rate: 'ratio',
  click_rate: 'ratio',
  bounce_rate: 'ratio',
  unsubscribe_rate: 'ratio',
} as const;

/** Catalog of sources, measures and dimensions shared by the API and the report builder. */
export const REPORT_SOURCE_SPECS: Readonly<Record<ReportSource, ReportSourceSpec>> = {
  contacts: {
    permission: 'contacts:read',
    sales: false,
    measures: { count: 'count' },
    dimensions: ['date', 'lead_source', 'source_type', 'owner', 'marketable_status', 'utm_source'],
    filter: 'contact',
    currency: false,
  },
  companies: {
    permission: 'contacts:read',
    sales: false,
    measures: { count: 'count' },
    dimensions: ['date', 'owner'],
    filter: 'company',
    currency: false,
  },
  tags: {
    permission: 'contacts:read',
    sales: false,
    measures: { applications: 'count', removals: 'count', contacts: 'count' },
    dimensions: ['date', 'tag'],
    filter: 'contact',
    currency: false,
  },
  lead_sources: {
    permission: 'contacts:read',
    sales: false,
    measures: {
      contacts: 'count',
      customers: 'count',
      revenue: 'money',
      conversion_rate: 'ratio',
      revenue_per_contact: 'money',
    },
    dimensions: ['lead_source', 'utm_source', 'source_type'],
    filter: 'contact',
    currency: true,
  },
  opportunities: {
    permission: 'opportunities:read',
    sales: true,
    measures: {
      count: 'count',
      value: 'money',
      open_count: 'count',
      open_value: 'money',
      weighted_value: 'money',
      won: 'count',
      lost: 'count',
      won_value: 'money',
      win_rate: 'ratio',
      avg_cycle_days: 'days',
      velocity_per_day: 'money',
    },
    dimensions: ['stage', 'pipeline', 'owner', 'status', 'date'],
    filter: 'contact',
    currency: true,
  },
  tasks: {
    permission: 'tasks:read',
    sales: true,
    measures: { created: 'count', completed: 'count', overdue: 'count' },
    dimensions: ['date', 'assignee', 'type', 'priority'],
    filter: 'contact',
    currency: false,
  },
  forms: {
    permission: 'forms:read',
    sales: false,
    measures: { submissions: 'count', contacts: 'count', new_contacts: 'count' },
    dimensions: ['date', 'form', 'utm_source'],
    filter: 'contact',
    currency: false,
  },
  orders: {
    permission: 'orders:read',
    sales: true,
    measures: {
      count: 'count',
      revenue: 'money',
      paid: 'money',
      refunded: 'money',
      net: 'money',
      avg_order_value: 'money',
      customers: 'count',
    },
    dimensions: ['date', 'status', 'source', 'kind', 'owner'],
    filter: 'contact',
    currency: true,
  },
  order_items: {
    permission: 'orders:read',
    sales: true,
    measures: { quantity: 'count', revenue: 'money', orders: 'count' },
    dimensions: ['product', 'date'],
    filter: 'contact',
    currency: true,
  },
  payments: {
    permission: 'orders:read',
    sales: true,
    measures: { count: 'count', amount: 'money', refunded: 'money', net: 'money', failed: 'count' },
    dimensions: ['date', 'method', 'status'],
    filter: 'contact',
    currency: true,
  },
  refunds: {
    permission: 'orders:read',
    sales: true,
    measures: { count: 'count', amount: 'money' },
    dimensions: ['date', 'reason'],
    filter: 'contact',
    currency: true,
  },
  receivables: {
    permission: 'orders:read',
    sales: true,
    measures: { count: 'count', balance: 'money', overdue_balance: 'money' },
    dimensions: ['aging', 'contact'],
    filter: 'contact',
    currency: true,
    snapshot: true,
  },
  customers: {
    permission: 'orders:read',
    sales: true,
    measures: {
      customers: 'count',
      lifetime_value: 'money',
      avg_lifetime_value: 'money',
      orders: 'count',
    },
    dimensions: ['contact', 'date'],
    filter: 'contact',
    currency: true,
  },
  subscriptions: {
    permission: 'subscriptions:read',
    sales: true,
    measures: {
      mrr: 'money',
      arr: 'money',
      active: 'count',
      active_start: 'count',
      new: 'count',
      churned: 'count',
      churn_rate: 'ratio',
      new_mrr: 'money',
      churned_mrr: 'money',
      revenue_churn_rate: 'ratio',
    },
    dimensions: ['date', 'plan', 'product'],
    filter: 'contact',
    currency: true,
  },
  emails: {
    permission: 'broadcasts:read',
    sales: false,
    measures: {
      sent: 'count',
      delivered: 'count',
      opened: 'count',
      clicked: 'count',
      bounced: 'count',
      complained: 'count',
      unsubscribed: 'count',
      ...RATES,
    },
    dimensions: ['date', 'source_type'],
    filter: null,
    currency: false,
  },
  broadcasts: {
    permission: 'broadcasts:read',
    sales: false,
    measures: {
      recipients: 'count',
      sent: 'count',
      delivered: 'count',
      opened: 'count',
      clicked: 'count',
      bounced: 'count',
      unsubscribed: 'count',
      ...RATES,
    },
    dimensions: ['broadcast', 'date'],
    filter: null,
    currency: false,
  },
  broadcast_links: {
    permission: 'broadcasts:read',
    sales: false,
    measures: { clicks: 'count', unique_clicks: 'count' },
    dimensions: ['link'],
    filter: null,
    currency: false,
    params: ['broadcast_id'],
  },
  automations: {
    permission: 'automations:read',
    sales: false,
    measures: {
      entered: 'count',
      completed: 'count',
      failed: 'count',
      removed: 'count',
      active: 'count',
      errors: 'count',
      completion_rate: 'ratio',
    },
    dimensions: ['automation', 'date'],
    filter: null,
    currency: false,
  },
  automation_nodes: {
    permission: 'automations:read',
    sales: false,
    measures: { entered: 'count', completed: 'count', errors: 'count', active: 'count' },
    dimensions: ['node'],
    filter: null,
    currency: false,
    snapshot: true,
    params: ['automation_id'],
  },
  analytics: {
    permission: 'analytics:read',
    sales: false,
    measures: {
      visitors: 'count',
      sessions: 'count',
      pageviews: 'count',
      revenue: 'money',
      conversions: 'number',
      revenue_per_visitor: 'money',
    },
    dimensions: [
      'date',
      'channel',
      'campaign',
      'referrer',
      'source',
      'utm_source',
      'utm_medium',
      'utm_term',
      'utm_content',
      'entry_page',
    ],
    filter: null,
    currency: true,
    params: ['site_id', 'model'],
  },
  ad_campaigns: {
    permission: 'analytics:read',
    sales: false,
    measures: {
      spend: 'money',
      revenue: 'money',
      roas: 'number',
      clicks: 'count',
      impressions: 'count',
      customers: 'count',
      cost_per_acquisition: 'money',
    },
    dimensions: ['campaign'],
    filter: null,
    currency: true,
    params: ['site_id', 'model'],
  },
};

// --------------------------------------------------------------- definition

export const DATE_PRESETS = [
  'today',
  'last_7_days',
  'last_30_days',
  'last_90_days',
  'this_month',
  'last_month',
  'this_quarter',
  'this_year',
  'last_year',
  'last_12_months',
  'all_time',
] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

/** A preset, or explicit local days (`to` included) in the report time zone. */
export const reportDateRangeSchema = z
  .strictObject({
    preset: z.enum(DATE_PRESETS).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
  })
  .refine((r) => r.preset !== undefined || (r.from !== undefined && r.to !== undefined), {
    message: 'either preset or from + to is required',
  });
export type ReportDateRange = z.infer<typeof reportDateRangeSchema>;

export const COMPARE_MODES = ['none', 'previous_period', 'previous_year'] as const;
export type CompareMode = (typeof COMPARE_MODES)[number];
export const GRANULARITIES = ['day', 'week', 'month'] as const;
export type Granularity = (typeof GRANULARITIES)[number];
export const CHART_TYPES = ['kpi', 'line', 'bar', 'table', 'funnel'] as const;
export type ChartType = (typeof CHART_TYPES)[number];

const paramKey = z.string().regex(/^[a-z_]{1,32}$/);
const timezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'unknown time zone');

export const reportDefinitionSchema = z.strictObject({
  source: z.enum(REPORT_SOURCES),
  measures: z.array(z.string().min(1).max(40)).min(1).max(8),
  dimension: z.string().min(1).max(40).nullable().default(null),
  granularity: z.enum(GRANULARITIES).default('month'),
  /** Query-builder filter on the contacts (or companies) behind the records. */
  filter: filterGroupSchema.optional(),
  date_range: reportDateRangeSchema.default({ preset: 'last_12_months' }),
  compare: z.enum(COMPARE_MODES).default('none'),
  /** ISO 4217; default: the tenant's commerce currency (or the analytics site currency). */
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  /** IANA zone of the date buckets (default UTC). */
  timezone: timezoneSchema.optional(),
  limit: z.number().int().min(1).max(500).default(100),
  params: z.record(paramKey, z.string().max(200)).optional(),
});
export type ReportDefinitionInput = z.input<typeof reportDefinitionSchema>;
export type ReportDefinition = z.infer<typeof reportDefinitionSchema>;

/** Per-run overrides of a stored definition (widgets, UI toolbar, export). */
export const reportOverridesSchema = z.strictObject({
  date_range: reportDateRangeSchema.optional(),
  compare: z.enum(COMPARE_MODES).optional(),
  granularity: z.enum(GRANULARITIES).optional(),
  dimension: z.string().min(1).max(40).nullable().optional(),
  measures: z.array(z.string().min(1).max(40)).min(1).max(8).optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  timezone: timezoneSchema.optional(),
  limit: z.number().int().min(1).max(500).optional(),
  params: z.record(paramKey, z.string().max(200)).optional(),
  /** Replaces the stored contact filter (the runner shows the effective one). */
  filter: filterGroupSchema.optional(),
});
export type ReportOverrides = z.infer<typeof reportOverridesSchema>;

export const runAdHocReportSchema = z.strictObject({ definition: reportDefinitionSchema });

// ------------------------------------------------------------------- result

export const reportValuesSchema = z.record(z.string(), z.number().nullable());
export type ReportValues = z.infer<typeof reportValuesSchema>;

export const reportRowSchema = z.object({
  key: z.string(),
  label: z.string(),
  values: reportValuesSchema,
});
export type ReportRow = z.infer<typeof reportRowSchema>;

const rangeOut = z.object({ from: z.string(), to: z.string() });

export const REPORT_EMPTY_REASONS = [
  'no_data',
  'source_unavailable',
  'analytics_unavailable',
  'no_sites',
  'attribution_unavailable',
  'param_required',
] as const;

export const reportResultSchema = z.object({
  report_id: z.string().nullable(),
  source: z.enum(REPORT_SOURCES),
  measures: z.array(z.object({ key: z.string(), kind: z.enum(MEASURE_KINDS) })),
  dimension: z.string().nullable(),
  granularity: z.enum(GRANULARITIES),
  timezone: z.string(),
  /** Local days, `to` included. */
  range: rangeOut,
  compare_range: rangeOut.nullable(),
  currency: z.string().nullable(),
  rows: z.array(reportRowSchema),
  totals: reportValuesSchema,
  /** Same keys as `rows` (date buckets aligned by position). */
  compare: z.object({ rows: z.array(reportRowSchema), totals: reportValuesSchema }).nullable(),
  meta: z.object({
    /** Other currencies with data in the range (money measures cover only `currency`). */
    currencies: z.array(z.string()),
    empty_reason: z.enum(REPORT_EMPTY_REASONS).nullable(),
    notes: z.array(z.string()),
    /** Choices for source parameters (sites, broadcasts, automations). */
    options: z.record(z.string(), z.array(z.object({ value: z.string(), label: z.string() }))),
    /** True when more rows exist past `limit` (export streams them all). */
    truncated: z.boolean(),
  }),
});
export type ReportResult = z.infer<typeof reportResultSchema>;

// ------------------------------------------------------------------ catalog

export const REPORT_CATEGORIES = [
  'sales',
  'subscriptions',
  'marketing',
  'automation',
  'crm',
  'pipeline',
  'attribution',
] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

export const reportCatalogEntrySchema = z.object({
  id: z.string(),
  kind: z.enum(['builtin', 'custom']),
  category: z.enum(REPORT_CATEGORIES),
  name: z.string(),
  description: z.string(),
  chart: z.enum(CHART_TYPES),
  definition: reportDefinitionSchema,
  /** Custom reports only. */
  shared: z.boolean().optional(),
  owner_id: z.string().nullable().optional(),
});
export type ReportCatalogEntry = z.infer<typeof reportCatalogEntrySchema>;

// ----------------------------------------------------------- custom reports

export const customReportSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  definition: reportDefinitionSchema,
  chart: z.enum(CHART_TYPES),
  shared: z.boolean(),
  owner_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type CustomReport = z.infer<typeof customReportSchema>;

export const createCustomReportSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  definition: reportDefinitionSchema,
  chart: z.enum(CHART_TYPES).default('table'),
  shared: z.boolean().default(true),
});
export type CreateCustomReportInput = z.input<typeof createCustomReportSchema>;

export const updateCustomReportSchema = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  definition: reportDefinitionSchema.optional(),
  chart: z.enum(CHART_TYPES).optional(),
  shared: z.boolean().optional(),
});
export type UpdateCustomReportInput = z.input<typeof updateCustomReportSchema>;

// --------------------------------------------------------------- dashboards

export const GRID_COLUMNS = 12;

export const widgetLayoutSchema = z.strictObject({
  x: z
    .number()
    .int()
    .min(0)
    .max(GRID_COLUMNS - 1),
  y: z.number().int().min(0).max(1000),
  w: z.number().int().min(1).max(GRID_COLUMNS),
  h: z.number().int().min(1).max(12),
});
export type WidgetLayout = z.infer<typeof widgetLayoutSchema>;

export const dashboardWidgetSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  type: z.enum(CHART_TYPES),
  title: z.string().trim().max(200).nullable().default(null),
  /** Built-in report id or custom report id. */
  report_id: z.string().min(1).max(64),
  /** Measures shown (default: the report's first measure; funnels use them as stages). */
  measures: z.array(z.string().min(1).max(40)).max(8).optional(),
  overrides: reportOverridesSchema.optional(),
  layout: widgetLayoutSchema,
});
export type DashboardWidget = z.infer<typeof dashboardWidgetSchema>;
export type DashboardWidgetInput = z.input<typeof dashboardWidgetSchema>;

export const dashboardSchema = z.object({
  id: z.string(),
  name: z.string(),
  shared: z.boolean(),
  /** The tenant home page shows the default shared dashboard. */
  is_default: z.boolean(),
  owner_id: z.string().nullable(),
  widgets: z.array(dashboardWidgetSchema),
  /** Built-in fallback (not stored) when no default dashboard exists. */
  builtin: z.boolean(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
});
export type Dashboard = z.infer<typeof dashboardSchema>;

export const createDashboardSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  shared: z.boolean().default(false),
  is_default: z.boolean().default(false),
  widgets: z.array(dashboardWidgetSchema).max(30).default([]),
});
export type CreateDashboardInput = z.input<typeof createDashboardSchema>;

export const updateDashboardSchema = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  shared: z.boolean().optional(),
  is_default: z.boolean().optional(),
  widgets: z.array(dashboardWidgetSchema).max(30).optional(),
});
export type UpdateDashboardInput = z.input<typeof updateDashboardSchema>;
