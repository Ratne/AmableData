import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {}, WorkerEntrypoint: class {} }));

const { default: worker } = await import('../src/index');

const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

describe('https redirect', () => {
  it.each(['/', '/login', '/api/health'])('sends http %s to https', async (path) => {
    const res = await worker.fetch(new Request(`http://crm.example.com${path}`), {} as Env, ctx);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(`https://crm.example.com${path}`);
  });
});
