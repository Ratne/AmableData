import { z } from 'zod';
import { idSchema, optText, richTextSchema, timestampSchema } from './common';
import { addressSchema } from './contacts';
import { customFieldValuesSchema } from './custom-fields';

// ---------------------------------------------------------------- companies

const companyFields = {
  website: optText(2048),
  email: z.email().max(254).nullable().optional(),
  phone: optText(30),
  phone_extension: optText(10),
  fax: optText(30),
  address: addressSchema.nullable().optional(),
  description: optText(5000),
  owner_id: idSchema.nullable().optional(),
  custom_fields: customFieldValuesSchema.optional(),
};

export const createCompanySchema = z.strictObject({
  name: z.string().trim().min(1).max(255),
  ...companyFields,
});
export type CreateCompanyInput = z.infer<typeof createCompanySchema>;

export const updateCompanySchema = z.strictObject({
  name: z.string().trim().min(1).max(255).optional(),
  ...companyFields,
});
export type UpdateCompanyInput = z.infer<typeof updateCompanySchema>;

export const companySchema = z.object({
  id: idSchema,
  name: z.string(),
  website: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  phone_extension: z.string().nullable(),
  fax: z.string().nullable(),
  address: z
    .object({
      line1: z.string().nullable(),
      line2: z.string().nullable(),
      locality: z.string().nullable(),
      region: z.string().nullable(),
      postal_code: z.string().nullable(),
      country_code: z.string().nullable(),
    })
    .nullable(),
  description: z.string().nullable(),
  owner_id: idSchema.nullable(),
  contact_count: z.number().int(),
  custom_fields: customFieldValuesSchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
  deleted_at: timestampSchema.nullable(),
});
export type Company = z.infer<typeof companySchema>;

export const listCompaniesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
  q: z.string().max(200).optional(),
  owner_id: idSchema.optional(),
});
export type ListCompaniesQuery = z.infer<typeof listCompaniesQuerySchema>;

// --------------------------------------------------------------------- tags

export const createTagCategorySchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  description: optText(1000),
});
export const updateTagCategorySchema = createTagCategorySchema.partial();
export type CreateTagCategoryInput = z.infer<typeof createTagCategorySchema>;
export type UpdateTagCategoryInput = z.infer<typeof updateTagCategorySchema>;

export const tagCategorySchema = z.object({
  id: idSchema,
  name: z.string(),
  description: z.string().nullable(),
  created_at: timestampSchema,
});
export type TagCategory = z.infer<typeof tagCategorySchema>;

export const createTagSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  description: optText(1000),
  category_id: idSchema.nullable().optional(),
});
export const updateTagSchema = createTagSchema.partial();
export type CreateTagInput = z.infer<typeof createTagSchema>;
export type UpdateTagInput = z.infer<typeof updateTagSchema>;

export const tagSchema = z.object({
  id: idSchema,
  name: z.string(),
  description: z.string().nullable(),
  category_id: idSchema.nullable(),
  contact_count: z.number().int(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type Tag = z.infer<typeof tagSchema>;

export const listTagsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
  category_id: idSchema.optional(),
  /** Substring of the name (legacy filter, kept for API clients). */
  name: z.string().max(100).optional(),
  /**
   * Search as you type: names starting with `q` first (served by the name
   * index), then names containing it; both case-insensitive, by name.
   */
  q: z.string().trim().max(100).optional(),
  /** Comma-separated tag ids (max 100): fetch those tags only, ignoring the other filters. */
  ids: z
    .string()
    .max(100 * 65)
    .refine((text) => text.split(',').filter((id) => id.trim() !== '').length <= 100, 'at most 100 ids')
    .optional(),
});
export type ListTagsQuery = z.infer<typeof listTagsQuerySchema>;

export const tagContactsSchema = z.strictObject({
  contact_ids: z.array(idSchema).min(1).max(1000),
});
export type TagContactsInput = z.infer<typeof tagContactsSchema>;

export const tagContactsResultSchema = z.object({
  tag_id: idSchema,
  /** Contacts whose tag set actually changed. */
  changed: z.number().int(),
  /** Requested ids that do not exist (or are deleted). */
  missing_contact_ids: z.array(idSchema),
});
export type TagContactsResult = z.infer<typeof tagContactsResultSchema>;

// -------------------------------------------------------------------- notes

export const NOTE_TYPES = ['note', 'call', 'email', 'meeting', 'other'] as const;

export const createNoteSchema = z.strictObject({
  contact_id: idSchema.nullable().optional(),
  company_id: idSchema.nullable().optional(),
  opportunity_id: idSchema.nullable().optional(),
  title: optText(255),
  type: z.enum(NOTE_TYPES).optional(),
  body: richTextSchema,
  pinned: z.boolean().optional(),
});
export type CreateNoteInput = z.infer<typeof createNoteSchema>;

export const updateNoteSchema = z.strictObject({
  title: optText(255),
  type: z.enum(NOTE_TYPES).optional(),
  body: richTextSchema.optional(),
  pinned: z.boolean().optional(),
});
export type UpdateNoteInput = z.infer<typeof updateNoteSchema>;

export const noteSchema = z.object({
  id: idSchema,
  contact_id: idSchema.nullable(),
  company_id: idSchema.nullable(),
  opportunity_id: idSchema.nullable(),
  title: z.string().nullable(),
  type: z.enum(NOTE_TYPES),
  body: richTextSchema,
  body_text: z.string(),
  pinned: z.boolean(),
  created_by: z.string().nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type Note = z.infer<typeof noteSchema>;

export const listNotesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
  contact_id: idSchema.optional(),
  company_id: idSchema.optional(),
  opportunity_id: idSchema.optional(),
});
export type ListNotesQuery = z.infer<typeof listNotesQuerySchema>;
