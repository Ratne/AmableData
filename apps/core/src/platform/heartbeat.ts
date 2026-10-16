import type { HeartbeatRequest, HeartbeatResponse } from '@amable/core/platform';
import type { Env } from '../env';
import { controlPlaneClient } from './client';
import {
  META_HEARTBEAT,
  META_REPORTING,
  parseQuotaSnapshot,
  readMeta,
  storeQuotaSnapshot,
  writeMeta,
} from './quota';
import { pendingErrorCount } from './telemetry';

async function count(db: D1Database, sql: string): Promise<number> {
  return (await db.prepare(sql).first<{ n: number }>())?.n ?? 0;
}

export async function buildHeartbeat(env: Env, nowMs: number): Promise<HeartbeatRequest> {
  const schema = Number(await readMeta(env.DB, 'schema_version'));
  return {
    version: env.APP_VERSION !== undefined && env.APP_VERSION !== '' ? env.APP_VERSION : 'dev',
    schemaVersion: Number.isFinite(schema) ? schema : 0,
    tenants: await count(env.DB, `SELECT COUNT(*) AS n FROM tenants`),
    queueBacklog: null,
    emailFailureRate: null,
    latencyMs: null,
    pendingErrors: await pendingErrorCount(env),
    sentAt: new Date(nowMs).toISOString(),
  };
}

/** `POST /v1/installation/heartbeat`; stores the snapshot, reporting knobs and fleet state. */
export async function sendHeartbeat(env: Env, nowMs: number): Promise<HeartbeatResponse | null> {
  const client = controlPlaneClient(env);
  if (client === null) return null;
  const response = await client.post<HeartbeatResponse>('/heartbeat', await buildHeartbeat(env, nowMs));
  const snapshot = parseQuotaSnapshot(response.quota);
  if (snapshot !== null) await storeQuotaSnapshot(env.DB, snapshot, nowMs);
  if (typeof response.reporting === 'object' && response.reporting !== null) {
    await writeMeta(env.DB, META_REPORTING, {
      sampleRate: response.reporting.sampleRate,
      maxBatch: response.reporting.maxBatch,
    });
  }
  await writeMeta(env.DB, META_HEARTBEAT, {
    at: nowMs,
    serviceState: response.serviceState,
    channel: response.channel,
    targetVersion: response.targetVersion,
  });
  return response;
}
