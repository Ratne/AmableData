import { afterEach, describe, expect, it } from 'vitest';
import { overrideAuthServices } from '../../src/auth/services';
import { webhookService } from '../../src/webhooks/runtime';
import { createAppsHarness, resetAppsHarness, type AppsHarness } from './helpers';
import { bearer, installApp, type InstalledApp } from './oauth-helpers';

const SEND = 'https://apps.example.com/channels/send';
const BASE = '/api/v2/t/acme';

afterEach(() => {
  resetAppsHarness();
  overrideAuthServices(null);
});

async function setup(): Promise<{ h: AppsHarness; installed: InstalledApp; sends: () => Array<Record<string, unknown>> }> {
  const h = await createAppsHarness();
  let n = 0;
  h.routes.set(SEND, (call) => {
    const body = JSON.parse(call.body) as { message: { text: string } };
    if (body.message.text === 'fail please') return Response.json({ error: 'number not on WhatsApp' }, { status: 422 });
    n += 1;
    return Response.json({ external_id: `wamid.${String(n)}`, status: 'sent' });
  });
  const installed = await installApp(h, {
    scopes: ['contacts:read', 'contacts:write', 'conversations:read', 'conversations:write'],
    webhooks: { endpoint: '/webhooks', events: ['message.received'] },
    extensions: {
      channels: [{ key: 'whatsapp', name: { en: 'WhatsApp' }, kind: 'whatsapp', send_endpoint: '/channels/send', address_field: 'phone' }],
    },
  });
  const sends = () => h.calls.filter((c) => c.url === SEND).map((c) => JSON.parse(c.body) as Record<string, unknown>);
  return { h, installed, sends };
}

const inbound = (h: AppsHarness, installed: InstalledApp, body: Record<string, unknown>) =>
  bearer(h, 'POST', `${BASE}/apps/messages/inbound`, installed.access, { channel: 'whatsapp', ...body });

describe('conversations', () => {
  it('turns inbound messages into threads, creating the contact once', async () => {
    const { h, installed } = await setup();
    const first = await inbound(h, installed, { external_id: 'wamid.in1', from: '+39 333 123 4567', text: 'Ciao!', contact: { given_name: 'Ada' } });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ duplicate: false });
    const contactId = String(first.body.contact_id);

    // Same provider id: stored once. Same number, other spelling: same thread.
    expect((await inbound(h, installed, { external_id: 'wamid.in1', from: '+393331234567', text: 'Ciao!' })).body).toMatchObject({ duplicate: true });
    const second = await inbound(h, installed, { external_id: 'wamid.in2', from: '00393331234567', text: 'Ci sei?' });
    expect(second.body.conversation_id).toBe(first.body.conversation_id);

    const list = await installed.owner.get(`${BASE}/conversations?status=open`);
    expect(list.body.data).toEqual([
      expect.objectContaining({
        channel: 'emailable:whatsapp',
        address: '+393331234567',
        contact: { id: contactId, name: 'Ada' },
        unread: 2,
        last_message_preview: 'Ci sei?',
        last_direction: 'in',
      }),
    ]);
    const contact = await installed.owner.get(`${BASE}/contacts/${contactId}`);
    expect(contact.body.phones).toEqual([expect.objectContaining({ number: expect.stringContaining('333') })]);
    expect((await installed.owner.get(`${BASE}/conversations/counts`)).body).toMatchObject({ open: 1, unassigned: 1, unread: 1 });

    // Known number: the existing contact is reused.
    const other = await installed.owner.post(`${BASE}/contacts`, { given_name: 'Bob', phones: [{ number: '+39 347 000 1111' }] });
    const fromBob = await inbound(h, installed, { external_id: 'wamid.in3', from: '+393470001111', text: 'Hi' });
    expect(fromBob.body.contact_id).toBe(other.body.id);

    // The app only posts on channels it declares.
    expect((await inbound(h, installed, { channel: 'sms', external_id: 'x', from: '+391', text: 'x' })).status).toBe(422);
  });

  it('sends replies through the channel app and records delivery updates', async () => {
    const { h, installed, sends } = await setup();
    const first = await inbound(h, installed, { external_id: 'wamid.in1', from: '+393331234567', text: 'Info?', contact: { given_name: 'Ada' } });
    const id = String(first.body.conversation_id);

    const reply = await installed.owner.post(`${BASE}/conversations/${id}/messages`, { text: 'Certo, dimmi' });
    expect(reply.status).toBe(201);
    expect(reply.body.data).toMatchObject({ direction: 'out', status: 'sent', external_id: 'wamid.1' });
    expect(sends()).toEqual([
      expect.objectContaining({
        channel: 'whatsapp',
        conversation_id: id,
        to: '+393331234567',
        message: expect.objectContaining({ text: 'Certo, dimmi' }),
        installation_id: installed.installId,
      }),
    ]);

    const note = await installed.owner.post(`${BASE}/conversations/${id}/messages`, { text: 'VIP, rispondere presto', note: true });
    expect(note.body.data).toMatchObject({ direction: 'note', status: 'note' });
    expect(sends()).toHaveLength(1);

    const failed = await installed.owner.post(`${BASE}/conversations/${id}/messages`, { text: 'fail please' });
    expect(failed.body.data).toMatchObject({ status: 'failed', error: 'number not on WhatsApp' });

    const read = await bearer(h, 'POST', `${BASE}/apps/messages/status`, installed.access, { channel: 'whatsapp', external_id: 'wamid.1', status: 'read' });
    expect(read.body).toMatchObject({ status: 'read' });
    // Late "delivered" after "read" does not step back.
    await bearer(h, 'POST', `${BASE}/apps/messages/status`, installed.access, { channel: 'whatsapp', external_id: 'wamid.1', status: 'delivered' });
    expect((await bearer(h, 'POST', `${BASE}/apps/messages/status`, installed.access, { channel: 'whatsapp', external_id: 'nope', status: 'read' })).status).toBe(404);

    const messages = await installed.owner.get(`${BASE}/conversations/${id}/messages`);
    expect((messages.body.data as Array<{ direction: string; status: string; text: string }>).map((m) => [m.direction, m.status])).toEqual([
      ['out', 'failed'],
      ['note', 'note'],
      ['out', 'read'],
      ['in', 'received'],
    ]);
    const conversation = await installed.owner.get(`${BASE}/conversations/${id}`);
    expect(conversation.body.data).toMatchObject({ unread: 0, last_direction: 'out', last_message_preview: 'fail please' });
  });

  it('assigns, closes, reopens on new messages and starts threads from a contact', async () => {
    const { h, installed, sends } = await setup();
    const first = await inbound(h, installed, { external_id: 'wamid.in1', from: '+393331234567', text: 'Ciao', contact: { given_name: 'Ada' } });
    const id = String(first.body.conversation_id);
    const me = (await h.env.DB.prepare(`SELECT id FROM users WHERE email = 'owner@acme.test'`).first<{ id: string }>())!.id;

    expect((await installed.owner.patch(`${BASE}/conversations/${id}`, { assigned_to: 'u_nobody' })).status).toBe(422);
    const assigned = await installed.owner.patch(`${BASE}/conversations/${id}`, { assigned_to: me });
    expect(assigned.body.data).toMatchObject({ assigned_to: me });
    expect((await installed.owner.get(`${BASE}/conversations?assigned_to=me`)).body.data).toHaveLength(1);
    expect((await installed.owner.get(`${BASE}/conversations?assigned_to=none`)).body.data).toHaveLength(0);

    expect((await installed.owner.patch(`${BASE}/conversations/${id}`, { status: 'closed' })).body.data).toMatchObject({ status: 'closed' });
    await inbound(h, installed, { external_id: 'wamid.in2', from: '+393331234567', text: 'Ancora io' });
    expect((await installed.owner.get(`${BASE}/conversations/${id}`)).body.data).toMatchObject({ status: 'open', unread: 2 });
    expect((await installed.owner.post(`${BASE}/conversations/${id}/read`, {})).body.data).toMatchObject({ unread: 0 });

    expect((await installed.owner.patch(`${BASE}/conversations/${id}`, { status: 'pending' })).body.data).toMatchObject({ status: 'pending' });
    await inbound(h, installed, { external_id: 'wamid.in3', from: '+393331234567', text: 'Eccomi' });
    expect((await installed.owner.get(`${BASE}/conversations/${id}`)).body.data).toMatchObject({ status: 'open', unread: 1 });

    const bob = await installed.owner.post(`${BASE}/contacts`, { given_name: 'Bob', phones: [{ number: '+39 347 000 1111' }] });
    const started = await installed.owner.post(`${BASE}/conversations`, { channel: 'emailable:whatsapp', contact_id: bob.body.id, text: 'Promo!' });
    expect(started.status).toBe(201);
    expect(started.body.data).toMatchObject({ address: '+393470001111', contact: { id: bob.body.id, name: 'Bob' } });
    expect(started.body.message).toMatchObject({ status: 'sent' });
    expect(sends().at(-1)).toMatchObject({ to: '+393470001111' });

    const noPhone = await installed.owner.post(`${BASE}/contacts`, { given_name: 'Carla', emails: [{ email: 'carla@example.com' }] });
    expect((await installed.owner.post(`${BASE}/conversations`, { channel: 'emailable:whatsapp', contact_id: noPhone.body.id, text: 'x' })).status).toBe(422);
    expect((await installed.owner.post(`${BASE}/conversations`, { channel: 'other-app:sms', contact_id: bob.body.id, text: 'x' })).status).toBe(422);

    const channels = await installed.owner.get(`${BASE}/conversations/channels`);
    expect(channels.body.data).toEqual([expect.objectContaining({ id: 'emailable:whatsapp', kind: 'whatsapp', address_field: 'phone', paused: false })]);
  });

  it('delivers message events to subscribed apps and erases threads with the contact', async () => {
    const { h, installed } = await setup();
    const first = await inbound(h, installed, { external_id: 'wamid.in1', from: '+393331234567', text: 'Ciao', contact: { given_name: 'Ada' } });
    const pending = (await h.env.TENANT_DB.get(h.env.TENANT_DB.idFromName('t_acme')).crm('events.pending', { type: 'system', id: null, canReadSensitive: true }, { limit: 100 })) as unknown as {
      ok: true;
      value: Array<{ id: string; type: string; occurredAt: string; payload: Record<string, unknown> }>;
    };
    const types = pending.value.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['conversation.created', 'message.received']));
    await webhookService(h.env).fanout('t_acme', pending.value as never);
    await h.drain();
    const delivered = h.calls.filter((c) => c.url === 'https://apps.example.com/webhooks' && c.body.includes('"message.received"'));
    expect(delivered).toHaveLength(1);
    expect(JSON.parse(delivered[0]!.body).data).toMatchObject({ conversationId: first.body.conversation_id, preview: 'Ciao' });

    const erased = await h.env.TENANT_DB.get(h.env.TENANT_DB.idFromName('t_acme')).crm(
      'contacts.erase',
      { type: 'system', id: null, canReadSensitive: true },
      { contactId: String(first.body.contact_id) },
    );
    expect(erased).toMatchObject({ ok: true });
    expect((await installed.owner.get(`${BASE}/conversations`)).body.data).toEqual([]);
  });
});
