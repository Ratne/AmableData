import type { AutomationGraph } from '@amable/api-types';
import { describe, expect, it } from 'vitest';
import { createNode, duplicateNode } from '../../src/features/automations/lib/defaults';
import {
  canConnect,
  connectionToEdge,
  flowToGraph,
  graphToFlow,
  takenIds,
} from '../../src/features/automations/lib/flow-mapping';

const graph: AutomationGraph = {
  schema_version: 1,
  nodes: [
    {
      id: 'g1',
      type: 'goal',
      position: { x: 0, y: 0 },
      triggers: [{ type: 'tag_applied', tag_ids: ['01JTAG0000000000000000000A'] }],
    },
    {
      id: 's1',
      type: 'sequence',
      position: { x: 300, y: 0 },
      label: 'Welcome',
      steps: [{ id: 'st1', type: 'delay', duration: { amount: 2, unit: 'days' } }],
    },
    {
      id: 'd1',
      type: 'decision',
      position: { x: 600, y: 0 },
      branches: [
        {
          id: 'hot',
          label: 'Hot',
          filter: {
            type: 'group',
            op: 'and',
            conditions: [{ type: 'field', field: 'score_value', operator: 'gte', value: 50 }],
          },
        },
      ],
    },
    { id: 's2', type: 'sequence', position: { x: 900, y: -100 }, steps: [] },
    { id: 's3', type: 'sequence', position: { x: 900, y: 100 }, steps: [] },
    {
      id: 'n1',
      type: 'note',
      position: { x: 0, y: 200 },
      text: 'Remember',
      width: 240,
      height: 90,
    },
  ],
  edges: [
    { id: 'e1', source: 'g1', target: 's1' },
    { id: 'e2', source: 's1', target: 'd1' },
    { id: 'e3', source: 'd1', target: 's2', source_handle: 'hot' },
    { id: 'e4', source: 'd1', target: 's3', source_handle: 'default' },
  ],
};

describe('graph <-> React Flow mapping', () => {
  it('round-trips a graph unchanged', () => {
    const flow = graphToFlow(graph);
    expect(flowToGraph(flow.nodes, flow.edges)).toEqual(graph);
  });

  it('maps node types, positions, note sizes and decision handles', () => {
    const { nodes, edges } = graphToFlow(graph);
    expect(nodes.map((n) => [n.id, n.type])).toEqual([
      ['g1', 'goal'],
      ['s1', 'sequence'],
      ['d1', 'decision'],
      ['s2', 'sequence'],
      ['s3', 'sequence'],
      ['n1', 'note'],
    ]);
    const note = nodes.find((n) => n.id === 'n1');
    expect(note).toMatchObject({ width: 240, height: 90, connectable: false });
    expect(edges.find((e) => e.id === 'e1')?.sourceHandle).toBeNull();
    expect(edges.find((e) => e.id === 'e3')?.sourceHandle).toBe('hot');
    expect(edges.find((e) => e.id === 'e4')?.sourceHandle).toBe('default');
  });

  it('defaults a decision edge without handle to the default branch', () => {
    const { nodes, edges } = graphToFlow({
      ...graph,
      edges: [{ id: 'x', source: 'd1', target: 's2' }],
    });
    expect(edges[0]?.sourceHandle).toBe('default');
    expect(flowToGraph(nodes, edges).edges).toEqual([
      { id: 'x', source: 'd1', target: 's2', source_handle: 'default' },
    ]);
  });

  it('writes back moved positions (rounded) and resized notes', () => {
    const flow = graphToFlow(graph);
    const nodes = flow.nodes.map((n) =>
      n.id === 's1'
        ? { ...n, position: { x: 412.6, y: 33.2 } }
        : n.id === 'n1'
          ? { ...n, width: 300.4, height: 150 }
          : n,
    );
    const out = flowToGraph(nodes, flow.edges);
    expect(out.nodes.find((n) => n.id === 's1')?.position).toEqual({ x: 413, y: 33 });
    expect(out.nodes.find((n) => n.id === 'n1')).toMatchObject({ width: 300, height: 150 });
  });

  it('drops dangling, note, self-loop, removed-branch and duplicate edges', () => {
    const flow = graphToFlow(graph);
    const edges = [
      ...flow.edges,
      { id: 'dangling', source: 'gone', target: 's1', sourceHandle: null },
      { id: 'note', source: 'g1', target: 'n1', sourceHandle: null },
      { id: 'self', source: 's2', target: 's2', sourceHandle: null },
      { id: 'branch', source: 'd1', target: 's3', sourceHandle: 'removed' },
      { id: 'dup', source: 'g1', target: 's1', sourceHandle: null },
    ];
    expect(flowToGraph(flow.nodes, edges).edges.map((e) => e.id)).toEqual(['e1', 'e2', 'e3', 'e4']);
  });

  it('removes edges of a deleted decision branch', () => {
    const flow = graphToFlow(graph);
    const nodes = flow.nodes.map((n) =>
      n.id === 'd1' && n.data.node.type === 'decision'
        ? {
            ...n,
            data: {
              node: { ...n.data.node, branches: [{ ...n.data.node.branches[0]!, id: 'warm' }] },
            },
          }
        : n,
    );
    expect(flowToGraph(nodes, flow.edges).edges.map((e) => e.id)).toEqual(['e1', 'e2', 'e4']);
  });

  it('validates and creates connections', () => {
    const { nodes, edges } = graphToFlow(graph);
    expect(canConnect({ source: 'g1', target: 's1', sourceHandle: null }, nodes, edges)).toBe(
      false,
    );
    expect(canConnect({ source: 'g1', target: 'n1', sourceHandle: null }, nodes, edges)).toBe(
      false,
    );
    expect(canConnect({ source: 's2', target: 's2', sourceHandle: null }, nodes, edges)).toBe(
      false,
    );
    expect(canConnect({ source: 'd1', target: 's2', sourceHandle: 'default' }, nodes, edges)).toBe(
      true,
    );
    const edge = connectionToEdge({ source: 'd1', target: 's2', sourceHandle: null }, nodes, edges);
    expect(edge).toMatchObject({ source: 'd1', target: 's2', sourceHandle: 'default' });
    expect(edge.id).toMatch(/^e_[a-z0-9]{6}$/);
  });

  it('creates and duplicates nodes with fresh, schema-valid ids', () => {
    const taken = takenIds(graph.nodes);
    expect(taken.has('st1')).toBe(true);
    expect(taken.has('hot')).toBe(true);
    const decision = createNode({ kind: 'decision' }, { x: 10.4, y: 20.6 }, taken);
    expect(decision).toMatchObject({ type: 'decision', position: { x: 10, y: 21 } });
    const seq = graph.nodes[1]!;
    const copy = duplicateNode(seq, taken);
    expect(copy.id).not.toBe(seq.id);
    expect(copy.type === 'sequence' && copy.steps[0]?.id).not.toBe('st1');
    expect(copy.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});
