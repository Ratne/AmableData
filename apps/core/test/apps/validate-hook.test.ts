import { formDefinitionSchema } from '@amable/forms';
import { afterEach, describe, expect, it } from 'vitest';
import { overrideAuthServices } from '../../src/auth/services';
import { installById } from '../../src/apps/store';
import { BREAKER_THRESHOLD, validateContactValues, validateImportBatch } from '../../src/apps/validate-hook';
import { blockingValidationErrors } from '../../src/forms/app-validation';
import { appConnector, appConnectorCatalog, appConnectorIssues } from '../../src/forms/connectors/app';
import type { ConnectorContext } from '../../src/forms/connectors/types';
import type { AppConnectorConfig } from '@amable/api-types';
import { createAppsHarness, resetAppsHarness, type AppsHarness } from './helpers';
import { installApp, type InstalledApp } from './oauth-helpers';

const HOOK = 'https://apps.example.com/hooks/validate';

afterEach(() => {
  resetAppsHarness();
  overrideAuthServices(null);
});

function verdict(email: string) {
  return email.startsWith('bad')
    ? { valid: false, reason: 'undeliverable', fields: { email_status: 'invalid' }, tags: ['Email non valida'], entity_data: { score: 3 } }
    : { valid: true, fields: { email_status: 'valid' } };
}

async function setup(): Promise<{ h: AppsHarness; installed: InstalledApp; hookCalls: () => number }> {
  const h = await createAppsHarness();
  h.routes.set(HOOK, (call) => {
    const body = JSON.parse(call.body) as { values: { email: string } };
    return Response.json(verdict(body.values.email));
  });
  const installed = await installApp(h);
  return { h, installed, hookCalls: () => h.calls.filter((c) => c.url === HOOK).length };
}

async function contactOf(installed: InstalledApp, id: string) {
  const contact = (await installed.owner.get(`/api/v2/t/acme/contacts/${id}`)).body as {
    custom_fields: Record<string, unknown>;
    tag_ids: string[];
  };
  const tags = ((await installed.owner.get('/api/v2/t/acme/tags')).body.data as Array<{ id: string; name: string }>).filter((t) =>
    contact.tag_ids.includes(t.id),
  );
  return { ...contact, tags };
}

describe('contact.validate hook', () => {
  it('annotates new CRM contacts with the app verdict, through the cache', async () => {
    const { h, installed, hookCalls } = await setup();
    const created = await installed.owner.post('/api/v2/t/acme/contacts', { given_name: 'Ada', emails: [{ email: 'bad@example.com' }] });
    expect(created.status).toBe(201);
    const id = String(created.body.id);
    const contact = await contactOf(installed, id);
    expect(contact.custom_fields['app_emailable_email_status']).toBe('invalid');
    expect(contact.tags.map((t) => t.name)).toContain('Email non valida');
    expect(hookCalls()).toBe(1);
    expect(JSON.parse(h.calls.find((c) => c.url === HOOK)!.body)).toMatchObject({
      hook: 'contact.validate',
      source: 'crm',
      values: { email: 'bad@example.com' },
    });

    // Same value (case and spaces aside): answered from the cache.
    const again = await validateContactValues(h.env, 't_acme', { email: ' BAD@example.com ' }, 'crm');
    expect(again).toEqual([expect.objectContaining({ app_id: 'emailable', valid: false, reason: 'undeliverable', cached: true })]);
    expect(hookCalls()).toBe(1);

    const live = await installed.owner.post('/api/t/acme/apps/validate', { email: 'good@example.com' });
    expect(live.status).toBe(200);
    expect(live.body.data).toEqual([expect.objectContaining({ app_id: 'emailable', valid: true, fields: ['email'], cached: false })]);
  });

  it('fails open and opens the circuit breaker after repeated failures', async () => {
    const { h, installed, hookCalls } = await setup();
    h.routes.set(HOOK, () => new Response('down', { status: 500 }));
    for (let i = 0; i < BREAKER_THRESHOLD; i += 1) {
      const results = await validateContactValues(h.env, 't_acme', { email: `x${i}@example.com` }, 'crm');
      expect(results[0]?.valid).toBeNull();
    }
    expect(hookCalls()).toBe(BREAKER_THRESHOLD);
    const install = await installById(h.env.DB, installed.installId);
    expect(install?.hookOpenUntil).toBeGreaterThan(Date.now());
    // Open: the app is skipped, the save still works.
    await validateContactValues(h.env, 't_acme', { email: 'later@example.com' }, 'crm');
    expect(hookCalls()).toBe(BREAKER_THRESHOLD);
    const created = await installed.owner.post('/api/v2/t/acme/contacts', { given_name: 'Bob', emails: [{ email: 'bob@example.com' }] });
    expect(created.status).toBe(201);
  });

  it('blocks form submissions only in blocking mode and on mapped fields', async () => {
    const { h } = await setup();
    const definition = formDefinitionSchema.parse({
      fields: [
        { id: 'f1', kind: 'text', key: 'name', label: 'Name', map_to: 'given_name' },
        { id: 'f2', kind: 'email', key: 'work_email', label: 'Email', map_to: 'email' },
      ],
      crm: { app_validation: 'blocking' },
    });
    expect(await blockingValidationErrors(h.env, 't_acme', definition, { name: 'Ada', work_email: 'bad@example.com' })).toEqual([
      { path: 'work_email', message: 'undeliverable' },
    ]);
    expect(await blockingValidationErrors(h.env, 't_acme', definition, { work_email: 'ok@example.com' })).toEqual([]);
    const advisory = { ...definition, crm: { ...definition.crm, app_validation: 'advisory' as const } };
    expect(await blockingValidationErrors(h.env, 't_acme', advisory, { work_email: 'bad@example.com' })).toEqual([]);
  });

  it('validates imported contacts in batches through batch_endpoint', async () => {
    const h = await createAppsHarness();
    h.routes.set('https://apps.example.com/hooks/validate-batch', (call) => {
      const body = JSON.parse(call.body) as { items: Array<{ ref: string; values: { email: string } }> };
      return Response.json({ results: body.items.map((item) => ({ ref: item.ref, ...verdict(item.values.email) })) });
    });
    const installed = await installApp(h, {
      extensions: { contact_validate: { fields: ['email'], endpoint: '/hooks/validate', batch_endpoint: '/hooks/validate-batch' } },
    });
    const ids: string[] = [];
    for (const email of ['bad1@example.com', 'good@example.com']) {
      // The per-contact endpoint is not routed here: it fails open.
      const created = await installed.owner.post('/api/v2/t/acme/contacts', { given_name: 'X', emails: [{ email }] });
      ids.push(String(created.body.id));
    }
    const before = h.calls.filter((c) => c.url.endsWith('/hooks/validate-batch')).length;
    const applied = await validateImportBatch(h.env, 't_acme', [
      { id: ids[0]!, email: 'bad1@example.com', phone: null },
      { id: ids[1]!, email: 'good@example.com', phone: null },
    ]);
    expect(applied).toBe(2);
    expect(h.calls.filter((c) => c.url.endsWith('/hooks/validate-batch')).length).toBe(before + 1);
    expect((await contactOf(installed, ids[0]!)).tags.map((t) => t.name)).toContain('Email non valida');
    expect((await contactOf(installed, ids[1]!)).custom_fields['app_emailable_email_status']).toBe('valid');
  });
});

describe('app form connectors', () => {
  it('lists, validates and delivers to app connectors', async () => {
    const h = await createAppsHarness();
    await installApp(h, {
      scopes: ['contacts:read', 'contacts:write', 'forms:submissions_read'],
      extensions: {
        form_connectors: [
          {
            key: 'add_lead',
            name: { en: 'Add as lead' },
            endpoint: '/connectors/lead',
            settings_schema: { type: 'object', properties: { list: { type: 'string', title: { en: 'List' } } }, required: ['list'] },
          },
        ],
      },
    });
    const catalog = await appConnectorCatalog(h.env, 't_acme');
    expect(catalog).toEqual([
      expect.objectContaining({ type: 'app', available: true, app: expect.objectContaining({ app_id: 'emailable', key: 'add_lead', paused: false }) }),
    ]);
    expect(await appConnectorIssues(h.env, 't_acme', { app_id: 'emailable', key: 'add_lead', settings: {} })).toEqual([
      { path: 'config.settings.list', message: 'required' },
    ]);
    expect(await appConnectorIssues(h.env, 't_acme', { app_id: 'emailable', key: 'nope', settings: {} })).toHaveLength(1);

    h.routes.set('https://apps.example.com/connectors/lead', () => Response.json({ ok: true }));
    const ctx = {
      env: h.env,
      tenantId: 't_acme',
      form: { id: 'f_1', name: 'Contact us', fields: [] },
      submission: {
        id: 's_1',
        submittedAt: new Date().toISOString(),
        contactId: 'c_1',
        values: { email: 'ada@example.com' },
        tracking: {},
        meta: { page_url: '', referrer: '', visitor_id: '' },
      },
      connection: { id: 'fc_1', name: 'Lead', config: { app_id: 'emailable', key: 'add_lead', settings: { list: 'vip' } }, secret: null },
      attempt: 1,
      runtime: {},
      submissionUrl: null,
      test: false,
    } as unknown as ConnectorContext<AppConnectorConfig>;
    expect(await appConnector.run(ctx)).toMatchObject({ status: 'success', statusCode: 200 });
    const call = h.calls.find((c) => c.url.endsWith('/connectors/lead'))!;
    expect(call.headers.get('idempotency-key')).toBe('s_1:fc_1');
    expect(JSON.parse(call.body)).toMatchObject({ connector: 'add_lead', settings: { list: 'vip' }, submission: { id: 's_1' } });

    h.routes.set('https://apps.example.com/connectors/lead', () => new Response('busy', { status: 503 }));
    expect(await appConnector.run(ctx)).toMatchObject({ status: 'failed', retryable: true, statusCode: 503 });
    const missing = { ...ctx, connection: { ...ctx.connection, config: { app_id: 'gone', key: 'x', settings: {} } } };
    expect(await appConnector.run(missing)).toMatchObject({ status: 'skipped' });
  });
});
