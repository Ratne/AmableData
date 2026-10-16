import { ROLES, type Role } from '@amable/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { mergedOpenApiDocument } from '../../src/developers/openapi';
import { fakeTenantDbNamespace } from '../crm/helpers';
import { fakeEngineNamespace } from '../automation/helpers';
import {
  addMember,
  createHarness,
  login,
  seedTenant,
  seedUser,
  type Harness,
  type TestClient,
} from '../helpers/harness';

const BASE = '/api/v2/t/acme';
const WRITERS: readonly Role[] = ['owner', 'admin', 'marketer'];

let h: Harness;
const clients = {} as Record<Role, TestClient>;

beforeAll(async () => {
  h = await createHarness();
  h.env.TENANT_DB = fakeTenantDbNamespace();
  h.env.ENGINE = fakeEngineNamespace(h.env.TENANT_DB, h.clock);
  const acme = await seedTenant(h, 'acme');
  for (const role of ROLES) {
    const user = await seedUser(h, { email: `${role}@acme.test` });
    await addMember(h, user.id, acme.id, role);
    clients[role] = await login(h, user.email);
  }
});

async function byRole(
  fn: (client: TestClient, role: Role) => Promise<number>,
): Promise<Record<Role, number>> {
  const out = {} as Record<Role, number>;
  for (const role of ROLES) out[role] = await fn(clients[role], role);
  return out;
}

const expected = (allowed: readonly Role[], ok: number) =>
  Object.fromEntries(ROLES.map((role) => [role, allowed.includes(role) ? ok : 403]));

const KINDS = [
  {
    path: 'automationFolders',
    readers: ROLES,
    item: async (client: TestClient, name: string) =>
      String((await client.post(`${BASE}/automations`, { name })).body['id']),
    list: (query: string) => `${BASE}/automations?${query}`,
  },
  {
    path: 'pageFolders',
    readers: ['owner', 'admin', 'marketer', 'analyst', 'viewer'] as readonly Role[],
    item: async (client: TestClient, name: string) =>
      String((await client.post(`${BASE}/pages`, { title: name, path: `/${name}` })).body['id']),
    list: (query: string) => `${BASE}/pages?${query}`,
  },
] as const;

describe.each(KINDS)('REST v2 /$path', ({ path, readers, item, list }) => {
  it('checks read and write permissions for all six roles', async () => {
    expect(await byRole(async (c) => (await c.get(`${BASE}/${path}`)).status)).toEqual(
      expected(readers, 200),
    );
    const created = await byRole(
      async (c, role) => (await c.post(`${BASE}/${path}`, { name: `By ${role}` })).status,
    );
    expect(created).toEqual(expected(WRITERS, 201));

    const folder = await clients.owner.post(`${BASE}/${path}`, { name: 'Perms' });
    const id = String(folder.body['id']);
    expect(
      await byRole(
        async (c, role) =>
          (await c.patch(`${BASE}/${path}/${id}`, { name: `Perms ${role}` })).status,
      ),
    ).toEqual(expected(WRITERS, 200));
    const itemId = await item(clients.owner, `perm-${path.toLowerCase()}`);
    expect(
      await byRole(
        async (c) =>
          (await c.post(`${BASE}/${path}/moveItems`, { ids: [itemId], folder_id: id })).status,
      ),
    ).toEqual(expected(WRITERS, 200));
    const deletions = await byRole(async (c, role) => {
      const own = await clients.owner.post(`${BASE}/${path}`, { name: `Delete ${role}` });
      return (await c.delete(`${BASE}/${path}/${String(own.body['id'])}`)).status;
    });
    expect(deletions).toEqual(expected(WRITERS, 200));
  });

  it('builds a tree, moves items in bulk, filters the list and applies the delete rules', async () => {
    const owner = clients.owner;
    const root = await owner.post(`${BASE}/${path}`, { name: 'Tree root' });
    const rootId = String(root.body['id']);
    const child = await owner.post(`${BASE}/${path}`, { name: 'Child', parent_id: rootId });
    expect(child.body).toMatchObject({ depth: 2, parent_id: rootId, item_count: 0 });
    const childId = String(child.body['id']);
    expect((await owner.post(`${BASE}/${path}`, { name: 'child', parent_id: rootId })).status).toBe(
      409,
    );
    expect((await owner.patch(`${BASE}/${path}/${rootId}`, { parent_id: childId })).status).toBe(
      422,
    );
    expect((await owner.post(`${BASE}/${path}`, { name: '' })).status).toBe(422);

    const ids = [
      await item(owner, `tree-a-${path.toLowerCase()}`),
      await item(owner, `tree-b-${path.toLowerCase()}`),
    ];
    const moved = await owner.post(`${BASE}/${path}/moveItems`, {
      ids: [...ids, 'ghost'],
      folder_id: childId,
    });
    expect(moved.body).toEqual({ folder_id: childId, moved: 2, missing: ['ghost'] });
    expect(
      (await owner.post(`${BASE}/${path}/moveItems`, { ids: [], folder_id: null })).status,
    ).toBe(422);
    expect((await owner.post(`${BASE}/${path}/moveItems`, { ids, folder_id: 'nope' })).status).toBe(
      404,
    );

    const tree = await owner.get(`${BASE}/${path}`);
    const folders = tree.body['data'] as Array<Record<string, unknown>>;
    expect(folders.find((f) => f['id'] === rootId)).toMatchObject({
      item_count: 0,
      total_count: 2,
    });
    expect(tree.body['max_depth']).toBe(5);

    const direct = await owner.get(list(`folder_id=${rootId}`));
    expect(direct.body['data']).toHaveLength(0);
    const deep = await owner.get(list(`folder_id=${rootId}&include_subfolders=true`));
    expect(
      (deep.body['data'] as Array<{ id: string; folder_id: string }>).map((r) => r.folder_id),
    ).toEqual([childId, childId]);

    expect((await owner.delete(`${BASE}/${path}/${rootId}`)).status).toBe(409);
    const removed = await owner.delete(`${BASE}/${path}/${rootId}?mode=move_to_parent`);
    expect(removed.body).toEqual({ id: rootId, deleted: true, moved_folders: 1, moved_items: 0 });
    expect((await owner.get(`${BASE}/${path}/${childId}`)).body).toMatchObject({
      parent_id: null,
      depth: 1,
      item_count: 2,
    });
  });
});

describe('folder routes in the OpenAPI document', () => {
  it('documents every folder route with its permission', () => {
    const doc = mergedOpenApiDocument() as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const folderPaths = Object.entries(doc.paths).filter(([p]) =>
      /\/(automation|page)Folders/.test(p),
    );
    expect(folderPaths.map(([p]) => p).sort()).toEqual([
      '/automationFolders',
      '/automationFolders/moveItems',
      '/automationFolders/{id}',
      '/pageFolders',
      '/pageFolders/moveItems',
      '/pageFolders/{id}',
    ]);
    for (const [p, operations] of folderPaths) {
      for (const [method, operation] of Object.entries(operations)) {
        if (typeof operation !== 'object' || operation === null || !('responses' in operation))
          continue;
        const kind = p.includes('automation') ? 'automations' : 'pages';
        const access = method === 'get' ? 'read' : 'write';
        expect(operation['x-amable-permission']).toBe(`${kind}:${access}`);
      }
    }
  });
});
