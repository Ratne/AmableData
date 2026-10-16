import { z } from 'zod';
import {
  dateSchema,
  dateTimeSchema,
  idSchema,
  optText,
  pageOf,
  richTextSchema,
  timestampSchema,
} from '../crm/common';

/**
 * Email marketing REST v2 schemas: templates, Dynamic Content snippets,
 * suppressions, messages, email settings and broadcasts.
 * Inputs are strict (unknown fields rejected), outputs use snake_case.
 */

const emailAddressSchema = z.email().max(254);

// ------------------------------------------------------------- templates

export const createEmailTemplateSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  subject: z.string().trim().max(300).default(''),
  body: richTextSchema,
  from_name: optText(100),
  reply_to: emailAddressSchema.nullable().optional(),
});
export type CreateEmailTemplateInput = z.infer<typeof createEmailTemplateSchema>;

export const updateEmailTemplateSchema = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  subject: z.string().trim().max(300).optional(),
  body: richTextSchema.optional(),
  from_name: optText(100),
  reply_to: emailAddressSchema.nullable().optional(),
});
export type UpdateEmailTemplateInput = z.infer<typeof updateEmailTemplateSchema>;

export const emailTemplateSchema = z.object({
  id: idSchema,
  name: z.string(),
  subject: z.string(),
  preheader: z.string(),
  body: richTextSchema,
  from_name: z.string().nullable(),
  reply_to: z.string().nullable(),
  /** True when the compiled HTML cache matches the current body. */
  compiled: z.boolean(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type EmailTemplate = z.infer<typeof emailTemplateSchema>;

export const emailTemplateSummarySchema = emailTemplateSchema.omit({ body: true });
export type EmailTemplateSummary = z.infer<typeof emailTemplateSummarySchema>;
export const emailTemplatePageSchema = pageOf(emailTemplateSummarySchema);

// ------------------------------------------------------------- snippets

/** Liquid partial name: usable as `{{ snippets.<key> }}`. */
export const snippetKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,62}$/, 'lowercase letters, digits and underscores');

export const createSnippetSchema = z.strictObject({
  key: snippetKeySchema,
  name: z.string().trim().min(1).max(200),
  /** Liquid source (text). Rendered per recipient, inserted as escaped text. */
  body: z.string().max(20_000),
});
export type CreateSnippetInput = z.infer<typeof createSnippetSchema>;

export const updateSnippetSchema = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  body: z.string().max(20_000).optional(),
});
export type UpdateSnippetInput = z.infer<typeof updateSnippetSchema>;

export const snippetSchema = z.object({
  id: idSchema,
  key: z.string(),
  name: z.string(),
  body: z.string(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type Snippet = z.infer<typeof snippetSchema>;
export const snippetListSchema = z.object({ data: z.array(snippetSchema) });

// ---------------------------------------------------------- suppressions

export const SUPPRESSION_REASONS = ['unsubscribe', 'bounce', 'complaint', 'manual'] as const;
export const suppressionReasonSchema = z.enum(SUPPRESSION_REASONS);
export type SuppressionReason = z.infer<typeof suppressionReasonSchema>;

export const suppressionSchema = z.object({
  email: z.string(),
  reason: suppressionReasonSchema,
  source: z.string().nullable(),
  contact_id: idSchema.nullable(),
  created_at: timestampSchema,
});
export type Suppression = z.infer<typeof suppressionSchema>;
export const suppressionPageSchema = pageOf(suppressionSchema);

export const listSuppressionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
  q: z.string().max(254).optional(),
  reason: suppressionReasonSchema.optional(),
});
export type ListSuppressionsQuery = z.infer<typeof listSuppressionsQuerySchema>;

export const addSuppressionSchema = z.strictObject({
  email: emailAddressSchema,
  reason: z.enum(['manual', 'unsubscribe']).default('manual'),
});
export type AddSuppressionInput = z.infer<typeof addSuppressionSchema>;

// -------------------------------------------------------------- messages

export const EMAIL_MESSAGE_STATUSES = [
  'queued',
  'sent',
  'delivered',
  'deferred',
  'bounced',
  'dropped',
  'complained',
  'skipped',
  'blocked',
  'failed',
] as const;
export const emailMessageStatusSchema = z.enum(EMAIL_MESSAGE_STATUSES);
export type EmailMessageStatus = z.infer<typeof emailMessageStatusSchema>;

export const emailMessageSchema = z.object({
  id: idSchema,
  contact_id: idSchema,
  email: z.string().nullable(),
  subject: z.string().nullable(),
  status: emailMessageStatusSchema,
  /** Why a message was skipped/blocked/failed (e.g. `suppressed`, `domain_not_verified`). */
  status_reason: z.string().nullable(),
  source_type: z.enum(['automation', 'broadcast', 'single', 'transactional', 'test']),
  broadcast_id: idSchema.nullable(),
  provider_message_id: z.string().nullable(),
  attempts: z.number().int(),
  open_count: z.number().int(),
  click_count: z.number().int(),
  sent_at: timestampSchema.nullable(),
  delivered_at: timestampSchema.nullable(),
  opened_at: timestampSchema.nullable(),
  clicked_at: timestampSchema.nullable(),
  bounced_at: timestampSchema.nullable(),
  unsubscribed_at: timestampSchema.nullable(),
  created_at: timestampSchema,
});
export type EmailMessage = z.infer<typeof emailMessageSchema>;
export const emailMessagePageSchema = pageOf(emailMessageSchema);

export const sendSingleEmailSchema = z.strictObject({
  template_id: idSchema.optional(),
  subject: z.string().trim().min(1).max(300).optional(),
  body: richTextSchema.optional(),
});
export type SendSingleEmailInput = z.infer<typeof sendSingleEmailSchema>;

export const sendSingleEmailResponseSchema = z.object({
  request_id: idSchema,
  queued: z.literal(true),
});

// -------------------------------------------------------------- settings

export const SENDING_STATES = ['verified', 'unverified', 'dev_override'] as const;

export const emailSettingsSchema = z.object({
  from_name: z.string().nullable(),
  from_email: z.string().nullable(),
  reply_to: z.string().nullable(),
  physical_address: z.string().nullable(),
  timezone: z.string(),
  rate_per_minute: z.number().int(),
  sending: z.object({
    state: z.enum(SENDING_STATES),
    domains: z.array(
      z.object({ hostname: z.string(), kind: z.string(), status: z.string() }),
    ),
    tracking_origin: z.string(),
    can_send: z.boolean(),
    block_reason: z.string().nullable(),
  }),
  warmup: z.object({
    started_at: timestampSchema.nullable(),
    day: z.number().int(),
    daily_cap: z.number().int().nullable(),
    sent_today: z.number().int(),
  }),
  suspension: z.object({
    suspended: z.boolean(),
    reason: z.string().nullable(),
    at: timestampSchema.nullable(),
  }),
  health: z.object({
    window_days: z.number().int(),
    sent: z.number().int(),
    bounce_rate: z.number(),
    complaint_rate: z.number(),
  }),
});
export type EmailSettings = z.infer<typeof emailSettingsSchema>;

export const updateEmailSettingsSchema = z.strictObject({
  from_name: optText(100),
  from_email: emailAddressSchema.nullable().optional(),
  reply_to: emailAddressSchema.nullable().optional(),
  physical_address: optText(500),
  timezone: z.string().min(1).max(64).optional(),
  rate_per_minute: z.number().int().min(1).max(10_000).optional(),
});
export type UpdateEmailSettingsInput = z.infer<typeof updateEmailSettingsSchema>;

export const previewContextQuerySchema = z.object({ contact_id: idSchema });
export const previewContextSchema = z.object({
  context: z.record(z.string(), z.unknown()),
  /** Default zone of the Liquid `date` filter (the tenant timezone), as when sending. */
  timezone: z.string(),
});

// ------------------------------------------------------------ broadcasts

export const broadcastSegmentSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('saved_search'), saved_search_id: idSchema }),
  z.strictObject({
    type: z.literal('tags'),
    match: z.enum(['any', 'all', 'none']),
    tag_ids: z.array(idSchema).min(1).max(50),
  }),
  /**
   * Contacts with the included tags (`tag_match` any/all) or in any included
   * saved search, minus contacts with any excluded tag or in any excluded
   * saved search. No include at all = nobody.
   */
  z.strictObject({
    type: z.literal('audience'),
    include_tag_ids: z.array(idSchema).max(50),
    tag_match: z.enum(['any', 'all']),
    include_saved_search_ids: z.array(idSchema).max(10),
    exclude_tag_ids: z.array(idSchema).max(50),
    exclude_saved_search_ids: z.array(idSchema).max(10),
  }),
]);
export type BroadcastSegment = z.infer<typeof broadcastSegmentSchema>;
export type BroadcastAudience = Extract<BroadcastSegment, { type: 'audience' }>;

export const broadcastScheduleSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('now') }),
  z.strictObject({ mode: z.literal('at'), at: dateTimeSchema }),
  /** Same local wall-clock time in each contact's timezone (fallback: tenant timezone). */
  z.strictObject({
    mode: z.literal('contact_tz'),
    local_date: dateSchema,
    local_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM'),
  }),
]);
export type BroadcastSchedule = z.infer<typeof broadcastScheduleSchema>;

export const BROADCAST_STATUSES = [
  'draft',
  'scheduled',
  'sending',
  'paused',
  'sent',
  'cancelled',
] as const;
export const broadcastStatusSchema = z.enum(BROADCAST_STATUSES);
export type BroadcastStatus = z.infer<typeof broadcastStatusSchema>;

export const createBroadcastSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  segment: broadcastSegmentSchema.nullable().optional(),
  template_id: idSchema.nullable().optional(),
  subject: z.string().trim().max(300).optional(),
  body: richTextSchema.nullable().optional(),
  from_name: optText(100),
  reply_to: emailAddressSchema.nullable().optional(),
  /** Max messages enqueued per hour (null = as fast as the tenant rate limit allows). */
  throttle_per_hour: z.number().int().min(10).max(1_000_000).nullable().optional(),
});
export type CreateBroadcastInput = z.infer<typeof createBroadcastSchema>;

export const updateBroadcastSchema = createBroadcastSchema.partial();
export type UpdateBroadcastInput = z.infer<typeof updateBroadcastSchema>;

export const broadcastSchema = z.object({
  id: idSchema,
  name: z.string(),
  status: broadcastStatusSchema,
  segment: broadcastSegmentSchema.nullable(),
  template_id: idSchema.nullable(),
  subject: z.string(),
  body: richTextSchema.nullable(),
  from_name: z.string().nullable(),
  reply_to: z.string().nullable(),
  throttle_per_hour: z.number().int().nullable(),
  schedule: broadcastScheduleSchema.nullable(),
  progress: z.object({
    recipients: z.number().int(),
    pending: z.number().int(),
    enqueued: z.number().int(),
    cancelled: z.number().int(),
  }),
  next_send_at: timestampSchema.nullable(),
  created_by: z.string().nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  started_at: timestampSchema.nullable(),
  completed_at: timestampSchema.nullable(),
});
export type Broadcast = z.infer<typeof broadcastSchema>;

export const broadcastSummarySchema = broadcastSchema.omit({ body: true }).extend({
  stats: z.object({
    sent: z.number().int(),
    opened: z.number().int(),
    clicked: z.number().int(),
  }),
});
export type BroadcastSummary = z.infer<typeof broadcastSummarySchema>;
export const broadcastPageSchema = pageOf(broadcastSummarySchema);

export const listBroadcastsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
  status: broadcastStatusSchema.optional(),
});
export type ListBroadcastsQuery = z.infer<typeof listBroadcastsQuerySchema>;

export const quotaDecisionSchema = z.object({
  action: z.enum(['allow', 'deny', 'pause']),
  reason: z.string().nullable(),
});

export const broadcastEstimateSchema = z.object({
  segment_size: z.number().int(),
  eligible: z.number().int(),
  excluded: z.object({
    no_email: z.number().int(),
    suppressed: z.number().int(),
    unmarketable: z.number().int(),
  }),
  warmup: z.object({
    daily_cap: z.number().int().nullable(),
    remaining_today: z.number().int().nullable(),
  }),
  quota: quotaDecisionSchema,
  can_send: z.boolean(),
  /** First blocking problem: domain_not_verified, sending_suspended, missing_physical_address, quota_denied, empty_segment, no_content. */
  block_reason: z.string().nullable(),
});
export type BroadcastEstimate = z.infer<typeof broadcastEstimateSchema>;

export const scheduleBucketSchema = z.object({
  time_zone: z.string(),
  send_at: timestampSchema,
  count: z.number().int(),
});
export type ScheduleBucket = z.infer<typeof scheduleBucketSchema>;

export const scheduleBroadcastResponseSchema = z.object({
  broadcast: broadcastSchema,
  buckets: z.array(scheduleBucketSchema),
});

export const testSendSchema = z.strictObject({
  /** Tenant members to send to (default: the caller). Only members of the tenant are allowed. */
  user_ids: z.array(idSchema).min(1).max(10).optional(),
  /** Contact whose data fills the Liquid fields (default: sample data). */
  contact_id: idSchema.optional(),
});
export type TestSendInput = z.infer<typeof testSendSchema>;

export const testSendResponseSchema = z.object({
  sent: z.array(z.object({ email: z.string(), message_id: z.string() })),
});

export const broadcastStatsSchema = z.object({
  broadcast_id: idSchema,
  status: broadcastStatusSchema,
  totals: z.object({
    recipients: z.number().int(),
    sent: z.number().int(),
    delivered: z.number().int(),
    opened: z.number().int(),
    clicked: z.number().int(),
    bounced: z.number().int(),
    complained: z.number().int(),
    unsubscribed: z.number().int(),
    failed: z.number().int(),
    skipped: z.number().int(),
  }),
  rates: z.object({
    delivery: z.number(),
    open: z.number(),
    click: z.number(),
    bounce: z.number(),
    unsubscribe: z.number(),
  }),
  links: z.array(
    z.object({
      url: z.string(),
      position: z.number().int(),
      clicks: z.number().int(),
      unique_clicks: z.number().int(),
    }),
  ),
  progress: broadcastSchema.shape.progress,
});
export type BroadcastStats = z.infer<typeof broadcastStatsSchema>;

export * from './liquid';
