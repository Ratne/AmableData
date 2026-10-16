import { afterEach, describe, expect, it } from 'vitest';
import { ATTACHMENT_MAX_BYTES } from '../../../src/platform/support/proxy';
import { INSTALLATION_ID, json, multipart, world, type World } from './helpers';

let current: World | null = null;
afterEach(() => current?.cp.restore());

async function setup(options: { licensed?: boolean } = {}) {
  current = await world(options);
  return current;
}

const ticket = (tenantId: string, id = 'tk_1') => ({
  id,
  source: 'crm',
  subject: 'Broken import',
  category: 'bug',
  status: 'open',
  tenantId,
  installationId: INSTALLATION_ID,
  requester: { id: 'u', name: 'Olga Owner', kind: 'crm_user' },
  createdAt: '2026-10-15T12:00:00.000Z',
  updatedAt: '2026-10-15T12:00:00.000Z',
  lastMessageAt: '2026-10-15T12:00:00.000Z',
  resolvedAt: null,
});

describe('support proxy', () => {
  it('answers 404 platform_unavailable on an open source installation', async () => {
    const { owner, cp } = await setup({ licensed: false });
    for (const path of ['/api/t/acme/platform/support/tickets', '/api/t/acme/platform/ideas']) {
      const res = await owner.get(path);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'platform_unavailable' });
    }
    expect(cp.calls).toHaveLength(0);
  });

  it('creates and lists tickets with the CRM user as actor (license auth, tenant filter)', async () => {
    const { owner, viewer, cp, acme } = await setup();
    cp.routes['POST /v1/installation/support/tickets'] = () => json({ ticket: ticket(acme.id) }, 201);
    cp.routes['GET /v1/installation/support/tickets'] = () => json({ tickets: [ticket(acme.id)] });

    const created = await viewer.post('/api/t/acme/platform/support/tickets', {
      subject: 'Broken import',
      category: 'bug',
      body: 'The CSV import fails on row 3.',
    });
    expect(created.status).toBe(201);
    const call = cp.calls.find((c) => c.method === 'POST');
    expect(call?.json).toEqual({
      actor: { userId: expect.any(String), name: 'Vera Viewer', email: 'viewer@acme.test', role: 'viewer', tenantId: acme.id },
      subject: 'Broken import',
      category: 'bug',
      body: 'The CSV import fails on row 3.',
    });

    const list = await owner.get('/api/t/acme/platform/support/tickets');
    expect(list.status).toBe(200);
    expect(list.body.tickets).toHaveLength(1);
    expect(cp.calls.at(-1)?.search).toBe(`?tenantId=${acme.id}`);

    const invalid = await owner.post('/api/t/acme/platform/support/tickets', { subject: 'x', category: 'nope', body: '' });
    expect(invalid.status).toBe(422);
  });

  it('hides tickets of another tenant and forwards replies only for own tickets', async () => {
    const { owner, cp, acme, other } = await setup();
    cp.routes['GET /v1/installation/support/tickets/tk_1'] = () =>
      json({ ticket: ticket(acme.id), messages: [], attachments: [] });
    cp.routes['GET /v1/installation/support/tickets/tk_2'] = () =>
      json({ ticket: ticket(other.id, 'tk_2'), messages: [], attachments: [] });
    cp.routes['POST /v1/installation/support/tickets/tk_1/messages'] = () =>
      json({ message: { id: 'm1', authorKind: 'crm_user', authorName: 'Olga', body: 'hi', createdAt: '' } }, 201);

    expect((await owner.get('/api/t/acme/platform/support/tickets/tk_1')).status).toBe(200);
    expect((await owner.get('/api/t/acme/platform/support/tickets/tk_2')).status).toBe(404);
    expect((await owner.post('/api/t/acme/platform/support/tickets/tk_2/messages', { body: 'x' })).status).toBe(404);
    const reply = await owner.post('/api/t/acme/platform/support/tickets/tk_1/messages', { body: 'More details' });
    expect(reply.status).toBe(201);
    expect(cp.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('uploads attachments as multipart (size capped) and serves downloads as attachments', async () => {
    const w = await setup();
    const { h, owner, cp, acme } = w;
    cp.routes['GET /v1/installation/support/tickets/tk_1'] = () =>
      json({
        ticket: ticket(acme.id),
        messages: [],
        attachments: [{ id: 'att_1', ticketId: 'tk_1', filename: 'log.txt', contentType: 'text/plain', size: 5 }],
      });
    cp.routes['POST /v1/installation/support/tickets/tk_1/attachments'] = () =>
      json({ attachment: { id: 'att_2', filename: 'shot.png' } }, 201);
    cp.routes['GET /v1/installation/support/attachments/att_1'] = () => new Response('hello');

    const form = new FormData();
    form.set('file', new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' }));
    const up = await multipart(h, owner, '/api/t/acme/platform/support/tickets/tk_1/attachments', form);
    expect(up.status).toBe(201);
    const forwarded = cp.calls.find((c) => c.method === 'POST')?.form;
    expect(forwarded?.get('file')).toBeInstanceOf(File);
    expect(JSON.parse(String(forwarded?.get('actor')))).toMatchObject({ email: 'owner@acme.test', role: 'owner' });

    const big = new FormData();
    big.set('file', new File([new Uint8Array(ATTACHMENT_MAX_BYTES + 1)], 'big.bin'));
    const tooBig = await multipart(h, owner, '/api/t/acme/platform/support/tickets/tk_1/attachments', big);
    expect(tooBig.status).toBe(413);

    const down = await owner.get('/api/t/acme/platform/support/tickets/tk_1/attachments/att_1');
    expect(down.status).toBe(200);
    expect(down.headers.get('content-disposition')).toBe('attachment; filename="log.txt"');
    expect((await owner.get('/api/t/acme/platform/support/tickets/tk_1/attachments/att_9')).status).toBe(404);
  });

  it('lists ideas with the installation voter key, proposes and votes', async () => {
    const { owner, cp } = await setup();
    const idea = { id: 'i1', title: 'Dark mode', body: '', status: 'planned', releasedIn: null, votes: 1, votedByMe: true, createdAt: '' };
    cp.routes['GET /v1/installation/ideas'] = () => json({ ideas: [idea], changelog: [{ id: 'c1', title: 'v2' }] });
    cp.routes['POST /v1/installation/ideas'] = () => json({ idea }, 201);
    cp.routes['POST /v1/installation/ideas/i1/vote'] = () => json({ ok: true, idea });
    cp.routes['DELETE /v1/installation/ideas/i1/vote'] = () => json({ ok: true, idea: { ...idea, votes: 0 } });

    const list = await owner.get('/api/t/acme/platform/ideas');
    expect(list.body).toMatchObject({ ideas: [idea], changelog: [{ id: 'c1' }] });
    expect(decodeURIComponent(cp.calls[0]?.search ?? '')).toMatch(new RegExp(`^\\?voterKey=inst:${INSTALLATION_ID}:`));

    expect((await owner.post('/api/t/acme/platform/ideas', { title: 'Dark mode', body: '' })).status).toBe(201);
    expect((await owner.post('/api/t/acme/platform/ideas/i1/vote')).body).toMatchObject({ ok: true });
    const unvote = await owner.delete('/api/t/acme/platform/ideas/i1/vote');
    expect(unvote.body).toMatchObject({ idea: { votes: 0 } });
    expect(cp.calls.at(-1)?.json).toMatchObject({ actor: { email: 'owner@acme.test' } });
  });

  it('maps an unreachable control plane to 503 and suspended services to 402', async () => {
    const { owner, cp } = await setup();
    cp.down = true;
    expect((await owner.get('/api/t/acme/platform/ideas')).body).toEqual({ error: 'platform_unreachable' });
    cp.down = false;
    cp.routes['GET /v1/installation/ideas'] = () => json({ error: 'services_suspended' }, 402);
    expect((await owner.get('/api/t/acme/platform/ideas')).status).toBe(402);
  });
});
