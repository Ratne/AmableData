import { describe, expect, it } from 'vitest';
import {
  FUNNEL_GRAPH_ERROR_CODES,
  funnelEdgeSchema,
  funnelNodeSchema,
  validateGraph,
  type FunnelEdge,
  type FunnelGraphErrorCode,
  type FunnelNode,
  type ValidatableGraph,
} from '../src/index';

const node = (input: unknown): FunnelNode => funnelNodeSchema.parse(input);
const edge = (id: string, from: string, to: string, via: unknown = { type: 'default' }): FunnelEdge =>
  funnelEdgeSchema.parse({ id, from, to, via });

const page = (id: string, paused = false) => ({ id, name: id, url: `https://example.com/${id}`, weight: 1, paused });

/** traffic → rotator → condition(route vip | default) → lander → (action 1 | default) → offer */
function validGraph(): { nodes: FunnelNode[]; edges: FunnelEdge[] } {
  return {
    nodes: [
      node({ id: 'traffic', kind: 'traffic' }),
      node({ id: 'rot', kind: 'rotator', config: { stickiness: 'none' } }),
      node({
        id: 'cond',
        kind: 'condition',
        config: {
          routes: [
            {
              id: 'vip',
              label: 'VIP',
              priority: 1,
              groups: [{ match: 'any', rules: [{ attr: 'tag', op: 'is', values: ['vip'] }] }],
            },
          ],
        },
      }),
      node({ id: 'tag', kind: 'tag', config: { add: ['seen'] } }),
      node({ id: 'lander', kind: 'page_group', config: { page_type: 'lander', pages: [page('l1')] } }),
      node({ id: 'offer', kind: 'page_group', config: { page_type: 'offer', pages: [page('o1')] } }),
    ],
    edges: [
      edge('e1', 'traffic', 'rot'),
      edge('e2', 'rot', 'cond', { type: 'weight', weight: 1 }),
      edge('e3', 'cond', 'lander', { type: 'route', route_id: 'vip' }),
      edge('e4', 'cond', 'tag'),
      edge('e5', 'tag', 'lander'),
      edge('e6', 'lander', 'offer', { type: 'action', actions: [1] }),
      edge('e7', 'lander', 'offer'),
    ],
  };
}

const codes = (graph: ValidatableGraph): FunnelGraphErrorCode[] => validateGraph(graph).map((e) => e.code);

describe('validateGraph', () => {
  it('accepts a well-formed graph', () => {
    expect(validateGraph(validGraph())).toEqual([]);
  });

  it('ignores soft-deleted nodes and their edges', () => {
    const g = validGraph();
    g.nodes.push(node({ id: 'old', kind: 'rotator', config: {}, deleted_at: 1 }));
    g.edges.push(edge('e_old', 'old', 'lander', { type: 'weight', weight: 1 }));
    expect(validateGraph(g)).toEqual([]);
  });

  const cases: Record<FunnelGraphErrorCode, (g: ReturnType<typeof validGraph>) => void> = {
    no_traffic_node: (g) => {
      g.nodes[0] = { ...g.nodes[0]!, deleted_at: 5 };
    },
    multiple_traffic_nodes: (g) => {
      g.nodes.push(node({ id: 'traffic2', kind: 'traffic' }));
      g.edges.push(edge('e_t2', 'traffic2', 'lander'));
    },
    edge_unknown_node: (g) => {
      g.edges.push(edge('e_x', 'lander', 'ghost', { type: 'action', actions: [2] }));
    },
    edge_invalid_for_kind: (g) => {
      g.edges.push(edge('e_x', 'rot', 'offer'));
    },
    missing_fallback: (g) => {
      g.edges = g.edges.filter((e) => e.id !== 'e4');
    },
    non_positive_weight: (g) => {
      g.edges.push({ id: 'e_w', from: 'rot', to: 'offer', via: { type: 'weight', weight: 0 } });
    },
    route_without_edge: (g) => {
      g.edges = g.edges.filter((e) => e.id !== 'e3');
    },
    edge_unknown_route: (g) => {
      g.edges.push(edge('e_r', 'cond', 'offer', { type: 'route', route_id: 'nope' }));
    },
    empty_page_group: (g) => {
      g.nodes[5] = node({ id: 'offer', kind: 'page_group', config: { page_type: 'offer', pages: [page('o1', true)] } });
    },
    dead_end_cycle: (g) => {
      g.nodes.push(node({ id: 'loop_a', kind: 'tag', config: {} }), node({ id: 'loop_b', kind: 'action_proxy' }));
      g.edges.push(
        edge('e_la', 'loop_a', 'loop_b'),
        edge('e_lb', 'loop_b', 'loop_a'),
        edge('e_in', 'rot', 'loop_a', { type: 'weight', weight: 1 }),
      );
    },
    unreachable_node: (g) => {
      g.nodes.push(node({ id: 'island', kind: 'page_group', config: { page_type: 'offer', pages: [page('x')] } }));
    },
  };

  it('covers every error code', () => {
    expect(Object.keys(cases).sort()).toEqual([...FUNNEL_GRAPH_ERROR_CODES].sort());
  });

  for (const code of FUNNEL_GRAPH_ERROR_CODES) {
    it(`reports ${code}`, () => {
      const g = validGraph();
      cases[code](g);
      expect(codes(g)).toContain(code);
      expect(codes(validGraph())).not.toContain(code);
    });
  }

  it('reports the offending node and edge ids', () => {
    const g = validGraph();
    g.edges.push(edge('e_bad', 'lander', 'ghost'));
    expect(validateGraph(g)).toContainEqual(
      expect.objectContaining({ code: 'edge_unknown_node', edge_id: 'e_bad', node_id: 'lander' }),
    );
  });

  it('flags edges pointing to soft-deleted nodes', () => {
    const g = validGraph();
    g.nodes[5] = { ...g.nodes[5]!, deleted_at: 9 };
    expect(codes(g)).toContain('edge_unknown_node');
  });

  it('allows at most one exit on single-exit nodes', () => {
    const g = validGraph();
    g.edges.push(edge('e_dup', 'traffic', 'lander'));
    expect(validateGraph(g)).toContainEqual(
      expect.objectContaining({ code: 'edge_invalid_for_kind', edge_id: 'e_dup' }),
    );
  });

  it('rejects any exit from an external URL', () => {
    const g = validGraph();
    g.nodes.push(node({ id: 'ext', kind: 'external_url', config: { url: 'https://example.org' } }));
    g.edges.push(edge('e_ext_in', 'lander', 'ext', { type: 'action', actions: [3] }), edge('e_ext', 'ext', 'offer'));
    expect(validateGraph(g)).toEqual([
      expect.objectContaining({ code: 'edge_invalid_for_kind', edge_id: 'e_ext' }),
    ]);
  });

  it('requires a default exit on page groups only when they have exits', () => {
    const g = validGraph();
    g.edges = g.edges.filter((e) => e.id !== 'e7');
    expect(validateGraph(g)).toEqual([expect.objectContaining({ code: 'missing_fallback', node_id: 'lander' })]);
    // The offer group has no exits at all and is fine.
    expect(codes(validGraph())).toEqual([]);
  });

  it('flags single-exit and rotator nodes without exits', () => {
    for (const kind of ['tag', 'webhook', 'action_proxy', 'rotator'] as const) {
      const g = validGraph();
      const config = kind === 'webhook' ? { url: 'https://hooks.example.com' } : {};
      g.nodes.push(node({ id: 'stub', kind, config }));
      g.edges.push(edge('e_stub', 'lander', 'stub', { type: 'action', actions: [9] }));
      expect(validateGraph(g)).toEqual([expect.objectContaining({ code: 'missing_fallback', node_id: 'stub' })]);
    }
  });

  it('accepts server cycles that can still reach a page', () => {
    const g = validGraph();
    g.edges.push(edge('e_back', 'rot', 'rot', { type: 'weight', weight: 1 }));
    expect(codes(g)).not.toContain('dead_end_cycle');
  });

  it('flags a self-looping server node', () => {
    const g = validGraph();
    g.nodes.push(node({ id: 'spin', kind: 'rotator', config: {} }));
    g.edges.push(
      edge('e_spin', 'spin', 'spin', { type: 'weight', weight: 1 }),
      edge('e_to_spin', 'lander', 'spin', { type: 'action', actions: [4] }),
    );
    expect(validateGraph(g)).toEqual([expect.objectContaining({ code: 'dead_end_cycle', node_id: 'spin' })]);
  });
});
