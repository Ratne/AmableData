import type {
  CreateSavedSectionInput,
  ListMediaQuery,
  SavedSection,
  UpdateSavedSectionInput,
} from '@amable/api-types';
import { cloneNodeWithNewIds, isHtmlDocument, validateBuilderDocument, type ElementNode } from '@amable/builder';
import type { CrmContext } from '../crm/context';
import type { SqlValue } from '../crm/db/sql';
import { CrmError, invalidMany, notFound } from '../crm/errors';
import { decodeCursor, paginate, parseJson, toIso } from '../crm/util';
import { parseDocument } from './pages';

// ------------------------------------------------------- saved sections

interface SectionRow {
  id: string;
  name: string;
  category: string | null;
  node: string;
  created_at: number;
  updated_at: number;
}

/** One element subtree, validated (and rich-text sanitized) like a one-node document. */
function parseNode(input: unknown): ElementNode {
  const result = validateBuilderDocument({ editorKind: 'canvas', body: [input] });
  if (!result.ok) {
    throw invalidMany(result.issues.map((i) => ({ path: i.path.replace(/^body\.0/, 'node'), message: i.message })));
  }
  const parsed = parseDocument({ editorKind: 'canvas', body: result.document.body }, 'node');
  const node = isHtmlDocument(parsed) ? undefined : parsed.body[0];
  if (node === undefined) throw new CrmError('validation_failed', 'node required');
  return node;
}

function serializeSection(row: SectionRow): SavedSection {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    node: parseJson<Record<string, unknown>>(row.node, {}),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function getSectionRow(ctx: CrmContext, id: string): SectionRow {
  const row = ctx.db.all<SectionRow>(`SELECT * FROM saved_sections WHERE id = ? AND deleted_at IS NULL`, id)[0];
  if (row === undefined) throw notFound('saved section', id);
  return row;
}

export function listSavedSections(ctx: CrmContext): { data: SavedSection[] } {
  const rows = ctx.db.all<SectionRow>(
    `SELECT * FROM saved_sections WHERE deleted_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT 500`,
  );
  return { data: rows.map(serializeSection) };
}

export function createSavedSection(ctx: CrmContext, input: CreateSavedSectionInput): SavedSection {
  // Fresh ids: the section is inserted into pages many times.
  const node = cloneNodeWithNewIds(parseNode(input.node));
  const id = ctx.newId();
  const now = ctx.now();
  ctx.db.run(
    `INSERT INTO saved_sections (id, name, category, node, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.name.trim(),
    input.category ?? null,
    JSON.stringify(node),
    ctx.actor.id,
    now,
    now,
  );
  return serializeSection(getSectionRow(ctx, id));
}

export function updateSavedSection(ctx: CrmContext, input: { id: string; data: UpdateSavedSectionInput }): SavedSection {
  const row = getSectionRow(ctx, input.id);
  const sets: string[] = [];
  const values: SqlValue[] = [];
  if (input.data.name !== undefined) {
    sets.push('name = ?');
    values.push(input.data.name.trim());
  }
  if (input.data.category !== undefined) {
    sets.push('category = ?');
    values.push(input.data.category);
  }
  if (input.data.node !== undefined) {
    sets.push('node = ?');
    values.push(JSON.stringify(parseNode(input.data.node)));
  }
  if (sets.length > 0) {
    sets.push('updated_at = ?');
    values.push(ctx.now());
    ctx.db.run(`UPDATE saved_sections SET ${sets.join(', ')} WHERE id = ?`, ...values, row.id);
  }
  return serializeSection(getSectionRow(ctx, row.id));
}

export function deleteSavedSection(ctx: CrmContext, input: { id: string }): { id: string; deleted: true } {
  const row = getSectionRow(ctx, input.id);
  const now = ctx.now();
  ctx.db.run(`UPDATE saved_sections SET deleted_at = ?, updated_at = ? WHERE id = ?`, now, now, row.id);
  return { id: row.id, deleted: true };
}

// ---------------------------------------------------------------- media

export interface MediaRow {
  id: string;
  r2_key: string;
  /** Public file name in `/m/<slug>/<file>` (`<id>.<ext>`). */
  file: string;
  filename: string;
  content_type: string;
  size: number;
  sha256: string | null;
  created_at: number;
}

export function listMedia(ctx: CrmContext, input: ListMediaQuery): { rows: MediaRow[]; next_cursor: string | null } {
  const where = ['deleted_at IS NULL'];
  const params: SqlValue[] = [];
  if (input.cursor !== undefined) {
    const cursor = decodeCursor(input.cursor);
    where.push('(created_at < ? OR (created_at = ? AND id < ?))');
    params.push(Number(cursor.v), Number(cursor.v), cursor.id);
  }
  const rows = ctx.db.all<MediaRow>(
    `SELECT * FROM media_files WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`,
    ...params,
    input.limit + 1,
  );
  const page = paginate(rows, input.limit, (row) => ({ v: row.created_at, id: row.id }));
  return { rows: page.rows, next_cursor: page.nextCursor };
}

/** Metadata of a file the worker already wrote to R2. */
export function createMedia(
  ctx: CrmContext,
  input: { id: string; r2_key: string; file: string; filename: string; content_type: string; size: number; sha256: string },
): MediaRow {
  ctx.db.run(
    `INSERT INTO media_files (id, r2_key, file, filename, content_type, size, sha256, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.id,
    input.r2_key,
    input.file,
    input.filename,
    input.content_type,
    input.size,
    input.sha256,
    ctx.actor.id,
    ctx.now(),
  );
  return getMedia(ctx, { id: input.id });
}

export function getMedia(ctx: CrmContext, input: { id: string }): MediaRow {
  const row = ctx.db.all<MediaRow>(`SELECT * FROM media_files WHERE id = ? AND deleted_at IS NULL`, input.id)[0];
  if (row === undefined) throw notFound('media file', input.id);
  return row;
}

/** Public lookup by file name (edge `/m/<slug>/<file>`); null when unknown or deleted. */
export function mediaByFile(ctx: CrmContext, input: { file: string }): MediaRow | null {
  return ctx.db.all<MediaRow>(`SELECT * FROM media_files WHERE file = ? AND deleted_at IS NULL`, input.file)[0] ?? null;
}

/** Live library files among `files` (page export); unknown names are left out. */
export function mediaByFiles(ctx: CrmContext, input: { files: string[] }): MediaRow[] {
  const out: MediaRow[] = [];
  for (let at = 0; at < input.files.length; at += 100) {
    const chunk = input.files.slice(at, at + 100);
    out.push(
      ...ctx.db.all<MediaRow>(
        `SELECT * FROM media_files WHERE deleted_at IS NULL AND file IN (${chunk.map(() => '?').join(', ')})`,
        ...chunk,
      ),
    );
  }
  return out;
}

/** A live file with this content, if the library already has one (dedup on page import). */
export function mediaBySha(ctx: CrmContext, input: { sha256: string }): MediaRow | null {
  return (
    ctx.db.all<MediaRow>(
      `SELECT * FROM media_files WHERE sha256 = ? AND deleted_at IS NULL ORDER BY created_at LIMIT 1`,
      input.sha256,
    )[0] ?? null
  );
}

/** Soft delete; the worker removes the R2 object afterwards. */
export function deleteMedia(ctx: CrmContext, input: { id: string }): MediaRow {
  const row = getMedia(ctx, input);
  ctx.db.run(`UPDATE media_files SET deleted_at = ? WHERE id = ?`, ctx.now(), row.id);
  return row;
}
