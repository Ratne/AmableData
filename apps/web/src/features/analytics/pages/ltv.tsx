import type { LtvReport, Site } from '@amable/api-types';
import { cn, DashboardFilterMenu } from '@amable/ui';
import { ChartContainer, type ChartConfig } from '@amable/ui/ui/chart';
import { useParams } from '@tanstack/react-router';
import { Repeat } from 'lucide-react';
import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from 'recharts';
import { useI18n } from '../../../i18n';
import { tenantRoute } from '../../../routes/tenant';
import { useLtvReport } from '../api-reports-ads';
import { AnalyticsFrame } from '../components/analytics-layout';
import { EmptyNote, ErrorState, ListSkeleton, Panel } from '../components/ui';
import { currencyDigits, minorToMajor, useFormatters } from '../lib/format';
import type { AnalyticsState } from '../lib/query-state';
import { groupLabel, rowLabel } from '../reports-ads/labels';
import { LTV_GROUPS, LTV_MODELS, validateLtvSearch, type LtvGroup, type LtvSearch } from '../reports-ads/search';
import { useReportSearch } from '../reports-ads/use-report-search';

const MAX_LINES = 5;
const LINE_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];

/** Customer acquisition cost of a row, null without customers. */
const cacOf = (row: LtvReport['rows'][number]) =>
  row.customers > 0 ? row.cost_minor / row.customers : null;

function LtvChart({ report, group }: { report: LtvReport; group: LtvGroup }) {
  const { t } = useI18n();
  const f = useFormatters();
  const rows = [...report.rows].sort((a, b) => b.customers - a.customers).slice(0, MAX_LINES);
  const data = report.windows.map((days) => {
    const point: Record<string, number | string> = { days: t('analytics.ltv.days', { days }) };
    rows.forEach((row, i) => {
      point[`r${i}`] = minorToMajor(row.ltv_minor[String(days)] ?? 0, report.currency);
    });
    return point;
  });
  const config = Object.fromEntries(
    rows.map((row, i) => [
      `r${i}`,
      { label: rowLabel(t, group, row), color: LINE_COLORS[i % LINE_COLORS.length]! },
    ]),
  ) satisfies ChartConfig;
  const money = (major: number) =>
    f.money(Math.round(major * 10 ** currencyDigits(report.currency)), report.currency);
  return (
    <ChartContainer config={config} className="aspect-auto h-[280px] w-full">
      <LineChart data={data} margin={{ top: 12, right: 12, left: 8, bottom: 0 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="days" tickLine={false} axisLine={false} tickMargin={8} />
        <YAxis tickLine={false} axisLine={false} width={64} tickFormatter={money} />
        <Tooltip
          formatter={(value, name) => [money(Number(value)), config[String(name)]?.label ?? name]}
        />
        {rows.map((_, i) => (
          <Line
            key={i}
            type="monotone"
            dataKey={`r${i}`}
            stroke={`var(--color-r${i})`}
            strokeWidth={2}
            dot={{ r: 3 }}
          />
        ))}
      </LineChart>
    </ChartContainer>
  );
}

function LtvTable({ report, group }: { report: LtvReport; group: LtvGroup }) {
  const { t } = useI18n();
  const f = useFormatters();
  const cell = 'whitespace-nowrap px-3 py-1.5 text-right tabular-nums';
  return (
    <div className="-mx-4 overflow-x-auto">
      <table className="w-full min-w-max border-collapse text-[12.5px]">
        <thead>
          <tr className="border-b border-foreground/[0.06] text-[11px] text-muted-foreground">
            <th scope="col" className="px-3 py-2 text-left font-medium">
              {groupLabel(t, group)}
            </th>
            <th scope="col" className={cn(cell, 'font-medium')}>
              {t('analytics.ltv.customers')}
            </th>
            <th scope="col" className={cn(cell, 'font-medium')}>
              {t('analytics.ltv.cost')}
            </th>
            <th scope="col" className={cn(cell, 'font-medium')}>
              {t('analytics.ltv.cac')}
            </th>
            {report.windows.map((days) => (
              <th key={days} scope="col" className={cn(cell, 'font-medium')}>
                {t('analytics.ltv.days', { days })}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {report.rows.map((row) => {
            const cac = cacOf(row);
            return (
              <tr key={row.key ?? '\u0000'} className="border-b border-foreground/[0.04]">
                <th
                  scope="row"
                  className={cn(
                    'max-w-72 truncate px-3 py-1.5 text-left font-normal',
                    row.key === null && 'italic text-muted-foreground',
                  )}
                >
                  {rowLabel(t, group, row)}
                </th>
                <td className={cell}>{f.number(row.customers)}</td>
                <td className={cell}>{f.money(row.cost_minor, report.currency)}</td>
                <td className={cell}>
                  {cac === null || row.cost_minor === 0 ? '—' : f.money(Math.round(cac), report.currency)}
                </td>
                {report.windows.map((days) => {
                  const ltv = row.ltv_minor[String(days)] ?? 0;
                  const paid = cac !== null && row.cost_minor > 0;
                  return (
                    <td
                      key={days}
                      className={cn(cell, paid && (ltv >= cac ? 'text-success' : 'text-destructive'))}
                      title={f.money(row.revenue_minor[String(days)] ?? 0, report.currency)}
                    >
                      {f.money(Math.round(ltv), report.currency)}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function LtvBody({
  state,
  search,
}: {
  state: AnalyticsState & { site: Site };
  search: LtvSearch;
}) {
  const { t } = useI18n();
  const group = search.group ?? 'source';
  const report = useLtvReport(state.tenant, state.site.id, {
    from: state.range.from,
    to: state.range.to,
    timezone: state.site.timezone,
    group_by: group,
    model: search.lm ?? 'first_click',
  });
  if (report.error) return <ErrorState error={report.error} />;
  if (!report.data)
    return (
      <Panel>
        <ListSkeleton />
      </Panel>
    );
  if (report.data.rows.length === 0)
    return (
      <Panel>
        <EmptyNote className="flex-col gap-2">
          <Repeat className="size-5" aria-hidden />
          {t('analytics.ltv.empty')}
        </EmptyNote>
      </Panel>
    );
  return (
    <>
      <Panel title={t('analytics.ltv.chartTitle')}>
        <p className="mb-2 text-xs text-muted-foreground">{t('analytics.ltv.hint')}</p>
        <LtvChart report={report.data} group={group} />
      </Panel>
      <Panel title={t('analytics.ltv.tableTitle')}>
        <LtvTable report={report.data} group={group} />
      </Panel>
    </>
  );
}

/** `/t/$tenant/analytics/ltv` — revenue per customer at 30…365 days by acquisition channel. */
export function AnalyticsLtvPage() {
  const { tenant } = useParams({ from: tenantRoute.id });
  const { t } = useI18n();
  const [search, update] = useReportSearch(validateLtvSearch);
  return (
    <AnalyticsFrame
      tenant={tenant}
      tab={null}
      title={t('analytics.ltv.title')}
      showFilters={false}
      showSegments={false}
      showInterval={false}
      toolbarExtra={
        <>
          <DashboardFilterMenu
            label={t('analytics.ltv.group')}
            value={search.group ?? 'source'}
            options={LTV_GROUPS.map((value) => ({ value, label: groupLabel(t, value) }))}
            onValueChange={(value) =>
              update({ group: value === 'source' ? undefined : (value as LtvSearch['group']) })
            }
          />
          <DashboardFilterMenu
            label={t('analytics.ltv.model')}
            value={search.lm ?? 'first_click'}
            options={LTV_MODELS.map((value) => ({ value, label: t(`analytics.ltv.model.${value}`) }))}
            onValueChange={(value) =>
              update({ lm: value === 'first_click' ? undefined : (value as LtvSearch['lm']) })
            }
          />
        </>
      }
    >
      {(state) => <LtvBody state={state} search={search} />}
    </AnalyticsFrame>
  );
}
