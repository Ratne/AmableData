import { d1InstallStore } from '@amable/app-sdk';
import {
  fakeCrm,
  fixtureFetch,
  routeFetch,
  signedCaller,
  testInstall,
  type Fixture,
} from '@amable/app-sdk/testing';
import { memoryD1 } from '@amable/app-sdk/testing/d1';
import { describe, expect, it } from 'vitest';
import { passed, runConformance } from '../../../../packages/app-cli/src/conformance';
import manifest from '../manifest.json';
import { createWorker } from '../src/app';
import { createRequest, parseParams, templateMessage, toCrmTemplate } from '../src/templates';
import { eventsOf, kapsoSignature, messageOf, verifyKapsoSignature } from '../src/webhook';
import contactErase from './fixtures/kapso/contact-erase.json';
import customerCreate from './fixtures/kapso/customer-create.json';
import customersNone from './fixtures/kapso/customers-none.json';
import invalidKey from './fixtures/kapso/error-invalid-key.json';
import numbersProduction from './fixtures/kapso/phone-numbers-production.json';
import sendNoSession from './fixtures/kapso/send-no-session.json';
import sendOk from './fixtures/kapso/send-ok.json';
import setupLink from './fixtures/kapso/setup-link-create.json';
import templateCreateInvalid from './fixtures/kapso/template-create-invalid.json';
import templateCreate from './fixtures/kapso/template-create.json';
import templateDelete from './fixtures/kapso/template-delete.json';
import templatesList from './fixtures/kapso/templates-list.json';
import templatesSandbox from './fixtures/kapso/templates-sandbox-forbidden.json';
import webhookCreate from './fixtures/kapso/webhook-create.json';
import webhookDeleteMissing from './fixtures/kapso/webhook-delete-missing.json';
import webhookDelete from './fixtures/kapso/webhook-delete.json';
import marketingStopped from './fixtures/kapso/webhooks/marketing-stopped.json';
import messageDelivered from './fixtures/kapso/webhooks/message-delivered.json';
import messageFailed from './fixtures/kapso/webhooks/message-failed.json';
import messageImage from './fixtures/kapso/webhooks/message-received-image.json';
import messageReceived from './fixtures/kapso/webhooks/message-received.json';
import businessAppEcho from './fixtures/kapso/webhooks/message-sent-business-app.json';
import receivedBatch from './fixtures/kapso/webhooks/received-batch.json';

const fx = (value: unknown) => value as Fixture;
/** Where the CRM deployed this copy (`APP_BASE_URL`). */
const BASE = 'https://amable-app-kapso.acme.workers.dev';
const API_KEY = 'kapso_test_key_0123456789';
const HOOK_SECRET = 'kapso_hook_secret_0123456789';
const PRODUCTION = {
  phone_number_id: '1234567890',
  business_account_id: '98765432109',
  display_phone_number: '+1 555-123-4567',
  name: 'Support Line',
  kind: 'production',
  webhook_id: 'wh_old',
};
const SANDBOX = {
  phone_number_id: '597907523413541',
  business_account_id: '2102230076919824',
  display_phone_number: null,
  name: 'Sandbox WhatsApp',
  kind: 'sandbox',
  webhook_id: 'wh_old',
};
const TEMPLATES = templatesList.response.body.data;

async function setup(
  options: { number?: typeof PRODUCTION | typeof SANDBOX | null; apiKey?: string | null } = {},
) {
  const db = memoryD1();
  const install = testInstall({ scopes: manifest.scopes });
  await d1InstallStore(db).put(install);
  const crm = fakeCrm();
  if (options.apiKey !== null)
    crm.data.set('kapso_api_key', { value: options.apiKey ?? API_KEY, secret: true });
  const number = options.number === undefined ? PRODUCTION : options.number;
  if (number !== null) {
    crm.data.set('kapso_number', { value: number, secret: false });
    crm.data.set('kapso_webhook_secret', { value: HOOK_SECRET, secret: true });
  }
  const kapso = fixtureFetch(
    [
      numbersProduction,
      customersNone,
      customerCreate,
      setupLink,
      templatesList,
      templateCreate,
      templateDelete,
      sendOk,
      webhookCreate,
      webhookDelete,
      contactErase,
    ].map(fx),
  );
  const worker = createWorker({ fetch: routeFetch(crm.fetch, kapso.fetch) });
  const env = { DB: db, APP_BASE_URL: BASE };
  const fetch = (request: Request) => worker.fetch(request, env);
  const call = signedCaller({ fetch, baseUrl: BASE, install });
  const screen = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const token = await crm.sessionToken({
      appId: manifest.id,
      audience: BASE,
      install,
    });
    const response = await fetch(
      new Request(`${BASE}${path}`, {
        method: init.method ?? 'GET',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const webhook = async (event: { event: string; body: unknown }, secret = HOOK_SECRET) => {
    const raw = JSON.stringify(event.body);
    const response = await fetch(
      new Request(`${BASE}/inbound/${install.id}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Webhook-Event': event.event,
          'X-Webhook-Signature': await kapsoSignature(secret, raw),
        },
        body: raw,
      }),
    );
    return response.status;
  };
  return { db, install, crm, kapso, fetch, call, screen, webhook, env };
}

describe('kapso: templates', () => {
  it('turns Meta templates into CRM templates with their parameters', () => {
    const [hello, promo, named, event, video] = TEMPLATES;
    expect(toCrmTemplate(hello as never)).toMatchObject({
      id: '1192339204654487',
      name: 'hello_world',
      language: 'en_US',
      category: 'MARKETING',
      params: [],
    });
    expect(toCrmTemplate(promo as never)).toMatchObject({
      params: [
        { key: '1', example: 'Mark' },
        { key: '2', example: 'FALL25' },
      ],
    });
    expect(toCrmTemplate(named as never)).toMatchObject({
      text: 'Thank you, {{customer_name}}! Your order number is {{order_number}}.',
      params: [
        { key: 'customer_name', example: 'Pablo' },
        { key: 'order_number', example: '860198-230332' },
      ],
    });
    expect(toCrmTemplate(event as never).params.map((p) => p.key)).toEqual([
      'event_name',
      'start_time',
      'button_0',
    ]);
    expect(toCrmTemplate(video as never).params.map((p) => p.key)).toEqual(['header_url']);
  });

  it('builds send requests with named, positional, header and button parameters', () => {
    const [, promo, named, event] = TEMPLATES;
    expect(templateMessage(named as never, { customer_name: 'Ada' })).toEqual({
      ok: false,
      missing: ['order_number'],
    });
    expect(templateMessage(named as never, { customer_name: 'Ada', order_number: 'A-1' })).toEqual({
      ok: true,
      text: 'Thank you, Ada! Your order number is A-1.',
      template: {
        name: 'order_confirmation_simple',
        language: { code: 'it' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', parameter_name: 'customer_name', text: 'Ada' },
              { type: 'text', parameter_name: 'order_number', text: 'A-1' },
            ],
          },
        ],
      },
    });
    const positional = templateMessage(promo as never, { '2': 'CODE', '1': 'Bob' });
    expect(positional.ok && positional.template['components']).toEqual([
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'Bob' },
          { type: 'text', text: 'CODE' },
        ],
      },
    ]);
    const withButton = templateMessage(event as never, {
      event_name: 'Open day',
      start_time: 'domani',
      button_0: 'open-day',
    });
    expect(withButton.ok && withButton.template['components']).toEqual([
      {
        type: 'header',
        parameters: [{ type: 'text', parameter_name: 'event_name', text: 'Open day' }],
      },
      {
        type: 'body',
        parameters: [
          { type: 'text', parameter_name: 'event_name', text: 'Open day' },
          { type: 'text', parameter_name: 'start_time', text: 'domani' },
        ],
      },
      {
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: 'open-day' }],
      },
    ]);
    expect(parseParams('first_name = Ada\norder: A-1\nnot a param')).toEqual({
      first_name: 'Ada',
      order: 'A-1',
    });
  });

  it('validates drafts before they reach Meta', () => {
    const draft = {
      name: 'appointment_reminder',
      language: 'it',
      category: 'UTILITY',
      body: 'Ciao {{first_name}}, ci vediamo il {{date}}.',
      examples: { first_name: 'Ada', date: '12/11' },
    };
    expect(createRequest(draft)).toEqual({
      ok: true,
      request: {
        name: 'appointment_reminder',
        language: 'it',
        category: 'UTILITY',
        parameter_format: 'NAMED',
        components: [
          {
            type: 'BODY',
            text: 'Ciao {{first_name}}, ci vediamo il {{date}}.',
            example: {
              body_text_named_params: [
                { param_name: 'first_name', example: 'Ada' },
                { param_name: 'date', example: '12/11' },
              ],
            },
          },
        ],
      },
    });
    expect(createRequest({ ...draft, examples: { first_name: 'Ada' } })).toMatchObject({
      ok: false,
      error: expect.stringContaining('{{date}}'),
    });
    expect(createRequest({ ...draft, name: 'Promo Estate' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('name'),
    });
    expect(
      createRequest({ ...draft, buttons: [{ type: 'URL', text: 'Prenota', url: 'http://x.it' }] }),
    ).toMatchObject({ ok: false });
    expect(
      createRequest({
        name: 'login_code',
        language: 'en',
        category: 'AUTHENTICATION',
        security_recommendation: true,
        code_expiration_minutes: 10,
      }),
    ).toMatchObject({
      ok: true,
      request: {
        components: [
          { type: 'BODY', add_security_recommendation: true },
          { type: 'FOOTER', code_expiration_minutes: 10 },
          { type: 'BUTTONS' },
        ],
      },
    });
  });
});

describe('kapso: webhooks', () => {
  it('verifies the signature and reads batches and every message type', async () => {
    const raw = JSON.stringify(messageReceived.body);
    expect(
      await verifyKapsoSignature(HOOK_SECRET, raw, await kapsoSignature(HOOK_SECRET, raw)),
    ).toBe(true);
    expect(await verifyKapsoSignature(HOOK_SECRET, raw, await kapsoSignature('other', raw))).toBe(
      false,
    );
    expect(await verifyKapsoSignature(HOOK_SECRET, raw, null)).toBe(false);
    expect(eventsOf('whatsapp.message.received', receivedBatch.body)).toHaveLength(2);
    expect(messageOf(messageImage.body)).toMatchObject({
      type: 'image',
      text: '[image] Il preventivo',
    });
    expect(messageOf(messageFailed.body)).toMatchObject({
      error:
        'Re-engagement message: More than 24 hours have passed since the recipient last replied',
    });
  });

  it('brings inbound messages to the inbox and fires the automation event', async () => {
    const app = await setup();
    expect(await app.webhook(messageReceived)).toBe(200);
    expect(app.crm.inbound).toEqual([
      {
        channel: 'whatsapp',
        external_id: 'wamid.in1',
        from: '+393331234567',
        text: 'Ciao, avete disponibilità sabato?',
        contact: { given_name: 'Ada', family_name: 'Lovelace' },
        sent_at: '2024-10-28T05:20:00.000Z',
      },
    ]);
    expect(app.crm.events).toEqual([
      {
        key: 'message_received',
        contact_id: 'ct_1',
        event_id: 'wamid.in1',
        data: { text: 'Ciao, avete disponibilità sabato?', type: 'text' },
      },
    ]);
    expect(await app.webhook(receivedBatch)).toBe(200);
    expect(app.crm.inbound.map((m) => m['external_id'])).toEqual([
      'wamid.in1',
      'wamid.b1',
      'wamid.b2',
    ]);
  });

  it('refuses unsigned deliveries and ignores other numbers', async () => {
    const app = await setup();
    expect(await app.webhook(messageReceived, 'wrong secret')).toBe(401);
    const other = { ...messageReceived, body: { ...messageReceived.body, phone_number_id: '999' } };
    expect(await app.webhook(other)).toBe(200);
    expect(app.crm.inbound).toEqual([]);
  });

  it('records delivery updates, errors and replies sent from the phone app', async () => {
    const app = await setup();
    await app.webhook(messageDelivered);
    await app.webhook(messageFailed);
    expect(app.crm.statuses).toEqual([
      { channel: 'whatsapp', external_id: 'wamid.out1', status: 'delivered' },
      {
        channel: 'whatsapp',
        external_id: 'wamid.out2',
        status: 'failed',
        error:
          'Re-engagement message: More than 24 hours have passed since the recipient last replied',
      },
    ]);
    await app.webhook(businessAppEcho);
    expect(app.crm.outbound).toEqual([
      {
        channel: 'whatsapp',
        external_id: 'wamid.app1',
        to: '+393331234567',
        text: 'Ti chiamo tra 5 minuti',
        status: 'sent',
        sent_at: '2024-10-28T05:28:20.000Z',
      },
    ]);
  });

  it('asks Kapso to retry when the CRM is down, and ignores messages sent outside the CRM', async () => {
    const app = await setup();
    app.crm.on('POST', /^\/apps\/messages\/inbound$/, () =>
      Response.json({ error: 'unavailable' }, { status: 503 }),
    );
    expect(await app.webhook(messageReceived)).toBe(500);
    app.crm.on('POST', /^\/apps\/messages\/status$/, () =>
      Response.json({ error: 'not_found', message: 'unknown message' }, { status: 404 }),
    );
    expect(await app.webhook(messageDelivered)).toBe(200);
  });

  it('fires the marketing opt-out event for contacts it talked to', async () => {
    const app = await setup();
    await app.webhook(marketingStopped);
    expect(app.crm.events).toEqual([]);
    await app.webhook(messageReceived);
    await app.webhook(marketingStopped);
    expect(app.crm.events.at(-1)).toEqual({
      key: 'marketing_opted_out',
      contact_id: 'ct_1',
      event_id: 'pref:4821:393331234567',
      data: { detail: 'User requested to stop marketing messages' },
    });
  });
});

describe('kapso: channel and automation block', () => {
  it('sends replies and templates from the inbox', async () => {
    const app = await setup();
    const reply = await app.call('/channels/send', {
      channel: 'whatsapp',
      to: '+39 333 123 4567',
      message: { id: 'msg_1', text: 'Sì, alle 10' },
    });
    expect(reply).toEqual({
      status: 200,
      body: {
        external_id: 'wamid.HBgNMTU1NTE0OTU5Nzg1FQIAERgSMDhGRjdBMDEyOTcxQzFFQkFBAA==',
        status: 'sent',
      },
    });
    expect(app.kapso.calls.at(-1)).toMatchObject({
      url: 'https://api.kapso.ai/meta/whatsapp/v24.0/1234567890/messages',
      headers: { 'x-api-key': API_KEY },
      body: {
        messaging_product: 'whatsapp',
        to: '393331234567',
        type: 'text',
        text: { body: 'Sì, alle 10' },
      },
    });

    const template = await app.call('/channels/send', {
      channel: 'whatsapp',
      to: '+393331234567',
      message: {
        id: 'msg_2',
        text: '[1627019861106475]',
        template: { id: '1627019861106475', params: { customer_name: 'Ada', order_number: 'A-1' } },
      },
    });
    expect(template.body).toMatchObject({
      status: 'sent',
      text: 'Thank you, Ada! Your order number is A-1.',
    });
    expect(app.kapso.calls.at(-1)?.body).toMatchObject({
      type: 'template',
      template: { name: 'order_confirmation_simple', language: { code: 'it' } },
    });

    const missing = await app.call('/channels/send', {
      channel: 'whatsapp',
      to: '+393331234567',
      message: { id: 'msg_3', text: 'x', template: { id: '1627019861106475', params: {} } },
    });
    expect(missing).toMatchObject({
      status: 422,
      body: { error: 'missing template parameters: customer_name, order_number' },
    });
    const pending = await app.call('/channels/send', {
      channel: 'whatsapp',
      to: '+393331234567',
      message: { id: 'msg_4', text: 'x', template: { id: '991234567890123', params: {} } },
    });
    expect(pending.status).toBe(422);
  });

  it('lists approved templates for the inbox and the automation editor', async () => {
    const app = await setup();
    const listed = await app.call('/channels/templates', { channel: 'whatsapp' });
    expect((listed.body['templates'] as Array<{ name: string }>).map((t) => t.name)).toEqual([
      'hello_world',
      'seasonal_promotion',
      'order_confirmation_simple',
      'event_reminder',
      'product_demo_video',
    ]);
    const options = await app.call('/options/templates', {
      kind: 'action',
      key: 'send_template',
      property: 'template',
    });
    expect((options.body['options'] as unknown[])[2]).toEqual({
      value: '1627019861106475',
      label: 'order_confirmation_simple (it)',
      description: 'utility · params: customer_name, order_number',
    });
    // Kapso is asked once: the list is cached for a minute.
    expect(
      app.kapso.callsTo('https://api.kapso.ai/meta/whatsapp/v24.0/98765432109/message_templates'),
    ).toHaveLength(1);

    const sandbox = await setup({ number: SANDBOX });
    expect((await sandbox.call('/channels/templates', { channel: 'whatsapp' })).body).toEqual({
      templates: [],
      notice: expect.stringContaining('sandbox'),
    });
    expect(sandbox.kapso.calls).toEqual([]);

    const unconnected = await setup({ number: null });
    expect((await unconnected.call('/channels/templates', { channel: 'whatsapp' })).body).toEqual({
      templates: [],
      notice: expect.stringContaining('not connected'),
    });
  });

  it('deletes its webhook at Kapso on uninstall, even from a cold isolate', async () => {
    const app = await setup();
    const uninstalled = await app.call('/webhooks', { type: 'app.uninstalled', data: {} });
    expect(uninstalled.status).toBe(200);
    expect(app.kapso.calls).toContainEqual(
      expect.objectContaining({
        method: 'DELETE',
        url: 'https://api.kapso.ai/platform/v1/whatsapp/phone_numbers/1234567890/webhooks/wh_old',
      }),
    );
  });

  it('sends the template of an automation step once, and shows it in the thread', async () => {
    const app = await setup();
    const step = {
      action: 'send_template',
      input: { template: '1627019861106475', params: 'customer_name=Ada\norder_number=A-1' },
      contact_id: 'ct_9',
      contact: {
        id: 'ct_9',
        first_name: 'Ada',
        last_name: null,
        email: null,
        phone: '+39 333 123 4567',
      },
      idempotency_key: 'run_1:step_1',
    };
    const first = await app.call('/actions/send-template', step);
    expect(first).toEqual({
      status: 200,
      body: {
        output: {
          message_id: 'wamid.HBgNMTU1NTE0OTU5Nzg1FQIAERgSMDhGRjdBMDEyOTcxQzFFQkFBAA==',
          template: 'order_confirmation_simple',
          language: 'it',
        },
      },
    });
    expect(app.crm.outbound).toEqual([
      {
        channel: 'whatsapp',
        external_id: 'wamid.HBgNMTU1NTE0OTU5Nzg1FQIAERgSMDhGRjdBMDEyOTcxQzFFQkFBAA==',
        to: '+393331234567',
        text: 'Thank you, Ada! Your order number is A-1.',
        template: { id: '1627019861106475', params: { customer_name: 'Ada', order_number: 'A-1' } },
      },
    ]);
    // The CRM retries a step with the same idempotency key: no second message.
    expect((await app.call('/actions/send-template', step)).body).toEqual(first.body);
    expect(
      app.kapso.callsTo('https://api.kapso.ai/meta/whatsapp/v24.0/1234567890/messages'),
    ).toHaveLength(1);

    expect(
      (
        await app.call('/actions/send-template', {
          ...step,
          idempotency_key: 'run_2',
          contact: { ...step.contact, phone: null },
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await app.call('/actions/send-template', {
          ...step,
          idempotency_key: 'run_3',
          input: { template: '' },
        })
      ).status,
    ).toBe(422);
  });

  it('reports Kapso refusals as failed messages', async () => {
    const app = await setup({ number: SANDBOX });
    app.kapso.use(fx(sendNoSession));
    const reply = await app.call('/channels/send', {
      channel: 'whatsapp',
      to: '+15550001111',
      message: { id: 'm', text: 'hi' },
    });
    expect(reply).toEqual({
      status: 422,
      body: { error: 'Active sandbox session required to send messages' },
    });
    const disconnected = await setup({ number: null });
    expect(
      (
        await disconnected.call('/channels/send', {
          channel: 'whatsapp',
          to: '+15550001111',
          message: { id: 'm', text: 'hi' },
        })
      ).status,
    ).toBe(422);
  });
});

describe('kapso: settings, onboarding and templates page', () => {
  it('checks the API key and connects a number of the project with a fresh webhook', async () => {
    const app = await setup({ apiKey: null, number: null });
    app.kapso.use(
      fx({
        ...invalidKey,
        request: {
          ...invalidKey.request,
          url: 'https://api.kapso.ai/platform/v1/whatsapp/phone_numbers',
        },
      }),
    );
    expect(
      (await app.screen('/api/settings', { method: 'POST', body: { api_key: 'wrong' } })).status,
    ).toBe(422);
    expect(app.crm.data.has('kapso_api_key')).toBe(false);

    app.kapso.use(fx(numbersProduction));
    const saved = await app.screen('/api/settings', { method: 'POST', body: { api_key: API_KEY } });
    expect(saved.body).toMatchObject({
      configured: true,
      last4: '6789',
      number: null,
      numbers: [{ phone_number_id: '1234567890', kind: 'production' }],
    });
    expect(app.crm.data.get('kapso_api_key')).toEqual({ value: API_KEY, secret: true });

    const connected = await app.screen('/api/number', {
      method: 'POST',
      body: { phone_number_id: '1234567890' },
    });
    expect(connected.body['number']).toMatchObject({
      phone_number_id: '1234567890',
      business_account_id: '98765432109',
      webhook_id: webhookCreate.response.body.data.id,
    });
    const created = app.kapso.calls.find(
      (c) => c.method === 'POST' && c.url.endsWith('/whatsapp/phone_numbers/1234567890/webhooks'),
    )!;
    const hook = (
      created.body as { whatsapp_webhook: { url: string; secret_key: string; events: string[] } }
    ).whatsapp_webhook;
    expect(hook.url).toBe(`${BASE}/inbound/${app.install.id}`);
    expect(hook.events).toContain('whatsapp.contact.marketing_preference_changed');
    expect(app.crm.data.get('kapso_webhook_secret')).toEqual({
      value: hook.secret_key,
      secret: true,
    });
    expect(hook.secret_key).toMatch(/^[0-9a-f]{64}$/);

    // Removing the key disconnects the number and deletes the webhook at Kapso.
    app.kapso.use(fx(webhookDeleteMissing));
    await app.screen('/api/settings', { method: 'POST', body: { api_key: '' } });
    expect(app.crm.data.has('kapso_api_key') || app.crm.data.has('kapso_number')).toBe(false);
  });

  it('onboards a new number through a Kapso setup link', async () => {
    const app = await setup({ number: null });
    const link = await app.screen('/api/connect', { method: 'POST', body: {} });
    expect(link.body).toEqual({ url: 'https://app.kapso.ai/whatsapp/setup/[redacted]' });
    const customer = app.kapso.calls.find(
      (c) => c.method === 'POST' && c.url.endsWith('/customers'),
    )!;
    expect(customer.body).toEqual({
      customer: { name: 'AmableData acme', external_customer_id: 'amable-t_test' },
    });
    const request = app.kapso.calls.find((c) => c.url.includes('/setup_links'))!.body as {
      setup_link: { success_redirect_url: string };
    };
    const success = request.setup_link.success_redirect_url;
    expect(success).toMatch(/^https:\/\/amable-app-kapso\.acme\.workers\.dev\/setup\/connected\/[0-9a-f]{32}$/);

    // Kapso sends the admin back with the new number.
    const back = await app.fetch(
      new Request(
        `${success}?setup_link_id=x&status=completed&phone_number_id=1234567890&display_phone_number=%2B15551234567`,
      ),
    );
    expect(back.status).toBe(200);
    expect(await back.text()).toContain('+1 555-123-4567');
    expect(app.crm.data.get('kapso_number')?.value).toMatchObject({
      phone_number_id: '1234567890',
    });
    // The link works once.
    expect((await app.fetch(new Request(success))).status).toBe(400);
    expect((await app.fetch(new Request(success.replace('/setup/connected/', '/setup/failed/')))).status).toBe(
      400,
    );
  });

  it('lists, submits and deletes WhatsApp templates', async () => {
    const app = await setup();
    const list = await app.screen('/api/templates');
    expect(list.body['sandbox']).toBe(false);
    expect(
      (
        list.body['templates'] as Array<{
          name: string;
          status: string;
          rejected_reason: string | null;
        }>
      ).at(-1),
    ).toMatchObject({
      name: 'flash_sale',
      status: 'REJECTED',
      rejected_reason: 'PROMOTIONAL',
    });
    const created = await app.screen('/api/templates', {
      method: 'POST',
      body: {
        name: 'appointment_reminder',
        language: 'it',
        category: 'UTILITY',
        body: 'Ciao {{first_name}}',
        examples: { first_name: 'Ada' },
      },
    });
    expect(created).toEqual({
      status: 201,
      body: { id: '1627019861106475', status: 'PENDING', category: 'UTILITY' },
    });
    expect(app.kapso.calls.at(-1)).toMatchObject({
      method: 'POST',
      url: 'https://api.kapso.ai/meta/whatsapp/v24.0/98765432109/message_templates',
      body: { parameter_format: 'NAMED' },
    });
    expect(
      (
        await app.screen('/api/templates', {
          method: 'POST',
          body: { name: 'x', language: 'it', category: 'UTILITY', body: '{{a}}' },
        })
      ).status,
    ).toBe(422);
    app.kapso.use(fx(templateCreateInvalid));
    expect(
      await app.screen('/api/templates', {
        method: 'POST',
        body: { name: 'ok_name', language: 'it', category: 'UTILITY', body: 'Ciao' },
      }),
    ).toEqual({
      status: 422,
      body: { error: 'Invalid template format' },
    });
    expect((await app.screen('/api/templates?name=flash_sale', { method: 'DELETE' })).body).toEqual(
      { ok: true },
    );
    expect(app.kapso.calls.at(-1)?.url).toBe(
      'https://api.kapso.ai/meta/whatsapp/v24.0/98765432109/message_templates?name=flash_sale',
    );

    const sandbox = await setup({ number: SANDBOX });
    sandbox.kapso.use(fx(templatesSandbox));
    expect((await sandbox.screen('/api/templates')).body).toMatchObject({
      sandbox: true,
      templates: [],
    });
    expect((await sandbox.screen('/api/templates', { method: 'POST', body: {} })).status).toBe(422);
  });
});

describe('kapso: privacy and conformance', () => {
  it('exports and erases the WhatsApp number it keeps for a contact', async () => {
    const app = await setup();
    await app.webhook(messageReceived);
    expect(
      (
        await app.call('/privacy/data', {
          type: 'privacy.data_requested',
          data: { contact_id: 'ct_1' },
        })
      ).body,
    ).toEqual({ data: { whatsapp_number: '+393331234567' } });
    expect(
      (
        await app.call('/privacy/erasure', {
          type: 'privacy.erasure_requested',
          data: { contact_id: 'ct_1' },
        })
      ).body,
    ).toEqual({ ok: true });
    expect(app.kapso.calls.at(-1)).toMatchObject({
      method: 'DELETE',
      url: 'https://api.kapso.ai/platform/v1/whatsapp/contacts/%2B393331234567',
    });
    expect(
      (
        await app.call('/privacy/data', {
          type: 'privacy.data_requested',
          data: { contact_id: 'ct_1' },
        })
      ).body,
    ).toEqual({ data: null });
    expect(app.db.sqlite.prepare(`SELECT key FROM amable_kv WHERE key LIKE 'wa:%'`).all()).toEqual([]);
  });

  it('passes the conformance suite', async () => {
    const app = await setup();
    const results = await runConformance({
      manifest,
      fetch: (input, init) => app.fetch(new Request(input, init)),
      secret: app.install.webhookSecrets[0]!,
      installationId: app.install.id,
    });
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(passed(results)).toBe(true);
    // Test calls have no side effects.
    expect(
      app.kapso.callsTo('https://api.kapso.ai/meta/whatsapp/v24.0/1234567890/messages'),
    ).toEqual([]);
  });
});
