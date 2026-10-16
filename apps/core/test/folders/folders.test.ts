import { DatabaseSync } from 'node:sqlite';
import { FOLDER_MAX_DEPTH, type Folder } from '@amable/api-types';
import { createDoSqliteMigrationStore, runMigrations, tenantMigrations } from '@amable/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { engineMigrations } from '../../src/automation/migrations';
import { createTestTenant, type TestTenant } from '../crm/helpers';
import { createEngineHarness, type EngineHarness } from '../automation/helpers';

function errorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as { shape?: { code: string } }).shape?.code ?? 'thrown';
  }
  return 'none';
}

async function asyncErrorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { shape?: { code: string } }).shape?.code ?? String(error);
  }
  return 'none';
}

const names = (folders: readonly Folder[]) =>
  folders.map((f) => `${'  '.repeat(f.depth - 1)}${f.name}`);

describe('page folders (TenantDb)', () => {
  let t: TestTenant;
  beforeEach(() => {
    t = createTestTenant();
  });

  const page = (path: string, folder_id?: string | null) =>
    t.op('pages.create', { title: path, path, ...(folder_id === undefined ? {} : { folder_id }) });

  it('creates nested folders with unique names per parent and lists them as a tree', () => {
    const a = t.op('pages.folders.create', { name: 'Campaigns' });
    const b = t.op('pages.folders.create', { name: 'Archive' });
    const a1 = t.op('pages.folders.create', { name: '2026', parent_id: a.id });
    t.op('pages.folders.create', { name: '2026', parent_id: b.id });
    expect(errorCode(() => t.op('pages.folders.create', { name: 'campaigns' }))).toBe('conflict');
    expect(errorCode(() => t.op('pages.folders.create', { name: '2026', parent_id: a.id }))).toBe(
      'conflict',
    );
    expect(errorCode(() => t.op('pages.folders.create', { name: 'x', parent_id: 'nope' }))).toBe(
      'not_found',
    );
    expect(a1).toMatchObject({ kind: 'page', parent_id: a.id, depth: 2, position: 0 });
    expect(names(t.op('pages.folders.list', {}).data)).toEqual([
      'Campaigns',
      '  2026',
      'Archive',
      '  2026',
    ]);

    const renamed = t.op('pages.folders.update', { id: a1.id, data: { name: 'Spring 2026' } });
    expect(renamed.name).toBe('Spring 2026');
    expect(
      errorCode(() => t.op('pages.folders.update', { id: b.id, data: { name: 'CAMPAIGNS' } })),
    ).toBe('conflict');
  });

  it('enforces the depth limit on create and on move', () => {
    let parent: string | null = null;
    const chain: string[] = [];
    for (let level = 1; level <= FOLDER_MAX_DEPTH; level += 1) {
      const folder: Folder = t.op('pages.folders.create', {
        name: `L${String(level)}`,
        parent_id: parent,
      });
      expect(folder.depth).toBe(level);
      chain.push(folder.id);
      parent = folder.id;
    }
    expect(
      errorCode(() => t.op('pages.folders.create', { name: 'too deep', parent_id: parent })),
    ).toBe('validation_failed');
    // A two-level subtree cannot go under level 4.
    const top = t.op('pages.folders.create', { name: 'Top' });
    t.op('pages.folders.create', { name: 'Child', parent_id: top.id });
    expect(
      errorCode(() => t.op('pages.folders.update', { id: top.id, data: { parent_id: chain[3] } })),
    ).toBe('validation_failed');
    expect(t.op('pages.folders.update', { id: top.id, data: { parent_id: chain[2] } }).depth).toBe(
      4,
    );
  });

  it('prevents cycles when moving folders and reorders siblings', () => {
    const a = t.op('pages.folders.create', { name: 'A' });
    const b = t.op('pages.folders.create', { name: 'B', parent_id: a.id });
    const c = t.op('pages.folders.create', { name: 'C', parent_id: b.id });
    expect(
      errorCode(() => t.op('pages.folders.update', { id: a.id, data: { parent_id: a.id } })),
    ).toBe('validation_failed');
    expect(
      errorCode(() => t.op('pages.folders.update', { id: a.id, data: { parent_id: c.id } })),
    ).toBe('validation_failed');
    // Move C to the root, then put it first.
    t.op('pages.folders.update', { id: c.id, data: { parent_id: null } });
    t.op('pages.folders.update', { id: c.id, data: { position: 0 } });
    expect(names(t.op('pages.folders.list', {}).data)).toEqual(['C', 'A', '  B']);
    // Same name in the new parent is refused.
    t.op('pages.folders.create', { name: 'B' });
    expect(
      errorCode(() => t.op('pages.folders.update', { id: b.id, data: { parent_id: null } })),
    ).toBe('conflict');
  });

  it('moves pages (single and bulk), counts them and filters the list', () => {
    const a = t.op('pages.folders.create', { name: 'A' });
    const sub = t.op('pages.folders.create', { name: 'Sub', parent_id: a.id });
    const p1 = page('/one');
    const p2 = page('/two');
    const p3 = page('/three', sub.id);
    page('/four');
    expect(errorCode(() => page('/five', 'missing'))).toBe('not_found');

    expect(t.op('pages.folders.moveItems', { ids: [p1.id], folder_id: a.id })).toEqual({
      folder_id: a.id,
      moved: 1,
      missing: [],
    });
    const bulk = t.op('pages.folders.moveItems', {
      ids: [p2.id, p2.id, 'ghost'],
      folder_id: sub.id,
    });
    expect(bulk).toEqual({ folder_id: sub.id, moved: 1, missing: ['ghost'] });

    const tree = t.op('pages.folders.list', {});
    expect(tree.total_count).toBe(4);
    expect(tree.unfiled_count).toBe(1);
    expect(tree.data.map((f) => [f.name, f.item_count, f.total_count])).toEqual([
      ['A', 1, 3],
      ['Sub', 2, 2],
    ]);

    const ids = (query: Record<string, string>) =>
      t
        .op('pages.list', { limit: 50, ...query })
        .data.map((p) => p.path)
        .sort();
    expect(ids({ folder_id: a.id })).toEqual(['/one']);
    expect(ids({ folder_id: a.id, include_subfolders: 'true' })).toEqual([
      '/one',
      '/three',
      '/two',
    ]);
    expect(ids({ folder_id: 'none' })).toEqual(['/four']);
    expect(t.op('pages.get', { id: p3.id }).folder_id).toBe(sub.id);
    // Duplicates stay in the same folder; deleted pages are not counted.
    expect(t.op('pages.duplicate', { id: p3.id }).folder_id).toBe(sub.id);
    t.op('pages.delete', { id: p3.id });
    expect(t.op('pages.folders.get', { id: sub.id }).item_count).toBe(2);
    expect(t.op('pages.folders.moveItems', { ids: [p3.id], folder_id: null }).missing).toEqual([
      p3.id,
    ]);
  });

  it('deletes only empty folders, or moves the contents to the parent', () => {
    const a = t.op('pages.folders.create', { name: 'A' });
    const b = t.op('pages.folders.create', { name: 'B', parent_id: a.id });
    const clash = t.op('pages.folders.create', { name: 'Clash', parent_id: b.id });
    t.op('pages.folders.create', { name: 'Clash', parent_id: a.id });
    const p1 = page('/one', b.id);
    const gone = page('/gone', b.id);
    t.op('pages.delete', { id: gone.id });

    expect(errorCode(() => t.op('pages.folders.delete', { id: b.id, mode: 'empty' }))).toBe(
      'conflict',
    );
    expect(t.op('pages.folders.delete', { id: b.id, mode: 'move_to_parent' })).toEqual({
      id: b.id,
      deleted: true,
      moved_folders: 1,
      moved_items: 1,
    });
    expect(t.op('pages.get', { id: p1.id }).folder_id).toBe(a.id);
    expect(t.op('pages.folders.get', { id: clash.id })).toMatchObject({
      parent_id: a.id,
      name: 'Clash (2)',
    });
    // The soft-deleted page follows, so a restore lands in an existing folder.
    expect(t.op('pages.restore', { id: gone.id }).folder_id).toBe(a.id);

    const empty = t.op('pages.folders.create', { name: 'Empty' });
    expect(t.op('pages.folders.delete', { id: empty.id, mode: 'empty' }).deleted).toBe(true);
    expect(errorCode(() => t.op('pages.folders.get', { id: empty.id }))).toBe('not_found');
  });
});

describe('automation folders (Engine DO)', () => {
  let h: EngineHarness;
  beforeEach(() => {
    h = createEngineHarness();
  });

  it('files automations, filters the list and moves 250 at once in chunks under the parameter limit', async () => {
    const root = await h.op('folders.create', { name: 'Onboarding' });
    const nested = await h.op('folders.create', { name: 'Welcome', parent_id: root.id });
    const inside = await h.op('automations.create', { name: 'Inside', folder_id: nested.id });
    expect(inside.folder_id).toBe(nested.id);
    expect(
      await asyncErrorCode(h.op('automations.create', { name: 'x', folder_id: 'missing' })),
    ).toBe('not_found');

    const ids: string[] = [];
    for (let i = 0; i < 250; i += 1)
      ids.push((await h.op('automations.create', { name: `A${String(i)}` })).id);
    // The harness DB throws above 100 bound parameters, like Durable Object SQLite.
    const moved = await h.op('folders.moveItems', { ids, folder_id: root.id });
    expect(moved).toMatchObject({ moved: 250, missing: [] });

    const tree = await h.op('folders.list', {});
    expect(tree).toMatchObject({ unfiled_count: 0, total_count: 251 });
    expect(tree.data.map((f) => [f.name, f.item_count, f.total_count])).toEqual([
      ['Onboarding', 250, 251],
      ['Welcome', 1, 1],
    ]);
    const direct = await h.op('automations.list', { limit: 200, folder_id: nested.id });
    expect(direct.data.map((a) => a.name)).toEqual(['Inside']);
    const deep = await h.op('automations.list', {
      limit: 5,
      folder_id: root.id,
      include_subfolders: 'true',
    });
    expect(deep.data).toHaveLength(5);
    expect(deep.next_cursor).not.toBeNull();

    expect(await asyncErrorCode(h.op('folders.delete', { id: root.id, mode: 'empty' }))).toBe(
      'conflict',
    );
    await h.op('folders.delete', { id: root.id, mode: 'move_to_parent' });
    const after = await h.op('folders.list', {});
    expect(after.data.map((f) => [f.name, f.depth, f.parent_id])).toEqual([['Welcome', 1, null]]);
    expect(after.unfiled_count).toBe(250);
    expect((await h.op('automations.get', { id: inside.id })).folder_id).toBe(nested.id);
  });

  it('prevents cycles and deep nesting', async () => {
    const a = await h.op('folders.create', { name: 'A' });
    const b = await h.op('folders.create', { name: 'B', parent_id: a.id });
    expect(
      await asyncErrorCode(h.op('folders.update', { id: a.id, data: { parent_id: b.id } })),
    ).toBe('validation_failed');
    let parent = b.id;
    for (let level = 3; level <= FOLDER_MAX_DEPTH; level += 1) {
      parent = (await h.op('folders.create', { name: `L${String(level)}`, parent_id: parent })).id;
    }
    expect(await asyncErrorCode(h.op('folders.create', { name: 'deep', parent_id: parent }))).toBe(
      'validation_failed',
    );
  });
});

/** Minimal Durable Object storage over node:sqlite, enough for the DO migration store. */
function fakeDoStorage(db: DatabaseSync): DurableObjectStorage {
  return {
    sql: {
      exec: (query: string, ...params: Array<string | number | null>) => {
        const statement = db.prepare(query);
        const rows = /^\s*(SELECT|WITH)/i.test(query)
          ? (statement.all(...params) as Record<string, unknown>[])
          : (statement.run(...params), []);
        return { toArray: () => rows };
      },
    },
    transactionSync: <T>(fn: () => T): T => {
      db.exec('BEGIN');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as DurableObjectStorage;
}

describe('folder migrations on existing Durable Objects', () => {
  it('adds the Engine folders to a DO at schema 2 without touching its automations, once', async () => {
    const db = new DatabaseSync(':memory:');
    const storage = fakeDoStorage(db);
    const store = () => createDoSqliteMigrationStore(storage, { metaTable: 'engine_meta' });
    await runMigrations(
      store(),
      engineMigrations.filter((m) => m.id <= 2),
    );
    db.prepare(
      `INSERT INTO eng_automations (id, name, draft_graph, signing_secret, created_at, updated_at) VALUES ('a1', 'Old', '{}', '', 1, 1)`,
    ).run();

    expect(await runMigrations(store(), engineMigrations)).toBe(3);
    expect(await runMigrations(store(), engineMigrations)).toBe(3);
    expect(db.prepare(`SELECT name, folder_id FROM eng_automations`).all()).toEqual([
      { name: 'Old', folder_id: null },
    ]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM eng_folders`).get()).toEqual({ n: 0 });
  });

  it('adds the page folders to a TenantDb at schema 7, once', async () => {
    const db = new DatabaseSync(':memory:');
    const storage = fakeDoStorage(db);
    const store = () => createDoSqliteMigrationStore(storage);
    await runMigrations(
      store(),
      tenantMigrations.filter((m) => m.id <= 7),
    );
    db.prepare(
      `INSERT INTO page_pages (id, title, path, draft, created_at, updated_at) VALUES ('p1', 'Home', '/', '{}', 1, 1)`,
    ).run();

    const latest = Math.max(...tenantMigrations.map((m) => m.id));
    expect(await runMigrations(store(), tenantMigrations)).toBe(latest);
    expect(await runMigrations(store(), tenantMigrations)).toBe(latest);
    expect(db.prepare(`SELECT path, folder_id FROM page_pages`).all()).toEqual([
      { path: '/', folder_id: null },
    ]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM folders`).get()).toEqual({ n: 0 });
  });
});
