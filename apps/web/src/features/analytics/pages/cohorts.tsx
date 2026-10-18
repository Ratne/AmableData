import { AD_PLATFORMS, type CohortReport, type Site } from '@amable/api-types';
import { cn, DashboardFilterMenu } from '@amable/ui';
import { useParams } from '@tanstack/react-router';
import { Grid3x3 } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { tenantRoute } from '../../../routes/tenant';
import { useCohortReport } from '../api-reports-ads';
import { AnalyticsFrame } from '../components/analytics-layout';
import { EmptyNote, ErrorState, ListSkeleton, Panel } from '../components/ui';
import { useFormatters } from '../lib/format';
import type { AnalyticsState } from '../lib/query-state';
import { platformLabel } from '../reports-ads/labels';
import { roiHeat } from '../reports-ads/model';
import {
  COHORT_GRANULARITIES,
  validateCohortSearch,
  type CohortSearch,
} from '../reports-ads/search';
import { useReportSearch } from '../reports-ads/use-report-search';

const HEAT_COLOR = { positive: 'var(--success)', negative: 'var(--destructive)', neutral: 'transparent' };

function cohortName(
  f: ReturnType<typeof useFormatters>,
  cohort: string,
  granularity: CohortReport['granularity'],
): string {
  const date = new Date(`${cohort}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return cohort;
  if (granularity === 'week') return f.date(date.toISOString(), 'UTC');
  return new Intl.DateTimeFormat(f.locale, { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
    date,
  );
}

function CohortHeatmap({ report }: { report: CohortReport }) {
  const { t } = useI18n();
  const f = useFormatters();
  const cell = 'whitespace-nowrap px-3 py-1.5 text-right tabular-nums';
  return (
    <div className="-mx-4 overflow-x-auto">
      <table className="w-full min-w-max border-separate border-spacing-[3px] text-[12.5px]">
        <thead>
          <tr className="text-[11px] text-muted-foreground">
            <th scope="col" className="px-3 py-1.5 text-left font-medium">
              {t('analytics.cohorts.cohort')}
            </th>
            <th scope="col" className={cn(cell, 'font-medium')}>
              {t('analytics.cohorts.customers')}
            </th>
            <th scope="col" className={cn(cell, 'font-medium')}>
              {t('analytics.cohorts.cost')}
            </th>
            {report.offsets.map((days) => (
              <th key={days} scope="col" className="px-3 py-1.5 text-center font-medium">
                {t('analytics.cohorts.offset', { days })}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {report.rows.map((row) => (
            <tr key={row.cohort}>
              <th scope="row" className="px-3 py-1.5 text-left font-normal">
                {cohortName(f, row.cohort, report.granularity)}
              </th>
              <td className={cell}>{f.number(row.customers)}</td>
              <td className={cell}>{f.money(row.cost_minor, report.currency)}</td>
              {report.offsets.map((days) => {
                const roi = row.roi[String(days)] ?? null;
                const revenue = row.revenue_minor[String(days)] ?? 0;
                const heat = roiHeat(roi);
                return (
                  <td
                    key={days}
                    title={t('analytics.cohorts.cellTitle', {
                      revenue: f.money(revenue, report.currency),
                      roi: roi === null ? '—' : f.percent(roi, 0),
                    })}
                    className="min-w-20 rounded-md px-3 py-1.5 text-center font-medium tabular-nums"
                    style={{
                      background:
                        heat.tone === 'neutral'
                          ? 'color-mix(in oklab, var(--foreground) 4%, transparent)'
                          : `color-mix(in oklab, ${HEAT_COLOR[heat.tone]} ${Math.round(12 + heat.intensity * 48)}%, transparent)`,
                    }}
                  >
                    {roi === null ? '—' : f.percent(roi, 0)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CohortBody({
  state,
  search,
}: {
  state: AnalyticsState & { site: Site };
  search: CohortSearch;
}) {
  const { t } = useI18n();
  const report = useCohortReport(state.tenant, state.site.id, {
    from: state.range.from,
    to: state.range.to,
    timezone: state.site.timezone,
    granularity: search.gran ?? 'month',
    ...(search.platform ? { platform: search.platform } : {}),
  });
  return (
    <Panel title={t('analytics.cohorts.title')}>
      <p className="mb-2 text-xs text-muted-foreground">{t('analytics.cohorts.hint')}</p>
      {report.error ? (
        <ErrorState error={report.error} />
      ) : !report.data ? (
        <ListSkeleton />
      ) : report.data.rows.length === 0 ? (
        <EmptyNote className="flex-col gap-2">
          <Grid3x3 className="size-5" aria-hidden />
          {t('analytics.cohorts.empty')}
        </EmptyNote>
      ) : (
        <CohortHeatmap report={report.data} />
      )}
    </Panel>
  );
}

/** `/t/$tenant/analytics/cohorts` — cumulative ROI of each acquisition cohort by days since. */
export function AnalyticsCohortsPage() {
  const { tenant } = useParams({ from: tenantRoute.id });
  const { t } = useI18n();
  const [search, update] = useReportSearch(validateCohortSearch);
  return (
    <AnalyticsFrame
      tenant={tenant}
      tab={null}
      title={t('analytics.cohorts.title')}
      showFilters={false}
      showSegments={false}
      showInterval={false}
      toolbarExtra={
        <>
          <DashboardFilterMenu
            label={t('analytics.cohorts.granularity')}
            value={search.gran ?? 'month'}
            options={COHORT_GRANULARITIES.map((value) => ({
              value,
              label: t(`analytics.cohorts.gran.${value}`),
            }))}
            onValueChange={(value) =>
              update({ gran: value === 'month' ? undefined : (value as CohortSearch['gran']) })
            }
          />
          <DashboardFilterMenu
            label={t('analytics.cohorts.platform')}
            value={search.platform ?? 'all'}
            options={[
              { value: 'all', label: t('analytics.cohorts.allPlatforms') },
              ...AD_PLATFORMS.map((value) => ({ value, label: platformLabel(t, value) })),
            ]}
            onValueChange={(value) =>
              update({ platform: value === 'all' ? undefined : (value as CohortSearch['platform']) })
            }
          />
        </>
      }
    >
      {(state) => <CohortBody state={state} search={search} />}
    </AnalyticsFrame>
  );
}
