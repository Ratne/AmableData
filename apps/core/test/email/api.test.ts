import { roleHasPermission } from '@amable/core';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  createHarness,
  login,
  seedTenant,
  seedUser,
  type Harness,
  type TestClient,
} from '../helpers/harness';
import { fakeTenantDbNamespace } from '../crm/helpers';
import { configureSender, fakeMailDbNamespace, sampleDoc, type MailWorld } from './helpers';

const BASE = '/api/v2/t/acme';

let h: Harness;
let owner: TestClient;
let marketer: TestClient;
let sales: TestClient;
let viewer: TestClient;
let world: MailWorld;
let contactId: string;

beforeAll(async () => {
  h = await createHarness();
  h.env.TENANT_DB = fakeTenantDbNamespace();
  const mail = fakeMailDbNamespace();
  h.env.MAIL_DB = mail.namespace;
  const acme = await seedTenant(h, 'acme');
  for (const role of ['owner', 'marketer', 'sales', 'viewer'] as const) {
    const user = await seedUser(h, { email: `${role}@acme.test` });
    await addMember(h, user.id, acme.id, role);
  }
  owner = await login(h, 'owner@acme.test');
  marketer = await login(h, 'marketer@acme.test');
  sales = await login(h, 'sales@acme.test');
  viewer = await login(h, 'viewer@acme.test');
  mail.namespace.get(mail.namespace.idFromName(acme.id));
  const w = mail.worlds.get(acme.id);
  if (w === undefined) throw new Error('mail world missing');
  world = w;
  await configureSender(world);
  contactId = world.contact({ email: 'lead@example.com', tags: ['News'] });
});

describe('email permissions (role matrix)', () => {
  it('marketers send broadcasts; sales only single emails; viewers read', () => {
    expect(roleHasPermission('marketer', 'broadcasts:send')).toBe(true);
    expect(roleHasPermission('marketer', 'suppressions:write')).toBe(true);
    expect(roleHasPermission('sales', 'broadcasts:send')).toBe(false);
    expect(roleHasPermission('sales', 'broadcasts:write')).toBe(false);
    expect(roleHasPermission('sales', 'emails:send_single')).toBe(true);
    expect(roleHasPermission('viewer', 'broadcasts:read')).toBe(true);
    expect(roleHasPermission('viewer', 'suppressions:write')).toBe(false);
    expect(roleHasPermission('analyst', 'templates:write')).toBe(false);
  });
});

describe('email REST v2', () => {
  it('enforces permissions on templates, broadcasts, suppressions and single emails', async () => {
    expect((await h.client().get(`${BASE}/broadcasts`)).status).toBe(401);
    expect((await viewer.get(`${BASE}/broadcasts`)).status).toBe(200);
    expect((await viewer.post(`${BASE}/emailTemplates`, { name: 'x', body: { type: 'doc' } })).status).toBe(403);
    expect((await viewer.post(`${BASE}/suppressions`, { email: 'a@b.test' })).status).toBe(403);
    expect((await sales.post(`${BASE}/broadcasts`, { name: 'Nope' })).status).toBe(403);

    const tpl = await marketer.post(`${BASE}/emailTemplates`, { name: 'Welcome', subject: 'Hi', body: sampleDoc() });
    expect(tpl.status).toBe(201);
    expect(tpl.body['compiled']).toBe(true);

    const single = await sales.post(`${BASE}/contacts/${contactId}/emails`, { template_id: tpl.body['id'] });
    expect(single.status).toBe(202);
    expect(world.queue.at(-1)).toMatchObject({ contactId, source: { type: 'single' } });

    const created = await marketer.post(`${BASE}/broadcasts`, {
      name: 'Launch',
      template_id: tpl.body['id'],
      segment: { type: 'saved_search', saved_search_id: 'missing' },
    });
    expect(created.status).toBe(201);
    const id = String(created.body['id']);
    expect((await sales.post(`${BASE}/broadcasts/${id}/schedule`, { mode: 'now' })).status).toBe(403);
    expect((await viewer.post(`${BASE}/broadcasts/${id}/cancel`, {})).status).toBe(403);
    expect((await viewer.get(`${BASE}/broadcasts/${id}/stats`)).status).toBe(200);
  });

  it('schedules with the right role and reports blocking problems as errors', async () => {
    const tagId = world.crm.op('tags.list', { limit: 10 }).data.find((t) => t.name === 'News')?.id;
    const created = await marketer.post(`${BASE}/broadcasts`, {
      name: 'News',
      subject: 'News',
      body: sampleDoc(),
      segment: { type: 'tags', match: 'any', tag_ids: [tagId] },
    });
    const id = String(created.body['id']);
    const estimate = await marketer.get(`${BASE}/broadcasts/${id}/estimate`);
    expect(estimate.body).toMatchObject({ eligible: 1, can_send: true });
    const bad = await marketer.post(`${BASE}/broadcasts/${id}/schedule`, { mode: 'later' });
    expect(bad.status).toBe(422);
    const ok = await marketer.post(`${BASE}/broadcasts/${id}/schedule`, { mode: 'now' });
    expect(ok.status).toBe(200);
    expect(ok.body['buckets']).toHaveLength(1);
    const again = await owner.post(`${BASE}/broadcasts/${id}/schedule`, { mode: 'now' });
    expect(again.status).toBe(409);
    expect(again.body['error']).toBe('conflict');
  });

  it('only lets settings managers change sender settings', async () => {
    expect((await marketer.patch(`${BASE}/email/settings`, { from_name: 'X' })).status).toBe(403);
    const res = await owner.patch(`${BASE}/email/settings`, { timezone: 'Europe/Rome' });
    expect(res.status).toBe(200);
    expect(res.body['timezone']).toBe('Europe/Rome');
    expect((await owner.patch(`${BASE}/email/settings`, { timezone: 'Nowhere/Land' })).status).toBe(422);
  });
});
