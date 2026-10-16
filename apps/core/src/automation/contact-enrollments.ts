import type {
  ContactEnrollment,
  ContactEnrollmentPosition,
  GraphNode,
  ListContactEnrollmentsQuery,
  Page,
} from '@amable/api-types';
import { placeholders, type SqlDb } from '../crm/db/sql';
import { decodeCursor, encodeCursor } from '../crm/util';
import type { CompiledGraph } from './graph';
import type { AutomationStatusValue, EnrollmentRow, TokenStatus } from './store';

/** Durable Object SQLite binds at most 100 parameters per statement. */
const IN_CHUNK = 90;

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += IN_CHUNK) out.push(items.slice(i, i + IN_CHUNK));
  return out;
}

function iso(ms: number): string;
function iso(ms: number | null): string | null;
function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function labelOf(node: GraphNode | undefined): string | null {
  if (node === undefined || node.type === 'note') return null;
  return node.label ?? null;
}

/** Runs `query` once per chunk of ids (the ids fill its `IN (…)` list). */
function byIds<T extends object>(
  db: SqlDb,
  ids: readonly string[],
  query: (list: string) => string,
): T[] {
  return chunks(ids).flatMap((chunk) => db.all<T>(query(placeholders(chunk.length)), ...chunk));
}

interface TokenWithDue {
  id: string;
  enrollment_id: string;
  version_id: string;
  node_id: string;
  step_index: number;
  status: TokenStatus;
  last_error: string | null;
  due_at: number | null;
}

/** Active and total enrollments of one contact, from the `(contact_id, status)` index alone. */
export function countContactEnrollments(
  db: SqlDb,
  input: { contactId: string },
): { active: number; total: number } {
  const row = db.all<{ active: number | null; total: number }>(
    `SELECT SUM(status = 'active') AS active, COUNT(*) AS total FROM eng_enrollments WHERE contact_id = ?`,
    input.contactId,
  )[0];
  return { active: row?.active ?? 0, total: row?.total ?? 0 };
}

/**
 * Enrollments of one contact across every automation (`eng_enrollments_contact`
 * index on `(contact_id, status)`), newest first by id, keyset-paginated, with
 * automation names, positions, goals reached and the ending log line resolved
 * in chunked batches.
 */
export function listContactEnrollments(
  db: SqlDb,
  versionOf: (versionId: string) => CompiledGraph | null,
  input: { contactId: string; query: ListContactEnrollmentsQuery },
): Page<ContactEnrollment> {
  const q = input.query;
  const before = q.cursor === undefined ? null : decodeCursor(q.cursor).id;
  const statuses = q.scope === 'current' ? `('active')` : `('completed', 'removed', 'failed')`;
  const rows = db.all<EnrollmentRow>(
    `SELECT * FROM eng_enrollments
     WHERE contact_id = ? AND status IN ${statuses} AND (? IS NULL OR id < ?)
     ORDER BY id DESC LIMIT ?`,
    input.contactId,
    before,
    before,
    q.limit + 1,
  );
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > q.limit && last !== undefined ? encodeCursor({ v: null, id: last.id }) : null;
  if (page.length === 0) return { data: [], next_cursor: null };

  const enrollmentIds = page.map((r) => r.id);
  const automations = new Map(
    byIds<{ id: string; name: string; status: AutomationStatusValue; deleted_at: number | null }>(
      db,
      [...new Set(page.map((r) => r.automation_id))],
      (list) => `SELECT id, name, status, deleted_at FROM eng_automations WHERE id IN (${list})`,
    ).map((a) => [a.id, a]),
  );
  const versionNumbers = new Map(
    byIds<{ id: string; number: number }>(
      db,
      [...new Set(page.map((r) => r.version_id))],
      (list) => `SELECT id, number FROM eng_versions WHERE id IN (${list})`,
    ).map((v) => [v.id, v.number]),
  );
  const tokens = byIds<TokenWithDue>(
    db,
    enrollmentIds,
    (list) =>
      `SELECT t.id, t.enrollment_id, t.version_id, t.node_id, t.step_index, t.status, t.last_error, j.due_at
       FROM eng_tokens t LEFT JOIN eng_jobs j ON j.kind = 'token' AND j.ref = t.id
       WHERE t.enrollment_id IN (${list}) AND t.status NOT IN ('done', 'cancelled')
       ORDER BY t.id`,
  );
  const goalHits = byIds<{ enrollment_id: string; node_id: string; at: number }>(
    db,
    enrollmentIds,
    (list) =>
      `SELECT enrollment_id, node_id, at FROM eng_goal_hits WHERE enrollment_id IN (${list}) ORDER BY at`,
  );
  const outcomes = new Map<string, string>();
  if (q.scope === 'history') {
    for (const log of byIds<{ enrollment_id: string; message: string }>(
      db,
      enrollmentIds,
      (list) =>
        `SELECT enrollment_id, message FROM eng_logs
         WHERE enrollment_id IN (${list}) AND kind IN ('completed', 'removed', 'step_failed')
         ORDER BY id`,
    )) {
      outcomes.set(log.enrollment_id, log.message);
    }
  }

  return {
    data: page.map((row) => {
      const automation = automations.get(row.automation_id);
      const graph = versionOf(row.version_id);
      const positions: ContactEnrollmentPosition[] = tokens
        .filter((t) => t.enrollment_id === row.id)
        .map((t) => {
          const node = versionOf(t.version_id)?.nodes.get(t.node_id);
          const step = node?.type === 'sequence' ? node.steps[t.step_index] : undefined;
          return {
            id: t.id,
            node_id: t.node_id,
            node_type: node?.type ?? null,
            node_label: labelOf(node),
            step_id: step?.id ?? null,
            step_type: step?.type ?? null,
            step_index: t.step_index,
            status: t.status,
            due_at: iso(t.due_at),
            last_error: t.last_error,
          };
        });
      return {
        id: row.id,
        automation_id: row.automation_id,
        automation_name: automation?.name ?? row.automation_id,
        automation_status:
          automation === undefined || automation.deleted_at !== null ? 'deleted' : automation.status,
        version_number: versionNumbers.get(row.version_id) ?? null,
        status: row.status,
        source: row.source,
        started_at: iso(row.started_at),
        ended_at: iso(row.ended_at),
        outcome: outcomes.get(row.id) ?? null,
        goals_reached: goalHits
          .filter((g) => g.enrollment_id === row.id)
          .map((g) => ({
            node_id: g.node_id,
            node_label: labelOf(graph?.nodes.get(g.node_id)),
            at: iso(g.at),
          })),
        positions,
      };
    }),
    next_cursor: nextCursor,
  };
}
