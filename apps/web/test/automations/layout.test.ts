import type { AutomationGraph } from '@amable/api-types';
import { describe, expect, it } from 'vitest';
import { COLUMN_WIDTH, tidyLayout } from '../../src/features/automations/lib/layout';

const filter = { type: 'group' as const, op: 'and' as const, conditions: [] };

const graph: AutomationGraph = {
  schema_version: 1,
  nodes: [
    { id: 'yes', type: 'sequence', position: { x: 0, y: 0 }, steps: [] },
    { id: 'no', type: 'sequence', position: { x: 0, y: 0 }, steps: [] },
    { id: 'g', type: 'goal', position: { x: 100, y: 50 }, triggers: [{ type: 'contact_created' }] },
    { id: 's', type: 'sequence', position: { x: 100, y: 50 }, steps: [] },
    { id: 'd', type: 'decision', position: { x: 100, y: 50 }, branches: [{ id: 'b1', filter }] },
    { id: 'n', type: 'note', position: { x: 7, y: 9 }, text: 'kept' },
  ],
  edges: [
    { id: 'e1', source: 'g', target: 's' },
    { id: 'e2', source: 's', target: 'd' },
    { id: 'e3', source: 'd', target: 'no', source_handle: 'default' },
    { id: 'e4', source: 'd', target: 'yes', source_handle: 'b1' },
    // A loop back must not push nodes to the right forever.
    { id: 'e5', source: 'yes', target: 's' },
  ],
};

describe('tidy layout', () => {
  it('puts nodes in columns by distance from the entry and branches in order', () => {
    const out = tidyLayout(graph);
    const at = (id: string) => out.nodes.find((n) => n.id === id)?.position;
    const x0 = at('g')?.x ?? 0;
    expect(at('s')?.x).toBe(x0 + COLUMN_WIDTH);
    expect(at('d')?.x).toBe(x0 + 2 * COLUMN_WIDTH);
    expect(at('yes')?.x).toBe(x0 + 3 * COLUMN_WIDTH);
    expect(at('no')?.x).toBe(x0 + 3 * COLUMN_WIDTH);
    // Branch 1 above the default branch.
    expect(at('yes')!.y).toBeLessThan(at('no')!.y);
    expect(at('n')).toEqual({ x: 7, y: 9 });
    expect(out.edges).toEqual(graph.edges);
  });
});
