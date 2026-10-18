import { verifyWebhook } from '@amable/auth';
import type { AppManifestInput } from '@amable/core/apps';
import { afterEach, describe, expect, it } from 'vitest';
import { overrideAuthServices } from '../../src/auth/services';
import { appActionCatalog, runAppAction, type AppActionOutcome, type AppActionRequest } from '../../src/apps/actions';
import { pauseInstall } from '../../src/apps/lifecycle';
import { installById } from '../../src/apps/store';
import { createEngineHarness, edge, goal, graph, seq, tagStep } from '../automation/helpers';
import { fakeEngineNamespace } from '../automation/helpers';
import { createAppsHarness, resetAppsHarness } from './helpers';
import { bearer, installApp } from './oauth-helpers';

const whatsappExtensions: Partial<AppManifestInput> = {
  id: 'kapso',
  name: 'Kapso',
  scopes: ['contacts:read', 'automations:trigger'],
  privacy: { handles_personal_data: true, erasure_endpoint: '/privacy/erasure', data_request_endpoint: '/privacy/data' },
  custom_fields: [],
  extensions: {
    automation_actions: [
      {
        key: 'send_template',
        name: { en: 'Send WhatsApp template' },
        endpoint: '/actions/send-template',
        input_schema: {
          type: 'object',
          properties: {
            template: { type: 'string', title: { en: 'Template' }, enum: ['welcome', 'reminder'] },
            greeting: { type: 'string', title: { en: 'Greeting' }, merge_tags: true },
            delay: { type: 'integer', title: { en: 'Delay' }, minimum: 0, maximum: 60 },
          },
          required: ['template'],
        },
        output_keys: ['message_id'],
      },
    ],
    automation_triggers: [{ key: 'message_received', name: { en: 'WhatsApp received' } }],
  },
};

afterEach(() => {
  resetAppsHarness();
  overrideAuthServices(null);
});

describe('app_action steps in the engine', () => {
  const action = (input: Record<string, unknown>) => ({
    id: 'wa',
    type: 'app_action' as const,
    app_id: 'kapso',
    action_key: 'send_template',
    input,
  });

  it('checks the step against the installed apps at publish', async () => {
    const h = createEngineHarness();
    const t = h.tag('Go');
    const created = await h.op('automations.create', {
      name: 'WA',
      graph: graph([goal('g', [{ type: 'tag_applied', tag_ids: [t] }]), seq('s', [action({ template: 'nope', extra: 1 })])], [edge('g', 's')]),
      settings: {},
    });
    const schema = whatsappExtensions.extensions!.automation_actions![0]!.input_schema;
    const none = await h.op('automations.validate', { id: created.id, apps: {} });
    expect(none.issues.map((i) => i.code)).toContain('app_not_installed');
    const bad = await h.op('automations.validate', { id: created.id, apps: { kapso: { send_template: schema as never } } });
    expect(bad.issues.filter((i) => i.severity === 'error').map((i) => [i.code, i.path])).toEqual([
      ['app_input_unknown', 'nodes[1].steps[0].input.extra'],
      ['app_input_enum', 'nodes[1].steps[0].input.template'],
    ]);
    await expect(h.op('automations.publish', { id: created.id, apps: { kapso: {} } })).rejects.toThrow(/unknown_app_action/);
  });

  it('runs the action with merge tags resolved, then continues; skipped apps do not break the flow', async () => {
    const requests: AppActionRequest[] = [];
    let outcome: AppActionOutcome = { kind: 'ok', status: 200, output: { message_id: 'm1' } };
    const h = createEngineHarness({
      apps: {
        run: (request) => {
          requests.push(request);
          return Promise.resolve(outcome);
        },
      },
    });
    const go = h.tag('Go');
    const after = h.tag('After');
    const id = await h.publish(
      graph(
        [
          goal('g', [{ type: 'tag_applied', tag_ids: [go] }]),
          seq('s', [action({ template: 'welcome', greeting: 'Ciao {{ contact.first_name }}!' }), tagStep('t', after)]),
        ],
        [edge('g', 's')],
      ),
    );
    const ada = h.contact('Ada');
    h.tenant.op('contacts.applyTags', { id: ada, data: { tag_ids: [go] } });
    await h.flush();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      appId: 'kapso',
      actionKey: 'send_template',
      input: { template: 'welcome', greeting: 'Ciao Ada!' },
      contactId: ada,
      contact: { id: ada, first_name: 'Ada' },
      automation: { id, nodeId: 's', stepId: 'wa' },
    });
    expect(requests[0]?.idempotencyKey).toMatch(/.+/);
    expect(h.tagsOf(ada)).toContain(after);

    outcome = { kind: 'skipped', reason: 'not_installed' };
    const bob = h.contact('Bob');
    h.tenant.op('contacts.applyTags', { id: bob, data: { tag_ids: [go] } });
    await h.flush();
    expect(h.tagsOf(bob)).toContain(after);

    outcome = { kind: 'failed', status: 422, error: 'HTTP 422: unknown template', transient: false };
    const eve = h.contact('Eve');
    h.tenant.op('contacts.applyTags', { id: eve, data: { tag_ids: [go] } });
    await h.flush();
    expect(h.tagsOf(eve)).not.toContain(after);
    const detail = await h.op('automations.enrollments', { id, query: { limit: 10 } });
    const failed = detail.data.find((e) => e.contact_id === eve);
    expect(failed?.status).toBe('failed');
    expect(failed?.positions[0]?.last_error).toMatch(/unknown template/);
  });

  it('starts automations from app events', async () => {
    const h = createEngineHarness();
    const done = h.tag('Done');
    await h.publish(
      graph(
        [goal('g', [{ type: 'app_event', app_id: 'kapso', key: 'message_received' }]), seq('s', [tagStep('t', done)])],
        [edge('g', 's')],
      ),
    );
    const ada = h.contact();
    const event = (appId: string, key: string, id: string) => ({
      id,
      type: 'app.event' as const,
      occurredAt: new Date(h.clock.now).toISOString(),
      payload: { contactId: ada, appId, key, name: `app.${appId}.${key}`, data: {} },
    });
    expect(await h.engine.ingest([event('other', 'message_received', 'e1')])).toMatchObject({ matched: 0 });
    expect(await h.engine.ingest([event('kapso', 'message_received', 'e2')])).toMatchObject({ matched: 1 });
    await h.flush();
    expect(h.tagsOf(ada)).toContain(done);
  });
});

describe('app actions and triggers over HTTP', () => {
  it('calls the app signed, filters the output and skips paused apps', async () => {
    const h = await createAppsHarness();
    const installed = await installApp(h, whatsappExtensions);
    h.routes.set('https://apps.example.com/actions/send-template', () =>
      Response.json({ output: { message_id: 'wamid.1', secret: 'x' } }),
    );
    const request: AppActionRequest = {
      appId: 'kapso',
      actionKey: 'send_template',
      input: { template: 'welcome' },
      contactId: 'c_1',
      contact: { id: 'c_1', first_name: 'Ada', last_name: null, email: 'ada@example.com', phone: null },
      idempotencyKey: 'tok:0',
      automation: { id: 'a_1', versionId: 'v_1', nodeId: 's', stepId: 'wa' },
    };
    expect(await runAppAction(h.env, 't_acme', request)).toEqual({ kind: 'ok', status: 200, output: { message_id: 'wamid.1' } });
    const call = h.calls.find((c) => c.url.endsWith('/actions/send-template'))!;
    expect(call.headers.get('idempotency-key')).toBe('tok:0');
    expect(JSON.parse(call.body)).toMatchObject({ action: 'send_template', input: { template: 'welcome' }, contact: { email: 'ada@example.com' } });
    expect(
      await verifyWebhook({ secrets: [installed.webhookSecret], header: call.headers.get('amable-signature'), rawBody: call.body, nowMs: Date.now() }),
    ).toEqual({ ok: true });

    expect(Object.keys(await appActionCatalog(h.env, 't_acme'))).toEqual(['kapso']);
    expect(await runAppAction(h.env, 't_acme', { ...request, actionKey: 'nope' })).toEqual({ kind: 'skipped', reason: 'unknown_action' });
    h.routes.set('https://apps.example.com/actions/send-template', () => new Response('busy', { status: 503 }));
    expect(await runAppAction(h.env, 't_acme', request)).toMatchObject({ kind: 'failed', status: 503, transient: true });
    await pauseInstall(h.env, (await installById(h.env.DB, installed.installId))!, 'paused_by_admin', h.clock.now);
    expect(await runAppAction(h.env, 't_acme', request)).toEqual({ kind: 'skipped', reason: 'paused' });
    expect(await runAppAction(h.env, 't_acme', { ...request, appId: 'missing' })).toEqual({ kind: 'skipped', reason: 'not_installed' });
  });

  it('lets an app fire its declared triggers for a contact', async () => {
    const h = await createAppsHarness();
    Object.assign(h.env, { ENGINE: fakeEngineNamespace(h.env.TENANT_DB, h.clock) });
    const installed = await installApp(h, whatsappExtensions);
    const contact = await installed.owner.post('/api/v2/t/acme/contacts', { given_name: 'Ada', emails: [{ email: 'ada@example.com' }] });
    const contactId = String(contact.body.id);

    const fired = await bearer(h, 'POST', '/api/v2/t/acme/apps/events', installed.access, {
      key: 'message_received',
      contact_id: contactId,
      event_id: 'wamid.1',
      data: { text: 'hello' },
    });
    expect(fired.status).toBe(202);
    expect(fired.body).toMatchObject({ event_id: 'app:kapso:wamid.1', event: 'app.kapso.message_received', matched: 0 });
    const unknown = await bearer(h, 'POST', '/api/v2/t/acme/apps/events', installed.access, { key: 'nope', contact_id: contactId });
    expect(unknown.status).toBe(422);
    const missing = await bearer(h, 'POST', '/api/v2/t/acme/apps/events', installed.access, { key: 'message_received', contact_id: 'c_missing' });
    expect(missing.status).toBe(404);
    // Members see what the installed apps add (automation editor).
    const extensions = await installed.owner.get('/api/t/acme/apps/extensions');
    expect(extensions.body.data).toEqual([
      expect.objectContaining({ app_id: 'kapso', status: 'active', extensions: expect.objectContaining({ automation_triggers: expect.any(Array) }) }),
    ]);
  });
});
