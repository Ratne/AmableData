import {
  createContactSchema,
  type CreateImportInput,
  type CreateContactInput,
  type ImportJob,
} from '@amable/api-types';
import type { CrmContext } from '../context';
import { CrmError, invalidMany, notFound } from '../errors';
import { emit } from '../events';
import { loadFieldDefs, prepareValues } from '../custom-fields/repo';
import { createContact, updateContact } from '../contacts';
import { findOrCreateCompanyByName, findOrCreateLeadSource } from '../companies';
import { applyTagsToContact, assertTags, findOrCreateTagByName } from '../tags';
import { parseJson, toIso } from '../util';
import { mapRow, validateMapping } from './mapping';

interface ImportRow {
  id: string;
  entity: 'contact';
  status: ImportJob['status'];
  mapping: string;
  options: string;
  total_rows: number;
  created: number;
  updated: number;
  failed: number;
  errors: string;
  created_at: number;
  finished_at: number | null;
}

type ImportOptions = NonNullable<CreateImportInput['options']>;

const MAX_STORED_ERRORS = 100;

function toApi(row: ImportRow): ImportJob {
  return {
    id: row.id,
    entity: row.entity,
    status: row.status,
    mapping: parseJson<Record<string, string>>(row.mapping, {}),
    total_rows: row.total_rows,
    created: row.created,
    updated: row.updated,
    failed: row.failed,
    errors: parseJson<ImportJob['errors']>(row.errors, []),
    created_at: toIso(row.created_at),
    finished_at: toIso(row.finished_at),
  };
}

function getRow(ctx: CrmContext, id: string): ImportRow {
  const row = ctx.db.all<ImportRow>(`SELECT * FROM crm_imports WHERE id = ?`, id)[0];
  if (row === undefined) throw notFound('import', id);
  return row;
}

export function getImport(ctx: CrmContext, input: { id: string }): ImportJob {
  return toApi(getRow(ctx, input.id));
}

export function createImport(ctx: CrmContext, input: CreateImportInput): ImportJob {
  const customKeys = new Set(loadFieldDefs(ctx, 'contact').map((d) => d.key));
  const mapping = Object.fromEntries(
    Object.entries(input.mapping).map(([k, v]) => [k.trim(), v.trim()]),
  );
  const problems = validateMapping(mapping, customKeys);
  if (problems.length > 0) {
    throw invalidMany(problems.map((message) => ({ path: 'mapping', message })));
  }
  if (input.options?.tag_ids !== undefined)
    assertTags(ctx, input.options.tag_ids, 'options.tag_ids');
  const id = ctx.newId();
  ctx.db.run(
    `INSERT INTO crm_imports (id, entity, status, mapping, options, created_by, created_at)
     VALUES (?, 'contact', 'pending', ?, ?, ?, ?)`,
    id,
    JSON.stringify(mapping),
    JSON.stringify(input.options ?? {}),
    ctx.actor.id,
    ctx.now(),
  );
  return getImport(ctx, { id });
}

function findExisting(ctx: CrmContext, email: string): string | null {
  const row = ctx.db.all<{ id: string }>(
    `SELECT c.id FROM crm_contacts c WHERE c.deleted_at IS NULL AND (c.primary_email = ? OR EXISTS
       (SELECT 1 FROM crm_contact_emails e WHERE e.contact_id = c.id AND e.email_normalized = ?))
     ORDER BY c.id LIMIT 1`,
    email,
    email,
  )[0];
  return row?.id ?? null;
}

/**
 * Processes one batch of data rows (called repeatedly while the CSV streams).
 * Each row is validated in full (schema + custom fields) before anything is
 * written; failing rows are counted and reported, never abort the batch.
 */
export function importRows(
  ctx: CrmContext,
  input: { importId: string; header: string[]; rows: string[][]; firstRowNumber: number },
): ImportJob {
  const job = getRow(ctx, input.importId);
  if (job.status === 'completed' || job.status === 'failed') {
    throw new CrmError('conflict', `import ${job.id} is already ${job.status}`);
  }
  const mapping = parseJson<Record<string, string>>(job.mapping, {});
  const options = parseJson<ImportOptions>(job.options, {});
  const delimiter = options.list_delimiter ?? ';';
  const defs = loadFieldDefs(ctx, 'contact');
  const errors = parseJson<ImportJob['errors']>(job.errors, []);
  let created = 0;
  let updated = 0;
  let failed = 0;
  let total = 0;

  input.rows.forEach((row, offset) => {
    const rowNumber = input.firstRowNumber + offset;
    if (row.every((cell) => cell.trim() === '')) return;
    total += 1;
    try {
      const mapped = mapRow(input.header, row, mapping, delimiter);
      const parsed = createContactSchema.safeParse({
        ...mapped.contact,
        source_type: options.source_type ?? 'import',
      });
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new CrmError(
          'validation_failed',
          `${issue?.path.join('.') ?? 'row'}: ${issue?.message ?? 'invalid'}`,
        );
      }
      const data: CreateContactInput = parsed.data;
      // Validate custom fields up front (lenient: text cells are coerced).
      prepareValues(ctx, 'contact', data.custom_fields, {
        lenient: true,
        listDelimiter: delimiter,
        defs,
      });

      const existingId =
        options.update_existing !== false && mapped.primaryEmail !== null
          ? findExisting(ctx, mapped.primaryEmail)
          : null;
      if (mapped.companyName !== null)
        data.company_id = findOrCreateCompanyByName(ctx, mapped.companyName);
      if (mapped.leadSourceName !== null)
        data.lead_source_id = findOrCreateLeadSource(ctx, mapped.leadSourceName);
      const tagIds = [
        ...(options.tag_ids ?? []),
        ...mapped.tagNames.map((name) => findOrCreateTagByName(ctx, name)),
      ];

      let contactId: string;
      if (existingId !== null) {
        const { source_type: _source, emails, ...rest } = data;
        // Keep the existing email list; only add new addresses from the row.
        const update =
          emails === undefined ? rest : { ...rest, emails: mergeEmails(ctx, existingId, emails) };
        contactId = updateContact(
          ctx,
          { id: existingId, data: update },
          { lenient: true, listDelimiter: delimiter },
        ).id;
        updated += 1;
      } else {
        contactId = createContact(ctx, data, { lenient: true, listDelimiter: delimiter }).id;
        created += 1;
      }
      if (tagIds.length > 0) applyTagsToContact(ctx, contactId, tagIds);
    } catch (error) {
      failed += 1;
      if (errors.length < MAX_STORED_ERRORS) {
        errors.push({
          row: rowNumber,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });

  ctx.db.run(
    `UPDATE crm_imports SET status = 'running', total_rows = total_rows + ?, created = created + ?,
       updated = updated + ?, failed = failed + ?, errors = ? WHERE id = ?`,
    total,
    created,
    updated,
    failed,
    JSON.stringify(errors),
    job.id,
  );
  return getImport(ctx, { id: job.id });
}

function mergeEmails(
  ctx: CrmContext,
  contactId: string,
  incoming: NonNullable<CreateContactInput['emails']>,
): NonNullable<CreateContactInput['emails']> {
  const current = ctx.db.all<{ email: string; label: string | null }>(
    `SELECT email, label FROM crm_contact_emails WHERE contact_id = ? ORDER BY position`,
    contactId,
  );
  const seen = new Set(current.map((e) => e.email.toLowerCase()));
  const merged: NonNullable<CreateContactInput['emails']> = current.map((e) => ({
    email: e.email,
  }));
  for (const e of incoming) {
    if (!seen.has(e.email.toLowerCase()) && merged.length < 5) merged.push(e);
  }
  return merged;
}

export function finishImport(
  ctx: CrmContext,
  input: { importId: string; error?: string },
): ImportJob {
  const job = getRow(ctx, input.importId);
  const errors = parseJson<ImportJob['errors']>(job.errors, []);
  if (input.error !== undefined) errors.push({ row: 0, message: input.error });
  const status = input.error === undefined ? 'completed' : 'failed';
  ctx.db.run(
    `UPDATE crm_imports SET status = ?, finished_at = ?, errors = ? WHERE id = ?`,
    status,
    ctx.now(),
    JSON.stringify(errors),
    job.id,
  );
  emit(ctx, 'import.completed', {
    importId: job.id,
    created: job.created,
    updated: job.updated,
    failed: job.failed,
  });
  return getImport(ctx, { id: job.id });
}
