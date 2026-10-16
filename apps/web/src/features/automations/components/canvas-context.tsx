import type { GraphNode, NodeStats } from '@amable/api-types';
import { createContext, useContext } from 'react';
import type { NodeIssues } from '../lib/issues';

/** What the custom canvas nodes need from the editor page. */
export interface CanvasContextValue {
  readonly readOnly: boolean;
  /** Reporting overlay: counters keyed by `node` and `node:step`; null when hidden. */
  readonly stats: ReadonlyMap<string, NodeStats> | null;
  readonly issues: ReadonlyMap<string, NodeIssues>;
  readonly updateNode: (node: GraphNode) => void;
  readonly openCounters: (nodeId: string) => void;
}

export const CanvasContext = createContext<CanvasContextValue | null>(null);

export function useCanvas(): CanvasContextValue {
  const value = useContext(CanvasContext);
  if (value === null) throw new Error('CanvasContext missing');
  return value;
}

export function statsKey(nodeId: string, stepId: string | null = null): string {
  return stepId === null ? nodeId : `${nodeId}:${stepId}`;
}
