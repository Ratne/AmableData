import '@xyflow/react/dist/style.css';
import type { FunnelEdge, FunnelGraph, FunnelNodeKind } from '@amable/api-types';
import { useTheme } from '@amable/ui';
import {
  applyNodeChanges,
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type Connection,
  type EdgeTypes,
  type NodeChange,
  type NodeTypes,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react';
import { useI18n } from '../../../i18n';
import { FunnelEdgeView } from './nodes/funnel-edge';
import { FunnelNodeView } from './nodes/funnel-node';
import type { FunnelFlowEdge, FunnelFlowNode, HeatCell } from './nodes/types';
import { PALETTE_MIME, type PaletteItem } from './palette';
import {
  DEFAULT_HANDLE,
  defaultVia,
  liveEdges,
  liveNodes,
  weightShare,
  type BuilderAction,
  type Position,
} from './state';

export type BuilderSelection = { kind: 'node'; id: string } | { kind: 'edge'; id: string } | null;

const nodeTypes: NodeTypes = Object.fromEntries(
  (
    [
      'traffic',
      'rotator',
      'page_group',
      'condition',
      'external_url',
      'action_proxy',
      'tag',
      'webhook',
    ] satisfies FunnelNodeKind[]
  ).map((kind) => [kind, FunnelNodeView]),
);
const edgeTypes: EdgeTypes = { funnel: FunnelEdgeView };

/** Condition nodes have one source handle per route plus the default one. */
function sourceHandleOf(graph: Pick<FunnelGraph, 'nodes'>, edge: FunnelEdge): string | null {
  const from = graph.nodes.find((n) => n.id === edge.from);
  if (from?.kind !== 'condition') return null;
  return edge.via.type === 'route' ? edge.via.route_id : DEFAULT_HANDLE;
}

export function useEdgeLabel() {
  const { t, locale } = useI18n();
  return useCallback(
    (graph: Pick<FunnelGraph, 'nodes' | 'edges'>, edge: FunnelEdge): string => {
      switch (edge.via.type) {
        case 'weight': {
          const pct = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(
            weightShare(graph, edge) * 100,
          );
          return `${pct}% · ${String(edge.via.weight)}`;
        }
        case 'route': {
          const routeId = edge.via.route_id;
          const from = graph.nodes.find((n) => n.id === edge.from);
          const route =
            from?.kind === 'condition'
              ? from.config.routes.find((r) => r.id === routeId)
              : undefined;
          return route?.label ?? t('analytics.funnelBuilder.edge.route');
        }
        case 'action':
          return t('analytics.funnelBuilder.edge.action', { list: edge.via.actions.join(', ') });
        case 'default':
          return t('analytics.funnelBuilder.edge.default');
      }
    },
    [locale, t],
  );
}

/**
 * React Flow canvas of the draft graph. Node positions live in React Flow
 * while dragging and are committed to the builder state on drop; everything
 * else is derived from the draft on every change.
 */
export function FunnelCanvas({
  graph,
  dispatch,
  selection,
  onSelect,
  onAdd,
  nodeIssues,
  edgeIssues,
  heat,
  trace,
}: {
  graph: FunnelGraph;
  dispatch: (action: BuilderAction) => void;
  selection: BuilderSelection;
  onSelect: (selection: BuilderSelection) => void;
  onAdd: (item: PaletteItem, at: Position) => void;
  nodeIssues: ReadonlyMap<string, readonly string[]>;
  edgeIssues: ReadonlyMap<string, readonly string[]>;
  heat: { nodes: ReadonlyMap<string, HeatCell>; edges: ReadonlyMap<string, HeatCell> } | null;
  trace: { nodes: ReadonlySet<string>; edges: ReadonlySet<string> } | null;
}) {
  const { resolvedTheme } = useTheme();
  const flow = useReactFlow<FunnelFlowNode, FunnelFlowEdge>();
  const edgeLabel = useEdgeLabel();

  const derivedNodes = useMemo<FunnelFlowNode[]>(
    () =>
      liveNodes(graph).map((node) => ({
        id: node.id,
        type: node.kind,
        position: { ...node.position },
        selected: selection?.kind === 'node' && selection.id === node.id,
        data: {
          node,
          issues: nodeIssues.get(node.id) ?? [],
          heat: heat?.nodes.get(node.id) ?? null,
          dimmed: trace !== null && !trace.nodes.has(node.id),
        },
      })),
    [graph, selection, nodeIssues, heat, trace],
  );

  const [nodes, setNodes] = useState<FunnelFlowNode[]>(derivedNodes);
  useEffect(() => {
    setNodes((previous) => {
      const byId = new Map(previous.map((n) => [n.id, n]));
      return derivedNodes.map((n) => {
        const old = byId.get(n.id);
        if (!old) return n;
        return {
          ...n,
          ...(old.measured ? { measured: old.measured } : {}),
          ...(old.dragging ? { dragging: true, position: old.position } : {}),
        };
      });
    });
  }, [derivedNodes]);

  const selectEdge = useCallback((id: string) => onSelect({ kind: 'edge', id }), [onSelect]);
  const edges = useMemo<FunnelFlowEdge[]>(
    () =>
      liveEdges(graph).map((edge) => ({
        id: edge.id,
        type: 'funnel',
        source: edge.from,
        target: edge.to,
        sourceHandle: sourceHandleOf(graph, edge),
        selected: selection?.kind === 'edge' && selection.id === edge.id,
        markerEnd: { type: MarkerType.ArrowClosed },
        data: {
          edge,
          label: edgeLabel(graph, edge),
          issues: edgeIssues.get(edge.id) ?? [],
          heat: heat?.edges.get(edge.id) ?? null,
          dimmed: trace !== null && !trace.edges.has(edge.id),
          onSelect: selectEdge,
        },
      })),
    [graph, selection, edgeIssues, heat, trace, edgeLabel, selectEdge],
  );

  const onNodesChange = useCallback((changes: NodeChange<FunnelFlowNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
  }, []);

  const canConnect = useCallback(
    (c: Connection | FunnelFlowEdge) => {
      if (c.source === c.target) return false;
      const from = liveNodes(graph).find((n) => n.id === c.source);
      return from !== undefined && defaultVia(graph, from, c.sourceHandle) !== null;
    },
    [graph],
  );

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      const raw = event.dataTransfer.getData(PALETTE_MIME);
      if (raw === '') return;
      event.preventDefault();
      const item = JSON.parse(raw) as PaletteItem;
      onAdd(item, flow.screenToFlowPosition({ x: event.clientX - 110, y: event.clientY - 24 }));
    },
    [flow, onAdd],
  );

  return (
    <div
      className="relative min-w-0 flex-1"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes(PALETTE_MIME)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
        }
      }}
      onDrop={onDrop}
      data-testid="funnel-canvas"
    >
      <ReactFlow<FunnelFlowNode, FunnelFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={(_, _node, dragged) => {
          for (const n of dragged)
            dispatch({
              type: 'move_node',
              id: n.id,
              position: { x: n.position.x, y: n.position.y },
            });
        }}
        onNodeClick={(_, node) => onSelect({ kind: 'node', id: node.id })}
        onEdgeClick={(_, edge) => onSelect({ kind: 'edge', id: edge.id })}
        onPaneClick={() => onSelect(null)}
        onNodesDelete={(deleted) => {
          const at = Date.now();
          for (const n of deleted) dispatch({ type: 'delete_node', id: n.id, at });
          onSelect(null);
        }}
        onEdgesDelete={(deleted) => {
          for (const e of deleted) dispatch({ type: 'remove_edge', id: e.id });
          onSelect(null);
        }}
        onConnect={(c) =>
          dispatch({ type: 'connect', from: c.source, to: c.target, handle: c.sourceHandle })
        }
        isValidConnection={canConnect}
        deleteKeyCode={['Backspace', 'Delete']}
        snapToGrid
        snapGrid={[16, 16]}
        colorMode={resolvedTheme}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1.1 }}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable className="!bg-background" />
      </ReactFlow>
    </div>
  );
}
