import { z } from 'zod';
import { idSchema, timestampSchema } from '../crm/common';

/**
 * Forms REST v2 schemas: forms (definition JSON validated server-side by
 * @amable/forms), decrypted submissions with their delivery log, and per-form
 * connections to external tools (signed webhook, Google Sheets, email
 * notification, DocuSeal).
 */

const listQuery = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
};

// ------------------------------------------------------------------ forms

export const FORM_STATUSES = ['active', 'inactive'] as const;
export const formStatusSchema = z.enum(FORM_STATUSES);
export type FormStatus = z.infer<typeof formStatusSchema>;

/** Form definition document (fields, settings, style, crm) — see `formDefinitionSchema` in @amable/forms. */
export const formDefinitionJsonSchema = z
  .record(z.string(), z.unknown())
  .describe('Form definition: { fields, settings, style, crm } (schema of @amable/forms)');

export const createFormSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  status: formStatusSchema.optional(),
  /** Omitted: a starter form (name, email, privacy consent). */
  definition: formDefinitionJsonSchema.optional(),
});
export type CreateFormInput = z.infer<typeof createFormSchema>;

export const updateFormSchema = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  status: formStatusSchema.optional(),
  definition: formDefinitionJsonSchema.optional(),
});
export type UpdateFormInput = z.infer<typeof updateFormSchema>;

const formBase = {
  id: idSchema,
  name: z.string(),
  status: formStatusSchema,
  archived: z.boolean(),
  submission_count: z.number().int(),
  last_submission_at: timestampSchema.nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  archived_at: timestampSchema.nullable(),
};

export const formSummarySchema = z.object({
  ...formBase,
  field_count: z.number().int(),
  connection_count: z.number().int(),
});
export type FormSummary = z.infer<typeof formSummarySchema>;

export const formSchema = z.object({ ...formBase, definition: formDefinitionJsonSchema });
export type Form = z.infer<typeof formSchema>;

export const listFormsQuerySchema = z.object({
  ...listQuery,
  /** `archived` lists archived forms only; default excludes them. */
  status: z.enum(['active', 'inactive', 'archived']).optional(),
  q: z.string().trim().max(200).optional(),
});
export type ListFormsQuery = z.infer<typeof listFormsQuerySchema>;

export const formEmbedSchema = z.object({
  form_id: idSchema,
  tenant: z.string(),
  script_url: z.string(),
  config_url: z.string(),
  hosted_url: z.string(),
  hosted_enabled: z.boolean(),
  /** HTML to paste in a page. */
  snippet: z.string(),
});
export type FormEmbed = z.infer<typeof formEmbedSchema>;

export const formIdParamSchema = z.object({ formId: idSchema });

// ------------------------------------------------------------ submissions

export const SUBMISSION_STATUSES = ['pending', 'processed', 'failed'] as const;
export const submissionStatusSchema = z.enum(SUBMISSION_STATUSES);
export type SubmissionStatus = z.infer<typeof submissionStatusSchema>;

export const DELIVERY_STATUSES = ['success', 'failed', 'skipped', 'retrying'] as const;
export const deliveryStatusSchema = z.enum(DELIVERY_STATUSES);
export type DeliveryStatus = z.infer<typeof deliveryStatusSchema>;

export const formDeliverySchema = z.object({
  id: idSchema,
  connection_id: idSchema,
  connection_name: z.string(),
  connection_type: z.string(),
  status: deliveryStatusSchema,
  attempts: z.number().int(),
  status_code: z.number().int().nullable(),
  /** Short description of the outgoing request (secrets and bodies redacted). */
  request: z.string().nullable(),
  response: z.string().nullable(),
  updated_at: timestampSchema,
});
export type FormDelivery = z.infer<typeof formDeliverySchema>;

export const submissionSourceSchema = z.object({
  utm_source: z.string().nullable(),
  utm_medium: z.string().nullable(),
  utm_campaign: z.string().nullable(),
  utm_term: z.string().nullable(),
  utm_content: z.string().nullable(),
  referrer: z.string().nullable(),
  page_url: z.string().nullable(),
  page_id: z.string().nullable(),
  country: z.string().nullable(),
  visitor_id: z.string().nullable(),
});
export type SubmissionSource = z.infer<typeof submissionSourceSchema>;

export const formSubmissionSchema = z.object({
  id: idSchema,
  form_id: idSchema,
  status: submissionStatusSchema,
  contact_id: idSchema.nullable(),
  contact_created: z.boolean(),
  error: z.string().nullable(),
  /** Values the CRM rejected (e.g. an invalid custom field value) while the rest was saved. */
  warnings: z.array(z.string()),
  attempts: z.number().int(),
  /** Decrypted field values, keyed by field key. */
  values: z.record(z.string(), z.unknown()),
  /** Auto-captured tracking parameters (utm_*, click ids). */
  tracking: z.record(z.string(), z.string()),
  source: submissionSourceSchema,
  created_at: timestampSchema,
  processed_at: timestampSchema.nullable(),
  deliveries: z.array(formDeliverySchema),
});
export type FormSubmission = z.infer<typeof formSubmissionSchema>;

export const listSubmissionsQuerySchema = z.object({
  ...listQuery,
  status: submissionStatusSchema.optional(),
  contact_id: idSchema.optional(),
});
export type ListSubmissionsQuery = z.infer<typeof listSubmissionsQuerySchema>;

export const submissionParamSchema = z.object({ formId: idSchema, submissionId: idSchema });

/** A submission of the contact, metadata only (values stay encrypted). */
export const contactSubmissionSchema = z.object({
  id: idSchema,
  form_id: idSchema,
  form_name: z.string(),
  /** The form was deleted since (its submissions are kept). */
  form_deleted: z.boolean(),
  status: submissionStatusSchema,
  contact_created: z.boolean(),
  page_url: z.string().nullable(),
  page_id: z.string().nullable(),
  /** Title of the landing page the form was submitted on, when `page_id` is one of the tenant's pages. */
  page_title: z.string().nullable(),
  created_at: timestampSchema,
  processed_at: timestampSchema.nullable(),
});
export type ContactSubmission = z.infer<typeof contactSubmissionSchema>;

export const listContactSubmissionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(512).optional(),
});
export type ListContactSubmissionsQuery = z.infer<typeof listContactSubmissionsQuerySchema>;

export const contactSubmissionParamSchema = z.object({ id: idSchema, submissionId: idSchema });

/** One decrypted value, labelled and rendered as text; `masked` when the caller may not read it in clear. */
export const contactSubmissionEntrySchema = z.object({
  key: z.string(),
  label: z.string(),
  /** Booleans stay booleans (the UI localizes them); everything else is display text. */
  value: z.union([z.string(), z.boolean()]),
  masked: z.boolean(),
});
export type ContactSubmissionEntry = z.infer<typeof contactSubmissionEntrySchema>;

export const contactSubmissionDetailSchema = contactSubmissionSchema.extend({
  error: z.string().nullable(),
  warnings: z.array(z.string()),
  /** Values in form field order (keys no longer in the form come last). */
  entries: z.array(contactSubmissionEntrySchema),
  tracking: z.record(z.string(), z.string()),
  source: submissionSourceSchema,
});
export type ContactSubmissionDetail = z.infer<typeof contactSubmissionDetailSchema>;

// ------------------------------------------------------------ connections

export const CONNECTOR_TYPES = ['webhook', 'google_sheets', 'email_notification', 'docuseal', 'app'] as const;
export const connectorTypeSchema = z.enum(CONNECTOR_TYPES);
export type ConnectorType = z.infer<typeof connectorTypeSchema>;

/**
 * Merge tag / source of a value: a field key, or one of `submission_id`,
 * `form_id`, `form_name`, `submitted_at`, `contact_id`, `page_url`,
 * `referrer`, `utm_*`.
 */
const sourceKeySchema = z.string().trim().min(1).max(100);
const headerNameSchema = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
const httpUrl = z.url({ protocol: /^https?$/ }).max(2048);

export const webhookConfigSchema = z.strictObject({
  url: httpUrl,
  method: z.enum(['POST', 'PUT', 'PATCH']).default('POST'),
  format: z.enum(['json', 'form']).default('json'),
  headers: z.record(headerNameSchema, z.string().max(1000)).default({}),
  /** Empty: every field plus submission facts. */
  field_map: z
    .array(z.strictObject({ source: sourceKeySchema, target: z.string().trim().min(1).max(100) }))
    .max(100)
    .default([]),
  /**
   * JSON format only: a JSON object whose string values may hold `{{key}}`
   * merge tags (field keys and submission facts). Wins over `field_map`.
   */
  body_template: z
    .string()
    .max(20_000)
    .refine(isJsonObjectText, 'expected a JSON object')
    .nullable()
    .optional(),
});
export type WebhookConfig = z.infer<typeof webhookConfigSchema>;

function isJsonObjectText(text: string): boolean {
  if (text.trim() === '') return true;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/** The spreadsheet is written as the service account whose JSON key is the connection secret. */
export const googleSheetsConfigSchema = z.strictObject({
  spreadsheet_id: z.string().trim().regex(/^[A-Za-z0-9_-]{10,200}$/, 'invalid spreadsheet id'),
  sheet_name: z.string().trim().min(1).max(100).default('Sheet1'),
  /** Empty: submission date then every field, in form order. */
  columns: z
    .array(
      z.strictObject({
        source: sourceKeySchema,
        column: z
          .string()
          .trim()
          .regex(/^[A-Za-z]{1,3}$/, 'expected a column letter')
          .transform((s) => s.toUpperCase()),
      }),
    )
    .max(200)
    .default([]),
});
export type GoogleSheetsConfig = z.infer<typeof googleSheetsConfigSchema>;

export const emailNotificationConfigSchema = z.strictObject({
  recipients: z.array(z.email().max(254)).min(1).max(10),
  /** Supports merge tags, e.g. `New lead: {{first_name}}`. */
  subject: z.string().trim().min(1).max(200).default('New submission: {{form_name}}'),
});
export type EmailNotificationConfig = z.infer<typeof emailNotificationConfigSchema>;

export const docusealConfigSchema = z
  .strictObject({
    region: z.enum(['global', 'eu', 'custom']).default('global'),
    /** Self-hosted DocuSeal: API root, e.g. https://sign.example.com/api. */
    base_url: z.union([z.literal(''), httpUrl]).default(''),
    template_id: z.number().int().positive(),
    /** Signer role in the template; empty: the first role. */
    role: z.string().trim().max(100).default(''),
    email_source: sourceKeySchema.default('email'),
    /** Empty: first and last name fields mapped to the contact. */
    name_source: z.string().trim().max(100).default(''),
    subject: z.string().trim().max(250).default(''),
    message: z.string().max(5000).default(''),
    prefill: z
      .array(z.strictObject({ source: sourceKeySchema, field: z.string().trim().min(1).max(200) }))
      .max(100)
      .default([]),
    send_email: z.boolean().default(true),
  })
  .refine((c) => c.region !== 'custom' || c.base_url !== '', {
    path: ['base_url'],
    message: 'required for a self-hosted server',
  });
export type DocusealConfig = z.infer<typeof docusealConfigSchema>;

/** Destination provided by an installed app (`extensions.form_connectors` in its manifest). */
export const appConnectorConfigSchema = z.strictObject({
  app_id: z.string().regex(/^[a-z][a-z0-9-]{2,39}$/),
  key: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
  /** Validated against the connector's `settings_schema`. */
  settings: z.record(z.string().max(64), z.unknown()).default({}),
});
export type AppConnectorConfig = z.infer<typeof appConnectorConfigSchema>;

const connectionCommon = {
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().optional(),
};

export const createConnectionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('webhook'), ...connectionCommon, config: webhookConfigSchema }),
  z.strictObject({
    type: z.literal('google_sheets'),
    ...connectionCommon,
    config: googleSheetsConfigSchema,
    /** JSON key of the Google service account (encrypted at rest, never returned). */
    secret: z.string().trim().min(1).max(10_000),
  }),
  z.strictObject({
    type: z.literal('email_notification'),
    ...connectionCommon,
    config: emailNotificationConfigSchema,
  }),
  z.strictObject({
    type: z.literal('docuseal'),
    ...connectionCommon,
    config: docusealConfigSchema,
    /** DocuSeal API key (encrypted at rest, never returned). */
    secret: z.string().trim().min(1).max(500),
  }),
  z.strictObject({ type: z.literal('app'), ...connectionCommon, config: appConnectorConfigSchema }),
]);
export type CreateConnectionInput = z.infer<typeof createConnectionSchema>;

export const updateConnectionSchema = z.strictObject({
  name: z.string().trim().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
  /** Full replacement, validated against the connection type. */
  config: z.record(z.string(), z.unknown()).optional(),
  /** New API key (DocuSeal) or service account key (Google Sheets). */
  secret: z.string().trim().min(1).max(10_000).optional(),
});
export type UpdateConnectionInput = z.infer<typeof updateConnectionSchema>;

export const formConnectionSchema = z.object({
  id: idSchema,
  form_id: idSchema,
  type: connectorTypeSchema,
  name: z.string(),
  enabled: z.boolean(),
  config: z.record(z.string(), z.unknown()),
  has_secret: z.boolean(),
  /** Last characters of the secret, to recognize it; the service account email for Google Sheets. */
  secret_hint: z.string().nullable(),
  last_delivery: z
    .object({ status: deliveryStatusSchema, at: timestampSchema })
    .nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type FormConnection = z.infer<typeof formConnectionSchema>;

/** Create / rotate answer: the webhook signing secret is shown once. */
export const formConnectionWithSecretSchema = formConnectionSchema.extend({
  signing_secret: z.string().nullable(),
});
export type FormConnectionWithSecret = z.infer<typeof formConnectionWithSecretSchema>;

export const connectionParamSchema = z.object({ formId: idSchema, connectionId: idSchema });

export const connectorInfoSchema = z.object({
  type: connectorTypeSchema,
  /** `generated`: signing secret created by us; `api_key`: provided by the user. */
  secret: z.enum(['none', 'generated', 'api_key']),
  oauth_provider: z.enum(['google']).nullable(),
  /** False when the installation cannot run it (e.g. no OAuth service). */
  available: z.boolean(),
  /** `type: 'app'`: one entry per connector of each installed app. */
  app: z
    .object({
      app_id: z.string(),
      key: z.string(),
      app_name: z.string(),
      name: z.object({ en: z.string(), it: z.string().optional() }),
      icon_url: z.string().nullable(),
      description: z.object({ en: z.string(), it: z.string().optional() }).nullable(),
      /** App input schema (`properties`, `required`) for the settings form. */
      settings_schema: z.record(z.string(), z.unknown()).nullable(),
      paused: z.boolean(),
    })
    .optional(),
});
export type ConnectorInfo = z.infer<typeof connectorInfoSchema>;

export const connectionTestResultSchema = z.object({
  status: deliveryStatusSchema,
  status_code: z.number().int().nullable(),
  request: z.string().nullable(),
  response: z.string().nullable(),
});
export type ConnectionTestResult = z.infer<typeof connectionTestResultSchema>;
