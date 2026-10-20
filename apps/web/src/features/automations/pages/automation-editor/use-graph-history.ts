import type { AutomationGraph } from '@amable/api-types';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import {
  graphToFlow,
  type AutomationFlowEdge,
  type AutomationFlowNode,
} from '../../lib/flow-mapping';

const HISTORY_LIMIT = 50;

/**
 * Undo / redo over graph snapshots. A change becomes a history entry once the
 * graph has been stable for 350 ms (never mid-drag).
 */
export function useGraphHistory({
  graphJson,
  dragging,
  setNodes,
  setEdges,
}: {
  graphJson: string;
  dragging: RefObject<boolean>;
  setNodes: (nodes: AutomationFlowNode[]) => void;
  setEdges: (edges: AutomationFlowEdge[]) => void;
}) {
  const past = useRef<string[]>([]);
  const future = useRef<string[]>([]);
  const stable = useRef(graphJson);
  const restoring = useRef(false);
  const [, bumpHistory] = useState(0);
  useEffect(() => {
    if (restoring.current) {
      restoring.current = false;
      stable.current = graphJson;
      return;
    }
    if (dragging.current || graphJson === stable.current) return;
    const timer = setTimeout(() => {
      past.current = [...past.current, stable.current].slice(-HISTORY_LIMIT);
      future.current = [];
      stable.current = graphJson;
      bumpHistory((n) => n + 1);
    }, 350);
    return () => clearTimeout(timer);
  }, [graphJson]);

  const applyGraph = useCallback(
    (next: AutomationGraph, asHistory = true) => {
      const mapped = graphToFlow(next);
      if (asHistory) restoring.current = true;
      setNodes(mapped.nodes);
      setEdges(mapped.edges);
    },
    [setNodes, setEdges],
  );
  const undo = useCallback(() => {
    const previous = past.current.pop();
    if (previous === undefined) return;
    future.current.push(stable.current);
    stable.current = previous;
    applyGraph(JSON.parse(previous) as AutomationGraph);
    bumpHistory((n) => n + 1);
  }, [applyGraph]);
  const redo = useCallback(() => {
    const next = future.current.pop();
    if (next === undefined) return;
    past.current.push(stable.current);
    stable.current = next;
    applyGraph(JSON.parse(next) as AutomationGraph);
    bumpHistory((n) => n + 1);
  }, [applyGraph]);

  return {
    applyGraph,
    undo,
    redo,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
  };
}
