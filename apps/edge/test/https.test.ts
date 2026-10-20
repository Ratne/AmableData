import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { httpsRedirect } from '../src/https';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

const { default: worker } = await import('../src/index');

const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

describe('https redirect', () => {
  it('moves plain-http page requests to https, keeping path and query', () => {
    const res = httpsRedirect(new Request('http://crm.example.com/t/acme/contacts?page=2'), undefined);
    expect(res?.status).toBe(301);
    expect(res?.headers.get('location')).toBe('https://crm.example.com/t/acme/contacts?page=2');
    expect(httpsRedirect(new Request('http://crm.example.com/', { method: 'HEAD' }), undefined)?.status).toBe(301);
  });

  it('serves https, loopback, dev, non-GET requests and ACME challenges as they are', () => {
    expect(httpsRedirect(new Request('https://crm.example.com/'), undefined)).toBeNull();
    for (const host of ['localhost:8787', '127.0.0.1:8787', '[::1]:8787', 'acme.localhost']) {
      expect(httpsRedirect(new Request(`http://${host}/`), undefined)).toBeNull();
    }
    expect(httpsRedirect(new Request('http://crm.example.com/'), 'dev')).toBeNull();
    expect(httpsRedirect(new Request('http://t.example.com/e', { method: 'POST', body: '{}' }), undefined)).toBeNull();
    expect(httpsRedirect(new Request('http://t.example.com/.well-known/acme-challenge/x'), undefined)).toBeNull();
  });

  it('redirects before any edge route runs', async () => {
    const res = await worker.fetch(new Request('http://pages.example.com/offerta'), {} as Env, ctx);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://pages.example.com/offerta');
  });
});
