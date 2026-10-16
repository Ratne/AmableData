import { BOOKING_WIDGET_BUNDLE_HASH } from '@amable/booking/bundle';
import { describe, expect, it } from 'vitest';
import { bookingEdgeRoutes } from '../src/booking/routes';
import type { Env } from '../src/env';

const env = { ENVIRONMENT: 'dev' } as Env;

describe('edge booking routes', () => {
  it('serves the widget bundle with a hash ETag and open CORS', async () => {
    const script = await bookingEdgeRoutes.request('/booking.js', {}, env);
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toContain('javascript');
    expect(script.headers.get('access-control-allow-origin')).toBe('*');
    expect(await script.text()).toContain('data-amable-booking');
    const cached = await bookingEdgeRoutes.request('/booking.js', { headers: { 'if-none-match': `"${BOOKING_WIDGET_BUNDLE_HASH}"` } }, env);
    expect(cached.status).toBe(304);
  });

  it('rejects malformed references and parameters without calling core', async () => {
    expect((await bookingEdgeRoutes.request('/b/acme/Bad_Slug/config', {}, env)).status).toBe(404);
    expect((await bookingEdgeRoutes.request('/b/acme/demo/slots?from=tomorrow&to=x', {}, env)).status).toBe(422);
    expect((await bookingEdgeRoutes.request('/b/acme/manage/short', {}, env)).status).toBe(404);
    const live = await bookingEdgeRoutes.request('/b/acme/demo/live', {}, env);
    expect(live.status).toBe(426);
    const text = await bookingEdgeRoutes.request('/b/acme/demo/book', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' }, env);
    expect(text.status).toBe(415);
    const huge = await bookingEdgeRoutes.request(
      '/b/acme/demo/book',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x: 'y'.repeat(40_000) }) },
      env,
    );
    expect(huge.status).toBe(413);
    const preflight = await bookingEdgeRoutes.request('/b/acme/demo/book', { method: 'OPTIONS' }, env);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('answers 503 when the core binding is missing', async () => {
    const config = await bookingEdgeRoutes.request('/b/acme/demo/config', {}, env);
    expect(config.status).toBe(503);
    expect(await config.json()).toMatchObject({ error: 'gateway_unavailable' });
  });
});
