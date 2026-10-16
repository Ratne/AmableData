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
let marketer: TestClient;
let sales: TestClient;
let viewer: TestClient;

beforeAll(async () => {
  h = await createHarness();
  h.env.TENANT_DB = fakeTenantDbNamespace();
  h.env.ENGINE = fakeEngineNamespace(h.env.TENANT_DB, h.clock);
  const acme = await seedTenant(h, 'acme');
  const users = {
    owner: await seedUser(h, { email: 'owner@example.com' }),
    marketer: await seedUser(h, { email: 'marketer@example.com' }),
    sales: await seedUser(h, { email: 'sales@example.com' }),
    viewer: await seedUser(h, { email: 'viewer@example.com' }),
  };
  await addMember(h, users.owner.id, acme.id, 'owner');
  await addMember(h, users.marketer.id, acme.id, 'marketer');
  await addMember(h, users.sales.id, acme.id, 'sales');
  await addMember(h, users.viewer.id, acme.id, 'viewer');
  owner = await login(h, 'owner@example.com');
  marketer = await login(h, 'marketer@example.com');
  sales = await login(h, 'sales@example.com');
  viewer = await login(h, 'viewer@example.com');
});

describe('automation REST v2', () => {
  it('creates, saves, publishes and reports through the API with per-role permissions', async () => {
    const tag = await owner.post(`${BASE}/tags`, { name: 'Lead' });
    const tagId = String(tag.body['id']);
    const created = await marketer.post(`${BASE}/automations`, { name: 'Welcome' });
    expect(created.status).toBe(201);
    const id = String(created.body['id']);
    expect(created.body['status']).toBe('draft');

    expect((await viewer.get(`${BASE}/automations`)).status).toBe(200);
    expect((await viewer.post(`${BASE}/automations`, { name: 'x' })).status).toBe(403);

    const draft = graph(
      [
        goal('g', [{ type: 'tag_applied', tag_ids: [tagId] }]),
        goal('api', [{ type: 'api', call_name: 'signup' }]),
        seq('s', []),
      ],
      [edge('g', 's'), edge('api', 's')],
    );
    const saved = await marketer.request('PUT', `${BASE}/automations/${id}/draft`, {
      graph: draft,
      revision: 1,
    });
    expect(saved.status).toBe(200);
    expect(saved.body['draft_revision']).toBe(2);
    const stale = await marketer.request('PUT', `${BASE}/automations/${id}/draft`, {
      graph: draft,
      revision: 1,
    });
    expect(stale.status).toBe(409);
    const strict = await marketer.request('PUT', `${BASE}/automations/${id}/draft`, {
      graph: { ...draft, extra: 1 },
      revision: 2,
    });
    expect(strict.status).toBe(422);

    expect((await sales.post(`${BASE}/automations/${id}/publish`)).status).toBe(403);
    const published = await marketer.post(`${BASE}/automations/${id}/publish`);
    expect(published.status).toBe(200);
    expect(published.body['automation']).toMatchObject({
      status: 'active',
      has_unpublished_changes: false,
    });

    const contact = await owner.post(`${BASE}/contacts`, { given_name: 'Ada' });
    const contactId = String(contact.body['id']);
    expect(
      (await viewer.post(`${BASE}/automationGoals/signup/trigger`, { contact_id: contactId }))
        .status,
    ).toBe(403);
    const fired = await sales.post(`${BASE}/automationGoals/signup/trigger`, {
      contact_id: contactId,
    });
    expect(fired.status).toBe(200);
    expect(fired.body['matched']).toEqual([{ automation_id: id, node_id: 'api' }]);

    const enrollments = await viewer.get(`${BASE}/automations/${id}/enrollments`);
    expect(enrollments.status).toBe(200);
    expect(enrollments.body['data']).toEqual([
      expect.objectContaining({
        contact_id: contactId,
        status: 'active',
        positions: [expect.objectContaining({ node_id: 's', status: 'scheduled' })],
      }),
    ]);
    const stats = await viewer.get(`${BASE}/automations/${id}/stats`);
    expect(stats.body['nodes']).toEqual(
      expect.arrayContaining([expect.objectContaining({ node_id: 'api', entered: 1 })]),
    );

    expect((await marketer.delete(`${BASE}/automations/${id}`)).status).toBe(409);
    expect((await marketer.post(`${BASE}/automations/${id}/unpublish`)).status).toBe(200);
    expect((await marketer.delete(`${BASE}/automations/${id}`)).status).toBe(200);
    expect((await viewer.get(`${BASE}/automations/${id}`)).status).toBe(404);
  });

  it('rejects publishing an invalid draft with the validation issues', async () => {
    const created = await marketer.post(`${BASE}/automations`, {
      name: 'Broken',
      graph: graph([seq('s', [])], []),
    });
    const res = await marketer.post(`${BASE}/automations/${String(created.body['id'])}/publish`);
    expect(res.status).toBe(422);
    expect(res.body['error']).toBe('validation_failed');
    expect(JSON.stringify(res.body['details'])).toContain('no_entry_goal');
  });

  it('only settings managers change the tenant time zone', async () => {
    expect(
      (await marketer.request('PUT', `${BASE}/automationSettings`, { time_zone: 'Europe/Rome' }))
        .status,
    ).toBe(403);
    const res = await owner.request('PUT', `${BASE}/automationSettings`, {
      time_zone: 'Europe/Rome',
    });
    expect(res.body).toEqual({ time_zone: 'Europe/Rome' });
    expect((await viewer.get(`${BASE}/automationSettings`)).body).toEqual({
      time_zone: 'Europe/Rome',
    });
  });

  it('reveals and rotates the HTTP signing secret only after a step-up (sessions); API keys pass', async () => {
    const created = await marketer.post(`${BASE}/automations`, { name: 'Signed' });
    const id = String(created.body['id']);
    h.clock.advance(10 * 60_000);
    const stale = await marketer.get(`${BASE}/automations/${id}/signing-secret`);
    expect(stale.status).toBe(403);
    expect(stale.body['error']).toBe('step_up_required');
    expect((await marketer.post(`${BASE}/automations/${id}/signing-secret/rotate`)).body['error']).toBe('step_up_required');
    await stepUp(h, marketer);
    const revealed = await marketer.get(`${BASE}/automations/${id}/signing-secret`);
    expect(revealed.status).toBe(200);
    const rotated = await marketer.post(`${BASE}/automations/${id}/signing-secret/rotate`);
    expect(rotated.status).toBe(200);
    expect(rotated.body['secret']).not.toBe(revealed.body['secret']);

    await stepUp(h, owner);
    const key = await owner.post('/api/t/acme/api-keys', { name: 'ci', scopes: ['automations:publish'] });
    expect(key.status).toBe(201);
    h.clock.advance(10 * 60_000);
    const viaKey = await h.client().request('GET', `${BASE}/automations/${id}/signing-secret`, undefined, {
      authorization: `Bearer ${String(key.body['key'])}`,
    });
    expect(viaKey.status).toBe(200);
  });

  it('documents every automation route with its permission', async () => {
    const res = await h.client().get('/api/v2/openapi.json');
    const paths = res.body['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const automation = Object.entries(paths).filter(([path]) => path.includes('utomation'));
    expect(automation.length).toBeGreaterThanOrEqual(15);
    for (const [, operations] of automation) {
      for (const operation of Object.values(operations)) {
        expect(String(operation['x-amable-permission'])).toMatch(/^(automations|settings):/);
      }
    }
  });
});
