import { z } from 'zod';
import { currencySchema } from '../commerce/index';
import { optText } from '../crm/common';

/**
 * Settings > General: workspace identity, white label, regional defaults and
 * the company profile. The timezone is the one email sends use and the
 * currency is the e-commerce default: one value each, edited from here too.
 */

export const WORKSPACE_LANGUAGES = ['it', 'en'] as const;

export const WORKSPACE_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** What every member needs: shell branding and the defaults of new records. */
export const workspaceProfileSchema = z.object({
  name: z.string(),
  slug: z.string(),
  /** Same-origin URL of the uploaded logo (versioned), or null for the product logo. */
  logo_url: z.string().nullable(),
  /** `#rrggbb`, or null for the product color. */
  primary_color: z.string().nullable(),
  timezone: z.string(),
  /** Language of invitations; null = the inviter's language. */
  language: z.enum(WORKSPACE_LANGUAGES).nullable(),
  /** ISO 3166-1 alpha-2 of new addresses and phone numbers; null = from the browser. */
  country_code: z.string().nullable(),
  currency: z.string(),
});
export type WorkspaceProfile = z.infer<typeof workspaceProfileSchema>;

export const COMPANY_FIELDS = [
  'legal_name',
  'vat_number',
  'tax_code',
  'sdi_code',
  'pec',
  'email',
  'phone',
  'website',
  'street',
  'street_number',
  'postal_code',
  'city',
  'region',
  'country_code',
] as const;
export type CompanyField = (typeof COMPANY_FIELDS)[number];

export const companyProfileSchema = z.object(
  Object.fromEntries(COMPANY_FIELDS.map((field) => [field, z.string().nullable()])) as Record<
    CompanyField,
    z.ZodNullable<z.ZodString>
  >,
);
export type CompanyProfile = z.infer<typeof companyProfileSchema>;

export const generalSettingsSchema = workspaceProfileSchema.extend({
  /** Former slugs, still resolved by public links and the API. */
  previous_slugs: z.array(z.string()),
  company: companyProfileSchema,
});
export type GeneralSettings = z.infer<typeof generalSettingsSchema>;

const optEmail = z.email().max(254).nullable().optional();

export const updateCompanyProfileSchema = z.strictObject({
  legal_name: optText(200),
  vat_number: optText(32),
  tax_code: optText(32),
  /** Italian e-invoicing recipient code. */
  sdi_code: z
    .string()
    .regex(/^[A-Z0-9]{6,7}$/, 'expected 6 or 7 letters or digits')
    .nullable()
    .optional(),
  pec: optEmail,
  email: optEmail,
  phone: optText(40),
  website: z
    .url({ protocol: /^https?$/ })
    .max(500)
    .nullable()
    .optional(),
  street: optText(255),
  street_number: optText(20),
  postal_code: optText(20),
  city: optText(100),
  region: optText(100),
  country_code: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullable()
    .optional(),
});
export type UpdateCompanyProfileInput = z.infer<typeof updateCompanyProfileSchema>;

export const updateGeneralSettingsSchema = z.strictObject({
  name: z.string().trim().min(1).max(120).optional(),
  /** Changing it needs step-up; the old slug keeps working as an alias. */
  slug: z.string().min(2).max(64).regex(WORKSPACE_SLUG_RE).optional(),
  primary_color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  timezone: z.string().min(1).max(64).optional(),
  language: z.enum(WORKSPACE_LANGUAGES).nullable().optional(),
  country_code: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullable()
    .optional(),
  currency: currencySchema.optional(),
  company: updateCompanyProfileSchema.optional(),
});
export type UpdateGeneralSettingsInput = z.infer<typeof updateGeneralSettingsSchema>;

export const WORKSPACE_LOGO_MAX_BYTES = 1024 * 1024;
