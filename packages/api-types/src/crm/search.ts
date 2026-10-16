import { z } from 'zod';
import { idSchema, timestampSchema } from './common';
import { sourceTypeSchema } from './contacts';

/**
 * Query builder JSON. A query targets one entity, optionally combines free-text
 * search (`q`, FTS) with a boolean filter tree, and selects columns, sort and a
 * cursor page. The same document is stored by saved searches and reused as a
 * segment by broadcasts and automations.
 */

export const SEARCH_ENTITIES = ['contact', 'company', 'order'] as const;
export const searchEntitySchema = z.enum(SEARCH_ENTITIES);
export type SearchEntity = z.infer<typeof searchEntitySchema>;

export const FIELD_OPERATORS = [
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'is_empty',
  'is_not_empty',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'in',
  'not_in',
] as const;
export const fieldOperatorSchema = z.enum(FIELD_OPERATORS);
export type FieldOperator = z.infer<typeof fieldOperatorSchema>;

const scalar = z.union([z.string().max(1000), z.number(), z.boolean()]);
export const conditionValueSchema = z.union([scalar, z.array(scalar).max(500), z.null()]);
export type ConditionValue = z.infer<typeof conditionValueSchema>;

/**
 * `field` is a built-in column (e.g. `given_name`, `email`, `owner_id`,
 * `created_at`) or `custom.<key>` for a custom field. Operators allowed depend
 * on the field kind (text, number, date, boolean, enum, multi).
 */
export const fieldConditionSchema = z.strictObject({
  type: z.literal('field'),
  field: z.string().min(1).max(100),
  operator: fieldOperatorSchema,
  /** Omitted for is_empty/is_not_empty; [from, to] for between; array for in/not_in. */
  value: conditionValueSchema.optional(),
});
export type FieldCondition = z.infer<typeof fieldConditionSchema>;

/** Tag filter: ANY of / ALL of / NONE of the given tags. */
export const tagConditionSchema = z.strictObject({
  type: z.literal('tags'),
  match: z.enum(['any', 'all', 'none']),
  tag_ids: z.array(idSchema).min(1).max(100),
});
export type TagCondition = z.infer<typeof tagConditionSchema>;

// Groups nest up to three levels (bounded so the OpenAPI schema stays finite).
const leaf = z.discriminatedUnion('type', [fieldConditionSchema, tagConditionSchema]);
const group3 = z.strictObject({
  type: z.literal('group'),
  op: z.enum(['and', 'or']),
  conditions: z.array(leaf).min(1).max(50),
});
const group2 = z.strictObject({
  type: z.literal('group'),
  op: z.enum(['and', 'or']),
  conditions: z
    .array(z.discriminatedUnion('type', [fieldConditionSchema, tagConditionSchema, group3]))
    .min(1)
    .max(50),
});
export const filterGroupSchema = z.strictObject({
  type: z.literal('group'),
  op: z.enum(['and', 'or']),
  conditions: z
    .array(z.discriminatedUnion('type', [fieldConditionSchema, tagConditionSchema, group2]))
    .max(50),
});

export type FilterLeaf = FieldCondition | TagCondition;
export interface FilterGroup {
  type: 'group';
  op: 'and' | 'or';
  conditions: Array<FilterLeaf | FilterGroup>;
}

export const sortSchema = z.strictObject({
  field: z.string().min(1).max(100),
  direction: z.enum(['asc', 'desc']).default('asc'),
});

export const searchQuerySchema = z.strictObject({
  entity: searchEntitySchema,
  /** Free text, matched with the full-text index (prefix match per word). */
  q: z.string().trim().max(200).optional(),
  filter: filterGroupSchema.optional(),
  /** Columns returned per row; `id` is always included. */
  columns: z.array(z.string().min(1).max(100)).max(50).optional(),
  sort: sortSchema.optional(),
  limit: z.number().int().min(1).max(500).optional(),
  cursor: z.string().max(1024).optional(),
  include_total: z.boolean().optional(),
});
export type SearchQueryInput = z.input<typeof searchQuerySchema>;
export type SearchQuery = z.infer<typeof searchQuerySchema>;

export const searchResultSchema = z.object({
  entity: searchEntitySchema,
  columns: z.array(z.string()),
  data: z.array(z.record(z.string(), z.unknown())),
  next_cursor: z.string().nullable(),
  total: z.number().int().nullable(),
});
export type SearchResult = z.infer<typeof searchResultSchema>;

export const GLOBAL_SEARCH_TYPES = ['contact', 'company', 'note', 'order'] as const;

export const globalSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  types: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type GlobalSearchQuery = z.infer<typeof globalSearchQuerySchema>;

export const globalSearchHitSchema = z.object({
  type: z.enum(GLOBAL_SEARCH_TYPES),
  id: idSchema,
  title: z.string(),
  snippet: z.string(),
  /** Lower is better (bm25), or 0 in fallback mode. */
  rank: z.number(),
});
export const globalSearchResponseSchema = z.object({
  mode: z.enum(['fts5', 'trigram']),
  data: z.array(globalSearchHitSchema),
});
export type GlobalSearchHit = z.infer<typeof globalSearchHitSchema>;
export type GlobalSearchResponse = z.infer<typeof globalSearchResponseSchema>;

// ---------------------------------------------------------- saved searches

export const createSavedSearchSchema = z.strictObject({
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().max(2000).nullable().optional(),
  /** `limit` and `cursor` are ignored when stored. */
  query: searchQuerySchema,
  /** Visible to every member of the tenant (default) or only to its owner. */
  shared: z.boolean().optional(),
});
export const updateSavedSearchSchema = createSavedSearchSchema.partial();
export type CreateSavedSearchInput = z.infer<typeof createSavedSearchSchema>;
export type UpdateSavedSearchInput = z.infer<typeof updateSavedSearchSchema>;

export const savedSearchSchema = z.object({
  id: idSchema,
  name: z.string(),
  description: z.string().nullable(),
  entity: searchEntitySchema,
  query: searchQuerySchema,
  shared: z.boolean(),
  owner_id: z.string().nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type SavedSearch = z.infer<typeof savedSearchSchema>;

export const executeSavedSearchSchema = z.strictObject({
  limit: z.number().int().min(1).max(500).optional(),
  cursor: z.string().max(1024).optional(),
  include_total: z.boolean().optional(),
});
export type ExecuteSavedSearchInput = z.infer<typeof executeSavedSearchSchema>;

// ------------------------------------------------------------- CSV import

/**
 * Column header -> target. Targets: a contact field (`given_name`, `email`,
 * `email2`, `phone`, `company_name`, `address.line1`, `utm_source`, …),
 * `tags` (tag names split by `list_delimiter`, created when missing),
 * `custom.<key>` or `ignore`.
 */
export const importMappingSchema = z.record(z.string().max(255), z.string().max(100));

export const createImportSchema = z.strictObject({
  entity: z.literal('contact'),
  mapping: importMappingSchema,
  options: z
    .strictObject({
      /** Match existing contacts by primary email and update them. Default true. */
      update_existing: z.boolean().optional(),
      /** Tags applied to every imported contact. */
      tag_ids: z.array(idSchema).max(50).optional(),
      /** Delimiter for multi-value cells (tags, LIST_BOX). Default ';'. */
      list_delimiter: z.string().min(1).max(3).optional(),
      source_type: sourceTypeSchema.optional(),
    })
    .optional(),
});
export type CreateImportInput = z.infer<typeof createImportSchema>;

export const importJobSchema = z.object({
  id: idSchema,
  entity: z.literal('contact'),
  status: z.enum(['pending', 'running', 'completed', 'failed']),
  mapping: importMappingSchema,
  total_rows: z.number().int(),
  created: z.number().int(),
  updated: z.number().int(),
  failed: z.number().int(),
  /** First 100 row errors (1-based data row numbers). */
  errors: z.array(z.object({ row: z.number().int(), message: z.string() })),
  created_at: timestampSchema,
  finished_at: timestampSchema.nullable(),
});
export type ImportJob = z.infer<typeof importJobSchema>;
