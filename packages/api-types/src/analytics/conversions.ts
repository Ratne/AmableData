import { z } from 'zod';
import { ATTRIBUTION_MODELS } from './base';
import { ATTRIBUTION_DIMENSIONS, touchSchema } from './reports';

/**
 * Custom conversions: rules defined in the dashboard ("reached page Y",
 * "completed goal Z") that turn matching pageviews or goals into conversions,
 * credited to the sessions of the person before them (landing page, channel,
 * campaign, ad). Served by REST v2 `/api/v2/t/{slug}/analytics/conversions*`.
 */

export const CONVERSION_TRIGGERS = ['pageview', 'goal'] as const;
export type ConversionTrigger = (typeof CONVERSION_TRIGGERS)[number];

/** Path comparison of pageview rules (case-sensitive, query string excluded). */
export const CONVERSION_MATCHES = ['exact', 'starts_with', 'contains'] as const;
export type ConversionMatch = (typeof CONVERSION_MATCHES)[number];

/** `once`: the first match of each visitor; `every`: every matching pageview or goal. */
export const CONVERSION_COUNTS = ['once', 'every'] as const;
export type ConversionCount = (typeof CONVERSION_COUNTS)[number];

export const MAX_CONVERSION_RULES = 100;
/** Rule conversions are `event:N` entries of the conversion log; postback custom events use 1-10. */
export const CONVERSION_RULE_FIRST_EVENT = 100;
export const CONVERSION_RULE_LAST_EVENT = 999;

const ruleFields = {
  name: z.string().trim().min(1).max(100),
  trigger: z.enum(CONVERSION_TRIGGERS),
  /** Page path (`/grazie`, a full URL is accepted) or goal name. */
  value: z.string().trim().min(1).max(2048),
  match: z.enum(CONVERSION_MATCHES),
  /** Pageview rules only: restrict to one hostname (`shop.example.com`). */
  hostname: z.string().trim().toLowerCase().max(253).nullable(),
  count: z.enum(CONVERSION_COUNTS),
  /** Fixed value of each conversion in the site currency (minor units). */
  value_minor: z.number().int().nonnegative().max(1_000_000_000).nullable(),
  enabled: z.boolean(),
};

export const createConversionRuleSchema = z.strictObject({
  name: ruleFields.name,
  trigger: ruleFields.trigger.default('pageview'),
  value: ruleFields.value,
  match: ruleFields.match.default('exact'),
  hostname: ruleFields.hostname.default(null),
  count: ruleFields.count.default('once'),
  value_minor: ruleFields.value_minor.default(null),
  enabled: ruleFields.enabled.default(true),
  /** Also convert the pageviews / goals already collected (raw retention window). */
  backfill: z.boolean().default(false),
});
export type CreateConversionRuleInput = z.input<typeof createConversionRuleSchema>;

export const updateConversionRuleSchema = z.strictObject({
  name: ruleFields.name.optional(),
  trigger: ruleFields.trigger.optional(),
  value: ruleFields.value.optional(),
  match: ruleFields.match.optional(),
  hostname: ruleFields.hostname.optional(),
  count: ruleFields.count.optional(),
  value_minor: ruleFields.value_minor.optional(),
  enabled: ruleFields.enabled.optional(),
});
export type UpdateConversionRuleInput = z.input<typeof updateConversionRuleSchema>;

export const conversionRuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Goal name recorded on pageview conversions (alerts, automations, funnels); the goal itself for goal rules. */
  key: z.string(),
  trigger: z.enum(CONVERSION_TRIGGERS),
  value: z.string(),
  match: z.enum(CONVERSION_MATCHES),
  hostname: z.string().nullable(),
  count: z.enum(CONVERSION_COUNTS),
  value_minor: z.number().int().nullable(),
  enabled: z.boolean(),
  /** Event of the conversion log (`event:N`). */
  event: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  /** Conversions written from past data (create with `backfill` only). */
  backfilled: z.number().int().optional(),
});
export type ConversionRule = z.infer<typeof conversionRuleSchema>;

// --------------------------------------------------------------------- report

/** Source dimensions of the conversion breakdown: the attribution ones plus the ad ids of the session. */
export const CONVERSION_DIMENSIONS = [
  ...ATTRIBUTION_DIMENSIONS,
  'ad_campaign',
  'ad_set',
  'ad',
] as const;
export type ConversionDimension = (typeof CONVERSION_DIMENSIONS)[number];

export const conversionReportQuerySchema = z.object({
  rule_id: z.string().min(1).max(64).optional(),
  dimension: z.enum(CONVERSION_DIMENSIONS).default('channel'),
  /** Defaults to the site attribution model. */
  model: z.enum(ATTRIBUTION_MODELS).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ConversionReportQuery = z.input<typeof conversionReportQuerySchema>;

const conversionTotalsSchema = z.object({
  conversions: z.number().int(),
  /** Distinct persons (a CRM contact across its visitors, else a visitor). */
  persons: z.number().int(),
  value_minor: z.number().int(),
  /** Persons / visitors of the range. */
  conversion_rate: z.number(),
});

export const conversionReportSchema = z.object({
  currency: z.string(),
  model: z.enum(ATTRIBUTION_MODELS),
  dimension: z.enum(CONVERSION_DIMENSIONS),
  /** Visitors with a session in the range. */
  visitors: z.number().int(),
  totals: conversionTotalsSchema,
  rules: z.array(conversionTotalsSchema.extend({ rule_id: z.string(), name: z.string() })),
  /** Conversions credited to the values of `dimension` (fractional with multi-touch models); null = no session. */
  breakdown: z.array(
    z.object({
      value: z.string().nullable(),
      /** Ad name of the synced account for the ad dimensions. */
      label: z.string().nullable(),
      conversions: z.number(),
      value_minor: z.number().int(),
    }),
  ),
  recent: z.array(
    z.object({
      ts: z.string(),
      rule_id: z.string(),
      rule_name: z.string(),
      visitor_id: z.string().nullable(),
      /** Page or goal that triggered the conversion. */
      trigger: z.string().nullable(),
      entry_page: z.string().nullable(),
      ad_campaign: z.string().nullable(),
      ad: z.string().nullable(),
      first_touch: touchSchema.nullable(),
      last_non_direct_touch: touchSchema.nullable(),
    }),
  ),
});
export type ConversionReport = z.infer<typeof conversionReportSchema>;
