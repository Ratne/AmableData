import type {
  CreateSavedSearchInput,
  ExecuteSavedSearchInput,
  SavedSearch,
  SearchQuery,
  SearchResult,
  UpdateSavedSearchInput,
} from '@amable/api-types';
import type { CrmContext } from './context';
import { notFound } from './errors';
import { compileSearchQuery, executeSearch, matchingIds } from './search/query-builder';
import { parseJson, toIso } from './util';

interface SavedSearchRow {
  id: string;
  name: string;
  description: string | null;
  entity: SavedSearch['entity'];
  query: string;
  shared: number;
  owner_id: string | null;
  created_at: number;
  updated_at: number;
}

function toApi(row: SavedSearchRow): SavedSearch {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    entity: row.entity,
    query: parseJson<SearchQuery>(row.query, { entity: row.entity }),
    shared: row.shared === 1,
    owner_id: row.owner_id,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

/** Saved searches are visible when shared or owned by the caller. */
function getRow(ctx: CrmContext, id: string): SavedSearchRow {
  const row = ctx.db.all<SavedSearchRow>(
    `SELECT * FROM crm_saved_searches WHERE id = ? AND deleted_at IS NULL AND (shared = 1 OR owner_id IS ?)`,
    id,
    ctx.actor.id,
  )[0];
  if (row === undefined) throw notFound('saved search', id);
  return row;
}

/** Stored queries never keep paging state. */
function storable(query: SearchQuery): SearchQuery {
  const { limit: _limit, cursor: _cursor, ...rest } = query;
  return rest;
}

export function listSavedSearches(ctx: CrmContext, _input: Record<string, never>): SavedSearch[] {
  return ctx.db
    .all<SavedSearchRow>(
      `SELECT * FROM crm_saved_searches WHERE deleted_at IS NULL AND (shared = 1 OR owner_id IS ?)
       ORDER BY name COLLATE NOCASE`,
      ctx.actor.id,
    )
    .map(toApi);
}

export function getSavedSearch(ctx: CrmContext, input: { id: string }): SavedSearch {
  return toApi(getRow(ctx, input.id));
}

export function createSavedSearch(ctx: CrmContext, input: CreateSavedSearchInput): SavedSearch {
  const query = storable(input.query);
  compileSearchQuery(ctx, query); // rejects unknown fields/operators at save time
  const id = ctx.newId();
  const now = ctx.now();
  ctx.db.run(
    `INSERT INTO crm_saved_searches (id, name, description, entity, query, shared, owner_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.name,
    input.description ?? null,
    query.entity,
    JSON.stringify(query),
    input.shared === false ? 0 : 1,
    ctx.actor.id,
    now,
    now,
  );
  return getSavedSearch(ctx, { id });
}

export function updateSavedSearch(
  ctx: CrmContext,
  input: { id: string; data: UpdateSavedSearchInput },
): SavedSearch {
  const row = getRow(ctx, input.id);
  const query = input.data.query === undefined ? null : storable(input.data.query);
  if (query !== null) compileSearchQuery(ctx, query);
  ctx.db.run(
    `UPDATE crm_saved_searches SET name = ?, description = ?, entity = ?, query = ?, shared = ?, updated_at = ?
     WHERE id = ?`,
    input.data.name ?? row.name,
    input.data.description === undefined ? row.description : input.data.description,
    query?.entity ?? row.entity,
    query === null ? row.query : JSON.stringify(query),
    input.data.shared === undefined ? row.shared : input.data.shared ? 1 : 0,
    ctx.now(),
    row.id,
  );
  return getSavedSearch(ctx, { id: row.id });
}

export function deleteSavedSearch(
  ctx: CrmContext,
  input: { id: string },
): { id: string; deleted: true } {
  getRow(ctx, input.id);
  ctx.db.run(`UPDATE crm_saved_searches SET deleted_at = ? WHERE id = ?`, ctx.now(), input.id);
  return { id: input.id, deleted: true };
}

export function executeSavedSearch(
  ctx: CrmContext,
  input: { id: string; options: ExecuteSavedSearchInput },
): SearchResult {
  const saved = toApi(getRow(ctx, input.id));
  return executeSearch(ctx, {
    ...saved.query,
    ...(input.options.limit === undefined ? {} : { limit: input.options.limit }),
    ...(input.options.cursor === undefined ? {} : { cursor: input.options.cursor }),
    ...(input.options.include_total === undefined
      ? {}
      : { include_total: input.options.include_total }),
  });
}

/** Resolves a saved search into the full list of matching ids (segment use). */
export function savedSearchMemberIds(
  ctx: CrmContext,
  input: { id: string; max?: number },
): string[] {
  const saved = toApi(getRow(ctx, input.id));
  return matchingIds(ctx, saved.query, input.max);
}
