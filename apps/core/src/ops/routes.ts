import { opsReplaySchema, opsStatusSchema, type OpsStatus } from '@amable/api-types';
import { siteStub, tenantSitesStub } from '@amable/app-edge/analytics';
import type { Context, Hono } from 'hono';
import { listBackups, backupDeps } from '../backup/service';
import { tenantBackupPrefix } from '../backup/format';
import { createCrmRouter, crmRoute, json } from '../crm/api/core';
import { audit, getTenant, type AppEnv } from '../middleware';
import { parkedRegistry, replayParkedRegistry } from './registry-dlq';

const tags = ['Operations'];
const opsApi = createCrmRouter();
const tenantId = (c: Context<AppEnv>) => getTenant(c).tenant.id;

/** Objects under a prefix, counted up to one listing page. */
async function countPrefix(bucket: R2Bucket, prefix: string): Promise<number> {
  return (await bucket.list({ prefix, limit: 1000 })).objects.length;
}

async function sitesStatus(c: Context<AppEnv>): Promise<OpsStatus['sites']> {
  const ns = c.env.ANALYTICS;
  if (ns === undefined) return [];
  const out: OpsStatus['sites'] = [];
  for (const id of await tenantSitesStub(ns, tenantId(c)).indexList()) {
    const stub = siteStub(ns, id);
    const [record, check, pending, stale, poison] = await Promise.all([
      stub.getSite(),
      stub.installCheck(),
      countPrefix(c.env.FILES, `wal-pending/${id}/`),
      countPrefix(c.env.FILES, `wal-stale/${id}/`),
      countPrefix(c.env.FILES, `poison/${id}/`),
    ]);
    if (record === null || record.deleted || record.tenantId !== tenantId(c)) continue;
    const last = check?.last_event_at == null ? NaN : Date.parse(check.last_event_at);
    out.push({
      id,
      name: record.site.name,
      last_event_at: Number.isFinite(last) ? last : null,
      pending_segments: pending,
      stale_segments: stale,
      poison_objects: poison,
    });
  }
  return out;
}

opsApi.openapi(
  crmRoute('settings:manage', {
    method: 'get',
    path: '/status',
    tags,
    summary: 'What is stuck or behind in the workspace, with the counts the recovery actions use',
    responses: { 200: json(opsStatusSchema, 'Status') },
  }),
  async (c) => {
    const [registry, sites, backups] = await Promise.all([
      parkedRegistry(c.env, tenantId(c)),
      sitesStatus(c),
      listBackups(backupDeps(c.env), tenantBackupPrefix(tenantId(c))),
    ]);
    const body: OpsStatus = {
      registry,
      sites,
      backups: { count: backups.length, last_at: backups[0]?.createdAt ?? null },
    };
    return c.json(body, 200);
  },
);

opsApi.openapi(
  crmRoute('settings:manage', {
    method: 'post',
    path: '/registry/replay',
    tags,
    summary: 'Replay the parked registry messages of the workspace (up to 500 per call)',
    responses: { 200: json(opsReplaySchema, 'Replayed') },
  }),
  async (c) => {
    const result = await replayParkedRegistry(c.env, tenantId(c));
    await audit(c, 'ops.registry_replayed', { details: result });
    return c.json(result, 200);
  },
);

/** Mounts `/api/v2/t/:slug/ops/*`. */
export function mountOpsApi(app: Hono<AppEnv>): void {
  app.route('/v2/t/:slug/ops', opsApi);
}
