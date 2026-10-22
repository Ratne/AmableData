import { Hono, type Context } from 'hono';
import { routePath } from 'hono/route';
import { consumeAnalyticsBatch } from './analytics/pipeline';
import { directLinkViews, linkRoutes } from './analytics/link-routes';
import { analyticsRoutes } from './analytics/routes';
import { bookingEdgeRoutes } from './booking/routes';
import { checkoutEdgeRoutes } from './checkout/routes';
import { formsEdgeRoutes } from './forms/routes';
import { pagesCatchAll, pagesEdgeRoutes } from './pages/routes';
import type { AnalyticsMessage } from './analytics/types';
import { emailEdgeRoutes } from './email/routes';
import { esignEdgeRoutes } from './esign/routes';
import type { Env } from './env';
import { reportEdgeError, withEdgeErrorReporting } from './errors';
import { httpsRedirect } from './https';

export type { Env } from './env';
export { AnalyticsDO } from './analytics/do';

export const app = new Hono<{ Bindings: Env }>();

const BASELINE_HEADERS: ReadonlyArray<[string, string]> = [
  ['x-content-type-options', 'nosniff'],
  ['referrer-policy', 'strict-origin-when-cross-origin'],
  ['permissions-policy', 'camera=(), microphone=(), geolocation=(), usb=(), payment=(), browsing-topics=()'],
];

/**
 * Baseline headers on every edge response that did not set its own. HSTS has
 * no includeSubDomains/preload: the hostnames live on customer zones. Framing
 * rules stay per route (forms and booking pages are meant to be embedded).
 */
app.use('*', async (c, next) => {
  await next();
  if (c.res.status === 101) return;
  const https = new URL(c.req.url).protocol === 'https:';
  const apply = (headers: Headers) => {
    for (const [name, value] of BASELINE_HEADERS) if (!headers.has(name)) headers.set(name, value);
    if (https && !headers.has('strict-transport-security')) {
      headers.set('strict-transport-security', 'max-age=31536000');
    }
  };
  try {
    apply(c.res.headers);
  } catch {
    // Responses proxied from the core binding have immutable headers.
    const copy = new Response(c.res.body, c.res);
    apply(copy.headers);
    c.res = copy;
  }
});

/** Web analytics: `POST /e`, `POST /e/server`, tracker scripts `/s.js` and variants. */
app.use('/e', directLinkViews);
app.route('/', analyticsRoutes);

/** Funnel tracking links `/go/…`, action links `/a/:n`, postbacks `/pb`, `/pb/event`. */
app.route('/', linkRoutes);

/** Hosted forms + embed widget, booking pages + embed widget, landing page fallback URLs and media. */
app.route('/', formsEdgeRoutes);
app.route('/', bookingEdgeRoutes);
app.route('/', pagesEdgeRoutes);

/** Checkout widget `/checkout.js`, hosted checkout and offer pages `/c/…`, Stripe webhooks. */
app.route('/', checkoutEdgeRoutes);

/** Document signing pages `/sign/:slug/:token` and the signing app `/sign.js`. */
app.route('/', esignEdgeRoutes);

/** Email click redirect `/r/:token`, open pixel `/o/:token`, unsubscribe page `/unsub/:token`. */
app.route('/', emailEdgeRoutes);

app.get('/health', (c) => c.json({ ok: true, worker: 'amable-edge' }));

// Published landing pages on connected customer hostnames — keep this the last route.
app.get('*', pagesCatchAll);

function routePattern(c: Context<{ Bindings: Env }>): string | null {
  try {
    return routePath(c, -1);
  } catch {
    return null;
  }
}

app.onError((error, c) => {
  const report = reportEdgeError(c.env, error, { source: 'edge', module: 'edge', route: routePattern(c) });
  try {
    c.executionCtx.waitUntil(report);
  } catch {
    // No ExecutionContext (tests): the report still runs.
  }
  return c.text('Internal error', 500);
});

const handler = {
  fetch: (request, env, ctx) => httpsRedirect(request, env.ENVIRONMENT) ?? app.fetch(request, env, ctx),

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    // `amable-analytics` on installations made by the managed installer (shared accounts).
    const queue = batch.queue.replace(/^amable-/, '');
    if (queue === 'analytics') {
      await withEdgeErrorReporting(env, { source: 'queue', module: queue }, () =>
        consumeAnalyticsBatch(batch as MessageBatch<AnalyticsMessage>, env),
      );
      return;
    }
    batch.ackAll();
  },
} satisfies ExportedHandler<Env>;

export default handler;
