import { verifyWebhook } from '@amable/auth';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { overrideAuthServices } from '../../src/auth/services';
import { installById } from '../../src/apps/store';
import { tenantOp } from '../../src/apps/tenant';
import { webhookService } from '../../src/webhooks/runtime';
import { AUTO_DISABLE_AFTER } from '../../src/webhooks/service';
import { stepUp } from '../helpers/harness';
import { createAppsHarness, resetAppsHarness, type AppsHarness } from './helpers';
import { bearer, installApp, type InstalledApp } from './oauth-helpers';

let h: AppsHarness;
let app: InstalledApp;

beforeEach(async () => {
  h = await createAppsHarness();
  app = await installApp(h);
});

afterEach(() => {
  resetAppsHarness();
  overrideAuthServices(null);
});

async function createContact(email = 'ada@example.com'): Promise<string> {
  const res = await app.owner.post('/api/v2/t/acme/contacts', { given_name: 'Ada', emails: [{ email }] });
  expect(res.status).toBe(201);
  return String(res.body.id);
}

describe('app storage API', () => {
  it('keeps key/value data per app, secrets encrypted at rest', async () => {
    const put = await bearer(h, 'PUT', '/api/v2/t/acme/apps/data/api_key', app.access, { value: 'sk_live_x', secret: true });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ key: 'api_key', value: 'sk_live_x', secret: true });
    await bearer(h, 'PUT', '/api/v2/t/acme/apps/data/settings', app.access, { value: { mode: 'strict' } });
    const stored = await tenantOp<Array<{ key: string; value: string }>>(h.env, 't_acme', 'apps.data.list', { appId: 'emailable' });
    expect(stored.find((e) => e.key === 'api_key')?.value).not.toContain('sk_live_x');
    const list = await bearer(h, 'GET', '/api/v2/t/acme/apps/data', app.access);
    expect(list.body.data).toEqual([
      expect.objectContaining({ key: 'api_key', value: 'sk_live_x' }),
      expect.objectContaining({ key: 'settings', value: { mode: 'strict' } }),
    ]);
    expect((await bearer(h, 'GET', '/api/v2/t/acme/apps/data/missing', app.access)).status).toBe(404);
    // Members cannot use the app-only endpoints.
    expect((await app.owner.get('/api/v2/t/acme/apps/data')).status).toBe(403);
  });

  it('stores values on records, visible to members, moved on merge', async () => {
    const id = await createContact();
    const patch = await bearer(h, 'PATCH', `/api/v2/t/acme/apps/entities/contact/${id}`, app.access, {
      values: { status: 'valid', score: 97 },
    });
    expect(patch.status).toBe(200);
    const seen = await app.owner.get(`/api/v2/t/acme/apps/entities/contact/${id}`);
    expect(seen.body.data).toEqual([
      expect.objectContaining({ app_id: 'emailable', key: 'score', value: 97 }),
      expect.objectContaining({ app_id: 'emailable', key: 'status', value: 'valid' }),
    ]);
    expect((await bearer(h, 'PATCH', '/api/v2/t/acme/apps/entities/order/nope', app.access, { values: { a: 1 } })).status).toBe(403);

    const other = await createContact('ada2@example.com');
    await tenantOp(h.env, 't_acme', 'contacts.merge', { targetId: other, sourceIds: [id] });
    const moved = await app.owner.get(`/api/v2/t/acme/apps/entities/contact/${other}`);
    expect((moved.body.data as unknown[]).length).toBe(2);
  });

  it('writes timeline entries attributed to the app', async () => {
    const id = await createContact();
    const res = await bearer(h, 'POST', '/api/v2/t/acme/apps/timeline', app.access, {
      contact_id: id,
      title: 'Email verified',
      icon: 'check',
    });
    expect(res.status).toBe(201);
    const timeline = await app.owner.get(`/api/v2/t/acme/contacts/${id}/timeline`);
    const entry = (timeline.body.data as Array<{ type: string; actor: { type: string; id: string }; data: Record<string, unknown> }>).find(
      (a) => a.type === 'app.timeline',
    );
    expect(entry).toMatchObject({ actor: { type: 'app', id: 'emailable' }, data: { title: 'Email verified', app_name: 'Emailable' } });
  });
});

describe('events to apps', () => {
  it('delivers signed events with installation, version and sequence, replayable', async () => {
    await h.drain();
    const installed = h.calls.find((c) => c.url === 'https://apps.example.com/webhooks' && c.body.includes('app.installed'));
    expect(installed).toBeDefined();
    const check = await verifyWebhook({
      secrets: [app.webhookSecret],
      header: installed!.headers.get('amable-signature'),
      rawBody: installed!.body,
      nowMs: h.clock.now,
    });
    expect(check.ok).toBe(true);
    await createContact();
    await webhookService(h.env).fanout('t_acme', [
      { id: 'evt_test_1', type: 'contact.created', occurredAt: new Date(h.clock.now).toISOString(), payload: { contactId: 'c1' } },
      { id: 'evt_test_2', type: 'order.paid', occurredAt: new Date(h.clock.now).toISOString(), payload: { orderId: 'o1' } },
    ]);
    await h.drain();
    const created = h.calls.filter((c) => c.url === 'https://apps.example.com/webhooks' && c.body.includes('"contact.created"'));
    expect(created).toHaveLength(1);
    expect(JSON.parse(created[0]!.body)).toMatchObject({ installation_id: app.installId, api_version: '2026-10', sequence: 2 });
    expect(h.calls.some((c) => c.body.includes('"order.paid"'))).toBe(false);

    const replay = await bearer(h, 'GET', '/api/v2/t/acme/apps/events?since=1', app.access);
    expect((replay.body.data as Array<{ type: string; sequence: number }>).map((e) => [e.sequence, e.type])).toEqual([
      [2, 'contact.created'],
    ]);
    // App endpoints stay out of the tenant's webhook list.
    expect((await app.owner.get('/api/v2/t/acme/webhooks')).body.data).toEqual([]);
  });

  it('pauses the app when its endpoint gets auto-disabled and tells the admins', async () => {
    h.routes.set('https://apps.example.com/webhooks', () => new Response('down', { status: 503 }));
    const service = webhookService(h.env);
    for (let i = 0; i < AUTO_DISABLE_AFTER; i += 1) {
      await service.fanout('t_acme', [
        { id: `evt_fail_${String(i)}`, type: 'contact.created', occurredAt: new Date(h.clock.now).toISOString(), payload: {} },
      ]);
      const pending = h.queue.splice(0);
      for (const message of pending) if (message.kind === 'webhooks.deliver') await service.attempt(message.deliveryId);
    }
    expect((await installById(h.env.DB, app.installId))?.status).toBe('paused');
    expect(h.emails.some((e) => e.subject.includes('paused'))).toBe(true);
    expect((await bearer(h, 'GET', '/api/v2/t/acme/contacts', app.access)).body.error).toBe('app_paused');

    await app.owner.post(`/api/t/acme/apps/installs/${app.installId}/resume`);
    expect((await installById(h.env.DB, app.installId))?.status).toBe('active');
  });
});

describe('GDPR across apps', () => {
  it('erasure wipes the contact and reaches every app with personal data', async () => {
    const id = await createContact('gdpr@example.com');
    await bearer(h, 'PATCH', `/api/v2/t/acme/apps/entities/contact/${id}`, app.access, { values: { status: 'valid' } });
    await stepUp(h, app.owner);
    const res = await app.owner.post(`/api/v2/t/acme/contacts/${id}/erase`);
    expect(res.status).toBe(200);
    expect(res.body.apps_notified).toEqual(['emailable']);
    const direct = h.calls.find((c) => c.url === 'https://apps.example.com/privacy/erasure');
    expect(JSON.parse(direct!.body)).toMatchObject({ contact_id: id, emails: ['gdpr@example.com'] });
    await h.drain();
    expect(h.calls.some((c) => c.url === 'https://apps.example.com/webhooks' && c.body.includes('privacy.erasure_requested'))).toBe(true);
    const left = await tenantOp<{ emails: string[]; phones: string[] }>(h.env, 't_acme', 'apps.privacy.facts', { contactId: id });
    expect(left).toMatchObject({ emails: [], phones: [] });
    expect(await tenantOp(h.env, 't_acme', 'apps.entity.get', { entity: 'contact', entityId: id })).toEqual([]);
    // Apps cannot erase.
    expect((await bearer(h, 'POST', `/api/v2/t/acme/contacts/${id}/erase`, app.access)).status).toBe(403);
  });

  it('data requests include what each app returns', async () => {
    const id = await createContact('access@example.com');
    h.routes.set('https://apps.example.com/privacy/data', () => Response.json({ checks: [{ at: '2026-10-01', result: 'valid' }] }));
    const res = await app.owner.post(`/api/v2/t/acme/contacts/${id}/data-request`);
    expect(res.status).toBe(200);
    expect(res.body.apps).toEqual([
      expect.objectContaining({ app_id: 'emailable', ok: true, data: { checks: [{ at: '2026-10-01', result: 'valid' }] } }),
    ]);
  });
});
