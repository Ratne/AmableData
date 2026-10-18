import { describe, expect, it } from 'vitest';
import { createAmableClient } from '../src/client';
import { fakeCrm, fixture, fixtureFetch, redact, routeFetch } from '../src/testing';

const list = fixture({
  provider: 'acme',
  description: 'items of a project',
  source: 'docs',
  request: { method: 'GET', url: 'https://api.acme.test/v1/projects/{id}/items' },
  response: { status: 200, body: { items: [1, 2] } },
});
const gone = fixture({
  provider: 'acme',
  description: 'webhook deleted',
  source: 'live',
  request: { method: 'DELETE', url: 'https://api.acme.test/v1/hooks/{id}' },
  response: { status: 204 },
});

describe('app testing kit', () => {
  it('answers from fixtures by method and path pattern, and reports misses', async () => {
    const provider = fixtureFetch([list, gone]);
    const ok = await provider.fetch('https://api.acme.test/v1/projects/p_1/items?page=2');
    expect(await ok.json()).toEqual({ items: [1, 2] });
    expect((await provider.fetch('https://api.acme.test/v1/hooks/h1', { method: 'DELETE' })).status).toBe(204);
    expect((await provider.fetch('https://api.acme.test/v1/projects/p_1/items/extra')).status).toBe(599);
    expect(provider.unmatched).toEqual(['GET https://api.acme.test/v1/projects/p_1/items/extra']);

    provider.use({ ...list, response: { status: 429, body: { message: 'slow down' } } });
    expect((await provider.fetch('https://api.acme.test/v1/projects/p_1/items')).status).toBe(429);
    expect(provider.callsTo('https://api.acme.test/v1/projects')).toHaveLength(3);
  });

  it('plays the CRM App API for the SDK client', async () => {
    const crm = fakeCrm();
    const fetch = routeFetch(crm.fetch, fixtureFetch([list]).fetch);
    const api = createAmableClient({ apiBase: crm.apiBase, accessToken: () => 'at', fetch });
    await api.data.set('api_key', 'k_123', { secret: true });
    expect(await api.data.get('api_key')).toMatchObject({ value: 'k_123', secret: true });
    await api.messages.inbound({ channel: 'whatsapp', external_id: 'w1', from: '+39333', text: 'Ciao' });
    await api.messages.outbound({ channel: 'whatsapp', external_id: 'w2', to: '+39333', text: 'Hi', template: { id: 'welcome:it' } });
    await api.events.fire({ key: 'opted_out', contact_id: 'ct_1' });
    expect(crm.inbound).toEqual([expect.objectContaining({ external_id: 'w1' })]);
    expect(crm.outbound).toEqual([expect.objectContaining({ template: { id: 'welcome:it' } })]);
    expect(crm.events).toEqual([{ key: 'opted_out', contact_id: 'ct_1' }]);
    await expect(api.contacts.list()).rejects.toMatchObject({ status: 501 });
    expect(crm.unhandled).toEqual(['GET /contacts']);
    // Non-CRM URLs fall through to the provider fixtures.
    expect((await fetch('https://api.acme.test/v1/projects/p/items')).status).toBe(200);
  });

  it('redacts secrets and personal values from recordings', () => {
    const recorded = {
      data: { id: 'wh_1', secret_key: 'abc', token: 'tok_live', owner_email: 'me@real.it', url: 'https://x.test/?key=live_abcdef123' },
      list: [{ phone: '+393331112222' }],
    };
    expect(redact(recorded, { secrets: ['live_abcdef123'], replace: { 'me@real.it': 'owner@example.com', '393331112222': '15550001111' } })).toEqual({
      data: { id: 'wh_1', secret_key: '[redacted]', token: '[redacted]', owner_email: 'owner@example.com', url: 'https://x.test/?key=[redacted]' },
      list: [{ phone: '+15550001111' }],
    });
  });
});
