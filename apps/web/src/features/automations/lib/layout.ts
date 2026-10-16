import type { AutomationGraph, GraphNode } from '@amable/api-types';

/**
 * "Tidy up": layered left-to-right layout. A node's column is its longest
 * distance from an entry (cycles are cut after one pass per node); inside a
 * column nodes follow the order of their parents (barycenter), so decision
 * branches fan out top to bottom. Notes keep their place.
 */

export const COLUMN_WIDTH = 330;
const ROW_GAP = 56;

/** Approximate rendered height (the canvas measures later; this only spaces rows). */
export function estimatedHeight(node: GraphNode): number {
  switch (node.type) {
    case 'goal':
      return node.triggers.length > 1 ? 86 : 64;
    case 'sequence':
      return 72 + Math.max(1, Math.min(node.steps.length, 9)) * 22;
    case 'decision':
      return 72 + (node.branches.length + 1) * 26;
    case 'note':
      return node.height ?? 120;
  }
}

export function tidyLayout(graph: AutomationGraph): AutomationGraph {
  const flow = graph.nodes.filter((n) => n.type !== 'note');
  if (flow.length === 0) return graph;
  const ids = new Set(flow.map((n) => n.id));
  const edges = graph.edges.filter(
    (e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target,
  );
  const incoming = new Map<string, number>(flow.map((n) => [n.id, 0]));
  for (const e of edges) incoming.set(e.target, (incoming.get(e.target) ?? 0) + 1);

  // Drop back edges (found by DFS from the entries) so loops do not stretch the layout.
  const outgoing = new Map<string, typeof edges>();
  for (const e of edges) outgoing.set(e.source, [...(outgoing.get(e.source) ?? []), e]);
  const state = new Map<string, 'open' | 'done'>();
  const back = new Set<string>();
  const visit = (id: string): void => {
    state.set(id, 'open');
    for (const e of outgoing.get(id) ?? []) {
      const s = state.get(e.target);
      if (s === 'open') back.add(e.id);
      else if (s === undefined) visit(e.target);
    }
    state.set(id, 'done');
  };
  const entries = flow.filter((n) => (incoming.get(n.id) ?? 0) === 0);
  for (const node of [...entries, ...flow]) if (!state.has(node.id)) visit(node.id);
  const forward = edges.filter((e) => !back.has(e.id));

  // Longest-path depth on the remaining DAG.
  const depth = new Map<string, number>(flow.map((n) => [n.id, 0]));
  for (let round = 0; round < flow.length; round += 1) {
    let changed = false;
    for (const e of forward) {
      const next = (depth.get(e.source) ?? 0) + 1;
      if (next > (depth.get(e.target) ?? 0)) {
        depth.set(e.target, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Branch order of each source handle, so a decision's branches keep their order.
  const handleRank = (sourceId: string, handle: string | undefined): number => {
    const source = flow.find((n) => n.id === sourceId);
    if (source?.type !== 'decision' || handle === undefined) return 0;
    const index = source.branches.findIndex((b) => b.id === handle);
    return index === -1 ? source.branches.length : index;
  };

  const columns = new Map<number, GraphNode[]>();
  for (const node of flow) {
    const d = depth.get(node.id) ?? 0;
    columns.set(d, [...(columns.get(d) ?? []), node]);
  }
  const order = new Map<string, number>();
  const positions = new Map<string, { x: number; y: number }>();
  const origin = {
    x: Math.min(...flow.map((n) => n.position.x)),
    y: Math.min(...flow.map((n) => n.position.y)),
  };
  for (const d of [...columns.keys()].sort((a, b) => a - b)) {
    const column = columns.get(d) ?? [];
    const key = (node: GraphNode): number => {
      const parents = forward.filter((e) => e.target === node.id && order.has(e.source));
      if (parents.length === 0) return node.position.y / 10_000;
      return (
        parents.reduce(
          (sum, e) =>
            sum + (order.get(e.source) ?? 0) + handleRank(e.source, e.source_handle) / 100,
          0,
        ) / parents.length
      );
    };
    const sorted = [...column].sort((a, b) => key(a) - key(b));
    const heights = sorted.map(estimatedHeight);
    const total = heights.reduce((sum, h) => sum + h, 0) + ROW_GAP * (sorted.length - 1);
    let y = origin.y - total / 2 + (heights[0] ?? 0) / 2;
    sorted.forEach((node, index) => {
      order.set(node.id, index);
      positions.set(node.id, {
        x: origin.x + d * COLUMN_WIDTH,
        y: Math.round(y - (heights[index] ?? 0) / 2),
      });
      y += (heights[index] ?? 0) / 2 + ROW_GAP + (heights[index + 1] ?? 0) / 2;
    });
  }
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const position = positions.get(node.id);
      return position === undefined ? node : { ...node, position };
    }),
  };
}
