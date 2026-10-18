import { runScheduledAdsSync } from './analytics/ads-sync';
import { runScheduledAnalytics } from './analytics/runtime';
import { app } from './app';
import { runAppsCron } from './apps/cron';
import { DISCOVERY_PATH, handleWellKnown, JWKS_PATH } from './apps/well-known';
import { backupDeps, runScheduledBackups } from './backup/service';
import { handleEmailSendBatch } from './email/consumer';
import { EMAIL_PUBLIC_PREFIXES, emailPublicApp } from './email/public';
import type { Env } from './env';
import { consumeFormSubmissions, FORM_SUBMISSIONS_QUEUE } from './forms/queue';
import { serveSpa } from './middleware/spa';
import { platformScheduled } from './platform/mount';
import { withErrorReporting } from './platform/telemetry';
import { runUpdateCheck } from './platform/updates';
import { handleGoogleOAuthCallback } from './providers/oauth-callback';
import { GOOGLE_OAUTH_CALLBACK_PATH } from './providers/select';
import { forwardToDevEdge, isDevEdgeRequest } from './public/dev-edge';
import { EDGE_GATEWAY_PREFIX, handleEdgeGateway } from './public/gateway';
import { consumeWebhooks, webhookService, WEBHOOKS_QUEUE } from './webhooks/runtime';

export { Engine } from './do/engine';
export { TenantDb } from './do/tenant-db';
export { MailDb } from './email/mail-db';
export { BookingCalendar } from './booking/calendar-do';
export { EditSession } from './pages/edit-session';

const handler = {
  // /api/* is handled by Hono. Documents (run_worker_first, everything except
  // hashed /assets/*) go through serveSpa: CSP nonce + preferences before first paint.
  fetch(request, env, ctx) {
    // Dev only: requests on the edge port (scripts/dev.mjs proxy) belong to the edge worker.
    if (isDevEdgeRequest(request, env)) return forwardToDevEdge(request, env);
    const { pathname } = new URL(request.url);
    if (pathname === '/api' || pathname.startsWith('/api/')) return app.fetch(request, env, ctx);
    // Signed calls of the edge worker (hosted forms, booking pages, landing SSR).
    if (pathname.startsWith(EDGE_GATEWAY_PREFIX)) return handleEdgeGateway(request, env, ctx);
    if (EMAIL_PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
      return emailPublicApp.fetch(request, env, ctx);
    }
    if (pathname === GOOGLE_OAUTH_CALLBACK_PATH) return handleGoogleOAuthCallback(request, env);
    // Marketplace apps: discovery document and the installation's public keys.
    if (pathname === DISCOVERY_PATH || pathname === JWKS_PATH) return handleWellKnown(request, env, pathname);
    return serveSpa(request, env);
  },

  // Queue consumers: email-send (apps/core/src/email), webhooks-out
  // (apps/core/src/webhooks); events-rollup is still a stub.
  // Failures are reported to the fleet monitor (no personal data), then rethrown for retry.
  async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
    return withErrorReporting(env, 'queue', batch.queue, async () => {
      if (batch.queue === 'email-send') return handleEmailSendBatch(batch, env);
      if (batch.queue === FORM_SUBMISSIONS_QUEUE) return consumeFormSubmissions(batch, env);
      if (batch.queue === WEBHOOKS_QUEUE) return consumeWebhooks(batch, env);
      console.log(`[queue:${batch.queue}] received ${batch.messages.length} message(s) — stub`);
      batch.ackAll();
    }, (promise) => ctx.waitUntil(promise));
  },

  // Cron: platform link (heartbeat, usage blocks, error outbox, grant expiry).
  // Other failures are reported to the fleet monitor, then rethrown.
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    await platformScheduled(env, controller.scheduledTime);
    return withErrorReporting(env, 'cron', controller.cron, async () => {
      // Web analytics: CRM → analytics sync of every tenant, daily ad / search integrations.
      await runScheduledAnalytics(env);
      // Ad platforms: hourly spend of the current day, daily reconciliation, token refresh.
      await runScheduledAdsSync(env);
      // Outgoing webhooks: delivery log retention.
      await webhookService(env).prune();
      // R2 backups: installation D1 + each tenant's DOs, once a day, a few per tick.
      await runScheduledBackups(backupDeps(env)).catch((error: unknown) => {
        console.error('[backup] scheduler failed:', error instanceof Error ? error.message : error);
      });
      // Self-hosted: latest public release, once a day.
      await runUpdateCheck(env, controller.scheduledTime);
      // Marketplace apps: catalog sync (every 6 hours), uninstall cleanup, metrics retention.
      await runAppsCron(env, controller.scheduledTime);
    }, (promise) => ctx.waitUntil(promise));
  },
} satisfies ExportedHandler<Env>;

export default handler;
