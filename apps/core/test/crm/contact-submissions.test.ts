import { ROLES, type Role } from '@amable/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formsGatewayHandlers } from '../../src/forms/gateway';
import { overrideFormsRuntime } from '../../src/forms/runtime';
import { fakeMailDbNamespace } from '../email/helpers';
import { collectWaits, gatewayCtx, inspectableTenantDb, leadDefinition, useFormsFakes } from '../forms/helpers';
import { edge, fakeEngineNamespace, goal, graph, seq } from '../automation/helpers';
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
import type { TestTenant } from './helpers';

const BASE = '/api/v2/t/acme';

type Row = Record<string, unknown>;

let h: Harness;
let acme: { id: string; slug: string };
let acmeDb: TestTenant;
let mail: ReturnType<typeof fakeMailDbNamespace>;
const clients = {} as Record<Role, TestClient>;
let other: TestClient;
let formId = '';
let contactId = '';
const submissionIds: string[] = [];

async function submit(values: Record<string, unknown>, pageUrl: string, pageId?: string): Promise<string> {
  const waits = collectWaits();
  const result = (await formsGatewayHandlers['forms.submit']?.(gatewayCtx(h.env, waits.ctx, acme), {
    formId,
    payload: {
      values: values as never,
      meta: { page_url: pageUrl, ...(pageId === undefined ? {} : { page_id: pageId }) },
    },
  })) as { submission_id: string };
  await waits.flush();
  return result.submission_id;
}

beforeAll(async () => {
  h = await createHarness();
  const tenants = inspectableTenantDb();
  h.env.TENANT_DB = tenants.namespace;
  mail = fakeMailDbNamespace();
  h.env.MAIL_DB = mail.namespace;
  h.env.ENGINE = fakeEngineNamespace(h.env.TENANT_DB, h.clock);
  acme = await seedTenant(h, 'acme');
  acmeDb = tenants.tenant(acme.id);
  const globex = await seedTenant(h, 'globex');
  for (const role of ROLES) {
    const user = await seedUser(h, { email: `${role}@acme.test` });
    await addMember(h, user.id, acme.id, role);
    clients[role] = await login(h, user.email);
  }
  const outsider = await seedUser(h, { email: 'owner@globex.test' });
  await addMember(h, outsider.id, globex.id, 'owner');
  other = await login(h, 'owner@globex.test');
  useFormsFakes();

  const definition = leadDefinition();
  const created = await clients.owner.post(`${BASE}/forms`, { name: 'Contact us', definition });
  formId = String(created.body['id']);
  acmeDb.db.run(
    `INSERT INTO page_pages (id, title, path, draft, created_at, updated_at) VALUES ('pg_1', 'Spring launch', '/spring', '{}', 0, 0)`,
  );
  for (let i = 0; i < 30; i++) {
    h.clock.now += 1000;
    submissionIds.push(
      await submit(
        { first_name: 'Ada', email: 'ada@example.com', notes: `secret plan ${String(i)}` },
        `https://www.example.com/p${String(i)}`,
        i === 29 ? 'pg_1' : undefined,
      ),
    );
  }
  const processed = acmeDb.db.all<{ contact_id: string }>(
    `SELECT contact_id FROM form_submissions WHERE id = ?`,
    submissionIds[0] ?? '',
  )[0];
  contactId = processed?.contact_id ?? '';
});

afterAll(() => overrideFormsRuntime(null));

describe('GET /contacts/{id}/submissions', () => {
  it('pages through every submission of the contact, newest first, metadata only', async () => {
    const seen: Row[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor === null ? '' : `&cursor=${cursor}`;
      const res = await clients.viewer.get(`${BASE}/contacts/${contactId}/submissions?limit=12${query}`);
      expect(res.status).toBe(200);
      seen.push(...(res.body['data'] as Row[]));
      cursor = res.body['next_cursor'] as string | null;
      pages += 1;
    } while (cursor !== null);
    expect(pages).toBe(3);
    expect(seen.map((s) => s['id'])).toEqual([...submissionIds].reverse());
    expect(seen[0]).toEqual({
      id: submissionIds[29],
      form_id: formId,
      form_name: 'Contact us',
      form_deleted: false,
      status: 'processed',
      contact_created: false,
      page_url: 'https://www.example.com/p29',
      page_id: 'pg_1',
      page_title: 'Spring launch',
      created_at: expect.any(String),
      processed_at: expect.any(String),
    });
    expect(seen.at(-1)?.['contact_created']).toBe(true);
    expect(JSON.stringify(seen)).not.toContain('secret plan');

    const plan = acmeDb.db.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN SELECT id FROM form_submissions WHERE contact_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, id DESC`,
      contactId,
    );
    expect(plan.map((p) => p.detail).join(' ')).toContain('form_submissions_contact_created');

    expect((await clients.viewer.get(`${BASE}/contacts/${contactId}/submissions?limit=101`)).status).toBe(422);
    expect((await clients.viewer.get(`${BASE}/contacts/01JZZZZZZZZZZZZZZZZZZZZZZZ/submissions`)).status).toBe(404);
  });

  it('is readable with forms:read only; the decrypted detail needs forms:submissions_read', async () => {
    const list: Record<string, number> = {};
    const detail: Record<string, number> = {};
    for (const role of ROLES) {
      list[role] = (await clients[role].get(`${BASE}/contacts/${contactId}/submissions`)).status;
      detail[role] = (
        await clients[role].get(`${BASE}/contacts/${contactId}/submissions/${submissionIds[0] ?? ''}`)
      ).status;
    }
    const expected = { owner: 200, admin: 200, marketer: 200, sales: 403, analyst: 200, viewer: 200 };
    expect(list).toEqual(expected);
    expect(detail).toEqual(expected);

    await stepUp(h, clients.owner);
    const key = await clients.owner.post('/api/t/acme/api-keys', { name: 'forms only', scopes: ['forms:read'] });
    const viaKey = await h.client().request('GET', `${BASE}/contacts/${contactId}/submissions`, undefined, {
      authorization: `Bearer ${String(key.body['key'])}`,
    });
    expect(viaKey.status).toBe(403);

    const doc = await h.client().get('/api/v2/openapi/publishing.json');
    const paths = doc.body['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    expect(paths['/contacts/{id}/submissions']?.['get']?.['x-amable-permission']).toBe('forms:read');
    expect(paths['/contacts/{id}/submissions/{submissionId}']?.['get']?.['x-amable-permission']).toBe(
      'forms:submissions_read',
    );
  });

  it('decrypts the values in field order and masks sensitive ones without contacts:read_sensitive', async () => {
    const path = `${BASE}/contacts/${contactId}/submissions/${submissionIds[3] ?? ''}`;
    const owner = await clients.owner.get(path);
    expect(owner.status).toBe(200);
    expect(owner.body['entries']).toEqual([
      { key: 'first_name', label: 'First name', value: 'Ada', masked: false },
      { key: 'email', label: 'Email', value: 'ada@example.com', masked: false },
      { key: 'notes', label: 'Notes', value: 'secret plan 3', masked: false },
    ]);
    expect(owner.body['form_name']).toBe('Contact us');

    const viewer = await clients.viewer.get(path);
    const notes = (viewer.body['entries'] as Row[]).find((e) => e['key'] === 'notes');
    expect(notes).toEqual({ key: 'notes', label: 'Notes', value: '*********an 3', masked: true });
    expect(JSON.stringify(viewer.body)).not.toContain('secret plan');
  });

  it('keeps tenants apart', async () => {
    expect((await other.get(`/api/v2/t/globex/contacts/${contactId}/submissions`)).status).toBe(404);
    expect(
      (await other.get(`/api/v2/t/globex/contacts/${contactId}/submissions/${submissionIds[0] ?? ''}`)).status,
    ).toBe(404);
    expect((await other.get(`${BASE}/contacts/${contactId}/submissions`)).status).toBe(404);
    const stranger = await clients.owner.post(`${BASE}/contacts`, { given_name: 'Stranger' });
    expect(
      (
        await clients.owner.get(
          `${BASE}/contacts/${String(stranger.body['id'])}/submissions/${submissionIds[0] ?? ''}`,
        )
      ).status,
    ).toBe(404);
  });
});

describe('GET /contacts/{id}/counts across Durable Objects', () => {
  async function publishedAutomation(name: string): Promise<string> {
    const created = await clients.owner.post(`${BASE}/automations`, { name });
    const id = String(created.body['id']);
    const draft = graph(
      [
        goal('g', [{ type: 'api', call_name: `go_${name.toLowerCase()}` }]),
        seq('s', [{ id: 'wait', type: 'delay', duration: { amount: 1, unit: 'days' } }]),
      ],
      [edge('g', 's')],
    );
    expect(
      (await clients.owner.request('PUT', `${BASE}/automations/${id}/draft`, { graph: draft, revision: 1 })).status,
    ).toBe(200);
    expect((await clients.owner.post(`${BASE}/automations/${id}/publish`)).status).toBe(200);
    return id;
  }

  it('adds submissions, emails and active/total enrollments, by permission', async () => {
    await clients.owner.get(`${BASE}/contacts/${contactId}/emails`);
    const world = [...mail.worlds.values()][0];
    if (world === undefined) throw new Error('mail world missing');
    for (let i = 0; i < 3; i++) {
      world.deps.db.run(
        `INSERT INTO mail_messages (id, request_id, contact_id, status, source_type, created_at, updated_at)
         VALUES (?, ?, ?, 'sent', 'single', ?, ?)`,
        `msg_${String(i)}`,
        `req_${String(i)}`,
        contactId,
        i,
        i,
      );
    }
    world.deps.db.run(
      `INSERT INTO mail_messages (id, request_id, contact_id, status, source_type, created_at, updated_at)
       VALUES ('msg_x', 'req_x', 'someone_else', 'sent', 'single', 0, 0)`,
    );
    const first = await publishedAutomation('First');
    const second = await publishedAutomation('Second');
    for (const id of [first, second]) {
      expect((await clients.owner.post(`${BASE}/automations/${id}/enrollments`, { contact_id: contactId })).status).toBe(201);
    }
    expect((await clients.owner.delete(`${BASE}/automations/${second}/contacts/${contactId}`)).status).toBe(200);

    const owner = await clients.owner.get(`${BASE}/contacts/${contactId}/counts`);
    expect(owner.status).toBe(200);
    expect(owner.body).toMatchObject({ submissions: 30, emails: 3, automations_active: 1, automations_total: 2 });

    const sales = await clients.sales.get(`${BASE}/contacts/${contactId}/counts`);
    expect(sales.body['submissions']).toBeUndefined();
    expect(sales.body).toMatchObject({ emails: 3, automations_active: 1, automations_total: 2 });

    await stepUp(h, clients.owner);
    const key = await clients.owner.post('/api/t/acme/api-keys', { name: 'contacts', scopes: ['contacts:read'] });
    const viaKey = await h.client().request('GET', `${BASE}/contacts/${contactId}/counts`, undefined, {
      authorization: `Bearer ${String(key.body['key'])}`,
    });
    expect(viaKey.body).toEqual({ tags: 0, notes: 0, emails: 3 });
  });

  it('omits the counts of a Durable Object that fails instead of failing the response', async () => {
    const mailDb = h.env.MAIL_DB;
    const engine = h.env.ENGINE;
    const broken = {
      idFromName: (name: string) => name,
      get: () => ({
        mail: () => Promise.reject(new Error('mail store down')),
        automation: () => Promise.reject(new Error('engine down')),
      }),
    };
    h.env.MAIL_DB = broken as unknown as typeof mailDb;
    h.env.ENGINE = broken as unknown as typeof engine;
    try {
      const res = await clients.owner.get(`${BASE}/contacts/${contactId}/counts`);
      expect(res.status).toBe(200);
      expect(res.body['submissions']).toBe(30);
      expect(res.body).not.toHaveProperty('emails');
      expect(res.body).not.toHaveProperty('automations_active');
      expect(res.body).not.toHaveProperty('automations_total');
    } finally {
      h.env.MAIL_DB = mailDb;
      h.env.ENGINE = engine;
    }
  });
});
