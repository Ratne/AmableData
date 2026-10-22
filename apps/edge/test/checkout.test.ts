import { describe, expect, it } from 'vitest';
import { CHECKOUT_CSP, checkoutEdgeRoutes } from '../src/checkout/routes';
import type { Env } from '../src/env';

const env = { ENVIRONMENT: 'dev' } as Env;
const TOKEN = 'a'.repeat(43);

const post = (path: string, body: unknown, contentType = 'application/json') =>
  checkoutEdgeRoutes.request(
    path,
    { method: 'POST', headers: { 'content-type': contentType }, body: typeof body === 'string' ? body : JSON.stringify(body) },
    env,
  );

describe('edge checkout routes', () => {
  it('serves the widget cross-origin', async () => {
    const script = await checkoutEdgeRoutes.request('/checkout.js', {}, env);
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toContain('javascript');
    expect(script.headers.get('access-control-allow-origin')).toBe('*');
    const preflight = await checkoutEdgeRoutes.request('/c/acme/co_1/session', { method: 'OPTIONS' }, env);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('rejects malformed references and payloads without calling core', async () => {
    expect((await checkoutEdgeRoutes.request('/c/acme/bad%20id/config', {}, env)).status).toBe(404);
    expect((await checkoutEdgeRoutes.request('/c/acme/stripe/config', {}, env)).status).toBe(404);
    expect((await post('/c/acme/co_1/session', 'x', 'text/plain')).status).toBe(415);
    expect((await post('/c/acme/co_1/session', '[1]')).status).toBe(400);
    expect((await post('/c/acme/session/accept', { token: 'short' })).status).toBe(422);
    expect((await post('/c/acme/session/refund', { token: TOKEN })).status).toBe(404);
  });

  it('answers 503 when the core binding is missing, so Stripe retries the webhook', async () => {
    const config = await checkoutEdgeRoutes.request('/c/acme/co_1/config', {}, env);
    expect(config.status).toBe(503);
    const step = await post('/c/acme/session/complete', { token: TOKEN });
    expect(step.status).toBe(503);
    const hook = await checkoutEdgeRoutes.request(
      '/c/acme/stripe/webhook',
      { method: 'POST', headers: { 'stripe-signature': 't=1,v1=x' }, body: '{}' },
      env,
    );
    expect(hook.status).toBe(503);
  });

  it('serves the hosted pages with the Stripe CSP and noindex', async () => {
    const offer = await checkoutEdgeRoutes.request(`/c/acme/offer?amb_cs=${TOKEN}`, {}, env);
    expect(offer.status).toBe(200);
    const html = await offer.text();
    expect(html).toContain('data-amable-offer data-amable-tenant="acme"');
    expect(html).toContain('/checkout.js?v=');
    expect(offer.headers.get('content-security-policy')).toBe(CHECKOUT_CSP);
    expect(CHECKOUT_CSP).toContain('https://js.stripe.com');
    expect(offer.headers.get('permissions-policy')).toContain('payment=(self "https://js.stripe.com")');
    expect(offer.headers.get('x-robots-tag')).toBe('noindex, nofollow');

    const expired = await checkoutEdgeRoutes.request('/c/acme/offer', {}, env);
    expect(expired.status).toBe(404);
    const missing = await checkoutEdgeRoutes.request('/c/acme/bad%20id', { headers: { 'accept-language': 'it' } }, env);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain('lang="it"');
  });
});
