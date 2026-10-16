import type { Hono } from 'hono';
import type { Env } from '../../env';
import type { AppEnv } from '../../middleware';
import { assistTenantRoutes, mountAssistEntry, sweepAssist } from './assist';
import { proxyRoutes } from './proxy';
import { sessionOnly } from './shared';

export { isSupportUserEmail, rejectSupportUsers } from './shared';

/**
 * Support tickets, ideas and assisted access (installation side):
 * - `/t/:slug/platform/{support,ideas,changelog}` proxy to the control plane (central guards apply)
 * - `/t/:slug/platform/assist/*` grants, status
 * - `/platform/assist/enter` token entry, `/platform/v1/assist/revoke` signed revoke
 */
export function mountSupportApi(app: Hono<AppEnv>): void {
  app.use('/t/:slug/platform/*', sessionOnly());
  app.route('/t/:slug/platform', proxyRoutes());
  app.route('/t/:slug/platform', assistTenantRoutes());
  mountAssistEntry(app);
}

/** Closes expired assisted-access grants and their sessions. */
export function sweepAssistGrants(env: Env, nowMs: number): Promise<void> {
  return sweepAssist(env, nowMs);
}
