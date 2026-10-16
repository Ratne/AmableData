import type { ChartType, MeasureKind, ReportResult, ReportRow } from '@amable/api-types/reports';
import { cn } from '@amable/ui';
import { ChartContainer, type ChartConfig } from '@amable/ui/ui/chart';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@amable/ui/ui/table';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useI18n } from '../../../i18n';
import { currencyExponent } from '../../commerce/lib/money';
import {
  chartValue,
  createValueFormatter,
  measureKind,
  relativeChange,
  type ValueFormatter,
} from '../lib/format';
import { dimensionLabel, dynamicLabel, measureLabel } from '../lib/labels';

const COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
];
const PREV_SUFFIX = '__prev';

export interface ReportVisualProps {
  readonly result: ReportResult;
  readonly chart: ChartType;
  /** Measures shown (default: all of the result); KPI and funnel use the first / all. */
  readonly measures?: readonly string[];
  /** Fill the parent height (widgets) instead of the fixed page height. */
  readonly fill?: boolean;
  readonly maxRows?: number;
}

export function useValueFormatter(currency: string | null): ValueFormatter {
  const { locale } = useI18n();
  return useMemo(() => createValueFormatter(locale, currency), [locale, currency]);
}

function shownMeasures(result: ReportResult, measures: readonly string[] | undefined): string[] {
  const available = result.measures.map((m) => m.key);
  const picked = (measures ?? []).filter((m) => available.includes(m));
  return picked.length > 0 ? picked : available;
}

function ChangeBadge({ value, kind }: { value: number | null; kind: MeasureKind }) {
  const { locale } = useI18n();
  if (value === null) return null;
  const up = value >= 0;
  const text = new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: 1,
    signDisplay: 'exceptZero',
  }).format(value);
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 rounded px-1 text-xs font-medium tabular-nums',
        up ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400',
      )}
      data-kind={kind}
    >
      {up ? (
        <ArrowUpRight className="size-3" aria-hidden />
      ) : (
        <ArrowDownRight className="size-3" aria-hidden />
      )}
      {text}
    </span>
  );
}

export function EmptyReason({ result }: { result: ReportResult }) {
  const { t } = useI18n();
  const reason = result.meta.empty_reason;
  const text =
    reason !== null ? dynamicLabel(t, `rep.emptyReason.${reason}`, reason) : t('rep.result.noRows');
  return (
    <div className="flex h-full min-h-24 items-center justify-center p-4 text-center text-sm text-muted-foreground">
      {text}
    </div>
  );
}

function isEmpty(result: ReportResult): boolean {
  if (result.meta.empty_reason !== null && result.meta.empty_reason !== 'no_data') return true;
  return result.dimension !== null && result.rows.length === 0;
}

function KpiVisual({ result, measures }: { result: ReportResult; measures: string[] }) {
  const { t } = useI18n();
  const format = useValueFormatter(result.currency);
  return (
    <div
      className={cn(
        'grid h-full content-center gap-4',
        measures.length > 1 ? 'grid-cols-[repeat(auto-fit,minmax(9rem,1fr))]' : 'grid-cols-1',
      )}
    >
      {measures.map((key) => {
        const kind = measureKind(result, key);
        const current = result.totals[key];
        const previous = result.compare?.totals[key];
        return (
          <div key={key} className="min-w-0" data-testid={`kpi-${key}`}>
            {measures.length > 1 ? (
              <div className="truncate text-xs text-muted-foreground">{measureLabel(t, key)}</div>
            ) : null}
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-2xl font-semibold tabular-nums">{format(kind, current)}</span>
              {result.compare !== null ? (
                <ChangeBadge value={relativeChange(current, previous)} kind={kind} />
              ) : null}
            </div>
            {result.compare !== null ? (
              <div className="text-xs text-muted-foreground tabular-nums">
                {t('rep.result.previous')}: {format(kind, previous)}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

interface SeriesPoint {
  readonly label: string;
  readonly [key: string]: number | string | null;
}

function seriesData(result: ReportResult, measures: string[]): SeriesPoint[] {
  return result.rows.map((row, index) => {
    const point: Record<string, number | string | null> = { label: row.label || row.key };
    const previous: ReportRow | undefined =
      result.dimension === 'date'
        ? result.compare?.rows[index]
        : result.compare?.rows.find((r) => r.key === row.key);
    for (const key of measures) {
      const kind = measureKind(result, key);
      point[key] = chartValue(kind, row.values[key], result.currency);
      if (result.compare !== null)
        point[`${key}${PREV_SUFFIX}`] = chartValue(kind, previous?.values[key], result.currency);
    }
    return point as SeriesPoint;
  });
}

function CartesianVisual({
  result,
  measures,
  chart,
  fill,
}: {
  result: ReportResult;
  measures: string[];
  chart: 'line' | 'bar';
  fill: boolean;
}) {
  const { t } = useI18n();
  const format = useValueFormatter(result.currency);
  const data = useMemo(() => seriesData(result, measures), [result, measures]);
  const primaryKind = measureKind(result, measures[0] ?? '');
  const axisOf = (key: string) => (measureKind(result, key) === primaryKind ? 'left' : 'right');
  const hasRight = measures.some((m) => axisOf(m) === 'right');
  const secondaryKind = measureKind(result, measures.find((m) => axisOf(m) === 'right') ?? '');
  const config: ChartConfig = Object.fromEntries(
    measures.flatMap((key, i) => [
      [key, { label: measureLabel(t, key), color: COLORS[i % COLORS.length] }],
      [`${key}${PREV_SUFFIX}`, { label: `${measureLabel(t, key)} (${t('rep.result.previous')})` }],
    ]),
  );
  const tick = (kind: MeasureKind) => (value: number) => {
    const raw =
      kind === 'money'
        ? Math.round(value * 10 ** currencyExponent(result.currency ?? 'EUR'))
        : value;
    return format(kind, raw, { compact: true });
  };
  const series = measures.flatMap((key, i) => {
    const color = COLORS[i % COLORS.length] ?? 'var(--chart-1)';
    const name = measureLabel(t, key);
    const axis = axisOf(key);
    const prevName = `${name} (${t('rep.result.previous')})`;
    if (chart === 'line') {
      return [
        <Line
          isAnimationActive={false}
          key={key}
          yAxisId={axis}
          dataKey={key}
          name={name}
          stroke={color}
          strokeWidth={2}
          dot={data.length < 32}
          type="monotone"
        />,
        ...(result.compare !== null
          ? [
              <Line
                isAnimationActive={false}
                key={`${key}p`}
                yAxisId={axis}
                dataKey={`${key}${PREV_SUFFIX}`}
                name={prevName}
                stroke={color}
                strokeOpacity={0.45}
                strokeDasharray="4 4"
                dot={false}
                type="monotone"
              />,
            ]
          : []),
      ];
    }
    return [
      ...(result.compare !== null
        ? [
            <Bar
              isAnimationActive={false}
              key={`${key}p`}
              yAxisId={axis}
              dataKey={`${key}${PREV_SUFFIX}`}
              name={prevName}
              fill={color}
              fillOpacity={0.35}
              radius={[3, 3, 0, 0]}
              maxBarSize={28}
            />,
          ]
        : []),
      <Bar
        isAnimationActive={false}
        key={key}
        yAxisId={axis}
        dataKey={key}
        name={name}
        fill={color}
        radius={[3, 3, 0, 0]}
        maxBarSize={28}
      />,
    ];
  });
  const Chart = chart === 'line' ? LineChart : BarChart;
  return (
    <ChartContainer
      config={config}
      className={cn('aspect-auto w-full', fill ? 'h-full min-h-32' : 'h-[320px]')}
    >
      <Chart data={data} margin={{ left: 4, right: hasRight ? 4 : 12, top: 8, bottom: 0 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={16} />
        <YAxis
          yAxisId="left"
          tickLine={false}
          axisLine={false}
          width={64}
          tickFormatter={tick(primaryKind)}
        />
        {hasRight ? (
          <YAxis
            yAxisId="right"
            orientation="right"
            tickLine={false}
            axisLine={false}
            width={56}
            tickFormatter={tick(secondaryKind)}
          />
        ) : null}
        <Tooltip
          cursor={{ fill: 'var(--muted)', opacity: 0.4 }}
          content={({ active, payload, label }) => {
            if (!active || payload.length === 0) return null;
            return (
              <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-lg">
                <div className="mb-1 font-medium">{String(label ?? '')}</div>
                {payload.map((entry) => {
                  const dataKey = String(entry.dataKey ?? '');
                  const key = dataKey.endsWith(PREV_SUFFIX)
                    ? dataKey.slice(0, -PREV_SUFFIX.length)
                    : dataKey;
                  const kind = measureKind(result, key);
                  const point = entry.payload as SeriesPoint | undefined;
                  const index = point === undefined ? -1 : data.indexOf(point);
                  const source = dataKey.endsWith(PREV_SUFFIX)
                    ? result.dimension === 'date'
                      ? result.compare?.rows[index]
                      : result.compare?.rows.find((r) => r.key === result.rows[index]?.key)
                    : result.rows[index];
                  return (
                    <div key={dataKey} className="flex items-center justify-between gap-4">
                      <span className="flex items-center gap-1.5 text-muted-foreground">
                        <span className="size-2 rounded-full" style={{ background: entry.color }} />
                        {String(entry.name ?? key)}
                      </span>
                      <span className="font-medium tabular-nums">
                        {format(kind, source?.values[key])}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          }}
        />
        {measures.length > 1 || result.compare !== null ? (
          <Legend iconSize={8} wrapperStyle={{ fontSize: 11 }} />
        ) : null}
        {series}
      </Chart>
    </ChartContainer>
  );
}

export function ReportTable({
  result,
  measures,
  maxRows,
}: {
  result: ReportResult;
  measures: readonly string[];
  maxRows?: number;
}) {
  const { t } = useI18n();
  const format = useValueFormatter(result.currency);
  const rows = maxRows === undefined ? result.rows : result.rows.slice(0, maxRows);
  const compare = result.compare;
  const previousOf = (row: ReportRow, index: number) =>
    result.dimension === 'date'
      ? compare?.rows[index]
      : compare?.rows.find((r) => r.key === row.key);
  return (
    <Table data-testid="report-table">
      <TableHeader>
        <TableRow>
          {result.dimension !== null ? (
            <TableHead>{dimensionLabel(t, result.dimension)}</TableHead>
          ) : null}
          {measures.map((key) => (
            <TableHead key={key} className="text-right">
              {measureLabel(t, key)}
            </TableHead>
          ))}
          {compare !== null
            ? measures.map((key) => (
                <TableHead key={`${key}c`} className="text-right text-muted-foreground">
                  {t('rep.result.change')} · {measureLabel(t, key)}
                </TableHead>
              ))
            : null}
        </TableRow>
      </TableHeader>
      {result.dimension !== null ? (
        <TableBody>
          {rows.map((row, index) => (
            <TableRow key={`${row.key}-${String(index)}`}>
              <TableCell className="max-w-[18rem] truncate font-medium" title={row.label}>
                {row.label || row.key || '—'}
              </TableCell>
              {measures.map((key) => (
                <TableCell key={key} className="text-right tabular-nums">
                  {format(measureKind(result, key), row.values[key])}
                </TableCell>
              ))}
              {compare !== null
                ? measures.map((key) => {
                    const change = relativeChange(
                      row.values[key],
                      previousOf(row, index)?.values[key],
                    );
                    return (
                      <TableCell key={`${key}c`} className="text-right">
                        <ChangeBadge value={change} kind={measureKind(result, key)} />
                      </TableCell>
                    );
                  })
                : null}
            </TableRow>
          ))}
        </TableBody>
      ) : null}
      <TableFooter>
        <TableRow>
          {result.dimension !== null ? (
            <TableCell className="font-medium">{t('rep.result.total')}</TableCell>
          ) : null}
          {measures.map((key) => (
            <TableCell key={key} className="text-right font-semibold tabular-nums">
              {format(measureKind(result, key), result.totals[key])}
            </TableCell>
          ))}
          {compare !== null
            ? measures.map((key) => (
                <TableCell key={`${key}c`} className="text-right">
                  <ChangeBadge
                    value={relativeChange(result.totals[key], compare.totals[key])}
                    kind={measureKind(result, key)}
                  />
                </TableCell>
              ))
            : null}
        </TableRow>
      </TableFooter>
    </Table>
  );
}

function FunnelVisual({ result, measures }: { result: ReportResult; measures: string[] }) {
  const { t } = useI18n();
  const format = useValueFormatter(result.currency);
  const first = measures[0] ?? '';
  const stages =
    result.dimension !== null && result.dimension !== 'date' && result.rows.length > 0
      ? result.rows.map((row) => ({
          key: row.key,
          label: row.label || row.key,
          kind: measureKind(result, first),
          value: row.values[first] ?? 0,
        }))
      : measures.map((key) => ({
          key,
          label: measureLabel(t, key),
          kind: measureKind(result, key),
          value: result.totals[key] ?? 0,
        }));
  const max = Math.max(1, ...stages.map((s) => Math.abs(s.value)));
  const top = stages[0]?.value ?? 0;
  return (
    <ol className="grid h-full content-start gap-1.5 overflow-auto" data-testid="report-funnel">
      {stages.map((stage, index) => (
        <li key={stage.key} className="grid gap-0.5">
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="truncate">{stage.label}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {format(stage.kind, stage.value)}
              {index > 0 && top !== 0 && Math.abs(stage.value) <= Math.abs(top)
                ? ` · ${new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 0 }).format(stage.value / top)}`
                : ''}
            </span>
          </div>
          <div className="h-5 rounded bg-muted">
            <div
              className="h-full rounded"
              style={{
                width: `${String(Math.max(2, (Math.abs(stage.value) / max) * 100))}%`,
                background: COLORS[index % COLORS.length],
              }}
            />
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Renders a report result as KPI, line, bar, table or funnel. */
export function ReportVisual({
  result,
  chart,
  measures,
  fill = false,
  maxRows,
}: ReportVisualProps) {
  const shown = shownMeasures(result, measures);
  if (chart === 'kpi')
    return <KpiVisual result={result} measures={shown.slice(0, measures === undefined ? 1 : 4)} />;
  if (isEmpty(result)) return <EmptyReason result={result} />;
  if (chart === 'funnel') return <FunnelVisual result={result} measures={shown} />;
  if (chart === 'table')
    return (
      <div className={cn(fill && 'h-full overflow-auto')}>
        <ReportTable result={result} measures={shown} maxRows={maxRows} />
      </div>
    );
  if (result.dimension === null) return <KpiVisual result={result} measures={shown} />;
  return <CartesianVisual result={result} measures={shown} chart={chart} fill={fill} />;
}
