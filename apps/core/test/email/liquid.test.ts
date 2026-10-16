import { ROLE_PERMISSIONS, ROLES, type Role } from '@amable/core';
import { beforeAll, describe, expect, it } from 'vitest';
import type { MailSendContact } from '../../src/crm/mail-reads';
import { liquidContextSchema, STANDARD_LIQUID_FIELDS } from '../../src/email/liquid';
import { recipientContext } from '../../src/email/render';
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
import { fakeMailDbNamespace } from './helpers';

const BASE = '/api/v2/t/acme';

let h: Harness;
let owner: TestClient;
let marketer: TestClient;
let viewer: TestClient;
let outsider: TestClient;
let ada: string;
let bob: string;
let acmeId: string;

beforeAll(async () => {
  h = await createHarness();
  h.env.TENANT_DB = fakeTenantDbNamespace();
  h.env.MAIL_DB = fakeMailDbNamespace().namespace;
  const acme = await seedTenant(h, 'acme');
  acmeId = acme.id;
  const other = await seedTenant(h, 'other');
  for (const role of ['owner', 'marketer', 'viewer'] as const) {
    const user = await seedUser(h, { email: `${role}@acme.test` });
    await addMember(h, user.id, acme.id, role);
  }
  const stranger = await seedUser(h, { email: 'owner@other.test' });
  await addMember(h, stranger.id, other.id, 'owner');
  owner = await login(h, 'owner@acme.test');
  marketer = await login(h, 'marketer@acme.test');
  viewer = await login(h, 'viewer@acme.test');
  outsider = await login(h, 'owner@other.test');

  await owner.post(`${BASE}/customFields/contacts`, {
    key: 'plan',
    label: 'Plan',
    type: 'DROPDOWN',
    options: [
      { value: 'free', label: 'Free' },
      { value: 'pro', label: 'Pro' },
    ],
  });
  await owner.post(`${BASE}/customFields/contacts`, { key: 'tax_code', label: 'Tax code', type: 'TEXT', sensitive: true });
  await owner.post(`${BASE}/customFields/contacts`, { key: 'renewal', label: 'Renewal', type: 'DATE' });
  const tag = await owner.post(`${BASE}/tags`, { name: 'VIP' });
  const a = await owner.post(`${BASE}/contacts`, {
    given_name: 'Ada',
    family_name: 'Lovelace',
    emails: [{ email: 'ada@example.com' }],
    tag_ids: [String(tag.body['id'])],
    custom_fields: { plan: 'pro', tax_code: 'RSSMRA80A01H501U', renewal: '2026-12-01' },
  });
  const b = await owner.post(`${BASE}/contacts`, { given_name: 'Bob', emails: [{ email: 'bob@example.com' }] });
  ada = String(a.body['id']);
  bob = String(b.body['id']);
  await owner.post(`${BASE}/emailSnippets`, {
    key: 'greeting',
    name: 'Greeting',
    body: 'Hi {{ contact.first_name | default: "there" }} & co',
  });
});

describe('Liquid context schema', () => {
  it('lists exactly the paths the send pipeline puts in the context', () => {
    const data: MailSendContact = {
      contact: {
        id: 'c1',
        given_name: 'Ada',
        family_name: null,
        preferred_name: null,
        emails: [],
        phones: [],
        addresses: [],
        job_title: null,
        website: null,
        time_zone: null,
        score_value: 0,
        custom_fields: {},
      } as unknown as MailSendContact['contact'],
      tag_names: [],
      company: { name: 'Acme', website: null },
    };
    const context = recipientContext(data, { id: 'u1', email: 'o@acme.test', name: 'O' });
    const paths: string[] = [];
    for (const [root, value] of Object.entries(context)) {
      for (const key of Object.keys(value as Record<string, unknown>)) {
        if (key !== 'custom') paths.push(`${root}.${key}`);
      }
    }
    const schemaPaths = STANDARD_LIQUID_FIELDS.map((f) => f.path).filter((p) => p !== 'now' && p !== 'unsubscribe_url');
    expect(schemaPaths.sort()).toEqual(paths.sort());
  });

  it('includes custom fields with their types, options and masking, and snippets', async () => {
    const res = await marketer.get(`${BASE}/liquid/schema`);
    expect(res.status).toBe(200);
    const fields = res.body['fields'] as { path: string; kind: string; custom_field_type: string | null; options: string[]; masked: boolean }[];
    expect(fields.find((f) => f.path === 'contact.custom.plan')).toMatchObject({
      kind: 'string',
      custom_field_type: 'DROPDOWN',
      options: ['free', 'pro'],
    });
    expect(fields.find((f) => f.path === 'contact.custom.renewal')).toMatchObject({ kind: 'date' });
    expect(fields.find((f) => f.path === 'snippets.greeting')).toBeDefined();
    expect(fields.find((f) => f.path === 'unsubscribe_url')).toBeDefined();
    expect(res.body['filters']).toEqual(expect.arrayContaining(['default', 'date', 'truncate', 'capitalize']));

    const pure = liquidContextSchema({
      customFields: [],
      snippets: [],
      canReadSensitive: false,
    });
    expect(pure.fields.every((f) => f.group !== 'custom')).toBe(true);
  });
});

describe('GET /email/previewContext', () => {
  const clients = new Map<Role, TestClient>();

  beforeAll(async () => {
    for (const role of ROLES) {
      const email = `ctx-${role}@acme.test`;
      const user = await seedUser(h, { email });
      await addMember(h, user.id, acmeId, role);
      clients.set(role, await login(h, email));
    }
  });

  it.each(ROLES.map((role) => [role]))('masks sensitive fields like POST /liquid/preview for %s', async (role) => {
    const client = clients.get(role);
    if (client === undefined) throw new Error(role);
    const permissions = ROLE_PERMISSIONS[role];
    const res = await client.get(`${BASE}/email/previewContext?contact_id=${ada}`);
    if (!permissions.includes('contacts:read')) {
      expect(res.status).toBe(403);
      return;
    }
    expect(res.status).toBe(200);
    const context = res.body['context'] as { contact: { first_name: string; custom: Record<string, unknown> }; snippets: Record<string, string> };
    expect(context.contact.first_name).toBe('Ada');
    expect(context.snippets['greeting']).toBe('Hi Ada & co');
    const taxCode = String(context.contact.custom['tax_code']);
    if (permissions.includes('contacts:read_sensitive')) expect(taxCode).toBe('RSSMRA80A01H501U');
    else expect(taxCode).toMatch(/^\*+501U$/);
    if (permissions.includes('broadcasts:read')) {
      const preview = await client.post(`${BASE}/liquid/preview`, { template: '{{ contact.custom.tax_code }}', contact_id: ada });
      expect(preview.body['output']).toBe(taxCode);
    }
  });

  it('requires auth and the right tenant', async () => {
    expect((await h.client().get(`${BASE}/email/previewContext?contact_id=${ada}`)).status).toBe(401);
    expect((await outsider.get(`${BASE}/email/previewContext?contact_id=${ada}`)).status).toBe(404);
    expect((await outsider.get(`/api/v2/t/other/email/previewContext?contact_id=${ada}`)).status).toBe(404);
  });
});

describe('tenant timezone in previews', () => {
  it('formats dates in the tenant timezone like the send pipeline, keeping explicit zones and calendar dates', async () => {
    const template =
      '{{ "2026-10-16T07:00:00Z" | date: "%H:%M" }}|{{ contact.custom.renewal | date: "%d/%m/%Y" }}|{{ "2026-10-16T07:00:00Z" | date: "%H:%M", "Asia/Tokyo" }}|{{ "2026-10-16T07:00:00Z" | date: "%H:%M", contact.time_zone }}|{{ snippets.when }}';
    await owner.post(`${BASE}/emailSnippets`, { key: 'when', name: 'When', body: '{{ "2026-10-16T07:00:00Z" | date: "%H:%M" }}' });

    const utc = await marketer.post(`${BASE}/liquid/preview`, { template, contact_id: ada });
    expect(utc.body['output']).toBe('07:00|01/12/2026|16:00|07:00|07:00');

    expect((await owner.patch(`${BASE}/email/settings`, { timezone: 'America/New_York' })).status).toBe(200);
    const ny = await marketer.post(`${BASE}/liquid/preview`, { template, contact_id: ada });
    expect(ny.body['output']).toBe('03:00|01/12/2026|16:00|03:00|03:00');
    const sample = await marketer.post(`${BASE}/liquid/preview`, { template: '{{ "2026-10-16T07:00:00Z" | date: "%H:%M" }}' });
    expect(sample.body['output']).toBe('03:00');
    const ctx = await marketer.get(`${BASE}/email/previewContext?contact_id=${ada}`);
    expect(ctx.body['timezone']).toBe('America/New_York');
    expect((ctx.body['context'] as { snippets: Record<string, string> }).snippets['when']).toBe('03:00');

    expect((await owner.patch(`${BASE}/email/settings`, { timezone: 'UTC' })).status).toBe(200);
  });
});

describe('POST /liquid/preview', () => {
  const template = 'Hello {{ contact.first_name }}{% if contact.tags contains "VIP" %} (VIP){% endif %}';

  it('renders for each contact, with the same context as sending', async () => {
    const forAda = await marketer.post(`${BASE}/liquid/preview`, { template, contact_id: ada });
    expect(forAda.status).toBe(200);
    expect(forAda.body).toMatchObject({ ok: true, output: 'Hello Ada (VIP)', contact_id: ada });
    expect(forAda.body['variables']).toEqual(['contact.first_name', 'contact.tags']);
    const forBob = await marketer.post(`${BASE}/liquid/preview`, { template, contact_id: bob });
    expect(forBob.body['output']).toBe('Hello Bob');
    expect(forBob.body['missing']).toEqual(['contact.tags']);
  });

  it('renders referenced snippets for the contact, escaping once in html', async () => {
    const text = await marketer.post(`${BASE}/liquid/preview`, { template: '{{ snippets.greeting }}', contact_id: bob });
    expect(text.body['output']).toBe('Hi Bob & co');
    const html = await marketer.post(`${BASE}/liquid/preview`, {
      template: '{{ snippets.greeting }}',
      contact_id: bob,
      format: 'html',
    });
    expect(html.body['output']).toBe('Hi Bob &amp; co');
  });

  it('uses sample data without a contact', async () => {
    const res = await owner.post(`${BASE}/liquid/preview`, { template: '{{ contact.email }}|{{ unsubscribe_url }}' });
    expect(res.body).toMatchObject({ ok: true, output: 'owner@acme.test|https://example.com/unsub/preview', contact_id: null });
  });

  it('reports syntax errors with line and column, and unknown or missing variables', async () => {
    const broken = await marketer.post(`${BASE}/liquid/preview`, {
      template: 'Hi\n{% if contact.first_name %}\nno end',
      contact_id: ada,
    });
    expect(broken.body['ok']).toBe(false);
    expect((broken.body['errors'] as unknown[])[0]).toMatchObject({ line: 2, column: 1 });

    const filter = await marketer.post(`${BASE}/liquid/preview`, { template: 'x\n  {{ contact.city | shout }}' });
    expect((filter.body['errors'] as unknown[])[0]).toMatchObject({ line: 2, column: 3 });

    const vars = await marketer.post(`${BASE}/liquid/preview`, {
      template: '{{ contact.frist_name }}{{ contact.custom.plan }}{{ contact.custom.renewal | date: "%d/%m/%Y" }}{{ owner.name | default: "team" }}',
      contact_id: bob,
    });
    expect(vars.body['ok']).toBe(true);
    expect(vars.body['unknown']).toEqual(['contact.frist_name']);
    expect(vars.body['missing']).toEqual(['contact.custom.plan', 'contact.custom.renewal', 'owner.name']);
    expect(vars.body['output']).toBe('team');
  });

  it('respects the sandbox: no file includes, render time limit, no prototype access', async () => {
    const include = await marketer.post(`${BASE}/liquid/preview`, { template: '{% render "secrets" %}' });
    expect(include.body['ok']).toBe(false);
    const started = Date.now();
    const slow = await marketer.post(`${BASE}/liquid/preview`, {
      template: '{% for a in (1..100000) %}{% for b in (1..100000) %}x{% endfor %}{% endfor %}',
    });
    expect(slow.body['ok']).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
    const proto = await marketer.post(`${BASE}/liquid/preview`, {
      template: '{{ contact.constructor.name }}{{ contact.__proto__ }}',
      contact_id: ada,
    });
    expect(proto.body['output']).toBe('');
    const huge = await marketer.post(`${BASE}/liquid/preview`, { template: 'x'.repeat(200_001) });
    expect(huge.status).toBe(422);
  });

  it('masks sensitive custom fields for roles that cannot read them', async () => {
    const t = '{{ contact.custom.tax_code }}';
    const own = await owner.post(`${BASE}/liquid/preview`, { template: t, contact_id: ada });
    expect(own.body['output']).toBe('RSSMRA80A01H501U');
    const view = await viewer.post(`${BASE}/liquid/preview`, { template: t, contact_id: ada });
    expect(view.status).toBe(200);
    expect(view.body['output']).not.toContain('RSSMRA80');
    expect(view.body['output']).toMatch(/^\*+501U$/);
    const schema = await viewer.get(`${BASE}/liquid/schema`);
    const fields = schema.body['fields'] as { path: string; masked: boolean }[];
    expect(fields.find((f) => f.path === 'contact.custom.tax_code')?.masked).toBe(true);
  });

  it('requires auth, both permissions and the right tenant', async () => {
    expect((await h.client().post(`${BASE}/liquid/preview`, { template: 'x' })).status).toBe(401);
    expect((await outsider.post(`${BASE}/liquid/preview`, { template: 'x', contact_id: ada })).status).toBe(404);
    // The other tenant cannot see acme's contacts through its own workspace either.
    const cross = await outsider.post('/api/v2/t/other/liquid/preview', { template: '{{ contact.first_name }}', contact_id: ada });
    expect(cross.status).toBe(404);

    await stepUp(h, owner);
    const onlyTemplates = await owner.post('/api/t/acme/api-keys', { name: 'tpl', scopes: ['broadcasts:read'] });
    const both = await owner.post('/api/t/acme/api-keys', { name: 'both', scopes: ['broadcasts:read', 'contacts:read'] });
    const bearer = (key: unknown) => ({ authorization: `Bearer ${String(key)}`, origin: '' });
    const anon = h.client();
    const denied = await anon.post(`${BASE}/liquid/preview`, { template: 'x' }, bearer(onlyTemplates.body['key']));
    expect(denied.status).toBe(403);
    expect(denied.body['missing']).toEqual(['contacts:read']);
    expect((await anon.get(`${BASE}/liquid/schema`, bearer(onlyTemplates.body['key']))).status).toBe(200);
    const allowed = await anon.post(`${BASE}/liquid/preview`, { template: '{{ contact.first_name }}', contact_id: ada }, bearer(both.body['key']));
    expect(allowed.body['output']).toBe('Ada');
  });

  it('is rate limited per user', async () => {
    let last = 0;
    for (let i = 0; i < 121; i++) {
      last = (await viewer.post(`${BASE}/liquid/preview`, { template: 'x' })).status;
    }
    expect(last).toBe(429);
    expect((await marketer.post(`${BASE}/liquid/preview`, { template: 'x' })).status).toBe(200);
  });
});
