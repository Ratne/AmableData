import type {
  FunnelEdge,
  FunnelEdgeVia,
  FunnelGraphError,
  FunnelGraphErrorCode,
  FunnelNode,
  FunnelNodeKind,
} from './funnel-graph';

/** Graph shape accepted by the validator (stored graph, input or editor state). */
export interface ValidatableGraph {
  nodes: readonly FunnelNode[];
  edges: readonly FunnelEdge[];
}

const ALLOWED_VIA: Record<FunnelNodeKind, readonly FunnelEdgeVia['type'][]> = {
  traffic: ['default'],
  rotator: ['weight'],
  page_group: ['action', 'default'],
  condition: ['route', 'default'],
  external_url: [],
  action_proxy: ['default'],
  tag: ['default'],
  webhook: ['default'],
};

const SINGLE_EXIT_KINDS: ReadonlySet<FunnelNodeKind> = new Set(['traffic', 'action_proxy', 'tag', 'webhook']);
const TERMINAL_KINDS: ReadonlySet<FunnelNodeKind> = new Set(['page_group', 'external_url']);

/**
 * Structural validation of a funnel graph shared by the edge engine, the core
 * API (HTTP 422) and the visual builder. Soft-deleted nodes are ignored, as
 * are the edges leaving them.
 */
export function validateGraph(graph: ValidatableGraph): FunnelGraphError[] {
  const errors: FunnelGraphError[] = [];
  const push = (code: FunnelGraphErrorCode, message: string, ids: { node_id?: string; edge_id?: string } = {}) =>
    errors.push({ code, message, ...ids });

  const live = new Map<string, FunnelNode>();
  const deleted = new Set<string>();
  for (const node of graph.nodes) {
    if (node.deleted_at != null) deleted.add(node.id);
    else live.set(node.id, node);
  }

  const traffic = [...live.values()].filter((n) => n.kind === 'traffic');
  if (traffic.length === 0) push('no_traffic_node', 'the funnel has no active traffic node');
  for (const extra of traffic.slice(1)) {
    push('multiple_traffic_nodes', 'only one active traffic node is allowed', { node_id: extra.id });
  }

  const out = new Map<string, FunnelEdge[]>();
  for (const edge of graph.edges) {
    if (deleted.has(edge.from)) continue;
    const from = live.get(edge.from);
    if (from === undefined) {
      push('edge_unknown_node', `edge starts from unknown node "${edge.from}"`, { edge_id: edge.id });
      continue;
    }
    if (!live.has(edge.to)) {
      const why = deleted.has(edge.to) ? 'deleted' : 'unknown';
      push('edge_unknown_node', `edge points to ${why} node "${edge.to}"`, { edge_id: edge.id, node_id: from.id });
      continue;
    }
    const via = edge.via;
    if (!ALLOWED_VIA[from.kind].includes(via.type)) {
      push('edge_invalid_for_kind', `a ${from.kind} node cannot have a "${via.type}" exit`, {
        edge_id: edge.id,
        node_id: from.id,
      });
      continue;
    }
    const list = out.get(from.id) ?? [];
    if (via.type === 'default' && list.some((e) => e.via.type === 'default')) {
      push('edge_invalid_for_kind', `a ${from.kind} node has at most one default exit`, {
        edge_id: edge.id,
        node_id: from.id,
      });
      continue;
    }
    if (via.type === 'weight' && !(via.weight > 0)) {
      push('non_positive_weight', 'rotation weights must be positive', { edge_id: edge.id, node_id: from.id });
      continue;
    }
    if (via.type === 'route' && from.kind === 'condition' && !from.config.routes.some((r) => r.id === via.route_id)) {
      push('edge_unknown_route', `route "${via.route_id}" does not exist`, { edge_id: edge.id, node_id: from.id });
      continue;
    }
    list.push(edge);
    out.set(from.id, list);
  }

  for (const node of live.values()) {
    const list = out.get(node.id) ?? [];
    const hasDefault = list.some((e) => e.via.type === 'default');
    if (SINGLE_EXIT_KINDS.has(node.kind) && list.length === 0) {
      push('missing_fallback', `the ${node.kind} node needs an exit`, { node_id: node.id });
    }
    if (node.kind === 'rotator' && list.length === 0) {
      push('missing_fallback', 'the rotator needs at least one weighted exit', { node_id: node.id });
    }
    if (node.kind === 'condition') {
      if (!hasDefault) push('missing_fallback', 'the condition needs a default route', { node_id: node.id });
      for (const route of node.config.routes) {
        if (!list.some((e) => e.via.type === 'route' && e.via.route_id === route.id)) {
          push('route_without_edge', `route "${route.label}" is not connected`, { node_id: node.id });
        }
      }
    }
    if (node.kind === 'page_group') {
      if (list.length > 0 && !hasDefault) {
        push('missing_fallback', 'the page group needs a default exit', { node_id: node.id });
      }
      if (!node.config.pages.some((p) => !p.paused)) {
        push('empty_page_group', 'the page group has no active page', { node_id: node.id });
      }
    }
  }

  if (traffic.length > 0) {
    const seen = new Set<string>(traffic.map((n) => n.id));
    const queue = [...seen];
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      for (const e of out.get(id) ?? []) {
        if (!seen.has(e.to)) {
          seen.add(e.to);
          queue.push(e.to);
        }
      }
    }
    for (const node of live.values()) {
      if (!seen.has(node.id)) push('unreachable_node', 'the node cannot be reached from traffic', { node_id: node.id });
    }
  }

  for (const cycle of deadEndCycles(live, out)) {
    push('dead_end_cycle', `nodes ${cycle.join(', ')} loop without reaching a page`, { node_id: cycle[0] });
  }

  return errors;
}

/** Cycles of server-side nodes from which no page or external URL is reachable. */
function deadEndCycles(live: Map<string, FunnelNode>, out: Map<string, FunnelEdge[]>): string[][] {
  const reverse = new Map<string, string[]>();
  for (const [from, list] of out) {
    for (const e of list) reverse.set(e.to, [...(reverse.get(e.to) ?? []), from]);
  }
  const exits = new Set<string>();
  const queue = [...live.values()].filter((n) => TERMINAL_KINDS.has(n.kind)).map((n) => n.id);
  for (const id of queue) exits.add(id);
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    for (const prev of reverse.get(id) ?? []) {
      if (!exits.has(prev)) {
        exits.add(prev);
        queue.push(prev);
      }
    }
  }

  // Tarjan's strongly connected components over server-side nodes.
  const server = (id: string) => {
    const n = live.get(id);
    return n !== undefined && !TERMINAL_KINDS.has(n.kind);
  };
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const result: string[][] = [];
  let counter = 0;

  const visit = (id: string) => {
    index.set(id, counter);
    low.set(id, counter);
    counter++;
    stack.push(id);
    onStack.add(id);
    for (const e of out.get(id) ?? []) {
      if (!server(e.to)) continue;
      if (!index.has(e.to)) {
        visit(e.to);
        low.set(id, Math.min(low.get(id)!, low.get(e.to)!));
      } else if (onStack.has(e.to)) {
        low.set(id, Math.min(low.get(id)!, index.get(e.to)!));
      }
    }
    if (low.get(id) !== index.get(id)) return;
    const scc: string[] = [];
    let top: string | undefined;
    do {
      top = stack.pop()!;
      onStack.delete(top);
      scc.push(top);
    } while (top !== id);
    const cyclic = scc.length > 1 || (out.get(id) ?? []).some((e) => e.to === id);
    if (cyclic && !scc.some((n) => exits.has(n))) result.push(scc);
  };

  const order = [...live.keys()];
  for (const id of order) if (server(id) && !index.has(id)) visit(id);
  return result.map((scc) => [...scc].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
}
