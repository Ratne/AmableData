import type { Folder } from '@amable/api-types';

/** Selected folder in a list page: every item, unfiled items, or one folder id. */
export type FolderSelection = 'all' | 'none' | string;

export interface FolderIndex {
  readonly byId: ReadonlyMap<string, Folder>;
  /** Children by parent id (`null` = root), in server order. */
  readonly children: ReadonlyMap<string | null, readonly Folder[]>;
}

export function indexFolders(folders: readonly Folder[]): FolderIndex {
  const byId = new Map<string, Folder>();
  const children = new Map<string | null, Folder[]>();
  for (const folder of folders) {
    byId.set(folder.id, folder);
    const list = children.get(folder.parent_id) ?? [];
    list.push(folder);
    children.set(folder.parent_id, list);
  }
  return { byId, children };
}

/** Root → folder chain (inclusive), for the breadcrumb. */
export function ancestorsOf(index: FolderIndex, id: string): Folder[] {
  const chain: Folder[] = [];
  const seen = new Set<string>();
  let cursor: string | null = id;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const folder = index.byId.get(cursor);
    if (folder === undefined) break;
    chain.unshift(folder);
    cursor = folder.parent_id;
  }
  return chain;
}

/** A folder and every folder below it. */
export function subtreeIds(index: FolderIndex, id: string): Set<string> {
  const out = new Set<string>();
  const stack = [id];
  while (stack.length > 0) {
    const next = stack.pop() as string;
    if (out.has(next)) continue;
    out.add(next);
    for (const child of index.children.get(next) ?? []) stack.push(child.id);
  }
  return out;
}

/** Levels of a subtree (1 = no subfolders). */
export function subtreeHeight(index: FolderIndex, id: string): number {
  const children = index.children.get(id) ?? [];
  let max = 0;
  for (const child of children) max = Math.max(max, subtreeHeight(index, child.id));
  return max + 1;
}

export type FolderDropCheck = 'ok' | 'same' | 'cycle' | 'depth';

/**
 * Whether `folderId` can move under `targetId` (`null` = root), mirroring the
 * server rules: no cycles, at most `maxDepth` levels.
 */
export function canMoveFolder(
  index: FolderIndex,
  folderId: string,
  targetId: string | null,
  maxDepth: number,
): FolderDropCheck {
  const folder = index.byId.get(folderId);
  if (folder === undefined) return 'same';
  if (folder.parent_id === targetId) return 'same';
  if (targetId === null) return 'ok';
  if (subtreeIds(index, folderId).has(targetId)) return 'cycle';
  const targetDepth = index.byId.get(targetId)?.depth ?? 0;
  return targetDepth + subtreeHeight(index, folderId) > maxDepth ? 'depth' : 'ok';
}

/** Ids of the folders to keep expanded so that `id` is visible. */
export function revealPath(index: FolderIndex, id: string): string[] {
  return ancestorsOf(index, id)
    .slice(0, -1)
    .map((folder) => folder.id);
}

/** Folder selection ↔ `folder_id` list filter of the REST API. */
export function folderQuery(
  selection: FolderSelection,
  includeSubfolders: boolean,
): { folder_id?: string; include_subfolders?: 'true' } {
  if (selection === 'all') return {};
  if (selection === 'none') return { folder_id: 'none' };
  return includeSubfolders
    ? { folder_id: selection, include_subfolders: 'true' }
    : { folder_id: selection };
}

/** Target folder of new items created while `selection` is shown. */
export function createTarget(selection: FolderSelection): string | null {
  return selection === 'all' || selection === 'none' ? null : selection;
}

// ------------------------------------------------------------ drag & drop

export const ITEMS_MIME = 'application/x-amable-items';
export const FOLDER_MIME = 'application/x-amable-folder';

export type DragPayload =
  | { readonly type: 'items'; readonly ids: readonly string[] }
  | { readonly type: 'folder'; readonly id: string };

/** Data of a drag, readable on drop (types only while dragging over). */
export function readDrag(data: Pick<DataTransfer, 'getData' | 'types'>): DragPayload | null {
  if (data.types.includes(FOLDER_MIME)) {
    const id = data.getData(FOLDER_MIME);
    return id === '' ? null : { type: 'folder', id };
  }
  if (data.types.includes(ITEMS_MIME)) {
    try {
      const parsed: unknown = JSON.parse(data.getData(ITEMS_MIME));
      if (
        Array.isArray(parsed) &&
        parsed.every((v): v is string => typeof v === 'string') &&
        parsed.length > 0
      ) {
        return { type: 'items', ids: parsed };
      }
    } catch {
      return null;
    }
  }
  return null;
}

/** Ids dragged from a row: the whole selection when the row belongs to it. */
export function draggedIds(rowId: string, selected: readonly string[]): string[] {
  return selected.includes(rowId) ? [...selected] : [rowId];
}

/** `?folder=` / `?sub=` search params ↔ selection. */
export interface FolderSearch {
  readonly folder?: string;
  readonly sub?: boolean;
}

export function parseFolderSearch(search: Record<string, unknown>): FolderSearch {
  const folder = search['folder'];
  const sub = search['sub'];
  return {
    ...(typeof folder === 'string' && folder !== '' && folder !== 'all' ? { folder } : {}),
    ...(sub === true || sub === 'true' || sub === 1 || sub === '1' ? { sub: true } : {}),
  };
}
