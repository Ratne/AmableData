import type { Env } from '../env';

/** Grace after expiry before an auth row is dropped (keeps recent history inspectable). */
const EXPIRED_GRACE_MS = 7 * 24 * 3600 * 1000;
/** Reported usage meters older than this are read by nothing (billing periods are monthly). */
const USAGE_RETENTION_MS = 90 * 24 * 3600 * 1000;
/** Audit trail kept one year. */
const AUDIT_RETENTION_MS = 365 * 24 * 3600 * 1000;
/** Per table and run; chunked so one run never holds D1 for long or trips query limits. */
const DELETE_CHUNK = 5000;

const TARGETS = [
  { table: 'sessions', where: 'expires_at < ?' },
  { table: 'auth_challenges', where: 'expires_at < ?' },
  { table: 'auth_tokens', where: 'expires_at < ?' },
  { table: 'platform_usage', where: 'reported_at IS NOT NULL AND hour_start < ?' },
  { table: 'audit_log', where: 'created_at < ?' },
] as const;

function boundOf(table: string, nowMs: number): number {
  if (table === 'platform_usage') return nowMs - USAGE_RETENTION_MS;
  if (table === 'audit_log') return nowMs - AUDIT_RETENTION_MS;
  return nowMs - EXPIRED_GRACE_MS;
}

/**
 * Hourly retention of rows past their window: expired sessions and auth
 * challenges/tokens (grace of a week), usage meters already reported to the
 * control plane (90 days) and the audit trail (one year).
 */
export async function runRetention(env: Env, nowMs: number): Promise<number> {
  let deleted = 0;
  for (const { table, where } of TARGETS) {
    const result = await env.DB.prepare(
      `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ${String(DELETE_CHUNK)})`,
    )
      .bind(boundOf(table, nowMs))
      .run();
    deleted += result.meta.changes ?? 0;
  }
  return deleted;
}
