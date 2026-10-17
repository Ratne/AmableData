/**
 * Per-hour health counters of an app install (the "App health" page): API
 * calls made by the app, hook / action / webhook calls made to it.
 */

export type AppMetricKind = 'api' | 'hook' | 'action' | 'webhook' | 'connector' | 'channel';

export const METRICS_RETENTION_MS = 30 * 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;

export async function recordAppMetric(
  db: D1Database,
  input: { installId: string; kind: AppMetricKind; nowMs: number; ok: boolean; durationMs: number },
): Promise<void> {
  const hour = Math.floor(input.nowMs / HOUR_MS) * HOUR_MS;
  await db
    .prepare(
      `INSERT INTO app_metrics (install_id, hour, kind, calls, errors, total_ms) VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT(install_id, hour, kind) DO UPDATE SET calls = calls + 1, errors = errors + excluded.errors,
         total_ms = total_ms + excluded.total_ms`,
    )
    .bind(input.installId, hour, input.kind, input.ok ? 0 : 1, Math.max(0, Math.round(input.durationMs)))
    .run();
}

export interface AppHealthBucket {
  readonly kind: AppMetricKind;
  readonly calls: number;
  readonly errors: number;
  readonly avg_ms: number;
}

export interface AppHealth {
  readonly since: string;
  readonly totals: AppHealthBucket[];
  readonly hourly: Array<{ hour: string; calls: number; errors: number }>;
  readonly queued_deliveries: number;
  readonly failed_deliveries: number;
  readonly last_success_at: string | null;
  readonly last_failure_at: string | null;
}

export async function appHealth(db: D1Database, installId: string, nowMs: number, hours = 24): Promise<AppHealth> {
  const since = Math.floor((nowMs - hours * HOUR_MS) / HOUR_MS) * HOUR_MS;
  const rows = (
    await db
      .prepare(`SELECT hour, kind, calls, errors, total_ms FROM app_metrics WHERE install_id = ? AND hour >= ? ORDER BY hour`)
      .bind(installId, since)
      .all<{ hour: number; kind: AppMetricKind; calls: number; errors: number; total_ms: number }>()
  ).results;
  const totals = new Map<AppMetricKind, { calls: number; errors: number; ms: number }>();
  const hourly = new Map<number, { calls: number; errors: number }>();
  for (const row of rows) {
    const t = totals.get(row.kind) ?? { calls: 0, errors: 0, ms: 0 };
    totals.set(row.kind, { calls: t.calls + row.calls, errors: t.errors + row.errors, ms: t.ms + row.total_ms });
    const h = hourly.get(row.hour) ?? { calls: 0, errors: 0 };
    hourly.set(row.hour, { calls: h.calls + row.calls, errors: h.errors + row.errors });
  }
  const deliveries = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN d.status IN ('pending', 'retrying') THEN 1 ELSE 0 END) AS queued,
         SUM(CASE WHEN d.status = 'failed' AND d.created_at >= ? THEN 1 ELSE 0 END) AS failed
       FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
       WHERE e.app_install_id = ?`,
    )
    .bind(since, installId)
    .first<{ queued: number | null; failed: number | null }>();
  const endpoint = await db
    .prepare(`SELECT last_success_at, last_failure_at FROM webhook_endpoints WHERE app_install_id = ?`)
    .bind(installId)
    .first<{ last_success_at: number | null; last_failure_at: number | null }>();
  const iso = (ms: number | null | undefined) => (ms == null ? null : new Date(ms).toISOString());
  return {
    since: new Date(since).toISOString(),
    totals: [...totals].map(([kind, t]) => ({
      kind,
      calls: t.calls,
      errors: t.errors,
      avg_ms: t.calls === 0 ? 0 : Math.round(t.ms / t.calls),
    })),
    hourly: [...hourly].map(([hour, h]) => ({ hour: new Date(hour).toISOString(), ...h })),
    queued_deliveries: deliveries?.queued ?? 0,
    failed_deliveries: deliveries?.failed ?? 0,
    last_success_at: iso(endpoint?.last_success_at),
    last_failure_at: iso(endpoint?.last_failure_at),
  };
}

export async function pruneAppMetrics(db: D1Database, nowMs: number): Promise<void> {
  await db.prepare(`DELETE FROM app_metrics WHERE hour < ?`).bind(nowMs - METRICS_RETENTION_MS).run();
}
