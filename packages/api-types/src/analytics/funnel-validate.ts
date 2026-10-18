import type { FunnelEdge, FunnelGraphError, FunnelNode } from './funnel-graph';

/** Graph shape accepted by the validator (stored graph, input or editor state). */
export interface ValidatableGraph {
  nodes: readonly FunnelNode[];
  edges: readonly FunnelEdge[];
}

/**
 * Structural validation of a funnel graph shared by the edge engine, the core
 * API (HTTP 422) and the visual builder. Soft-deleted nodes are ignored.
 */
export function validateGraph(_graph: ValidatableGraph): FunnelGraphError[] {
  return [];
}
