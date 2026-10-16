import { z } from 'zod';
import {
  analyticsFilterSchema,
  analyticsQueryParamsSchema,
  ATTRIBUTION_MODELS,
  type AttributionModel,
} from './base';

/**
 * Web analytics, second wave: attribution, purchases, realtime, insights,
 * visitors and contact journeys, funnels, segments, goal alerts, share links,
 * site keys, ad/search integrations, bots and conversion prediction.
 * Everything here is served by REST v2 `/api/v2/t/{slug}/analytics/*` and,
 * for site keys, by `/api/v2/analytics/*`.
 */

// ----------------------------------------------------------------- attribution

export const DEFAULT_ATTRIBUTION_MODEL: AttributionModel = 'last_non_direct';

/** Source dimensions whose revenue is credited with an attribution model. */
export const ATTRIBUTION_DIMENSIONS = [
  'channel',
  'referrer',
  'source',
  'campaign',
  'utm_source',
  'utm_medium',
  'utm_term',
  'utm_content',
  /** Landing page of the touch session. */
  'entry_page',
] as const;
export type AttributionDimension = (typeof ATTRIBUTION_DIMENSIONS)[number];

export const attributionModelParamSchema = z.object({
  model: z.enum(ATTRIBUTION_MODELS).optional(),
});

export const attributionQuerySchema = z.object({
  dimension: z.enum(ATTRIBUTION_DIMENSIONS).optional(),
  /** Comma separated subset of the models (default: all). */
  models: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

export const attributedValueSchema = z.object({
  model: z.enum(ATTRIBUTION_MODELS),
  /** Integer minor units; the shares of one payment always add up to its amount. */
  revenue_minor: z.number().int(),
  /** Credited conversions (fractional with the multi-touch models). */
  conversions: z.number(),
});

/**
 * Revenue of the range credited to the values of one source dimension, side
 * by side for several attribution models. `value: null` collects payments
 * without any recorded touch (only without filters).
 */
export const attributionReportSchema = z.object({
  dimension: z.enum(ATTRIBUTION_DIMENSIONS),
  currency: z.string(),
  models: z.array(z.enum(ATTRIBUTION_MODELS)),
  default_model: z.enum(ATTRIBUTION_MODELS),
  total_revenue_minor: z.number().int(),
  total_conversions: z.number().int(),
  rows: z.array(
    z.object({
      value: z.string().nullable(),
      credits: z.array(attributedValueSchema),
    }),
  ),
});
export type AttributionReport = z.infer<typeof attributionReportSchema>;

/** First / last non-direct touch of a person (null fields when unknown). */
export const touchSchema = z.object({
  ts: z.string(),
  channel: z.string(),
  source: z.string().nullable(),
  referrer_host: z.string().nullable(),
  campaign: z.string().nullable(),
});
export type Touch = z.infer<typeof touchSchema>;

export const timeToConversionSchema = z.object({
  first_seen: z.string().nullable(),
  first_purchase_at: z.string().nullable(),
  /** Sessions up to and including the one of the first purchase. */
  sessions_before_purchase: z.number().int().nullable(),
  days_to_purchase: z.number().nullable(),
  hours_to_purchase: z.number().nullable(),
});
export type TimeToConversion = z.infer<typeof timeToConversionSchema>;

// ------------------------------------------------------------------- purchases

export const analyticsPurchaseSchema = z.object({
  transaction_id: z.string(),
  ts: z.string(),
  /** Local day (site / query time zone) — used to place avatars on the chart. */
  label: z.string(),
  amount_minor: z.number().int(),
  refunded_minor: z.number().int(),
  currency: z.string(),
  renewal: z.boolean(),
  /** `crm` (orders of this CRM), `tracker` or `server` (sent by the site). */
  source: z.enum(['crm', 'tracker', 'server']),
  order_id: z.string().nullable(),
  visitor_id: z.string().nullable(),
  contact_id: z.string().nullable(),
  name: z.string().nullable(),
  email: z.string().nullable(),
});
export type AnalyticsPurchase = z.infer<typeof analyticsPurchaseSchema>;

export const analyticsPurchasesSchema = z.object({
  currency: z.string(),
  data: z.array(analyticsPurchaseSchema),
});
export type AnalyticsPurchases = z.infer<typeof analyticsPurchasesSchema>;

export const analyticsPurchasesParamsSchema = analyticsQueryParamsSchema.extend({
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

// -------------------------------------------------------------------- realtime

export const REALTIME_WINDOW_MINUTES = 30;

export const realtimeVisitorSchema = z.object({
  visitor_id: z.string(),
  session_id: z.string(),
  country: z.string().nullable(),
  region: z.string().nullable(),
  city: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  page: z.string().nullable(),
  hostname: z.string().nullable(),
  referrer_host: z.string().nullable(),
  channel: z.string(),
  device: z.string().nullable(),
  browser: z.string().nullable(),
  os: z.string().nullable(),
  started_at: z.string(),
  last_seen: z.string(),
  pageviews: z.number().int(),
  revenue_minor: z.number().int(),
  /** Identified visitors only (never in public share links). */
  name: z.string().nullable(),
  contact_id: z.string().nullable(),
});
export type RealtimeVisitor = z.infer<typeof realtimeVisitorSchema>;

export const realtimeEventSchema = z.object({
  type: z.enum(['pageview', 'goal', 'payment', 'identify', 'external_link']),
  ts: z.string(),
  visitor_id: z.string(),
  path: z.string().nullable(),
  /** Goal name, or the link host for external links. */
  name: z.string().nullable(),
  country: z.string().nullable(),
  city: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  channel: z.string().nullable(),
  device: z.string().nullable(),
  amount_minor: z.number().int().nullable(),
  currency: z.string().nullable(),
  /** Display name of an identified visitor (null in share links). */
  label: z.string().nullable(),
});
export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;

const countRowSchema = z.object({ value: z.string().nullable(), visitors: z.number().int() });

export const analyticsRealtimeSchema = z.object({
  site_id: z.string(),
  currency: z.string(),
  /** Visitors seen in the last 5 minutes. */
  online: z.number().int(),
  window_minutes: z.number().int(),
  visitors: z.array(realtimeVisitorSchema),
  events: z.array(realtimeEventSchema),
  countries: z.array(countRowSchema),
  pages: z.array(countRowSchema),
  referrers: z.array(countRowSchema),
});
export type AnalyticsRealtime = z.infer<typeof analyticsRealtimeSchema>;

/**
 * Messages of the realtime WebSocket (`…/realtime/ws`): a snapshot right after
 * connecting (and on `{"type":"snapshot"}`), then one `event` per ingested
 * event; `ping` → `pong`.
 */
export type RealtimeServerMessage =
  | { type: 'snapshot'; data: AnalyticsRealtime }
  | { type: 'event'; data: RealtimeEvent }
  | { type: 'pong' };
export type RealtimeClientMessage = { type: 'ping' } | { type: 'snapshot' };

// -------------------------------------------------------------------- insights

export const insightsSegmentRowSchema = z.object({
  value: z.string().nullable(),
  visitors: z.number().int(),
  customers: z.number().int(),
  revenue_minor: z.number().int(),
  conversion_rate: z.number(),
});
export type InsightsSegmentRow = z.infer<typeof insightsSegmentRowSchema>;

const distributionSchema = z.object({
  median: z.number().nullable(),
  average: z.number().nullable(),
  buckets: z.array(z.object({ bucket: z.string(), customers: z.number().int() })),
});

export const analyticsInsightsSchema = z.object({
  from: z.string(),
  to: z.string(),
  timezone: z.string(),
  currency: z.string(),
  visitors: z.number().int(),
  /** People (visitor, or contact across its visitors) with a first purchase in the range. */
  customers: z.number().int(),
  revenue_minor: z.number().int(),
  revenue_by_device: z.array(insightsSegmentRowSchema),
  revenue_by_os: z.array(insightsSegmentRowSchema),
  revenue_by_browser: z.array(insightsSegmentRowSchema),
  top_countries_by_revenue: z.array(insightsSegmentRowSchema),
  top_countries_by_conversion: z.array(insightsSegmentRowSchema),
  visits_before_purchase: distributionSchema,
  days_before_purchase: distributionSchema,
  median_hours_to_purchase: z.number().nullable(),
  converting_events: z.array(
    z.object({
      goal: z.string(),
      visitors: z.number().int(),
      customers: z.number().int(),
      conversion_rate: z.number(),
      revenue_minor: z.number().int(),
    }),
  ),
  /** Purchases per local weekday (0 = Monday) and hour. Only non-zero cells. */
  heatmap: z.array(
    z.object({
      day: z.number().int().min(0).max(6),
      hour: z.number().int().min(0).max(23),
      conversions: z.number().int(),
    }),
  ),
  revenue_per_visitor: z.array(
    z.object({
      t: z.string(),
      label: z.string(),
      visitors: z.number().int(),
      revenue_minor: z.number().int(),
      revenue_per_visitor_minor: z.number(),
    }),
  ),
});
export type AnalyticsInsights = z.infer<typeof analyticsInsightsSchema>;

export const analyticsInsightsParamsSchema = analyticsQueryParamsSchema.extend({
  interval: z.enum(['week', 'month']).default('week'),
});

// -------------------------------------------------------------------- visitors

export const predictionSchema = z.object({
  /** 0..100. */
  score: z.number(),
  /** Calibrated probability to convert (0..1). */
  conversion_rate: z.number(),
  expected_value_minor: z.number().int(),
});
export type Prediction = z.infer<typeof predictionSchema>;

export const visitorSummarySchema = z.object({
  visitor_id: z.string(),
  contact_id: z.string().nullable(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  user_id: z.string().nullable(),
  first_seen: z.string(),
  last_seen: z.string(),
  sessions: z.number().int(),
  pageviews: z.number().int(),
  goals: z.number().int(),
  revenue_minor: z.number().int(),
  customer: z.boolean(),
  country: z.string().nullable(),
  device: z.string().nullable(),
  browser: z.string().nullable(),
  os: z.string().nullable(),
  first_channel: z.string().nullable(),
  first_source: z.string().nullable(),
  prediction: predictionSchema.nullable(),
});
export type VisitorSummary = z.infer<typeof visitorSummarySchema>;

export const VISITOR_SORTS = ['last_seen', 'revenue', 'score', 'sessions'] as const;

export const visitorsListParamsSchema = analyticsQueryParamsSchema.extend({
  q: z.string().max(255).optional(),
  identified: z.enum(['true', 'false']).optional(),
  customers: z.enum(['true', 'false']).optional(),
  sort: z.enum(VISITOR_SORTS).default('last_seen'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});

export const visitorsListSchema = z.object({
  data: z.array(visitorSummarySchema),
  next_cursor: z.string().nullable(),
});
export type VisitorsList = z.infer<typeof visitorsListSchema>;

export const visitorSessionSchema = z.object({
  id: z.string(),
  visitor_id: z.string(),
  started_at: z.string(),
  last_seen: z.string(),
  duration_ms: z.number().int(),
  channel: z.string(),
  source: z.string().nullable(),
  referrer_host: z.string().nullable(),
  utm_source: z.string().nullable(),
  utm_medium: z.string().nullable(),
  utm_campaign: z.string().nullable(),
  entry_page: z.string().nullable(),
  exit_page: z.string().nullable(),
  country: z.string().nullable(),
  city: z.string().nullable(),
  device: z.string().nullable(),
  browser: z.string().nullable(),
  os: z.string().nullable(),
  revenue_minor: z.number().int(),
  pageviews: z.array(z.object({ ts: z.string(), path: z.string(), hostname: z.string() })),
  goals: z.array(
    z.object({
      ts: z.string(),
      name: z.string(),
      path: z.string().nullable(),
      params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).nullable(),
    }),
  ),
});
export type VisitorSession = z.infer<typeof visitorSessionSchema>;

export const visitorProfileSchema = z.object({
  visitor: visitorSummarySchema,
  currency: z.string(),
  traits: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).nullable(),
  /** Other visitor ids of the same contact (devices, browsers) merged into this profile. */
  linked_visitor_ids: z.array(z.string()),
  sessions: z.array(visitorSessionSchema),
  completed_goals: z.array(
    z.object({ name: z.string(), count: z.number().int(), first_at: z.string(), last_at: z.string() }),
  ),
  visited_pages: z.array(
    z.object({ path: z.string(), count: z.number().int(), last_at: z.string() }),
  ),
  payments: z.array(analyticsPurchaseSchema),
  first_touch: touchSchema.nullable(),
  last_non_direct_touch: touchSchema.nullable(),
  time_to_conversion: timeToConversionSchema,
});
export type VisitorProfile = z.infer<typeof visitorProfileSchema>;

// ------------------------------------------------------------- contact journey

export const JOURNEY_ITEM_KINDS = [
  'session',
  'goal',
  'payment',
  'email',
  'order',
  'form',
  'booking',
  'identified',
] as const;
export type JourneyItemKind = (typeof JOURNEY_ITEM_KINDS)[number];

export const journeyItemSchema = z.object({
  kind: z.enum(JOURNEY_ITEM_KINDS),
  ts: z.string(),
  site_id: z.string().nullable(),
  /** Short machine-friendly title: goal name, page path, email event type, order number… */
  title: z.string(),
  detail: z.string().nullable(),
  channel: z.string().nullable(),
  path: z.string().nullable(),
  amount_minor: z.number().int().nullable(),
  currency: z.string().nullable(),
  /** Id of the referenced record (session, order, email message, form submission). */
  ref: z.string().nullable(),
  /** Pages of a session item (in order). */
  pages: z.array(z.string()).optional(),
});
export type JourneyItem = z.infer<typeof journeyItemSchema>;

export const contactJourneySchema = z.object({
  contact_id: z.string(),
  sites: z.array(z.object({ site_id: z.string(), name: z.string(), currency: z.string() })),
  visitors: z.array(z.object({ site_id: z.string(), visitor_id: z.string(), linked_at: z.string(), source: z.string() })),
  first_visit: z
    .object({
      ts: z.string(),
      site_id: z.string(),
      channel: z.string(),
      source: z.string().nullable(),
      referrer_host: z.string().nullable(),
      campaign: z.string().nullable(),
      entry_page: z.string().nullable(),
    })
    .nullable(),
  totals: z.object({
    sessions: z.number().int(),
    pageviews: z.number().int(),
    goals: z.number().int(),
    /** Web revenue per currency (orders of this CRM included). */
    revenue: z.array(z.object({ currency: z.string(), amount_minor: z.number().int() })),
    orders: z.number().int(),
    emails_opened: z.number().int(),
    emails_clicked: z.number().int(),
  }),
  sources: z.array(z.object({ channel: z.string(), source: z.string().nullable(), sessions: z.number().int() })),
  top_pages: z.array(z.object({ path: z.string(), count: z.number().int() })),
  goals: z.array(z.object({ name: z.string(), count: z.number().int(), last_at: z.string() })),
  first_touch: touchSchema.nullable(),
  last_non_direct_touch: touchSchema.nullable(),
  time_to_conversion: timeToConversionSchema,
  prediction: predictionSchema.nullable(),
  /** Newest first, at most `limit`. */
  items: z.array(journeyItemSchema),
});
export type ContactJourney = z.infer<typeof contactJourneySchema>;

export const contactJourneyParamsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

// --------------------------------------------------------------------- funnels

export const funnelStepSchema = z.strictObject({
  type: z.enum(['pageview', 'goal']),
  /** Page path (pageview) or goal name (goal). */
  value: z.string().trim().min(1).max(255),
  /** Pageview steps only: `exact` path or path `contains`. */
  match: z.enum(['exact', 'contains']).default('exact'),
  label: z.string().trim().max(100).optional(),
});
export type FunnelStep = z.infer<typeof funnelStepSchema>;

export const funnelSchema = z.object({
  id: z.string(),
  name: z.string(),
  steps: z.array(
    z.object({
      type: z.enum(['pageview', 'goal']),
      value: z.string(),
      match: z.enum(['exact', 'contains']),
      label: z.string().optional(),
    }),
  ),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Funnel = z.infer<typeof funnelSchema>;

export const createFunnelSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  steps: z.array(funnelStepSchema).min(2).max(8),
});
export type CreateFunnelInput = z.infer<typeof createFunnelSchema>;

export const updateFunnelSchema = z.strictObject({
  name: z.string().trim().min(1).max(100).optional(),
  steps: z.array(funnelStepSchema).min(2).max(8).optional(),
});
export type UpdateFunnelInput = z.infer<typeof updateFunnelSchema>;

export const funnelResultSchema = z.object({
  funnel_id: z.string(),
  from: z.string(),
  to: z.string(),
  /** Visitors entering step 1 in the range (filters apply to their sessions). */
  entered: z.number().int(),
  completed: z.number().int(),
  conversion_rate: z.number(),
  steps: z.array(
    z.object({
      index: z.number().int(),
      label: z.string(),
      visitors: z.number().int(),
      /** Share of step-1 visitors that reached this step. */
      conversion_rate: z.number(),
      /** Share of the previous step's visitors that reached this one. */
      step_conversion_rate: z.number(),
      dropoff: z.number().int(),
      median_ms_from_previous: z.number().nullable(),
    }),
  ),
});
export type FunnelResult = z.infer<typeof funnelResultSchema>;

// -------------------------------------------------------------------- segments

export const segmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  filters: z.array(analyticsFilterSchema),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Segment = z.infer<typeof segmentSchema>;

export const createSegmentSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  filters: z.array(analyticsFilterSchema).min(1).max(20),
});
export type CreateSegmentInput = z.infer<typeof createSegmentSchema>;

export const updateSegmentSchema = z.strictObject({
  name: z.string().trim().min(1).max(100).optional(),
  filters: z.array(analyticsFilterSchema).min(1).max(20).optional(),
});
export type UpdateSegmentInput = z.infer<typeof updateSegmentSchema>;

// ---------------------------------------------------------------------- alerts

const goalRefSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_]{1,64}$/, 'goal names use a-z, 0-9 and _ (max 64)');

const httpsUrlSchema = z
  .string()
  .url()
  .max(2048)
  .refine((u) => u.startsWith('https://'), 'https URL required');

export const alertSchema = z.object({
  id: z.string(),
  name: z.string(),
  goal: z.string(),
  enabled: z.boolean(),
  email_recipients: z.array(z.string()),
  webhook_url: z.string().nullable(),
  last_triggered_at: z.string().nullable(),
  /** Deliveries in the last 24 hours (emails + webhooks). */
  deliveries_24h: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Alert = z.infer<typeof alertSchema>;

export const createAlertSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  goal: goalRefSchema,
  enabled: z.boolean().default(true),
  email_recipients: z.array(z.string().email().max(320)).max(10).default([]),
  webhook_url: httpsUrlSchema.nullable().default(null),
});
export type CreateAlertInput = z.infer<typeof createAlertSchema>;

export const updateAlertSchema = z.strictObject({
  name: z.string().trim().min(1).max(100).optional(),
  goal: goalRefSchema.optional(),
  enabled: z.boolean().optional(),
  email_recipients: z.array(z.string().email().max(320)).max(10).optional(),
  webhook_url: httpsUrlSchema.nullable().optional(),
});
export type UpdateAlertInput = z.infer<typeof updateAlertSchema>;

/** Create / secret-roll response: the webhook signing secret is shown once. */
export const alertWithSecretSchema = z.object({
  alert: alertSchema,
  webhook_secret: z.string().nullable(),
});

/** Body POSTed to alert webhooks (`Amable-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<body>">`). */
export const alertWebhookPayloadSchema = z.object({
  type: z.literal('analytics.goal_alert'),
  alert_id: z.string(),
  site_id: z.string(),
  goal: z.string(),
  /** Completions aggregated in this delivery (throttled to one per minute per alert). */
  count: z.number().int(),
  first_at: z.string(),
  last_at: z.string(),
  visitor_ids: z.array(z.string()),
  test: z.boolean(),
});
export type AlertWebhookPayload = z.infer<typeof alertWebhookPayloadSchema>;

// ---------------------------------------------------------------- share links

export const shareSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Public read-only dashboard URL (contains the signed token). */
  url: z.string(),
  created_at: z.string(),
  revoked_at: z.string().nullable(),
  last_used_at: z.string().nullable(),
});
export type Share = z.infer<typeof shareSchema>;

export const createShareSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
});

/** What a public share link may see (no identities, no visitor profiles). */
export const publicShareInfoSchema = z.object({
  share: z.object({ name: z.string() }),
  site: z.object({ name: z.string(), timezone: z.string(), currency: z.string() }),
});
export type PublicShareInfo = z.infer<typeof publicShareInfoSchema>;

// ------------------------------------------------------------------- site keys

export const SITE_KEY_SCOPES = ['read', 'write'] as const;
export type SiteKeyScope = (typeof SITE_KEY_SCOPES)[number];

export const siteKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  /** First characters of the key, to recognise it. */
  prefix: z.string(),
  scopes: z.array(z.enum(SITE_KEY_SCOPES)),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
});
export type SiteKey = z.infer<typeof siteKeySchema>;

export const createSiteKeySchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(SITE_KEY_SCOPES)).min(1).default(['read']),
});

export const siteKeyWithSecretSchema = z.object({ key: siteKeySchema, secret: z.string() });

/** `POST /api/v2/analytics/goals` (site key with `write`). */
export const apiGoalSchema = z.strictObject({
  visitor_id: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
  name: goalRefSchema,
  params: z
    .record(z.string().max(64), z.union([z.string().max(255), z.number().finite(), z.boolean()]))
    .optional(),
});

/** `POST /api/v2/analytics/identify` (site key with `write`). */
export const apiIdentifySchema = z.strictObject({
  visitor_id: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
  user_id: z.string().min(1).max(255),
  email: z.string().email().max(320).optional(),
  name: z.string().max(255).optional(),
});

/** `POST /api/v2/analytics/payments` (site key with `write`). */
export const apiPaymentSchema = z.strictObject({
  visitor_id: z.string().regex(/^[A-Za-z0-9-]{8,64}$/).optional(),
  amount: z.number().finite().nonnegative(),
  currency: z.string().regex(/^[A-Za-z]{3}$/),
  transaction_id: z.string().min(1).max(255),
  email: z.string().email().max(320).optional(),
  renewal: z.boolean().optional(),
  refunded: z.boolean().optional(),
});

// ---------------------------------------------------------------- integrations

export const INTEGRATION_PROVIDERS = ['meta_ads', 'search_console'] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

export const integrationSchema = z.object({
  provider: z.enum(INTEGRATION_PROVIDERS),
  /** False when the installation has no OAuth service for this provider. */
  available: z.boolean(),
  /** True for the local development provider (generated data, no network). */
  fake: z.boolean(),
  status: z.enum(['disconnected', 'connected', 'error']),
  account_name: z.string().nullable(),
  connected_at: z.string().nullable(),
  last_sync_at: z.string().nullable(),
  last_error: z.string().nullable(),
});
export type Integration = z.infer<typeof integrationSchema>;

export const integrationConnectSchema = z.object({ authorize_url: z.string() });
export const integrationCallbackSchema = z.strictObject({
  state: z.string().min(1).max(512),
  code: z.string().min(1).max(2048),
});

export const adsReportSchema = z.object({
  currency: z.string(),
  totals: z.object({
    spend_minor: z.number().int(),
    revenue_minor: z.number().int(),
    roas: z.number().nullable(),
    clicks: z.number().int(),
    impressions: z.number().int(),
  }),
  campaigns: z.array(
    z.object({
      campaign_id: z.string(),
      campaign_name: z.string(),
      spend_minor: z.number().int(),
      impressions: z.number().int(),
      clicks: z.number().int(),
      /** Sessions / visitors whose `utm_campaign` matches the campaign name. */
      visitors: z.number().int(),
      customers: z.number().int(),
      revenue_minor: z.number().int(),
      roas: z.number().nullable(),
      cost_per_acquisition_minor: z.number().int().nullable(),
    }),
  ),
  daily: z.array(
    z.object({ label: z.string(), spend_minor: z.number().int(), revenue_minor: z.number().int() }),
  ),
});
export type AdsReport = z.infer<typeof adsReportSchema>;

const searchRowSchema = z.object({
  key: z.string(),
  clicks: z.number().int(),
  impressions: z.number().int(),
  ctr: z.number(),
  position: z.number(),
});

export const searchConsoleReportSchema = z.object({
  totals: z.object({
    clicks: z.number().int(),
    impressions: z.number().int(),
    ctr: z.number(),
    position: z.number(),
  }),
  queries: z.array(searchRowSchema),
  pages: z.array(searchRowSchema),
});
export type SearchConsoleReport = z.infer<typeof searchConsoleReportSchema>;

// ------------------------------------------------------------------------ bots

export const botsReportSchema = z.object({
  list_version: z.string(),
  total_hits: z.number().int(),
  categories: z.array(z.object({ value: z.string(), hits: z.number().int() })),
  bots: z.array(
    z.object({
      bot: z.string(),
      provider: z.string(),
      category: z.string(),
      hits: z.number().int(),
      /** Hits whose IP is in the provider's published ranges. */
      verified_hits: z.number().int(),
      /** Hits claiming the bot's user agent from an IP outside its ranges. */
      spoofed_hits: z.number().int(),
    }),
  ),
  pages: z.array(z.object({ path: z.string(), hits: z.number().int() })),
  daily: z.array(
    z.object({
      label: z.string(),
      ai_answers: z.number().int(),
      training: z.number().int(),
      indexing: z.number().int(),
      other: z.number().int(),
    }),
  ),
});
export type BotsReport = z.infer<typeof botsReportSchema>;

export const crawlerSnippetsSchema = z.object({
  endpoint: z.string(),
  /** Placeholder to replace with the site secret (never embedded here). */
  secret_placeholder: z.string(),
  worker: z.string(),
  node: z.string(),
  php: z.string(),
});
export type CrawlerSnippets = z.infer<typeof crawlerSnippetsSchema>;

// ------------------------------------------------------------------ prediction

export const predictionModelSchema = z.object({
  trained_at: z.string().nullable(),
  /** Visitors used to train (one sample per visitor). */
  samples: z.number().int(),
  positives: z.number().int(),
  base_rate: z.number(),
  /** Share of correct predictions on the training set at a 0.5 threshold. */
  accuracy: z.number().nullable(),
  average_order_value_minor: z.number().int(),
  currency: z.string(),
  top_features: z.array(z.object({ feature: z.string(), weight: z.number() })),
});
export type PredictionModelInfo = z.infer<typeof predictionModelSchema>;

// ---------------------------------------------------------------- install check

export const installCheckSchema = z.object({
  site_id: z.string(),
  receiving: z.boolean(),
  last_event_at: z.string().nullable(),
  last_event_url: z.string().nullable(),
  events_24h: z.number().int(),
  has_secret: z.boolean(),
  hostnames: z.array(z.string()),
});
export type InstallCheck = z.infer<typeof installCheckSchema>;
