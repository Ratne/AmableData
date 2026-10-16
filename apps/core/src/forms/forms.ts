import type {
  CreateFormInput,
  Form,
  FormSummary,
  ListFormsQuery,
  Page,
  UpdateFormInput,
} from '@amable/api-types';
import {
  collectsValue,
  defaultFormDefinition,
  formDefinitionSchema,
  type FormDefinition,
} from '@amable/forms';
import type { CrmContext } from '../crm/context';
import type { SqlValue } from '../crm/db/sql';
import { CrmError, invalidMany, notFound } from '../crm/errors';
import { assertRef } from '../crm/refs';
import { assertTags } from '../crm/tags';
import { decodeCursor, paginate, parseJson, toIso } from '../crm/util';

export interface FormRow {
  id: string;
  name: string;
  status: 'active' | 'inactive';
  definition: string;
  submission_count: number;
  last_submission_at: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  deleted_at: number | null;
}

/** Validates a definition document; Zod issues become `validation_failed` details under `definition.`. */
export function parseDefinition(input: unknown): FormDefinition {
  const result = formDefinitionSchema.safeParse(input);
  if (!result.success) {
    throw invalidMany(
      result.error.issues.map((issue) => ({
        path: ['definition', ...issue.path.map(String)].join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

/** Stored definitions were validated on write; a corrupt row falls back to an empty form. */
export function storedDefinition(row: Pick<FormRow, 'definition'>): FormDefinition {
  const result = formDefinitionSchema.safeParse(parseJson<unknown>(row.definition, {}));
  return result.success ? result.data : formDefinitionSchema.parse({});
}

function assertCrmRefs(ctx: CrmContext, definition: FormDefinition): void {
  if (definition.crm.tag_ids.length > 0) {
    assertTags(ctx, definition.crm.tag_ids, 'definition.crm.tag_ids');
  }
  assertRef(ctx, 'lead_source', definition.crm.lead_source_id, 'definition.crm.lead_source_id');
}

export function getFormRow(ctx: CrmContext, id: string): FormRow {
  const row = ctx.db.all<FormRow>(`SELECT * FROM form_forms WHERE id = ? AND deleted_at IS NULL`, id)[0];
  if (row === undefined) throw notFound('form', id);
  return row;
}

function connectionCounts(ctx: CrmContext, ids: string[]): Map<string, number> {
  if (ids.length === 0) return new Map();
  const rows = ctx.db.all<{ form_id: string; n: number }>(
    `SELECT form_id, COUNT(*) AS n FROM form_connections
     WHERE deleted_at IS NULL AND form_id IN (${ids.map(() => '?').join(', ')}) GROUP BY form_id`,
    ...ids,
  );
  return new Map(rows.map((r) => [r.form_id, r.n]));
}

function serializeBase(row: FormRow) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    archived: row.archived_at !== null,
    submission_count: row.submission_count,
    last_submission_at: toIso(row.last_submission_at),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    archived_at: toIso(row.archived_at),
  };
}

export function serializeForm(row: FormRow): Form {
  return { ...serializeBase(row), definition: storedDefinition(row) as unknown as Form['definition'] };
}

export function listForms(ctx: CrmContext, input: ListFormsQuery): Page<FormSummary> {
  const where: string[] = ['deleted_at IS NULL'];
  const params: SqlValue[] = [];
  if (input.status === 'archived') {
    where.push('archived_at IS NOT NULL');
  } else {
    where.push('archived_at IS NULL');
    if (input.status !== undefined) {
      where.push('status = ?');
      params.push(input.status);
    }
  }
  if (input.q !== undefined && input.q !== '') {
    where.push(`name LIKE ? ESCAPE '\\'`);
    params.push(`%${input.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
  }
  if (input.cursor !== undefined) {
    const cursor = decodeCursor(input.cursor);
    where.push('(updated_at < ? OR (updated_at = ? AND id < ?))');
    params.push(Number(cursor.v), Number(cursor.v), cursor.id);
  }
  const rows = ctx.db.all<FormRow>(
    `SELECT * FROM form_forms WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT ?`,
    ...params,
    input.limit + 1,
  );
  const page = paginate(rows, input.limit, (row) => ({ v: row.updated_at, id: row.id }));
  const counts = connectionCounts(
    ctx,
    page.rows.map((r) => r.id),
  );
  return {
    data: page.rows.map((row) => ({
      ...serializeBase(row),
      field_count: storedDefinition(row).fields.filter((f) => collectsValue(f.kind)).length,
      connection_count: counts.get(row.id) ?? 0,
    })),
    next_cursor: page.nextCursor,
  };
}

export function getForm(ctx: CrmContext, input: { id: string }): Form {
  return serializeForm(getFormRow(ctx, input.id));
}

export function createForm(
  ctx: CrmContext,
  input: CreateFormInput & { locale?: 'en' | 'it' },
): Form {
  const definition =
    input.definition === undefined ? defaultFormDefinition(input.locale ?? 'en') : parseDefinition(input.definition);
  assertCrmRefs(ctx, definition);
  const id = ctx.newId();
  const now = ctx.now();
  ctx.db.run(
    `INSERT INTO form_forms (id, name, status, definition, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.name.trim(),
    input.status ?? 'active',
    JSON.stringify(definition),
    ctx.actor.id,
    now,
    now,
  );
  return getForm(ctx, { id });
}

export function updateForm(ctx: CrmContext, input: { id: string; data: UpdateFormInput }): Form {
  const row = getFormRow(ctx, input.id);
  const sets: string[] = [];
  const values: SqlValue[] = [];
  if (input.data.name !== undefined) {
    sets.push('name = ?');
    values.push(input.data.name.trim());
  }
  if (input.data.status !== undefined) {
    sets.push('status = ?');
    values.push(input.data.status);
  }
  if (input.data.definition !== undefined) {
    const definition = parseDefinition(input.data.definition);
    assertCrmRefs(ctx, definition);
    sets.push('definition = ?');
    values.push(JSON.stringify(definition));
  }
  if (sets.length > 0) {
    sets.push('updated_at = ?');
    values.push(ctx.now());
    ctx.db.run(`UPDATE form_forms SET ${sets.join(', ')} WHERE id = ?`, ...values, row.id);
  }
  return getForm(ctx, { id: row.id });
}

export function deleteForm(ctx: CrmContext, input: { id: string }): { id: string; deleted: true } {
  const row = getFormRow(ctx, input.id);
  const now = ctx.now();
  ctx.db.run(`UPDATE form_forms SET deleted_at = ?, updated_at = ? WHERE id = ?`, now, now, row.id);
  ctx.db.run(
    `UPDATE form_connections SET deleted_at = ?, updated_at = ? WHERE form_id = ? AND deleted_at IS NULL`,
    now,
    now,
    row.id,
  );
  return { id: row.id, deleted: true };
}

/** Copies name and definition; connections (and their secrets) are not copied. */
export function duplicateForm(ctx: CrmContext, input: { id: string; name?: string }): Form {
  const row = getFormRow(ctx, input.id);
  const id = ctx.newId();
  const now = ctx.now();
  ctx.db.run(
    `INSERT INTO form_forms (id, name, status, definition, created_by, created_at, updated_at)
     VALUES (?, ?, 'inactive', ?, ?, ?, ?)`,
    id,
    (input.name ?? `${row.name} (copy)`).slice(0, 200),
    row.definition,
    ctx.actor.id,
    now,
    now,
  );
  return getForm(ctx, { id });
}

export function archiveForm(ctx: CrmContext, input: { id: string }): Form {
  const row = getFormRow(ctx, input.id);
  if (row.archived_at === null) {
    const now = ctx.now();
    ctx.db.run(`UPDATE form_forms SET archived_at = ?, updated_at = ? WHERE id = ?`, now, now, row.id);
  }
  return getForm(ctx, { id: row.id });
}

export function restoreForm(ctx: CrmContext, input: { id: string }): Form {
  const row = getFormRow(ctx, input.id);
  if (row.archived_at !== null) {
    ctx.db.run(`UPDATE form_forms SET archived_at = NULL, updated_at = ? WHERE id = ?`, ctx.now(), row.id);
  }
  return getForm(ctx, { id: row.id });
}

/** Form as seen by the public: only active, non-archived forms exist. */
export function publicForm(
  ctx: CrmContext,
  input: { id: string },
): { id: string; name: string; definition: FormDefinition } {
  const row = ctx.db.all<FormRow>(
    `SELECT * FROM form_forms WHERE id = ? AND deleted_at IS NULL AND archived_at IS NULL AND status = 'active'`,
    input.id,
  )[0];
  if (row === undefined) throw new CrmError('not_found', 'form not found');
  return { id: row.id, name: row.name, definition: storedDefinition(row) };
}
