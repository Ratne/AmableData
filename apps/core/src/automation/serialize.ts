import type {
  Automation,
  AutomationVersionSummary,
  Enrollment,
  ExecutionLogEntry,
} from '@amable/api-types';
import { LOG_KINDS } from '@amable/api-types';
import { chunks, first, placeholders, type SqlDb } from '../crm/db/sql';
import { parseJson, toIso } from '../crm/util';
import { isSequence, type CompiledGraph } from './graph';
import {
  getVersionRow,
  parseSettings,
  type AutomationRow,
  type EnrollmentRow,
  type TokenRow,
} from './store';

/** API views of the engine rows. */

type LogKind = (typeof LOG_KINDS)[number];

export function automationView(db: SqlDb, row: AutomationRow): Automation {
  const version =
    row.published_version_id === null ? undefined : getVersionRow(db, row.published_version_id);
  const active =
    first<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM eng_enrollments WHERE automation_id = ? AND status = 'active'`,
      row.id,
    )?.n ?? 0;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    folder_id: row.folder_id,
    settings: parseSettings(row.settings),
    draft_revision: row.draft_revision,
    has_unpublished_changes:
      version === undefined ||
      version.graph !== row.draft_graph ||
      version.settings !== row.settings,
    published_version:
      version === undefined
        ? null
        : { id: version.id, number: version.number, published_at: toIso(version.published_at) },
    active_enrollments: active,
    created_by: row.created_by,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

export function versionSummaryView(row: VersionSummaryRow): AutomationVersionSummary {
  return {
    id: row.id,
    automation_id: row.automation_id,
    number: row.number,
    settings: parseSettings(row.settings),
    published_by: row.published_by,
    published_at: toIso(row.published_at),
  };
}

/** Enrollments with their live positions (`versionOf` resolves the step of each position). */
export function enrollmentViews(
  db: SqlDb,
  rows: readonly EnrollmentRow[],
  versionOf: (id: string) => { compiled: CompiledGraph } | null,
): Enrollment[] {
  if (rows.length === 0) return [];
  const tokens = chunks(rows.map((r) => r.id)).flatMap((ids) =>
    db.all<TokenRow & { due_at: number | null }>(
      `SELECT t.*, j.due_at FROM eng_tokens t LEFT JOIN eng_jobs j ON j.kind = 'token' AND j.ref = t.id
       WHERE t.enrollment_id IN (${placeholders(ids.length)}) AND t.status NOT IN ('done', 'cancelled')
       ORDER BY t.id`,
      ...ids,
    ),
  );
  return rows.map((row) => ({
    id: row.id,
    automation_id: row.automation_id,
    version_id: row.version_id,
    contact_id: row.contact_id,
    status: row.status,
    source: row.source,
    entry_node_id: row.entry_node_id,
    started_at: toIso(row.started_at),
    ended_at: toIso(row.ended_at),
    positions: tokens
      .filter((t) => t.enrollment_id === row.id)
      .map((t) => {
        const node = versionOf(t.version_id)?.compiled.nodes.get(t.node_id);
        return {
          id: t.id,
          node_id: t.node_id,
          step_id: isSequence(node) ? (node.steps[t.step_index]?.id ?? null) : null,
          step_index: t.step_index,
          status: t.status,
          due_at: toIso(t.due_at),
          attempts: t.attempts,
          last_error: t.last_error,
        };
      }),
  }));
}

export type VersionSummaryRow = Pick<
  NonNullable<ReturnType<typeof getVersionRow>>,
  'id' | 'automation_id' | 'number' | 'settings' | 'published_by' | 'published_at'
>;

export interface LogRow {
  id: string;
  kind: LogKind;
  node_id: string | null;
  step_id: string | null;
  message: string;
  data: string;
  at: number;
}

export function toLogEntry(row: LogRow): ExecutionLogEntry {
  return {
    id: row.id,
    kind: row.kind,
    node_id: row.node_id,
    step_id: row.step_id,
    message: row.message,
    data: parseJson<Record<string, unknown>>(row.data, {}),
    at: new Date(row.at).toISOString(),
  };
}
