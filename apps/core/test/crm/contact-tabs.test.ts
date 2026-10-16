import { beforeAll, describe, expect, it } from 'vitest';
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
import { fakeTenantDbNamespace } from './helpers';

const BASE = '/api/v2/t/acme';

let h: Harness;
let owner: TestClient;
let viewer: TestClient;

beforeAll(async () => {
  h = await createHarness();
  h.env.TENANT_DB = fakeTenantDbNamespace();
  const acme = await seedTenant(h, 'acme');
  const o = await seedUser(h, { email: 'owner@example.com' });
  const v = await seedUser(h, { email: 'viewer@example.com' });
  await addMember(h, o.id, acme.id, 'owner');
  await addMember(h, v.id, acme.id, 'viewer');
  owner = await login(h, 'owner@example.com');
  viewer = await login(h, 'viewer@example.com');
});

type Row = Record<string, unknown>;

describe('contact page tabs', () => {
  it('pages through the tags of a contact by name, with search and removal', async () => {
    const contact = await owner.post(`${BASE}/contacts`, { given_name: 'Tagged' });
    const contactId = String(contact.body['id']);
    const tagIds: string[] = [];
    for (let i = 0; i < 150; i++) {
      const name = `${i % 2 === 0 ? 'Even' : 'Odd'} ${String(i).padStart(3, '0')}`;
      const tag = await owner.post(`${BASE}/tags`, { name });
      tagIds.push(String(tag.body['id']));
    }
    const unrelated = await owner.post(`${BASE}/tags`, { name: 'Even but not applied' });
    expect(unrelated.status).toBe(201);
    for (let i = 0; i < tagIds.length; i += 100) {
      const applied = await owner.post(`${BASE}/contacts/${contactId}/tags`, {
        tag_ids: tagIds.slice(i, i + 100),
      });
      expect(applied.status).toBe(200);
    }

    const names: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor === null ? '' : `&cursor=${cursor}`;
      const res = await viewer.get(`${BASE}/contacts/${contactId}/tags?limit=40${query}`);
      expect(res.status).toBe(200);
      const data = res.body['data'] as Row[];
      expect(data[0]).toEqual({
        id: expect.any(String),
        name: expect.any(String),
        category_id: null,
        applied_at: expect.any(String),
        applied_by: expect.any(String),
      });
      names.push(...data.map((t) => String(t['name'])));
      cursor = res.body['next_cursor'] as string | null;
      pages += 1;
    } while (cursor !== null);
    expect(pages).toBe(4);
    expect(names).toHaveLength(150);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(names.slice(0, 2)).toEqual(['Even 000', 'Even 002']);

    const search = await viewer.get(`${BASE}/contacts/${contactId}/tags?q=odd 1&limit=200`);
    const found = (search.body['data'] as Row[]).map((t) => String(t['name']));
    expect(found).toHaveLength(25);
    expect(found.every((n) => n.startsWith('Odd 1'))).toBe(true);
    const wildcard = await viewer.get(`${BASE}/contacts/${contactId}/tags?q=%25`);
    expect(wildcard.body['data']).toEqual([]);

    await owner.delete(`${BASE}/contacts/${contactId}/tags/${tagIds[0] ?? ''}`);
    await owner.delete(`${BASE}/tags/${tagIds[1] ?? ''}`);
    const counts = await owner.get(`${BASE}/contacts/${contactId}/counts`);
    expect(counts.body['tags']).toBe(148);

    expect((await viewer.get(`${BASE}/contacts/${contactId}/tags?limit=201`)).status).toBe(422);
    expect((await viewer.get(`${BASE}/contacts/01JZZZZZZZZZZZZZZZZZZZZZZZ/tags`)).status).toBe(404);
  });

  it('counts the records of every tab and omits the ones the caller may not read', async () => {
    const contact = await owner.post(`${BASE}/contacts`, { given_name: 'Busy' });
    const contactId = String(contact.body['id']);
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'n' }] }] };
    await owner.post(`${BASE}/notes`, { contact_id: contactId, body: doc });
    await owner.post(`${BASE}/notes`, { contact_id: contactId, body: doc });
    const task = await owner.post(`${BASE}/tasks`, { contact_id: contactId, title: 'Call' });
    await owner.post(`${BASE}/tasks`, { contact_id: contactId, title: 'Mail' });
    await owner.post(`${BASE}/tasks/${String(task.body['id'])}/complete`);
    await owner.post(`${BASE}/appointments`, {
      contact_id: contactId,
      title: 'Demo',
      start_at: '2026-11-01T10:00:00Z',
      end_at: '2026-11-01T10:30:00Z',
    });
    await owner.post(`${BASE}/pipelines`, { name: 'Sales', is_default: true });
    const deal = await owner.post(`${BASE}/opportunities`, { contact_id: contactId, title: 'Deal' });
    expect(deal.status).toBe(201);

    const full = await owner.get(`${BASE}/contacts/${contactId}/counts`);
    expect(full.status).toBe(200);
    expect(full.body).toEqual({
      tags: 0,
      notes: 2,
      tasks_open: 1,
      appointments: 1,
      opportunities: 1,
      orders: 0,
      submissions: 0,
    });

    const viewerCounts = await viewer.get(`${BASE}/contacts/${contactId}/counts`);
    expect(viewerCounts.body).toEqual(full.body);

    await stepUp(h, owner);
    const key = await owner.post('/api/t/acme/api-keys', { name: 'crm', scopes: ['contacts:read'] });
    const viaKey = await h.client().request('GET', `${BASE}/contacts/${contactId}/counts`, undefined, {
      authorization: `Bearer ${String(key.body['key'])}`,
    });
    expect(viaKey.status).toBe(200);
    expect(viaKey.body).toEqual({ tags: 0, notes: 2 });
  });
});
