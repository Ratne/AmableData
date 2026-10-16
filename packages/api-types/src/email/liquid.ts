import { z } from 'zod';
import { customFieldTypeSchema } from '../crm/custom-fields';
import { idSchema } from '../crm/common';

/**
 * Liquid helper: the schema of the recipient render context (what `{{ … }}`
 * can read in emails and Dynamic Content snippets) and the live preview of a
 * template for a real contact, rendered by the send-time sandbox.
 */

export const LIQUID_VALUE_KINDS = ['string', 'number', 'boolean', 'date', 'list', 'url', 'html'] as const;
export const liquidValueKindSchema = z.enum(LIQUID_VALUE_KINDS);
export type LiquidValueKind = z.infer<typeof liquidValueKindSchema>;

export const LIQUID_FIELD_GROUPS = ['contact', 'custom', 'company', 'owner', 'snippets', 'system'] as const;
export const liquidFieldGroupSchema = z.enum(LIQUID_FIELD_GROUPS);
export type LiquidSchemaGroup = z.infer<typeof liquidFieldGroupSchema>;

export const liquidSchemaFieldSchema = z.object({
  /** Dotted path, e.g. `contact.first_name`, `contact.custom.vip_level`; `now` for the current date. */
  path: z.string(),
  group: liquidFieldGroupSchema,
  kind: liquidValueKindSchema,
  /** Custom field label or snippet name; built-in fields are labelled by the client. */
  label: z.string().nullable(),
  custom_field_type: customFieldTypeSchema.nullable(),
  /** Choice values of dropdown / radio / list custom fields. */
  options: z.array(z.string()),
  /** Masked for the caller (sensitive custom field without `contacts:read_sensitive`). */
  masked: z.boolean(),
  example: z.string().nullable(),
});
export type LiquidSchemaField = z.infer<typeof liquidSchemaFieldSchema>;

export const liquidSchemaSchema = z.object({
  fields: z.array(liquidSchemaFieldSchema),
  /** Filters accepted by the sandbox (unknown filters are an error). */
  filters: z.array(z.string()),
  /** Tags Liquid supports in templates. */
  tags: z.array(z.string()),
  limits: z.object({
    template_bytes: z.number().int(),
    render_ms: z.number().int(),
    snippet_render_ms: z.number().int(),
    memory_bytes: z.number().int(),
  }),
});
export type LiquidSchema = z.infer<typeof liquidSchemaSchema>;

export const liquidPreviewInputSchema = z.strictObject({
  template: z.string().max(200_000),
  /** Omit to render with sample data. */
  contact_id: idSchema.optional(),
  /** `html` escapes output like an email body; `text` like a subject or plain-text part. */
  format: z.enum(['html', 'text']).default('text'),
});
export type LiquidPreviewInput = z.input<typeof liquidPreviewInputSchema>;

export const liquidIssueSchema = z.object({
  message: z.string(),
  line: z.number().int().nullable(),
  column: z.number().int().nullable(),
});
export type LiquidPreviewIssue = z.infer<typeof liquidIssueSchema>;

export const liquidPreviewSchema = z.object({
  ok: z.boolean(),
  output: z.string(),
  errors: z.array(liquidIssueSchema),
  /** Global variables the template reads. */
  variables: z.array(z.string()),
  /** Known variables that are empty for this contact (the fallback, if any, is used). */
  missing: z.array(z.string()),
  /** Variables that are not part of the render context (probably a typo). */
  unknown: z.array(z.string()),
  contact_id: idSchema.nullable(),
});
export type LiquidPreview = z.infer<typeof liquidPreviewSchema>;
