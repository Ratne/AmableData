/** Zod-free constants shared by the schema and the widget (keeps zod out of the embed bundle). */

export const FIELD_KINDS = [
  'text',
  'email',
  'phone',
  'textarea',
  'number',
  'date',
  'select',
  'radio',
  'checkbox',
  'multicheck',
  'rating',
  'consent',
  'hidden',
  'heading',
  'html',
  'page_break',
] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

/** Kinds that only render content and never collect a value. */
export const DISPLAY_KINDS: ReadonlySet<FieldKind> = new Set(['heading', 'html', 'page_break']);
/** Kinds whose value is chosen among `options`. */
export const OPTION_KINDS: ReadonlySet<FieldKind> = new Set(['select', 'radio', 'multicheck']);

export function collectsValue(kind: FieldKind): boolean {
  return !DISPLAY_KINDS.has(kind);
}

/** Contact attributes a field can write to (besides `custom.<key>` CRM custom fields). */
export const CONTACT_MAP_TARGETS = [
  'email',
  'given_name',
  'family_name',
  'phone',
  'company_name',
  'job_title',
  'website',
  'address.line1',
  'address.street_number',
  'address.line2',
  'address.locality',
  'address.region',
  'address.postal_code',
  'address.country_code',
] as const;
export type ContactMapTarget = (typeof CONTACT_MAP_TARGETS)[number];

export const CUSTOM_MAP_PREFIX = 'custom.';

/** Attribution parameters captured from the host page URL. */
export const UTM_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;
/** Click ids and referral parameters also kept when present. */
export const TRACKING_PARAMS = [...UTM_PARAMS, 'gclid', 'fbclid', 'msclkid', 'ref'] as const;
