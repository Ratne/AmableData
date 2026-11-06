import { ROLES, type Role } from '@amable/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { fakeTenantDbNamespace } from '../crm/helpers';
import {
  addMember,
  createHarness,
  login,
  seedTenant,
  seedUser,
  stepUp,
  type Harness,
  type TestClient,
} from '../helpers/harness';

const BASE = '/api/v2/t/acme';
const READERS: readonly Role[] = ['owner', 'admin', 'marketer', 'analyst', 'viewer'];
const WRITERS: readonly Role[] = ['owner', 'admin', 'marketer'];

let h: Harness;
const clients = {} as Record<Role, TestClient>;

async function forEachRole(fn: (client: TestClient, role: Role) => Promise<number>): Promise<Record<Role, number>> {
  const out = {} as Record<Role, number>;
  for (const role of ROLES) out[role] = await fn(clients[role], role);
  return out;
}

function expectByRole(results: Record<Role, number>, allowed: readonly Role[], ok: number) {
  expect(results).toEqual(Object.fromEntries(ROLES.map((role) => [role, allowed.includes(role) ? ok : 403])));
}

beforeAll(async () => {
  h = await createHarness();
  h.env.TENANT_DB = fakeTenantDbNamespace();
  const acme = await seedTenant(h, 'acme');
  const other = await seedTenant(h, 'other');
  for (const role of ROLES) {
    const user = await seedUser(h, { email: `${role}@acme.test`, name: `The ${role}` });
    await addMember(h, user.id, acme.id, role);
    clients[role] = await login(h, user.email);
  }
  await h.env.DB.prepare(
    `INSERT INTO domains (id, tenant_id, hostname, kind, status, created_at) VALUES
       ('dom_go', ?1, 'go.acme.test', 'shortlink', 'verified', 0),
       ('dom_two', ?1, 'two.acme.test', 'shortlink', 'pending', 0),
       ('dom_site', ?1, 'www.acme.test', 'app', 'verified', 0),
       ('dom_foreign', ?2, 'go.other.test', 'shortlink', 'verified', 0)`,
  )
    .bind(acme.id, other.id)
    .run();
});

describe('short links REST v2', () => {
  it('lists the shortlink domains of the workspace to every reader', async () => {
    const res = await clients.viewer.get(`${BASE}/shortlinks/domains`);
    expect(res.status).toBe(200);
    expect(res.body['data']).toEqual([
      { id: 'dom_go', hostname: 'go.acme.test', status: 'verified' },
      { id: 'dom_two', hostname: 'two.acme.test', status: 'pending' },
    ]);
    expectByRole(await forEachRole((c) => c.get(`${BASE}/shortlinks`).then((r) => r.status)), READERS, 200);
  });

  it('creates links on own shortlink domains only, with short_url and creator', async () => {
    const created = await clients.marketer.post(`${BASE}/shortlinks`, {
      domain_id: 'dom_go',
      key: 'promo',
      url: 'https://shop.example/promo',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      key: 'promo',
      hostname: 'go.acme.test',
      short_url: 'https://go.acme.test/promo',
      created_by_name: 'The marketer',
    });
    const dup = await clients.owner.post(`${BASE}/shortlinks`, { domain_id: 'dom_go', key: 'promo', url: 'https://x.test' });
    expect(dup.status).toBe(409);
    for (const domain of ['dom_site', 'dom_foreign', 'missing']) {
      const res = await clients.owner.post(`${BASE}/shortlinks`, { domain_id: domain, url: 'https://x.test' });
      expect(res.status, domain).toBe(422);
    }
    const bad = await clients.owner.post(`${BASE}/shortlinks`, { domain_id: 'dom_go', key: 'a b', url: 'ftp://x' });
    expect(bad.status).toBe(422);

    expectByRole(
      await forEachRole((c) =>
        c.post(`${BASE}/shortlinks`, { domain_id: 'dom_go', url: 'https://x.test' }).then((r) => r.status),
      ),
      WRITERS,
      201,
    );
  });

  it('updates, reports statistics and deletes', async () => {
    const created = await clients.owner.post(`${BASE}/shortlinks`, { domain_id: 'dom_go', url: 'https://x.test' });
    const id = String(created.body['id']);
    const updated = await clients.admin.patch(`${BASE}/shortlinks/${id}`, { key: 'renamed', domain_id: 'dom_two' });
    expect(updated.status).toBe(200);
    expect(updated.body['short_url']).toBe('https://two.acme.test/renamed');
    expect((await clients.admin.patch(`${BASE}/shortlinks/${id}`, { domain_id: 'dom_site' })).status).toBe(422);
    expect((await clients.viewer.patch(`${BASE}/shortlinks/${id}`, { title: 'x' })).status).toBe(403);

    const stats = await clients.analyst.get(`${BASE}/shortlinks/${id}/stats?days=7`);
    expect(stats.status).toBe(200);
    expect(stats.body).toMatchObject({ days: 7, total_clicks: 0, human_clicks: 0, bot_clicks: 0 });
    expect((stats.body['series'] as unknown[]).length).toBe(7);
    expect((await clients.analyst.get(`${BASE}/shortlinks/${id}/stats?days=91`)).status).toBe(422);

    expect((await clients.viewer.delete(`${BASE}/shortlinks/${id}`)).status).toBe(403);
    expect((await clients.marketer.delete(`${BASE}/shortlinks/${id}`)).status).toBe(200);
    expect((await clients.marketer.delete(`${BASE}/shortlinks/${id}`)).status).toBe(404);

    const audit = await h.env.DB.prepare(
      `SELECT action FROM audit_log WHERE action LIKE 'shortlinks.%' AND target = ? ORDER BY rowid`,
    )
      .bind(id)
      .all<{ action: string }>();
    expect(audit.results.map((r) => r.action)).toEqual([
      'shortlinks.link_created',
      'shortlinks.link_updated',
      'shortlinks.link_deleted',
    ]);
  });

  it('manages folders bound to domains', async () => {
    const folder = await clients.marketer.post(`${BASE}/shortlinks/folders`, { name: 'Spring', domain_ids: ['dom_go'] });
    expect(folder.status).toBe(201);
    const folderId = String(folder.body['id']);
    expect((await clients.marketer.post(`${BASE}/shortlinks/folders`, { name: 'X', domain_ids: ['dom_site'] })).status).toBe(422);
    expect(
      (await clients.owner.post(`${BASE}/shortlinks`, { domain_id: 'dom_two', url: 'https://x.test', folder_id: folderId })).status,
    ).toBe(422);
    const link = await clients.owner.post(`${BASE}/shortlinks`, { domain_id: 'dom_go', url: 'https://x.test', folder_id: folderId });
    expect(link.status).toBe(201);

    const list = await clients.viewer.get(`${BASE}/shortlinks/folders`);
    expect(list.body['data']).toEqual([expect.objectContaining({ id: folderId, domain_ids: ['dom_go'], link_count: 1 })]);
    expect((await clients.viewer.get(`${BASE}/shortlinks?folder_id=${folderId}`)).body['data']).toHaveLength(1);
    expect((await clients.viewer.patch(`${BASE}/shortlinks/folders/${folderId}`, { name: 'Y' })).status).toBe(403);
    expect((await clients.marketer.patch(`${BASE}/shortlinks/folders/${folderId}`, { name: 'Summer' })).body['name']).toBe('Summer');
    const removed = await clients.marketer.delete(`${BASE}/shortlinks/folders/${folderId}`);
    expect(removed.body).toEqual({ id: folderId, deleted: true, moved_links: 1 });
  });

  it('deletes the links of a removed shortlink domain', async () => {
    await clients.owner.post(`${BASE}/shortlinks`, { domain_id: 'dom_two', key: 'bye', url: 'https://x.test' });
    await stepUp(h, clients.owner);
    const res = await clients.owner.delete(`${BASE}/domains/dom_two`);
    expect(res.status).toBe(200);
    const links = await clients.owner.get(`${BASE}/shortlinks?include_archived=true`);
    expect((links.body['data'] as Array<{ domain_id: string }>).some((l) => l.domain_id === 'dom_two')).toBe(false);
  });
});
