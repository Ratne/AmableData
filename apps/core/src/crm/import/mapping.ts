import type { CustomFieldValues } from '@amable/api-types';

/** Contact columns a CSV header can map to (besides tags, custom.<key>, ignore). */
const SCALAR_TARGETS = [
  'given_name',
  'middle_name',
  'family_name',
  'prefix',
  'suffix',
  'preferred_name',
  'job_title',
  'website',
  'spouse_name',
  'time_zone',
  'preferred_locale',
  'birthday',
  'anniversary',
  'owner_id',
  'marketable_status',
] as const;

const UTM_TARGETS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
] as const;
const EMAIL_TARGETS = ['email', 'email2', 'email3'] as const;
const PHONE_TARGETS = ['phone', 'phone2', 'phone3'] as const;
const ADDRESS_TARGETS = [
  'address.line1',
  'address.street_number',
  'address.line2',
  'address.locality',
  'address.region',
  'address.postal_code',
  'address.country_code',
] as const;
const SPECIAL_TARGETS = [
  'name',
  'score_value',
  'company_name',
  'lead_source',
  'tags',
  'ignore',
] as const;

export const IMPORT_TARGETS: readonly string[] = [
  ...SCALAR_TARGETS,
  ...UTM_TARGETS,
  ...EMAIL_TARGETS,
  ...PHONE_TARGETS,
  ...ADDRESS_TARGETS,
  ...SPECIAL_TARGETS,
];

/** Returns the problems of a mapping (unknown targets/custom keys, duplicates). */
export function validateMapping(
  mapping: Record<string, string>,
  customKeys: ReadonlySet<string>,
): string[] {
  const problems: string[] = [];
  const used = new Set<string>();
  for (const [column, target] of Object.entries(mapping)) {
    if (target.startsWith('custom.')) {
      if (!customKeys.has(target.slice('custom.'.length))) {
        problems.push(`column "${column}": unknown custom field "${target}"`);
      }
    } else if (!IMPORT_TARGETS.includes(target)) {
      problems.push(`column "${column}": unknown target "${target}"`);
    }
    if (target !== 'ignore' && target !== 'tags' && used.has(target)) {
      problems.push(`target "${target}" is mapped more than once`);
    }
    used.add(target);
  }
  if (![...used].some((t) => t !== 'ignore')) problems.push('mapping has no target columns');
  return problems;
}

/** A CSV row turned into contact input (validated later with the API schema). */
export interface MappedRow {
  contact: Record<string, unknown> & { custom_fields: CustomFieldValues };
  tagNames: string[];
  companyName: string | null;
  leadSourceName: string | null;
  primaryEmail: string | null;
}

/** Maps one CSV row through the header mapping. Pure: no database access. */
export function mapRow(
  header: string[],
  row: string[],
  mapping: Record<string, string>,
  listDelimiter: string,
): MappedRow {
  const contact: MappedRow['contact'] = { custom_fields: {} };
  const emails: string[] = [];
  const phones: string[] = [];
  const address: Record<string, string> = {};
  const utm: Record<string, string> = {};
  const tagNames: string[] = [];
  let companyName: string | null = null;
  let leadSourceName: string | null = null;

  header.forEach((column, index) => {
    const target = mapping[column.trim()];
    const raw = (row[index] ?? '').trim();
    if (target === undefined || target === 'ignore') return;
    if (target === 'tags') {
      tagNames.push(
        ...raw
          .split(listDelimiter)
          .map((t) => t.trim())
          .filter((t) => t !== ''),
      );
      return;
    }
    if (target.startsWith('custom.')) {
      // Empty cells leave custom fields untouched (no accidental clearing on update).
      if (raw !== '') contact.custom_fields[target.slice('custom.'.length)] = raw;
      return;
    }
    if (raw === '') return;
    if ((EMAIL_TARGETS as readonly string[]).includes(target))
      emails[EMAIL_TARGETS.indexOf(target as (typeof EMAIL_TARGETS)[number])] = raw;
    else if ((PHONE_TARGETS as readonly string[]).includes(target))
      phones[PHONE_TARGETS.indexOf(target as (typeof PHONE_TARGETS)[number])] = raw;
    else if (target.startsWith('address.')) address[target.slice('address.'.length)] = raw;
    else if (target.startsWith('utm_')) utm[target.slice('utm_'.length)] = raw;
    else if (target === 'company_name') companyName = raw;
    else if (target === 'lead_source') leadSourceName = raw;
    else if (target === 'score_value')
      contact['score_value'] = /^-?\d+$/.test(raw) ? Number(raw) : raw;
    else if (target === 'name') {
      const [given, ...rest] = raw.split(/\s+/);
      contact['given_name'] = given;
      if (rest.length > 0) contact['family_name'] = rest.join(' ');
    } else contact[target] = raw;
  });

  const emailList = emails.filter((e): e is string => typeof e === 'string');
  if (emailList.length > 0)
    contact['emails'] = emailList.map((email) => ({ email: email.toLowerCase() }));
  const phoneList = phones.filter((p): p is string => typeof p === 'string');
  if (phoneList.length > 0) contact['phones'] = phoneList.map((number) => ({ number }));
  if (Object.keys(address).length > 0) {
    if (address['country_code'] !== undefined)
      address['country_code'] = address['country_code'].toUpperCase();
    contact['addresses'] = [{ type: 'billing', ...address }];
  }
  if (Object.keys(utm).length > 0) contact['utm'] = utm;

  return {
    contact,
    tagNames,
    companyName,
    leadSourceName,
    primaryEmail: emailList[0]?.toLowerCase() ?? null,
  };
}
