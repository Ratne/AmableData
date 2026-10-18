import type {
  AddressInput,
  Contact,
  ContactEmailInput,
  ContactPhoneInput,
  CustomFieldValueInput,
  UpdateContactInput,
} from '@amable/api-types';
import {
  CUSTOM_MAP_PREFIX,
  PHONE_RE,
  type FormCrmSettings,
  type FormDefinition,
  type SubmissionValue,
  type SubmissionValues,
} from '@amable/forms';
import { z } from 'zod';
import { findOrCreateCompanyByName } from '../crm/companies';
import { createContact, getContact, getContactRow, updateContact } from '../crm/contacts';
import type { CrmContext } from '../crm/context';
import { placeholders } from '../crm/db/sql';
import { loadFieldDefs } from '../crm/custom-fields/repo';
import { normalizeCustomFieldValue } from '../crm/custom-fields/validate';
import { applyTagsToContact } from '../crm/tags';

/**
 * Submission → CRM contact: collects the mapped values, matches an existing
 * contact (normalized email, else phone digits) and creates or updates it
 * following the form's update policy. Runs inside the `forms.applySubmission`
 * transaction.
 */

export interface SubmissionTracking {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
}

export interface ContactMappingResult {
  contactId: string | null;
  created: boolean;
  /** Values that could not be written (shown on the submission). */
  warnings: string[];
}

interface MappedValues {
  email: string | null;
  phone: string | null;
  scalars: Partial<Record<'given_name' | 'family_name' | 'job_title' | 'website', string>>;
  companyName: string | null;
  address: Partial<Record<'line1' | 'street_number' | 'line2' | 'locality' | 'region' | 'postal_code' | 'country_code', string>>;
  custom: Record<string, CustomFieldValueInput>;
  marketingConsent: boolean;
}

const emailSchema = z.email().max(254);
const SCALAR_LIMITS = { given_name: 100, family_name: 100, job_title: 255, website: 2048 } as const;
const ADDRESS_LIMITS = { line1: 255, street_number: 20, line2: 255, locality: 100, region: 100, postal_code: 20, country_code: 2 } as const;
const UTM_KEYS = ['source', 'medium', 'campaign', 'term', 'content'] as const;
const FILLABLE_STATUSES = new Set(['unknown', 'non_marketable']);

function asText(value: SubmissionValue): string {
  if (Array.isArray(value)) return value.join(', ');
  return String(value).trim();
}

function collect(
  ctx: CrmContext,
  definition: FormDefinition,
  values: SubmissionValues,
  warnings: string[],
): MappedValues {
  const mapped: MappedValues = {
    email: null,
    phone: null,
    scalars: {},
    companyName: null,
    address: {},
    custom: {},
    marketingConsent: false,
  };
  const customDefs = new Map(loadFieldDefs(ctx, 'contact').map((d) => [d.key, d]));
  for (const field of definition.fields) {
    const value = values[field.key];
    if (field.kind === 'consent' && field.marketing && value === true) mapped.marketingConsent = true;
    if (value === undefined || field.map_to === null) continue;
    const target = field.map_to;
    if (target.startsWith(CUSTOM_MAP_PREFIX)) {
      const key = target.slice(CUSTOM_MAP_PREFIX.length);
      const def = customDefs.get(key);
      if (def === undefined) {
        warnings.push(`${field.key}: custom field "${key}" no longer exists`);
        continue;
      }
      const result = normalizeCustomFieldValue(def, value, { lenient: true, listDelimiter: ',' });
      if (!result.ok) {
        warnings.push(`${field.key}: ${result.error}`);
        continue;
      }
      if (result.value !== null) mapped.custom[key] = result.value.api;
      continue;
    }
    const text = asText(value);
    if (text === '') continue;
    switch (target) {
      case 'email':
        if (emailSchema.safeParse(text).success) mapped.email = text.toLowerCase();
        else warnings.push(`${field.key}: invalid email`);
        break;
      case 'phone':
        if (PHONE_RE.test(text)) mapped.phone = text;
        else warnings.push(`${field.key}: invalid phone number`);
        break;
      case 'company_name':
        mapped.companyName = text.slice(0, 255);
        break;
      case 'given_name':
      case 'family_name':
      case 'job_title':
      case 'website':
        mapped.scalars[target] = text.slice(0, SCALAR_LIMITS[target]);
        break;
      default: {
        const part = target.slice('address.'.length) as keyof typeof ADDRESS_LIMITS;
        if (part === 'country_code') {
          const code = text.toUpperCase();
          if (/^[A-Z]{2}$/.test(code)) mapped.address.country_code = code;
          else warnings.push(`${field.key}: expected a 2-letter country code`);
        } else {
          mapped.address[part] = text.slice(0, ADDRESS_LIMITS[part]);
        }
      }
    }
  }
  return mapped;
}

export function findContactByEmail(ctx: CrmContext, email: string): string | null {
  return (
    ctx.db.all<{ id: string }>(
      `SELECT c.id FROM crm_contact_emails e JOIN crm_contacts c ON c.id = e.contact_id
       WHERE e.email_normalized = ? AND c.deleted_at IS NULL
       ORDER BY e.is_primary DESC, c.created_at, c.id LIMIT 1`,
      email.trim().toLowerCase(),
    )[0]?.id ?? null
  );
}

export function findContactByPhone(ctx: CrmContext, phone: string): string | null {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 6) return null;
  return (
    ctx.db.all<{ id: string }>(
      `SELECT c.id FROM crm_contact_phones p JOIN crm_contacts c ON c.id = p.contact_id
       WHERE p.number_digits = ? AND c.deleted_at IS NULL
       ORDER BY p.position, c.created_at, c.id LIMIT 1`,
      digits,
    )[0]?.id ?? null
  );
}

function existingTags(ctx: CrmContext, ids: string[], warnings: string[]): string[] {
  if (ids.length === 0) return [];
  const found = new Set(
    ctx.db
      .all<{ id: string }>(
        `SELECT id FROM crm_tags WHERE deleted_at IS NULL AND id IN (${placeholders(ids.length)})`,
        ...ids,
      )
      .map((r) => r.id),
  );
  for (const id of ids) if (!found.has(id)) warnings.push(`tag ${id} no longer exists`);
  return ids.filter((id) => found.has(id));
}

function existingLeadSource(ctx: CrmContext, id: string | null): string | null {
  if (id === null) return null;
  return ctx.db.all(`SELECT 1 FROM crm_lead_sources WHERE id = ? AND deleted_at IS NULL`, id).length > 0
    ? id
    : null;
}

function utmOf(tracking: SubmissionTracking): NonNullable<UpdateContactInput['utm']> {
  const utm: NonNullable<UpdateContactInput['utm']> = {};
  for (const key of UTM_KEYS) {
    const value = tracking[`utm_${key}`]?.trim().slice(0, 255);
    if (value !== undefined && value !== '') utm[key] = value;
  }
  return utm;
}

function addressInput(address: MappedValues['address']): AddressInput | null {
  return Object.keys(address).length === 0 ? null : { type: 'other', ...address };
}

const EMAIL_LABELS = new Set(['work', 'personal', 'other']);
const PHONE_TYPES = new Set(['mobile', 'work', 'home', 'fax', 'other']);

function emailsOf(contact: Contact): ContactEmailInput[] {
  return contact.emails.map((e) => ({
    email: e.email,
    ...(e.label !== null && EMAIL_LABELS.has(e.label) ? { label: e.label as ContactEmailInput['label'] } : {}),
  }));
}

function phonesOf(contact: Contact): ContactPhoneInput[] {
  return contact.phones.map((p) => ({
    number: p.number,
    ...(p.extension !== null ? { extension: p.extension } : {}),
    ...(p.type !== null && PHONE_TYPES.has(p.type) ? { type: p.type as ContactPhoneInput['type'] } : {}),
  }));
}

const isEmpty = (value: unknown): boolean => value === null || value === undefined || value === '';

function updateData(
  ctx: CrmContext,
  contact: Contact,
  mapped: MappedValues,
  crm: FormCrmSettings,
  tracking: SubmissionTracking,
): UpdateContactInput {
  const overwrite = crm.update_policy === 'overwrite';
  const row = getContactRow(ctx, contact.id);
  const data: UpdateContactInput = {};
  for (const [key, value] of Object.entries(mapped.scalars) as Array<[keyof MappedValues['scalars'], string]>) {
    if (overwrite || isEmpty(row[key])) data[key] = value;
  }
  if (mapped.companyName !== null && (overwrite || row.company_id === null)) {
    data.company_id = findOrCreateCompanyByName(ctx, mapped.companyName);
  }
  if (mapped.email !== null && !contact.emails.some((e) => e.email.toLowerCase() === mapped.email)) {
    const emails = emailsOf(contact);
    data.emails = (overwrite ? [{ email: mapped.email }, ...emails] : [...emails, { email: mapped.email }]).slice(0, 5);
  }
  if (mapped.phone !== null) {
    const digits = mapped.phone.replace(/\D/g, '');
    if (!contact.phones.some((p) => p.number.replace(/\D/g, '') === digits)) {
      const phones = phonesOf(contact);
      data.phones = (overwrite ? [{ number: mapped.phone }, ...phones] : [...phones, { number: mapped.phone }]).slice(0, 5);
    }
  }
  const address = addressInput(mapped.address);
  if (address !== null) {
    if (contact.addresses.length === 0) {
      data.addresses = [address];
    } else if (overwrite) {
      const [first, ...rest] = contact.addresses;
      data.addresses = [{ ...first, ...address, type: first?.type as AddressInput['type'] }, ...rest] as AddressInput[];
    }
  }
  const custom: Record<string, CustomFieldValueInput> = {};
  for (const [key, value] of Object.entries(mapped.custom)) {
    if (overwrite || isEmpty(contact.custom_fields[key])) custom[key] = value;
  }
  if (Object.keys(custom).length > 0) data.custom_fields = custom;
  const utm = utmOf(tracking);
  const emptyUtm: NonNullable<UpdateContactInput['utm']> = {};
  for (const key of UTM_KEYS) {
    if (utm[key] !== undefined && isEmpty(contact.utm[key])) emptyUtm[key] = utm[key];
  }
  if (Object.keys(emptyUtm).length > 0) data.utm = emptyUtm;
  const leadSource = existingLeadSource(ctx, crm.lead_source_id);
  if (leadSource !== null && row.lead_source_id === null) data.lead_source_id = leadSource;
  if (crm.owner_id !== null && row.owner_id === null) data.owner_id = crm.owner_id;
  if (mapped.marketingConsent && FILLABLE_STATUSES.has(row.marketable_status)) {
    data.marketable_status = 'single_opt_in';
  }
  return data;
}

/** Creates or updates the contact of a submission; null contact when neither email nor phone is mapped. */
export function applyToContact(
  ctx: CrmContext,
  definition: FormDefinition,
  values: SubmissionValues,
  tracking: SubmissionTracking,
): ContactMappingResult {
  const warnings: string[] = [];
  const crm = definition.crm;
  if (!crm.create_contacts) return { contactId: null, created: false, warnings };
  const mapped = collect(ctx, definition, values, warnings);
  if (mapped.email === null && mapped.phone === null) return { contactId: null, created: false, warnings };

  const tagIds = existingTags(ctx, crm.tag_ids, warnings);
  const existingId =
    (mapped.email === null ? null : findContactByEmail(ctx, mapped.email)) ??
    (mapped.phone === null ? null : findContactByPhone(ctx, mapped.phone));

  if (existingId === null) {
    const address = addressInput(mapped.address);
    const utm = utmOf(tracking);
    const leadSource = existingLeadSource(ctx, crm.lead_source_id);
    const contact = createContact(ctx, {
      ...mapped.scalars,
      ...(mapped.companyName === null ? {} : { company_id: findOrCreateCompanyByName(ctx, mapped.companyName) }),
      ...(mapped.email === null ? {} : { emails: [{ email: mapped.email }] }),
      ...(mapped.phone === null ? {} : { phones: [{ number: mapped.phone }] }),
      ...(address === null ? {} : { addresses: [address] }),
      ...(Object.keys(utm).length === 0 ? {} : { utm }),
      ...(Object.keys(mapped.custom).length === 0 ? {} : { custom_fields: mapped.custom }),
      ...(leadSource === null ? {} : { lead_source_id: leadSource }),
      ...(crm.owner_id === null ? {} : { owner_id: crm.owner_id }),
      ...(mapped.marketingConsent ? { marketable_status: 'single_opt_in' as const } : {}),
      ...(tagIds.length === 0 ? {} : { tag_ids: tagIds }),
      source_type: 'form',
    }, { requireAll: false });
    return { contactId: contact.id, created: true, warnings };
  }

  const contact = getContact(ctx, { id: existingId });
  const data = updateData(ctx, contact, mapped, crm, tracking);
  if (Object.keys(data).length > 0) updateContact(ctx, { id: existingId, data });
  if (tagIds.length > 0) applyTagsToContact(ctx, existingId, tagIds);
  return { contactId: existingId, created: false, warnings };
}
