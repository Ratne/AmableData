import type {
  Company,
  CreateCompanyInput,
  CreateLeadSourceInput,
  LeadSource,
  UpdateCompanyInput,
} from '@amable/api-types';
import type { CrmContext } from './context';
import { placeholders, type SqlValue } from './db/sql';
import { CrmError, notFound } from './errors';
import { emit } from './events';
import { prepareValues, readValues, searchableValues, writeValues } from './custom-fields/repo';
import { indexContact } from './contacts';
import { indexDocument, removeDocument } from './search/index-store';
import { toIso } from './util';

interface CompanyRow {
  id: string;
  name: string;
  website: string | null;
  email: string | null;
  phone: string | null;
  phone_extension: string | null;
  fax: string | null;
  address_line1: string | null;
  address_line2: string | null;
  address_locality: string | null;
  address_region: string | null;
  address_postal_code: string | null;
  address_country_code: string | null;
  description: string | null;
  owner_id: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  contact_count: number;
}

const COMPANY_SELECT = `SELECT r.*, (SELECT COUNT(*) FROM crm_contacts c
  WHERE c.company_id = r.id AND c.deleted_at IS NULL) AS contact_count FROM crm_companies r`;

const SIMPLE_FIELDS = [
  'name',
  'website',
  'email',
  'phone',
  'phone_extension',
  'fax',
  'description',
  'owner_id',
] as const satisfies ReadonlyArray<keyof UpdateCompanyInput & keyof CompanyRow>;

const ADDRESS_FIELDS = [
  'line1',
  'line2',
  'locality',
  'region',
  'postal_code',
  'country_code',
] as const;

function getCompanyRow(ctx: CrmContext, id: string, includeDeleted = false): CompanyRow {
  const row = ctx.db.all<CompanyRow>(
    `${COMPANY_SELECT} WHERE r.id = ? ${includeDeleted ? '' : 'AND r.deleted_at IS NULL'}`,
    id,
  )[0];
  if (row === undefined) throw notFound('company', id);
  return row;
}

export function serializeCompanies(ctx: CrmContext, rows: CompanyRow[]): Company[] {
  const custom = readValues(
    ctx,
    'company',
    rows.map((r) => r.id),
  );
  return rows.map((row) => {
    const hasAddress = ADDRESS_FIELDS.some((f) => row[`address_${f}`] !== null);
    return {
      id: row.id,
      name: row.name,
      website: row.website,
      email: row.email,
      phone: row.phone,
      phone_extension: row.phone_extension,
      fax: row.fax,
      address: hasAddress
        ? {
            line1: row.address_line1,
            line2: row.address_line2,
            locality: row.address_locality,
            region: row.address_region,
            postal_code: row.address_postal_code,
            country_code: row.address_country_code,
          }
        : null,
      description: row.description,
      owner_id: row.owner_id,
      contact_count: row.contact_count,
      custom_fields: custom.get(row.id) ?? {},
      created_at: toIso(row.created_at),
      updated_at: toIso(row.updated_at),
      deleted_at: toIso(row.deleted_at),
    };
  });
}

export function companiesByIds(ctx: CrmContext, ids: string[]): Company[] {
  if (ids.length === 0) return [];
  const rows = ctx.db.all<CompanyRow>(
    `${COMPANY_SELECT} WHERE r.id IN (${placeholders(ids.length)})`,
    ...ids,
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return serializeCompanies(
    ctx,
    ids.map((id) => byId.get(id)).filter((r): r is CompanyRow => r !== undefined),
  );
}

function indexCompany(ctx: CrmContext, id: string): void {
  const row = ctx.db.all<CompanyRow>(`${COMPANY_SELECT} WHERE r.id = ?`, id)[0];
  if (row === undefined || row.deleted_at !== null) {
    removeDocument(ctx, 'company', id);
    return;
  }
  indexDocument(ctx, 'company', id, row.name, [
    row.website,
    row.email,
    row.phone,
    row.address_locality,
    row.address_region,
    row.address_country_code,
    row.description,
    ...searchableValues(ctx, 'company', id),
  ]);
}

export function getCompany(ctx: CrmContext, input: { id: string }): Company {
  const [company] = serializeCompanies(ctx, [getCompanyRow(ctx, input.id)]);
  if (company === undefined) throw notFound('company', input.id);
  return company;
}

export function createCompany(ctx: CrmContext, input: CreateCompanyInput): Company {
  const custom = prepareValues(ctx, 'company', input.custom_fields, { requireAll: true });
  const id = ctx.newId();
  const now = ctx.now();
  const columns = ['id', 'created_by', 'created_at', 'updated_at'];
  const values: SqlValue[] = [id, ctx.actor.id, now, now];
  for (const field of SIMPLE_FIELDS) {
    const value = input[field];
    if (value !== undefined) {
      columns.push(field);
      values.push(value);
    }
  }
  for (const field of ADDRESS_FIELDS) {
    const value = input.address?.[field];
    if (value !== undefined) {
      columns.push(`address_${field}`);
      values.push(value);
    }
  }
  ctx.db.run(
    `INSERT INTO crm_companies (${columns.join(', ')}) VALUES (${placeholders(columns.length)})`,
    ...values,
  );
  writeValues(ctx, id, custom);
  emit(ctx, 'company.created', { companyId: id }, { name: input.name });
  indexCompany(ctx, id);
  return getCompany(ctx, { id });
}

export function updateCompany(
  ctx: CrmContext,
  input: { id: string; data: UpdateCompanyInput },
): Company {
  const current = getCompanyRow(ctx, input.id);
  const data = input.data;
  const custom = prepareValues(ctx, 'company', data.custom_fields);
  const sets: string[] = [];
  const values: SqlValue[] = [];
  const changed: string[] = [];
  for (const field of SIMPLE_FIELDS) {
    const value = data[field];
    if (value === undefined || value === current[field]) continue;
    sets.push(`${field} = ?`);
    values.push(value);
    changed.push(field);
  }
  if (data.address !== undefined) {
    for (const field of ADDRESS_FIELDS) {
      const value = data.address === null ? null : (data.address[field] ?? null);
      if (value === current[`address_${field}`]) continue;
      sets.push(`address_${field} = ?`);
      values.push(value);
      if (!changed.includes('address')) changed.push('address');
    }
  }
  changed.push(...writeValues(ctx, input.id, custom).map((k) => `custom.${k}`));
  if (changed.length > 0) {
    sets.push('updated_at = ?');
    values.push(ctx.now());
    ctx.db.run(`UPDATE crm_companies SET ${sets.join(', ')} WHERE id = ?`, ...values, input.id);
    emit(ctx, 'company.updated', { companyId: input.id, changedFields: changed });
    indexCompany(ctx, input.id);
    if (changed.includes('name')) {
      // Contact search documents embed the company name.
      for (const { id } of ctx.db.all<{ id: string }>(
        `SELECT id FROM crm_contacts WHERE company_id = ? AND deleted_at IS NULL`,
        input.id,
      )) {
        indexContact(ctx, id);
      }
    }
  }
  return getCompany(ctx, { id: input.id });
}

/** Soft-deletes the company; linked contacts keep the reference (restorable). */
export function deleteCompany(
  ctx: CrmContext,
  input: { id: string },
): { id: string; deleted: true } {
  getCompanyRow(ctx, input.id);
  const now = ctx.now();
  ctx.db.run(
    `UPDATE crm_companies SET deleted_at = ?, updated_at = ? WHERE id = ?`,
    now,
    now,
    input.id,
  );
  removeDocument(ctx, 'company', input.id);
  emit(ctx, 'company.deleted', { companyId: input.id });
  return { id: input.id, deleted: true };
}

export function restoreCompany(ctx: CrmContext, input: { id: string }): Company {
  getCompanyRow(ctx, input.id, true);
  ctx.db.run(
    `UPDATE crm_companies SET deleted_at = NULL, updated_at = ? WHERE id = ?`,
    ctx.now(),
    input.id,
  );
  indexCompany(ctx, input.id);
  return getCompany(ctx, { id: input.id });
}

/** Case-insensitive lookup by name, creating the company when missing (CSV import). */
export function findOrCreateCompanyByName(ctx: CrmContext, name: string): string {
  const trimmed = name.trim().slice(0, 255);
  const existing = ctx.db.all<{ id: string }>(
    `SELECT id FROM crm_companies WHERE name = ? COLLATE NOCASE AND deleted_at IS NULL ORDER BY id LIMIT 1`,
    trimmed,
  )[0];
  return existing?.id ?? createCompany(ctx, { name: trimmed }).id;
}

// ------------------------------------------------------------- lead sources

export function listLeadSources(ctx: CrmContext, _input: Record<string, never>): LeadSource[] {
  return ctx.db
    .all<{ id: string; name: string; category: string | null; created_at: number }>(
      `SELECT id, name, category, created_at FROM crm_lead_sources WHERE deleted_at IS NULL ORDER BY name`,
    )
    .map((r) => ({ ...r, created_at: toIso(r.created_at) }));
}

export function createLeadSource(ctx: CrmContext, input: CreateLeadSourceInput): LeadSource {
  const taken = ctx.db.all(
    `SELECT 1 FROM crm_lead_sources WHERE name = ? AND deleted_at IS NULL`,
    input.name,
  );
  if (taken.length > 0)
    throw new CrmError('conflict', `lead source "${input.name}" already exists`);
  const id = ctx.newId();
  const now = ctx.now();
  ctx.db.run(
    `INSERT INTO crm_lead_sources (id, name, category, created_at) VALUES (?, ?, ?, ?)`,
    id,
    input.name,
    input.category ?? null,
    now,
  );
  return { id, name: input.name, category: input.category ?? null, created_at: toIso(now) };
}

export function findOrCreateLeadSource(ctx: CrmContext, name: string): string {
  const existing = ctx.db.all<{ id: string }>(
    `SELECT id FROM crm_lead_sources WHERE name = ? COLLATE NOCASE AND deleted_at IS NULL LIMIT 1`,
    name.trim(),
  )[0];
  return existing?.id ?? createLeadSource(ctx, { name: name.trim().slice(0, 255) }).id;
}
