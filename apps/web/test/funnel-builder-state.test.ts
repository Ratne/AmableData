import type { FunnelGraph, FunnelGraphError, FunnelNodeOf } from '@amable/api-types';
import { describe, expect, it } from 'vitest';
import { mockFunnelGraph, mockHeatmap } from '../src/features/analytics/funnel-builder/mock';
import {
  builderReducer,
  canSave,
  createNode,
  deletedNodes,
  draftIssues,
  initBuilder,
  isDirty,
  liveEdges,
  liveNodes,
  toGraph,
  toGraphUpdate,
  tracePath,
  type BuilderAction,
  type BuilderState,
} from '../src/features/analytics/funnel-builder/state';

const T0 = Date.UTC(2026, 9, 15, 10);
const valid = () => [] as FunnelGraphError[];
const failing = (): FunnelGraphError[] => [
  { code: 'missing_fallback', node_id: 'n2', message: 'no fallback' },
];

function graph(): FunnelGraph {
  return {
    id: 'f1',
    name: 'Funnel',
    group_id: null,
    version: 3,
    nodes: [
      { id: 'n1', kind: 'traffic', position: { x: 0, y: 0 }, config: {} },
      {
        id: 'n2',
        kind: 'page_group',
        label: 'Landers',
        position: { x: 300, y: 0 },
        config: {
          page_type: 'lander',
          pages: [
            { id: 'p1', name: 'Quiz', url: 'https://example.com/q', weight: 100, paused: false },
          ],
          map_action_to_page: false,
        },
      },
    ],
    edges: [{ id: 'e1', from: 'n1', to: 'n2', via: { type: 'weight', weight: 100 } }],
    default_cost_minor: null,
    ip_anonymize: false,
    status: 'active',
    created_at: T0,
    updated_at: T0,
  };
}

function run(state: BuilderState, ...actions: BuilderAction[]): BuilderState {
  return actions.reduce(builderReducer, state);
}

describe('funnel builder state', () => {
  it('adds nodes with fresh ids and connects them with a via derived from the source kind', () => {
    const start = initBuilder(graph());
    const offer = createNode(
      'page_group',
      { x: 600, y: 0 },
      start.draft.nodes.map((n) => n.id),
    );
    expect(offer.id).toBe('n3');
    const s = run(
      start,
      { type: 'add_node', node: offer },
      { type: 'connect', from: 'n2', to: 'n3' },
      { type: 'connect', from: 'n2', to: 'n3' },
    );
    expect(s.draft.nodes.map((n) => n.id)).toEqual(['n1', 'n2', 'n3']);
    const added = s.draft.edges.filter((e) => e.from === 'n2');
    expect(added.map((e) => e.via)).toEqual([
      { type: 'action', actions: [1] },
      { type: 'action', actions: [2] },
    ]);
    expect(added.map((e) => e.id)).toEqual(['e2', 'e3']);
    expect(isDirty(s)).toBe(true);
  });

  it('routes condition handles to their route or to the default exit', () => {
    const start = initBuilder(graph());
    const cond = createNode('condition', { x: 0, y: 0 }, ['n1', 'n2']);
    const s = run(
      start,
      { type: 'add_node', node: cond },
      { type: 'connect', from: 'n3', to: 'n2', handle: 'r1' },
      { type: 'connect', from: 'n3', to: 'n1', handle: 'default' },
    );
    expect(s.draft.edges.filter((e) => e.from === 'n3').map((e) => e.via)).toEqual([
      { type: 'route', route_id: 'r1' },
      { type: 'default' },
    ]);
  });

  it('refuses self loops, terminal sources and invalid via types', () => {
    const start = initBuilder(graph());
    const ext = createNode('external_url', { x: 0, y: 0 }, ['n1', 'n2']);
    const s = run(
      start,
      { type: 'add_node', node: ext },
      { type: 'connect', from: 'n2', to: 'n2' },
      { type: 'connect', from: 'n3', to: 'n2' },
      { type: 'update_edge', id: 'e1', via: { type: 'route', route_id: 'r1' } },
    );
    expect(s.draft.edges).toEqual(start.draft.edges);
  });

  it('updates node config and edge via', () => {
    const s = run(
      initBuilder(graph()),
      { type: 'update_edge', id: 'e1', via: { type: 'weight', weight: 40 } },
      { type: 'rename', name: 'Renamed' },
    );
    const node = s.draft.nodes[1] as FunnelNodeOf<'page_group'>;
    const next = run(s, {
      type: 'update_node',
      node: { ...node, config: { ...node.config, page_type: 'offer' } },
    });
    expect((next.draft.nodes[1] as FunnelNodeOf<'page_group'>).config.page_type).toBe('offer');
    expect(next.draft.edges[0]?.via).toEqual({ type: 'weight', weight: 40 });
    expect(next.draft.name).toBe('Renamed');
  });

  it('soft-deletes nodes keeping their edges and restores them', () => {
    const start = initBuilder(graph());
    const deleted = run(start, { type: 'delete_node', id: 'n2', at: T0 + 5 });
    expect(deleted.draft.nodes).toHaveLength(2);
    expect(deletedNodes(deleted.draft).map((n) => n.id)).toEqual(['n2']);
    expect(liveNodes(deleted.draft).map((n) => n.id)).toEqual(['n1']);
    expect(deleted.draft.edges).toHaveLength(1);
    expect(liveEdges(deleted.draft)).toHaveLength(0);
    expect(isDirty(deleted)).toBe(true);
    const restored = run(deleted, { type: 'restore_node', id: 'n2' });
    expect(restored.draft.nodes[1]).not.toHaveProperty('deleted_at');
    expect(isDirty(restored)).toBe(false);
  });

  it('discard restores the last saved graph and can be undone', () => {
    const start = initBuilder(graph());
    const edited = run(start, { type: 'move_node', id: 'n2', position: { x: 10, y: 20 } });
    const discarded = run(edited, { type: 'discard' });
    expect(toGraph(discarded)).toEqual(graph());
    expect(isDirty(discarded)).toBe(false);
    const undone = run(discarded, { type: 'undo_discard' });
    expect(undone.draft.nodes[1]?.position).toEqual({ x: 10, y: 20 });
    expect(run(undone, { type: 'rename', name: 'x' }).discarded).toBeNull();
  });

  it('is not dirty after a change is reverted by hand', () => {
    const start = initBuilder(graph());
    const node = start.draft.nodes[1] as FunnelNodeOf<'page_group'>;
    const s = run(
      start,
      { type: 'update_node', node: { ...node, label: 'Other' } },
      { type: 'move_node', id: 'n1', position: { x: 5, y: 5 } },
    );
    expect(isDirty(s)).toBe(true);
    const back = run(
      s,
      { type: 'update_node', node },
      { type: 'move_node', id: 'n1', position: { x: 0, y: 0 } },
    );
    expect(isDirty(back)).toBe(false);
    expect(canSave(back, valid)).toBe(false);
  });

  it('blocks saving when the validator or the schema report errors', () => {
    const dirty = run(initBuilder(graph()), { type: 'rename', name: 'Changed' });
    expect(canSave(dirty, valid)).toBe(true);
    expect(canSave(dirty, failing)).toBe(false);
    expect(draftIssues(dirty, failing)).toEqual([
      { code: 'missing_fallback', node_id: 'n2', message: 'no fallback' },
    ]);

    const ext = createNode('external_url', { x: 0, y: 0 }, ['n1', 'n2']);
    const broken = run(dirty, { type: 'add_node', node: ext });
    expect(canSave(broken, valid)).toBe(false);
    expect(draftIssues(broken, valid).every((i) => i.node_id === 'n3')).toBe(true);
    // Soft-deleted nodes do not block the save.
    expect(canSave(run(broken, { type: 'delete_node', id: 'n3', at: T0 }), valid)).toBe(true);
  });

  it('marks a save as the new baseline', () => {
    const dirty = run(initBuilder(graph()), { type: 'rename', name: 'Changed' });
    const update = toGraphUpdate(dirty);
    expect(update.version).toBe(3);
    expect(update.name).toBe('Changed');
    const saved = run(dirty, { type: 'saved', graph: { ...toGraph(dirty), version: 4 } });
    expect(isDirty(saved)).toBe(false);
    expect(saved.saved.version).toBe(4);
  });

  it('round-trips FunnelGraph -> state -> FunnelGraph', () => {
    for (const g of [graph(), mockFunnelGraph('demo')]) {
      const state = initBuilder(g);
      expect(toGraph(state)).toEqual(g);
      expect(isDirty(state)).toBe(false);
      expect(JSON.parse(JSON.stringify(toGraph(state)))).toEqual(g);
    }
  });

  it('traces the paths through a node', () => {
    const g = mockFunnelGraph('demo');
    const trace = tracePath(g, 'n4');
    expect([...trace.nodes].sort()).toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7']);
    expect(trace.edges.has('e7')).toBe(false);
    expect(trace.edges.has('e6')).toBe(true);
  });

  it('builds a consistent mock heatmap', () => {
    const g = mockFunnelGraph('demo');
    const visits = mockHeatmap(g, 'visits');
    expect(visits.nodes.find((n) => n.node_id === 'n1')?.value).toBe(10_000);
    const flow = mockHeatmap(g, 'flow_pct');
    expect(flow.nodes.find((n) => n.node_id === 'n1')?.value).toBe(100);
    for (const n of visits.nodes) expect(n.conversions).toBeLessThanOrEqual(n.visits);
  });
});
