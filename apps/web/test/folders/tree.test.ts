import type { Folder } from '@amable/api-types';
import { describe, expect, it } from 'vitest';
import {
  ancestorsOf,
  canMoveFolder,
  createTarget,
  draggedIds,
  folderQuery,
  FOLDER_MIME,
  indexFolders,
  ITEMS_MIME,
  parseFolderSearch,
  readDrag,
  revealPath,
} from '../../src/features/folders/lib/tree';

const folder = (id: string, parent_id: string | null, depth: number): Folder => ({
  id,
  kind: 'page',
  parent_id,
  name: id.toUpperCase(),
  position: 0,
  depth,
  item_count: 0,
  total_count: 0,
  created_at: '2026-10-16T00:00:00.000Z',
  updated_at: '2026-10-16T00:00:00.000Z',
});

// a ─ b ─ c ─ d      e
const index = indexFolders([
  folder('a', null, 1),
  folder('b', 'a', 2),
  folder('c', 'b', 3),
  folder('d', 'c', 4),
  folder('e', null, 1),
]);

function transfer(data: Record<string, string>): Pick<DataTransfer, 'getData' | 'types'> {
  return { types: Object.keys(data), getData: (type: string) => data[type] ?? '' };
}

describe('folder tree helpers', () => {
  it('builds the breadcrumb chain and the folders to expand', () => {
    expect(ancestorsOf(index, 'c').map((f) => f.id)).toEqual(['a', 'b', 'c']);
    expect(revealPath(index, 'c')).toEqual(['a', 'b']);
    expect(ancestorsOf(index, 'missing')).toEqual([]);
  });

  it('mirrors the server move rules (cycles, depth limit, no-op)', () => {
    expect(canMoveFolder(index, 'a', 'c', 5)).toBe('cycle');
    expect(canMoveFolder(index, 'b', 'a', 5)).toBe('same');
    expect(canMoveFolder(index, 'b', null, 5)).toBe('ok');
    // b has 3 levels (b, c, d): under e (depth 1) it reaches depth 4.
    expect(canMoveFolder(index, 'b', 'e', 5)).toBe('ok');
    expect(canMoveFolder(index, 'b', 'e', 3)).toBe('depth');
    expect(canMoveFolder(index, 'e', 'd', 5)).toBe('ok');
    expect(canMoveFolder(index, 'e', 'd', 4)).toBe('depth');
  });

  it('maps the selection to the list filter and the target of new items', () => {
    expect(folderQuery('all', true)).toEqual({});
    expect(folderQuery('none', true)).toEqual({ folder_id: 'none' });
    expect(folderQuery('a', false)).toEqual({ folder_id: 'a' });
    expect(folderQuery('a', true)).toEqual({ folder_id: 'a', include_subfolders: 'true' });
    expect(createTarget('none')).toBeNull();
    expect(createTarget('b')).toBe('b');
  });

  it('parses the URL search params', () => {
    expect(parseFolderSearch({})).toEqual({});
    expect(parseFolderSearch({ folder: 'all', sub: 'nope' })).toEqual({});
    expect(parseFolderSearch({ folder: 'a', sub: true })).toEqual({ folder: 'a', sub: true });
    expect(parseFolderSearch({ folder: 3, sub: '1' })).toEqual({ sub: true });
  });

  it('drags the whole selection from a selected row and reads drops', () => {
    expect(draggedIds('x', ['x', 'y'])).toEqual(['x', 'y']);
    expect(draggedIds('z', ['x', 'y'])).toEqual(['z']);
    expect(readDrag(transfer({ [ITEMS_MIME]: '["x","y"]' }))).toEqual({ type: 'items', ids: ['x', 'y'] });
    expect(readDrag(transfer({ [FOLDER_MIME]: 'a' }))).toEqual({ type: 'folder', id: 'a' });
    expect(readDrag(transfer({ [ITEMS_MIME]: 'not json' }))).toBeNull();
    expect(readDrag(transfer({ [ITEMS_MIME]: '[]' }))).toBeNull();
    expect(readDrag(transfer({ 'text/plain': 'hi' }))).toBeNull();
  });
});
