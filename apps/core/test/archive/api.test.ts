import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { archiveTenant, type ArchiveDeps } from '../../src/archive/scheduler';
import type { ArchiveDb } from '../../src/archive/model';
import type { ArchiveDoStub } from '../../src/archive/scheduler';
import { formsGatewayHandlers } from '../../src/forms/gateway';
import { overrideFormsRuntime } from '../../src/forms/runtime';
import type { Env } from '../../src/env';
import { FakeR2 } from '../backup/helpers';
import { fakeEditSessions } from '../helpers/edit-lock';
import { addMember, createHarness, login, seedTenant, seedUser, stepUp, type Harness, type TestClient } from '../helpers/harness';
import { collectWaits, gatewayCtx, inspectableTenantDb, leadDefinition, useFormsFakes } from '../forms/helpers';

const BASE = '/api/v2/t/acme';
const OLD = Date.UTC(2023, 4, 10);

let h: Harness;
let owner: TestClient;
let sales: TestClient;
let other: TestClient;
let tenants: ReturnType<typeof inspectableTenantDb>;
let r2: FakeR2;
let tenantId = '';
let contactId = '';
let formId = '';
let submissionId = '';

function archiveDepsFor(env: Env): ArchiveDeps {
  return {
    bucket: r2.asBucket(),
    db: env.DB,
    stub: (id: string, db: ArchiveDb) =>
      db === 'tenant_db'
        ? (env.TENANT_DB.get(env.TENANT_DB.idFromName(id)) as unknown as ArchiveDoStub)
        : { archive: (op) => Promise.resolve({ ok: true as const, value: op === 'purgeOutbox' ? { deleted: 0 } : [] }) },
    now: () => Date.now(),
  };
}

beforeAll(async () => {
  h = await createHarness();
  r2 = new FakeR2();
  h.env.FILES = r2.asBucket();
  h.env.EDGE_ORIGIN = 'https://t.acme.example';
  tenants = inspectableTenantDb();
  h.env.TENANT_DB = tenants.namespace;
  h.env.EDIT_SESSION = fakeEditSessions().namespace;
  h.env.MAIL_DB = {
    idFromName: (name: string) => name,
    get: () => ({ archive: () => Promise.resolve({ ok: true, value: [] }), storageInfo: () => Promise.resolve({ bytes: 8 * 1024 ** 3 }) }),
  } as unknown as Env['MAIL_DB'];
  const acme = await seedTenant(h, 'acme');
  tenantId = acme.id;
  const beta = await seedTenant(h, 'beta');
  const ownerUser = await seedUser(h, { email: 'owner@acme.test' });
  await addMember(h, ownerUser.id, acme.id, 'owner');
  owner = await login(h, ownerUser.email);
  const salesUser = await seedUser(h, { email: 'sales@acme.test' });
  await addMember(h, salesUser.id, acme.id, 'sales');
  sales = await login(h, salesUser.email);
  const otherUser = await seedUser(h, { email: 'owner@beta.test' });
  await addMember(h, otherUser.id, beta.id, 'owner');
  other = await login(h, otherUser.email);

  const contact = await owner.post(`${BASE}/contacts`, { given_name: 'Ada', family_name: 'Lovelace' });
  expect(contact.status).toBe(201);
  contactId = String(contact.body['id']);
  const db = tenants.tenant(tenantId).db;
  for (const [i, at] of [OLD, OLD + 86_400_000, Date.UTC(2023, 7, 1)].entries()) {
    db.run(
      `INSERT INTO crm_activities (id, type, contact_id, actor_type, data, occurred_at) VALUES (?, 'note', ?, 'user', ?, ?)`,
      `01H0000000000000000000000${i}`,
      contactId,
      JSON.stringify({ n: i }),
      at,
    );
  }

  useFormsFakes();
  const created = await owner.post(`${BASE}/forms`, { name: 'Contact us', definition: leadDefinition() });
  formId = String(created.body['id']);
  const waits = collectWaits();
  const submitted = (await formsGatewayHandlers['forms.submit']?.(gatewayCtx(h.env, waits.ctx, acme), {
    formId,
    payload: { values: { first_name: 'Grace', email: 'grace@example.com' } },
  })) as { submission_id: string };
  await waits.flush();
  submissionId = submitted.submission_id;
  db.run(`UPDATE form_submissions SET created_at = ? WHERE id = ?`, OLD, submissionId);

  const report = await archiveTenant(archiveDepsFor(h.env), tenantId, Date.now() + 30_000);
  expect(report.complete).toBe(true);
  expect(db.all(`SELECT id FROM crm_activities WHERE occurred_at < ?`, Date.UTC(2024, 0, 1))).toEqual([]);
});

afterAll(() => overrideFormsRuntime(null));

describe('archived timeline', () => {
  it('returns archived activities newest first, a few months per page', async () => {
    const res = await owner.get(`${BASE}/contacts/${contactId}/timeline/archive`);
    expect(res.status).toBe(200);
    const data = res.body['data'] as Array<{ id: string; data: { n: number }; occurred_at: string }>;
    expect(data.map((a) => a.data.n)).toEqual([2, 1, 0]);
    expect(data[2]?.occurred_at).toBe(new Date(OLD).toISOString());
    expect(res.body['next_before']).toBeNull();

    const older = await owner.get(`${BASE}/contacts/${contactId}/timeline/archive?before=2023-06`);
    expect((older.body['data'] as unknown[]).length).toBe(2);
  });

  it('is confined to the workspace and its permissions', async () => {
    expect((await other.get(`/api/v2/t/acme/contacts/${contactId}/timeline/archive`)).status).toBe(404);
    expect((await other.get(`/api/v2/t/beta/contacts/${contactId}/timeline/archive`)).status).toBe(404);
    expect((await owner.get(`${BASE}/contacts/${contactId}/timeline/archive?before=2023-13`)).status).toBe(422);
  });
});

describe('archived submissions', () => {
  it('lists archived months and decrypts their submissions', async () => {
    const months = await owner.get(`${BASE}/forms/${formId}/archivedSubmissions`);
    expect(months.status).toBe(200);
    expect(months.body['data']).toEqual([{ month: '2023-05', rows: 1 }]);

    const page = await owner.get(`${BASE}/forms/${formId}/archivedSubmissions/2023-05`);
    expect(page.status).toBe(200);
    const data = page.body['data'] as Array<{ id: string; values: Record<string, unknown> }>;
    expect(data.map((s) => s.id)).toEqual([submissionId]);
    expect(data[0]?.values).toMatchObject({ first_name: 'Grace', email: 'grace@example.com' });
    expect(page.body['next_offset']).toBeNull();
  });

  it('needs forms:submissions_read', async () => {
    expect((await sales.get(`${BASE}/forms/${formId}/archivedSubmissions`)).status).toBe(403);
  });
});

describe('data & archiving settings', () => {
  it('shows the retention windows, the archive totals and the database sizes to the owner', async () => {
    const res = await owner.get('/api/t/acme/backups/archive');
    expect(res.status).toBe(200);
    expect(res.body['retention']).toEqual({ crm_events: 24, email: 24, clicks: 12, submissions: 12, esign: 24 });
    const streams = res.body['streams'] as Array<{ stream: string; rows: number }>;
    expect(streams.find((s) => s.stream === 'crm_activities')?.rows).toBe(3);
    const storage = res.body['storage'] as { databases: Array<{ name: string; bytes: number | null }>; warning: number };
    expect(storage.databases.find((d) => d.name === 'mail_db')?.bytes).toBeGreaterThan(storage.warning);
    expect((await sales.get('/api/t/acme/backups/archive')).status).toBe(403);
  });

  it('saves new windows after a step-up and validates them', async () => {
    expect((await owner.request('PUT', '/api/t/acme/backups/archive', { clicks: 6 })).status).toBe(403);
    await stepUp(h, owner);
    expect((await owner.request('PUT', '/api/t/acme/backups/archive', { clicks: 2 })).status).toBe(422);
    const saved = await owner.request('PUT', '/api/t/acme/backups/archive', { clicks: 6, crm_events: 0 });
    expect(saved.status).toBe(200);
    expect(saved.body['retention']).toMatchObject({ clicks: 6, crm_events: 0, email: 24 });
  });
});
