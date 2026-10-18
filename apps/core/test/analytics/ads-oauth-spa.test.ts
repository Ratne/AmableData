import { describe, expect, it } from 'vitest';
import { adsRedirectUri } from '../../src/analytics/ads-sync';
import type { Env } from '../../src/env';
import { serveSpa } from '../../src/middleware/spa';
import { createHarness } from '../helpers/harness';

const SHELL = '<!doctype html><html><head><script type="module" src="/assets/index.js"></script></head><body><div id="root"></div></body></html>';

describe('ads OAuth redirect page', () => {
  it('is served the SPA shell by the worker (deep link with code and state)', async () => {
    const h = await createHarness();
    const fetched: string[] = [];
    const env = {
      ...h.env,
      APP_ORIGIN: 'https://app.acme.test',
      ASSETS: {
        fetch: (input: Request | string) => {
          const url = typeof input === 'string' ? input : input.url;
          fetched.push(new URL(url).pathname);
          return Promise.resolve(
            new URL(url).pathname === '/'
              ? new Response(SHELL, { headers: { 'content-type': 'text/html' } })
              : new Response('not found', { status: 404 }),
          );
        },
      },
    } as unknown as Env;
    const redirect = adsRedirectUri(env);
    expect(redirect).toBe('https://app.acme.test/oauth/ads/callback');
    const res = await serveSpa(new Request(`${redirect}?code=abc&state=acme.r4nd0m`), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('<div id="root"></div>');
    expect(fetched).toEqual(['/']);
  });
});
