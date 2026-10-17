import { generateAppKey, signPayload } from '@amable/app-sdk';
import { describe, expect, it } from 'vitest';
import { passed, runConformance } from '../../../../packages/app-cli/src/conformance';
import manifest from '../manifest.json';
import { createWorker } from '../src/app';
import { normalizeEndpoint, parseParameters, parseWebhook, type Fetch } from '../src/wati';

const SECRET = 'whsec_wati_test';
const ENDPOINT = 'https://live-mt-server.wati.io/123456';
const HOOK_TOKEN = 'a'.repeat(64);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call {
  url: string;
  method: string;
  body: unknown;
}

async function setup(options: { configured?: boolean } = {}) {
  const kv = new Map<string, string>();
  const store = {
    get: async (key: string) => kv.get(key) ?? null,
    put: async (key: string, value: string) => void kv.set(key, value),
    delete: async (key: string) => void kv.delete(key),
  };
  const installId = `ai_${Math.random().toString(36).slice(2, 10)}`;
  kv.set(
    `install:${installId}`,
    JSON.stringify({
      id: installId,
      origin: 'https://crm.example',
      tenant: { id: 't1', slug: 'acme' },
      apiBase: 'https://crm.example/api/v2/t/acme',
      scopes: manifest.scopes,
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: Date.now() + 3_600_000,
      webhookSecrets: [SECRET],
    }),
  );
  kv.set(`hook:${installId}`, HOOK_TOKEN);
  const calls: Call[] = [];
  const outbound: Fetch = async (input, init) => {
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
    calls.push({ url: input, method: init?.method ?? 'GET', body });
    if (input.endsWith('/apps/data/wati')) {
      return options.configured === false ? json({ error: 'not_found' }, 404) : json({ key: 'wati', value: { endpoint: ENDPOINT, token: 'tok' }, secret: true });
    }
    if (input.startsWith(`${ENDPOINT}/api/v1/sendSessionMessage/`)) {
      const text = new URL(input).searchParams.get('messageText');
      return text === 'late'
        ? json({ result: false, info: 'Ticket has expired, use a template' })
        : json({ result: true, message: { whatsappMessageId: 'wamid.out1', text } });
    }
    if (input.startsWith(`${ENDPOINT}/api/v1/sendTemplateMessage`)) return json({ result: true, id: 'wamid.tpl1' });
    if (input === 'https://crm.example/api/v2/t/acme/apps/messages/inbound') {
      return json({ conversation_id: 'cv1', message_id: 'm1', contact_id: 'c1', duplicate: false }, 201);
    }
    if (input === 'https://crm.example/api/v2/t/acme/apps/messages/status') {
      return (body as { external_id: string }).external_id === 'wamid.unknown' ? json({ error: 'not_found' }, 404) : json({ message_id: 'm2', status: 'read' });
    }
    if (input === 'https://crm.example/api/v2/t/acme/apps/events') return json({ event_id: 'e1', event: 'app.wati.message_received', matched: 1 }, 202);
    return json({ error: 'unexpected' }, 500);
  };
  const env = { APP_KEYS: JSON.stringify([await generateAppKey()]), INSTALLS: store };
  const worker = createWorker({ fetch: outbound });
  const fetch = (input: string, init?: RequestInit) => worker.fetch(new Request(input, init), env);
  const signed = async (path: string, payload: Record<string, unknown>) => {
    const body = JSON.stringify({ installation_id: installId, tenant: 'acme', api_version: '2026-10', ...payload });
    const response = await fetch(`${manifest.base_url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Amable-Signature': await signPayload(SECRET, body), 'Amable-Installation': installId },
      body,
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const hook = (body: unknown, token = HOOK_TOKEN) =>
    fetch(`${manifest.base_url}/wati/webhook/${installId}/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { fetch, signed, hook, calls, installId };
}

describe('wati app', () => {
  it('parses WATI webhooks, endpoints and template parameters', () => {
    expect(
      parseWebhook({ eventType: 'message', id: 'x1', whatsappMessageId: 'wamid.in1', waId: '393331234567', text: 'Ciao', senderName: 'Ada', timestamp: '1760000000', owner: false }),
    ).toEqual({ kind: 'message', externalId: 'wamid.in1', from: '+393331234567', text: 'Ciao', senderName: 'Ada', sentAt: '2025-10-09T08:53:20.000Z' });
    expect(parseWebhook({ eventType: 'message', whatsappMessageId: 'w', waId: '393331234567', type: 'image', text: '' })).toMatchObject({ text: '[image]' });
    expect(parseWebhook({ eventType: 'message', whatsappMessageId: 'w', waId: '393331234567', text: 'from operator', owner: true })).toEqual({ kind: 'ignored' });
    expect(parseWebhook({ eventType: 'sentMessageREAD_v2', whatsappMessageId: 'wamid.out1' })).toEqual({ kind: 'status', externalId: 'wamid.out1', status: 'read', error: null });
    expect(parseWebhook({ eventType: 'sentMessageFAILED', id: 'w2', failedDetail: 'not on WhatsApp' })).toMatchObject({ status: 'failed', error: 'not on WhatsApp' });
    expect(parseWebhook({ eventType: 'templateMessageSent', id: 'w3' })).toEqual({ kind: 'ignored' });

    expect(normalizeEndpoint('https://live-mt-server.wati.io/123456/api/v1/')).toBe(ENDPOINT);
    expect(normalizeEndpoint('https://evil.example/123456')).toBeNull();
    expect(normalizeEndpoint('http://live-mt-server.wati.io/1')).toBeNull();
    expect(parseParameters('name = Ada\ncode=X=1\nbroken\n=nope')).toEqual([
      { name: 'name', value: 'Ada' },
      { name: 'code', value: 'X=1' },
    ]);
  });

  it('sends replies and templates through WATI, reporting refusals to the CRM', async () => {
    const app = await setup();
    const sent = await app.signed('/channels/send', { channel: 'whatsapp', to: '+393331234567', message: { id: 'm1', text: 'Ciao Ada' } });
    expect(sent).toEqual({ status: 200, body: { external_id: 'wamid.out1', status: 'sent' } });
    expect(app.calls.find((c) => c.url.includes('sendSessionMessage'))!.url).toContain('/sendSessionMessage/393331234567?messageText=Ciao+Ada');

    const late = await app.signed('/channels/send', { channel: 'whatsapp', to: '+393331234567', message: { id: 'm2', text: 'late' } });
    expect(late).toEqual({ status: 422, body: { error: 'Ticket has expired, use a template' } });

    const template = await app.signed('/actions/send-template', {
      action: 'send_template',
      input: { template_name: 'welcome', parameters: 'name=Ada' },
      contact: { id: 'c1', phone: '+39 333 123 4567' },
    });
    expect(template).toEqual({ status: 200, body: { message_id: 'wamid.tpl1' } });
    expect(app.calls.find((c) => c.url.includes('sendTemplateMessage'))).toMatchObject({
      url: `${ENDPOINT}/api/v1/sendTemplateMessage?whatsappNumber=393331234567`,
      body: { template_name: 'welcome', broadcast_name: 'amable_welcome', parameters: [{ name: 'name', value: 'Ada' }] },
    });
    expect((await app.signed('/actions/send-template', { input: { template_name: 'welcome' }, contact: { id: 'c1', phone: null } })).status).toBe(422);
  });

  it('refuses to send before WATI is configured', async () => {
    const app = await setup({ configured: false });
    const sent = await app.signed('/channels/send', { channel: 'whatsapp', to: '+393331234567', message: { id: 'm1', text: 'x' } });
    expect(sent.status).toBe(422);
    expect(app.calls.some((c) => c.url.startsWith(ENDPOINT))).toBe(false);
  });

  it('turns WATI webhooks into inbox messages, triggers and delivery updates', async () => {
    const app = await setup();
    expect((await app.hook({ eventType: 'message', whatsappMessageId: 'wamid.in1', waId: '393331234567', text: 'Ciao' }, 'b'.repeat(64))).status).toBe(404);

    const received = await app.hook({ eventType: 'message', whatsappMessageId: 'wamid.in1', waId: '393331234567', text: 'Ciao', senderName: 'Ada' });
    expect(received.status).toBe(200);
    expect(app.calls.find((c) => c.url.endsWith('/apps/messages/inbound'))!.body).toEqual({
      channel: 'whatsapp',
      external_id: 'wamid.in1',
      from: '+393331234567',
      text: 'Ciao',
      contact: { given_name: 'Ada' },
    });
    expect(app.calls.find((c) => c.url.endsWith('/apps/events'))!.body).toEqual({
      key: 'message_received',
      contact_id: 'c1',
      event_id: 'wamid.in1',
      data: { text: 'Ciao' },
    });

    expect((await app.hook({ eventType: 'sentMessageREAD_v2', whatsappMessageId: 'wamid.out1' })).status).toBe(200);
    expect(app.calls.find((c) => c.url.endsWith('/apps/messages/status'))!.body).toEqual({ channel: 'whatsapp', external_id: 'wamid.out1', status: 'read' });
    // Delivery updates of template sends (not in the inbox) are fine too.
    expect((await app.hook({ eventType: 'sentMessageDELIVERED_v2', whatsappMessageId: 'wamid.unknown' })).status).toBe(200);
  });

  it('passes the conformance suite', async () => {
    const app = await setup();
    const results = await runConformance({ manifest, fetch: app.fetch, secret: SECRET, installationId: app.installId });
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(passed(results)).toBe(true);
  });
});
