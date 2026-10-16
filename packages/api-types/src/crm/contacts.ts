import { z } from 'zod';
import { dateSchema, idSchema, optText, timestampSchema } from './common';
import { customFieldValuesSchema } from './custom-fields';

export const MARKETABLE_STATUSES = [
  'unknown',
  'single_opt_in',
  'double_opt_in',
  'unsubscribed',
  'bounced',
  'complained',
  'non_marketable',
] as const;
export const marketableStatusSchema = z.enum(MARKETABLE_STATUSES);
export type MarketableStatus = z.infer<typeof marketableStatusSchema>;

export const SOURCE_TYPES = ['manual', 'api', 'import', 'form', 'booking', 'other'] as const;
export const sourceTypeSchema = z.enum(SOURCE_TYPES);
export type SourceType = z.infer<typeof sourceTypeSchema>;

export const contactEmailSchema = z.strictObject({
  email: z.email().max(254),
  label: z.enum(['work', 'personal', 'other']).optional(),
});
export type ContactEmailInput = z.infer<typeof contactEmailSchema>;

export const contactPhoneSchema = z.strictObject({
  number: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ().-]{3,30}$/, 'invalid phone number'),
  extension: z.string().trim().max(10).optional(),
  type: z.enum(['mobile', 'work', 'home', 'fax', 'other']).optional(),
});
export type ContactPhoneInput = z.infer<typeof contactPhoneSchema>;

export const addressSchema = z.strictObject({
  type: z.enum(['billing', 'shipping', 'other']).optional(),
  line1: optText(255),
  street_number: optText(20),
  line2: optText(255),
  locality: optText(100),
  region: optText(100),
  postal_code: optText(20),
  country_code: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullable()
    .optional(),
});
export type AddressInput = z.infer<typeof addressSchema>;

export const socialAccountSchema = z.strictObject({
  type: z.enum(['facebook', 'instagram', 'linkedin', 'x', 'youtube', 'tiktok', 'other']),
  name: z.string().trim().min(1).max(255),
});

export const utmSchema = z.strictObject({
  source: optText(255),
  medium: optText(255),
  campaign: optText(255),
  term: optText(255),
  content: optText(255),
});
export type Utm = z.infer<typeof utmSchema>;

const contactFields = {
  given_name: optText(100),
  middle_name: optText(100),
  family_name: optText(100),
  prefix: optText(30),
  suffix: optText(30),
  preferred_name: optText(100),
  job_title: optText(255),
  company_id: idSchema.nullable().optional(),
  birthday: dateSchema.nullable().optional(),
  anniversary: dateSchema.nullable().optional(),
  website: optText(2048),
  spouse_name: optText(100),
  time_zone: optText(64),
  preferred_locale: optText(16),
  owner_id: idSchema.nullable().optional(),
  lead_source_id: idSchema.nullable().optional(),
  source_type: sourceTypeSchema.optional(),
  utm: utmSchema.optional(),
  score_value: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  marketable_status: marketableStatusSchema.optional(),
  /** First entry is the primary email. Replaces the whole list on update. */
  emails: z.array(contactEmailSchema).max(5).optional(),
  phones: z.array(contactPhoneSchema).max(5).optional(),
  addresses: z.array(addressSchema).max(3).optional(),
  social_accounts: z.array(socialAccountSchema).max(10).optional(),
  /** Merged into existing values on update; `null` clears a field. */
  custom_fields: customFieldValuesSchema.optional(),
};

export const createContactSchema = z.strictObject({
  ...contactFields,
  /** Tags applied right after creation. */
  tag_ids: z.array(idSchema).max(100).optional(),
});
export type CreateContactInput = z.infer<typeof createContactSchema>;

export const updateContactSchema = z.strictObject(contactFields);
export type UpdateContactInput = z.infer<typeof updateContactSchema>;

export const contactSchema = z.object({
  id: idSchema,
  given_name: z.string().nullable(),
  middle_name: z.string().nullable(),
  family_name: z.string().nullable(),
  prefix: z.string().nullable(),
  suffix: z.string().nullable(),
  preferred_name: z.string().nullable(),
  job_title: z.string().nullable(),
  company_id: idSchema.nullable(),
  birthday: z.string().nullable(),
  anniversary: z.string().nullable(),
  website: z.string().nullable(),
  spouse_name: z.string().nullable(),
  time_zone: z.string().nullable(),
  preferred_locale: z.string().nullable(),
  owner_id: idSchema.nullable(),
  lead_source_id: idSchema.nullable(),
  source_type: sourceTypeSchema,
  utm: z.object({
    source: z.string().nullable(),
    medium: z.string().nullable(),
    campaign: z.string().nullable(),
    term: z.string().nullable(),
    content: z.string().nullable(),
  }),
  score_value: z.number().int(),
  marketable_status: marketableStatusSchema,
  emails: z.array(
    z.object({ email: z.string(), label: z.string().nullable(), is_primary: z.boolean() }),
  ),
  phones: z.array(
    z.object({ number: z.string(), extension: z.string().nullable(), type: z.string().nullable() }),
  ),
  addresses: z.array(
    z.object({
      type: z.string(),
      line1: z.string().nullable(),
      street_number: z.string().nullable(),
      line2: z.string().nullable(),
      locality: z.string().nullable(),
      region: z.string().nullable(),
      postal_code: z.string().nullable(),
      country_code: z.string().nullable(),
    }),
  ),
  social_accounts: z.array(z.object({ type: z.string(), name: z.string() })),
  tag_ids: z.array(idSchema),
  custom_fields: customFieldValuesSchema,
  merged_into_id: idSchema.nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  deleted_at: timestampSchema.nullable(),
});
export type Contact = z.infer<typeof contactSchema>;

export const listContactsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
  q: z.string().max(200).optional(),
  email: z.string().max(254).optional(),
  tag_id: idSchema.optional(),
  owner_id: idSchema.optional(),
  company_id: idSchema.optional(),
  updated_since: z.iso.datetime({ offset: true }).optional(),
  include_deleted: z.enum(['true', 'false']).optional(),
});
export type ListContactsQuery = z.infer<typeof listContactsQuerySchema>;

export const mergeContactsSchema = z.strictObject({
  /** Contacts folded into the target; they are soft-deleted with `merged_into_id`. */
  source_ids: z.array(idSchema).min(1).max(10),
});
export type MergeContactsInput = z.infer<typeof mergeContactsSchema>;

export const applyTagsSchema = z.strictObject({ tag_ids: z.array(idSchema).min(1).max(100) });
export type ApplyTagsInput = z.infer<typeof applyTagsSchema>;

/** `GET /contacts/{id}/tags`: the contact's tags by name, `q` filters by name (contains). */
export const listContactTagsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
  q: z.string().trim().max(100).optional(),
  category_id: idSchema.optional(),
});
export type ListContactTagsQuery = z.infer<typeof listContactTagsQuerySchema>;

export const contactTagSchema = z.object({
  id: idSchema,
  name: z.string(),
  category_id: idSchema.nullable(),
  applied_at: timestampSchema,
  /** User (or API key creator) who applied it; null for imports and automations without one. */
  applied_by: z.string().nullable(),
});
export type ContactTag = z.infer<typeof contactTagSchema>;

/**
 * Sizes of the contact page tabs. Keys the caller may not read (tasks,
 * appointments, opportunities, orders) are left out.
 */
export const contactCountsSchema = z.object({
  tags: z.number().int(),
  notes: z.number().int(),
  tasks_open: z.number().int().optional(),
  appointments: z.number().int().optional(),
  opportunities: z.number().int().optional(),
  orders: z.number().int().optional(),
  /** Form submissions (`forms:read`). */
  submissions: z.number().int().optional(),
  /** Emails sent to the contact (MailDb); omitted when the email store is unreachable. */
  emails: z.number().int().optional(),
  /** Enrollments (`automations:read`); omitted when the automation engine is unreachable. */
  automations_active: z.number().int().optional(),
  automations_total: z.number().int().optional(),
});
export type ContactCounts = z.infer<typeof contactCountsSchema>;

export const createLeadSourceSchema = z.strictObject({
  name: z.string().trim().min(1).max(255),
  category: optText(100),
});
export type CreateLeadSourceInput = z.infer<typeof createLeadSourceSchema>;

export const leadSourceSchema = z.object({
  id: idSchema,
  name: z.string(),
  category: z.string().nullable(),
  created_at: timestampSchema,
});
export type LeadSource = z.infer<typeof leadSourceSchema>;

export const activitySchema = z.object({
  id: idSchema,
  type: z.string(),
  contact_id: idSchema.nullable(),
  company_id: idSchema.nullable(),
  opportunity_id: idSchema.nullable(),
  actor: z.object({ type: z.enum(['user', 'api_key', 'system']), id: z.string().nullable() }),
  data: z.record(z.string(), z.unknown()),
  occurred_at: timestampSchema,
});
export type Activity = z.infer<typeof activitySchema>;

/** `GET /addressSuggestions`: free-text address search for the contact editor. */
export const addressSuggestionsQuerySchema = z.object({
  q: z.string().trim().min(3).max(200),
  /** UI language (BCP 47); the geocoder answers in it when it can. */
  lang: z.string().trim().max(35).optional(),
  /** ISO country the suggestions are restricted to. */
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
});
export type AddressSuggestionsQuery = z.infer<typeof addressSuggestionsQuerySchema>;

export const addressSuggestionSchema = z.object({
  label: z.string(),
  line1: z.string(),
  street_number: z.string().nullable(),
  locality: z.string().nullable(),
  region: z.string().nullable(),
  postal_code: z.string().nullable(),
  country_code: z.string().nullable(),
});
export type AddressSuggestion = z.infer<typeof addressSuggestionSchema>;

export const addressSuggestionsResponseSchema = z.object({
  /** False when no geocoder is available (installation one off, no tenant Mapbox token). */
  enabled: z.boolean(),
  /** Source of the suggestions, to show its attribution next to them. */
  provider: z.enum(['photon', 'mapbox']).nullable(),
  data: z.array(addressSuggestionSchema),
});
export type AddressSuggestionsResponse = z.infer<typeof addressSuggestionsResponseSchema>;

/** Address autocomplete provider of the tenant (`/settings/addressLookup`). */
export const addressLookupSettingsSchema = z.object({
  /** `default`: the installation geocoder (OpenStreetMap); `mapbox`: the tenant's own Mapbox token. */
  provider: z.enum(['default', 'mapbox']),
  /** False when the installation turned its own geocoder off (`ADDRESS_LOOKUP_URL=off`). */
  default_available: z.boolean(),
  mapbox: z.object({
    configured: z.boolean(),
    /** Last characters of the saved token, to recognize it. */
    token_hint: z.string().nullable(),
    /** Mapbox "permanent" geocoding: results may be stored (billed differently by Mapbox). */
    permanent: z.boolean(),
  }),
});
export type AddressLookupSettings = z.infer<typeof addressLookupSettingsSchema>;

export const updateAddressLookupSettingsSchema = z.strictObject({
  provider: z.enum(['default', 'mapbox']).optional(),
  /** New Mapbox access token (verified against Mapbox before saving); `null` removes it. */
  mapbox_token: z
    .string()
    .trim()
    .regex(/^[ps]k\.[A-Za-z0-9._-]{20,500}$/, 'not a Mapbox access token (pk.… or sk.…)')
    .nullable()
    .optional(),
  mapbox_permanent: z.boolean().optional(),
});
export type UpdateAddressLookupSettingsInput = z.infer<typeof updateAddressLookupSettingsSchema>;
