import {
  automationGraphSchema,
  automationSettingsSchema,
  EMPTY_GRAPH,
  type AutomationGraph,
  type AutomationSettings,
} from '@amable/api-types';
import { first, placeholders, type SqlDb, type SqlValue } from '../crm/db/sql';
import { parseJson } from '../crm/util';

/** Row shapes of the Engine DO tables and small query helpers. */

export type AutomationStatusValue = 'draft' | 'active' | 'inactive';
export type EnrollmentStatusValue = 'active' | 'completed' | 'removed' | 'failed';
export type TokenStatus =
  'scheduled' | 'running' | 'paused' | 'waiting' | 'suspended' | 'done' | 'cancelled' | 'failed';

/** Token statuses that keep an enrollment active. */
export const LIVE_TOKEN_STATUSES: readonly TokenStatus[] = [
  'scheduled',
  'running',
  'paused',
  'waiting',
  'suspended',
];
export const LIVE_SQL = `('scheduled', 'running', 'paused', 'waiting', 'suspended')`;

export interface AutomationRow {
  id: string;
  name: string;
  description: string | null;
  status: AutomationStatusValue;
  /** Added by Engine migration 3 (null = unfiled). */
  folder_id: string | null;
  settings: string;
  draft_graph: string;
  draft_revision: number;
  published_version_id: string | null;
  signing_secret: string;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface VersionRow {
  id: string;
  automation_id: string;
  number: number;
  graph: string;
  settings: string;
  published_by: string | null;
  published_at: number;
}

export interface EnrollmentRow {
  id: string;
  automation_id: string;
  version_id: string;
  contact_id: string;
  status: EnrollmentStatusValue;
  source: 'goal' | 'manual' | 'sequence';
  entry_node_id: string | null;
  started_at: number;
  updated_at: number;
  ended_at: number | null;
}

export interface TokenRow {
  id: string;
  enrollment_id: string;
  automation_id: string;
  version_id: string;
  contact_id: string;
  node_id: string;
  step_index: number;
  status: TokenStatus;
  step_state: string | null;
  attempts: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface JobRow {
  id: string;
  kind: 'token' | 'poll' | 'anniversary' | 'prune';
  ref: string;
  due_at: number;
}

export function parseGraph(text: string): AutomationGraph {
  const parsed = automationGraphSchema.safeParse(parseJson<unknown>(text, null));
  return parsed.success ? parsed.data : EMPTY_GRAPH;
}

export function parseSettings(text: string): AutomationSettings {
  const parsed = automationSettingsSchema.safeParse(parseJson<unknown>(text, {}));
  return parsed.success ? parsed.data : {};
}

export function getAutomationRow(db: SqlDb, id: string): AutomationRow | undefined {
  return first<AutomationRow>(
    db,
    `SELECT * FROM eng_automations WHERE id = ? AND deleted_at IS NULL`,
    id,
  );
}

export function getVersionRow(db: SqlDb, id: string): VersionRow | undefined {
  return first<VersionRow>(db, `SELECT * FROM eng_versions WHERE id = ?`, id);
}

export function getTokenRow(db: SqlDb, id: string): TokenRow | undefined {
  return first<TokenRow>(db, `SELECT * FROM eng_tokens WHERE id = ?`, id);
}

export function getEnrollmentRow(db: SqlDb, id: string): EnrollmentRow | undefined {
  return first<EnrollmentRow>(db, `SELECT * FROM eng_enrollments WHERE id = ?`, id);
}

export function activeEnrollment(
  db: SqlDb,
  automationId: string,
  contactId: string,
): EnrollmentRow | undefined {
  return first<EnrollmentRow>(
    db,
    `SELECT * FROM eng_enrollments WHERE automation_id = ? AND contact_id = ? AND status = 'active'`,
    automationId,
    contactId,
  );
}

// ------------------------------------------------------------- scheduler

/** Sets a job's due time (insert or move). */
export function setJob(
  db: SqlDb,
  id: string,
  kind: JobRow['kind'],
  ref: string,
  dueAt: number,
): void {
  db.run(
    `INSERT INTO eng_jobs (id, kind, ref, due_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (kind, ref) DO UPDATE SET due_at = excluded.due_at`,
    id,
    kind,
    ref,
    dueAt,
  );
}

/** Schedules a job at `dueAt` unless it is already due earlier. */
export function scheduleNoLaterThan(
  db: SqlDb,
  id: string,
  kind: JobRow['kind'],
  ref: string,
  dueAt: number,
): void {
  db.run(
    `INSERT INTO eng_jobs (id, kind, ref, due_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (kind, ref) DO UPDATE SET due_at = MIN(due_at, excluded.due_at)`,
    id,
    kind,
    ref,
    dueAt,
  );
}

export function deleteJob(db: SqlDb, kind: JobRow['kind'], ref: string): void {
  db.run(`DELETE FROM eng_jobs WHERE kind = ? AND ref = ?`, kind, ref);
}

export function deleteTokenJobs(db: SqlDb, tokenIds: readonly string[]): void {
  // Durable Object SQLite binds at most 100 parameters per statement.
  for (let i = 0; i < tokenIds.length; i += 90) {
    const chunk = tokenIds.slice(i, i + 90);
    db.run(
      `DELETE FROM eng_jobs WHERE kind = 'token' AND ref IN (${placeholders(chunk.length)})`,
      ...chunk,
    );
  }
}

export function earliestJob(db: SqlDb): number | null {
  return first<{ at: number | null }>(db, `SELECT MIN(due_at) AS at FROM eng_jobs`)?.at ?? null;
}

// ------------------------------------------------------------------ stats

export function bumpStat(
  db: SqlDb,
  automationId: string,
  nodeId: string,
  stepId: string | null,
  column: 'entered' | 'completed' | 'errors',
  by = 1,
): void {
  db.run(
    `INSERT INTO eng_node_stats (automation_id, node_id, step_id, ${column}) VALUES (?, ?, ?, ?)
     ON CONFLICT (automation_id, node_id, step_id) DO UPDATE SET ${column} = ${column} + excluded.${column}`,
    automationId,
    nodeId,
    stepId ?? '',
    by,
  );
}

// ------------------------------------------------------------------- meta

export function getMeta(db: SqlDb, key: string): string | null {
  return (
    first<{ value: string }>(db, `SELECT value FROM engine_meta WHERE key = ?`, key)?.value ?? null
  );
}

export function setMeta(db: SqlDb, key: string, value: string): void {
  db.run(
    `INSERT INTO engine_meta (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    key,
    value,
  );
}

export type { SqlValue };
