import { describe, expect, it } from 'vitest';
import { emailEdgeRoutes, type EmailEdgeEnv } from '../src/email/routes';

const TOKEN = 'eyJrIjoiY2xpY2sifQ.AAAAAAAAAAAAAAAAAAAAAA';

function fakeCore(responses: Record<string, unknown>) {
  const calls: { path: string; body: unknown }[] = [];
  const core = {
    async fetch(input: string, init?: RequestInit) {
      const path = new URL(input).pathname;
      calls.push({ path, body: JSON.parse(String(init?.body ?? 'null')) });
      const body = responses[path];
      return body === undefined
        ? new Response('{}', { status: 400 })
        : new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    },
  };
  return { env: { CORE: core as unknown as Fetcher } satisfies EmailEdgeEnv, calls };
}

const waits: Promise<unknown>[] = [];
const ctx = {
  waitUntil(p: Promise<unknown>) {
    waits.push(p);
  },
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

describe('edge email routes', () => {
  it('redirects clicks to the destination verified by core', async () => {
    const { env, calls } = fakeCore({ '/edge/email/click': { url: 'https://shop.example.com/?_amb_c=x.y' } });
    const res = await emailEdgeRoutes.request(`/r/${TOKEN}`, {}, env, ctx);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://shop.example.com/?_amb_c=x.y');
    expect(calls).toEqual([{ path: '/edge/email/click', body: { token: TOKEN } }]);
    const bad = await emailEdgeRoutes.request('/r/not-a-token', {}, env, ctx);
    expect(bad.status).toBe(404);
    const html = await bad.text();
    expect(html).toContain('This link is not valid or has expired.');
    expect(html).not.toContain('unsubscribe');
  });

  it('serves the open pixel immediately and records it in the background', async () => {
    const { env, calls } = fakeCore({ '/edge/email/open': { ok: true } });
    const res = await emailEdgeRoutes.request(`/o/${TOKEN}`, {}, env, ctx);
    expect(res.headers.get('content-type')).toBe('image/gif');
    expect(res.headers.get('cache-control')).toContain('no-store');
    await Promise.all(waits);
    expect(calls.map((c) => c.path)).toEqual(['/edge/email/open']);
  });

  it('asks for confirmation on GET and unsubscribes on POST, including RFC 8058 one-click', async () => {
    const { env, calls } = fakeCore({
      '/edge/email/unsubscribe/info': { valid: true, email: 'ad•@example.com', alreadyUnsubscribed: false },
      '/edge/email/unsubscribe': { ok: true },
    });
    const page = await emailEdgeRoutes.request(`/unsub/${TOKEN}`, { headers: { 'accept-language': 'it-IT,it' } }, env, ctx);
    const html = await page.text();
    expect(html).toContain('<form method="post">');
    expect(html).toContain('ad•@example.com');
    expect(html).toContain('Disiscriviti');
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    // GET never unsubscribes (link scanners).
    expect(calls.map((c) => c.path)).toEqual(['/edge/email/unsubscribe/info']);

    const oneClick = await emailEdgeRoutes.request(
      `/unsub/${TOKEN}`,
      { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'content-type': 'application/x-www-form-urlencoded' } },
      env,
      ctx,
    );
    expect(oneClick.status).toBe(200);
    expect(calls.at(-1)).toEqual({ path: '/edge/email/unsubscribe', body: { token: TOKEN, via: 'one_click' } });

    const form = await emailEdgeRoutes.request(`/unsub/${TOKEN}`, { method: 'POST', body: 'confirm=1' }, env, ctx);
    expect(await form.text()).toContain('You have been unsubscribed');
    expect(calls.at(-1)?.body).toEqual({ token: TOKEN, via: 'link' });
  });
});
