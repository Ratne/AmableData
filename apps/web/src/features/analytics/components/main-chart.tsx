import type { AnalyticsInterval, AnalyticsPoint, AnalyticsPurchase } from '@amable/api-types';
import { ChartContainer, type ChartConfig } from '@amable/ui/ui/chart';
import { Skeleton } from '@amable/ui/ui/skeleton';
import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from 'recharts';
import { useI18n } from '../../../i18n';
import { usePurchases, useTimeseries } from '../api';
import {
  avatarHue,
  currencyDigits,
  initials,
  minorToMajor,
  useFormatters,
  type Formatters,
} from '../lib/format';
import { useReportScope } from './scope';
import { ErrorState, panelClass, Segmented } from './ui';

interface ChartRow {
  readonly index: number;
  readonly t: string;
  readonly visitors: number;
  readonly pageviews: number;
  readonly revenue: number;
  readonly revenueMinor: number;
  readonly purchases: readonly AnalyticsPurchase[];
  readonly anchor: number | null;
}

const MAX_AVATARS = 3;
const AVATAR = 18;

function tickFormatter(f: Formatters, interval: AnalyticsInterval, timeZone: string | undefined) {
  const options: Intl.DateTimeFormatOptions =
    interval === 'hour'
      ? { hour: '2-digit', minute: '2-digit' }
      : interval === 'month'
        ? { month: 'short', year: '2-digit' }
        : { day: 'numeric', month: 'short' };
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat(f.locale, { ...options, timeZone });
  } catch {
    format = new Intl.DateTimeFormat(f.locale, options);
  }
  return (iso: string) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : format.format(date);
  };
}

/** Index of the bucket a purchase falls into (last bucket starting before it). */
function bucketOf(points: readonly AnalyticsPoint[], ts: number): number {
  let found = -1;
  for (let i = 0; i < points.length; i += 1) {
    if (new Date(points[i]!.t).getTime() <= ts) found = i;
    else break;
  }
  return found;
}

type Metric = 'visitors' | 'pageviews';

export function MainChart() {
  const { t } = useI18n();
  const f = useFormatters();
  const navigate = useNavigate();
  const { source, query, interval, currency, timezone, tenant } = useReportScope();
  const series = useTimeseries(source, query, interval);
  const purchases = usePurchases(source, query);
  const [metric, setMetric] = useState<Metric>('visitors');
  const cur = purchases.data?.currency ?? currency;

  const rows = useMemo<ChartRow[]>(() => {
    const points = series.data?.points ?? [];
    const grouped = new Map<number, AnalyticsPurchase[]>();
    for (const purchase of purchases.data?.data ?? []) {
      const index = bucketOf(points, new Date(purchase.ts).getTime());
      if (index < 0) continue;
      grouped.set(index, [...(grouped.get(index) ?? []), purchase]);
    }
    return points.map((point, index) => {
      const bought = grouped.get(index) ?? [];
      return {
        index,
        t: point.t,
        visitors: point.visitors,
        pageviews: point.pageviews,
        revenue: minorToMajor(point.revenue_minor, cur),
        revenueMinor: point.revenue_minor,
        purchases: bought,
        anchor: bought.length > 0 ? 1 : null,
      };
    });
  }, [series.data, purchases.data, cur]);

  const tick = useMemo(() => tickFormatter(f, interval, timezone), [f, interval, timezone]);
  const metricLabel = t(
    metric === 'visitors' ? 'analytics.kpi.visitors' : 'analytics.chart.pageviews',
  );
  const revenueLabel = t('analytics.kpi.revenue');
  const config: ChartConfig = {
    [metric]: { label: metricLabel, color: 'var(--chart-1)' },
    revenue: { label: revenueLabel, color: 'var(--chart-2)' },
  };

  const openContact = (purchase: AnalyticsPurchase) => {
    if (!tenant || !purchase.contact_id) return;
    void navigate({
      to: '/t/$tenant/contacts/$contactId',
      params: { tenant, contactId: purchase.contact_id },
    });
  };

  const renderAvatars = ({
    cx,
    cy,
    index,
  }: {
    cx?: number | string;
    cy?: number | string;
    index: number;
  }) => {
    const row = rows[index];
    const x = Number(cx);
    const y = Number(cy);
    if (!row || row.purchases.length === 0 || !Number.isFinite(x) || !Number.isFinite(y))
      return <g key={`a${index}`} />;
    const shown = row.purchases.slice(0, MAX_AVATARS);
    const extra = row.purchases.length - shown.length;
    const items = extra > 0 ? shown.length + 1 : shown.length;
    const step = AVATAR - 5;
    const left = x - ((items - 1) * step) / 2;
    return (
      <g key={`a${index}`}>
        {shown.map((purchase, i) => {
          const label = purchase.name ?? purchase.email ?? t('analytics.chart.anonymousCustomer');
          const hue = avatarHue(purchase.contact_id ?? purchase.email ?? purchase.transaction_id);
          const clickable = !!tenant && !!purchase.contact_id;
          return (
            <g
              key={purchase.transaction_id}
              transform={`translate(${left + i * step}, ${y})`}
              onClick={() => openContact(purchase)}
              style={{ cursor: clickable ? 'pointer' : 'default' }}
            >
              <title>{`${label} · ${f.money(purchase.amount_minor, purchase.currency)}`}</title>
              <circle r={AVATAR / 2 + 1.5} fill="var(--background)" />
              <circle r={AVATAR / 2} fill={`hsl(${hue} 65% 52%)`} />
              <text textAnchor="middle" dy="0.35em" fontSize={7.5} fontWeight={600} fill="#fff">
                {initials(purchase.name, purchase.email)}
              </text>
            </g>
          );
        })}
        {extra > 0 ? (
          <g transform={`translate(${left + shown.length * step}, ${y})`}>
            <circle r={AVATAR / 2 + 1.5} fill="var(--background)" />
            <circle r={AVATAR / 2} fill="var(--muted)" />
            <text
              textAnchor="middle"
              dy="0.35em"
              fontSize={7.5}
              fontWeight={600}
              fill="var(--muted-foreground)"
            >
              {`+${extra}`}
            </text>
          </g>
        ) : null}
      </g>
    );
  };

  const renderTooltip = (props: TooltipContentProps) => {
    const first = props.payload[0];
    const index =
      typeof first?.payload === 'object' && first.payload !== null && 'index' in first.payload
        ? Number((first.payload as { index: unknown }).index)
        : -1;
    const row = rows[index];
    if (!props.active || !row) return null;
    return (
      <div className="min-w-44 rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg">
        <div className="mb-1.5 font-medium">{f.dateTime(row.t, timezone)}</div>
        <div className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <i className="size-2 rounded-[3px] bg-chart-1" />
            {metricLabel}
          </span>
          <span className="tabular-nums">{f.number(row[metric])}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <i className="size-2 rounded-[3px] bg-chart-2" />
            {revenueLabel}
          </span>
          <span className="tabular-nums">{f.money(row.revenueMinor, cur)}</span>
        </div>
        {row.purchases.length > 0 ? (
          <div className="mt-1.5 border-t pt-1.5 text-muted-foreground">
            {t('analytics.chart.customers', { count: row.purchases.length })}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <section className={`${panelClass} px-4 pb-2 pt-3`}>
      <header className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <i className="size-2.5 rounded-[3px] bg-chart-1" aria-hidden />
            {metricLabel}
          </span>
          <span className="flex items-center gap-1.5">
            <i className="size-2.5 rounded-[3px] bg-chart-2" aria-hidden />
            {revenueLabel}
          </span>
          {source?.kind === 'tenant' ? (
            <span className="hidden items-center gap-1.5 sm:flex">
              <i
                className="size-2.5 rounded-full bg-gradient-to-br from-sky-400 to-violet-500"
                aria-hidden
              />
              {t('analytics.chart.customersLegend')}
            </span>
          ) : null}
        </div>
        <Segmented<Metric>
          label={t('analytics.chart.metric')}
          value={metric}
          onChange={setMetric}
          options={[
            { value: 'visitors', label: t('analytics.kpi.visitors') },
            { value: 'pageviews', label: t('analytics.chart.pageviews') },
          ]}
        />
      </header>
      {series.error ? (
        <ErrorState error={series.error} />
      ) : !series.data ? (
        <Skeleton className="my-2 h-[280px] w-full" />
      ) : (
        <ChartContainer config={config} className="aspect-auto h-[300px] w-full">
          <ComposedChart data={rows} margin={{ top: 26, right: 4, left: 4, bottom: 0 }}>
            <defs>
              <linearGradient id="amb-visitors-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.28} />
                <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis
              dataKey="t"
              tickFormatter={tick}
              tickLine={false}
              axisLine={false}
              minTickGap={28}
              tickMargin={8}
            />
            <YAxis
              yAxisId="visitors"
              tickLine={false}
              axisLine={false}
              width={40}
              allowDecimals={false}
              tickFormatter={(value: number) => f.compact(value)}
            />
            <YAxis
              yAxisId="revenue"
              orientation="right"
              tickLine={false}
              axisLine={false}
              width={52}
              tickFormatter={(value: number) =>
                f.moneyCompact(Math.round(value * 10 ** currencyDigits(cur)), cur)
              }
            />
            <YAxis yAxisId="avatars" hide orientation="right" width={0} domain={[0, 1]} />
            <Tooltip cursor={{ strokeDasharray: '3 3' }} content={renderTooltip} />
            <Bar
              yAxisId="revenue"
              dataKey="revenue"
              fill="var(--chart-2)"
              fillOpacity={0.75}
              radius={[3, 3, 0, 0]}
              maxBarSize={22}
            />
            <Area
              yAxisId="visitors"
              type="monotone"
              dataKey={metric}
              stroke="var(--chart-1)"
              strokeWidth={2}
              fill="url(#amb-visitors-fill)"
              dot={false}
              activeDot={{ r: 3.5 }}
            />
            {source?.kind === 'tenant' ? (
              <Line
                yAxisId="avatars"
                dataKey="anchor"
                stroke="none"
                isAnimationActive={false}
                activeDot={false}
                dot={renderAvatars}
                connectNulls={false}
              />
            ) : null}
          </ComposedChart>
        </ChartContainer>
      )}
    </section>
  );
}
