import type { AutomationGraph, GraphEdge, GraphNode } from '@amable/api-types';
import type { Connection, Edge, Node } from '@xyflow/react';
import { uniqueId } from './ids';

/**
 * Mapping between the automation graph JSON (schema v1) and React Flow.
 *
 * Every React Flow node carries the whole graph node in `data.node`; the
 * canvas owns the position (and the size of notes), so `flowToGraph` writes
 * them back. Decision edges use the branch id (or `default`) as source
 * handle; every other node has a single unnamed source handle.
 */

export const DEFAULT_HANDLE = 'default';

export type FlowNodeData = { node: GraphNode };
export type AutomationFlowNode = Node<FlowNodeData, GraphNode['type']>;
export type AutomationFlowEdge = Edge;

export interface FlowState {
  readonly nodes: AutomationFlowNode[];
  readonly edges: AutomationFlowEdge[];
}

function toFlowNode(node: GraphNode): AutomationFlowNode {
  const base: AutomationFlowNode = {
    id: node.id,
    type: node.type,
    position: { x: node.position.x, y: node.position.y },
    data: { node },
  };
  if (node.type === 'note') {
    return {
      ...base,
      ...(node.width === undefined ? {} : { width: node.width }),
      ...(node.height === undefined ? {} : { height: node.height }),
      // Notes sit behind the flow and never connect.
      zIndex: -1,
      connectable: false,
    };
  }
  return base;
}

function toFlowEdge(edge: GraphEdge, byId: ReadonlyMap<string, GraphNode>): AutomationFlowEdge {
  const source = byId.get(edge.source);
  const handle =
    source?.type === 'decision'
      ? (edge.source_handle ?? DEFAULT_HANDLE)
      : (edge.source_handle ?? null);
  return { id: edge.id, source: edge.source, target: edge.target, sourceHandle: handle };
}

export function graphToFlow(graph: AutomationGraph): FlowState {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return {
    nodes: graph.nodes.map(toFlowNode),
    edges: graph.edges.map((edge) => toFlowEdge(edge, byId)),
  };
}

function rounded(value: number): number {
  return Math.round(value);
}

/** Branch handles a decision exposes (branches in order, then `default`). */
export function decisionHandles(node: GraphNode): string[] {
  return node.type === 'decision' ? [...node.branches.map((b) => b.id), DEFAULT_HANDLE] : [];
}

/**
 * Graph JSON of the canvas. Edges whose ends no longer exist, edges touching
 * notes, self loops, edges from removed decision branches and duplicates are
 * dropped, so the result always matches what the canvas shows.
 */
export function flowToGraph(
  nodes: readonly AutomationFlowNode[],
  edges: readonly AutomationFlowEdge[],
): AutomationGraph {
  const graphNodes: GraphNode[] = nodes.map((flowNode) => {
    const node = flowNode.data.node;
    const position = { x: rounded(flowNode.position.x), y: rounded(flowNode.position.y) };
    if (node.type !== 'note') return { ...node, position };
    const width = flowNode.width ?? node.width;
    const height = flowNode.height ?? node.height;
    const { width: _w, height: _h, ...rest } = node;
    return {
      ...rest,
      position,
      ...(width === undefined ? {} : { width: rounded(width) }),
      ...(height === undefined ? {} : { height: rounded(height) }),
    };
  });
  const byId = new Map(graphNodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  const graphEdges: GraphEdge[] = [];
  for (const edge of edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source === undefined || target === undefined) continue;
    if (source.type === 'note' || target.type === 'note' || source.id === target.id) continue;
    let handle: string | undefined;
    if (source.type === 'decision') {
      handle = edge.sourceHandle ?? DEFAULT_HANDLE;
      if (!decisionHandles(source).includes(handle)) continue;
    }
    const key = `${source.id}|${handle ?? ''}|${target.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    graphEdges.push({
      id: edge.id,
      source: source.id,
      target: target.id,
      ...(handle === undefined ? {} : { source_handle: handle }),
    });
  }
  return { schema_version: 1, nodes: graphNodes, edges: graphEdges };
}

/** Whether the canvas may draw this connection (same rules `flowToGraph` keeps). */
export function canConnect(
  connection: Pick<Connection, 'source' | 'target' | 'sourceHandle'>,
  nodes: readonly AutomationFlowNode[],
  edges: readonly AutomationFlowEdge[],
): boolean {
  if (connection.source === connection.target) return false;
  const source = nodes.find((n) => n.id === connection.source);
  const target = nodes.find((n) => n.id === connection.target);
  if (source === undefined || target === undefined) return false;
  if (source.type === 'note' || target.type === 'note') return false;
  const handle = source.type === 'decision' ? (connection.sourceHandle ?? DEFAULT_HANDLE) : null;
  return !edges.some(
    (edge) =>
      edge.source === connection.source &&
      edge.target === connection.target &&
      (edge.sourceHandle ?? null) === handle,
  );
}

/** New canvas edge for a connection (ids unique among the existing edges). */
export function connectionToEdge(
  connection: Pick<Connection, 'source' | 'target' | 'sourceHandle'>,
  nodes: readonly AutomationFlowNode[],
  edges: readonly AutomationFlowEdge[],
): AutomationFlowEdge {
  const source = nodes.find((n) => n.id === connection.source);
  const handle = source?.type === 'decision' ? (connection.sourceHandle ?? DEFAULT_HANDLE) : null;
  return {
    id: uniqueId('e', new Set(edges.map((edge) => edge.id))),
    source: connection.source,
    target: connection.target,
    sourceHandle: handle,
  };
}

/** Every id used in the graph (nodes, steps, branches): new ids must avoid all of them. */
export function takenIds(nodes: readonly GraphNode[]): Set<string> {
  const ids = new Set<string>();
  for (const node of nodes) {
    ids.add(node.id);
    if (node.type === 'sequence') for (const step of node.steps) ids.add(step.id);
    if (node.type === 'decision') for (const branch of node.branches) ids.add(branch.id);
  }
  return ids;
}
