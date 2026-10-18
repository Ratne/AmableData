import {
  funnelGraphSchema,
  validateGraph,
  type FunnelEdge,
  type FunnelEdgeVia,
  type FunnelGraph,
  type FunnelGraphError,
  type FunnelGraphErrorCode,
  type FunnelGraphUpdate,
  type FunnelNode,
  type FunnelNodeKind,
  type FunnelPage,
  type ValidatableGraph,
} from '@amable/api-types';

/**
 * Pure state of the visual funnel builder. The draft is edited locally and
 * only committed by an explicit save (half-edited graphs never reach live
 * links); `saved` is the baseline used by the dirty diff and by discard.
 */

export interface BuilderState {
  readonly saved: FunnelGraph;
  readonly draft: FunnelGraph;
  /** Draft replaced by the last discard, so the discard can be undone. */
  readonly discarded: FunnelGraph | null;
}

export type GraphValidator = (graph: ValidatableGraph) => FunnelGraphError[];

export type Position = { readonly x: number; readonly y: number };

export type BuilderAction =
  | { type: 'add_node'; node: FunnelNode }
  | { type: 'update_node'; node: FunnelNode }
  | { type: 'move_node'; id: string; position: Position }
  | { type: 'delete_node'; id: string; at: number }
  | { type: 'restore_node'; id: string }
  | { type: 'connect'; from: string; to: string; handle?: string | null }
  | { type: 'update_edge'; id: string; via: FunnelEdgeVia }
  | { type: 'remove_edge'; id: string }
  | { type: 'rename'; name: string }
  | { type: 'discard' }
  | { type: 'undo_discard' }
  | { type: 'saved'; graph: FunnelGraph };

/** Source handle of the fallback exit of condition nodes. */
export const DEFAULT_HANDLE = 'default';

/** Edge types each source kind may emit (`external_url` is terminal). */
export const ALLOWED_VIA: Readonly<Record<FunnelNodeKind, readonly FunnelEdgeVia['type'][]>> = {
  traffic: ['weight', 'default'],
  rotator: ['weight', 'default'],
  page_group: ['action', 'default'],
  condition: ['route', 'default'],
  external_url: [],
  action_proxy: ['action', 'default'],
  tag: ['default'],
  webhook: ['default'],
};

// ------------------------------------------------------------------ helpers

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Smallest free `<prefix><n>` id. */
export function nextId(prefix: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  let n = 1;
  while (used.has(`${prefix}${String(n)}`)) n += 1;
  return `${prefix}${String(n)}`;
}

export function liveNodes(graph: Pick<FunnelGraph, 'nodes'>): FunnelNode[] {
  return graph.nodes.filter((n) => n.deleted_at === undefined || n.deleted_at === null);
}

export function deletedNodes(graph: Pick<FunnelGraph, 'nodes'>): FunnelNode[] {
  return graph.nodes.filter((n) => n.deleted_at !== undefined && n.deleted_at !== null);
}

/** Edges whose endpoints are both live. */
export function liveEdges(graph: Pick<FunnelGraph, 'nodes' | 'edges'>): FunnelEdge[] {
  const live = new Set(liveNodes(graph).map((n) => n.id));
  return graph.edges.filter((e) => live.has(e.from) && live.has(e.to));
}

/** Default config of a new node of `kind`. */
export function createNode(
  kind: FunnelNodeKind,
  position: Position,
  taken: Iterable<string>,
  pages: readonly FunnelPage[] = [],
): FunnelNode {
  const base = { id: nextId('n', taken), position: { x: position.x, y: position.y } };
  switch (kind) {
    case 'traffic':
      return { ...base, kind, config: {} };
    case 'rotator':
      return { ...base, kind, config: { stickiness: 'none' } };
    case 'page_group':
      return {
        ...base,
        kind,
        config: { page_type: 'lander', pages: clone([...pages]), map_action_to_page: false },
      };
    case 'condition':
      return {
        ...base,
        kind,
        config: {
          routes: [
            {
              id: 'r1',
              label: 'Route 1',
              priority: 1,
              groups: [{ match: 'all', rules: [{ attr: 'country', op: 'is', values: [] }] }],
            },
          ],
        },
      };
    case 'external_url':
      return { ...base, kind, config: { url: '', append_data: true } };
    case 'action_proxy':
      return { ...base, kind, config: {} };
    case 'tag':
      return { ...base, kind, config: { add: [], remove: [] } };
    case 'webhook':
      return { ...base, kind, config: { url: '', method: 'POST' } };
  }
}

/** Via of a new edge leaving `from`, or null when the source cannot emit one. */
export function defaultVia(
  graph: Pick<FunnelGraph, 'nodes' | 'edges'>,
  from: FunnelNode,
  handle?: string | null,
): FunnelEdgeVia | null {
  const outgoing = graph.edges.filter((e) => e.from === from.id);
  switch (from.kind) {
    case 'traffic':
    case 'rotator':
      return { type: 'weight', weight: 100 };
    case 'page_group':
    case 'action_proxy': {
      const used = new Set(outgoing.flatMap((e) => (e.via.type === 'action' ? e.via.actions : [])));
      let n = 1;
      while (used.has(n)) n += 1;
      return n > 255 ? null : { type: 'action', actions: [n] };
    }
    case 'condition': {
      const linked = new Set(
        outgoing.flatMap((e) => (e.via.type === 'route' ? [e.via.route_id] : [])),
      );
      if (handle === DEFAULT_HANDLE) return { type: 'default' };
      const routes = [...from.config.routes].sort((a, b) => a.priority - b.priority);
      const picked =
        handle !== undefined && handle !== null
          ? routes.find((r) => r.id === handle)
          : routes.find((r) => !linked.has(r.id));
      if (picked !== undefined) return { type: 'route', route_id: picked.id };
      return outgoing.some((e) => e.via.type === 'default') ? null : { type: 'default' };
    }
    case 'tag':
    case 'webhook':
      return outgoing.length > 0 ? null : { type: 'default' };
    case 'external_url':
      return null;
  }
}

function sameVia(a: FunnelEdgeVia, b: FunnelEdgeVia): boolean {
  return canonical(a) === canonical(b);
}

function withDraft(state: BuilderState, draft: FunnelGraph): BuilderState {
  return { ...state, draft, discarded: null };
}

function mapNodes(state: BuilderState, id: string, fn: (node: FunnelNode) => FunnelNode) {
  if (!state.draft.nodes.some((n) => n.id === id)) return state;
  return withDraft(state, {
    ...state.draft,
    nodes: state.draft.nodes.map((n) => (n.id === id ? fn(n) : n)),
  });
}

// ------------------------------------------------------------------ reducer

export function initBuilder(graph: FunnelGraph): BuilderState {
  return { saved: clone(graph), draft: clone(graph), discarded: null };
}

export function builderReducer(state: BuilderState, action: BuilderAction): BuilderState {
  const draft = state.draft;
  switch (action.type) {
    case 'add_node':
      if (draft.nodes.some((n) => n.id === action.node.id)) return state;
      return withDraft(state, { ...draft, nodes: [...draft.nodes, clone(action.node)] });
    case 'update_node':
      return mapNodes(state, action.node.id, (current) =>
        current.kind === action.node.kind ? clone(action.node) : current,
      );
    case 'move_node':
      return mapNodes(state, action.id, (n) => ({
        ...n,
        position: { x: action.position.x, y: action.position.y },
      }));
    case 'delete_node':
      return mapNodes(state, action.id, (n) => ({ ...n, deleted_at: action.at }));
    case 'restore_node':
      return mapNodes(state, action.id, (n) => {
        const { deleted_at: _drop, ...rest } = n;
        return rest as FunnelNode;
      });
    case 'connect': {
      if (action.from === action.to) return state;
      const live = liveNodes(draft);
      const from = live.find((n) => n.id === action.from);
      if (from === undefined || !live.some((n) => n.id === action.to)) return state;
      const via = defaultVia(draft, from, action.handle);
      if (via === null) return state;
      const duplicate = draft.edges.some(
        (e) => e.from === action.from && e.to === action.to && sameVia(e.via, via),
      );
      if (duplicate) return state;
      const edge: FunnelEdge = {
        id: nextId(
          'e',
          draft.edges.map((e) => e.id),
        ),
        from: action.from,
        to: action.to,
        via,
      };
      return withDraft(state, { ...draft, edges: [...draft.edges, edge] });
    }
    case 'update_edge': {
      const edge = draft.edges.find((e) => e.id === action.id);
      const from = edge && draft.nodes.find((n) => n.id === edge.from);
      if (!edge || !from || !ALLOWED_VIA[from.kind].includes(action.via.type)) return state;
      return withDraft(state, {
        ...draft,
        edges: draft.edges.map((e) => (e.id === action.id ? { ...e, via: clone(action.via) } : e)),
      });
    }
    case 'remove_edge':
      if (!draft.edges.some((e) => e.id === action.id)) return state;
      return withDraft(state, { ...draft, edges: draft.edges.filter((e) => e.id !== action.id) });
    case 'rename':
      return withDraft(state, { ...draft, name: action.name });
    case 'discard':
      if (!isDirty(state)) return state;
      return { ...state, draft: clone(state.saved), discarded: draft };
    case 'undo_discard':
      if (state.discarded === null) return state;
      return { ...state, draft: state.discarded, discarded: null };
    case 'saved':
      return initBuilder(action.graph);
  }
}

// ------------------------------------------------------------- serialization

/** Key-sorted JSON without `null`/`undefined` members: equal graphs, equal strings. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v).sort()) {
      const member = (v as Record<string, unknown>)[key];
      if (member !== null && member !== undefined) out[key] = member;
    }
    return out;
  });
}

export function isDirty(state: BuilderState): boolean {
  return canonical(state.draft) !== canonical(state.saved);
}

export function toGraph(state: BuilderState): FunnelGraph {
  return clone(state.draft);
}

/** Body of the save request (optimistic concurrency on the saved version). */
export function toGraphUpdate(state: BuilderState): FunnelGraphUpdate {
  const d = state.draft;
  return {
    name: d.name,
    ...(d.group_id !== undefined ? { group_id: d.group_id } : {}),
    nodes: clone(d.nodes),
    edges: clone(d.edges),
    ...(d.default_cost_minor !== undefined ? { default_cost_minor: d.default_cost_minor } : {}),
    ip_anonymize: d.ip_anonymize,
    version: state.saved.version,
  };
}

// ---------------------------------------------------------------- validation

/** A schema problem (bad URL, empty label…) or a structural error of `validateGraph`. */
export interface BuilderIssue {
  readonly code: FunnelGraphErrorCode | 'invalid_config';
  readonly node_id?: string;
  readonly edge_id?: string;
  readonly message: string;
}

export function draftIssues(
  state: BuilderState,
  validator: GraphValidator = validateGraph,
): BuilderIssue[] {
  const draft = state.draft;
  const issues: BuilderIssue[] = [];
  const parsed = funnelGraphSchema.safeParse(draft);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const [section, index] = issue.path;
      const node = section === 'nodes' && typeof index === 'number' ? draft.nodes[index] : null;
      const edge = section === 'edges' && typeof index === 'number' ? draft.edges[index] : null;
      if (node && node.deleted_at !== undefined && node.deleted_at !== null) continue;
      issues.push({
        code: 'invalid_config',
        ...(node ? { node_id: node.id } : {}),
        ...(edge ? { edge_id: edge.id } : {}),
        message: issue.message,
      });
    }
  }
  for (const error of validator({ nodes: draft.nodes, edges: draft.edges })) {
    issues.push({
      code: error.code,
      ...(error.node_id !== undefined ? { node_id: error.node_id } : {}),
      ...(error.edge_id !== undefined ? { edge_id: error.edge_id } : {}),
      message: error.message,
    });
  }
  return issues;
}

/** Save is allowed only with a real diff and a valid graph. */
export function canSave(state: BuilderState, validator: GraphValidator = validateGraph): boolean {
  return isDirty(state) && draftIssues(state, validator).length === 0;
}

export function issuesByTarget(issues: readonly BuilderIssue[]) {
  const nodes = new Map<string, BuilderIssue[]>();
  const edges = new Map<string, BuilderIssue[]>();
  const graph: BuilderIssue[] = [];
  for (const issue of issues) {
    if (issue.node_id !== undefined)
      nodes.set(issue.node_id, [...(nodes.get(issue.node_id) ?? []), issue]);
    else if (issue.edge_id !== undefined)
      edges.set(issue.edge_id, [...(edges.get(issue.edge_id) ?? []), issue]);
    else graph.push(issue);
  }
  return { nodes, edges, graph };
}

// ---------------------------------------------------------------- path trace

/** Nodes and edges on any live path through `nodeId` (its ancestors and descendants). */
export function tracePath(
  graph: Pick<FunnelGraph, 'nodes' | 'edges'>,
  nodeId: string,
): { nodes: Set<string>; edges: Set<string> } {
  const edges = liveEdges(graph);
  const walk = (start: string, forward: boolean) => {
    const seen = new Set<string>([start]);
    const stack = [start];
    const used = new Set<string>();
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const e of edges) {
        const [a, b] = forward ? [e.from, e.to] : [e.to, e.from];
        if (a !== current) continue;
        used.add(e.id);
        if (!seen.has(b)) {
          seen.add(b);
          stack.push(b);
        }
      }
    }
    return { seen, used };
  };
  if (!liveNodes(graph).some((n) => n.id === nodeId)) return { nodes: new Set(), edges: new Set() };
  const down = walk(nodeId, true);
  const up = walk(nodeId, false);
  return {
    nodes: new Set([...down.seen, ...up.seen]),
    edges: new Set([...down.used, ...up.used]),
  };
}

/** Share of each weight edge among the weight edges of the same source (0..1). */
export function weightShare(graph: Pick<FunnelGraph, 'nodes' | 'edges'>, edge: FunnelEdge): number {
  if (edge.via.type !== 'weight') return 0;
  const total = liveEdges(graph)
    .filter((e) => e.from === edge.from && e.via.type === 'weight')
    .reduce((sum, e) => sum + (e.via.type === 'weight' ? e.via.weight : 0), 0);
  return total > 0 ? edge.via.weight / total : 0;
}
