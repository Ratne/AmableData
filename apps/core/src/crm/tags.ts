import type {
  CreateTagCategoryInput,
  CreateTagInput,
  ListTagsQuery,
  Page,
  Tag,
  TagCategory,
  TagContactsResult,
  UpdateTagCategoryInput,
  UpdateTagInput,
} from '@amable/api-types';
import type { CrmContext } from './context';
import { placeholders } from './db/sql';
import { CrmError, invalid, notFound } from './errors';
import { emit } from './events';
import { assertRef } from './refs';
import { decodeCursor, paginate, toIso } from './util';

// --------------------------------------------------------------- categories

interface CategoryRow {
  id: string;
  name: string;
  description: string | null;
  created_at: number;
}

function categoryToApi(row: CategoryRow): TagCategory {
  return { ...row, created_at: toIso(row.created_at) };
}

function getCategoryRow(ctx: CrmContext, id: string): CategoryRow {
  const row = ctx.db.all<CategoryRow>(
    `SELECT id, name, description, created_at FROM crm_tag_categories WHERE id = ? AND deleted_at IS NULL`,
    id,
  )[0];
  if (row === undefined) throw notFound('tag category', id);
  return row;
}

function assertCategoryNameFree(ctx: CrmContext, name: string, exceptId: string | null): void {
  const rows = ctx.db.all<{ id: string }>(
    `SELECT id FROM crm_tag_categories WHERE name = ? COLLATE NOCASE AND deleted_at IS NULL`,
    name,
  );
  if (rows.some((r) => r.id !== exceptId)) {
    throw new CrmError('conflict', `tag category "${name}" already exists`);
  }
}

export function listTagCategories(ctx: CrmContext, _input: Record<string, never>): TagCategory[] {
  return ctx.db
    .all<CategoryRow>(
      `SELECT id, name, description, created_at FROM crm_tag_categories
       WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE`,
    )
    .map(categoryToApi);
}

export function createTagCategory(ctx: CrmContext, input: CreateTagCategoryInput): TagCategory {
  assertCategoryNameFree(ctx, input.name, null);
  const id = ctx.newId();
  const now = ctx.now();
  ctx.db.run(
    `INSERT INTO crm_tag_categories (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    id,
    input.name,
    input.description ?? null,
    now,
    now,
  );
  return categoryToApi(getCategoryRow(ctx, id));
}

export function updateTagCategory(
  ctx: CrmContext,
  input: { id: string; data: UpdateTagCategoryInput },
): TagCategory {
  const row = getCategoryRow(ctx, input.id);
  if (input.data.name !== undefined) assertCategoryNameFree(ctx, input.data.name, row.id);
  ctx.db.run(
    `UPDATE crm_tag_categories SET name = ?, description = ?, updated_at = ? WHERE id = ?`,
    input.data.name ?? row.name,
    input.data.description === undefined ? row.description : input.data.description,
    ctx.now(),
    row.id,
  );
  return categoryToApi(getCategoryRow(ctx, row.id));
}

/** Deletes the category; its tags stay, uncategorized. */
export function deleteTagCategory(
  ctx: CrmContext,
  input: { id: string },
): { id: string; deleted: true } {
  getCategoryRow(ctx, input.id);
  const now = ctx.now();
  ctx.db.run(
    `UPDATE crm_tags SET category_id = NULL, updated_at = ? WHERE category_id = ?`,
    now,
    input.id,
  );
  ctx.db.run(`UPDATE crm_tag_categories SET deleted_at = ? WHERE id = ?`, now, input.id);
  return { id: input.id, deleted: true };
}

// --------------------------------------------------------------------- tags

interface TagRow {
  id: string;
  name: string;
  description: string | null;
  category_id: string | null;
  contact_count: number;
  created_at: number;
  updated_at: number;
}

const TAG_SELECT = `SELECT t.id, t.name, t.description, t.category_id, t.created_at, t.updated_at,
  (SELECT COUNT(*) FROM crm_contact_tags ct JOIN crm_contacts c ON c.id = ct.contact_id
   WHERE ct.tag_id = t.id AND c.deleted_at IS NULL) AS contact_count
  FROM crm_tags t`;

function tagToApi(row: TagRow): Tag {
  return { ...row, created_at: toIso(row.created_at), updated_at: toIso(row.updated_at) };
}

function getTagRow(ctx: CrmContext, id: string): TagRow {
  const row = ctx.db.all<TagRow>(`${TAG_SELECT} WHERE t.id = ? AND t.deleted_at IS NULL`, id)[0];
  if (row === undefined) throw notFound('tag', id);
  return row;
}

function assertTagNameFree(
  ctx: CrmContext,
  name: string,
  categoryId: string | null,
  exceptId: string | null,
): void {
  const rows = ctx.db.all<{ id: string }>(
    `SELECT id FROM crm_tags WHERE name = ? COLLATE NOCASE AND IFNULL(category_id, '') = ? AND deleted_at IS NULL`,
    name,
    categoryId ?? '',
  );
  if (rows.some((r) => r.id !== exceptId)) {
    throw new CrmError('conflict', `tag "${name}" already exists in this category`);
  }
}

/** Upper bound of a NOCASE prefix range: every name starting with the prefix sorts below it. */
const PREFIX_END = '\u{10FFFF}';

function likeContains(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

interface SearchPhaseRow extends TagRow {
  phase: 'p' | 'c';
}

/**
 * `q` search in two keyset phases, each ordered by name (NOCASE) then id:
 * `p` = names starting with `q` — a range on the `crm_tags_name` index —,
 * then `c` = names containing `q` elsewhere (a scan, bounded by the limit).
 * The cursor carries the phase so pages continue across the boundary.
 */
function searchTags(ctx: CrmContext, input: ListTagsQuery & { q: string }): Page<Tag> {
  const after = input.cursor === undefined ? null : decodeCursor(input.cursor);
  const cursorText = typeof after?.v === 'string' ? after.v : null;
  const afterPhase = cursorText?.startsWith('c:') === true ? 'c' : 'p';
  const afterName = cursorText === null ? null : cursorText.slice(2);
  const prefix = input.q;
  const run = (phase: 'p' | 'c', take: number): SearchPhaseRow[] => {
    const where = ['t.deleted_at IS NULL'];
    const params: (string | number)[] = [];
    if (phase === 'p') {
      where.push('t.name >= ? COLLATE NOCASE', 't.name < ? COLLATE NOCASE');
      params.push(prefix, `${prefix}${PREFIX_END}`);
    } else {
      where.push(
        `t.name LIKE ? ESCAPE '\\'`,
        'NOT (t.name >= ? COLLATE NOCASE AND t.name < ? COLLATE NOCASE)',
      );
      params.push(likeContains(prefix), prefix, `${prefix}${PREFIX_END}`);
    }
    if (input.category_id !== undefined) {
      where.push('t.category_id = ?');
      params.push(input.category_id);
    }
    if (after !== null && afterName !== null && afterPhase === phase) {
      where.push('(t.name > ? COLLATE NOCASE OR (t.name = ? COLLATE NOCASE AND t.id > ?))');
      params.push(afterName, afterName, after.id);
    }
    return ctx.db
      .all<TagRow>(
        `${TAG_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.name COLLATE NOCASE, t.id LIMIT ?`,
        ...params,
        take,
      )
      .map((row) => ({ ...row, phase }));
  };
  const rows: SearchPhaseRow[] = afterPhase === 'p' ? run('p', input.limit + 1) : [];
  if (rows.length <= input.limit) rows.push(...run('c', input.limit + 1 - rows.length));
  const page = paginate(rows, input.limit, (r) => ({ v: `${r.phase}:${r.name}`, id: r.id }));
  return {
    data: page.rows.map(({ phase: _phase, ...row }) => tagToApi(row)),
    next_cursor: page.nextCursor,
  };
}

/** Tags by id (chip labels of pickers); unknown and deleted ids are left out. */
function tagsByIds(ctx: CrmContext, ids: string[]): Page<Tag> {
  if (ids.length === 0) return { data: [], next_cursor: null };
  const rows = ctx.db.all<TagRow>(
    `${TAG_SELECT} WHERE t.deleted_at IS NULL AND t.id IN (${placeholders(ids.length)})
     ORDER BY LOWER(t.name), t.id`,
    ...ids,
  );
  return { data: rows.map(tagToApi), next_cursor: null };
}

export function listTags(ctx: CrmContext, input: ListTagsQuery): Page<Tag> {
  if (input.ids !== undefined) {
    const ids = [...new Set(input.ids.split(',').map((id) => id.trim()).filter(Boolean))];
    return tagsByIds(ctx, ids.slice(0, 100));
  }
  if (input.q !== undefined && input.q !== '') return searchTags(ctx, { ...input, q: input.q });
  const after = input.cursor === undefined ? null : decodeCursor(input.cursor);
  const rows = ctx.db.all<TagRow>(
    `${TAG_SELECT}
     WHERE t.deleted_at IS NULL
       AND (? IS NULL OR t.category_id = ?)
       AND (? IS NULL OR t.name LIKE ? ESCAPE '\\')
       AND (? IS NULL OR (LOWER(t.name) > ? OR (LOWER(t.name) = ? AND t.id > ?)))
     ORDER BY LOWER(t.name), t.id LIMIT ?`,
    input.category_id ?? null,
    input.category_id ?? null,
    input.name ?? null,
    input.name === undefined ? null : `%${input.name.replace(/[\\%_]/g, (c) => `\\${c}`)}%`,
    after?.id ?? null,
    typeof after?.v === 'string' ? after.v : '',
    typeof after?.v === 'string' ? after.v : '',
    after?.id ?? '',
    input.limit + 1,
  );
  const page = paginate(rows, input.limit, (r) => ({ v: r.name.toLowerCase(), id: r.id }));
  return { data: page.rows.map(tagToApi), next_cursor: page.nextCursor };
}

export function getTag(ctx: CrmContext, input: { id: string }): Tag {
  return tagToApi(getTagRow(ctx, input.id));
}

export function createTag(ctx: CrmContext, input: CreateTagInput): Tag {
  assertRef(ctx, 'tag_category', input.category_id, 'category_id');
  assertTagNameFree(ctx, input.name, input.category_id ?? null, null);
  const id = ctx.newId();
  const now = ctx.now();
  ctx.db.run(
    `INSERT INTO crm_tags (id, name, description, category_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    input.name,
    input.description ?? null,
    input.category_id ?? null,
    now,
    now,
  );
  return getTag(ctx, { id });
}

export function updateTag(ctx: CrmContext, input: { id: string; data: UpdateTagInput }): Tag {
  const row = getTagRow(ctx, input.id);
  const categoryId =
    input.data.category_id === undefined ? row.category_id : input.data.category_id;
  assertRef(ctx, 'tag_category', categoryId, 'category_id');
  assertTagNameFree(ctx, input.data.name ?? row.name, categoryId, row.id);
  ctx.db.run(
    `UPDATE crm_tags SET name = ?, description = ?, category_id = ?, updated_at = ? WHERE id = ?`,
    input.data.name ?? row.name,
    input.data.description === undefined ? row.description : input.data.description,
    categoryId,
    ctx.now(),
    row.id,
  );
  return getTag(ctx, { id: row.id });
}

/**
 * Soft-deletes the tag. Its contact links are kept (so `restoreTag` brings them
 * back) but every reader ignores links to deleted tags, so contacts stop having
 * it at once. No per-contact `contact.tag_removed` events (bulk administrative
 * cleanup, not a contact action).
 */
export function deleteTag(ctx: CrmContext, input: { id: string }): { id: string; deleted: true } {
  getTagRow(ctx, input.id);
  ctx.db.run(`UPDATE crm_tags SET deleted_at = ? WHERE id = ?`, ctx.now(), input.id);
  return { id: input.id, deleted: true };
}

/** Undoes `deleteTag`: the tag and its contact links are back. */
export function restoreTag(ctx: CrmContext, input: { id: string }): Tag {
  const row = ctx.db.all<{ name: string; category_id: string | null; deleted_at: number | null }>(
    `SELECT name, category_id, deleted_at FROM crm_tags WHERE id = ?`,
    input.id,
  )[0];
  if (row === undefined) throw notFound('tag', input.id);
  if (row.deleted_at === null) return getTag(ctx, input);
  assertTagNameFree(ctx, row.name, row.category_id, input.id);
  ctx.db.run(
    `UPDATE crm_tags SET deleted_at = NULL, updated_at = ? WHERE id = ?`,
    ctx.now(),
    input.id,
  );
  return getTag(ctx, input);
}

/** Finds a tag by name (case-insensitive, uncategorized first) or creates it. */
export function findOrCreateTagByName(ctx: CrmContext, name: string): string {
  const existing = ctx.db.all<{ id: string }>(
    `SELECT id FROM crm_tags WHERE name = ? COLLATE NOCASE AND deleted_at IS NULL
     ORDER BY category_id IS NOT NULL, id LIMIT 1`,
    name.trim(),
  )[0];
  if (existing !== undefined) return existing.id;
  return createTag(ctx, { name: name.trim().slice(0, 100) }).id;
}

// ---------------------------------------------------- contact <-> tag links

function tagNames(ctx: CrmContext, tagIds: string[]): Map<string, string> {
  if (tagIds.length === 0) return new Map();
  const rows = ctx.db.all<{ id: string; name: string }>(
    `SELECT id, name FROM crm_tags WHERE deleted_at IS NULL AND id IN (${placeholders(tagIds.length)})`,
    ...tagIds,
  );
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Validates that every tag exists; returns their names. */
export function assertTags(
  ctx: CrmContext,
  tagIds: string[],
  path = 'tag_ids',
): Map<string, string> {
  const unique = [...new Set(tagIds)];
  const names = tagNames(ctx, unique);
  const missing = unique.filter((id) => !names.has(id));
  if (missing.length > 0) throw invalid(path, `tags not found: ${missing.join(', ')}`);
  return names;
}

/** Applies tags to one contact, emitting `contact.tag_applied` for new links. */
export function applyTagsToContact(ctx: CrmContext, contactId: string, tagIds: string[]): string[] {
  const names = assertTags(ctx, tagIds);
  const applied: string[] = [];
  for (const tagId of names.keys()) {
    const exists = ctx.db.all(
      `SELECT 1 FROM crm_contact_tags WHERE contact_id = ? AND tag_id = ?`,
      contactId,
      tagId,
    );
    if (exists.length > 0) continue;
    ctx.db.run(
      `INSERT INTO crm_contact_tags (contact_id, tag_id, applied_at, applied_by) VALUES (?, ?, ?, ?)`,
      contactId,
      tagId,
      ctx.now(),
      ctx.actor.id,
    );
    emit(ctx, 'contact.tag_applied', { contactId, tagId }, { tagName: names.get(tagId) });
    applied.push(tagId);
  }
  return applied;
}

/** Removes tags from one contact, emitting `contact.tag_removed` for removed links. */
export function removeTagsFromContact(
  ctx: CrmContext,
  contactId: string,
  tagIds: string[],
): string[] {
  const names = tagNames(ctx, tagIds);
  const removed: string[] = [];
  for (const tagId of new Set(tagIds)) {
    const exists = ctx.db.all(
      `SELECT 1 FROM crm_contact_tags WHERE contact_id = ? AND tag_id = ?`,
      contactId,
      tagId,
    );
    if (exists.length === 0) continue;
    ctx.db.run(
      `DELETE FROM crm_contact_tags WHERE contact_id = ? AND tag_id = ?`,
      contactId,
      tagId,
    );
    emit(ctx, 'contact.tag_removed', { contactId, tagId }, { tagName: names.get(tagId) ?? null });
    removed.push(tagId);
  }
  return removed;
}

function liveContactIds(ctx: CrmContext, ids: string[]): Set<string> {
  const live = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const row of ctx.db.all<{ id: string }>(
      `SELECT id FROM crm_contacts WHERE deleted_at IS NULL AND id IN (${placeholders(chunk.length)})`,
      ...chunk,
    )) {
      live.add(row.id);
    }
  }
  return live;
}

export function applyTagToContacts(
  ctx: CrmContext,
  input: { tagId: string; contactIds: string[] },
): TagContactsResult {
  getTagRow(ctx, input.tagId);
  const unique = [...new Set(input.contactIds)];
  const live = liveContactIds(ctx, unique);
  let changed = 0;
  for (const contactId of unique) {
    if (live.has(contactId)) changed += applyTagsToContact(ctx, contactId, [input.tagId]).length;
  }
  return {
    tag_id: input.tagId,
    changed,
    missing_contact_ids: unique.filter((id) => !live.has(id)),
  };
}

export function removeTagFromContacts(
  ctx: CrmContext,
  input: { tagId: string; contactIds: string[] },
): TagContactsResult {
  getTagRow(ctx, input.tagId);
  const unique = [...new Set(input.contactIds)];
  const live = liveContactIds(ctx, unique);
  let changed = 0;
  for (const contactId of unique) {
    if (live.has(contactId)) changed += removeTagsFromContact(ctx, contactId, [input.tagId]).length;
  }
  return {
    tag_id: input.tagId,
    changed,
    missing_contact_ids: unique.filter((id) => !live.has(id)),
  };
}

export function tagIdsByContact(ctx: CrmContext, contactIds: string[]): Map<string, string[]> {
  const result = new Map<string, string[]>(contactIds.map((id) => [id, []]));
  for (let i = 0; i < contactIds.length; i += 500) {
    const chunk = contactIds.slice(i, i + 500);
    const rows = ctx.db.all<{ contact_id: string; tag_id: string }>(
      `SELECT ct.contact_id, ct.tag_id FROM crm_contact_tags ct JOIN crm_tags t ON t.id = ct.tag_id
       WHERE t.deleted_at IS NULL AND ct.contact_id IN (${placeholders(chunk.length)})
       ORDER BY ct.applied_at, ct.tag_id`,
      ...chunk,
    );
    for (const row of rows) result.get(row.contact_id)?.push(row.tag_id);
  }
  return result;
}
