import { createSecretBox, randomBytes, toBase64, verifyWebhook } from '@amable/auth';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { overrideAuthServices } from '../src/auth/services';
import { listOperations, mergedOpenApiDocument } from '../src/developers/openapi';
import { overrideWebhookDeps } from '../src/webhooks/runtime';
import {
  AUTO_DISABLE_AFTER,
  MAX_ATTEMPTS,
  RETRY_DELAYS_S,
  WebhookService,
  type WebhookDeps,
  type WebhookMessage,
} from '../src/webhooks/service';
import { addMember, createHarness, login, seedTenant, seedUser, stepUp, type Harness } from './helpers/harness';

interface Received {
  url: string;
  headers: Headers;
  body: string;
}

let h: Harness;
let queue: Array<{ message: WebhookMessage; delay: number | undefined }>;
let received: Received[];
let respond: (call: number) => Response | Promise<Response>;
let seq = 0;

async function deps(): Promise<WebhookDeps> {
  const box = await createSecretBox(toBase64(randomBytes(32)));
  return {
    db: h.env.DB,
    box: () => Promise.resolve(box),
    enqueue: (message, delay) => {
      queue.push({ message, delay });
      return Promise.resolve();
    },
    fetch: async (input, init) => {
      received.push({
        url: input,
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? init.body : '',
      });
      return respond(received.length);
    },
    now: () => h.clock.now,
    newId: () => `id_${String(++seq).padStart(6, '0')}`,
  };
}

const event = (n: number, type = 'contact.created') => ({
  id: `evt_${String(n)}`,
  type,
  occurredAt: new Date(Date.UTC(2026, 9, 15)).toISOString(),
  payload: { contactId: `c_${String(n)}` },
});

beforeEach(async () => {
  h = await createHarness();
  await seedTenant(h, 'acme');
  queue = [];
  received = [];
  respond = () => new Response('ok', { status: 200 });
});

afterEach(() => {
  overrideWebhookDeps(null);
  overrideAuthServices(null);
});

describe('webhook endpoints', () => {
  it('stores the signing secret encrypted and returns it once', async () => {
    const service = new WebhookService(await deps());
    const { endpoint, secret } = await service.create('t_acme', {
      url: 'https://hooks.example.com/in',
      event_types: ['contact.created'],
      createdBy: null,
    });
    expect(secret).toMatch(/^whsec_/);
    expect(endpoint.secret_hint).toBe(secret.slice(-4));
    const row = await h.env.DB.prepare(`SELECT secret FROM webhook_endpoints`).first<{ secret: string }>();
    expect(row?.secret).not.toContain(secret);
    expect(JSON.stringify(await service.list('t_acme'))).not.toContain(secret);
  });

  it('rejects private, loopback and unknown-event endpoints', async () => {
    const service = new WebhookService(await deps());
    for (const url of ['http://127.0.0.1:9000/x', 'http://10.0.0.5/x', 'https://localhost/x', 'ftp://a.example.com']) {
      await expect(
        service.create('t_acme', { url, event_types: ['*'], createdBy: null }),
      ).rejects.toMatchObject({ code: 'invalid_url' });
    }
    await expect(
      service.create('t_acme', { url: 'https://a.example.com', event_types: ['nope.event'], createdBy: null }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('fan-out and delivery', () => {
  it('creates one delivery per subscribed endpoint and event, idempotently', async () => {
    const service = new WebhookService(await deps());
    await service.create('t_acme', { url: 'https://a.example.com/h', event_types: ['contact.created'], createdBy: null });
    await service.create('t_acme', { url: 'https://b.example.com/h', event_types: ['*'], createdBy: null });
    const events = [event(1), event(2, 'order.paid')];
    expect(await service.fanout('t_acme', events)).toBe(3);
    expect(await service.fanout('t_acme', events)).toBe(0);
    expect(queue.filter((q) => q.message.kind === 'webhooks.deliver')).toHaveLength(3);
  });

  it('delivers bookings as appointment.booked, also to endpoints saved with the retired booking.created', async () => {
    const service = new WebhookService(await deps());
    const { endpoint } = await service.create('t_acme', {
      url: 'https://a.example.com/h',
      event_types: ['booking.created'],
      createdBy: null,
    });
    expect(endpoint.event_types).toEqual(['appointment.booked']);
    await h.env.DB.prepare(`UPDATE webhook_endpoints SET event_types = ?`).bind('["booking.created"]').run();
    expect(await service.fanout('t_acme', [event(1, 'appointment.booked')])).toBe(1);
  });

  it('publishes nothing without active endpoints and chunks the fan-out', async () => {
    const service = new WebhookService(await deps());
    await service.publish('t_acme', [event(1)]);
    expect(queue).toHaveLength(0);
    await service.create('t_acme', { url: 'https://a.example.com/h', event_types: ['*'], createdBy: null });
    await service.publish('t_acme', Array.from({ length: 45 }, (_, i) => event(i)));
    expect(queue.map((q) => q.message.kind)).toEqual(['webhooks.fanout', 'webhooks.fanout', 'webhooks.fanout']);
  });

  it('signs every attempt with HMAC + timestamp (verifiable by the receiver)', async () => {
    const service = new WebhookService(await deps());
    const { secret } = await service.create('t_acme', {
      url: 'https://a.example.com/h',
      event_types: ['*'],
      createdBy: null,
    });
    await service.fanout('t_acme', [event(7)]);
    const deliver = queue.find((q) => q.message.kind === 'webhooks.deliver');
    if (deliver?.message.kind !== 'webhooks.deliver') throw new Error('no delivery queued');
    expect(await service.attempt(deliver.message.deliveryId)).toBe('succeeded');
    const call = received[0];
    if (call === undefined) throw new Error('no request');
    expect(JSON.parse(call.body)).toMatchObject({ id: 'evt_7', type: 'contact.created', tenant: 'acme', data: { contactId: 'c_7' } });
    expect(call.headers.get('amable-event')).toBe('contact.created');
    const verified = await verifyWebhook({
      secrets: [secret],
      header: call.headers.get('amable-signature'),
      rawBody: call.body,
      nowMs: h.clock.now,
    });
    expect(verified.ok).toBe(true);
    const wrong = await verifyWebhook({
      secrets: ['whsec_other'],
      header: call.headers.get('amable-signature'),
      rawBody: call.body,
      nowMs: h.clock.now,
    });
    expect(wrong.ok).toBe(false);
  });

  it('retries with backoff, then gives up after the last attempt', async () => {
    respond = () => new Response('boom', { status: 503 });
    const service = new WebhookService(await deps());
    await service.create('t_acme', { url: 'https://a.example.com/h', event_types: ['*'], createdBy: null });
    await service.fanout('t_acme', [event(1)]);
    const first = queue.shift();
    if (first?.message.kind !== 'webhooks.deliver') throw new Error('no delivery queued');
    const id = first.message.deliveryId;
    const delays: Array<number | undefined> = [];
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      const status = await service.attempt(id);
      expect(status).toBe(i === MAX_ATTEMPTS - 1 ? 'failed' : 'retrying');
      const next = queue.shift();
      if (next !== undefined) delays.push(next.delay);
    }
    expect(delays).toEqual([...RETRY_DELAYS_S]);
    const detail = await service.delivery('t_acme', id);
    expect(detail).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS, last_status: 503, last_error: 'HTTP 503' });
  });

  it('auto-disables an endpoint after repeated failures, and a 410 disables at once', async () => {
    respond = () => new Response('', { status: 500 });
    const service = new WebhookService(await deps());
    const { endpoint } = await service.create('t_acme', { url: 'https://a.example.com/h', event_types: ['*'], createdBy: null });
    await service.fanout('t_acme', Array.from({ length: AUTO_DISABLE_AFTER }, (_, i) => event(i)));
    const ids = queue.flatMap((q) => (q.message.kind === 'webhooks.deliver' ? [q.message.deliveryId] : []));
    for (const id of ids) await service.attempt(id);
    const disabled = await service.get('t_acme', endpoint.id);
    expect(disabled).toMatchObject({ status: 'disabled', disabled_reason: 'failures', consecutive_failures: AUTO_DISABLE_AFTER });

    const enabled = await service.update('t_acme', endpoint.id, { status: 'active' });
    expect(enabled).toMatchObject({ status: 'active', consecutive_failures: 0, disabled_reason: null });

    respond = () => new Response('', { status: 410 });
    queue = [];
    await service.fanout('t_acme', [event(99)]);
    const deliver = queue.find((q) => q.message.kind === 'webhooks.deliver');
    if (deliver?.message.kind !== 'webhooks.deliver') throw new Error('no delivery queued');
    expect(await service.attempt(deliver.message.deliveryId)).toBe('failed');
    expect((await service.get('t_acme', endpoint.id)).status).toBe('disabled');
  });

  it('replays a delivery as a new one with the same body', async () => {
    respond = (n) => new Response('', { status: n === 1 ? 500 : 200 });
    const service = new WebhookService(await deps());
    await service.create('t_acme', { url: 'https://a.example.com/h', event_types: ['*'], createdBy: null });
    await service.fanout('t_acme', [event(5)]);
    const deliver = queue.find((q) => q.message.kind === 'webhooks.deliver');
    if (deliver?.message.kind !== 'webhooks.deliver') throw new Error('no delivery queued');
    await service.attempt(deliver.message.deliveryId);
    const replay = await service.replay('t_acme', deliver.message.deliveryId);
    expect(replay).toMatchObject({ status: 'succeeded', replay_of: deliver.message.deliveryId, event_id: 'evt_5' });
    expect(received[1]?.body).toBe(received[0]?.body);
  });

  it('prunes deliveries past the retention window', async () => {
    const service = new WebhookService(await deps());
    await service.create('t_acme', { url: 'https://a.example.com/h', event_types: ['*'], createdBy: null });
    await service.fanout('t_acme', [event(1)]);
    h.clock.advance(31 * 24 * 3600 * 1000);
    expect(await service.prune()).toBe(1);
  });
});

describe('webhook REST API', () => {
  it('requires webhooks:manage and returns the secret once', async () => {
    const d = await deps();
    overrideWebhookDeps(() => d);
    const owner = await seedUser(h, { email: 'owner@acme.test' });
    const marketer = await seedUser(h, { email: 'mk@acme.test' });
    await addMember(h, owner.id, 't_acme', 'owner');
    await addMember(h, marketer.id, 't_acme', 'marketer');
    const ownerClient = await login(h, owner.email);
    const marketerClient = await login(h, marketer.email);

    expect((await marketerClient.get('/api/v2/t/acme/webhooks')).status).toBe(403);
    const input = { url: 'https://hooks.example.com/in', event_types: ['contact.created', 'form.submitted'] };
    const fresh = await ownerClient.post('/api/v2/t/acme/webhooks', input);
    expect(fresh.status).toBe(403);
    expect(fresh.body.error).toBe('step_up_required');
    await stepUp(h, ownerClient);
    const created = await ownerClient.post('/api/v2/t/acme/webhooks', input);
    expect(created.status).toBe(201);
    expect(created.body.secret).toMatch(/^whsec_/);
    const id = (created.body.endpoint as { id: string }).id;

    const test = await ownerClient.post(`/api/v2/t/acme/webhooks/${id}/test`);
    expect(test.status).toBe(200);
    expect(test.body).toMatchObject({ event_type: 'webhook.test', status: 'succeeded', last_status: 200 });
    const log = await ownerClient.get(`/api/v2/t/acme/webhooks/${id}/deliveries`);
    expect((log.body.data as unknown[]).length).toBe(1);

    // API keys are scope-bound integrations: no step-up for them.
    const key = await ownerClient.post('/api/t/acme/api-keys', { name: 'ci', scopes: ['webhooks:manage'] });
    expect(key.status).toBe(201);
    const viaKey = await h
      .client()
      .post('/api/v2/t/acme/webhooks', input, { authorization: `Bearer ${key.body.key as string}`, origin: '' });
    expect(viaKey.status).toBe(201);
    h.clock.advance(10 * 60_000);
    const stale = await ownerClient.post(`/api/v2/t/acme/webhooks/${id}/rotate-secret`);
    expect(stale.body.error).toBe('step_up_required');

    const bad = await h.client().post(
      '/api/v2/t/acme/webhooks',
      { url: 'http://169.254.169.254/x', event_types: ['*'] },
      { authorization: `Bearer ${key.body.key as string}`, origin: '' },
    );
    expect(bad.status).toBe(422);
    expect(bad.body.error).toBe('invalid_url');
    const audit = await h.env.DB.prepare(`SELECT action FROM audit_log WHERE action LIKE 'webhook.%'`).all<{ action: string }>();
    expect(audit.results.map((r) => r.action)).toContain('webhook.endpoint_created');
  });
});

describe('merged OpenAPI document', () => {
  it('covers every module and every operation declares x-amable-permission', () => {
    const doc = mergedOpenApiDocument();
    const operations = listOperations(doc);
    expect(operations.length).toBeGreaterThan(150);
    const missing = operations
      .filter((op) => typeof op.operation['x-amable-permission'] !== 'string')
      .map((op) => `${op.method.toUpperCase()} ${op.path}`);
    expect(missing).toEqual([]);
    const paths = Object.keys(doc['paths'] as object);
    expect(paths).toEqual(
      expect.arrayContaining(['/contacts', '/emailTemplates', '/analytics/sites', '/forms', '/reports', '/webhooks']),
    );
    const refs = JSON.stringify(doc).match(/#\/components\/schemas\/[A-Za-z0-9_.-]+/g) ?? [];
    const schemas = (doc['components'] as { schemas: Record<string, unknown> }).schemas;
    const dangling = [...new Set(refs)].filter((ref) => !((ref.split('/').pop() ?? '') in schemas));
    expect(dangling).toEqual([]);
  });
});
