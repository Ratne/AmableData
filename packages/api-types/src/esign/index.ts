import { z } from 'zod';
import { idSchema, timestampSchema } from '../crm/common';

/**
 * Electronic signatures REST v2 schemas: templates (source PDF, page images,
 * parties, fields placed on the pages), signature requests sent to one signer
 * per party, and the audit trail of every request. Field rectangles are
 * normalized to the page (0..1, origin top-left), so they do not depend on
 * the resolution the page is rendered at.
 */

const listQuery = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
};

export const ESIGN_FIELD_TYPES = [
  'signature',
  'initials',
  'text',
  'number',
  'date',
  'checkbox',
  'select',
  'radio',
  'image',
  'signed_date',
] as const;
export type EsignFieldType = (typeof ESIGN_FIELD_TYPES)[number];

/** Field types whose value is an image (drawn / typed signature, uploaded picture). */
export const ESIGN_IMAGE_FIELDS: ReadonlySet<EsignFieldType> = new Set([
  'signature',
  'initials',
  'image',
]);
/** Filled by the system when the party signs. */
export const ESIGN_AUTO_FIELDS: ReadonlySet<EsignFieldType> = new Set(['signed_date']);

export const ESIGN_TEMPLATE_STATUSES = ['draft', 'active', 'archived'] as const;
export const ESIGN_REQUEST_STATUSES = [
  'sent',
  'partially_signed',
  'completed',
  'declined',
  'voided',
  'expired',
] as const;
export type EsignRequestStatus = (typeof ESIGN_REQUEST_STATUSES)[number];
export const ESIGN_SIGNER_STATUSES = [
  'pending',
  'sent',
  'opened',
  'completed',
  'declined',
] as const;
export type EsignSignerStatus = (typeof ESIGN_SIGNER_STATUSES)[number];

export const ESIGN_MAX_PAGES = 50;
export const ESIGN_PDF_MAX_BYTES = 20 * 1024 * 1024;
export const ESIGN_PAGE_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

const partyIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, 'lowercase letters, digits, "_" and "-"');
const fieldIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const unit = z.number().min(0).max(1);

export const esignPartySchema = z.strictObject({
  id: partyIdSchema,
  name: z.string().trim().min(1).max(100),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
});
export type EsignParty = z.infer<typeof esignPartySchema>;

export const esignFieldSchema = z
  .strictObject({
    id: fieldIdSchema,
    type: z.enum(ESIGN_FIELD_TYPES),
    party_id: partyIdSchema,
    /** 0-based page index. */
    page: z
      .number()
      .int()
      .min(0)
      .max(ESIGN_MAX_PAGES - 1),
    x: unit,
    y: unit,
    w: z.number().min(0.005).max(1),
    h: z.number().min(0.005).max(1),
    required: z.boolean().default(true),
    label: z.string().trim().max(200).default(''),
    /** Choices of `select` and `radio`. */
    options: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  })
  .refine((f) => f.x + f.w <= 1.0001 && f.y + f.h <= 1.0001, {
    message: 'the field must stay inside the page',
    path: ['w'],
  })
  .refine((f) => (f.type !== 'select' && f.type !== 'radio') || f.options.length > 0, {
    message: 'select and radio fields need options',
    path: ['options'],
  });
export type EsignField = z.infer<typeof esignFieldSchema>;
export type EsignFieldInput = z.input<typeof esignFieldSchema>;

export const esignRemindersSchema = z.strictObject({
  enabled: z.boolean().default(true),
  /** Days after the invitation before the first reminder. */
  first_after_days: z.number().int().min(1).max(60).default(3),
  every_days: z.number().int().min(1).max(60).default(3),
  max: z.number().int().min(0).max(10).default(3),
});

export const esignSettingsSchema = z.strictObject({
  /** Signers confirm a 6-digit code sent to their email before signing. */
  require_otp: z.boolean().default(false),
  /** Requests expire this many days after being sent (null: never). */
  expire_days: z.number().int().min(1).max(365).nullable().default(30),
  reminders: esignRemindersSchema.default({
    enabled: true,
    first_after_days: 3,
    every_days: 3,
    max: 3,
  }),
  /** Invitation subject / message; empty: the built-in text. */
  email_subject: z.string().trim().max(300).default(''),
  email_message: z.string().trim().max(5000).default(''),
  /** Language of emails and signing page; `auto` follows the signer's browser. */
  locale: z.enum(['auto', 'en', 'it']).default('auto'),
});
export type EsignSettings = z.infer<typeof esignSettingsSchema>;
export type EsignSettingsInput = z.input<typeof esignSettingsSchema>;

export const ESIGN_DEFAULT_SETTINGS: EsignSettings = esignSettingsSchema.parse({});

export const esignPageSchema = z.object({
  index: z.number().int(),
  /** PDF points (crop box, rotation applied). */
  width: z.number(),
  height: z.number(),
  has_image: z.boolean(),
});
export type EsignPage = z.infer<typeof esignPageSchema>;

// -------------------------------------------------------------- templates

export const esignTemplateSchema = z.object({
  id: idSchema,
  name: z.string(),
  status: z.enum(ESIGN_TEMPLATE_STATUSES),
  source: z.object({ filename: z.string(), size: z.number().int(), sha256: z.string() }).nullable(),
  pages: z.array(esignPageSchema),
  parties: z.array(esignPartySchema),
  signing_order: z.enum(['parallel', 'sequential']),
  fields: z.array(esignFieldSchema),
  settings: esignSettingsSchema,
  /** Every page has its image and every party has at least one field: can be sent. */
  ready: z.boolean(),
  created_by: z.string().nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type EsignTemplate = z.infer<typeof esignTemplateSchema>;

const partiesInput = z
  .array(esignPartySchema)
  .min(1)
  .max(10)
  .refine(
    (list) => new Set(list.map((p) => p.id)).size === list.length,
    'party ids must be unique',
  );
const fieldsInput = z
  .array(esignFieldSchema)
  .max(500)
  .refine(
    (list) => new Set(list.map((f) => f.id)).size === list.length,
    'field ids must be unique',
  );

export const createEsignTemplateSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  parties: partiesInput.optional(),
  signing_order: z.enum(['parallel', 'sequential']).optional(),
  fields: fieldsInput.optional(),
  settings: esignSettingsSchema.partial().optional(),
});
export type CreateEsignTemplateInput = z.input<typeof createEsignTemplateSchema>;

export const updateEsignTemplateSchema = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  status: z.enum(ESIGN_TEMPLATE_STATUSES).optional(),
  parties: partiesInput.optional(),
  signing_order: z.enum(['parallel', 'sequential']).optional(),
  fields: fieldsInput.optional(),
  settings: esignSettingsSchema.partial().optional(),
});
export type UpdateEsignTemplateInput = z.input<typeof updateEsignTemplateSchema>;

export const listEsignTemplatesQuerySchema = z.object({
  ...listQuery,
  status: z.enum(ESIGN_TEMPLATE_STATUSES).optional(),
  q: z.string().trim().max(200).optional(),
});
export type ListEsignTemplatesQuery = z.infer<typeof listEsignTemplatesQuerySchema>;

export const esignTemplateParamSchema = z.object({ templateId: idSchema });
export const esignPageParamSchema = z.object({
  templateId: idSchema,
  page: z.coerce
    .number()
    .int()
    .min(0)
    .max(ESIGN_MAX_PAGES - 1),
});
export const uploadEsignPdfQuerySchema = z.object({ filename: z.string().max(255).optional() });
export const uploadEsignPageImageQuerySchema = z.object({
  /** SHA-256 of the document the image was rendered from (refused after a newer upload). */
  source_sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export const esignDocumentQuerySchema = z.object({
  kind: z.enum(['completed', 'original']).default('completed'),
  download: z.enum(['true', 'false']).optional(),
});

// -------------------------------------------------------------- requests

export const esignSignerSchema = z.object({
  id: idSchema,
  party_id: z.string(),
  party_name: z.string(),
  position: z.number().int(),
  contact_id: z.string().nullable(),
  email: z.string(),
  name: z.string(),
  status: z.enum(ESIGN_SIGNER_STATUSES),
  sent_at: timestampSchema.nullable(),
  opened_at: timestampSchema.nullable(),
  completed_at: timestampSchema.nullable(),
  declined_at: timestampSchema.nullable(),
  decline_reason: z.string().nullable(),
  reminders_sent: z.number().int(),
  next_reminder_at: timestampSchema.nullable(),
  otp_verified_at: timestampSchema.nullable(),
});
export type EsignSigner = z.infer<typeof esignSignerSchema>;

export const esignRequestSchema = z.object({
  id: idSchema,
  template_id: idSchema,
  name: z.string(),
  status: z.enum(ESIGN_REQUEST_STATUSES),
  signing_order: z.enum(['parallel', 'sequential']),
  origin: z.enum(['manual', 'api', 'automation']),
  message: z.string(),
  locale: z.string(),
  source_sha256: z.string(),
  completed_sha256: z.string().nullable(),
  /** The signed PDF is stored and can be downloaded. */
  document_ready: z.boolean(),
  /** Last sealing error; with `finalize_next_attempt_at` null the automatic attempts gave up and staff can retry. */
  finalize_error: z.string().nullable(),
  /** Next automatic sealing attempt (or the end of the running one); null when none is planned. */
  finalize_next_attempt_at: timestampSchema.nullable(),
  expires_at: timestampSchema.nullable(),
  completed_at: timestampSchema.nullable(),
  declined_at: timestampSchema.nullable(),
  voided_at: timestampSchema.nullable(),
  void_reason: z.string().nullable(),
  created_by: z.string().nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  signers: z.array(esignSignerSchema),
});
export type EsignRequest = z.infer<typeof esignRequestSchema>;

export const ESIGN_EVENT_TYPES = [
  'created',
  'sent',
  'reminder_requested',
  'reminder_sent',
  'notify_failed',
  'link_copied',
  'opened',
  'otp_sent',
  'otp_failed',
  'otp_verified',
  'consent_given',
  'signed',
  'declined',
  'completed',
  'document_sealed',
  'voided',
  'expired',
  'downloaded',
  'link_rotated',
] as const;
export type EsignEventType = (typeof ESIGN_EVENT_TYPES)[number];

export const esignEventSchema = z.object({
  id: idSchema,
  signer_id: z.string().nullable(),
  type: z.string(),
  actor: z.object({ type: z.string(), id: z.string().nullable() }),
  ip: z.string().nullable(),
  user_agent: z.string().nullable(),
  country: z.string().nullable(),
  meta: z.record(z.string(), z.unknown()),
  occurred_at: timestampSchema,
});
export type EsignEvent = z.infer<typeof esignEventSchema>;

export const esignRequestDetailSchema = esignRequestSchema.extend({
  events: z.array(esignEventSchema),
  fields: z.array(esignFieldSchema),
  parties: z.array(esignPartySchema),
});
export type EsignRequestDetail = z.infer<typeof esignRequestDetailSchema>;

export const esignSignerInputSchema = z
  .strictObject({
    party_id: partyIdSchema,
    /** An existing contact (its primary email unless `email` is given)… */
    contact_id: idSchema.optional(),
    /** …or an email (matched to a contact, created when missing). */
    email: z.email().max(320).optional(),
    name: z.string().trim().max(200).optional(),
  })
  .refine((s) => s.contact_id !== undefined || s.email !== undefined, {
    message: 'contact_id or email is required',
    path: ['email'],
  });
export type EsignSignerInput = z.infer<typeof esignSignerInputSchema>;

export const createEsignRequestSchema = z.strictObject({
  template_id: idSchema,
  signers: z.array(esignSignerInputSchema).min(1).max(10),
  /** Overrides the template invitation message. */
  message: z.string().trim().max(5000).optional(),
  /** Overrides the template expiry (days; null: never). */
  expire_days: z.number().int().min(1).max(365).nullable().optional(),
  locale: z.enum(['en', 'it']).optional(),
});
export type CreateEsignRequestInput = z.infer<typeof createEsignRequestSchema>;

export const listEsignRequestsQuerySchema = z.object({
  ...listQuery,
  status: z.enum(ESIGN_REQUEST_STATUSES).optional(),
  template_id: idSchema.optional(),
  contact_id: idSchema.optional(),
});
export type ListEsignRequestsQuery = z.infer<typeof listEsignRequestsQuerySchema>;

export const esignRequestParamSchema = z.object({ requestId: idSchema });
export const esignSignerParamSchema = z.object({ requestId: idSchema, signerId: idSchema });
export const voidEsignRequestSchema = z.strictObject({
  reason: z.string().trim().max(500).optional(),
});
export const esignSignerLinkSchema = z.object({ url: z.string() });
export const remindEsignRequestSchema = z.strictObject({
  /** Only this signer (default: every signer whose turn it is). */
  signer_id: idSchema.optional(),
});
