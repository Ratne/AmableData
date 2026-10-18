import type { FunnelEdge, FunnelNode, FunnelNodeKind } from '@amable/api-types';
import type { Edge, Node } from '@xyflow/react';

/** Heatmap value of a node or edge: formatted text and 0..1 position in the scale. */
export type HeatCell = { readonly text: string; readonly intensity: number };

export type FunnelNodeData = {
  node: FunnelNode;
  issues: readonly string[];
  heat: HeatCell | null;
  dimmed: boolean;
};

export type FunnelEdgeData = {
  edge: FunnelEdge;
  label: string;
  issues: readonly string[];
  heat: HeatCell | null;
  dimmed: boolean;
  onSelect: (id: string) => void;
};

export type FunnelFlowNode = Node<FunnelNodeData, FunnelNodeKind>;
export type FunnelFlowEdge = Edge<FunnelEdgeData, 'funnel'>;
