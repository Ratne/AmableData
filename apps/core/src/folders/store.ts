import {
  FOLDER_MAX_DEPTH,
  type CreateFolderInput,
  type DeleteFolderResult,
  type Folder,
  type FolderKind,
  type FolderTree,
  type MoveFolderItemsInput,
  type MoveFolderItemsResult,
  type UpdateFolderInput,
} from '@amable/api-types';
import { placeholders, type SqlDb, type SqlValue } from '../crm/db/sql';
import { CrmError, invalid, notFound } from '../crm/errors';

/**
 * Generic folder tree over one items table. Each Durable Object keeps the
 * folders of its own items (Engine: automations in `eng_folders`; TenantDb:
 * landing pages in `folders`), so moving items and counting them is one local
 * transaction. Table and predicate names come from code, never from input.
 */
export interface FolderStoreConfig {
  readonly kind: FolderKind;
  readonly foldersTable: string;
  readonly itemsTable: string;
  /** SQL predicate selecting live items (counted and movable), e.g. `deleted_at IS NULL`. */
  readonly liveItems: string;
}

export interface FolderPorts {
  now(): number;
  newId(): string;
}

/** Item list filter, as parsed from `folder_id` / `include_subfolders`. */
export interface FolderFilter {
  readonly folder_id?: string | undefined;
  readonly include_subfolders?: 'true' | 'false' | undefined;
}

interface FolderRow {
  id: string;
  kind: FolderKind;
  parent_id: string | null;
  name: string;
  position: number;
  created_at: number;
  updated_at: number;
}

/** Ids per statement: SQLite in Durable Objects allows at most 100 bound parameters. */
const CHUNK = 90;

const iso = (ms: number) => new Date(ms).toISOString();

export function chunks<T>(values: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

export function createFolderStore(db: SqlDb, config: FolderStoreConfig, ports: FolderPorts) {
  const { kind, foldersTable: F, itemsTable: I, liveItems } = config;

  const rows = (): FolderRow[] =>
    db.all<FolderRow>(
      `SELECT id, kind, parent_id, name, position, created_at, updated_at FROM ${F} WHERE kind = ?`,
      kind,
    );

  const byId = (all: readonly FolderRow[]) => new Map(all.map((row) => [row.id, row]));

  const folderOrThrow = (id: string): FolderRow => {
    const row = db.all<FolderRow>(
      `SELECT id, kind, parent_id, name, position, created_at, updated_at FROM ${F} WHERE id = ? AND kind = ?`,
      id,
      kind,
    )[0];
    if (row === undefined) throw notFound('folder', id);
    return row;
  };

  /** Depth of a folder (root = 1); stops on corrupted (cyclic) data. */
  const depthOf = (map: ReadonlyMap<string, FolderRow>, id: string): number => {
    let depth = 0;
    let cursor: string | null = id;
    const seen = new Set<string>();
    while (cursor !== null && !seen.has(cursor)) {
      seen.add(cursor);
      const row = map.get(cursor);
      if (row === undefined) break;
      depth += 1;
      cursor = row.parent_id;
    }
    return depth;
  };

  const childrenOf = (all: readonly FolderRow[]) => {
    const children = new Map<string | null, FolderRow[]>();
    for (const row of all) {
      const key = row.parent_id;
      const list = children.get(key) ?? [];
      list.push(row);
      children.set(key, list);
    }
    for (const list of children.values()) {
      list.sort(
        (a, b) =>
          a.position - b.position ||
          a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) ||
          a.id.localeCompare(b.id),
      );
    }
    return children;
  };

  /** Ids of a folder and all its descendants. */
  const subtree = (all: readonly FolderRow[], id: string): string[] => {
    const children = childrenOf(all);
    const out: string[] = [];
    const stack = [id];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const next = stack.pop() as string;
      if (seen.has(next)) continue;
      seen.add(next);
      out.push(next);
      for (const child of children.get(next) ?? []) stack.push(child.id);
    }
    return out;
  };

  /** Levels of a subtree: 1 for a folder without subfolders. */
  const heightOf = (all: readonly FolderRow[], id: string): number => {
    const children = childrenOf(all);
    const walk = (current: string, seen: Set<string>): number => {
      if (seen.has(current)) return 0;
      seen.add(current);
      let max = 0;
      for (const child of children.get(current) ?? []) max = Math.max(max, walk(child.id, seen));
      return max + 1;
    };
    return walk(id, new Set());
  };

  const assertNameFree = (parentId: string | null, name: string, exceptId: string | null) => {
    const clash = db.all<{ id: string }>(
      `SELECT id FROM ${F} WHERE kind = ? AND COALESCE(parent_id, '') = ? AND name = ? COLLATE NOCASE AND id != ?`,
      kind,
      parentId ?? '',
      name,
      exceptId ?? '',
    )[0];
    if (clash !== undefined) {
      throw new CrmError('conflict', `a folder named "${name}" already exists here`, [
        { path: 'name', message: 'already used by another folder in the same parent' },
      ]);
    }
  };

  /** First free name among siblings: `name`, `name (2)`, `name (3)`, … */
  const freeName = (parentId: string | null, name: string, exceptId: string): string => {
    const taken = new Set(
      db
        .all<{ name: string }>(
          `SELECT name FROM ${F} WHERE kind = ? AND COALESCE(parent_id, '') = ? AND id != ?`,
          kind,
          parentId ?? '',
          exceptId,
        )
        .map((row) => row.name.toLowerCase()),
    );
    if (!taken.has(name.toLowerCase())) return name;
    for (let n = 2; ; n += 1) {
      const candidate = `${name} (${String(n)})`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  };

  const nextPosition = (parentId: string | null): number =>
    (db.all<{ p: number | null }>(
      `SELECT MAX(position) AS p FROM ${F} WHERE kind = ? AND COALESCE(parent_id, '') = ?`,
      kind,
      parentId ?? '',
    )[0]?.p ?? -1) + 1;

  /** Renumbers the siblings of `parentId` with `movedId` inserted at `index`. */
  const placeAt = (parentId: string | null, movedId: string, index: number) => {
    const siblings = (childrenOf(rows()).get(parentId) ?? []).filter((row) => row.id !== movedId);
    const order = siblings.map((row) => row.id);
    order.splice(Math.min(index, order.length), 0, movedId);
    order.forEach((id, position) => {
      db.run(`UPDATE ${F} SET position = ? WHERE id = ?`, position, id);
    });
  };

  const tree = (): FolderTree => {
    const all = rows();
    const map = byId(all);
    const counts = new Map<string | null, number>();
    for (const row of db.all<{ folder_id: string | null; n: number }>(
      `SELECT folder_id, COUNT(*) AS n FROM ${I} WHERE ${liveItems} GROUP BY folder_id`,
    )) {
      // Items pointing at a folder that no longer exists count as unfiled.
      const key = row.folder_id !== null && map.has(row.folder_id) ? row.folder_id : null;
      counts.set(key, (counts.get(key) ?? 0) + row.n);
    }
    const children = childrenOf(all);
    const totals = new Map<string, number>();
    const total = (id: string, seen: Set<string>): number => {
      if (seen.has(id)) return 0;
      seen.add(id);
      let sum = counts.get(id) ?? 0;
      for (const child of children.get(id) ?? []) sum += total(child.id, seen);
      totals.set(id, sum);
      return sum;
    };
    const ordered: Folder[] = [];
    const visit = (parentId: string | null, depth: number, seen: Set<string>) => {
      for (const row of children.get(parentId) ?? []) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        ordered.push({
          id: row.id,
          kind: row.kind,
          parent_id: row.parent_id,
          name: row.name,
          position: row.position,
          depth,
          item_count: counts.get(row.id) ?? 0,
          total_count: totals.get(row.id) ?? total(row.id, new Set()),
          created_at: iso(row.created_at),
          updated_at: iso(row.updated_at),
        });
        visit(row.id, depth + 1, seen);
      }
    };
    visit(null, 1, new Set());
    let all_items = 0;
    for (const n of counts.values()) all_items += n;
    return {
      data: ordered,
      unfiled_count: counts.get(null) ?? 0,
      total_count: all_items,
      max_depth: FOLDER_MAX_DEPTH,
    };
  };

  const toFolder = (id: string): Folder => {
    const found = tree().data.find((folder) => folder.id === id);
    if (found === undefined) throw notFound('folder', id);
    return found;
  };

  return {
    tree,

    get(input: { id: string }): Folder {
      return toFolder(folderOrThrow(input.id).id);
    },

    /** Throws 404 for an unknown target folder (null = unfiled is always valid). */
    assertTarget(folderId: string | null | undefined): string | null {
      if (folderId === undefined || folderId === null) return null;
      return folderOrThrow(folderId).id;
    },

    create(input: CreateFolderInput): Folder {
      const parentId = input.parent_id ?? null;
      const name = input.name.trim();
      if (parentId !== null) {
        folderOrThrow(parentId);
        if (depthOf(byId(rows()), parentId) + 1 > FOLDER_MAX_DEPTH) {
          throw invalid(
            'parent_id',
            `folders can be nested at most ${String(FOLDER_MAX_DEPTH)} levels deep`,
          );
        }
      }
      assertNameFree(parentId, name, null);
      const id = ports.newId();
      const now = ports.now();
      db.run(
        `INSERT INTO ${F} (id, kind, parent_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id,
        kind,
        parentId,
        name,
        nextPosition(parentId),
        now,
        now,
      );
      return toFolder(id);
    },

    /** Rename, reparent (no cycles, depth limit) and/or reorder among siblings. */
    update(input: { id: string; data: UpdateFolderInput }): Folder {
      const row = folderOrThrow(input.id);
      const { data } = input;
      const name = data.name?.trim() ?? row.name;
      const parentId = data.parent_id === undefined ? row.parent_id : data.parent_id;
      const moving = parentId !== row.parent_id;
      if (moving && parentId !== null) {
        folderOrThrow(parentId);
        const all = rows();
        if (subtree(all, row.id).includes(parentId)) {
          throw invalid(
            'parent_id',
            'a folder cannot be moved into itself or one of its subfolders',
          );
        }
        if (depthOf(byId(all), parentId) + heightOf(all, row.id) > FOLDER_MAX_DEPTH) {
          throw invalid(
            'parent_id',
            `folders can be nested at most ${String(FOLDER_MAX_DEPTH)} levels deep`,
          );
        }
      }
      if (moving || name !== row.name) assertNameFree(parentId, name, row.id);
      db.run(
        `UPDATE ${F} SET name = ?, parent_id = ?, updated_at = ? WHERE id = ?`,
        name,
        parentId,
        ports.now(),
        row.id,
      );
      if (data.position !== undefined) placeAt(parentId, row.id, data.position);
      else if (moving)
        db.run(`UPDATE ${F} SET position = ? WHERE id = ?`, nextPosition(parentId), row.id);
      return toFolder(row.id);
    },

    /**
     * `empty`: only a folder without subfolders and live items. `move_to_parent`:
     * subfolders (renamed on clashes) and items go to the parent first.
     * Soft-deleted items follow the same path (or become unfiled), so a restore never
     * points at a missing folder.
     */
    delete(input: { id: string; mode: 'empty' | 'move_to_parent' }): DeleteFolderResult {
      const row = folderOrThrow(input.id);
      const children = db.all<{ id: string; name: string }>(
        `SELECT id, name FROM ${F} WHERE kind = ? AND parent_id = ? ORDER BY position, name`,
        kind,
        row.id,
      );
      const items =
        db.all<{ n: number }>(
          `SELECT COUNT(*) AS n FROM ${I} WHERE folder_id = ? AND ${liveItems}`,
          row.id,
        )[0]?.n ?? 0;
      if (input.mode === 'empty' && (children.length > 0 || items > 0)) {
        throw new CrmError(
          'conflict',
          'the folder is not empty: move or delete its contents first',
          [
            {
              path: 'mode',
              message: `${String(children.length)} subfolders, ${String(items)} items`,
            },
          ],
        );
      }
      const now = ports.now();
      for (const child of children) {
        db.run(
          `UPDATE ${F} SET parent_id = ?, name = ?, position = ?, updated_at = ? WHERE id = ?`,
          row.parent_id,
          freeName(row.parent_id, child.name, child.id),
          nextPosition(row.parent_id),
          now,
          child.id,
        );
      }
      db.run(`UPDATE ${I} SET folder_id = ? WHERE folder_id = ?`, row.parent_id, row.id);
      db.run(`DELETE FROM ${F} WHERE id = ?`, row.id);
      return { id: row.id, deleted: true, moved_folders: children.length, moved_items: items };
    },

    /** Files live items into a folder (or unfiles them with null), in chunks of 90 ids. */
    moveItems(input: MoveFolderItemsInput): MoveFolderItemsResult {
      const target = input.folder_id === null ? null : folderOrThrow(input.folder_id).id;
      const ids = [...new Set(input.ids)];
      const found = new Set<string>();
      for (const part of chunks(ids)) {
        for (const item of db.all<{ id: string }>(
          `SELECT id FROM ${I} WHERE ${liveItems} AND id IN (${placeholders(part.length)})`,
          ...part,
        )) {
          found.add(item.id);
        }
      }
      const existing = ids.filter((id) => found.has(id));
      for (const part of chunks(existing)) {
        db.run(
          `UPDATE ${I} SET folder_id = ? WHERE id IN (${placeholders(part.length)})`,
          target,
          ...part,
        );
      }
      return {
        folder_id: target,
        moved: existing.length,
        missing: ids.filter((id) => !found.has(id)),
      };
    },

    /**
     * SQL predicate (on the items table's `folder_id`) for a list filter, or null
     * for no filter. Subfolders are resolved by a recursive CTE, so the number of
     * bound parameters never depends on the tree size.
     */
    filter(input: FolderFilter, column = 'folder_id'): { sql: string; params: SqlValue[] } | null {
      const folderId = input.folder_id;
      if (folderId === undefined) return null;
      if (folderId === 'none') {
        return {
          sql: `(${column} IS NULL OR ${column} NOT IN (SELECT id FROM ${F} WHERE kind = ?))`,
          params: [kind],
        };
      }
      if (input.include_subfolders === 'true') {
        return {
          sql: `${column} IN (WITH RECURSIVE sub(id) AS (SELECT ? UNION SELECT f.id FROM ${F} f JOIN sub ON f.parent_id = sub.id WHERE f.kind = ?) SELECT id FROM sub)`,
          params: [folderId, kind],
        };
      }
      return { sql: `${column} = ?`, params: [folderId] };
    },
  };
}

export type FolderStore = ReturnType<typeof createFolderStore>;
