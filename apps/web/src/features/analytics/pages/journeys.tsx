import type { JourneyReport, Site } from '@amable/api-types';
import { cn, DashboardFilterMenu } from '@amable/ui';
import { useParams } from '@tanstack/react-router';
import { ChevronRight, Footprints } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { tenantRoute } from '../../../routes/tenant';
import { useJourneyReport } from '../api-reports-ads';
import { AnalyticsFrame } from '../components/analytics-layout';
import { EmptyNote, ErrorState, ListSkeleton, Panel } from '../components/ui';
import { useFormatters } from '../lib/format';
import type { AnalyticsState } from '../lib/query-state';
import { journeyStepLabel } from '../reports-ads/model';
import { JOURNEY_STEPS, validateJourneySearch, type JourneySearch } from '../reports-ads/search';
import { useReportSearch } from '../reports-ads/use-report-search';

function StepChips({ steps }: { steps: readonly string[] }) {
  const { t } = useI18n();
  const none = t('analytics.journeys.none');
  return (
    <ol className="flex flex-wrap items-center gap-1">
      {steps.map((step, index) => (
        <li key={index} className="flex items-center gap-1">
          {index > 0 ? (
            <ChevronRight className="size-3 shrink-0 text-muted-foreground" aria-hidden />
          ) : null}
          <span
            className={cn(
              'max-w-56 truncate rounded-full px-2 py-0.5 text-[11.5px]',
              step === '' ? 'bg-foreground/[0.05] italic text-muted-foreground' : 'bg-primary/10 text-foreground',
            )}
            title={journeyStepLabel(step, none)}
          >
            {journeyStepLabel(step, none)}
          </span>
        </li>
      ))}
    </ol>
  );
}

function JourneyTable({ report }: { report: JourneyReport }) {
  const { t } = useI18n();
  const f = useFormatters();
  const cell = 'whitespace-nowrap px-3 py-2 text-right align-top tabular-nums';
  return (
    <div className="-mx-4 overflow-x-auto">
      <table className="w-full border-collapse text-[12.5px]">
        <thead>
          <tr className="border-b border-foreground/[0.06] text-[11px] text-muted-foreground">
            <th scope="col" className="px-3 py-2 text-left font-medium">
              {t('analytics.journeys.path')}
            </th>
            <th scope="col" className={cn(cell, 'font-medium')}>
              {t('analytics.journeys.visitors')}
            </th>
            <th scope="col" className={cn(cell, 'font-medium')}>
              {t('analytics.journeys.conversions')}
            </th>
            <th scope="col" className={cn(cell, 'font-medium')}>
              {t('analytics.journeys.revenue')}
            </th>
            <th scope="col" className={cn(cell, 'font-medium')}>
              {t('analytics.journeys.avgDays')}
            </th>
          </tr>
        </thead>
        <tbody>
          {report.rows.map((row, index) => (
            <tr key={`${row.steps.join('\u0000')}-${index}`} className="border-b border-foreground/[0.04]">
              <td className="px-3 py-2">
                <StepChips steps={row.steps} />
              </td>
              <td className={cell}>{f.number(row.visitors)}</td>
              <td className={cell}>{f.number(row.conversions)}</td>
              <td className={cn(cell, 'font-medium')}>{f.money(row.revenue_minor, report.currency)}</td>
              <td className={cell}>
                {row.avg_days_to_convert === null ? '—' : f.number(row.avg_days_to_convert, 1)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function JourneyBody({
  state,
  search,
}: {
  state: AnalyticsState & { site: Site };
  search: JourneySearch;
}) {
  const { t } = useI18n();
  const report = useJourneyReport(state.tenant, state.site.id, {
    from: state.range.from,
    to: state.range.to,
    timezone: state.site.timezone,
    step: search.step ?? 'source',
    converted_only: search.conv === '1',
  });
  return (
    <Panel title={t('analytics.journeys.title')}>
      <p className="mb-2 text-xs text-muted-foreground">{t('analytics.journeys.hint')}</p>
      {report.error ? (
        <ErrorState error={report.error} />
      ) : !report.data ? (
        <ListSkeleton />
      ) : report.data.rows.length === 0 ? (
        <EmptyNote className="flex-col gap-2">
          <Footprints className="size-5" aria-hidden />
          {t('analytics.journeys.empty')}
        </EmptyNote>
      ) : (
        <JourneyTable report={report.data} />
      )}
    </Panel>
  );
}

/** `/t/$tenant/analytics/journeys` — aggregated touch sequences up to the first sale. */
export function AnalyticsJourneysPage() {
  const { tenant } = useParams({ from: tenantRoute.id });
  const { t } = useI18n();
  const [search, update] = useReportSearch(validateJourneySearch);
  return (
    <AnalyticsFrame
      tenant={tenant}
      tab={null}
      title={t('analytics.journeys.title')}
      showFilters={false}
      showSegments={false}
      showInterval={false}
      toolbarExtra={
        <>
          <DashboardFilterMenu
            label={t('analytics.journeys.step')}
            value={search.step ?? 'source'}
            options={JOURNEY_STEPS.map((value) => ({
              value,
              label: t(`analytics.journeys.step.${value}`),
            }))}
            onValueChange={(value) =>
              update({ step: value === 'source' ? undefined : (value as JourneySearch['step']) })
            }
          />
          <DashboardFilterMenu
            value={search.conv ?? 'all'}
            options={[
              { value: 'all', label: t('analytics.journeys.allJourneys') },
              { value: '1', label: t('analytics.journeys.convertedOnly') },
            ]}
            onValueChange={(value) => update({ conv: value === '1' ? '1' : undefined })}
          />
        </>
      }
    >
      {(state) => <JourneyBody state={state} search={search} />}
    </AnalyticsFrame>
  );
}
