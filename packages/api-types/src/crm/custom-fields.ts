import { z } from 'zod';
import { idSchema, timestampSchema } from './common';

/** The 24 supported custom field types. */
export const CUSTOM_FIELD_TYPES = [
  'CURRENCY',
  'DATE',
  'DATE_TIME',
  'DAY_OF_WEEK',
  'DECIMAL_NUMBER',
  'DRILLDOWN',
  'DROPDOWN',
  'EMAIL',
  'LIST_BOX',
  'MONTH',
  'NAME',
  'PERCENT',
  'PHONE_NUMBER',
  'RADIO',
  'SOCIAL_SECURITY_NUMBER',
  'STATE',
  'TEXT',
  'TEXT_AREA',
  'USER',
  'USER_LIST_BOX',
  'WEBSITE',
  'WHOLE_NUMBER',
  'YEAR',
  'YES_NO',
] as const;
export const customFieldTypeSchema = z.enum(CUSTOM_FIELD_TYPES);
export type CustomFieldType = z.infer<typeof customFieldTypeSchema>;

/** Types whose value must be one (or more) of the declared options. */
export const OPTION_FIELD_TYPES: readonly CustomFieldType[] = [
  'DROPDOWN',
  'RADIO',
  'LIST_BOX',
  'DRILLDOWN',
];

export const CUSTOM_FIELD_ENTITIES = ['contact', 'company', 'opportunity', 'order'] as const;
export const customFieldEntitySchema = z.enum(CUSTOM_FIELD_ENTITIES);
export type CustomFieldEntity = z.infer<typeof customFieldEntitySchema>;

/** Plural path segment used by `/customFields/{entity}`. */
export const customFieldEntityPathSchema = z.enum([
  'contacts',
  'companies',
  'opportunities',
  'orders',
]);
export type CustomFieldEntityPath = z.infer<typeof customFieldEntityPathSchema>;

export const CUSTOM_FIELD_ENTITY_BY_PATH: Readonly<
  Record<CustomFieldEntityPath, CustomFieldEntity>
> = { contacts: 'contact', companies: 'company', opportunities: 'opportunity', orders: 'order' };

const optionValue = z.string().trim().min(1).max(100);
const optionLabel = z.string().trim().min(1).max(255);

// DRILLDOWN options nest up to three levels (bounded so the OpenAPI schema stays finite).
const optionLevel3 = z.strictObject({ value: optionValue, label: optionLabel });
const optionLevel2 = z.strictObject({
  value: optionValue,
  label: optionLabel,
  children: z.array(optionLevel3).max(200).optional(),
});
export const customFieldOptionSchema = z.strictObject({
  value: optionValue,
  label: optionLabel,
  children: z.array(optionLevel2).max(200).optional(),
});
export type CustomFieldOption = z.infer<typeof customFieldOptionSchema>;

export const customFieldConfigSchema = z.strictObject({
  /** CURRENCY: ISO 4217 code. */
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  /** CURRENCY / DECIMAL_NUMBER / PERCENT: max decimal places. */
  decimals: z.number().int().min(0).max(6).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  /** TEXT / TEXT_AREA / NAME: max characters. */
  max_length: z.number().int().min(1).max(65_535).optional(),
  /** SOCIAL_SECURITY_NUMBER: 'us_ssn' (NNN-NN-NNNN) or 'generic' national id. */
  format: z.enum(['us_ssn', 'generic']).optional(),
});
export type CustomFieldConfig = z.infer<typeof customFieldConfigSchema>;

/** Raw value accepted on input; validated and normalized per field type server-side. */
export const customFieldValueInputSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.null(),
]);
export type CustomFieldValueInput = z.infer<typeof customFieldValueInputSchema>;

/** `custom_fields` map on entities, keyed by the field `key`. */
export const customFieldValuesSchema = z.record(z.string(), customFieldValueInputSchema);
export type CustomFieldValues = z.infer<typeof customFieldValuesSchema>;

export const customFieldKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,62}$/, 'lowercase letters, digits and underscores');

export const createCustomFieldSchema = z.strictObject({
  key: customFieldKeySchema,
  label: z.string().trim().min(1).max(255),
  type: customFieldTypeSchema,
  group_id: idSchema.nullable().optional(),
  position: z.number().int().min(0).optional(),
  options: z.array(customFieldOptionSchema).max(500).optional(),
  config: customFieldConfigSchema.optional(),
  required: z.boolean().optional(),
  /** Masked for roles without `contacts:read_sensitive`. Defaults to true for SSN. */
  sensitive: z.boolean().optional(),
});
export type CreateCustomFieldInput = z.infer<typeof createCustomFieldSchema>;

export const updateCustomFieldSchema = z.strictObject({
  label: z.string().trim().min(1).max(255).optional(),
  group_id: idSchema.nullable().optional(),
  position: z.number().int().min(0).optional(),
  options: z.array(customFieldOptionSchema).max(500).optional(),
  config: customFieldConfigSchema.optional(),
  required: z.boolean().optional(),
  sensitive: z.boolean().optional(),
});
export type UpdateCustomFieldInput = z.infer<typeof updateCustomFieldSchema>;

export const customFieldSchema = z.object({
  id: idSchema,
  entity: customFieldEntitySchema,
  key: z.string(),
  label: z.string(),
  type: customFieldTypeSchema,
  group_id: idSchema.nullable(),
  position: z.number().int(),
  options: z.array(customFieldOptionSchema),
  config: customFieldConfigSchema,
  required: z.boolean(),
  sensitive: z.boolean(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  /** Marketplace app that owns the field (declared in its manifest); null for fields created by users. */
  owner_app_id: z.string().nullable().optional(),
});
export type CustomField = z.infer<typeof customFieldSchema>;

export const createCustomFieldTabSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  position: z.number().int().min(0).optional(),
});
export const updateCustomFieldTabSchema = createCustomFieldTabSchema.partial();
export type CreateCustomFieldTabInput = z.infer<typeof createCustomFieldTabSchema>;
export type UpdateCustomFieldTabInput = z.infer<typeof updateCustomFieldTabSchema>;

export const customFieldTabSchema = z.object({
  id: idSchema,
  entity: customFieldEntitySchema,
  name: z.string(),
  position: z.number().int(),
});
export type CustomFieldTab = z.infer<typeof customFieldTabSchema>;

export const createCustomFieldGroupSchema = z.strictObject({
  tab_id: idSchema,
  name: z.string().trim().min(1).max(100),
  position: z.number().int().min(0).optional(),
});
export const updateCustomFieldGroupSchema = createCustomFieldGroupSchema.partial();
export type CreateCustomFieldGroupInput = z.infer<typeof createCustomFieldGroupSchema>;
export type UpdateCustomFieldGroupInput = z.infer<typeof updateCustomFieldGroupSchema>;

export const customFieldGroupSchema = z.object({
  id: idSchema,
  tab_id: idSchema,
  name: z.string(),
  position: z.number().int(),
});
export type CustomFieldGroup = z.infer<typeof customFieldGroupSchema>;

/** Tabs -> groups -> fields, plus fields not assigned to any group. */
export const customFieldLayoutSchema = z.object({
  tabs: z.array(
    customFieldTabSchema.extend({
      groups: z.array(customFieldGroupSchema.extend({ fields: z.array(customFieldSchema) })),
    }),
  ),
  ungrouped: z.array(customFieldSchema),
});
export type CustomFieldLayout = z.infer<typeof customFieldLayoutSchema>;
