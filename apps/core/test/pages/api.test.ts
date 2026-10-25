import { ROLES, type Role } from '@amable/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app';
import { EditLock } from '../../src/edit-lock/lock';
import { fakeEditSessions } from '../helpers/edit-lock';
import { fakeTenantDbNamespace } from '../crm/helpers';
import {
  addMember,
  createHarness,
  login,
  ORIGIN,
  seedTenant,
  seedUser,
  type Harness,
  type TestClient,
} from '../helpers/harness';
import { fakeR2 } from './helpers';

const BASE = '/api/v2/t/acme';
const READERS: readonly Role[] = ['owner', 'admin', 'marketer', 'analyst', 'viewer'];
const WRITERS: readonly Role[] = ['owner', 'admin', 'marketer'];

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

let h: Harness;
const clients = {} as Record<Role, TestClient>;
const users = {} as Record<Role, string>;
const sessions = fakeEditSessions();
const locks = sessions.locks;
const forwarded = sessions.forwarded;
let pageId = '';

async function forEachRole(fn: (client: TestClient, role: Role) => Promise<number>): Promise<Record<Role, number>> {
  const out = {} as Record<Role, number>;
  for (const role of ROLES) out[role] = await fn(clients[role], role);
  return out;
}

function expectByRole(results: Record<Role, number>, allowed: readonly Role[], ok: number) {
  expect(results).toEqual(Object.fromEntries(ROLES.map((role) => [role, allowed.includes(role) ? ok : 403])));
}

async function raw(client: TestClient, method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}) {
  return app.request(
    `${ORIGIN}${path}`,
    {
      method,
      headers: {
        origin: ORIGIN,
        'x-amable-csrf': '1',
        cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        ...headers,
      },
      ...(body === undefined ? {} : { body }),
    },
    h.env,
  );
}

beforeAll(async () => {
  h = await createHarness();
  h.env.EDGE_ORIGIN = 'https://t.acme.example';
  h.env.TENANT_DB = fakeTenantDbNamespace();
  h.env.FILES = fakeR2();
  h.env.EDIT_SESSION = sessions.namespace;
  const acme = await seedTenant(h, 'acme');
  for (const role of ROLES) {
    const user = await seedUser(h, { email: `${role}@acme.test` });
    users[role] = user.id;
    await addMember(h, user.id, acme.id, role);
    clients[role] = await login(h, user.email);
  }
  const created = await clients.owner.post(`${BASE}/pages`, { title: 'Home', path: '/' });
  expect(created.status).toBe(201);
  pageId = String(created.body['id']);
});

describe('pages REST v2', () => {
  it('returns pages with their public URL and draft', async () => {
    const page = await clients.viewer.get(`${BASE}/pages/${pageId}`);
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ path: '/', host: null, draft_revision: 1, public_url: 'https://t.acme.example/p/acme' });
    const list = await clients.viewer.get(`${BASE}/pages?limit=10`);
    expect(list.body['data']).toHaveLength(1);
  });

  it('enforces pages:read / pages:write / pages:publish for all six roles', async () => {
    expectByRole(await forEachRole(async (c) => (await c.get(`${BASE}/pages`)).status), READERS, 200);
    expectByRole(
      await forEachRole(async (c, role) => (await c.post(`${BASE}/pages`, { title: role, path: `/${role}` })).status),
      WRITERS,
      201,
    );
    expectByRole(
      await forEachRole(async (c) => (await c.patch(`${BASE}/pages/${pageId}`, { seo: { title: 'Home' } })).status),
      WRITERS,
      200,
    );
    expectByRole(
      await forEachRole(async (c) => (await c.post(`${BASE}/pages/${pageId}/publish`, { note: 'go' })).status),
      WRITERS,
      200,
    );
    expectByRole(await forEachRole(async (c) => (await c.get(`${BASE}/pages/${pageId}/versions`)).status), READERS, 200);
    expectByRole(await forEachRole(async (c) => (await c.get(`${BASE}/pages/${pageId}/preview`)).status), READERS, 200);
    expectByRole(await forEachRole(async (c) => (await c.get(`${BASE}/pages/${pageId}/lock/status`)).status), READERS, 200);
    expectByRole(await forEachRole(async (c) => (await c.get(`${BASE}/savedSections`)).status), READERS, 200);
    expectByRole(
      await forEachRole(
        async (c, role) =>
          (await c.post(`${BASE}/savedSections`, { name: role, node: { id: 'n', type: 'spacer' } })).status,
      ),
      WRITERS,
      201,
    );
    expectByRole(await forEachRole(async (c) => (await c.get(`${BASE}/media`)).status), READERS, 200);
    expectByRole(
      await forEachRole(async (c) => (await raw(c, 'PUT', `${BASE}/media?filename=a.png`, PNG)).status),
      WRITERS,
      201,
    );
    expectByRole(await forEachRole(async (c) => (await c.post(`${BASE}/pages/${pageId}/unpublish`)).status), WRITERS, 200);
  });

  it('saves drafts with revisions, 409 stale_draft and 423 while someone else holds the lock', async () => {
    const page = await clients.marketer.get(`${BASE}/pages/${pageId}`);
    const base = Number(page.body['draft_revision']);
    const document = { editorKind: 'canvas', body: [{ id: 'h', type: 'heading', settings: { title: 'Hi' } }] };
    const saved = await clients.marketer.request('PUT', `${BASE}/pages/${pageId}/draft`, { document, base_revision: base });
    expect(saved).toMatchObject({ status: 200, body: { draft_revision: base + 1 } });
    const stale = await clients.marketer.request('PUT', `${BASE}/pages/${pageId}/draft`, { document, base_revision: base });
    expect(stale).toMatchObject({ status: 409, body: { error: 'stale_draft', draft_revision: base + 1 } });

    const tenantId = [...locks.keys()][0]?.split(':')[0] ?? '';
    const lock = new EditLock();
    lock.join({ connId: 'c', userId: users.admin, userName: 'Admin' }, Date.now());
    locks.set(`${tenantId}:${pageId}`, lock);
    const locked = await clients.marketer.request('PUT', `${BASE}/pages/${pageId}/draft`, { document, base_revision: base + 1 });
    expect(locked).toMatchObject({ status: 423, body: { error: 'locked' } });
    expect((await clients.marketer.patch(`${BASE}/pages/${pageId}`, { seo: { title: 'X' } })).status).toBe(423);
    expect((await clients.marketer.post(`${BASE}/pages/${pageId}/publish`, {})).status).toBe(423);
    expect((await clients.marketer.post(`${BASE}/pages/${pageId}/unpublish`)).status).toBe(423);
    expect((await clients.marketer.request('DELETE', `${BASE}/pages/${pageId}`)).status).toBe(423);
    const holder = await clients.admin.request('PUT', `${BASE}/pages/${pageId}/draft`, { document, base_revision: base + 1 });
    expect(holder.status).toBe(200);
    const status = await clients.viewer.get(`${BASE}/pages/${pageId}/lock/status`);
    expect(status.body).toMatchObject({ type: 'state', holder: { user_id: users.admin, user_name: 'Admin' }, role: 'waiting' });
  });

  it('forwards the lock WebSocket with the verified identity only', async () => {
    expect((await clients.marketer.get(`${BASE}/pages/${pageId}/lock`)).status).toBe(426);
    const res = await raw(clients.marketer, 'GET', `${BASE}/pages/${pageId}/lock`, undefined, {
      upgrade: 'websocket',
      'x-amable-user-id': 'forged',
    });
    expect(res.status).toBe(200);
    const headers = forwarded.at(-1);
    expect(headers?.get('x-amable-user-id')).toBe(users.marketer);
    expect(headers?.get('x-amable-can-takeover')).toBe('1');
    expect(headers?.get('x-amable-lock-kind')).toBe('pages');
    expect(headers?.get('x-amable-lock-resource-id')).toBe(pageId);
    expect(headers?.get('x-amable-lock-takeover-permission')).toBe('pages:publish');
    const evil = await raw(clients.marketer, 'GET', `${BASE}/pages/${pageId}/lock`, undefined, {
      upgrade: 'websocket',
      origin: 'https://evil.example',
    });
    expect(evil.status).toBe(403);
  });

  it('renders the preview as the public page', async () => {
    const preview = await clients.viewer.get(`${BASE}/pages/${pageId}/preview`);
    expect(String(preview.body['html'])).toContain('<h2 class="b-heading">Hi</h2>');
    expect(String(preview.body['html'])).toContain('<meta name="robots" content="noindex,nofollow"/>');
  });

  it('stores raw HTML pages untouched and previews them as written', async () => {
    const html = '<!doctype html><html><head><title>Raw</title></head><body><p onclick="x()">Raw</p><script>x=1</script></body></html>';
    const created = await clients.marketer.post(`${BASE}/pages`, { title: 'Raw', path: '/raw', document: { editorKind: 'html', html } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ editor_kind: 'html', draft: { editorKind: 'html', html } });
    const id = String(created.body['id']);
    const listed = await clients.viewer.get(`${BASE}/pages?q=raw`);
    expect(listed.body['data']).toEqual([expect.objectContaining({ id, editor_kind: 'html' })]);
    const preview = await clients.viewer.get(`${BASE}/pages/${id}/preview`);
    expect(preview.body['html']).toBe(html);
    const back = await clients.marketer.request('PUT', `${BASE}/pages/${id}/draft`, {
      document: { editorKind: 'canvas', body: [] },
      base_revision: Number(created.body['draft_revision']),
    });
    expect(back.status).toBe(200);
    expect((await clients.viewer.get(`${BASE}/pages/${id}`)).body['editor_kind']).toBe('canvas');
    const bad = await clients.marketer.post(`${BASE}/pages`, { title: 'Bad', path: '/bad', document: { editorKind: 'html' } });
    expect(bad.status).toBe(422);
  });

  it('accepts only real images by magic bytes, up to 10 MB, and streams them back', async () => {
    const svg = await raw(clients.owner, 'PUT', `${BASE}/media?filename=x.png`, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', {
      'content-type': 'image/png',
    });
    expect(svg.status).toBe(415);
    const html = await raw(clients.owner, 'PUT', `${BASE}/media?filename=x.gif`, '<html>GIF89a</html>', { 'content-type': 'image/gif' });
    expect(html.status).toBe(415);
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(PNG);
    expect((await raw(clients.owner, 'PUT', `${BASE}/media?filename=big.png`, big)).status).toBe(413);

    const jpeg = await raw(clients.owner, 'PUT', `${BASE}/media?filename=../../photo.jpg`, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), {
      'content-type': 'text/html',
    });
    expect(jpeg.status).toBe(201);
    const media = (await jpeg.json()) as { id: string; filename: string; content_type: string; url: string; preview_url: string };
    expect(media).toMatchObject({ filename: 'photo.jpg', content_type: 'image/jpeg' });
    expect(media.url).toMatch(/^https:\/\/t\.acme\.example\/m\/acme\/[0-9A-Z]{26}\.jpg$/);
    const content = await raw(clients.viewer, 'GET', media.preview_url);
    expect(content.status).toBe(200);
    expect(content.headers.get('x-content-type-options')).toBe('nosniff');
    expect(content.headers.get('content-disposition')).toBe('inline; filename="photo.jpg"');
    expect(new Uint8Array(await content.arrayBuffer())[0]).toBe(0xff);
    expect((await clients.viewer.delete(`${BASE}/media/${media.id}`)).status).toBe(403);
    expect((await clients.owner.delete(`${BASE}/media/${media.id}`)).status).toBe(200);
  });
});
