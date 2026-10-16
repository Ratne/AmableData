import type { UsageBlock, UsageReportRequest, UsageReportResponse } from '@amable/core/platform';
import type { Env } from '../env';
import { controlPlaneClient } from './client';
import { HOUR_MS, parseQuotaSnapshot, storeQuotaSnapshot } from './quota';

export const MAX_BLOCKS_PER_REPORT = 100;

interface UsageRow {
  tenant_id: string;
  channel: string;
  hour_start: number;
  count: number;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function usageBlockId(tenantId: string, hourStartMs: number): string {
  return `${tenantId}:email:${new Date(hourStartMs).toISOString()}`;
}

/**
 * Reports closed hours not yet reported (≤ 100 blocks per call) and marks
 * `reported_at` only for blocks the control plane accepted or already had.
 * Block ids are deterministic, so a lost answer just replays as duplicates.
 */
export async function flushUsage(
  env: Env,
  nowMs: number,
): Promise<{ reported: number; pending: number }> {
  const client = controlPlaneClient(env);
  if (client === null) return { reported: 0, pending: 0 };
  const rows = (
    await env.DB.prepare(
      `SELECT tenant_id, channel, hour_start, count FROM platform_usage
        WHERE reported_at IS NULL AND channel = 'email' AND hour_start + ? <= ?
        ORDER BY hour_start, tenant_id LIMIT ?`,
    )
      .bind(HOUR_MS, nowMs, MAX_BLOCKS_PER_REPORT)
      .all<UsageRow>()
  ).results;
  if (rows.length === 0) return { reported: 0, pending: 0 };
  const byId = new Map<string, UsageRow>();
  const blocks: UsageBlock[] = rows.map((row) => {
    const blockId = usageBlockId(row.tenant_id, row.hour_start);
    byId.set(blockId, row);
    return {
      blockId,
      tenantId: row.tenant_id,
      channel: 'email',
      count: row.count,
      periodStart: new Date(row.hour_start).toISOString(),
    };
  });
  const request: UsageReportRequest = { blocks };
  const response = await client.post<Partial<Record<keyof UsageReportResponse, unknown>> | null>(
    '/usage',
    request,
  );
  const done = [...stringList(response?.accepted), ...stringList(response?.duplicates)]
    .map((id) => byId.get(id))
    .filter((row): row is UsageRow => row !== undefined);
  if (done.length > 0) {
    await env.DB.batch(
      done.map((row) =>
        env.DB.prepare(
          `UPDATE platform_usage SET reported_at = ?
            WHERE tenant_id = ? AND channel = ? AND hour_start = ? AND reported_at IS NULL`,
        ).bind(nowMs, row.tenant_id, row.channel, row.hour_start),
      ),
    );
  }
  const snapshot = parseQuotaSnapshot(response?.quota);
  if (snapshot !== null) await storeQuotaSnapshot(env.DB, snapshot, nowMs);
  return { reported: done.length, pending: rows.length - done.length };
}
