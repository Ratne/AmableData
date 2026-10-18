import { z } from 'zod';
import { AD_PLATFORMS } from './ads';

/**
 * Ad attribution reports computed from the funnel click-log (touches), ad
 * spend and attributed conversions: performance per source / campaign / adset
 * / ad, lifetime value windows, cohorts and aggregated journeys.
 */

/**
 * Attribution models of the ad reports. `windowed_hybrid` credits the first
 * click when it happened within `window_days` of the conversion, the last click
 * otherwise. The legacy site models live in `base.ts` (`ATTRIBUTION_MODELS`).
 */
export const ATTRIBUTION_MODELS_V2 = [
  'first_click',
  'last_click',
  'linear',
  'u_shaped',
  'time_decay',
  'windowed_hybrid',
] as const;
export type AttributionModelV2 = (typeof ATTRIBUTION_MODELS_V2)[number];

export const DEFAULT_ATTRIBUTION_MODEL_V2: AttributionModelV2 = 'last_click';
export const DEFAULT_ATTRIBUTION_WINDOW_DAYS = 7;
/** Half-life of `time_decay`. */
export const TIME_DECAY_HALF_LIFE_DAYS = 7;
/** Shares of first / middle / last touches in `u_shaped`. */
export const U_SHAPED_WEIGHTS = { first: 0.4, middle: 0.2, last: 0.4 } as const;

export const attributionWindowDaysSchema = z.coerce.number().int().min(1).max(30);

export const PERFORMANCE_GROUP_BY = [
  'platform',
  'source',
  'campaign',
  'adset',
  'ad',
  'day',
  'funnel',
  'node',
  'country',
  'device',
] as const;
export type PerformanceGroupBy = (typeof PERFORMANCE_GROUP_BY)[number];

/** Date a conversion is reported on: the click that earned it or the sale itself. */
export const REPORT_BASIS = ['click_date', 'sale_date'] as const;
export type ReportBasis = (typeof REPORT_BASIS)[number];

const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const reportRangeShape = {
  site_id: z.string().min(1).max(64),
  from: daySchema,
  to: daySchema,
  timezone: z.string().max(64).optional(),
};

export const performanceFilterSchema = z.object({
  dimension: z.enum(PERFORMANCE_GROUP_BY),
  value: z.string().max(255),
});
export type PerformanceFilter = z.infer<typeof performanceFilterSchema>;

export const performanceQuerySchema = z.object({
  ...reportRangeShape,
  model: z.enum(ATTRIBUTION_MODELS_V2).default(DEFAULT_ATTRIBUTION_MODEL_V2),
  window_days: attributionWindowDaysSchema.default(DEFAULT_ATTRIBUTION_WINDOW_DAYS),
  group_by: z.enum(PERFORMANCE_GROUP_BY).default('source'),
  basis: z.enum(REPORT_BASIS).default('click_date'),
  platform: z.enum(AD_PLATFORMS).optional(),
  traffic_source_id: z.string().max(64).optional(),
  funnel_id: z.string().max(64).optional(),
  /** Drill-down: rows restricted to children of these values. */
  filters: z.array(performanceFilterSchema).max(10).default([]),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});
export type PerformanceQuery = z.input<typeof performanceQuerySchema>;
export type PerformanceQueryParsed = z.infer<typeof performanceQuerySchema>;

export const performanceRowSchema = z.object({
  key: z.string().nullable(),
  label: z.string().nullable(),
  /** Parent value for hierarchical views (adset → campaign, ad → adset). */
  parent_key: z.string().nullable(),
  visits: z.number().int(),
  clicks: z.number().int(),
  cost_minor: z.number().int(),
  /** Attributed revenue of the selected model (first purchases + renewals). */
  revenue_minor: z.number().int(),
  /** All revenue of the attributed customers in the range. */
  total_revenue_minor: z.number().int(),
  profit_minor: z.number().int(),
  /** Profit minus hard costs / COGS / taxes recorded on the CRM payments. */
  net_profit_minor: z.number().int(),
  /** Revenue / cost; null without cost. */
  roas: z.number().nullable(),
  /** Profit / cost; null without cost. */
  roi: z.number().nullable(),
  /** Credited sales (fractional with the multi-touch models). */
  sales: z.number(),
  leads: z.number(),
  new_leads: z.number(),
  returning_customers: z.number(),
  aov_minor: z.number().nullable(),
  cpa_minor: z.number().nullable(),
  cvr: z.number().nullable(),
  reported_conversions: z.number().nullable(),
  reported_revenue_minor: z.number().int().nullable(),
  /** `revenue_minor - reported_revenue_minor` (null without platform data). */
  reported_vs_revenue_minor: z.number().int().nullable(),
});
export type PerformanceRow = z.infer<typeof performanceRowSchema>;

export const performanceReportSchema = z.object({
  model: z.enum(ATTRIBUTION_MODELS_V2),
  window_days: z.number().int(),
  group_by: z.enum(PERFORMANCE_GROUP_BY),
  basis: z.enum(REPORT_BASIS),
  currency: z.string(),
  totals: performanceRowSchema,
  rows: z.array(performanceRowSchema),
});
export type PerformanceReport = z.infer<typeof performanceReportSchema>;

// ------------------------------------------------------------------------- LTV

export const LTV_WINDOWS = [30, 60, 90, 180, 365] as const;
export type LtvWindow = (typeof LTV_WINDOWS)[number];

export const ltvQuerySchema = z.object({
  ...reportRangeShape,
  group_by: z.enum(['source', 'campaign', 'platform']).default('source'),
  model: z.enum(['first_click', 'last_click']).default('first_click'),
});
export type LtvQuery = z.input<typeof ltvQuerySchema>;

export const ltvRowSchema = z.object({
  key: z.string().nullable(),
  label: z.string().nullable(),
  customers: z.number().int(),
  cost_minor: z.number().int(),
  /** Revenue per customer within N days of the join date, keyed by window (`"30"`…). */
  ltv_minor: z.record(z.string(), z.number()),
  revenue_minor: z.record(z.string(), z.number().int()),
});
export type LtvRow = z.infer<typeof ltvRowSchema>;

export const ltvReportSchema = z.object({
  currency: z.string(),
  windows: z.array(z.number().int()),
  rows: z.array(ltvRowSchema),
});
export type LtvReport = z.infer<typeof ltvReportSchema>;

// ---------------------------------------------------------------------- cohort

export const COHORT_OFFSETS = [0, 30, 60, 90] as const;

export const cohortQuerySchema = z.object({
  ...reportRangeShape,
  granularity: z.enum(['week', 'month']).default('month'),
  traffic_source_id: z.string().max(64).optional(),
  platform: z.enum(AD_PLATFORMS).optional(),
});
export type CohortQuery = z.input<typeof cohortQuerySchema>;

export const cohortRowSchema = z.object({
  /** Cohort start day (`YYYY-MM-DD`, first click of the customers). */
  cohort: z.string(),
  customers: z.number().int(),
  cost_minor: z.number().int(),
  /** Cumulative revenue at each offset in days, keyed by offset (`"0"`, `"30"`…). */
  revenue_minor: z.record(z.string(), z.number().int()),
  roi: z.record(z.string(), z.number().nullable()),
});
export type CohortRow = z.infer<typeof cohortRowSchema>;

export const cohortReportSchema = z.object({
  currency: z.string(),
  granularity: z.enum(['week', 'month']),
  offsets: z.array(z.number().int()),
  rows: z.array(cohortRowSchema),
});
export type CohortReport = z.infer<typeof cohortReportSchema>;

// --------------------------------------------------------------------- journey

export const JOURNEY_MAX_STEPS = 30;

export const journeyQuerySchema = z.object({
  ...reportRangeShape,
  /** Step granularity: traffic source, campaign or funnel node. */
  step: z.enum(['source', 'campaign', 'node']).default('source'),
  converted_only: z.union([z.boolean(), z.stringbool()]).default(false),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});
export type JourneyQuery = z.input<typeof journeyQuerySchema>;

export const journeyRowSchema = z.object({
  steps: z.array(z.string()).max(JOURNEY_MAX_STEPS),
  visitors: z.number().int(),
  conversions: z.number().int(),
  revenue_minor: z.number().int(),
  avg_days_to_convert: z.number().nullable(),
});
export type JourneyRow = z.infer<typeof journeyRowSchema>;

export const journeyReportSchema = z.object({
  currency: z.string(),
  rows: z.array(journeyRowSchema),
});
export type JourneyReport = z.infer<typeof journeyReportSchema>;

// ------------------------------------------------------------- tracking quality

/** Share of conversions with a resolved identity / click id (0..1 each). */
export const trackingQualitySchema = z.object({
  conversions: z.number().int(),
  with_identity: z.number().int(),
  with_click_id: z.number().int(),
  with_touch: z.number().int(),
  score: z.number(),
});
export type TrackingQuality = z.infer<typeof trackingQualitySchema>;
