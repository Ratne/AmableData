import { afterEach, describe, expect, it } from 'vitest';
import { overrideAuthServices } from '../../src/auth/services';
import { createAppsHarness, resetAppsHarness, type AppsHarness } from './helpers';
import { bearer, installApp, type InstalledApp } from './oauth-helpers';

const APP = 'https://apps.example.com';
const BASE = '/api/v2/t/acme';

afterEach(() => {
  resetAppsHarness();
  overrideAuthServices(null);
});

const TEMPLATES = [
  { id: 'welcome:it', name: 'welcome', language: 'it', category: 'UTILITY', text: 'Ciao {{name}}, come possiamo aiutarti?', params: [{ key: 'name', example: 'Ada' }] },
  { id: 'broken', name: '', language: null, category: null, text: 'x', params: [] },
];

async function setup(): Promise<{ h: AppsHarness; installed: InstalledApp; sends: () => Array<Record<string, unknown>> }> {
  const h = await createAppsHarness();
  h.routes.set(`${APP}/channels/send`, (call) => {
    const body = JSON.parse(call.body) as { message: { id: string; template?: { params: Record<string, string> } } };
    const rendered = body.message.template === undefined ? undefined : `Ciao ${body.message.template.params['name'] ?? ''}, come possiamo aiutarti?`;
    return Response.json({ external_id: `wamid.${body.message.id}`, status: 'sent', ...(rendered === undefined ? {} : { text: rendered }) });
  });
  h.routes.set(`${APP}/channels/templates`, () => Response.json({ templates: TEMPLATES }));
  h.routes.set(`${APP}/options/templates`, (call) => {
    const body = JSON.parse(call.body) as { kind: string; key: string; property: string };
    return Response.json({ options: [{ value: 'welcome:it', label: `welcome (it) for ${body.key}.${body.property}` }, { value: '' }] });
  });
  const installed = await installApp(h, {
    scopes: ['contacts:read', 'contacts:write', 'conversations:read', 'conversations:write'],
    extensions: {
      channels: [
        {
          key: 'whatsapp',
          name: { en: 'WhatsApp' },
          kind: 'whatsapp',
          send_endpoint: '/channels/send',
          address_field: 'phone',
          reply_window_hours: 24,
          templates_endpoint: '/channels/templates',
        },
      ],
      automation_actions: [
        {
          key: 'send_template',
          name: { en: 'Send template' },
          endpoint: '/actions/send-template',
          input_schema: {
            type: 'object',
            properties: { template: { type: 'string', title: { en: 'Template' }, options_endpoint: '/options/templates' } },
            required: ['template'],
          },
        },
      ],
    },
  });
  const sends = () => h.calls.filter((c) => c.url === `${APP}/channels/send`).map((c) => JSON.parse(c.body) as Record<string, unknown>);
  return { h, installed, sends };
}

describe('channel templates and reply windows', () => {
  it('refuses free text once the window is closed and reopens it with a template', async () => {
    const { h, installed, sends } = await setup();
    const dayAgo = new Date(h.clock.now - 25 * 3_600_000).toISOString();
    const inbound = await bearer(h, 'POST', `${BASE}/apps/messages/inbound`, installed.access, {
      channel: 'whatsapp',
      external_id: 'wamid.old',
      from: '+393331234567',
      text: 'Ciao',
      contact: { given_name: 'Ada' },
      sent_at: dayAgo,
    });
    const id = String(inbound.body.conversation_id);

    const channels = await installed.owner.get(`${BASE}/conversations/channels`);
    expect(channels.body.data).toEqual([expect.objectContaining({ id: 'emailable:whatsapp', reply_window_hours: 24, templates: true })]);
    expect((await installed.owner.get(`${BASE}/conversations/${id}`)).body.data).toMatchObject({ last_inbound_at: dayAgo });

    const refused = await installed.owner.post(`${BASE}/conversations/${id}/messages`, { text: 'Sei ancora lì?' });
    expect(refused.status).toBe(422);
    expect(sends()).toHaveLength(0);
    // Notes are never sent: always allowed.
    expect((await installed.owner.post(`${BASE}/conversations/${id}/messages`, { text: 'Richiamare', note: true })).status).toBe(201);

    const templates = await installed.owner.get(`${BASE}/conversations/channels/emailable:whatsapp/templates`);
    expect(templates.body.data).toEqual([TEMPLATES[0]]);

    const sent = await installed.owner.post(`${BASE}/conversations/${id}/messages`, {
      text: 'Ciao Ada, come possiamo aiutarti?',
      template: { id: 'welcome:it', params: { name: 'Ada' } },
    });
    expect(sent.status).toBe(201);
    expect(sent.body.data).toMatchObject({ status: 'sent', template: { id: 'welcome:it', params: { name: 'Ada' } }, text: 'Ciao Ada, come possiamo aiutarti?' });
    expect(sends().at(-1)).toMatchObject({ message: { template: { id: 'welcome:it', params: { name: 'Ada' } } } });

    // The contact answers: the window is open again for free text.
    await bearer(h, 'POST', `${BASE}/apps/messages/inbound`, installed.access, { channel: 'whatsapp', external_id: 'wamid.new', from: '+393331234567', text: 'Sì!' });
    expect((await installed.owner.post(`${BASE}/conversations/${id}/messages`, { text: 'Perfetto' })).body.data).toMatchObject({ status: 'sent' });
  });

  it('opens new threads with a template only, and the app text replaces the placeholder', async () => {
    const { installed, sends } = await setup();
    const bob = await installed.owner.post(`${BASE}/contacts`, { given_name: 'Bob', phones: [{ number: '+39 347 000 1111' }] });
    const free = await installed.owner.post(`${BASE}/conversations`, { channel: 'emailable:whatsapp', contact_id: bob.body.id, text: 'Promo!' });
    expect(free.status).toBe(422);
    // Refused atomically: no empty thread is left behind.
    expect((await installed.owner.get(`${BASE}/conversations`)).body.data).toEqual([]);

    const started = await installed.owner.post(`${BASE}/conversations`, {
      channel: 'emailable:whatsapp',
      contact_id: bob.body.id,
      template: { id: 'welcome:it', params: { name: 'Bob' } },
    });
    expect(started.status).toBe(201);
    expect(started.body.message).toMatchObject({ text: 'Ciao Bob, come possiamo aiutarti?', template: { id: 'welcome:it' } });
    expect(started.body.data).toMatchObject({ last_message_preview: 'Ciao Bob, come possiamo aiutarti?', last_inbound_at: null });
    expect(sends()).toHaveLength(1);
  });

  it('records messages the app sent on its own, once, without touching unread', async () => {
    const { h, installed } = await setup();
    const first = await bearer(h, 'POST', `${BASE}/apps/messages/inbound`, installed.access, {
      channel: 'whatsapp',
      external_id: 'wamid.in1',
      from: '+393331234567',
      text: 'Ciao',
      contact: { given_name: 'Ada' },
    });
    const outbound = (external_id: string) =>
      bearer(h, 'POST', `${BASE}/apps/messages/outbound`, installed.access, {
        channel: 'whatsapp',
        external_id,
        to: '+39 333 123 4567',
        text: 'Promemoria appuntamento',
        template: { id: 'reminder:it', params: { day: 'lunedì' } },
      });
    const recorded = await outbound('wamid.auto1');
    expect(recorded.status).toBe(201);
    expect(recorded.body).toMatchObject({ conversation_id: first.body.conversation_id, contact_id: first.body.contact_id, duplicate: false });
    expect((await outbound('wamid.auto1')).body).toMatchObject({ duplicate: true });

    const conversation = await installed.owner.get(`${BASE}/conversations/${String(first.body.conversation_id)}`);
    expect(conversation.body.data).toMatchObject({ unread: 1, last_direction: 'out', last_message_preview: 'Promemoria appuntamento' });
    const messages = await installed.owner.get(`${BASE}/conversations/${String(first.body.conversation_id)}/messages`);
    expect((messages.body.data as unknown[])[0]).toMatchObject({ direction: 'out', status: 'sent', author: { type: 'app' }, template: { id: 'reminder:it' } });

    // Delivery updates find it by provider id like any other outbound message.
    const read = await bearer(h, 'POST', `${BASE}/apps/messages/status`, installed.access, { channel: 'whatsapp', external_id: 'wamid.auto1', status: 'read' });
    expect(read.body).toMatchObject({ status: 'read' });
    expect((await bearer(h, 'POST', `${BASE}/apps/messages/outbound`, installed.access, { channel: 'sms', external_id: 'x', to: '+391234567', text: 'x' })).status).toBe(422);
  });

  it('asks the app for the dynamic options of an action input', async () => {
    const { h, installed } = await setup();
    const options = await installed.owner.get(`/api/t/acme/apps/extensions/emailable/options?kind=action&key=send_template&property=template`);
    expect(options.status).toBe(200);
    expect(options.body).toEqual({ data: [{ value: 'welcome:it', label: 'welcome (it) for send_template.template' }], unavailable: false });
    const call = h.calls.find((c) => c.url === `${APP}/options/templates`)!;
    expect(call.headers.get('amable-signature')).toBeTruthy();
    expect((await installed.owner.get(`/api/t/acme/apps/extensions/emailable/options?kind=action&key=send_template&property=other`)).status).toBe(404);
    expect((await installed.owner.get(`/api/t/acme/apps/extensions/emailable/options?kind=action&key=send_template`)).status).toBe(422);

    h.routes.set(`${APP}/options/templates`, () => new Response('down', { status: 503 }));
    expect((await installed.owner.get(`/api/t/acme/apps/extensions/emailable/options?kind=action&key=send_template&property=template`)).body).toEqual({
      data: [],
      unavailable: true,
    });
  });
});
