import { cn } from '@amable/ui';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { CircleAlert } from 'lucide-react';
import { memo } from 'react';
import { useI18n } from '../../../../i18n';
import { heatColor } from '../heatmap';
import { DEFAULT_HANDLE } from '../state';
import { KIND_META } from './kind-meta';
import type { FunnelFlowNode } from './types';

const handleClass = '!size-2.5 !border-2 !border-background !bg-muted-foreground';

/** One React Flow node view for every funnel node kind. */
export const FunnelNodeView = memo(function FunnelNodeView({
  data,
  selected,
}: NodeProps<FunnelFlowNode>) {
  const { t } = useI18n();
  const { node, issues, heat, dimmed } = data;
  const meta = KIND_META[node.kind];
  const Icon = meta.icon;
  const kindLabel = t(`analytics.funnelBuilder.kind.${node.kind}`);

  const summary = (() => {
    switch (node.kind) {
      case 'traffic':
        return t('analytics.funnelBuilder.node.entry');
      case 'rotator':
        return t(`analytics.funnelBuilder.panel.stickiness.${node.config.stickiness}`);
      case 'page_group': {
        const pages = t('analytics.funnelBuilder.node.pages', { count: node.config.pages.length });
        const type = t(`analytics.funnelBuilder.panel.pageType.${node.config.page_type}`);
        const mapped = node.config.map_action_to_page
          ? ` · ${t('analytics.funnelBuilder.node.mapped')}`
          : '';
        return `${type} · ${pages}${mapped}`;
      }
      case 'condition':
        return t('analytics.funnelBuilder.node.routes', { count: node.config.routes.length });
      case 'external_url':
        return node.config.url || t('analytics.funnelBuilder.node.noUrl');
      case 'action_proxy':
        return t('analytics.funnelBuilder.node.passthrough');
      case 'tag':
        return t('analytics.funnelBuilder.node.tags', {
          add: node.config.add.length,
          remove: node.config.remove.length,
        });
      case 'webhook':
        return node.config.url
          ? `${node.config.method} ${node.config.url}`
          : t('analytics.funnelBuilder.node.noUrl');
    }
  })();

  const routes =
    node.kind === 'condition'
      ? [
          ...[...node.config.routes]
            .sort((a, b) => a.priority - b.priority)
            .map((r) => ({ id: r.id, label: r.label })),
          { id: DEFAULT_HANDLE, label: t('analytics.funnelBuilder.edge.default') },
        ]
      : null;

  return (
    <>
      {node.kind !== 'traffic' ? (
        <Handle type="target" position={Position.Left} className={handleClass} />
      ) : null}
      <div
        className={cn(
          'w-56 rounded-xl border bg-card text-card-foreground shadow-sm transition-opacity',
          selected && 'ring-2 ring-primary ring-offset-1 ring-offset-background',
          issues.length > 0 && 'border-destructive',
          dimmed && 'opacity-30',
        )}
        style={heat ? { boxShadow: `0 0 0 3px ${heatColor(heat.intensity, 0.55)}` } : undefined}
        data-testid={`funnel-node-${node.id}`}
      >
        <div className={cn('flex items-center gap-2 rounded-t-xl px-3 py-2', meta.tone)}>
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-background/70">
            <Icon className="size-3.5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-medium tracking-wide uppercase opacity-70">
              {kindLabel}
            </p>
            <p className="truncate text-sm font-semibold">{node.label || kindLabel}</p>
          </div>
          {issues.length > 0 ? (
            <span
              className="flex items-center gap-0.5 rounded-full bg-destructive px-1.5 text-[10px] font-semibold text-white"
              title={issues.join('\n')}
            >
              <CircleAlert className="size-3" aria-hidden />
              {issues.length}
            </span>
          ) : null}
        </div>
        <p className="truncate px-3 py-1.5 text-xs text-muted-foreground">{summary}</p>
        {routes ? (
          <ul className="grid border-t py-1">
            {routes.map((route) => (
              <li key={route.id} className="relative py-0.5 pr-4 pl-3 text-xs">
                <span
                  className={cn(
                    'block truncate',
                    route.id === DEFAULT_HANDLE ? 'text-muted-foreground' : 'font-medium',
                  )}
                >
                  {route.label}
                </span>
                <Handle
                  id={route.id}
                  type="source"
                  position={Position.Right}
                  className={cn(
                    handleClass,
                    route.id === DEFAULT_HANDLE ? '!bg-muted-foreground/60' : '!bg-amber-500',
                  )}
                  style={{ top: '50%' }}
                />
              </li>
            ))}
          </ul>
        ) : null}
        {heat ? (
          <div className="flex items-center gap-2 border-t px-3 py-1.5">
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-foreground/[0.06]">
              <span
                className="block h-full rounded-full"
                style={{
                  width: `${String(Math.max(4, heat.intensity * 100))}%`,
                  background: heatColor(heat.intensity, 1),
                }}
              />
            </span>
            <span className="font-mono text-xs font-semibold tabular-nums">{heat.text}</span>
          </div>
        ) : null}
      </div>
      {node.kind !== 'external_url' && node.kind !== 'condition' ? (
        <Handle type="source" position={Position.Right} className={handleClass} />
      ) : null}
    </>
  );
});
