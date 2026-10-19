import {
  ESIGN_DEFAULT_SETTINGS,
  esignSettingsSchema,
  type CreateEsignTemplateInput,
  type EsignField,
  type EsignParty,
  type EsignTemplate,
  type ListEsignTemplatesQuery,
  type Page,
  type UpdateEsignTemplateInput,
} from '@amable/api-types';
import type { EsignTemplateCatalog } from '../automation/validate';
import type { CrmContext } from '../crm/context';
import { CrmError, invalid, notFound } from '../crm/errors';
import { decodeCursor, paginate, toIso } from '../crm/util';
import {
  fieldsOf,
  pagesOf,
  partiesOf,
  rememberTenant,
  settingsOf,
  type StoredPage,
  type TemplateRow,
  type TenantFacts,
} from './model';

/**
 * Signature templates in the TenantDb: the PDF and page images live in R2
 * (the worker uploads them and passes the keys in), parties and fields are
 * JSON on the row. A template can be sent once it is `active` and `ready`.
 */

const DEFAULT_PARTIES: EsignParty[] = [{ id: 'first', name: 'First party', color: '#4f46e5' }];

/** Every page has its image and every party has at least one field on an existing page. */
export function templateReady(
  pages: readonly StoredPage[],
  parties: readonly EsignParty[],
  fields: readonly EsignField[],
): boolean {
  if (pages.length === 0 || pages.some((p) => p.image_key === null)) return false;
  if (parties.length === 0) return false;
  return parties.every((party) =>
    fields.some((f) => f.party_id === party.id && f.page < pages.length),
  );
}

export function templateToApi(row: TemplateRow): EsignTemplate {
  const pages = pagesOf(row.pages);
  const parties = partiesOf(row.parties);
  const fields = fieldsOf(row.fields);
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    source:
      row.source_r2_key === null
        ? null
        : {
            filename: row.source_filename ?? 'document.pdf',
            size: row.source_size ?? 0,
            sha256: row.source_sha256 ?? '',
          },
    pages: pages.map((p) => ({
      index: p.index,
      width: p.width,
      height: p.height,
      has_image: p.image_key !== null,
    })),
    parties,
    signing_order: row.signing_order,
    fields,
    settings: settingsOf(row.settings),
    ready: templateReady(pages, parties, fields),
    created_by: row.created_by,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

export function getTemplateRow(ctx: CrmContext, id: string): TemplateRow {
  const row = ctx.db.all<TemplateRow>(
    `SELECT * FROM esign_templates WHERE id = ? AND deleted_at IS NULL`,
    id,
  )[0];
  if (row === undefined) throw notFound('signature template', id);
  return row;
}

function checkFields(
  parties: readonly EsignParty[],
  fields: readonly EsignField[],
  pageCount: number | null,
): void {
  const ids = new Set(parties.map((p) => p.id));
  fields.forEach((field, i) => {
    if (!ids.has(field.party_id))
      throw invalid(`fields.${String(i)}.party_id`, `unknown party ${field.party_id}`);
    if (pageCount !== null && pageCount > 0 && field.page >= pageCount) {
      throw invalid(`fields.${String(i)}.page`, `the document has ${String(pageCount)} page(s)`);
    }
  });
}

/** Party ids and sendability of every template, for publish validation of automation steps. */
export function templateCatalog(
  ctx: CrmContext,
  _input: Record<string, never> = {},
): EsignTemplateCatalog {
  const catalog: Record<string, { parties: string[]; sendable: boolean }> = {};
  for (const row of ctx.db.all<TemplateRow>(`SELECT * FROM esign_templates WHERE deleted_at IS NULL`)) {
    const template = templateToApi(row);
    catalog[row.id] = {
      parties: template.parties.map((p) => p.id),
      sendable: template.status === 'active' && template.ready,
    };
  }
  return catalog;
}

export function listTemplates(
  ctx: CrmContext,
  input: ListEsignTemplatesQuery,
): Page<EsignTemplate> {
  const after = input.cursor === undefined ? null : decodeCursor(input.cursor).id;
  const like = input.q === undefined || input.q === '' ? null : `%${input.q.toLowerCase()}%`;
  const rows = ctx.db.all<TemplateRow>(
    `SELECT * FROM esign_templates
     WHERE deleted_at IS NULL AND (? IS NULL OR status = ?) AND (? IS NULL OR lower(name) LIKE ?)
       AND (? IS NULL OR id < ?)
     ORDER BY id DESC LIMIT ?`,
    input.status ?? null,
    input.status ?? null,
    like,
    like,
    after,
    after,
    input.limit + 1,
  );
  const page = paginate(rows, input.limit, (row) => ({ v: null, id: row.id }));
  return { data: page.rows.map(templateToApi), next_cursor: page.nextCursor };
}

export function getTemplate(ctx: CrmContext, input: { id: string }): EsignTemplate {
  return templateToApi(getTemplateRow(ctx, input.id));
}

export function createTemplate(
  ctx: CrmContext,
  input: { data: CreateEsignTemplateInput; tenant?: TenantFacts },
): EsignTemplate {
  const parties = input.data.parties ?? DEFAULT_PARTIES;
  const fields = (input.data.fields ?? []) as EsignField[];
  checkFields(parties, fields, null);
  const settings = esignSettingsSchema.parse({ ...ESIGN_DEFAULT_SETTINGS, ...input.data.settings });
  const id = ctx.newId();
  const now = ctx.now();
  ctx.db.run(
    `INSERT INTO esign_templates (id, name, status, pages, parties, signing_order, fields, settings, created_by, created_at, updated_at)
     VALUES (?, ?, 'draft', '[]', ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.data.name,
    JSON.stringify(parties),
    input.data.signing_order ?? 'parallel',
    JSON.stringify(fields),
    JSON.stringify(settings),
    ctx.actor.id,
    now,
    now,
  );
  rememberTenant(ctx, input.tenant);
  return getTemplate(ctx, { id });
}

export function updateTemplate(
  ctx: CrmContext,
  input: { id: string; data: UpdateEsignTemplateInput; tenant?: TenantFacts },
): EsignTemplate {
  const row = getTemplateRow(ctx, input.id);
  const pages = pagesOf(row.pages);
  const parties = input.data.parties ?? partiesOf(row.parties);
  let fields = (input.data.fields as EsignField[] | undefined) ?? fieldsOf(row.fields);
  if (input.data.parties !== undefined && input.data.fields === undefined) {
    const kept = new Set(parties.map((p) => p.id));
    fields = fields.filter((f) => kept.has(f.party_id));
  }
  checkFields(parties, fields, pages.length);
  const settings =
    input.data.settings === undefined
      ? settingsOf(row.settings)
      : esignSettingsSchema.parse({ ...settingsOf(row.settings), ...input.data.settings });
  const status = input.data.status ?? row.status;
  if (status === 'active' && !templateReady(pages, parties, fields)) {
    throw new CrmError(
      'conflict',
      row.status === 'active'
        ? 'an active template needs its document and at least one field for every party: put it back to draft to save these changes'
        : 'upload the document and place at least one field for every party before activating',
      [{ path: 'status', message: 'not_ready' }],
    );
  }
  ctx.db.run(
    `UPDATE esign_templates SET name = ?, status = ?, parties = ?, signing_order = ?, fields = ?, settings = ?, updated_at = ?
     WHERE id = ?`,
    input.data.name ?? row.name,
    status,
    JSON.stringify(parties),
    input.data.signing_order ?? row.signing_order,
    JSON.stringify(fields),
    JSON.stringify(settings),
    ctx.now(),
    row.id,
  );
  rememberTenant(ctx, input.tenant);
  return getTemplate(ctx, { id: row.id });
}

/** Soft delete; R2 objects stay, sent requests keep referencing them. */
export function deleteTemplate(
  ctx: CrmContext,
  input: { id: string },
): { id: string; deleted: true } {
  const row = getTemplateRow(ctx, input.id);
  ctx.db.run(
    `UPDATE esign_templates SET deleted_at = ?, updated_at = ? WHERE id = ?`,
    ctx.now(),
    ctx.now(),
    row.id,
  );
  return { id: row.id, deleted: true };
}

/** A new source PDF: page images must be uploaded again, fields beyond the last page are dropped. */
export function setTemplateSource(
  ctx: CrmContext,
  input: {
    id: string;
    r2_key: string;
    filename: string;
    size: number;
    sha256: string;
    pages: Array<{ width: number; height: number }>;
  },
): EsignTemplate {
  const row = getTemplateRow(ctx, input.id);
  const pages: StoredPage[] = input.pages.map((p, index) => ({
    index,
    width: p.width,
    height: p.height,
    image_key: null,
    image_type: null,
  }));
  const fields = fieldsOf(row.fields).filter((f) => f.page < pages.length);
  ctx.db.run(
    `UPDATE esign_templates SET source_r2_key = ?, source_filename = ?, source_size = ?, source_sha256 = ?, pages = ?, fields = ?,
       status = CASE WHEN status = 'active' THEN 'draft' ELSE status END, updated_at = ?
     WHERE id = ?`,
    input.r2_key,
    input.filename,
    input.size,
    input.sha256,
    JSON.stringify(pages),
    JSON.stringify(fields),
    ctx.now(),
    row.id,
  );
  return getTemplate(ctx, { id: row.id });
}

/** Image of one page, rendered by the editor from the current source (`source_sha256` guards against a newer upload). */
export function setTemplatePageImage(
  ctx: CrmContext,
  input: { id: string; page: number; image_key: string; image_type: string; source_sha256: string },
): EsignTemplate {
  const row = getTemplateRow(ctx, input.id);
  if (row.source_sha256 !== input.source_sha256) {
    throw new CrmError('conflict', 'the document changed: render the pages again');
  }
  const pages = pagesOf(row.pages);
  const page = pages[input.page];
  if (page === undefined) throw invalid('page', `the document has ${String(pages.length)} page(s)`);
  page.image_key = input.image_key;
  page.image_type = input.image_type;
  ctx.db.run(
    `UPDATE esign_templates SET pages = ?, updated_at = ? WHERE id = ?`,
    JSON.stringify(pages),
    ctx.now(),
    row.id,
  );
  return getTemplate(ctx, { id: row.id });
}

export function templateFile(
  ctx: CrmContext,
  input: { id: string; page?: number },
): { key: string; content_type: string; filename: string } {
  const row = getTemplateRow(ctx, input.id);
  if (input.page === undefined) {
    if (row.source_r2_key === null) throw notFound('document of template', row.id);
    return {
      key: row.source_r2_key,
      content_type: 'application/pdf',
      filename: row.source_filename ?? 'document.pdf',
    };
  }
  const page = pagesOf(row.pages)[input.page];
  if (page?.image_key == null) throw notFound('page image', `${row.id}/${String(input.page)}`);
  return {
    key: page.image_key,
    content_type: page.image_type ?? 'image/webp',
    filename: `page-${String(input.page + 1)}`,
  };
}
