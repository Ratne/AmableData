import { EDGE_ERROR_REPORT_OP, EDGE_INSTALLATION_TENANT, type GatewayRequest } from '@amable/api-types';
import { verifyWebhook } from '@amable/auth/security';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

const { app, default: handler } = await import('../src/index');
const { MAX_FORWARDS_PER_MINUTE, reportEdgeError, resetEdgeErrorBudget, withEdgeErrorReporting } = await import('../src/errors');

const SECRET = 'edge-secret';

function fakeCore() {
  const calls: { body: string; signature: string | null }[] = [];
  const core = {
    fetch: async (_url: string, init?: RequestInit) => {
      calls.push({ body: String(init?.body), signature: new Headers(init?.headers).get('x-amable-edge-signature') });
      return new Response('{"ok":true}');
    },
  } as unknown as Fetcher;
  return { calls, core };
}

beforeEach(() => {
  resetEdgeErrorBudget();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('edge error reporter', () => {
  it('logs locally and forwards a signed, tenant-less report to the core', async () => {
    const { calls, core } = fakeCore();
    const env = { CORE: core, EDGE_GATEWAY_SECRET: SECRET } as Env;
    await reportEdgeError(env, new RangeError('bad offset'), { source: 'edge', module: 'forms', route: '/f/:slug' });
    expect(vi.mocked(console.error).mock.calls[0]?.[0]).toContain('[edge-error] edge /f/:slug RangeError: bad offset');
    expect(calls).toHaveLength(1);
    const verified = await verifyWebhook({ secrets: [SECRET], header: calls[0]?.signature ?? null, rawBody: calls[0]?.body ?? '' });
    expect(verified.ok).toBe(true);
    const envelope = JSON.parse(calls[0]?.body ?? '{}') as GatewayRequest;
    expect(envelope.op).toBe(EDGE_ERROR_REPORT_OP);
    expect(envelope.tenant).toEqual(EDGE_INSTALLATION_TENANT);
    expect(envelope.input).toMatchObject({ source: 'edge', module: 'forms', route: '/f/:slug', errorType: 'RangeError', message: 'bad offset' });
  });

  it('never throws, stays local without a core binding or secret, and caps forwards per minute', async () => {
    await expect(reportEdgeError({} as Env, new Error('x'), { source: 'edge', module: null })).resolves.toBeUndefined();
    const broken = { CORE: { fetch: () => Promise.reject(new Error('down')) } as unknown as Fetcher, EDGE_GATEWAY_SECRET: SECRET } as Env;
    await expect(reportEdgeError(broken, new Error('x'), { source: 'edge', module: null })).resolves.toBeUndefined();

    resetEdgeErrorBudget();
    const { calls, core } = fakeCore();
    const env = { CORE: core, EDGE_GATEWAY_SECRET: SECRET } as Env;
    for (let i = 0; i < MAX_FORWARDS_PER_MINUTE + 5; i += 1) await reportEdgeError(env, new Error(`e${String(i)}`), { source: 'edge', module: null }, 1_000);
    expect(calls).toHaveLength(MAX_FORWARDS_PER_MINUTE);
    await reportEdgeError(env, new Error('later'), { source: 'edge', module: null }, 62_000);
    expect(calls).toHaveLength(MAX_FORWARDS_PER_MINUTE + 1);
  });

  it('reports unhandled fetch errors with the route pattern and answers an opaque 500', async () => {
    const { calls, core } = fakeCore();
    app.post('/__test/boom/:id', () => {
      throw new TypeError('kaboom');
    });
    const res = await app.request('https://t.example.com/__test/boom/42', { method: 'POST' }, { CORE: core, EDGE_GATEWAY_SECRET: SECRET } as Env);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('Internal error');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect((JSON.parse(calls[0]?.body ?? '{}') as GatewayRequest).input).toMatchObject({ source: 'edge', route: '/__test/boom/:id', errorType: 'TypeError' });
  });

  it('queue and alarm failures are reported and rethrown (retry semantics unchanged)', async () => {
    const { calls, core } = fakeCore();
    const env = { CORE: core, EDGE_GATEWAY_SECRET: SECRET } as Env;
    const batch = {
      queue: 'analytics',
      messages: [{ id: 'm1', body: { kind: 'event' }, attempts: 1, ack: () => undefined, retry: () => undefined }],
      ackAll: () => undefined,
      retryAll: () => undefined,
    } as unknown as MessageBatch<unknown>;
    await expect(handler.queue(batch, env)).rejects.toThrow();
    expect((JSON.parse(calls[0]?.body ?? '{}') as GatewayRequest).input).toMatchObject({ source: 'queue', module: 'analytics' });

    await expect(
      withEdgeErrorReporting(env, { source: 'durable_object', module: 'analytics', route: 'alarm' }, () => Promise.reject(new Error('retention'))),
    ).rejects.toThrow('retention');
    expect((JSON.parse(calls[1]?.body ?? '{}') as GatewayRequest).input).toMatchObject({ source: 'durable_object', route: 'alarm' });
  });
});
