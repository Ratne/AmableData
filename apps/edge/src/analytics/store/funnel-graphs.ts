import type {
  FunnelGraph,
  FunnelGraphSummary,
  FunnelStatus,
  funnelGraphInputSchema,
  funnelGraphUpdateSchema,
} from '@amable/api-types';
import type { z } from 'zod';
import { first, type SqlDb } from '../db/sql';
import { newObjectId } from './config';

/**
 * Funnel graphs: the current version lives in `funnel_graphs`, every saved
 * version is kept in `funnel_graph_versions` (touches reference nodes of old
 * versions). Archive is the soft-delete: links of archived funnels keep
 * resolving through the history, nothing is ever removed.
 */

export type FunnelGraphBody = z.output<typeof funnelGraphInputSchema>;
export type FunnelGraphUpdateBody = z.output<typeof funnelGraphUpdateSchema>;

interface FunnelGraphRow {
  id: string;
  name: string;
  group_id: string | null;
  status: FunnelStatus;
  version: number;
  graph: string;
  created_at: number;
  updated_at: number;
}

type StoredGraph = Pick<FunnelGraph, 'nodes' | 'edges' | 'default_cost_minor' | 'ip_anonymize'>;

function graphJson(body: FunnelGraphBody): string {
  const stored: StoredGraph = {
    nodes: body.nodes,
    edges: body.edges,
    default_cost_minor: body.default_cost_minor ?? null,
    ip_anonymize: body.ip_anonymize,
  };
  return JSON.stringify(stored);
}

function toGraph(row: FunnelGraphRow): FunnelGraph {
  const stored = JSON.parse(row.graph) as StoredGraph;
  return {
    id: row.id,
    name: row.name,
    group_id: row.group_id,
    nodes: stored.nodes,
    edges: stored.edges,
    default_cost_minor: stored.default_cost_minor ?? null,
    ip_anonymize: stored.ip_anonymize,
    version: row.version,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function saveVersion(
  db: SqlDb,
  id: string,
  version: number,
  body: FunnelGraphBody,
  now: number,
): void {
  db.run(
    `INSERT INTO funnel_graph_versions (funnel_id, version, name, graph, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (funnel_id, version) DO NOTHING`,
    id,
    version,
    body.name,
    graphJson(body),
    now,
  );
}

export function getFunnelGraph(db: SqlDb, id: string): FunnelGraph | null {
  const row = first<FunnelGraphRow>(db, `SELECT * FROM funnel_graphs WHERE id = ?`, id);
  return row === undefined ? null : toGraph(row);
}

/** A past version (same id/status/created_at as the current row). */
export function getFunnelGraphVersion(db: SqlDb, id: string, version: number): FunnelGraph | null {
  const row = first<FunnelGraphRow & { v_name: string; v_graph: string; v_created_at: number }>(
    db,
    `SELECT g.*, v.name AS v_name, v.graph AS v_graph, v.created_at AS v_created_at
     FROM funnel_graph_versions v JOIN funnel_graphs g ON g.id = v.funnel_id
     WHERE v.funnel_id = ? AND v.version = ?`,
    id,
    version,
  );
  if (row === undefined) return null;
  return toGraph({
    ...row,
    name: row.v_name,
    graph: row.v_graph,
    version,
    updated_at: row.v_created_at,
  });
}

export function listFunnelGraphs(db: SqlDb, status?: FunnelStatus): FunnelGraphSummary[] {
  const rows =
    status === undefined
      ? db.all<FunnelGraphRow>(`SELECT * FROM funnel_graphs ORDER BY rowid`)
      : db.all<FunnelGraphRow>(
          `SELECT * FROM funnel_graphs WHERE status = ? ORDER BY rowid`,
          status,
        );
  return rows.map((row) => {
    const graph = toGraph(row);
    return {
      id: graph.id,
      name: graph.name,
      group_id: graph.group_id ?? null,
      status: graph.status,
      version: graph.version,
      node_count: graph.nodes.filter((n) => n.deleted_at === undefined || n.deleted_at === null)
        .length,
      updated_at: graph.updated_at,
    };
  });
}

export function createFunnelGraph(db: SqlDb, body: FunnelGraphBody, now: number): FunnelGraph {
  const id = newObjectId('fg');
  db.run(
    `INSERT INTO funnel_graphs (id, name, group_id, status, version, graph, created_at, updated_at)
     VALUES (?, ?, ?, 'active', 1, ?, ?, ?)`,
    id,
    body.name,
    body.group_id ?? null,
    graphJson(body),
    now,
    now,
  );
  saveVersion(db, id, 1, body, now);
  return getFunnelGraph(db, id) as FunnelGraph;
}

export type UpdateFunnelGraphOutcome =
  | { ok: true; graph: FunnelGraph }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'conflict'; current_version: number };

/** Optimistic concurrency: saves only when `body.version` is the stored version. */
export function updateFunnelGraph(
  db: SqlDb,
  id: string,
  body: FunnelGraphUpdateBody,
  now: number,
): UpdateFunnelGraphOutcome {
  const next = body.version + 1;
  const updated = db.all<{ id: string }>(
    `UPDATE funnel_graphs SET name = ?, group_id = ?, graph = ?, version = ?, updated_at = ?
     WHERE id = ? AND version = ? RETURNING id`,
    body.name,
    body.group_id ?? null,
    graphJson(body),
    next,
    now,
    id,
    body.version,
  );
  if (updated.length === 0) {
    const current = first<{ version: number }>(
      db,
      `SELECT version FROM funnel_graphs WHERE id = ?`,
      id,
    );
    return current === undefined
      ? { ok: false, reason: 'not_found' }
      : { ok: false, reason: 'conflict', current_version: current.version };
  }
  saveVersion(db, id, next, body, now);
  return { ok: true, graph: getFunnelGraph(db, id) as FunnelGraph };
}

export function setFunnelGraphStatus(
  db: SqlDb,
  id: string,
  status: FunnelStatus,
  now: number,
): FunnelGraph | null {
  db.run(
    `UPDATE funnel_graphs SET status = ?, archived_at = ?, updated_at = ? WHERE id = ?`,
    status,
    status === 'archived' ? now : null,
    now,
    id,
  );
  return getFunnelGraph(db, id);
}
