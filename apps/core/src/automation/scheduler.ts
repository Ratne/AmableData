import type { SqlDb } from '../crm/db/sql';
import { CrmCallError } from './ports';
import type { AutomationSettings } from '@amable/api-types';
import type { CompiledGraph } from './graph';
import { StepFailure } from './steps';
import { LIVE_SQL } from './store';
import { addDays, formatDate, isLeap, parseTimeOfDay, wallClock } from './time';

/** Scheduling constants, retry policy and the periodic jobs of the automation engine. */

export const MAX_ATTEMPTS = 5;
export const LEASE_MS = 5 * 60_000;
export const POLL_INTERVAL_MS = 5 * 60_000;
/** Durable Object SQLite binds at most 100 parameters per statement (pending/ack use one per id). */
export const OUTBOX_BATCH = 90;
export const JOBS_PER_ROUND = 100;
export const STEPS_PER_RUN = 25;
export const CONCURRENCY = 8;
/** CRM lookups in flight during the hourly anniversary scan. */
export const ANNIVERSARY_LOOKUP_CONCURRENCY = 4;
const PROCESSED_EVENTS_TTL_MS = 7 * 24 * 60 * 60_000;
/** Execution logs older than this are deleted by the daily prune job. */
export const LOG_RETENTION_MS = 90 * 24 * 60 * 60_000;
const LOG_PRUNE_BATCH_SIZE = 2_000;
const LOG_PRUNE_BATCHES = 10;

/** Retry delay after the n-th failed attempt: 30 s, 2 min, 8 min, 32 min (capped at 6 h). */
export function backoffMs(attempt: number): number {
  return Math.min(30_000 * 4 ** Math.max(attempt - 1, 0), 6 * 60 * 60_000);
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isPermanent(error: unknown): boolean {
  if (error instanceof StepFailure) return error.permanent;
  return error instanceof CrmCallError;
}

/**
 * Daily prune: processed event ids and finished step runs past their TTL, execution
 * logs past retention in bounded batches. Returns true when old logs are left.
 */
export function pruneEngineTables(db: SqlDb, now: number): boolean {
  db.run(`DELETE FROM eng_processed_events WHERE processed_at < ?`, now - PROCESSED_EVENTS_TTL_MS);
  db.run(
    `DELETE FROM eng_step_runs WHERE at < ? AND key NOT IN (
       SELECT t.id || ':' || t.step_index FROM eng_tokens t WHERE t.status IN ${LIVE_SQL})`,
    now - PROCESSED_EVENTS_TTL_MS,
  );
  // Execution logs: bounded batches so one alarm never runs a huge delete.
  let more = false;
  for (let batch = 0; batch < LOG_PRUNE_BATCHES; batch += 1) {
    db.run(
      `DELETE FROM eng_logs WHERE id IN (SELECT id FROM eng_logs WHERE at < ? LIMIT ?)`,
      now - LOG_RETENTION_MS,
      LOG_PRUNE_BATCH_SIZE,
    );
    more = db.all(`SELECT 1 FROM eng_logs WHERE at < ? LIMIT 1`, now - LOG_RETENTION_MS).length > 0;
    if (!more) break;
  }
  return more;
}

export interface DueAnniversaryGoal {
  automationId: string;
  nodeId: string;
  triggerIndex: number;
  today: string;
  lookup: { field: string; monthDay: string; includeLeapDay: boolean };
}

/** Date-anniversary goals whose local time of day has been reached, with the CRM lookup of each. */
export function dueAnniversaryGoals(
  published: ReadonlyArray<{
    automationId: string;
    version: { compiled: CompiledGraph; settings: AutomationSettings };
  }>,
  now: number,
  tenantTimeZone: string,
): DueAnniversaryGoal[] {
  const due: DueAnniversaryGoal[] = [];
  for (const { automationId, version } of published) {
    for (const ref of version.compiled.goalsByEvent.get('automation.date_anniversary') ?? []) {
      if (ref.trigger.type !== 'date_anniversary') continue;
      const trigger = ref.trigger;
      const zone =
        trigger.time_zone === undefined || trigger.time_zone === 'tenant'
          ? (version.settings.time_zone ?? tenantTimeZone)
          : trigger.time_zone;
      const local = wallClock(now, zone);
      const [h, m] = parseTimeOfDay(trigger.time, '09:00');
      if (local.hour * 60 + local.minute < h * 60 + m) continue;
      const today = { year: local.year, month: local.month, day: local.day };
      const target = addDays(today, -(trigger.offset_days ?? 0));
      const monthDay = formatDate(target).slice(5);
      due.push({
        automationId,
        nodeId: ref.node.id,
        triggerIndex: ref.triggerIndex,
        today: formatDate(today),
        lookup: {
          field: trigger.field,
          monthDay,
          includeLeapDay: monthDay === '02-28' && !isLeap(target.year),
        },
      });
    }
  }
  return due;
}
