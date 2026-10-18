import { z } from 'zod';
import { AD_PLATFORMS } from './ads';

/**
 * Traffic sources: where funnel traffic comes from (an ad platform, a
 * newsletter, an affiliate…). Each source declares which URL parameters are
 * captured as tracking fields (stored and reportable) — every other parameter
 * only lives in the visit's data buffer (`{data-*}` tokens), never stored.
 */

/** Parameters owned by the link routes; never usable as tracking fields or data params. */
export const RESERVED_URL_PARAMS = ['vid', 'n', 'c', 'ts', 'f', 'p', 'hit', 'rev', 'tx', 'rn'] as const;

export const MAX_CUSTOM_TRACKING_FIELDS = 20;
export const TRACKING_FIELD_SLOTS = Array.from(
  { length: MAX_CUSTOM_TRACKING_FIELDS },
  (_, i) => `c${i + 1}` as `c${number}`,
);

const urlParamSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.-]{1,64}$/, 'invalid URL parameter')
  .refine((p) => !(RESERVED_URL_PARAMS as readonly string[]).includes(p.toLowerCase()), {
    message: 'reserved URL parameter',
  });

const fieldBase = {
  url_param: urlParamSchema,
  /** Platform macro placed in the entrance URL, e.g. `{{campaign.id}}`. */
  source_token: z.string().max(200).default(''),
  /** Append `url_param=source_token` to generated entrance links. */
  append: z.boolean().default(true),
};

/** The two fixed fields: renamable URL parameter, not removable. */
export const reservedTrackingFieldSchema = z.object(fieldBase);
export type ReservedTrackingField = z.infer<typeof reservedTrackingFieldSchema>;

export const customTrackingFieldSchema = z.object({
  slot: z.enum(TRACKING_FIELD_SLOTS as [`c${number}`, ...`c${number}`[]]),
  name: z.string().trim().min(1).max(64),
  /** Previous name, kept on rename so old reports stay readable. */
  previous_name: z.string().max(64).nullable().optional(),
  ...fieldBase,
});
export type CustomTrackingField = z.infer<typeof customTrackingFieldSchema>;

export const COST_TYPES = ['cpc', 'cpm', 'cpa', 'revshare', 'none'] as const;
export type CostType = (typeof COST_TYPES)[number];

export const TRAFFIC_SOURCE_TEMPLATES = ['meta', 'google', 'tiktok', 'custom'] as const;
export type TrafficSourceTemplate = (typeof TRAFFIC_SOURCE_TEMPLATES)[number];

/** Conversion event of this CRM: `sale`, `lead`, or a numbered custom event `event:N`. */
export const conversionEventSchema = z.string().regex(/^(?:sale|lead|event:\d{1,3})$/, 'invalid event');

export const conversionConfigSchema = z.object({
  /** Server-to-server postback fired on conversions (`{token}` placeholders). */
  postback_url: z.url().max(2048).nullable().optional(),
  /** Ad connection receiving conversions through the platform API. */
  ad_connection_id: z.string().max(64).nullable().optional(),
  platform: z.enum(AD_PLATFORMS).nullable().optional(),
  mapping: z
    .array(
      z.object({
        event: conversionEventSchema,
        /** Platform event name (`Purchase`, `Lead`, conversion action id…). */
        platform_event: z.string().trim().min(1).max(200),
      }),
    )
    .max(30)
    .default([]),
});
export type ConversionConfig = z.infer<typeof conversionConfigSchema>;

const trafficSourceBody = {
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().max(64).nullable().optional(),
  template: z.enum(TRAFFIC_SOURCE_TEMPLATES).default('custom'),
  cost_type: z.enum(COST_TYPES).default('cpc'),
  default_cost_minor: z.number().int().nonnegative().nullable().optional(),
  reserved_fields: z.object({
    campaign: reservedTrackingFieldSchema,
    /** External click id (gclid, fbclid, ttclid…) used for platform conversions. */
    external: reservedTrackingFieldSchema,
  }),
  fields: z.array(customTrackingFieldSchema).max(MAX_CUSTOM_TRACKING_FIELDS).default([]),
  conversion: conversionConfigSchema.default({ mapping: [] }),
  /** Percent applied to reported cost / revenue (e.g. -10 = 10% less). */
  cost_modifier_pct: z.number().min(-100).max(1000).nullable().optional(),
  revenue_modifier_pct: z.number().min(-100).max(1000).nullable().optional(),
  skip_zero_revenue_postbacks: z.boolean().default(false),
  /** Percent of conversions NOT sent back to the platform (0 = send all). */
  postback_throttle_pct: z.number().min(0).max(100).nullable().optional(),
};

type FieldsShape = {
  reserved_fields: { campaign: { url_param: string }; external: { url_param: string } };
  fields: { slot: string; url_param: string }[];
};

function checkFields(src: FieldsShape, ctx: z.RefinementCtx) {
  const slots = new Set<string>();
  src.fields.forEach((f, i) => {
    if (slots.has(f.slot)) ctx.addIssue({ code: 'custom', message: 'duplicate slot', path: ['fields', i, 'slot'] });
    slots.add(f.slot);
  });
  const params = new Map<string, (string | number)[]>();
  params.set(src.reserved_fields.campaign.url_param.toLowerCase(), ['reserved_fields', 'campaign', 'url_param']);
  const ext = src.reserved_fields.external.url_param.toLowerCase();
  if (params.has(ext)) {
    ctx.addIssue({ code: 'custom', message: 'duplicate URL parameter', path: ['reserved_fields', 'external', 'url_param'] });
  }
  params.set(ext, ['reserved_fields', 'external', 'url_param']);
  src.fields.forEach((f, i) => {
    const key = f.url_param.toLowerCase();
    if (params.has(key)) ctx.addIssue({ code: 'custom', message: 'duplicate URL parameter', path: ['fields', i, 'url_param'] });
    params.set(key, ['fields', i, 'url_param']);
  });
}

export const trafficSourceSchema = z
  .object({
    id: z.string().min(1).max(64),
    ...trafficSourceBody,
    status: z.enum(['active', 'archived']),
    created_at: z.number().int(),
    updated_at: z.number().int(),
  })
  .superRefine(checkFields);
export type TrafficSource = z.infer<typeof trafficSourceSchema>;

export const trafficSourceInputSchema = z.strictObject(trafficSourceBody).superRefine(checkFields);
export type TrafficSourceInput = z.input<typeof trafficSourceInputSchema>;

/** Static template offered by `GET /traffic-sources/templates`. */
export const trafficSourceTemplateSchema = z.object({
  template: z.enum(TRAFFIC_SOURCE_TEMPLATES),
  name: z.string(),
  source: trafficSourceInputSchema,
});
export type TrafficSourceTemplateDef = z.infer<typeof trafficSourceTemplateSchema>;

// ------------------------------------------------------------ tracking domains

export const TRACKING_DOMAIN_STATUSES = ['pending_dns', 'pending_ssl', 'active', 'error'] as const;
export type TrackingDomainStatus = (typeof TRACKING_DOMAIN_STATUSES)[number];

export const trackingDomainSchema = z.object({
  id: z.string(),
  site_id: z.string(),
  hostname: z.string(),
  status: z.enum(TRACKING_DOMAIN_STATUSES),
  /** DNS records the customer must create. */
  dns: z.object({
    cname_name: z.string(),
    cname_target: z.string(),
    txt_name: z.string().nullable(),
    txt_value: z.string().nullable(),
  }),
  error: z.string().nullable(),
  created_at: z.number().int(),
  checked_at: z.number().int().nullable(),
});
export type TrackingDomain = z.infer<typeof trackingDomainSchema>;

export const createTrackingDomainSchema = z.strictObject({
  site_id: z.string().min(1).max(64),
  hostname: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
      'invalid hostname',
    ),
});
export type CreateTrackingDomainInput = z.infer<typeof createTrackingDomainSchema>;
