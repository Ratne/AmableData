import { z } from 'zod';

/** Revenue attribution models (see `apps/edge/src/analytics/store/attribution.ts`). */
export const ATTRIBUTION_MODELS = [
  'first_touch',
  'last_touch',
  'last_non_direct',
  'linear',
  'position_based',
] as const;
export type AttributionModel = (typeof ATTRIBUTION_MODELS)[number];

/**
 * Web analytics base contracts: the tracker/server ingest protocol (apps/edge `POST /e`),
 * site configuration and the query API (REST v2 `/analytics/*`, AnalyticsDO RPC).
 */

// ---------------------------------------------------------------------- ingest

export const ANALYTICS_EVENT_TYPES = [
  'pageview',
  'goal',
  'identify',
  'payment',
  'external_link',
] as const;
export type AnalyticsEventType = (typeof ANALYTICS_EVENT_TYPES)[number];

export const CLICK_ID_NAMES = [
  'gclid',
  'fbclid',
  'msclkid',
  'ttclid',
  'twclid',
  'li_fat_id',
  'wbraid',
  'gbraid',
] as const;
export type ClickIdName = (typeof CLICK_ID_NAMES)[number];

export const SOURCE_PARAM_NAMES = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'ref',
  'source',
  'via',
] as const;

const trackerIdSchema = z.string().regex(/^[A-Za-z0-9-]{8,64}$/);
const contextIdSchema = z.string().regex(/^[\w-]{1,64}$/);
const extraValueSchema = z.union([z.string().max(1024), z.number().finite(), z.boolean()]);

function boundedRecord<T extends z.ZodType>(value: T, maxKeys: number) {
  return z
    .record(z.string().max(64), value)
    .refine((r) => Object.keys(r).length <= maxKeys, `at most ${maxKeys} keys`);
}

/** Body of `POST /e` sent by the browser tracker (protocol v1). Unknown keys are dropped. */
export const trackerEventSchema = z.object({
  type: z.enum(ANALYTICS_EVENT_TYPES),
  site: z.string().min(1).max(64),
  url: z.string().min(1).max(2048),
  ref: z.string().max(2048).optional(),
  vw: z.number().int().min(0).max(100_000).optional(),
  vh: z.number().int().min(0).max(100_000).optional(),
  sw: z.number().int().min(0).max(100_000).optional(),
  sh: z.number().int().min(0).max(100_000).optional(),
  lang: z.string().max(35).optional(),
  tz: z.string().max(64).optional(),
  vid: trackerIdSchema.optional(),
  sid: trackerIdSchema.optional(),
  fs: z.number().int().nonnegative().optional(),
  sn: z.number().int().min(1).max(1_000_000).optional(),
  cl: z.literal(1).optional(),
  clk: boundedRecord(z.string().max(255), 8).optional(),
  src: boundedRecord(z.string().max(255), 8).optional(),
  name: z.string().max(64).optional(),
  data: boundedRecord(extraValueSchema, 20).optional(),
  /** Signed contact token (`_amb_c` of an email click), sent once with the landing pageview. */
  ct: z.string().max(4096).optional(),
  /** Funnel context of the session: funnel, traffic source, node, page and funnel visitor id. */
  dl: z
    .object({
      f: contextIdSchema.optional(),
      ts: contextIdSchema.optional(),
      n: contextIdSchema.optional(),
      p: contextIdSchema.optional(),
      vid: contextIdSchema.optional(),
    })
    .optional()
    .catch(undefined),
  /** Email/SMS link params of the landing URL (first pageview only). */
  la: z
    .object({
      /** Lower-cased email or SHA-256 hex. */
      he: z.string().max(320).optional(),
      sl: z.string().max(128).optional(),
      el: z.string().max(128).optional(),
    })
    .optional()
    .catch(undefined),
});
export type TrackerEvent = z.infer<typeof trackerEventSchema>;

const goalNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_]{1,64}$/, 'goal names use a-z, 0-9 and _ (max 64)');
const goalParamsSchema = boundedRecord(
  z.union([z.string().max(255), z.number().finite(), z.boolean()]),
  10,
);
const currencySchema = z
  .string()
  .regex(/^[A-Za-z]{3}$/, 'ISO 4217 code')
  .transform((s) => s.toUpperCase());

/**
 * Body of `POST /e/server` (server SDKs: goals, payments, identify, server-side
 * pageviews and crawler hits). Authenticated with the site secret.
 */
export const serverEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('goal'),
    visitor_id: trackerIdSchema,
    name: goalNameSchema,
    url: z.string().max(2048).optional(),
    params: goalParamsSchema.optional(),
  }),
  z.object({
    type: z.literal('payment'),
    visitor_id: trackerIdSchema.optional(),
    amount: z.number().finite().nonnegative(),
    currency: currencySchema,
    transaction_id: z.string().min(1).max(255),
    email: z.string().email().max(320).optional(),
    customer_id: z.string().max(255).optional(),
    renewal: z.boolean().optional(),
    refunded: z.boolean().optional(),
    is_free_trial: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('identify'),
    visitor_id: trackerIdSchema,
    user_id: z.string().min(1).max(255),
    email: z.string().email().max(320).optional(),
    name: z.string().max(255).optional(),
    traits: goalParamsSchema.optional(),
  }),
  z.object({
    type: z.literal('pageview'),
    url: z.string().min(1).max(2048),
    user_agent: z.string().max(1024),
    ip: z.string().max(64),
    referrer: z.string().max(2048).optional(),
    visitor_id: trackerIdSchema.optional(),
  }),
  z.object({
    type: z.literal('crawler'),
    url: z.string().min(1).max(2048),
    user_agent: z.string().max(1024),
    ip: z.string().max(64).optional(),
  }),
]);
export type ServerEvent = z.infer<typeof serverEventSchema>;

// ----------------------------------------------------------------------- sites

const hostnameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    'invalid hostname',
  );

const timezoneSchema = z
  .string()
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'unknown IANA time zone');

/** Days of raw data kept in the AnalyticsDO (older rows are archived to R2); 0 = forever. */
const retentionSchema = z
  .number()
  .int()
  .refine((d) => d === 0 || (d >= 30 && d <= 3650), '0 or 30..3650');

export const siteSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Hostnames allowed to send events; each also covers its subdomains. */
  hostnames: z.array(z.string()),
  cookieless: z.boolean(),
  allow_localhost: z.boolean(),
  timezone: z.string(),
  currency: z.string(),
  retention_days: z.number().int(),
  /** Default attribution model of the dashboard. */
  attribution_model: z.enum(ATTRIBUTION_MODELS),
  has_secret: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Site = z.infer<typeof siteSchema>;

export const createSiteSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  hostnames: z.array(hostnameSchema).min(1).max(20),
  cookieless: z.boolean().default(false),
  allow_localhost: z.boolean().default(false),
  timezone: timezoneSchema.default('UTC'),
  currency: currencySchema.default('EUR'),
  retention_days: retentionSchema.default(395),
  attribution_model: z.enum(ATTRIBUTION_MODELS).default('last_non_direct'),
});
export type CreateSiteInput = z.infer<typeof createSiteSchema>;

export const updateSiteSchema = z.strictObject({
  name: z.string().trim().min(1).max(100).optional(),
  hostnames: z.array(hostnameSchema).min(1).max(20).optional(),
  cookieless: z.boolean().optional(),
  allow_localhost: z.boolean().optional(),
  timezone: timezoneSchema.optional(),
  currency: currencySchema.optional(),
  retention_days: retentionSchema.optional(),
  attribution_model: z.enum(ATTRIBUTION_MODELS).optional(),
});
export type UpdateSiteInput = z.infer<typeof updateSiteSchema>;

export const siteSnippetSchema = z.object({
  site_id: z.string(),
  /** Recommended `<script>` tag (with the pre-load queue stub). */
  html: z.string(),
  scripts: z.object({ default: z.string(), cookieless: z.string(), hash: z.string() }),
  /** Endpoint for server SDKs (Bearer site secret). */
  server_endpoint: z.string(),
});
export type SiteSnippet = z.infer<typeof siteSnippetSchema>;

export const siteWithSecretSchema = z.object({
  site: siteSchema,
  /** Site secret for `POST /e/server` — shown once. */
  secret: z.string(),
  snippet: siteSnippetSchema,
});
export type SiteWithSecret = z.infer<typeof siteWithSecretSchema>;

// ----------------------------------------------------------------------- query

/** Session-level dimensions (filterable and breakable). */
export const ANALYTICS_SESSION_DIMENSIONS = [
  'channel',
  'referrer',
  'source',
  'campaign',
  'utm_source',
  'utm_medium',
  'utm_term',
  'utm_content',
  'country',
  'region',
  'city',
  'device',
  'browser',
  'os',
  'hostname',
  'entry_page',
  'exit_page',
] as const;

export const ANALYTICS_FILTER_DIMENSIONS = [
  ...ANALYTICS_SESSION_DIMENSIONS,
  'page',
  'goal',
] as const;
export type AnalyticsFilterDimension = (typeof ANALYTICS_FILTER_DIMENSIONS)[number];

export const ANALYTICS_BREAKDOWN_DIMENSIONS = [
  ...ANALYTICS_SESSION_DIMENSIONS,
  'page',
  'goal',
  'exit_link',
  'bot',
  'bot_category',
] as const;
export type AnalyticsBreakdownDimension = (typeof ANALYTICS_BREAKDOWN_DIMENSIONS)[number];

export const ANALYTICS_INTERVALS = ['hour', 'day', 'week', 'month'] as const;
export type AnalyticsInterval = (typeof ANALYTICS_INTERVALS)[number];

export const analyticsFilterSchema = z.object({
  dimension: z.enum(ANALYTICS_FILTER_DIMENSIONS),
  op: z.enum(['is', 'is_not', 'contains']),
  value: z.string().max(255),
});
export type AnalyticsFilter = z.infer<typeof analyticsFilterSchema>;

/** Date (YYYY-MM-DD, in the query time zone) or ISO date-time. */
const rangeBoundSchema = z.union([
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  z.iso.datetime({ offset: true }),
]);

/** Range + filters of every analytics query (DO RPC input). `to` dates are inclusive. */
export const analyticsRangeSchema = z.object({
  from: rangeBoundSchema,
  to: rangeBoundSchema,
  timezone: timezoneSchema.optional(),
  filters: z.array(analyticsFilterSchema).max(20).default([]),
});
export type AnalyticsRange = z.input<typeof analyticsRangeSchema>;

export const analyticsOverviewSchema = z.object({
  from: z.string(),
  to: z.string(),
  timezone: z.string(),
  visitors: z.number().int(),
  sessions: z.number().int(),
  pageviews: z.number().int(),
  views_per_session: z.number(),
  bounce_rate: z.number(),
  avg_session_duration_ms: z.number(),
  goals: z.number().int(),
  /** Visitors who completed any goal (goal conversion). */
  conversions: z.number().int(),
  conversion_rate: z.number(),
  /** Visitors with a purchase (free trials excluded) and their share of visitors. */
  customers: z.number().int(),
  purchase_conversion_rate: z.number(),
  revenue_minor: z.number().int(),
  revenue_per_visitor_minor: z.number(),
  currency: z.string(),
  online: z.number().int(),
});
export type AnalyticsOverview = z.infer<typeof analyticsOverviewSchema>;

export const analyticsPointSchema = z.object({
  /** Bucket start (ISO, UTC) and local label in the query time zone. */
  t: z.string(),
  label: z.string(),
  visitors: z.number().int(),
  sessions: z.number().int(),
  pageviews: z.number().int(),
  bounce_rate: z.number(),
  goals: z.number().int(),
  revenue_minor: z.number().int(),
});
export type AnalyticsPoint = z.infer<typeof analyticsPointSchema>;

export const analyticsTimeseriesSchema = z.object({
  interval: z.enum(ANALYTICS_INTERVALS),
  timezone: z.string(),
  /** `rollup` when served from the hourly/daily rollups, `raw` otherwise. */
  source: z.enum(['rollup', 'raw']),
  points: z.array(analyticsPointSchema),
});
export type AnalyticsTimeseries = z.infer<typeof analyticsTimeseriesSchema>;

export const analyticsBreakdownRowSchema = z.object({
  value: z.string().nullable(),
  visitors: z.number().int(),
  sessions: z.number().int().optional(),
  pageviews: z.number().int().optional(),
  bounce_rate: z.number().optional(),
  avg_session_duration_ms: z.number().optional(),
  completions: z.number().int().optional(),
  hits: z.number().int().optional(),
  revenue_minor: z.number().int().optional(),
  /** Attributed customers (fractional with the linear model) — source dimensions only. */
  conversions: z.number().optional(),
});
export type AnalyticsBreakdownRow = z.infer<typeof analyticsBreakdownRowSchema>;

export const analyticsBreakdownSchema = z.object({
  dimension: z.enum(ANALYTICS_BREAKDOWN_DIMENSIONS),
  /** Attribution model used for `revenue_minor` / `conversions` of source dimensions. */
  model: z.enum(ATTRIBUTION_MODELS).optional(),
  rows: z.array(analyticsBreakdownRowSchema),
});
export type AnalyticsBreakdown = z.infer<typeof analyticsBreakdownSchema>;

/**
 * REST query string of `/analytics/{overview,timeseries,breakdown/*}`. Filters use
 * `filter_<dimension>=<value>` (is), `filter_<dimension>=!<value>` (is not) and
 * `filter_<dimension>=~<value>` (contains). Defaults: the last 7 days.
 */
export const analyticsQueryParamsSchema = z.looseObject({
  site_id: z.string().min(1).max(64),
  from: rangeBoundSchema.optional(),
  to: rangeBoundSchema.optional(),
  timezone: timezoneSchema.optional(),
});
export type AnalyticsQueryParams = z.infer<typeof analyticsQueryParamsSchema>;

export const analyticsTimeseriesParamsSchema = analyticsQueryParamsSchema.extend({
  interval: z.enum(ANALYTICS_INTERVALS).default('day'),
});

export const analyticsBreakdownParamsSchema = analyticsQueryParamsSchema.extend({
  limit: z.coerce.number().int().min(1).max(1000).default(50),
  /** Attribution model for source dimensions (default: the site's). */
  model: z.enum(ATTRIBUTION_MODELS).optional(),
});
