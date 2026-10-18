import type {
  AddressInput,
  Contact,
  ContactEmailInput,
  ContactPhoneInput,
  CreateContactInput,
  ListContactsQuery,
  MarketableStatus,
  Page,
  SourceType,
  UpdateContactInput,
} from '@amable/api-types';
import type { CrmContext } from './context';
import { placeholders, type SqlValue } from './db/sql';
import { invalid, notFound } from './errors';
import { emit } from './events';
import {
  deleteValuesOf,
  prepareValues,
  readValues,
  searchableValues,
  writeValues,
  type PreparedValues,
} from './custom-fields/repo';
import { assertRef } from './refs';
import { indexDocument, removeDocument } from './search/index-store';
import { applyTagsToContact, assertTags, tagIdsByContact } from './tags';
import { parseJson, toIso } from './util';
import type { FilterLeaf } from '@amable/api-types';

export interface ContactRow {
  id: string;
  given_name: string | null;
  middle_name: string | null;
  family_name: string | null;
  prefix: string | null;
  suffix: string | null;
  preferred_name: string | null;
  job_title: string | null;
  company_id: string | null;
  birthday: string | null;
  anniversary: string | null;
  website: string | null;
  spouse_name: string | null;
  time_zone: string | null;
  preferred_locale: string | null;
  owner_id: string | null;
  lead_source_id: string | null;
  source_type: SourceType;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
  score_value: number;
  marketable_status: MarketableStatus;
  social_accounts: string;
  primary_email: string | null;
  primary_phone: string | null;
  merged_into_id: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

/** Scalar input fields stored in a column of the same name. */
const SCALAR_FIELDS = [
  'given_name',
  'middle_name',
  'family_name',
  'prefix',
  'suffix',
  'preferred_name',
  'job_title',
  'company_id',
  'birthday',
  'anniversary',
  'website',
  'spouse_name',
  'time_zone',
  'preferred_locale',
  'owner_id',
  'lead_source_id',
  'source_type',
  'score_value',
  'marketable_status',
] as const satisfies ReadonlyArray<keyof UpdateContactInput & keyof ContactRow>;

const UTM_KEYS = ['source', 'medium', 'campaign', 'term', 'content'] as const;

export function getContactRow(ctx: CrmContext, id: string, includeDeleted = false): ContactRow {
  const row = ctx.db.all<ContactRow>(
    `SELECT * FROM crm_contacts WHERE id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`,
    id,
  )[0];
  if (row === undefined) throw notFound('contact', id);
  return row;
}

export function displayName(row: {
  given_name: string | null;
  family_name: string | null;
  primary_email?: string | null;
}): string {
  const name = [row.given_name, row.family_name].filter((p) => p !== null && p !== '').join(' ');
  return name !== '' ? name : (row.primary_email ?? '');
}

// ------------------------------------------------------------ validation

interface PreparedContact {
  emails: ContactEmailInput[] | undefined;
  phones: ContactPhoneInput[] | undefined;
  addresses: AddressInput[] | undefined;
  customFields: PreparedValues;
}

function dedupeEmails(emails: ContactEmailInput[]): ContactEmailInput[] {
  const seen = new Set<string>();
  return emails.filter((e) => {
    const key = e.email.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function prepareContact(
  ctx: CrmContext,
  input: UpdateContactInput,
  mode: 'create' | 'update',
  options: { lenient?: boolean; listDelimiter?: string; requireAll?: boolean } = {},
): PreparedContact {
  assertRef(ctx, 'company', input.company_id, 'company_id');
  assertRef(ctx, 'lead_source', input.lead_source_id, 'lead_source_id');
  return {
    emails: input.emails === undefined ? undefined : dedupeEmails(input.emails),
    phones: input.phones,
    addresses: input.addresses,
    customFields: prepareValues(ctx, 'contact', input.custom_fields, {
      ...options,
      requireAll: mode === 'create' && options.requireAll !== false,
    }),
  };
}

// ------------------------------------------------------------ sub-records

function writeEmails(
  ctx: CrmContext,
  contactId: string,
  emails: ContactEmailInput[],
): string | null {
  ctx.db.run(`DELETE FROM crm_contact_emails WHERE contact_id = ?`, contactId);
  emails.forEach((e, position) => {
    ctx.db.run(
      `INSERT INTO crm_contact_emails (id, contact_id, email, email_normalized, label, is_primary, position)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ctx.newId(),
      contactId,
      e.email.trim(),
      e.email.trim().toLowerCase(),
      e.label ?? null,
      position === 0 ? 1 : 0,
      position,
    );
  });
  return emails[0]?.email.trim().toLowerCase() ?? null;
}

function writePhones(
  ctx: CrmContext,
  contactId: string,
  phones: ContactPhoneInput[],
): string | null {
  ctx.db.run(`DELETE FROM crm_contact_phones WHERE contact_id = ?`, contactId);
  phones.forEach((p, position) => {
    ctx.db.run(
      `INSERT INTO crm_contact_phones (id, contact_id, number, number_digits, extension, type, position)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ctx.newId(),
      contactId,
      p.number,
      p.number.replace(/\D/g, ''),
      p.extension ?? null,
      p.type ?? null,
      position,
    );
  });
  return phones[0]?.number ?? null;
}

function writeAddresses(ctx: CrmContext, contactId: string, addresses: AddressInput[]): void {
  ctx.db.run(`DELETE FROM crm_contact_addresses WHERE contact_id = ?`, contactId);
  addresses.forEach((a, position) => {
    ctx.db.run(
      `INSERT INTO crm_contact_addresses
         (id, contact_id, type, line1, street_number, line2, locality, region, postal_code, country_code, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ctx.newId(),
      contactId,
      a.type ?? 'billing',
      a.line1 ?? null,
      a.street_number ?? null,
      a.line2 ?? null,
      a.locality ?? null,
      a.region ?? null,
      a.postal_code ?? null,
      a.country_code ?? null,
      position,
    );
  });
}

// ------------------------------------------------------------ search index

export function indexContact(ctx: CrmContext, id: string): void {
  const row = ctx.db.all<ContactRow & { company_name: string | null }>(
    `SELECT c.*, co.name AS company_name FROM crm_contacts c
     LEFT JOIN crm_companies co ON co.id = c.company_id WHERE c.id = ?`,
    id,
  )[0];
  if (row === undefined || row.deleted_at !== null) {
    removeDocument(ctx, 'contact', id);
    return;
  }
  const emails = ctx.db.all<{ email: string }>(
    `SELECT email FROM crm_contact_emails WHERE contact_id = ? ORDER BY position`,
    id,
  );
  const phones = ctx.db.all<{ number: string; number_digits: string }>(
    `SELECT number, number_digits FROM crm_contact_phones WHERE contact_id = ? ORDER BY position`,
    id,
  );
  const addresses = ctx.db.all<{
    locality: string | null;
    region: string | null;
    country_code: string | null;
  }>(`SELECT locality, region, country_code FROM crm_contact_addresses WHERE contact_id = ?`, id);
  indexDocument(ctx, 'contact', id, displayName(row) || '(no name)', [
    row.preferred_name,
    row.middle_name,
    ...emails.map((e) => e.email),
    ...phones.flatMap((p) => [p.number, p.number_digits]),
    row.company_name,
    row.job_title,
    row.website,
    ...addresses.flatMap((a) => [a.locality, a.region, a.country_code]),
    ...searchableValues(ctx, 'contact', id),
  ]);
}

// ------------------------------------------------------------ serialization

export function serializeContacts(ctx: CrmContext, rows: ContactRow[]): Contact[] {
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];
  const emails = new Map<string, Contact['emails']>(ids.map((id) => [id, []]));
  const phones = new Map<string, Contact['phones']>(ids.map((id) => [id, []]));
  const addresses = new Map<string, Contact['addresses']>(ids.map((id) => [id, []]));
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const list = placeholders(chunk.length);
    for (const e of ctx.db.all<{
      contact_id: string;
      email: string;
      label: string | null;
      is_primary: number;
    }>(
      `SELECT contact_id, email, label, is_primary FROM crm_contact_emails WHERE contact_id IN (${list}) ORDER BY position`,
      ...chunk,
    )) {
      emails
        .get(e.contact_id)
        ?.push({ email: e.email, label: e.label, is_primary: e.is_primary === 1 });
    }
    for (const p of ctx.db.all<{
      contact_id: string;
      number: string;
      extension: string | null;
      type: string | null;
    }>(
      `SELECT contact_id, number, extension, type FROM crm_contact_phones WHERE contact_id IN (${list}) ORDER BY position`,
      ...chunk,
    )) {
      phones.get(p.contact_id)?.push({ number: p.number, extension: p.extension, type: p.type });
    }
    for (const a of ctx.db.all<{
      contact_id: string;
      type: string;
      line1: string | null;
      street_number: string | null;
      line2: string | null;
      locality: string | null;
      region: string | null;
      postal_code: string | null;
      country_code: string | null;
    }>(
      `SELECT contact_id, type, line1, street_number, line2, locality, region, postal_code, country_code
       FROM crm_contact_addresses WHERE contact_id IN (${list}) ORDER BY position`,
      ...chunk,
    )) {
      const { contact_id: contactId, ...address } = a;
      addresses.get(contactId)?.push(address);
    }
  }
  const tags = tagIdsByContact(ctx, ids);
  const custom = readValues(ctx, 'contact', ids);

  return rows.map((row) => ({
    id: row.id,
    given_name: row.given_name,
    middle_name: row.middle_name,
    family_name: row.family_name,
    prefix: row.prefix,
    suffix: row.suffix,
    preferred_name: row.preferred_name,
    job_title: row.job_title,
    company_id: row.company_id,
    birthday: row.birthday,
    anniversary: row.anniversary,
    website: row.website,
    spouse_name: row.spouse_name,
    time_zone: row.time_zone,
    preferred_locale: row.preferred_locale,
    owner_id: row.owner_id,
    lead_source_id: row.lead_source_id,
    source_type: row.source_type,
    utm: {
      source: row.utm_source,
      medium: row.utm_medium,
      campaign: row.utm_campaign,
      term: row.utm_term,
      content: row.utm_content,
    },
    score_value: row.score_value,
    marketable_status: row.marketable_status,
    emails: emails.get(row.id) ?? [],
    phones: phones.get(row.id) ?? [],
    addresses: addresses.get(row.id) ?? [],
    social_accounts: parseJson<Contact['social_accounts']>(row.social_accounts, []),
    tag_ids: tags.get(row.id) ?? [],
    custom_fields: custom.get(row.id) ?? {},
    merged_into_id: row.merged_into_id,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    deleted_at: toIso(row.deleted_at),
  }));
}

export function getContact(
  ctx: CrmContext,
  input: { id: string; includeDeleted?: boolean },
): Contact {
  const row = getContactRow(ctx, input.id, input.includeDeleted === true);
  const [contact] = serializeContacts(ctx, [row]);
  if (contact === undefined) throw notFound('contact', input.id);
  return contact;
}

export function contactsByIds(ctx: CrmContext, ids: string[]): Contact[] {
  if (ids.length === 0) return [];
  const rows = ctx.db.all<ContactRow>(
    `SELECT * FROM crm_contacts WHERE id IN (${placeholders(ids.length)})`,
    ...ids,
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return serializeContacts(
    ctx,
    ids.map((id) => byId.get(id)).filter((r): r is ContactRow => r !== undefined),
  );
}

// ------------------------------------------------------------ mutations

export interface WriteOptions {
  lenient?: boolean;
  listDelimiter?: string;
  /** Skip the event/index side effects already handled by a caller (merge). */
  silent?: boolean;
  /** False for contacts the system creates (forms, bookings, inbound messages): nobody is there to fill required fields. */
  requireAll?: boolean;
}

export function createContact(
  ctx: CrmContext,
  input: CreateContactInput,
  options: WriteOptions = {},
): Contact {
  const hasIdentity =
    (input.given_name ?? '') !== '' ||
    (input.family_name ?? '') !== '' ||
    (input.emails?.length ?? 0) > 0 ||
    (input.phones?.length ?? 0) > 0;
  if (!hasIdentity) {
    throw invalid('given_name', 'a contact needs a name, an email or a phone number');
  }
  const prepared = prepareContact(ctx, input, 'create', options);
  if (input.tag_ids !== undefined) assertTags(ctx, input.tag_ids);

  const id = ctx.newId();
  const now = ctx.now();
  const columns: string[] = ['id', 'created_by', 'created_at', 'updated_at', 'social_accounts'];
  const values: SqlValue[] = [
    id,
    ctx.actor.id,
    now,
    now,
    JSON.stringify(input.social_accounts ?? []),
  ];
  for (const field of SCALAR_FIELDS) {
    const value = input[field];
    if (value !== undefined) {
      columns.push(field);
      values.push(value);
    }
  }
  for (const key of UTM_KEYS) {
    const value = input.utm?.[key];
    if (value !== undefined) {
      columns.push(`utm_${key}`);
      values.push(value);
    }
  }
  ctx.db.run(
    `INSERT INTO crm_contacts (${columns.join(', ')}) VALUES (${placeholders(columns.length)})`,
    ...values,
  );
  const primaryEmail = writeEmails(ctx, id, prepared.emails ?? []);
  const primaryPhone = writePhones(ctx, id, prepared.phones ?? []);
  writeAddresses(ctx, id, prepared.addresses ?? []);
  ctx.db.run(
    `UPDATE crm_contacts SET primary_email = ?, primary_phone = ? WHERE id = ?`,
    primaryEmail,
    primaryPhone,
    id,
  );
  writeValues(ctx, id, prepared.customFields);

  const name = displayName({
    given_name: input.given_name ?? null,
    family_name: input.family_name ?? null,
    primary_email: primaryEmail,
  });
  emit(ctx, 'contact.created', { contactId: id }, { name });
  if (input.owner_id !== undefined && input.owner_id !== null) {
    emit(ctx, 'contact.owner_assigned', { contactId: id, ownerId: input.owner_id });
  }
  if (input.tag_ids !== undefined) applyTagsToContact(ctx, id, input.tag_ids);
  indexContact(ctx, id);
  return getContact(ctx, { id });
}

export function updateContact(
  ctx: CrmContext,
  input: { id: string; data: UpdateContactInput },
  options: WriteOptions = {},
): Contact {
  const current = getContactRow(ctx, input.id);
  const data = input.data;
  const prepared = prepareContact(ctx, data, 'update', options);
  const changed: string[] = [];
  const sets: string[] = [];
  const values: SqlValue[] = [];

  for (const field of SCALAR_FIELDS) {
    const value = data[field];
    if (value === undefined || value === current[field]) continue;
    sets.push(`${field} = ?`);
    values.push(value);
    changed.push(field);
  }
  for (const key of UTM_KEYS) {
    const value = data.utm?.[key];
    const column = `utm_${key}` as const;
    if (value === undefined || value === current[column]) continue;
    sets.push(`${column} = ?`);
    values.push(value);
    changed.push(column);
  }
  if (data.social_accounts !== undefined) {
    const json = JSON.stringify(data.social_accounts);
    if (json !== current.social_accounts) {
      sets.push('social_accounts = ?');
      values.push(json);
      changed.push('social_accounts');
    }
  }
  if (prepared.emails !== undefined) {
    const before = ctx.db
      .all<{ email: string }>(
        `SELECT email FROM crm_contact_emails WHERE contact_id = ? ORDER BY position`,
        input.id,
      )
      .map((e) => e.email);
    const after = prepared.emails.map((e) => e.email.trim());
    if (JSON.stringify(before) !== JSON.stringify(after)) changed.push('emails');
    sets.push('primary_email = ?');
    values.push(writeEmails(ctx, input.id, prepared.emails));
  }
  if (prepared.phones !== undefined) {
    const before = ctx.db
      .all<{ number: string }>(
        `SELECT number FROM crm_contact_phones WHERE contact_id = ? ORDER BY position`,
        input.id,
      )
      .map((p) => p.number);
    if (JSON.stringify(before) !== JSON.stringify(prepared.phones.map((p) => p.number))) {
      changed.push('phones');
    }
    sets.push('primary_phone = ?');
    values.push(writePhones(ctx, input.id, prepared.phones));
  }
  if (prepared.addresses !== undefined) {
    writeAddresses(ctx, input.id, prepared.addresses);
    changed.push('addresses');
  }
  changed.push(...writeValues(ctx, input.id, prepared.customFields).map((key) => `custom.${key}`));

  if (changed.length > 0) {
    sets.push('updated_at = ?');
    values.push(ctx.now());
    ctx.db.run(`UPDATE crm_contacts SET ${sets.join(', ')} WHERE id = ?`, ...values, input.id);
    if (options.silent !== true) {
      emit(ctx, 'contact.updated', { contactId: input.id, changedFields: changed });
      if (data.score_value !== undefined && data.score_value !== current.score_value) {
        emit(ctx, 'contact.score_changed', {
          contactId: input.id,
          from: current.score_value,
          to: data.score_value,
        });
      }
      if (data.owner_id !== undefined && data.owner_id !== current.owner_id) {
        emit(ctx, 'contact.owner_assigned', { contactId: input.id, ownerId: data.owner_id });
      }
    }
    indexContact(ctx, input.id);
  }
  return getContact(ctx, { id: input.id });
}

export function deleteContact(
  ctx: CrmContext,
  input: { id: string },
): { id: string; deleted: true } {
  getContactRow(ctx, input.id);
  const now = ctx.now();
  ctx.db.run(
    `UPDATE crm_contacts SET deleted_at = ?, updated_at = ? WHERE id = ?`,
    now,
    now,
    input.id,
  );
  removeDocument(ctx, 'contact', input.id);
  emit(ctx, 'contact.deleted', { contactId: input.id });
  return { id: input.id, deleted: true };
}

export function restoreContact(ctx: CrmContext, input: { id: string }): Contact {
  const row = getContactRow(ctx, input.id, true);
  if (row.deleted_at === null) return getContact(ctx, { id: input.id });
  if (row.merged_into_id !== null) {
    throw invalid('id', `contact was merged into ${row.merged_into_id} and cannot be restored`);
  }
  ctx.db.run(
    `UPDATE crm_contacts SET deleted_at = NULL, updated_at = ? WHERE id = ?`,
    ctx.now(),
    input.id,
  );
  indexContact(ctx, input.id);
  emit(ctx, 'contact.restored', { contactId: input.id });
  return getContact(ctx, { id: input.id });
}

/** Hard purge of a contact's satellite rows (used after merge). */
export function purgeContactSatellites(ctx: CrmContext, id: string): void {
  ctx.db.run(`DELETE FROM crm_contact_emails WHERE contact_id = ?`, id);
  ctx.db.run(`DELETE FROM crm_contact_phones WHERE contact_id = ?`, id);
  ctx.db.run(`DELETE FROM crm_contact_addresses WHERE contact_id = ?`, id);
  ctx.db.run(`DELETE FROM crm_contact_tags WHERE contact_id = ?`, id);
  deleteValuesOf(ctx, 'contact', id);
}

/** Translates the simple list query parameters into query-builder conditions. */
export function listContactsConditions(input: ListContactsQuery): FilterLeaf[] {
  const conditions: FilterLeaf[] = [];
  if (input.email !== undefined) {
    conditions.push({ type: 'field', field: 'any_email', operator: 'equals', value: input.email });
  }
  if (input.tag_id !== undefined) {
    conditions.push({ type: 'tags', match: 'any', tag_ids: [input.tag_id] });
  }
  if (input.owner_id !== undefined) {
    conditions.push({
      type: 'field',
      field: 'owner_id',
      operator: 'equals',
      value: input.owner_id,
    });
  }
  if (input.company_id !== undefined) {
    conditions.push({
      type: 'field',
      field: 'company_id',
      operator: 'equals',
      value: input.company_id,
    });
  }
  if (input.updated_since !== undefined) {
    conditions.push({
      type: 'field',
      field: 'updated_at',
      operator: 'gte',
      value: input.updated_since,
    });
  }
  return conditions;
}

export type ContactPage = Page<Contact>;
