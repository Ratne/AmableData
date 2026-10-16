import type { AnalyticsInsights, InsightsSegmentRow } from '@amable/api-types';
import { cn } from '@amable/ui';
import { ChartContainer, type ChartConfig } from '@amable/ui/ui/chart';
import { Skeleton } from '@amable/ui/ui/skeleton';
import { useParams } from '@tanstack/react-router';
import { Clock, Hourglass, Repeat, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from 'recharts';
import { useI18n } from '../../../i18n';
import { tenantRoute } from '../../../routes/tenant';
import { useInsights } from '../api';
import { AnalyticsFrame } from '../components/analytics-layout';
import { AnimatedNumber } from '../components/animated-number';
import { KpiCard } from '../components/kpi-row';
import { useReportScope } from '../components/scope';
import { EmptyNote, ErrorState, Flag, Panel, Segmented } from '../components/ui';
import { countryName } from '../lib/countries';
import { currencyDigits, minorToMajor, useFormatters } from '../lib/format';

type Metric = 'revenue' | 'conversion';

function SegmentChart({ rows, metric }: { rows: readonly InsightsSegmentRow[]; metric: Metric }) {
  const { t } = useI18n();
  const f = useFormatters();
  const { currency } = useReportScope();
  if (rows.length === 0) return <EmptyNote>{t('analytics.insights.noPurchases')}</EmptyNote>;
  const data = rows.slice(0, 8).map((row) => ({
    name: row.value ?? t('analytics.breakdown.none'),
    value:
      metric === 'revenue' ? minorToMajor(row.revenue_minor, currency) : row.conversion_rate * 100,
    row,
  }));
  const config: ChartConfig = {
    value: { label: t('analytics.kpi.revenue'), color: 'var(--chart-2)' },
  };
  return (
    <ChartContainer config={config} className="aspect-auto h-[220px] w-full">
      <BarChart data={data} layout="vertical" margin={{ left: 0, right: 12, top: 4, bottom: 0 }}>
        <CartesianGrid horizontal={false} strokeDasharray="3 3" />
        <XAxis
          type="number"
          tickLine={false}
          axisLine={false}
          tickFormatter={(value: number) =>
            metric === 'revenue'
              ? f.moneyCompact(Math.round(value * 10 ** currencyDigits(currency)), currency)
              : `${f.number(value, 1)}%`
          }
        />
        <YAxis type="category" dataKey="name" tickLine={false} axisLine={false} width={92} />
        <Tooltip
          cursor={{ fill: 'var(--muted)', opacity: 0.4 }}
          content={({ active, payload }) => {
            const entry = payload[0]?.payload as
              { row?: InsightsSegmentRow; name?: string } | undefined;
            const row = entry?.row;
            if (!active || !row) return null;
            return (
              <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-lg">
                <div className="mb-1 font-medium">{entry.name}</div>
                <div className="text-muted-foreground">
                  {t('analytics.insights.segmentTip', {
                    revenue: f.money(row.revenue_minor, currency),
                    customers: f.number(row.customers),
                    visitors: f.number(row.visitors),
                    rate: f.percent(row.conversion_rate, 2),
                  })}
                </div>
              </div>
            );
          }}
        />
        <Bar
          dataKey="value"
          fill={metric === 'revenue' ? 'var(--chart-2)' : 'var(--chart-1)'}
          radius={[0, 4, 4, 0]}
          maxBarSize={18}
        />
      </BarChart>
    </ChartContainer>
  );
}

function SegmentsPanel({ insights }: { insights: AnalyticsInsights }) {
  const { t } = useI18n();
  const [dimension, setDimension] = useState<'device' | 'os' | 'browser'>('device');
  const [metric, setMetric] = useState<Metric>('revenue');
  const rows =
    dimension === 'device'
      ? insights.revenue_by_device
      : dimension === 'os'
        ? insights.revenue_by_os
        : insights.revenue_by_browser;
  return (
    <Panel
      title={t('analytics.insights.revenueBy')}
      actions={
        <>
          <Segmented
            label={t('analytics.insights.revenueBy')}
            value={dimension}
            onChange={setDimension}
            options={[
              { value: 'device', label: t('analytics.dim.device') },
              { value: 'os', label: t('analytics.dim.os') },
              { value: 'browser', label: t('analytics.dim.browser') },
            ]}
          />
          <Segmented
            label={t('analytics.insights.metric')}
            value={metric}
            onChange={setMetric}
            options={[
              { value: 'revenue', label: t('analytics.kpi.revenue') },
              { value: 'conversion', label: t('analytics.kpi.conversionRate') },
            ]}
          />
        </>
      }
    >
      <SegmentChart rows={rows} metric={metric} />
    </Panel>
  );
}

function CountryTable({ rows, metric }: { rows: readonly InsightsSegmentRow[]; metric: Metric }) {
  const { t, locale } = useI18n();
  const f = useFormatters();
  const { currency, onFilter } = useReportScope();
  if (rows.length === 0) return <EmptyNote>{t('analytics.insights.noPurchases')}</EmptyNote>;
  const value = (row: InsightsSegmentRow) =>
    metric === 'revenue' ? row.revenue_minor : row.conversion_rate;
  const max = Math.max(Number.EPSILON, ...rows.map(value));
  return (
    <ul className="flex flex-col gap-0.5">
      {rows.slice(0, 10).map((row) => (
        <li key={row.value ?? 'none'}>
          <button
            type="button"
            disabled={!row.value || !onFilter}
            onClick={() =>
              row.value && onFilter?.({ dimension: 'country', op: 'is', value: row.value })
            }
            className="group relative flex h-8 w-full items-center gap-3 rounded-md px-2 text-left disabled:cursor-default"
          >
            <span
              aria-hidden
              className={cn(
                'absolute inset-y-0 left-0 rounded-md',
                metric === 'revenue' ? 'bg-chart-2/12' : 'bg-primary/10',
              )}
              style={{ width: `${(value(row) / max) * 100}%` }}
            />
            <span className="relative flex min-w-0 flex-1 items-center gap-2 text-[13px]">
              <Flag code={row.value} />
              <span className="truncate">
                {countryName(row.value, locale) || t('analytics.breakdown.none')}
              </span>
            </span>
            <span className="relative w-16 text-right text-[12.5px] tabular-nums text-muted-foreground">
              {f.number(row.customers)}
            </span>
            <span className="relative w-20 text-right text-[12.5px] font-medium tabular-nums">
              {metric === 'revenue'
                ? f.moneyCompact(row.revenue_minor, currency)
                : f.percent(row.conversion_rate, 2)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Histogram({
  title,
  distribution,
  unit,
}: {
  title: string;
  distribution: AnalyticsInsights['visits_before_purchase'];
  unit: 'visits' | 'days';
}) {
  const { t } = useI18n();
  const f = useFormatters();
  const config: ChartConfig = {
    customers: { label: t('analytics.insights.customers'), color: 'var(--chart-1)' },
  };
  const fmt = (value: number | null) =>
    value === null
      ? '—'
      : unit === 'visits'
        ? f.number(value, 1)
        : t('analytics.insights.daysValue', { value: f.number(value, 1) });
  return (
    <Panel
      title={title}
      actions={
        <span className="flex gap-3 text-xs text-muted-foreground">
          <span>
            {t('analytics.insights.median')}{' '}
            <b className="font-medium text-foreground">{fmt(distribution.median)}</b>
          </span>
          <span>
            {t('analytics.insights.average')}{' '}
            <b className="font-medium text-foreground">{fmt(distribution.average)}</b>
          </span>
        </span>
      }
    >
      {distribution.buckets.length === 0 ? (
        <EmptyNote>{t('analytics.insights.noPurchases')}</EmptyNote>
      ) : (
        <ChartContainer config={config} className="aspect-auto h-[180px] w-full">
          <BarChart data={distribution.buckets} margin={{ left: 0, right: 0, top: 8, bottom: 0 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis dataKey="bucket" tickLine={false} axisLine={false} />
            <YAxis tickLine={false} axisLine={false} width={32} allowDecimals={false} />
            <Tooltip
              cursor={{ fill: 'var(--muted)', opacity: 0.4 }}
              content={({ active, payload, label }) =>
                active && payload[0] ? (
                  <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-lg">
                    <div className="font-medium">{String(label ?? '')}</div>
                    <div className="text-muted-foreground">
                      {t('analytics.insights.customersCount', {
                        count: f.number(Number(payload[0].value ?? 0)),
                      })}
                    </div>
                  </div>
                ) : null
              }
            />
            <Bar dataKey="customers" fill="var(--chart-1)" radius={[4, 4, 0, 0]} maxBarSize={36} />
          </BarChart>
        </ChartContainer>
      )}
    </Panel>
  );
}

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

function Heatmap({ cells }: { cells: AnalyticsInsights['heatmap'] }) {
  const { t, locale } = useI18n();
  const f = useFormatters();
  const grid = useMemo(() => {
    const map = new Map<string, number>();
    for (const cell of cells) map.set(`${cell.day}:${cell.hour}`, cell.conversions);
    return map;
  }, [cells]);
  const max = Math.max(1, ...cells.map((cell) => cell.conversions));
  const dayNames = useMemo(() => {
    const format = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
    // 2024-01-01 is a Monday.
    return WEEKDAYS.map((day) => format.format(new Date(Date.UTC(2024, 0, 1 + day))));
  }, [locale]);
  return (
    <Panel
      title={t('analytics.insights.heatmap')}
      actions={
        <span className="text-[11px] text-muted-foreground">
          {t('analytics.insights.heatmapHint')}
        </span>
      }
    >
      <div className="overflow-x-auto">
        <div className="grid min-w-[560px] grid-cols-[36px_repeat(24,minmax(0,1fr))] gap-[3px]">
          <span />
          {Array.from({ length: 24 }, (_, hour) => (
            <span key={hour} className="text-center text-[10px] tabular-nums text-muted-foreground">
              {hour % 3 === 0 ? hour : ''}
            </span>
          ))}
          {WEEKDAYS.map((day) => (
            <div key={day} className="contents">
              <span className="flex items-center text-[11px] text-muted-foreground">
                {dayNames[day]}
              </span>
              {Array.from({ length: 24 }, (_, hour) => {
                const value = grid.get(`${day}:${hour}`) ?? 0;
                const intensity = value / max;
                return (
                  <span
                    key={hour}
                    title={t('analytics.insights.heatmapCell', {
                      day: dayNames[day] ?? '',
                      hour: `${String(hour).padStart(2, '0')}:00`,
                      count: f.number(value),
                    })}
                    className="aspect-square rounded-[4px]"
                    style={{
                      background:
                        value === 0
                          ? 'color-mix(in oklab, var(--foreground) 5%, transparent)'
                          : `color-mix(in oklab, var(--primary) ${Math.round(18 + intensity * 82)}%, transparent)`,
                    }}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </Panel>
  );
}

function RpvChart({ insights }: { insights: AnalyticsInsights }) {
  const { t } = useI18n();
  const f = useFormatters();
  const { currency, timezone } = useReportScope();
  const config: ChartConfig = {
    rpv: { label: t('analytics.kpi.revenuePerVisitor'), color: 'var(--chart-1)' },
  };
  const data = insights.revenue_per_visitor.map((point) => ({
    t: point.t,
    rpv: minorToMajor(point.revenue_per_visitor_minor, currency),
    point,
  }));
  if (data.length === 0) return <EmptyNote>{t('analytics.breakdown.empty')}</EmptyNote>;
  return (
    <ChartContainer config={config} className="aspect-auto h-[220px] w-full">
      <LineChart data={data} margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="t"
          tickLine={false}
          axisLine={false}
          tickFormatter={(iso: string) => f.date(iso, timezone)}
          minTickGap={32}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={56}
          tickFormatter={(value: number) =>
            f.money(Math.round(value * 10 ** currencyDigits(currency)), currency)
          }
        />
        <Tooltip
          content={({ active, payload }) => {
            const entry = payload[0]?.payload as
              { point?: AnalyticsInsights['revenue_per_visitor'][number] } | undefined;
            const point = entry?.point;
            if (!active || !point) return null;
            return (
              <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-lg">
                <div className="mb-1 font-medium">{f.date(point.t, timezone)}</div>
                <div className="text-muted-foreground">
                  {t('analytics.insights.rpvTip', {
                    rpv: f.money(Math.round(point.revenue_per_visitor_minor), currency),
                    revenue: f.money(point.revenue_minor, currency),
                    visitors: f.number(point.visitors),
                  })}
                </div>
              </div>
            );
          }}
        />
        <Line
          type="monotone"
          dataKey="rpv"
          stroke="var(--chart-1)"
          strokeWidth={2}
          dot={{ r: 2.5 }}
          activeDot={{ r: 4 }}
        />
      </LineChart>
    </ChartContainer>
  );
}

function InsightsBody() {
  const { t } = useI18n();
  const f = useFormatters();
  const { source, query, currency } = useReportScope();
  const [rpvInterval, setRpvInterval] = useState<'week' | 'month'>('week');
  const insights = useInsights(source, query, rpvInterval);
  const [countryMetric, setCountryMetric] = useState<Metric>('revenue');

  if (insights.error) return <ErrorState error={insights.error} />;
  const data = insights.data;
  if (!data)
    return (
      <div className="grid gap-[7px]">
        <Skeleton className="h-20 w-full" />
        <div className="grid gap-[7px] lg:grid-cols-2">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      </div>
    );

  const hours = data.median_hours_to_purchase;
  return (
    <>
      <ul className="grid grid-cols-2 gap-[7px] lg:grid-cols-4">
        <KpiCard
          icon={Users}
          label={t('analytics.insights.customers')}
          hint={t('analytics.insights.customersHint', { visitors: f.compact(data.visitors) })}
        >
          <AnimatedNumber value={data.customers} format={(v) => f.number(Math.round(v))} />
        </KpiCard>
        <KpiCard
          icon={Clock}
          label={t('analytics.insights.medianHours')}
          hint={t('analytics.insights.medianHoursHint')}
        >
          {hours === null ? (
            '—'
          ) : (
            <AnimatedNumber
              value={hours}
              format={(v) => t('analytics.insights.hoursValue', { value: f.number(v, 1) })}
            />
          )}
        </KpiCard>
        <KpiCard icon={Repeat} label={t('analytics.insights.visitsBefore')}>
          {data.visits_before_purchase.median === null
            ? '—'
            : f.number(data.visits_before_purchase.median, 1)}
        </KpiCard>
        <KpiCard icon={Hourglass} label={t('analytics.insights.daysBefore')}>
          {data.days_before_purchase.median === null
            ? '—'
            : t('analytics.insights.daysValue', {
                value: f.number(data.days_before_purchase.median, 1),
              })}
        </KpiCard>
      </ul>

      <div className="grid grid-cols-1 gap-[7px] xl:grid-cols-2">
        <SegmentsPanel insights={data} />
        <Panel
          title={t('analytics.insights.topCountries')}
          actions={
            <Segmented
              label={t('analytics.insights.topCountries')}
              value={countryMetric}
              onChange={setCountryMetric}
              options={[
                { value: 'revenue', label: t('analytics.insights.byRevenue') },
                { value: 'conversion', label: t('analytics.insights.byConversion') },
              ]}
            />
          }
        >
          <CountryTable
            metric={countryMetric}
            rows={
              countryMetric === 'revenue'
                ? data.top_countries_by_revenue
                : data.top_countries_by_conversion
            }
          />
        </Panel>
        <Histogram
          title={t('analytics.insights.visitsBefore')}
          distribution={data.visits_before_purchase}
          unit="visits"
        />
        <Histogram
          title={t('analytics.insights.daysBefore')}
          distribution={data.days_before_purchase}
          unit="days"
        />
      </div>

      <Heatmap cells={data.heatmap} />

      <div className="grid grid-cols-1 gap-[7px] xl:grid-cols-2">
        <Panel title={t('analytics.insights.convertingEvents')}>
          {data.converting_events.length === 0 ? (
            <EmptyNote>{t('analytics.insights.noGoals')}</EmptyNote>
          ) : (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="pb-1.5 font-medium">{t('analytics.dim.goal')}</th>
                  <th className="pb-1.5 text-right font-medium">{t('analytics.kpi.visitors')}</th>
                  <th className="pb-1.5 text-right font-medium">
                    {t('analytics.insights.customers')}
                  </th>
                  <th className="pb-1.5 text-right font-medium">
                    {t('analytics.kpi.conversionRate')}
                  </th>
                  <th className="pb-1.5 text-right font-medium">{t('analytics.kpi.revenue')}</th>
                </tr>
              </thead>
              <tbody>
                {data.converting_events.map((event) => (
                  <tr key={event.goal} className="border-t border-foreground/[0.06]">
                    <td className="py-1.5 font-mono text-[12px]">{event.goal}</td>
                    <td className="py-1.5 text-right tabular-nums">{f.compact(event.visitors)}</td>
                    <td className="py-1.5 text-right tabular-nums">{f.compact(event.customers)}</td>
                    <td className="py-1.5 text-right font-medium tabular-nums">
                      {f.percent(event.conversion_rate, 1)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {f.moneyCompact(event.revenue_minor, currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
        <Panel
          title={t('analytics.insights.rpvGrowth')}
          actions={
            <Segmented
              label={t('analytics.controls.interval')}
              value={rpvInterval}
              onChange={setRpvInterval}
              options={[
                { value: 'week', label: t('analytics.interval.week') },
                { value: 'month', label: t('analytics.interval.month') },
              ]}
            />
          }
        >
          <RpvChart insights={data} />
        </Panel>
      </div>
    </>
  );
}

export function AnalyticsInsightsPage() {
  const { tenant } = useParams({ from: tenantRoute.id });
  return (
    <AnalyticsFrame tenant={tenant} tab="insights" showInterval={false}>
      {() => <InsightsBody />}
    </AnalyticsFrame>
  );
}
