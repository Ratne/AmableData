import type { PerformanceReport } from '@amable/api-types';
import { ChartContainer, type ChartConfig } from '@amable/ui/ui/chart';
import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts';
import { useI18n } from '../../../i18n';
import { useFormatters } from '../lib/format';
import { columnLabel, rowLabel } from './labels';
import { formatMetric, rowsByKey, type PerformanceColumn } from './model';

const MAX_BARS = 15;

/** Bars of one metric per row, with the previous period beside it when comparing. */
export function PerformanceChart({
  report,
  previous,
  metric,
}: {
  report: PerformanceReport;
  previous: PerformanceReport | undefined;
  metric: PerformanceColumn;
}) {
  const { t } = useI18n();
  const f = useFormatters();
  const prev = previous ? rowsByKey(previous.rows) : null;
  const data = report.rows.slice(0, MAX_BARS).map((row) => ({
    name: rowLabel(t, report.group_by, row),
    current: row[metric] ?? 0,
    previous: prev ? (prev.get(row.key)?.[metric] ?? 0) : undefined,
  }));
  const config = {
    current: { label: t('analytics.performance.current'), color: 'var(--chart-1)' },
    previous: { label: t('analytics.performance.previous'), color: 'var(--chart-3)' },
  } satisfies ChartConfig;
  const format = (value: number) => formatMetric(f, metric, value, report.currency);
  return (
    <ChartContainer config={config} className="aspect-auto h-[340px] w-full">
      <BarChart data={data} margin={{ top: 12, right: 8, left: 8, bottom: 0 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="name"
          tickLine={false}
          axisLine={false}
          interval={0}
          tickMargin={8}
          tickFormatter={(value: string) => (value.length > 14 ? `${value.slice(0, 13)}…` : value)}
        />
        <YAxis tickLine={false} axisLine={false} width={64} tickFormatter={format} />
        <Tooltip
          cursor={{ fill: 'var(--muted)', opacity: 0.4 }}
          formatter={(value, name) => [
            format(Number(value)),
            name === 'previous' ? config.previous.label : columnLabel(t, metric),
          ]}
        />
        <Bar dataKey="current" fill="var(--color-current)" radius={[3, 3, 0, 0]} maxBarSize={36} />
        {prev ? (
          <Bar
            dataKey="previous"
            fill="var(--color-previous)"
            fillOpacity={0.6}
            radius={[3, 3, 0, 0]}
            maxBarSize={36}
          />
        ) : null}
      </BarChart>
    </ChartContainer>
  );
}
