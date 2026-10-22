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
import { fakeEditSessions } from '../helpers/edit-lock';
import { configureSender, fakeMailDbNamespace, sampleDoc, type MailWorld } from './helpers';

const BASE = '/api/v2/t/acme';

let h: Harness;
let owner: TestClient;
let marketer: TestClient;
let sales: TestClient;
let viewer: TestClient;
let world: MailWorld;
let contactId: string;
const sessions = fakeEditSessions();
let tenantId = '';
const userIds: Record<string, string> = {};

beforeAll(async () => {
  h = await createHarness();
  h.env.TENANT_DB = fakeTenantDbNamespace();
  const mail = fakeMailDbNamespace();
  h.env.MAIL_DB = mail.namespace;
  h.env.EDIT_SESSION = sessions.namespace;
  const acme = await seedTenant(h, 'acme');
  tenantId = acme.id;
  for (const role of ['owner', 'marketer', 'sales', 'viewer'] as const) {
    const user = await seedUser(h, { email: `${role}@acme.test` });
    userIds[role] = user.id;
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

  it('keeps templates and draft broadcasts read-only for everyone but the edit lock holder', async () => {
    const tpl = await marketer.post(`${BASE}/emailTemplates`, { name: 'Shared', subject: 'Hi', body: sampleDoc() });
    const tplId = String(tpl.body['id']);
    sessions.hold(`${tenantId}:templates:${tplId}`, userIds['owner'] ?? '', 'Owner');
    expect(await marketer.patch(`${BASE}/emailTemplates/${tplId}`, { name: 'X' })).toMatchObject({ status: 423, body: { error: 'locked' } });
    expect((await marketer.delete(`${BASE}/emailTemplates/${tplId}`)).status).toBe(423);
    expect((await marketer.get(`${BASE}/emailTemplates/${tplId}`)).status).toBe(200);
    expect((await owner.patch(`${BASE}/emailTemplates/${tplId}`, { name: 'Owner edit' })).status).toBe(200);
    expect((await viewer.get(`${BASE}/emailTemplates/${tplId}/lock/status`)).body).toMatchObject({ role: 'waiting', holder: { user_name: 'Owner' } });

    const tagId = world.crm.op('tags.list', { limit: 10 }).data.find((t) => t.name === 'News')?.id;
    const created = await marketer.post(`${BASE}/broadcasts`, {
      name: 'Shared',
      subject: 'Shared',
      body: sampleDoc(),
      segment: { type: 'tags', match: 'any', tag_ids: [tagId] },
    });
    const id = String(created.body['id']);
    sessions.hold(`${tenantId}:broadcasts:${id}`, userIds['owner'] ?? '', 'Owner');
    expect((await marketer.patch(`${BASE}/broadcasts/${id}`, { name: 'Y' })).status).toBe(423);
    expect((await marketer.post(`${BASE}/broadcasts/${id}/schedule`, { mode: 'now' })).status).toBe(423);
    expect((await marketer.delete(`${BASE}/broadcasts/${id}`)).status).toBe(423);
    expect((await marketer.get(`${BASE}/broadcasts/${id}/estimate`)).status).toBe(200);
    expect((await owner.post(`${BASE}/broadcasts/${id}/schedule`, { mode: 'at', at: '2099-01-01T09:00:00.000Z' })).status).toBe(200);
    // Operational actions on a scheduled broadcast never wait for the editor.
    expect((await marketer.post(`${BASE}/broadcasts/${id}/pause`)).status).toBe(200);
    expect((await marketer.post(`${BASE}/broadcasts/${id}/cancel`)).status).toBe(200);
  });

  it('only lets settings managers change sender settings', async () => {
    expect((await marketer.patch(`${BASE}/email/settings`, { from_name: 'X' })).status).toBe(403);
    const res = await owner.patch(`${BASE}/email/settings`, { timezone: 'Europe/Rome' });
    expect(res.status).toBe(200);
    expect(res.body['timezone']).toBe('Europe/Rome');
    expect((await owner.patch(`${BASE}/email/settings`, { timezone: 'Nowhere/Land' })).status).toBe(422);
  });
});
