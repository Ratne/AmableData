import type { ResumeEmailResponse } from '@amable/core/platform';
import type { Hono } from 'hono';
import { z } from 'zod';
import { revokeApp } from '../apps/lifecycle';
import { mapLimited } from '../concurrency';
import type { Env } from '../env';
import type { AppEnv } from '../middleware';
import { appOrigin } from '../middleware/security';
import { bootstrapOwner } from './bootstrap-owner';
import { sendHeartbeat } from './heartbeat';
import { platformLink } from './license';
import { dropQuotaMemoryCache, quotaSnapshotSchema, storeQuotaSnapshot } from './quota';
import { POINT_IN_TIME_WINDOW_MS, restoreTenantObjects } from './restore';
import { verifiedControlPlaneBody, verifiedControlPlaneJson } from './signature';
import { flushUsage } from './usage';

const restoreSchema = z.strictObject({ at: z.number().int().positive() });

const revokeAppSchema = z.strictObject({
  app_id: z.string().regex(/^[a-z][a-z0-9-]{2,39}$/),
  reason: z.string().min(1).max(500),
});

const bootstrapOwnerSchema = z.strictObject({
  email: z.string().trim().max(320).pipe(z.email()),
  workspaceName: z.string().trim().min(1).max(120),
  locale: z.enum(['en', 'it']),
});

const resumeEmailSchema = z.strictObject({
  reason: z.enum(['top_up', 'quota_reset', 'manual']),
  quota: quotaSnapshotSchema,
});

const RESUME_CONCURRENCY = 8;

/** Asks every tenant's Engine DO to re-check its paused email steps. */
export async function resumeAllTenants(env: Env): Promise<{ tenants: number; resumed: number }> {
  const tenants = (await env.DB.prepare(`SELECT id FROM tenants`).all<{ id: string }>()).results;
  const counts = await mapLimited(tenants, RESUME_CONCURRENCY, async ({ id }) => {
    try {
      return await env.ENGINE.get(env.ENGINE.idFromName(id)).resumeEmailSteps(id);
    } catch (error) {
      console.error(`[platform] resume email steps failed for tenant ${id}`, error);
      return 0;
    }
  });
  return { tenants: tenants.length, resumed: counts.reduce((sum, n) => sum + n, 0) };
}

/** Signed control plane → installation routes (`/api/platform/v1/*`). */
export function mountPlatformInbound(app: Hono<AppEnv>): void {
  app.post('/platform/v1/resume-email', async (c) => {
    const parsed = await verifiedControlPlaneJson(c, resumeEmailSchema);
    if (!parsed.ok) return parsed.response;
    dropQuotaMemoryCache(c.env.DB);
    await storeQuotaSnapshot(c.env.DB, parsed.data.quota, c.get('services').now());
    const result = await resumeAllTenants(c.env);
    const response: ResumeEmailResponse = { ok: true, ...result };
    return c.json(response);
  });

  app.post('/platform/v1/restore', async (c) => {
    const parsed = await verifiedControlPlaneJson(c, restoreSchema);
    if (!parsed.ok) return parsed.response;
    const now = c.get('services').now();
    if (parsed.data.at > now || parsed.data.at < now - POINT_IN_TIME_WINDOW_MS) {
      return c.json({ error: 'restore_point_out_of_range' }, 422);
    }
    return c.json(await restoreTenantObjects(c.env, parsed.data.at));
  });

  // Marketplace kill switch pushed by the control plane (the catalog sync would get it within 6 hours).
  app.post('/platform/v1/apps/revoke', async (c) => {
    const parsed = await verifiedControlPlaneJson(c, revokeAppSchema);
    if (!parsed.ok) return parsed.response;
    const now = c.get('services').now();
    await c.env.DB.prepare(`UPDATE app_catalog SET revoked = 1, revoked_reason = ? WHERE app_id = ?`)
      .bind(parsed.data.reason, parsed.data.app_id)
      .run();
    const installs = await revokeApp(c.env, parsed.data.app_id, parsed.data.reason, now);
    return c.json({ ok: true, installs });
  });

  app.post('/platform/v1/bootstrap-owner', async (c) => {
    const parsed = await verifiedControlPlaneJson(c, bootstrapOwnerSchema);
    if (!parsed.ok) return parsed.response;
    return c.json(await bootstrapOwner(c.env, parsed.data, appOrigin(c), c.get('services').now()));
  });

  // Signed reachability probe of the link (no data beyond what the control plane already knows).
  app.post('/platform/v1/status', async (c) => {
    const body = await verifiedControlPlaneBody(c);
    if (body === null) return c.json({ error: 'invalid_signature' }, 401);
    const link = platformLink(c.env);
    return c.json({
      ok: true,
      licensed: link.mode === 'licensed',
      installationId: link.mode === 'licensed' ? link.installationId : null,
      version: c.env.APP_VERSION ?? 'dev',
      schemaVersion: c.get('schemaVersion'),
    });
  });
}

/** Heartbeat + usage block flush, every cron tick. Never throws for network failures. */
export async function runPlatformCron(env: Env, nowMs: number): Promise<void> {
  if (platformLink(env).mode !== 'licensed') return;
  try {
    await flushUsage(env, nowMs);
  } catch (error) {
    console.warn('[platform] usage report failed', error);
  }
  try {
    await sendHeartbeat(env, nowMs);
  } catch (error) {
    console.warn('[platform] heartbeat failed', error);
  }
}
