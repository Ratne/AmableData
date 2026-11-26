import {
  opsReplaySchema,
  opsStatusSchema,
  opsTelemetrySchema,
  opsTelemetryUpdateSchema,
  type OpsStatus,
  type OpsTelemetry,
} from '@amable/api-types';
import { siteStub, tenantSitesStub } from '@amable/app-edge/analytics';
import type { Context, Hono } from 'hono';
import { listBackups, backupDeps } from '../backup/service';
import { tenantBackupPrefix } from '../backup/format';
import { createCrmRouter, crmRoute, json, jsonBody } from '../crm/api/core';
import { audit, getTenant, HttpError, type AppEnv } from '../middleware';
import {
  previewUsagePing,
  setLocalTelemetry,
  telemetryControl,
  telemetryStatus,
} from '../platform/usage-telemetry';
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

async function telemetryBody(c: Context<AppEnv>): Promise<OpsTelemetry> {
  const status = await telemetryStatus(c.env);
  return {
    enabled: status.enabled,
    control: status.control,
    can_change: status.control === 'local' && getTenant(c).role === 'owner',
    last_sent_at: status.lastSentAt,
    preview: { ...(await previewUsagePing(c.env)) },
  };
}

opsApi.openapi(
  crmRoute('settings:manage', {
    method: 'get',
    path: '/telemetry',
    tags,
    summary: 'Anonymous usage statistics of the installation: state and the exact next ping',
    responses: { 200: json(opsTelemetrySchema, 'Telemetry') },
  }),
  async (c) => c.json(await telemetryBody(c), 200),
);

// Installation-wide choice: workspace owners administer the installation (as for update notices).
opsApi.openapi(
  crmRoute('settings:manage', {
    method: 'put',
    path: '/telemetry',
    tags,
    summary: 'Switch the anonymous usage statistics on or off (open source installations, owners)',
    request: { body: jsonBody(opsTelemetryUpdateSchema) },
    responses: { 200: json(opsTelemetrySchema, 'Telemetry') },
  }),
  async (c) => {
    const { enabled } = c.req.valid('json');
    if (getTenant(c).role !== 'owner') throw new HttpError(403, 'forbidden');
    if (telemetryControl(c.env) !== 'local') throw new HttpError(409, 'telemetry_managed_elsewhere');
    await setLocalTelemetry(c.env, enabled);
    await audit(c, enabled ? 'ops.telemetry_enabled' : 'ops.telemetry_disabled', {});
    return c.json(await telemetryBody(c), 200);
  },
);

/** Mounts `/api/v2/t/:slug/ops/*`. */
export function mountOpsApi(app: Hono<AppEnv>): void {
  app.route('/v2/t/:slug/ops', opsApi);
}
