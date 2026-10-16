import type { AutomationGraph } from '@amable/api-types';
import type { SqlDb, SqlValue } from '../crm/db/sql';
import { CrmError } from '../crm/errors';
import type { CrmResult } from '../crm/ops';
import {
  bucketCte,
  ensureIndexes,
  lit,
  type AggregateInput,
  type AggregateOutput,
  type AggregateRow,
} from '../reports/aggregate';
import type { AutomationEngine } from './engine';

/**
 * Read-only aggregates of the Engine DO for the report engine: enrollments per
 * automation (entered / completed / failed / removed in the range, active now,
 * lifetime step errors) and the per-node counters of one automation. Reached
 * through `Engine.report` (separate from the automation API dispatcher).
 * Additive index on `eng_enrollments.started_at`, created at first use.
 */

const ENGINE_REPORT_INDEXES: ReadonlyArray<[string, string]> = [
  [
    'eng_enrollments',
    `CREATE INDEX IF NOT EXISTS rpt_enrollments_started ON eng_enrollments (started_at)`,
  ],
];

const MEASURE_SQL: Readonly<Record<string, string>> = {
  entered: 'COUNT(*)',
  completed: `SUM(CASE WHEN en.status = 'completed' THEN 1 ELSE 0 END)`,
  failed: `SUM(CASE WHEN en.status = 'failed' THEN 1 ELSE 0 END)`,
  removed: `SUM(CASE WHEN en.status = 'removed' THEN 1 ELSE 0 END)`,
};

function num(v: SqlValue | undefined): number {
  return typeof v === 'number' ? v : 0;
}

function automationsReport(db: SqlDb, input: AggregateInput): AggregateOutput {
  const range = `en.started_at >= ${lit(input.range.from)} AND en.started_at < ${lit(input.range.to)}`;
  const ranged = input.measures.filter((m) => m in MEASURE_SQL);
  const select = ranged.map((m) => `${MEASURE_SQL[m] ?? '0'} AS "${m}"`).join(', ');
  if (input.dimension === 'date') {
    const rows: AggregateRow[] = [];
    if (input.buckets !== null && ranged.length > 0) {
      for (const r of db.all<Record<string, SqlValue>>(
        `WITH ${bucketCte(input.buckets)}
         SELECT b.k AS k, ${select} FROM eng_enrollments en
           JOIN b ON en.started_at >= b.s AND en.started_at < b.e
          WHERE ${range} GROUP BY b.k ORDER BY b.k`,
      )) {
        rows.push({
          key: String(r['k']),
          label: null,
          values: Object.fromEntries(input.measures.map((m) => [m, num(r[m])])),
        });
      }
    }
    const totals = db.all<Record<string, SqlValue>>(
      `SELECT ${select || '0 AS none'} FROM eng_enrollments en WHERE ${range}`,
    )[0];
    return {
      rows,
      totals: Object.fromEntries(input.measures.map((m) => [m, num(totals?.[m])])),
      currency: null,
      currencies: [],
      truncated: false,
    };
  }
  const all = db
    .all<Record<string, SqlValue>>(
      `SELECT a.id AS k, a.name AS label,
              COALESCE(e.entered, 0) AS entered, COALESCE(e.completed, 0) AS completed,
              COALESCE(e.failed, 0) AS failed, COALESCE(e.removed, 0) AS removed,
              (SELECT COUNT(*) FROM eng_enrollments x WHERE x.automation_id = a.id AND x.status = 'active') AS active,
              (SELECT COALESCE(SUM(ns.errors), 0) FROM eng_node_stats ns
                WHERE ns.automation_id = a.id AND ns.step_id = '') AS errors
         FROM eng_automations a
         LEFT JOIN (SELECT en.automation_id AS automation_id,
                           ${Object.entries(MEASURE_SQL)
                             .map(([m, sql]) => `${sql} AS ${m}`)
                             .join(', ')}
                      FROM eng_enrollments en WHERE ${range} GROUP BY en.automation_id) e
           ON e.automation_id = a.id
        WHERE a.deleted_at IS NULL`,
    )
    .map((r) => ({
      key: String(r['k']),
      label: typeof r['label'] === 'string' ? r['label'] : null,
      values: Object.fromEntries(input.measures.map((m) => [m, num(r[m])])),
    }));
  const totals: Record<string, number> = {};
  for (const m of input.measures) totals[m] = all.reduce((sum, r) => sum + (r.values[m] ?? 0), 0);
  const first = input.measures[0] ?? 'entered';
  all.sort(
    (a, b) =>
      (b.values[first] ?? 0) - (a.values[first] ?? 0) ||
      (a.label ?? '').localeCompare(b.label ?? ''),
  );
  return {
    rows: input.dimension === null ? [] : all.slice(input.offset, input.offset + input.limit),
    totals,
    currency: null,
    currencies: [],
    truncated: input.dimension !== null && all.length > input.offset + input.limit,
    notes: ['errors_lifetime'],
  };
}

function nodeLabel(graph: AutomationGraph, nodeId: string, stepId: string | null): string {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (node === undefined) return stepId === null ? nodeId : `${nodeId} › ${stepId}`;
  const base =
    'label' in node && typeof node.label === 'string' && node.label !== ''
      ? node.label
      : `${node.type} ${node.id}`;
  if (stepId === null) return base;
  const step = node.type === 'sequence' ? node.steps.find((s) => s.id === stepId) : undefined;
  return `${base} › ${step === undefined ? stepId : `${step.type} ${step.id}`}`;
}

function automationOptions(db: SqlDb): Array<{ value: string; label: string }> {
  return db
    .all<{ id: string; name: string }>(
      `SELECT id, name FROM eng_automations WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 200`,
    )
    .map((r) => ({ value: r.id, label: r.name }));
}

function nodesReport(db: SqlDb, engine: AutomationEngine, input: AggregateInput): AggregateOutput {
  const options = { automation_id: automationOptions(db) };
  const automationId = input.params?.['automation_id'] ?? '';
  if (automationId === '') {
    return {
      rows: [],
      totals: {},
      currency: null,
      currencies: [],
      truncated: false,
      options,
      emptyReason: 'param_required',
    };
  }
  const stats = engine.stats({ id: automationId });
  const graph = engine.getAutomation({ id: automationId }).draft_graph;
  const rows: AggregateRow[] = stats.nodes.map((n) => ({
    key: n.step_id === null ? n.node_id : `${n.node_id}#${n.step_id}`,
    label: nodeLabel(graph, n.node_id, n.step_id),
    values: Object.fromEntries(
      input.measures.map((m) => [m, m in n ? Number(n[m as keyof typeof n] ?? 0) : 0]),
    ),
  }));
  const totals: Record<string, number> = {};
  const nodeRows = stats.nodes.filter((n) => n.step_id === null);
  for (const m of input.measures) {
    totals[m] = nodeRows.reduce(
      (s, n) => s + (m in n ? Number(n[m as keyof typeof n] ?? 0) : 0),
      0,
    );
  }
  return {
    rows: rows.slice(input.offset, input.offset + input.limit),
    totals,
    currency: null,
    currencies: [],
    truncated: rows.length > input.offset + input.limit,
    options,
  };
}

/** Dispatcher of `Engine.report(tenantId, op, input)`. */
export function runAutomationReportOp(
  db: SqlDb,
  engine: AutomationEngine,
  op: string,
  input: unknown,
): CrmResult<unknown> {
  if (op !== 'reports.aggregate') {
    return {
      ok: false,
      error: new CrmError('bad_request', `unknown report operation ${op}`).toShape(),
    };
  }
  const aggregate = input as AggregateInput;
  try {
    ensureIndexes(db, 'engine', ENGINE_REPORT_INDEXES);
    if (aggregate.source === 'automations')
      return { ok: true, value: automationsReport(db, aggregate) };
    if (aggregate.source === 'automation_nodes')
      return { ok: true, value: nodesReport(db, engine, aggregate) };
    return {
      ok: false,
      error: new CrmError(
        'bad_request',
        `source ${aggregate.source} is not served by the engine`,
      ).toShape(),
    };
  } catch (error) {
    if (error instanceof CrmError) return { ok: false, error: error.toShape() };
    throw error;
  }
}
