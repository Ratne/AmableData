import type { PerformanceGroupBy, Site } from '@amable/api-types';
import { cn, DashboardButton, DashboardFilterMenu } from '@amable/ui';
import { Skeleton } from '@amable/ui/ui/skeleton';
import { useParams } from '@tanstack/react-router';
import { ChevronRight, Download, GitCompareArrows, TrendingUp } from 'lucide-react';
import { useMemo } from 'react';
import { useI18n } from '../../../i18n';
import { tenantRoute } from '../../../routes/tenant';
import { usePerformanceReport } from '../api-reports-ads';
import { AnalyticsFrame } from '../components/analytics-layout';
import { EmptyNote, ErrorState, Panel, Segmented } from '../components/ui';
import { useFormatters } from '../lib/format';
import type { AnalyticsState } from '../lib/query-state';
import { previousRange } from '../lib/range';
import {
  AttributionModelControls,
  BasisPicker,
  ColumnPicker,
} from '../reports-ads/controls';
import { columnLabel, groupLabel, platformLabel } from '../reports-ads/labels';
import {
  drillInto,
  encodeDrill,
  performanceCsv,
  performanceRequest,
  PERFORMANCE_TOP_GROUPS,
  PERFORMANCE_VIEWS,
  resolvePerformance,
  serializeColumns,
  type PerformanceColumn,
  type PerformanceOptions,
  type PerformanceView,
} from '../reports-ads/model';
import { PerformanceChart } from '../reports-ads/performance-chart';
import { PerformanceNestedTable, PerformanceTable } from '../reports-ads/performance-table';
import { validatePerformanceSearch, type PerformanceSearch } from '../reports-ads/search';
import { downloadText, useReportSearch } from '../reports-ads/use-report-search';

type Update = (patch: Partial<PerformanceSearch>) => void;

function Breadcrumb({ options, update }: { options: PerformanceOptions; update: Update }) {
  const { t } = useI18n();
  const { drill, topGroup } = options;
  const crumb = 'max-w-48 truncate rounded px-1 hover:bg-foreground/[0.05] hover:text-foreground';
  return (
    <nav className="flex min-w-0 flex-wrap items-center gap-0.5 text-[13px]">
      <button
        type="button"
        className={cn(crumb, drill.length === 0 ? 'font-medium text-foreground' : 'text-muted-foreground')}
        onClick={() => update({ dd: undefined })}
      >
        {groupLabel(t, topGroup)}
      </button>
      {drill.map((step, index) => {
        const value =
          step.value === ''
            ? t('analytics.performance.none')
            : step.dimension === 'platform'
              ? platformLabel(t, step.value)
              : step.value;
        const last = index === drill.length - 1;
        return (
          <span key={`${encodeDrill(step)}-${index}`} className="flex min-w-0 items-center gap-0.5">
            <ChevronRight className="size-3 shrink-0 text-muted-foreground" aria-hidden />
            <button
              type="button"
              title={`${groupLabel(t, step.dimension)}: ${value}`}
              className={cn(crumb, last ? 'font-medium text-foreground' : 'text-muted-foreground')}
              onClick={() => update({ dd: drill.slice(0, index + 1).map(encodeDrill) })}
            >
              {value}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

function PerformanceReportPanel({
  state,
  options,
  update,
}: {
  state: AnalyticsState & { site: Site };
  options: PerformanceOptions;
  update: Update;
}) {
  const { t } = useI18n();
  const f = useFormatters();
  const { site } = state;
  const range = { from: state.range.from, to: state.range.to, timezone: site.timezone };
  const request = performanceRequest(site.id, range, options);
  const before = previousRange(state.range);
  const previousRequest = options.compare
    ? performanceRequest(site.id, { ...range, ...before }, options)
    : null;
  const report = usePerformanceReport(state.tenant, request);
  const previous = usePerformanceReport(state.tenant, previousRequest, options.compare);
  const data = report.data;
  const prev = options.compare ? previous.data : undefined;

  const exportCsv = () => {
    if (!data) return;
    const csv = performanceCsv(data, options.columns, {
      dimension: groupLabel(t, data.group_by),
      column: (c) => columnLabel(t, c),
      unattributed: t('analytics.performance.unattributed'),
      total: t('analytics.performance.total'),
    });
    downloadText(`performance-${data.group_by}-${range.from}-${range.to}.csv`, csv);
  };

  const empty = data !== undefined && data.rows.length === 0;
  const vsTitle = t('analytics.performance.vsPrevious', {
    from: f.date(`${before.from}T12:00:00Z`, 'UTC'),
    to: f.date(`${before.to}T12:00:00Z`, 'UTC'),
  });

  return (
    <Panel
      title={<Breadcrumb options={options} update={update} />}
      actions={
        <>
          <Segmented<PerformanceView>
            label={t('analytics.performance.view')}
            value={options.view}
            onChange={(view) => update({ view: view === 'table' ? undefined : view })}
            options={PERFORMANCE_VIEWS.map((value) => ({
              value,
              label: t(`analytics.performance.view.${value}`),
            }))}
          />
          {options.view === 'chart' ? (
            <DashboardFilterMenu
              label={t('analytics.performance.chartMetric')}
              value={options.chartMetric}
              options={options.columns.map((value) => ({ value, label: columnLabel(t, value) }))}
              onValueChange={(value) => update({ metric: value as PerformanceColumn })}
            />
          ) : null}
          <DashboardButton
            variant={options.compare ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={options.compare}
            title={vsTitle}
            onClick={() => update({ cmp: options.compare ? undefined : '1' })}
          >
            <GitCompareArrows aria-hidden />
            <span className="hidden sm:inline">{t('analytics.performance.compare')}</span>
          </DashboardButton>
          <ColumnPicker
            columns={options.columns}
            onChange={(columns) => update({ cols: serializeColumns(columns) })}
          />
          <DashboardButton variant="ghost" size="sm" onClick={exportCsv} disabled={!data || empty}>
            <Download aria-hidden />
            <span className="hidden sm:inline">{t('analytics.performance.export')}</span>
          </DashboardButton>
        </>
      }
    >
      {options.compare ? (
        <p className="mb-2 text-[11px] text-muted-foreground">{vsTitle}</p>
      ) : null}
      {report.error ? (
        <ErrorState error={report.error} />
      ) : !data ? (
        <div className="flex flex-col gap-1.5" aria-busy>
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </div>
      ) : empty ? (
        <EmptyNote className="flex-col gap-1">
          <TrendingUp className="size-5" aria-hidden />
          <span className="text-sm text-foreground">{t('analytics.performance.empty')}</span>
          <span>{t('analytics.performance.emptyHint')}</span>
        </EmptyNote>
      ) : options.view === 'chart' ? (
        <PerformanceChart report={data} previous={prev} metric={options.chartMetric} />
      ) : options.view === 'nested' ? (
        <PerformanceNestedTable
          tenant={state.tenant}
          report={data}
          previous={prev}
          request={request}
          previousRequest={previousRequest}
          columns={options.columns}
        />
      ) : (
        <PerformanceTable
          report={data}
          previous={prev}
          columns={options.columns}
          onDrill={(row) => update({ dd: drillInto(options.drill, data.group_by, row.key) })}
        />
      )}
    </Panel>
  );
}

/**
 * `/t/$tenant/analytics/performance` — spend and attributed revenue per
 * platform → campaign → adset → ad, with the attribution model, columns,
 * view and comparison kept in the search params.
 */
export function AnalyticsPerformancePage() {
  const { tenant } = useParams({ from: tenantRoute.id });
  const { t } = useI18n();
  const [search, update] = useReportSearch(validatePerformanceSearch);
  const options = useMemo(() => resolvePerformance(search), [search]);
  return (
    <AnalyticsFrame
      tenant={tenant}
      tab={null}
      title={t('analytics.performance.title')}
      showFilters={false}
      showSegments={false}
      showInterval={false}
      toolbarExtra={
        <>
          <AttributionModelControls
            model={options.model}
            windowDays={options.windowDays}
            onModel={(am) => update({ am: am === 'last_click' ? undefined : am })}
            onWindow={(win) => update({ win })}
          />
          <BasisPicker
            basis={options.basis}
            onChange={(basis) => update({ basis: basis === 'click_date' ? undefined : basis })}
          />
          <DashboardFilterMenu
            label={t('analytics.performance.group')}
            value={options.topGroup}
            options={PERFORMANCE_TOP_GROUPS.map((value) => ({
              value,
              label: groupLabel(t, value),
            }))}
            onValueChange={(value) =>
              update({
                group: value === 'platform' ? undefined : (value as PerformanceGroupBy),
                dd: undefined,
              })
            }
          />
        </>
      }
    >
      {(state) => <PerformanceReportPanel state={state} options={options} update={update} />}
    </AnalyticsFrame>
  );
}
