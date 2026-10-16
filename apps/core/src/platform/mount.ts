import type { Hono } from 'hono';
import type { Env } from '../env';
import type { AppEnv } from '../middleware';
import { billingApi } from './billing';
import { mountPlatformInbound, runPlatformCron } from './inbound';
import { mountSupportApi, sweepAssistGrants } from './support';
import { flushErrorOutbox } from './telemetry';

/**
 * Installation side of the platform link (managed offering). Nothing here
 * imports the control plane: it speaks the versioned HTTP contract of
 * `@amable/core/platform`. Without `LICENSE_KEY` (open source) every piece
 * degrades to local behavior.
 *
 * - `/api/platform/v1/*`  signed control plane → installation calls (resume email, grant revoke)
 * - `/api/platform/assist/*` assisted-access entry for support staff
 * - `/api/t/:slug/platform/*` support tickets, ideas, grants (central guards apply)
 * - `/api/v2/t/:slug/billing` plan, email quota and wallet (Settings > Billing & wallet)
 */
export function mountPlatformApi(app: Hono<AppEnv>): void {
  mountPlatformInbound(app);
  mountSupportApi(app);
  app.route('/v2/t/:slug', billingApi);
}

/** Cron work of the platform link: heartbeat, usage blocks, error outbox, grant expiry. */
export async function platformScheduled(env: Env, nowMs: number): Promise<void> {
  const results = await Promise.allSettled([
    runPlatformCron(env, nowMs),
    flushErrorOutbox(env, nowMs),
    sweepAssistGrants(env, nowMs),
  ]);
  for (const result of results) {
    if (result.status === 'rejected') console.error('[platform] cron task failed', result.reason);
  }
}
