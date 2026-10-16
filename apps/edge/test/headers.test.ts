import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

const { app } = await import('../src/index');

describe('edge baseline headers', () => {
  it('adds nosniff, referrer and permissions policies, and HSTS on https', async () => {
    const res = await app.request('https://t.example.com/health', {}, {} as Env);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('permissions-policy')).toContain('camera=()');
    expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000');
    const plain = await app.request('http://localhost/health', {}, {} as Env);
    expect(plain.headers.get('strict-transport-security')).toBeNull();
  });

  it('keeps route-specific values and copes with immutable proxied responses', async () => {
    const res = await app.request('https://t.example.com/unsub/test', {}, {} as Env);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');

    let proxiedCalls = 0;
    const core = {
      fetch: () => {
        proxiedCalls += 1;
        const proxied = new Response('img', { headers: { 'content-type': 'image/png' } });
        const immutable = () => {
          throw new TypeError("Can't modify immutable headers.");
        };
        Object.defineProperty(proxied.headers, 'set', { value: immutable });
        return Promise.resolve(proxied);
      },
    };
    const media = await app.request(
      'https://t.example.com/m/acme/01HZZZZZZZZZZZZZZZZZZZZZZZ.png',
      {},
      { CORE: core, ENVIRONMENT: 'dev' } as unknown as Env,
    );
    expect(proxiedCalls).toBe(1);
    expect(media.status).toBe(200);
    expect(await media.text()).toBe('img');
    expect(media.headers.get('x-content-type-options')).toBe('nosniff');
    expect(media.headers.get('strict-transport-security')).toBe('max-age=31536000');
  });
});
