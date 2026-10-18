import { ROLES, type Role } from '@amable/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formsGatewayHandlers } from '../../src/forms/gateway';
import { overrideFormsRuntime } from '../../src/forms/runtime';
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
import { collectWaits, gatewayCtx, inspectableTenantDb, leadDefinition, serviceAccountKey, useFormsFakes } from './helpers';

const BASE = '/api/v2/t/acme';

let h: Harness;
const clients = {} as Record<Role, TestClient>;
let formId = '';
let submissionId = '';

function expectByRole(results: Record<Role, number>, allowed: readonly Role[], ok: number) {
  const expected = Object.fromEntries(ROLES.map((role) => [role, allowed.includes(role) ? ok : 403]));
  expect(results).toEqual(expected);
}

async function forEachRole(fn: (client: TestClient, role: Role) => Promise<number>): Promise<Record<Role, number>> {
  const out = {} as Record<Role, number>;
  for (const role of ROLES) out[role] = await fn(clients[role], role);
  return out;
}

beforeAll(async () => {
  h = await createHarness();
  h.env.EDGE_ORIGIN = 'https://t.acme.example';
  const tenants = inspectableTenantDb();
  h.env.TENANT_DB = tenants.namespace;
  const acme = await seedTenant(h, 'acme');
  for (const role of ROLES) {
    const user = await seedUser(h, { email: `${role}@acme.test` });
    await addMember(h, user.id, acme.id, role);
    clients[role] = await login(h, user.email);
  }
  useFormsFakes();
  const created = await clients.owner.post(`${BASE}/forms`, { name: 'Contact us', definition: leadDefinition() });
  expect(created.status).toBe(201);
  formId = String(created.body['id']);
  const waits = collectWaits();
  const submitted = (await formsGatewayHandlers['forms.submit']?.(gatewayCtx(h.env, waits.ctx, acme), {
    formId,
    payload: { values: { first_name: 'Ada', email: 'ada@example.com' } },
  })) as { submission_id: string };
  await waits.flush();
  submissionId = submitted.submission_id;
});

afterAll(() => overrideFormsRuntime(null));

describe('forms REST v2 permissions by role', () => {
  it('lets every role but sales read forms; only owner, admin and marketer write them', async () => {
    expectByRole(
      await forEachRole(async (c) => (await c.get(`${BASE}/forms`)).status),
      ['owner', 'admin', 'marketer', 'analyst', 'viewer'],
      200,
    );
    expectByRole(
      await forEachRole(async (c, role) => (await c.post(`${BASE}/forms`, { name: `By ${role}` })).status),
      ['owner', 'admin', 'marketer'],
      201,
    );
    expectByRole(
      await forEachRole(async (c) => (await c.patch(`${BASE}/forms/${formId}`, { name: 'Contact us' })).status),
      ['owner', 'admin', 'marketer'],
      200,
    );
  });

  it('serves decrypted submissions to roles with forms:submissions_read', async () => {
    const results = await forEachRole(async (c) => {
      const res = await c.get(`${BASE}/forms/${formId}/submissions`);
      if (res.status === 200) {
        const [first] = res.body['data'] as Array<{ id: string; values: Record<string, unknown>; status: string }>;
        expect(first).toMatchObject({ id: submissionId, status: 'processed', values: { first_name: 'Ada', email: 'ada@example.com' } });
      }
      return res.status;
    });
    expectByRole(results, ['owner', 'admin', 'marketer', 'analyst', 'viewer'], 200);
    const one = await clients.viewer.get(`${BASE}/forms/${formId}/submissions/${submissionId}`);
    expect(one.body).toMatchObject({ contact_created: true, source: { country: 'IT', visitor_id: 'vis_cookie_12345' } });
    expect((await clients.viewer.delete(`${BASE}/forms/${formId}/submissions/${submissionId}`)).status).toBe(403);
  });

  it('restricts connection management and shows the webhook secret once', async () => {
    const fresh = await clients.owner.post(`${BASE}/forms/${formId}/connections`, {
      type: 'webhook',
      name: 'No step-up',
      config: { url: 'https://hooks.example.net/in' },
    });
    expect(fresh.status).toBe(403);
    expect(fresh.body['error']).toBe('step_up_required');
    for (const role of ROLES) await stepUp(h, clients[role]);
    expectByRole(
      await forEachRole(async (c, role) =>
        (await c.post(`${BASE}/forms/${formId}/connections`, {
          type: 'email_notification',
          name: `Notify ${role}`,
          config: { recipients: ['team@acme.test'] },
        })).status,
      ),
      ['owner', 'admin', 'marketer'],
      201,
    );
    const created = await clients.marketer.post(`${BASE}/forms/${formId}/connections`, {
      type: 'webhook',
      name: 'Zap',
      config: { url: 'https://hooks.example.net/in' },
    });
    expect(created.status).toBe(201);
    expect(String(created.body['signing_secret'])).toMatch(/^whsec_/);
    expect(created.body).toMatchObject({ has_secret: true, config: { method: 'POST', format: 'json' } });
    const list = await clients.viewer.get(`${BASE}/forms/${formId}/connections`);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(String(created.body['signing_secret']));
    const connectionId = String(created.body['id']);
    expect((await clients.viewer.post(`${BASE}/forms/${formId}/connections/${connectionId}/test`)).status).toBe(403);
    const test = await clients.admin.post(`${BASE}/forms/${formId}/connections/${connectionId}/test`);
    expect(test.body).toMatchObject({ status: 'success', status_code: 200 });

    // Stale step-up: toggles and renames pass, secrets and target config do not.
    h.clock.advance(10 * 60_000);
    const path = `${BASE}/forms/${formId}/connections/${connectionId}`;
    expect((await clients.marketer.patch(path, { enabled: false, name: 'Zap 2' })).status).toBe(200);
    expect((await clients.marketer.patch(path, { config: { url: 'https://evil.example.net/in' } })).body['error']).toBe('step_up_required');
    expect((await clients.marketer.post(`${path}/rotateSecret`)).body['error']).toBe('step_up_required');
    await stepUp(h, clients.marketer);
    const rotated = await clients.marketer.post(`${path}/rotateSecret`);
    expect(rotated.status).toBe(200);
    expect(String(rotated.body['signing_secret'])).not.toBe(String(created.body['signing_secret']));
    expect((await clients.marketer.patch(path, { config: { url: 'https://hooks.example.net/v2' } })).status).toBe(200);
    for (const role of ROLES) await stepUp(h, clients[role]);

    const invalid = await clients.owner.post(`${BASE}/forms/${formId}/connections`, {
      type: 'webhook',
      name: 'Bad',
      config: { url: 'ftp://nope' },
    });
    expect(invalid.status).toBe(422);
    const audits = await h.env.DB.prepare(`SELECT action FROM audit_log WHERE action LIKE 'forms.%'`).all<{ action: string }>();
    expect(audits.results.map((r) => r.action)).toEqual(
      expect.arrayContaining(['forms.form_created', 'forms.connection_created', 'forms.connection_tested']),
    );
  });

  it('stores the Google service account key and shows only its email', async () => {
    await stepUp(h, clients.owner);
    const path = `${BASE}/forms/${formId}/connections`;
    const config = { spreadsheet_id: 'sheet_ABCDEFGHIJK', sheet_name: 'Leads' };
    const missing = await clients.owner.post(path, { type: 'google_sheets', name: 'Sheet', config });
    expect(missing.status).toBe(422);
    const notAKey = await clients.owner.post(path, { type: 'google_sheets', name: 'Sheet', config, secret: '{"type":"authorized_user"}' });
    expect(notAKey.status).toBe(422);
    expect((notAKey.body['details'] as Array<{ path: string }>)[0]?.path).toBe('secret');

    const { json } = await serviceAccountKey('forms@acme-crm.iam.gserviceaccount.com');
    const created = await clients.owner.post(path, { type: 'google_sheets', name: 'Sheet', config, secret: json });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ has_secret: true, secret_hint: 'forms@acme-crm.iam.gserviceaccount.com', signing_secret: null });
    const list = await clients.viewer.get(path);
    expect(JSON.stringify(list.body)).not.toContain('PRIVATE KEY');

    const other = await serviceAccountKey('other@acme-crm.iam.gserviceaccount.com');
    const updated = await clients.owner.patch(`${path}/${String(created.body['id'])}`, { secret: other.json });
    expect(updated.body).toMatchObject({ secret_hint: 'other@acme-crm.iam.gserviceaccount.com' });
  });

  it('returns the embed snippet on the edge origin, duplicates and archives', async () => {
    const embed = await clients.analyst.get(`${BASE}/forms/${formId}/embed`);
    expect(embed.body).toMatchObject({
      hosted_url: `https://t.acme.example/f/acme/${formId}`,
      snippet: `<div data-amable-form="${formId}" data-amable-tenant="acme"></div>\n<script async src="https://t.acme.example/forms.js"></script>`,
    });
    const copy = await clients.marketer.post(`${BASE}/forms/${formId}/duplicate`, {});
    expect(copy.body).toMatchObject({ name: 'Contact us (copy)', status: 'inactive' });
    const archived = await clients.marketer.post(`${BASE}/forms/${String(copy.body['id'])}/archive`);
    expect(archived.body['archived']).toBe(true);
    const listed = await clients.viewer.get(`${BASE}/forms?status=archived`);
    expect((listed.body['data'] as Array<{ id: string }>).map((f) => f.id)).toEqual([copy.body['id']]);
    const catalog = await clients.viewer.get(`${BASE}/formConnectorTypes`);
    expect((catalog.body['data'] as Array<{ type: string }>).map((c) => c.type)).toEqual([
      'webhook',
      'google_sheets',
      'email_notification',
      'docuseal',
    ]);
  });

  it('validates definitions and erases submissions on delete', async () => {
    const bad = await clients.owner.patch(`${BASE}/forms/${formId}`, {
      definition: { fields: [{ id: 'a', kind: 'email', key: 'Bad Key' }] },
    });
    expect(bad.status).toBe(422);
    expect(String((bad.body['details'] as Array<{ path: string }>)[0]?.path)).toBe('definition.fields.0.key');
    const removed = await clients.marketer.delete(`${BASE}/forms/${formId}/submissions/${submissionId}`);
    expect(removed.status).toBe(200);
    expect((await clients.owner.get(`${BASE}/forms/${formId}/submissions/${submissionId}`)).status).toBe(404);
  });
});
