import type { GraphNode } from '@amable/api-types';
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
import { fakeTenantDbNamespace } from '../crm/helpers';
import { edge, fakeEngineNamespace, goal, graph, seq } from './helpers';

const BASE = '/api/v2/t/acme';

let h: Harness;
let owner: TestClient;
let viewer: TestClient;

beforeAll(async () => {
  h = await createHarness();
  h.env.TENANT_DB = fakeTenantDbNamespace();
  h.env.ENGINE = fakeEngineNamespace(h.env.TENANT_DB, h.clock);
  const acme = await seedTenant(h, 'acme');
  const o = await seedUser(h, { email: 'owner@example.com' });
  const v = await seedUser(h, { email: 'viewer@example.com' });
  await addMember(h, o.id, acme.id, 'owner');
  await addMember(h, v.id, acme.id, 'viewer');
  owner = await login(h, 'owner@example.com');
  viewer = await login(h, 'viewer@example.com');
});

function labelled(node: GraphNode, label: string): GraphNode {
  return node.type === 'goal' ? { ...node, label } : node;
}

async function publishedAutomation(name: string): Promise<string> {
  const created = await owner.post(`${BASE}/automations`, { name });
  const id = String(created.body['id']);
  const draft = graph(
    [
      labelled(goal('g', [{ type: 'api', call_name: `go_${name.toLowerCase()}` }]), 'Start'),
      seq('s', [{ id: 'wait', type: 'delay', duration: { amount: 1, unit: 'days' } }]),
    ],
    [edge('g', 's')],
  );
  expect(
    (await owner.request('PUT', `${BASE}/automations/${id}/draft`, { graph: draft, revision: 1 }))
      .status,
  ).toBe(200);
  expect((await owner.post(`${BASE}/automations/${id}/publish`)).status).toBe(200);
  return id;
}

describe('GET /contacts/{id}/automations', () => {
  it('lists current and past enrollments of a contact, paginated, with positions and outcome', async () => {
    const contact = await owner.post(`${BASE}/contacts`, { given_name: 'Ada' });
    const contactId = String(contact.body['id']);
    const other = await owner.post(`${BASE}/contacts`, { given_name: 'Bob' });
    const ids = [];
    for (const name of ['Alpha', 'Beta', 'Gamma']) {
      const id = await publishedAutomation(name);
      ids.push(id);
      const enrolled = await owner.post(`${BASE}/automations/${id}/enrollments`, {
        contact_id: contactId,
      });
      expect(enrolled.status).toBe(201);
    }
    await owner.post(`${BASE}/automations/${ids[0] ?? ''}/enrollments`, {
      contact_id: String(other.body['id']),
    });
    const removed = await owner.delete(`${BASE}/automations/${ids[0] ?? ''}/contacts/${contactId}`);
    expect(removed.body['removed']).toBe(true);

    const first = await viewer.get(`${BASE}/contacts/${contactId}/automations?limit=1`);
    expect(first.status).toBe(200);
    const page1 = first.body['data'] as Array<Record<string, unknown>>;
    expect(page1).toHaveLength(1);
    expect(page1[0]).toMatchObject({
      automation_id: ids[2],
      automation_name: 'Gamma',
      automation_status: 'active',
      version_number: 1,
      status: 'active',
      source: 'manual',
      ended_at: null,
      goals_reached: [expect.objectContaining({ node_id: 'g', node_label: 'Start' })],
      positions: [
        expect.objectContaining({
          node_id: 's',
          node_type: 'sequence',
          step_id: 'wait',
          step_type: 'delay',
          status: 'scheduled',
        }),
      ],
    });
    const cursor = first.body['next_cursor'];
    expect(typeof cursor).toBe('string');
    const second = await viewer.get(
      `${BASE}/contacts/${contactId}/automations?limit=1&cursor=${String(cursor)}`,
    );
    expect((second.body['data'] as Array<Record<string, unknown>>).map((e) => e['automation_name'])).toEqual(['Beta']);
    expect(second.body['next_cursor']).toBeNull();

    const history = await viewer.get(`${BASE}/contacts/${contactId}/automations?scope=history`);
    expect(history.body['data']).toEqual([
      expect.objectContaining({
        automation_name: 'Alpha',
        status: 'removed',
        outcome: 'removed manually',
        ended_at: expect.any(String),
        positions: [],
      }),
    ]);
    expect(history.body['next_cursor']).toBeNull();

    const nobody = await viewer.get(`${BASE}/contacts/${String(other.body['id'])}/automations`);
    expect((nobody.body['data'] as unknown[]).length).toBe(1);
  });

  it('keeps more than 100 enrollments pageable (chunked IN lists)', async () => {
    const contact = await owner.post(`${BASE}/contacts`, { given_name: 'Many' });
    const contactId = String(contact.body['id']);
    const id = await publishedAutomation('Loop');
    for (let i = 0; i < 101; i++) {
      await owner.post(`${BASE}/automations/${id}/enrollments`, { contact_id: contactId });
      await owner.delete(`${BASE}/automations/${id}/contacts/${contactId}`);
    }
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const query: string = cursor === null ? '' : `&cursor=${cursor}`;
      const res = await viewer.get(
        `${BASE}/contacts/${contactId}/automations?scope=history&limit=100${query}`,
      );
      expect(res.status).toBe(200);
      for (const e of res.body['data'] as Array<Record<string, unknown>>) seen.add(String(e['id']));
      cursor = res.body['next_cursor'] as string | null;
    } while (cursor !== null);
    expect(seen.size).toBe(101);
  });

  it('requires automations:read and declares it in the OpenAPI document', async () => {
    const contact = await owner.post(`${BASE}/contacts`, { given_name: 'Key' });
    const path = `${BASE}/contacts/${String(contact.body['id'])}/automations`;
    expect((await h.client().get(path)).status).toBe(401);

    await stepUp(h, owner);
    const crmOnly = await owner.post('/api/t/acme/api-keys', { name: 'crm', scopes: ['contacts:read'] });
    const auto = await owner.post('/api/t/acme/api-keys', { name: 'auto', scopes: ['automations:read'] });
    const viaKey = (key: Record<string, unknown>) =>
      h.client().request('GET', path, undefined, { authorization: `Bearer ${String(key['key'])}` });
    expect((await viaKey(crmOnly.body)).status).toBe(403);
    expect((await viaKey(auto.body)).status).toBe(200);
    expect((await viewer.get(`${path}?limit=500`)).status).toBe(422);

    const doc = await h.client().get('/api/v2/openapi.json');
    const paths = doc.body['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    expect(paths['/contacts/{id}/automations']?.['get']?.['x-amable-permission']).toBe(
      'automations:read',
    );
  });
});

describe('GET /automations?q=', () => {
  it('searches active automations by name, paginated, with wildcards matched literally', async () => {
    const ids: string[] = [];
    const named = async (name: string, slug: string) => {
      const id = await publishedAutomation(slug);
      expect((await owner.patch(`${BASE}/automations/${id}`, { name })).status).toBe(200);
      return id;
    };
    for (let i = 0; i < 7; i++) ids.push(await named(`Nurture ${String(i)}`, `Nurture${String(i)}`));
    await named('Onboarding 100%', 'Onboarding');
    const draft = await owner.post(`${BASE}/automations`, { name: 'Nurture draft' });
    expect(draft.status).toBe(201);

    const names: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor === null ? '' : `&cursor=${cursor}`;
      const res = await viewer.get(`${BASE}/automations?status=active&q=nurTURE&limit=3${query}`);
      expect(res.status).toBe(200);
      names.push(...(res.body['data'] as Array<Record<string, unknown>>).map((a) => String(a['name'])));
      cursor = res.body['next_cursor'] as string | null;
    } while (cursor !== null);
    expect(names).toEqual(ids.map((_, i) => `Nurture ${String(6 - i)}`));

    const all = await viewer.get(`${BASE}/automations?q=nurture&limit=50`);
    expect((all.body['data'] as unknown[]).length).toBe(8);
    const percent = await viewer.get(`${BASE}/automations?q=${encodeURIComponent('0%')}`);
    expect((percent.body['data'] as Array<Record<string, unknown>>).map((a) => a['name'])).toEqual([
      'Onboarding 100%',
    ]);
    const underscore = await viewer.get(`${BASE}/automations?q=_`);
    expect(underscore.body['data']).toEqual([]);
    expect((await viewer.get(`${BASE}/automations?q=${'x'.repeat(201)}`)).status).toBe(422);
  });
});
