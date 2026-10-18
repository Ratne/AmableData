import { cn } from '@amable/ui';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import { memo } from 'react';
import { heatColor } from '../heatmap';
import type { FunnelFlowEdge } from './types';

/** Bezier connection with its label (weight %, route, action numbers or default). */
export const FunnelEdgeView = memo(function FunnelEdgeView({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  selected,
  data,
}: EdgeProps<FunnelFlowEdge>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const issues = data?.issues ?? [];
  const heat = data?.heat ?? null;
  const stroke =
    issues.length > 0
      ? 'var(--destructive)'
      : heat
        ? heatColor(heat.intensity, 0.9)
        : selected
          ? 'var(--primary)'
          : undefined;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        {...(markerEnd !== undefined ? { markerEnd } : {})}
        style={{
          ...(stroke ? { stroke } : {}),
          strokeWidth: heat ? 1.5 + heat.intensity * 6 : selected ? 2 : 1.5,
          opacity: data?.dimmed ? 0.2 : 1,
        }}
      />
      {data ? (
        <EdgeLabelRenderer>
          <button
            type="button"
            className={cn(
              'nodrag nopan absolute rounded-md border bg-background px-1.5 py-0.5 text-[10px] font-medium shadow-sm',
              selected && 'border-primary text-primary',
              issues.length > 0 && 'border-destructive text-destructive',
              data.dimmed && 'opacity-30',
            )}
            style={{
              transform: `translate(-50%, -50%) translate(${String(labelX)}px, ${String(labelY)}px)`,
              pointerEvents: 'all',
            }}
            title={issues.join('\n') || undefined}
            onClick={(event) => {
              event.stopPropagation();
              data.onSelect(id);
            }}
            data-testid={`funnel-edge-${id}`}
          >
            {data.label}
            {heat ? (
              <span className="ml-1 font-mono text-muted-foreground">{heat.text}</span>
            ) : null}
          </button>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
});
