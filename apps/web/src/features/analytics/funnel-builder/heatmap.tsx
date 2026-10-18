import { HEATMAP_METRICS, type FunnelHeatmap, type HeatmapMetric } from '@amable/api-types';
import { Flame } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { Segmented } from '../components/ui';
import type { HeatCell } from './nodes/types';

/** Red (low) → amber → green (high). */
export function heatColor(intensity: number, alpha: number): string {
  const hue = Math.round(Math.max(0, Math.min(1, intensity)) * 140);
  return `hsl(${String(hue)} 72% 45% / ${String(alpha)})`;
}

function formatter(locale: string, metric: HeatmapMetric) {
  const number = new Intl.NumberFormat(locale, {
    maximumFractionDigits: metric === 'visits' ? 0 : 1,
  });
  return (value: number) =>
    metric === 'visits' ? number.format(value) : `${number.format(value)}%`;
}

function normalize(values: readonly number[]) {
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  return (v: number) => (max === min ? 0.5 : (v - min) / (max - min));
}

/** Heat cells of nodes (metric value) and edges (share of the entrances). */
export function heatCells(
  heatmap: FunnelHeatmap,
  locale: string,
): { nodes: Map<string, HeatCell>; edges: Map<string, HeatCell> } {
  const format = formatter(locale, heatmap.metric);
  const scaleNode = normalize(heatmap.nodes.map((n) => n.value));
  const scaleEdge = normalize(heatmap.edges.map((e) => e.flow_pct));
  const pct = formatter(locale, 'flow_pct');
  return {
    nodes: new Map(
      heatmap.nodes.map((n) => [
        n.node_id,
        { text: format(n.value), intensity: scaleNode(n.value) },
      ]),
    ),
    edges: new Map(
      heatmap.edges.map((e) => [
        e.edge_id,
        { text: pct(e.flow_pct), intensity: scaleEdge(e.flow_pct) },
      ]),
    ),
  };
}

/** Heatmap mode picker (off + the four metrics) with the colour legend. */
export function HeatmapControls({
  metric,
  onChange,
}: {
  metric: HeatmapMetric | null;
  onChange: (metric: HeatmapMetric | null) => void;
}) {
  const { t } = useI18n();
  const options = [
    { value: 'off' as const, label: t('analytics.funnelBuilder.heatmap.off') },
    ...HEATMAP_METRICS.map((m) => ({ value: m, label: t(`analytics.funnelBuilder.heatmap.${m}`) })),
  ];
  return (
    <div className="flex items-center gap-2">
      <Flame className="size-3.5 text-muted-foreground" aria-hidden />
      <Segmented
        label={t('analytics.funnelBuilder.heatmap.label')}
        options={options}
        value={metric ?? 'off'}
        onChange={(value) => onChange(value === 'off' ? null : value)}
      />
      {metric ? (
        <span className="hidden items-center gap-1 text-[10px] text-muted-foreground lg:flex">
          {t('analytics.funnelBuilder.heatmap.low')}
          <span
            className="h-1.5 w-16 rounded-full"
            style={{
              background: `linear-gradient(90deg, ${heatColor(0, 1)}, ${heatColor(0.5, 1)}, ${heatColor(1, 1)})`,
            }}
          />
          {t('analytics.funnelBuilder.heatmap.high')}
        </span>
      ) : null}
    </div>
  );
}
