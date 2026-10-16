import type { AnalyticsDO } from '@amable/app-edge/analytics';
import type { Context } from 'hono';
import type { AppEnv } from '../middleware';

/**
 * Forwards an authorized realtime WebSocket upgrade to the site's AnalyticsDO
 * (hibernatable socket). Cross-site WebSocket hijacking is refused: the
 * browser's `Origin` must be this app (same host as the request, or APP_ORIGIN).
 */
export async function forwardRealtimeSocket(
  c: Context<AppEnv>,
  stub: DurableObjectStub<AnalyticsDO>,
  audience: 'private' | 'public',
): Promise<Response> {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
    return c.json({ error: 'websocket_required' }, 426);
  }
  const origin = c.req.header('origin');
  if (audience === 'private' && origin !== undefined) {
    const host = (() => {
      try {
        return new URL(origin).host;
      } catch {
        return '';
      }
    })();
    const own = new URL(c.req.url).host;
    const app = c.env.APP_ORIGIN === undefined ? null : new URL(c.env.APP_ORIGIN).host;
    if (host !== own && host !== app) return c.json({ error: 'origin_not_allowed' }, 403);
  }
  const res = await stub.fetch(
    new Request(`https://analytics.internal/ws?audience=${audience}`, c.req.raw),
  );
  // Responses from a stub have immutable headers; API middleware sets headers afterwards.
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: new Headers(res.headers),
    webSocket: res.webSocket,
  });
}
