import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app';
import {
  addMember,
  createHarness,
  login,
  ORIGIN,
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
let sales: TestClient;

beforeAll(async () => {
  h = await createHarness();
  h.env.TENANT_DB = fakeTenantDbNamespace();
  const acme = await seedTenant(h, 'acme');
  const other = await seedTenant(h, 'other');
  const o = await seedUser(h, { email: 'owner@example.com' });
  const v = await seedUser(h, { email: 'viewer@example.com' });
  const s = await seedUser(h, { email: 'sales@example.com' });
  const stranger = await seedUser(h, { email: 'stranger@example.com' });
  await addMember(h, o.id, acme.id, 'owner');
  await addMember(h, v.id, acme.id, 'viewer');
  await addMember(h, s.id, acme.id, 'sales');
  await addMember(h, stranger.id, other.id, 'owner');
  owner = await login(h, 'owner@example.com');
  viewer = await login(h, 'viewer@example.com');
  sales = await login(h, 'sales@example.com');
});

describe('REST v2 access control', () => {
  it('requires authentication', async () => {
    const res = await h.client().get(`${BASE}/contacts`);
    expect(res.status).toBe(401);
  });

  it('hides tenants the caller is not a member of (no enumeration)', async () => {
    const res = await owner.get('/api/v2/t/other/contacts');
    expect(res.status).toBe(404);
    expect(res.body['error']).toBe('tenant_not_found');
  });

  it('enforces per-route permissions by role', async () => {
    expect((await viewer.get(`${BASE}/contacts`)).status).toBe(200);
    const denied = await viewer.post(`${BASE}/contacts`, { given_name: 'Nope' });
    expect(denied.status).toBe(403);
    expect(denied.body['error']).toBe('forbidden');
    const settings = await sales.post(`${BASE}/customFields/contacts`, {
      key: 'x',
      label: 'X',
      type: 'TEXT',
    });
    expect(settings.status).toBe(403);
    expect((await sales.post(`${BASE}/contacts`, { given_name: 'Allowed' })).status).toBe(201);
  });
});

describe('REST v2 CRUD, errors and idempotency', () => {
  it('creates, reads, lists and validates contacts', async () => {
    const created = await owner.post(`${BASE}/contacts`, {
      given_name: 'Ada',
      family_name: 'Lovelace',
      emails: [{ email: 'ada@example.com' }],
    });
    expect(created.status).toBe(201);
    const id = String(created.body['id']);
    expect(created.body['emails']).toEqual([
      { email: 'ada@example.com', label: null, is_primary: true },
    ]);

    const fetched = await viewer.get(`${BASE}/contacts/${id}`);
    expect(fetched.body['family_name']).toBe('Lovelace');

    const list = await owner.get(`${BASE}/contacts?q=lovelace&limit=5`);
    expect(list.status).toBe(200);
    expect((list.body['data'] as Array<{ id: string }>).map((c) => c.id)).toEqual([id]);
    expect(list.body['next_cursor']).toBeNull();

    const invalid = await owner.post(`${BASE}/contacts`, {
      given_name: 'X',
      emails: [{ email: 'nope' }],
      extra: 1,
    });
    expect(invalid.status).toBe(422);
    expect(invalid.body['error']).toBe('validation_failed');
    expect(Array.isArray(invalid.body['details'])).toBe(true);

    const domain = await owner.post(`${BASE}/contacts`, {});
    expect(domain.status).toBe(422);
    expect(domain.body).toMatchObject({
      error: 'validation_failed',
      details: [{ path: 'given_name' }],
    });

    const missing = await owner.get(`${BASE}/contacts/01NOTFOUND`);
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({
      error: 'not_found',
      message: 'contact 01NOTFOUND not found',
    });
  });

  it('replays POSTs with the same Idempotency-Key and rejects key reuse with another body', async () => {
    const headers = { 'idempotency-key': 'create-grace-1' };
    const first = await owner.post(`${BASE}/contacts`, { given_name: 'Grace' }, headers);
    const second = await owner.post(`${BASE}/contacts`, { given_name: 'Grace' }, headers);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body['id']).toBe(first.body['id']);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    const list = await owner.get(`${BASE}/contacts?q=grace`);
    expect(list.body['data']).toHaveLength(1);

    const conflict = await owner.post(`${BASE}/contacts`, { given_name: 'Other' }, headers);
    expect(conflict.status).toBe(422);
    expect(conflict.body['error']).toBe('idempotency_conflict');
    // Keys are scoped per caller.
    const otherCaller = await sales.post(`${BASE}/contacts`, { given_name: 'Grace' }, headers);
    expect(otherCaller.body['id']).not.toBe(first.body['id']);
  });

  it('runs search, tags and saved searches end to end', async () => {
    const tag = await owner.post(`${BASE}/tags`, { name: 'VIP' });
    const contact = await owner.post(`${BASE}/contacts`, {
      given_name: 'Linus',
      tag_ids: [tag.body['id']],
    });
    const applied = await owner.post(`${BASE}/tags/${String(tag.body['id'])}/apply`, {
      contact_ids: [contact.body['id'], 'missing'],
    });
    expect(applied.body).toMatchObject({ changed: 0, missing_contact_ids: ['missing'] });

    const query = {
      entity: 'contact',
      filter: {
        type: 'group',
        op: 'and',
        conditions: [{ type: 'tags', match: 'all', tag_ids: [tag.body['id']] }],
      },
      columns: ['given_name', 'tags'],
    };
    const result = await viewer.post(`${BASE}/search`, query);
    expect(result.status).toBe(200);
    expect(result.body['data']).toEqual([
      { id: contact.body['id'], given_name: 'Linus', tags: [tag.body['id']] },
    ]);

    const saved = await owner.post(`${BASE}/savedSearches`, { name: 'VIPs', query });
    expect(saved.status).toBe(201);
    const executed = await viewer.post(
      `${BASE}/savedSearches/${String(saved.body['id'])}/execute`,
      {},
    );
    expect(executed.body['data']).toHaveLength(1);
    expect((await viewer.post(`${BASE}/savedSearches`, { name: 'x', query })).status).toBe(403);

    const global = await viewer.get(`${BASE}/search?q=linus`);
    expect(global.body).toMatchObject({
      mode: 'fts5',
      data: [{ type: 'contact', title: 'Linus' }],
    });
  });

  it('accepts API keys limited to their scopes', async () => {
    await stepUp(h, owner);
    const key = await owner.post('/api/t/acme/api-keys', {
      name: 'read only',
      scopes: ['contacts:read'],
    });
    expect(key.status).toBe(201);
    const bearer = { authorization: `Bearer ${String(key.body['key'])}` };
    const client = h.client();
    expect((await client.get(`${BASE}/contacts`, bearer)).status).toBe(200);
    expect((await client.post(`${BASE}/contacts`, { given_name: 'Nope' }, bearer)).status).toBe(
      403,
    );
    expect((await client.get('/api/v2/t/other/contacts', bearer)).status).toBe(404);
  });

  it('imports a streamed CSV', async () => {
    await owner.post(`${BASE}/customFields/contacts`, {
      key: 'plan',
      label: 'Plan',
      type: 'DROPDOWN',
      options: [
        { value: 'free', label: 'Free' },
        { value: 'pro', label: 'Pro' },
      ],
    });
    const job = await owner.post(`${BASE}/imports`, {
      entity: 'contact',
      mapping: { Nome: 'given_name', Email: 'email', Piano: 'custom.plan', Etichette: 'tags' },
    });
    expect(job.status).toBe(201);
    const csv =
      'Nome;Email;Piano;Etichette\nMario;mario@example.com;Pro;Webinar\nAnna;anna@example.com;Gold;\n';
    const response = await app.request(
      `${ORIGIN}${BASE}/imports/${String(job.body['id'])}/csv`,
      {
        method: 'PUT',
        headers: {
          origin: ORIGIN,
          'x-amable-csrf': '1',
          'content-type': 'text/csv',
          cookie: [...owner.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        },
        body: csv,
      },
      h.env,
    );
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: 'completed', total_rows: 2, created: 1, failed: 1 });
    const again = await owner.request('PUT', `${BASE}/imports/${String(job.body['id'])}/csv`, 'x');
    expect(again.status).toBe(409);
  });
});

describe('OpenAPI document', () => {
  it('is served at /api/v2/openapi.json and declares a permission on every operation', async () => {
    const res = await h.client().get('/api/v2/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body['openapi']).toBe('3.1.0');
    const paths = res.body['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const operations = Object.values(paths).flatMap((methods) => Object.values(methods));
    expect(operations.length).toBeGreaterThan(80);
    for (const operation of operations) {
      expect(typeof operation['x-amable-permission']).toBe('string');
      expect(operation['responses']).toHaveProperty('403');
    }
    expect(Object.keys(paths)).toEqual(
      expect.arrayContaining([
        '/contacts',
        '/contacts/{id}/merge',
        '/companies',
        '/tags/{id}/apply',
        '/customFields/{entity}',
        '/notes',
        '/tasks',
        '/appointments',
        '/calendar',
        '/opportunities',
        '/pipelines',
        '/savedSearches/{id}/execute',
        '/search',
        '/imports/{id}/csv',
      ]),
    );
  });
});
