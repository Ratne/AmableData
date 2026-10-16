import type {
  CreatePageInput,
  LandingPage,
  ListPagesQuery,
  PageVersion,
  UpdatePageInput,
} from '@amable/api-types';
import { sanitizeHtml } from '@amable/auth/security';
import {
  emptyBuilderDocument,
  sanitizeBuilderDocument,
  validateBuilderDocument,
  type BuilderDocument,
} from '@amable/builder';
import type { CrmContext } from '../crm/context';
import type { SqlValue } from '../crm/db/sql';
import { CrmError, invalid, invalidMany, notFound } from '../crm/errors';
import { emit } from '../crm/events';
import { decodeCursor, paginate, parseJson, toIso } from '../crm/util';
import { createFolderStore, type FolderStore } from '../folders/store';

/** Stored draft documents are bounded (the TenantDb row and the SSR stay small). */
export const MAX_DOCUMENT_BYTES = 2_000_000;

/**
 * Paths the edge serves itself on every host (other edge routes win over the
 * page catch-all), so pages cannot claim them.
 */
const RESERVED_PREFIXES = ['/_edge', '/f', '/b', '/p', '/m', '/e', '/s.js', '/forms.js', '/booking.js', '/sitemap.xml', '/robots.txt'];

export interface PageRow {
  id: string;
  title: string;
  path: string;
  host: string | null;
  status: 'draft' | 'published';
  /** Added by tenant migration 8 (null = unfiled). */
  folder_id: string | null;
  draft: string;
  draft_revision: number;
  published_version_id: string | null;
  published_at: number | null;
  seo: string;
  settings: string;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface VersionRow {
  id: string;
  page_id: string;
  version: number;
  document: string;
  title: string;
  seo: string;
  settings: string;
  note: string | null;
  published_at: number;
  published_by: string | null;
}

/** A page as stored; the API adds `public_url` (needs the tenant slug and edge origin). */
export type PageRecord = Omit<LandingPage, 'public_url'>;
export type PageDetailRecord = PageRecord & { draft: BuilderDocument; draft_revision: number };

export interface StoredSeo {
  title: string | null;
  description: string | null;
  og_image: string | null;
  canonical: string | null;
  noindex: boolean;
}

export interface StoredSettings {
  analytics_site_id: string | null;
  favicon: string | null;
  lang: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

export function readSeo(json: string): StoredSeo {
  const raw = parseJson<Record<string, unknown>>(json, {});
  return {
    title: str(raw.title),
    description: str(raw.description),
    og_image: str(raw.og_image),
    canonical: str(raw.canonical),
    noindex: raw.noindex === true,
  };
}

export function readSettings(json: string): StoredSettings {
  const raw = parseJson<Record<string, unknown>>(json, {});
  return { analytics_site_id: str(raw.analytics_site_id), favicon: str(raw.favicon), lang: str(raw.lang) };
}

/** `/`-prefixed, lowercase, no duplicate or trailing slashes, no dot segments. */
export function normalizePath(raw: string, path = 'path'): string {
  const trimmed = raw.trim().toLowerCase();
  const segments = trimmed.split('/').filter((s) => s !== '');
  if (segments.some((s) => s === '.' || s === '..')) throw invalid(path, 'dot segments are not allowed');
  if (segments.some((s) => !/^[a-z0-9\-._~]+$/.test(s))) {
    throw invalid(path, 'letters, digits, - . _ ~ and / only');
  }
  const normalized = `/${segments.join('/')}`;
  if (normalized.length > 300) throw invalid(path, 'path too long');
  const reserved = RESERVED_PREFIXES.find((p) => normalized === p || normalized.startsWith(`${p}/`));
  if (reserved !== undefined) throw invalid(path, `${reserved} is reserved`);
  return normalized;
}

function normalizeHost(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  const host = raw.trim().toLowerCase().replace(/\.$/, '');
  return host === '' ? null : host;
}

/** Validates a builder document and sanitizes its rich text; issues become `validation_failed` under `document.`. */
export function parseDocument(input: unknown, path = 'document'): BuilderDocument {
  const result = validateBuilderDocument(input);
  if (!result.ok) {
    throw invalidMany(result.issues.map((i) => ({ path: `${path}.${i.path}`, message: i.message })));
  }
  const clean = sanitizeBuilderDocument(result.document, (html) => sanitizeHtml(html, { allowStyles: true }));
  if (JSON.stringify(clean).length > MAX_DOCUMENT_BYTES) {
    throw new CrmError('payload_too_large', 'document too large');
  }
  return clean;
}

function storedDocument(json: string): BuilderDocument {
  const result = validateBuilderDocument(parseJson<unknown>(json, {}));
  return result.ok ? result.document : emptyBuilderDocument();
}

/** Folders of the landing pages (`folders` table, kind `page`). */
export function pageFolders(ctx: CrmContext): FolderStore {
  return createFolderStore(
    ctx.db,
    { kind: 'page', foldersTable: 'folders', itemsTable: 'page_pages', liveItems: 'deleted_at IS NULL' },
    ctx,
  );
}

export function getPageRow(ctx: CrmContext, id: string, options: { deleted?: boolean } = {}): PageRow {
  const row = ctx.db.all<PageRow>(
    `SELECT * FROM page_pages WHERE id = ? AND deleted_at IS ${options.deleted === true ? 'NOT NULL' : 'NULL'}`,
    id,
  )[0];
  if (row === undefined) throw notFound('page', id);
  return row;
}

function assertRouteFree(ctx: CrmContext, host: string | null, path: string, exceptId: string | null): void {
  const clash = ctx.db.all<{ id: string }>(
    `SELECT id FROM page_pages WHERE COALESCE(host, '') = ? AND path = ? AND deleted_at IS NULL AND id != ?`,
    host ?? '',
    path,
    exceptId ?? '',
  )[0];
  if (clash !== undefined) {
    throw new CrmError('conflict', `another page already uses ${host ?? ''}${path}`, [
      { path: 'path', message: 'already used by another page on this host' },
    ]);
  }
}

export function serializePage(row: PageRow): PageRecord {
  return {
    id: row.id,
    title: row.title,
    path: row.path,
    host: row.host,
    status: row.status,
    folder_id: row.folder_id,
    published_version_id: row.published_version_id,
    published_at: toIso(row.published_at),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    deleted_at: toIso(row.deleted_at),
    seo: readSeo(row.seo),
    settings: readSettings(row.settings),
  };
}

function detail(row: PageRow): PageDetailRecord {
  return { ...serializePage(row), draft: storedDocument(row.draft), draft_revision: row.draft_revision };
}

export function serializeVersion(row: Pick<VersionRow, 'id' | 'version' | 'note' | 'published_at' | 'published_by'>): PageVersion {
  return {
    id: row.id,
    version: row.version,
    note: row.note,
    published_at: toIso(row.published_at),
    published_by: row.published_by,
  };
}

// --------------------------------------------------------------- CRUD

export function listPages(ctx: CrmContext, input: ListPagesQuery): { data: PageRecord[]; next_cursor: string | null } {
  const where: string[] = [input.status === 'deleted' ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL'];
  const params: SqlValue[] = [];
  if (input.status === 'draft' || input.status === 'published') {
    where.push('status = ?');
    params.push(input.status);
  }
  if (input.q !== undefined && input.q !== '') {
    where.push(`(title LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\')`);
    const like = `%${input.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    params.push(like, like);
  }
  const folder = pageFolders(ctx).filter(input);
  if (folder !== null) {
    where.push(folder.sql);
    params.push(...folder.params);
  }
  if (input.cursor !== undefined) {
    const cursor = decodeCursor(input.cursor);
    where.push('(updated_at < ? OR (updated_at = ? AND id < ?))');
    params.push(Number(cursor.v), Number(cursor.v), cursor.id);
  }
  const rows = ctx.db.all<PageRow>(
    `SELECT * FROM page_pages WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT ?`,
    ...params,
    input.limit + 1,
  );
  const page = paginate(rows, input.limit, (row) => ({ v: row.updated_at, id: row.id }));
  return { data: page.rows.map(serializePage), next_cursor: page.nextCursor };
}

export function getPage(ctx: CrmContext, input: { id: string }): PageDetailRecord {
  return detail(getPageRow(ctx, input.id));
}

export function createPage(ctx: CrmContext, input: CreatePageInput): PageDetailRecord {
  const path = normalizePath(input.path);
  const host = normalizeHost(input.host);
  assertRouteFree(ctx, host, path, null);
  const document = input.document === undefined ? emptyBuilderDocument() : parseDocument(input.document);
  const folderId = pageFolders(ctx).assertTarget(input.folder_id);
  const id = ctx.newId();
  const now = ctx.now();
  ctx.db.run(
    `INSERT INTO page_pages (id, title, path, host, status, draft, draft_revision, created_by, created_at, updated_at, folder_id)
     VALUES (?, ?, ?, ?, 'draft', ?, 1, ?, ?, ?, ?)`,
    id,
    input.title.trim(),
    path,
    host,
    JSON.stringify(document),
    ctx.actor.id,
    now,
    now,
    folderId,
  );
  return getPage(ctx, { id });
}

function mergeJson(current: string, patch: Record<string, unknown>): string {
  const merged: Record<string, unknown> = { ...parseJson<Record<string, unknown>>(current, {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    merged[key] = value;
  }
  return JSON.stringify(merged);
}

export function updatePage(ctx: CrmContext, input: { id: string; data: UpdatePageInput }): PageDetailRecord {
  const row = getPageRow(ctx, input.id);
  const sets: string[] = [];
  const values: SqlValue[] = [];
  const { data } = input;
  if (data.title !== undefined) {
    sets.push('title = ?');
    values.push(data.title.trim());
  }
  const path = data.path === undefined ? row.path : normalizePath(data.path);
  const host = data.host === undefined ? row.host : normalizeHost(data.host);
  if (path !== row.path || host !== row.host) {
    assertRouteFree(ctx, host, path, row.id);
    sets.push('path = ?', 'host = ?');
    values.push(path, host);
  }
  if (data.seo !== undefined) {
    sets.push('seo = ?');
    values.push(mergeJson(row.seo, data.seo));
  }
  if (data.settings !== undefined) {
    sets.push('settings = ?');
    values.push(mergeJson(row.settings, data.settings));
  }
  if (sets.length > 0) {
    sets.push('updated_at = ?');
    values.push(ctx.now());
    ctx.db.run(`UPDATE page_pages SET ${sets.join(', ')} WHERE id = ?`, ...values, row.id);
  }
  return getPage(ctx, { id: row.id });
}

/** Soft delete: a published page stops being served (and `page.unpublished` is emitted). */
export function deletePage(ctx: CrmContext, input: { id: string }): { id: string; deleted: true } {
  const row = getPageRow(ctx, input.id);
  const now = ctx.now();
  ctx.db.run(`UPDATE page_pages SET deleted_at = ?, updated_at = ? WHERE id = ?`, now, now, row.id);
  if (row.status === 'published') {
    emit(ctx, 'page.unpublished', { pageId: row.id, path: row.path, host: row.host });
  }
  return { id: row.id, deleted: true };
}

/** Restores a soft-deleted page as a draft (it must be published again to go live). */
export function restorePage(ctx: CrmContext, input: { id: string }): PageDetailRecord {
  const row = getPageRow(ctx, input.id, { deleted: true });
  assertRouteFree(ctx, row.host, row.path, row.id);
  ctx.db.run(
    `UPDATE page_pages SET deleted_at = NULL, status = 'draft', updated_at = ? WHERE id = ?`,
    ctx.now(),
    row.id,
  );
  return getPage(ctx, { id: row.id });
}

function freePath(ctx: CrmContext, host: string | null, base: string): string {
  const stem = base === '/' ? '/copy' : `${base}-copy`;
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? stem : `${stem}-${n}`;
    const used = ctx.db.all<{ id: string }>(
      `SELECT id FROM page_pages WHERE COALESCE(host, '') = ? AND path = ? AND deleted_at IS NULL`,
      host ?? '',
      candidate,
    );
    if (used.length === 0) return candidate;
  }
  throw new CrmError('conflict', 'no free path for the copy');
}

/** Copies the draft, SEO and settings into a new draft page; versions are not copied. */
export function duplicatePage(
  ctx: CrmContext,
  input: { id: string; title?: string | undefined; path?: string | undefined },
): PageDetailRecord {
  const row = getPageRow(ctx, input.id);
  const path = input.path === undefined ? freePath(ctx, row.host, row.path) : normalizePath(input.path);
  assertRouteFree(ctx, row.host, path, null);
  const id = ctx.newId();
  const now = ctx.now();
  ctx.db.run(
    `INSERT INTO page_pages (id, title, path, host, status, draft, draft_revision, seo, settings, created_by, created_at, updated_at, folder_id)
     VALUES (?, ?, ?, ?, 'draft', ?, 1, ?, ?, ?, ?, ?, ?)`,
    id,
    (input.title ?? `${row.title} (copy)`).slice(0, 200),
    path,
    row.host,
    row.draft,
    row.seo,
    row.settings,
    ctx.actor.id,
    now,
    now,
    row.folder_id,
  );
  return getPage(ctx, { id });
}

// ------------------------------------------------------- draft & versions

export type SaveDraftResult =
  | { ok: true; draft_revision: number }
  | { ok: false; error: 'stale_draft'; draft_revision: number };

/** Optimistic concurrency: the save applies only on top of `base_revision`. */
export function saveDraft(
  ctx: CrmContext,
  input: { id: string; document: unknown; base_revision: number },
): SaveDraftResult {
  const row = getPageRow(ctx, input.id);
  if (row.draft_revision !== input.base_revision) {
    return { ok: false, error: 'stale_draft', draft_revision: row.draft_revision };
  }
  const document = parseDocument(input.document);
  const revision = row.draft_revision + 1;
  ctx.db.run(
    `UPDATE page_pages SET draft = ?, draft_revision = ?, updated_at = ? WHERE id = ?`,
    JSON.stringify(document),
    revision,
    ctx.now(),
    row.id,
  );
  return { ok: true, draft_revision: revision };
}

/** Snapshots the (re-validated) draft with the current SEO/settings as the next version and makes it live. */
export function publishPage(
  ctx: CrmContext,
  input: { id: string; note?: string | undefined },
): { page: PageRecord; version: PageVersion } {
  const row = getPageRow(ctx, input.id);
  const document = parseDocument(parseJson<unknown>(row.draft, {}), 'draft');
  const last = ctx.db.all<{ v: number | null }>(
    `SELECT MAX(version) AS v FROM page_versions WHERE page_id = ?`,
    row.id,
  )[0];
  const version = (last?.v ?? 0) + 1;
  const id = ctx.newId();
  const now = ctx.now();
  const note = input.note === undefined || input.note.trim() === '' ? null : input.note.trim();
  ctx.db.run(
    `INSERT INTO page_versions (id, page_id, version, document, title, seo, settings, note, published_at, published_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    row.id,
    version,
    JSON.stringify(document),
    row.title,
    row.seo,
    row.settings,
    note,
    now,
    ctx.actor.id,
  );
  ctx.db.run(
    `UPDATE page_pages SET status = 'published', published_version_id = ?, published_at = ?, updated_at = ? WHERE id = ?`,
    id,
    now,
    now,
    row.id,
  );
  emit(ctx, 'page.published', { pageId: row.id, versionId: id, version, path: row.path, host: row.host });
  return {
    page: serializePage(getPageRow(ctx, row.id)),
    version: serializeVersion({ id, version, note, published_at: now, published_by: ctx.actor.id }),
  };
}

export function unpublishPage(ctx: CrmContext, input: { id: string }): PageDetailRecord {
  const row = getPageRow(ctx, input.id);
  if (row.status === 'published') {
    ctx.db.run(`UPDATE page_pages SET status = 'draft', updated_at = ? WHERE id = ?`, ctx.now(), row.id);
    emit(ctx, 'page.unpublished', { pageId: row.id, path: row.path, host: row.host });
  }
  return getPage(ctx, { id: row.id });
}

export function listVersions(ctx: CrmContext, input: { id: string }): { data: PageVersion[] } {
  const row = getPageRow(ctx, input.id);
  const rows = ctx.db.all<VersionRow>(
    `SELECT id, version, note, published_at, published_by FROM page_versions WHERE page_id = ? ORDER BY version DESC`,
    row.id,
  );
  return { data: rows.map(serializeVersion) };
}

/** Replaces the draft with a published version's document (new draft revision). */
export function restoreVersion(ctx: CrmContext, input: { id: string; versionId: string }): PageDetailRecord {
  const row = getPageRow(ctx, input.id);
  const version = ctx.db.all<VersionRow>(
    `SELECT * FROM page_versions WHERE id = ? AND page_id = ?`,
    input.versionId,
    row.id,
  )[0];
  if (version === undefined) throw notFound('page version', input.versionId);
  ctx.db.run(
    `UPDATE page_pages SET draft = ?, draft_revision = draft_revision + 1, updated_at = ? WHERE id = ?`,
    version.document,
    ctx.now(),
    row.id,
  );
  return getPage(ctx, { id: row.id });
}

// ------------------------------------------------------------- public

export interface ResolvedPage {
  page: { id: string; title: string; path: string; host: string | null; updated_at: number };
  version: { id: string; version: number; published_at: number };
  document: BuilderDocument;
  seo: StoredSeo;
  settings: StoredSettings;
}

/**
 * Published version of the page at `<host><path>` (`host` null = the
 * `/p/<slug>/…` URLs, which also serve pages with a host as a fallback).
 */
export function resolvePage(ctx: CrmContext, input: { host: string | null; path: string }): ResolvedPage | null {
  let path: string;
  try {
    path = normalizePath(input.path);
  } catch {
    return null;
  }
  const host = normalizeHost(input.host);
  const rows = ctx.db.all<PageRow & { v_id: string; v_version: number; v_document: string; v_title: string; v_seo: string; v_settings: string; v_published_at: number }>(
    `SELECT p.*, v.id AS v_id, v.version AS v_version, v.document AS v_document, v.title AS v_title,
            v.seo AS v_seo, v.settings AS v_settings, v.published_at AS v_published_at
     FROM page_pages p JOIN page_versions v ON v.id = p.published_version_id
     WHERE p.path = ? AND p.status = 'published' AND p.deleted_at IS NULL
       AND (${host === null ? '1 = 1' : 'p.host = ?'})
     ORDER BY CASE WHEN p.host IS NULL THEN 0 ELSE 1 END
     LIMIT 1`,
    ...(host === null ? [path] : [path, host]),
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    page: { id: row.id, title: row.v_title, path: row.path, host: row.host, updated_at: row.updated_at },
    version: { id: row.v_id, version: row.v_version, published_at: row.v_published_at },
    document: storedDocument(row.v_document),
    seo: readSeo(row.v_seo),
    settings: readSettings(row.v_settings),
  };
}

/** Published, indexable pages of a host (null = pages without a host) for sitemap.xml. */
export function sitemapPages(
  ctx: CrmContext,
  input: { host: string | null },
): { data: Array<{ path: string; published_at: number }> } {
  const host = normalizeHost(input.host);
  const rows = ctx.db.all<{ path: string; published_at: number; seo: string }>(
    `SELECT p.path, p.published_at, v.seo FROM page_pages p JOIN page_versions v ON v.id = p.published_version_id
     WHERE p.status = 'published' AND p.deleted_at IS NULL AND COALESCE(p.host, '') = ?
     ORDER BY p.path LIMIT 5000`,
    host ?? '',
  );
  return {
    data: rows.filter((r) => !readSeo(r.seo).noindex).map((r) => ({ path: r.path, published_at: r.published_at })),
  };
}
