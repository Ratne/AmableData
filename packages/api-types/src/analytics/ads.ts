import { z } from 'zod';

/**
 * Ad platforms: connections (OAuth), entities (campaign → adset/ad group → ad),
 * daily spend with the conversions the platform itself reports, the outbound
 * conversion queue (server-side conversions sent back to the platforms) and
 * visitor identity keys used to stitch anonymous clicks to leads and sales.
 */

export const AD_PLATFORMS = ['meta', 'google', 'tiktok'] as const;
export type AdPlatform = (typeof AD_PLATFORMS)[number];

export const AD_CONNECTION_STATUSES = ['active', 'auth_expired', 'error', 'disconnected'] as const;
export type AdConnectionStatus = (typeof AD_CONNECTION_STATUSES)[number];

/** Connection as exposed by the API (tokens never leave the server). */
export const adConnectionSchema = z.object({
  id: z.string(),
  platform: z.enum(AD_PLATFORMS),
  account_id: z.string(),
  account_name: z.string().nullable(),
  currency: z.string().nullable(),
  status: z.enum(AD_CONNECTION_STATUSES),
  last_sync_at: z.number().int().nullable(),
  last_error: z.string().nullable(),
  created_at: z.number().int(),
  /** Meta dataset (pixel) ID or TikTok pixel code the server-side conversions go to. */
  pixel_id: z.string().nullable().optional(),
  /** Meta/TikTok test event code: conversions show up in the platform's test tool. */
  test_event_code: z.string().nullable().optional(),
});
export type AdConnection = z.infer<typeof adConnectionSchema>;

export const adConnectionSettingsSchema = z.strictObject({
  pixel_id: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{4,64}$/)
    .nullable()
    .optional(),
  test_event_code: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .nullable()
    .optional(),
});
export type AdConnectionSettings = z.infer<typeof adConnectionSettingsSchema>;

export const AD_ENTITY_LEVELS = ['campaign', 'adset', 'ad'] as const;
export type AdEntityLevel = (typeof AD_ENTITY_LEVELS)[number];

export const adEntitySchema = z.object({
  platform: z.enum(AD_PLATFORMS),
  level: z.enum(AD_ENTITY_LEVELS),
  external_id: z.string().min(1).max(128),
  parent_external_id: z.string().max(128).nullable().optional(),
  name: z.string().max(500),
  status: z.string().max(64),
  budget_minor: z.number().int().nonnegative().nullable().optional(),
});
export type AdEntity = z.infer<typeof adEntitySchema>;

export const adSpendDaySchema = z.object({
  platform: z.enum(AD_PLATFORMS),
  /** Entity the spend belongs to (campaign level unless synced deeper). */
  entity_external_id: z.string().min(1).max(128),
  /** Local day of the ad account, `YYYY-MM-DD`. */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  spend_minor: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  clicks: z.number().int().nonnegative().nullable().optional(),
  impressions: z.number().int().nonnegative().nullable().optional(),
  /** What the platform claims (reported vs actual). */
  reported_conversions: z.number().nonnegative().nullable().optional(),
  reported_revenue_minor: z.number().int().nonnegative().nullable().optional(),
});
export type AdSpendDay = z.infer<typeof adSpendDaySchema>;

// ---------------------------------------------------------- outbound conversions

/** Where an outbound conversion goes: an ad platform API, or the traffic source's postback URL. */
export const OUTBOUND_TARGETS = [...AD_PLATFORMS, 'postback'] as const;
export type OutboundTarget = (typeof OUTBOUND_TARGETS)[number];

export const OUTBOUND_KINDS = ['purchase', 'lead', 'custom'] as const;
export type OutboundKind = (typeof OUTBOUND_KINDS)[number];

export const OUTBOUND_STATUSES = ['pending', 'sent', 'failed', 'skipped'] as const;
export type OutboundStatus = (typeof OUTBOUND_STATUSES)[number];

/** Normalized conversion sent to a platform; PII is hashed by the provider client. */
export const outboundPayloadSchema = z.object({
  event_name: z.string().min(1).max(200),
  event_time: z.number().int(),
  value_minor: z.number().int().nullable().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable().optional(),
  order_id: z.string().max(255).nullable().optional(),
  click_ids: z.record(z.string(), z.string().max(512)).default({}),
  email: z.string().max(320).nullable().optional(),
  phone: z.string().max(32).nullable().optional(),
  ip: z.string().max(64).nullable().optional(),
  user_agent: z.string().max(1024).nullable().optional(),
  page_url: z.string().max(2048).nullable().optional(),
  external_id: z.string().max(255).nullable().optional(),
  /** Postback jobs: the URL with its tokens already filled in. */
  url: z.string().max(4096).optional(),
});
export type OutboundPayload = z.infer<typeof outboundPayloadSchema>;

export const outboundConversionJobSchema = z.object({
  id: z.string(),
  platform: z.enum(OUTBOUND_TARGETS),
  connection_id: z.string(),
  kind: z.enum(OUTBOUND_KINDS),
  payload: outboundPayloadSchema,
  status: z.enum(OUTBOUND_STATUSES),
  attempts: z.number().int().nonnegative(),
  last_error: z.string().nullable().optional(),
  /** Stable hash of the conversion; shared with the browser pixel for dedup. */
  event_id: z.string().min(1).max(128),
  created_at: z.number().int(),
  next_attempt_at: z.number().int().nullable().optional(),
  sent_at: z.number().int().nullable().optional(),
});
export type OutboundConversionJob = z.infer<typeof outboundConversionJobSchema>;

export const PROVIDER_ERROR_KINDS = ['retryable', 'permanent', 'auth_expired'] as const;
export type ProviderErrorKind = (typeof PROVIDER_ERROR_KINDS)[number];

// -------------------------------------------------------------------- identity

export const IDENTITY_KEY_TYPES = ['email', 'phone', 'session', 'ip'] as const;
export type IdentityKeyType = (typeof IDENTITY_KEY_TYPES)[number];

export const identityKeySchema = z.object({
  key_type: z.enum(IDENTITY_KEY_TYPES),
  /** Normalized value (lower-case email, E.164 phone). */
  key_value: z.string().min(1).max(320),
  visitor_id: z.string(),
  first_seen: z.number().int(),
});
export type IdentityKey = z.infer<typeof identityKeySchema>;

export const MERGE_MECHANISMS = ['email', 'phone', 'session', 'manual'] as const;
export type MergeMechanism = (typeof MERGE_MECHANISMS)[number];

export const visitorMergeSchema = z.object({
  child_visitor_id: z.string(),
  origin_visitor_id: z.string(),
  mechanism: z.enum(MERGE_MECHANISMS),
  active: z.boolean(),
  created_at: z.number().int(),
});
export type VisitorMerge = z.infer<typeof visitorMergeSchema>;

// ------------------------------------------------- tokens for the edge worker

/** Gateway op answered by the core: decrypted (refreshed if needed) access token of a connection. */
export const ADS_TOKEN_GATEWAY_OP = 'analytics.adsToken';

export const adsTokenInputSchema = z.strictObject({
  tenant_id: z.string().min(1).max(64),
  site_id: z.string().min(1).max(64),
  connection_id: z.string().min(1).max(64),
});
export type AdsTokenInput = z.infer<typeof adsTokenInputSchema>;

/** Null when the connection is unknown to the core or disconnected. */
export type AdsTokenOutput = {
  platform: AdPlatform;
  access_token: string;
  /** Google Ads only. */
  developer_token?: string | null;
  login_customer_id?: string | null;
  api_version?: string | null;
} | null;

/** Error code the core answers when the connection's refresh token is revoked. */
export const ADS_TOKEN_AUTH_EXPIRED = 'auth_expired';

export type AnalyticsGatewayOps = {
  [ADS_TOKEN_GATEWAY_OP]: { input: AdsTokenInput; output: AdsTokenOutput };
};
