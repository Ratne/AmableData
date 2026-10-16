import type { ResumeEmailResponse } from '@amable/core/platform';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import type { AppEnv } from '../middleware';
import { sendHeartbeat } from './heartbeat';
import { platformLink } from './license';
import { dropQuotaMemoryCache, quotaSnapshotSchema, storeQuotaSnapshot } from './quota';
import { verifiedControlPlaneBody } from './signature';
import { flushUsage } from './usage';

const resumeEmailSchema = z.strictObject({
  reason: z.enum(['top_up', 'quota_reset', 'manual']),
  quota: quotaSnapshotSchema,
});

/** Asks every tenant's Engine DO to re-check its paused email steps. */
export async function resumeAllTenants(env: Env): Promise<{ tenants: number; resumed: number }> {
  const tenants = (await env.DB.prepare(`SELECT id FROM tenants`).all<{ id: string }>()).results;
  let resumed = 0;
  for (const { id } of tenants) {
    try {
      resumed += await env.ENGINE.get(env.ENGINE.idFromName(id)).resumeEmailSteps(id);
    } catch (error) {
      console.error(`[platform] resume email steps failed for tenant ${id}`, error);
    }
  }
  return { tenants: tenants.length, resumed };
}

/** Signed control plane → installation routes (`/api/platform/v1/*`). */
export function mountPlatformInbound(app: Hono<AppEnv>): void {
  app.post('/platform/v1/resume-email', async (c) => {
    const body = await verifiedControlPlaneBody(c);
    if (body === null) return c.json({ error: 'invalid_signature' }, 401);
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const parsed = resumeEmailSchema.safeParse(json);
    if (!parsed.success) return c.json({ error: 'validation_failed' }, 422);
    dropQuotaMemoryCache(c.env.DB);
    await storeQuotaSnapshot(c.env.DB, parsed.data.quota, c.get('services').now());
    const result = await resumeAllTenants(c.env);
    const response: ResumeEmailResponse = { ok: true, ...result };
    return c.json(response);
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
