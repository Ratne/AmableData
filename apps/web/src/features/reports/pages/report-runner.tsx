import { REPORT_SOURCE_SPECS, type ReportCatalogEntry } from '@amable/api-types/reports';
import { PageBody, usePageChrome } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Card, CardContent } from '@amable/ui/ui/card';
import { Skeleton } from '@amable/ui/ui/skeleton';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, CopyPlus, Pencil, RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useI18n } from '../../../i18n';
import { errorMessage } from '../../crm/api/hooks';
import { useFieldCatalog } from '../../crm/field-catalog';
import { QueryBuilder } from '../../search/query-builder';
import { countConditions } from '../../search/query-model';
import {
  useReportApi,
  useReportEntry,
  useReportPermissions,
  useReportRun,
  useReportTimeZone,
} from '../api/hooks';
import { CsvExportButton } from '../components/csv-export-button';
import { ReportToolbar } from '../components/report-toolbar';
import { ReportTable, ReportVisual } from '../components/report-visual';
import { exportCsvUrl } from '../lib/export';
import { reportDescription, reportName } from '../lib/labels';
import { runnerFromEntry, runnerOverrides, type RunnerState } from '../lib/runner';
import { useStableDebounced } from '../lib/use-debounced';

function RangeLine({
  from,
  to,
  compare,
}: {
  from: string;
  to: string;
  compare: { from: string; to: string } | null;
}) {
  const { t } = useI18n();
  return (
    <p className="text-xs text-muted-foreground tabular-nums">
      {t('rep.result.range', { from, to })}
      {compare !== null
        ? ` · ${t('rep.result.compareRange', { from: compare.from, to: compare.to })}`
        : ''}
    </p>
  );
}

function Runner({ entry }: { entry: ReportCatalogEntry }) {
  const { t } = useI18n();
  const { slug } = useReportApi();
  const perms = useReportPermissions();
  const spec = REPORT_SOURCE_SPECS[entry.definition.source];
  const catalog = useFieldCatalog(spec.filter === 'company' ? 'company' : 'contact');
  const [state, setState] = useState<RunnerState>(() => runnerFromEntry(entry));
  const [filtersOpen, setFiltersOpen] = useState(false);
  const timezone = useReportTimeZone();
  const overrides = useMemo(
    () => runnerOverrides(state, catalog.kinds, { filterable: spec.filter !== null, timezone }),
    [state, catalog.kinds, spec.filter, timezone],
  );
  const applied = useStableDebounced(overrides);
  const run = useReportRun(entry.id, applied);
  const result = run.data;
  const filterCount = countConditions(overrides.filter);
  const name = reportName(t, entry);
  usePageChrome({ title: name });

  return (
    <PageBody className="grid gap-4 pt-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <Link
            to="/t/$tenant/reports"
            params={{ tenant: slug }}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3" aria-hidden /> {t('rep.back')}
          </Link>
          <h1 className="text-lg font-semibold">{name}</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">{reportDescription(t, entry)}</p>
          {result !== undefined ? (
            <RangeLine
              from={result.range.from}
              to={result.range.to}
              compare={result.compare_range}
            />
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void run.refetch()}
            aria-label={t('rep.toolbar.refresh')}
          >
            <RefreshCw
              className={run.isFetching ? 'size-3.5 animate-spin' : 'size-3.5'}
              aria-hidden
            />
          </Button>
          {perms.canCreate ? (
            entry.kind === 'custom' ? (
              <Button asChild variant="outline" size="sm">
                <Link
                  to="/t/$tenant/reports/builder/$customId"
                  params={{ tenant: slug, customId: entry.id }}
                >
                  <Pencil className="size-3.5" aria-hidden /> {t('rep.edit')}
                </Link>
              </Button>
            ) : (
              <Button asChild variant="outline" size="sm">
                <Link
                  to="/t/$tenant/reports/builder"
                  params={{ tenant: slug }}
                  search={{ from: entry.id }}
                >
                  <CopyPlus className="size-3.5" aria-hidden /> {t('rep.duplicate')}
                </Link>
              </Button>
            )
          ) : null}
          <CsvExportButton
            canExport={perms.canExport}
            href={exportCsvUrl(slug, entry.id, applied)}
            label={t('rep.toolbar.export')}
          />
        </div>
      </div>

      <ReportToolbar
        state={state}
        onChange={setState}
        spec={spec}
        options={result?.meta.options ?? {}}
        filterCount={filterCount}
        filtersOpen={filtersOpen}
        onToggleFilters={() => setFiltersOpen((open) => !open)}
      />

      {filtersOpen && spec.filter !== null ? (
        <Card className="py-3">
          <CardContent className="px-3">
            <QueryBuilder
              root={state.filter}
              onChange={(filter) => setState((s) => ({ ...s, filter }))}
              fields={catalog.fields}
              allowTags={spec.filter === 'contact'}
            />
          </CardContent>
        </Card>
      ) : null}

      <Card className="py-4">
        <CardContent className="grid gap-3 px-4" data-testid="report-result">
          {run.isPending ? (
            <Skeleton className="h-[320px]" />
          ) : run.isError ? (
            <p className="py-10 text-center text-sm text-destructive">
              {errorMessage(t, run.error)}
            </p>
          ) : result !== undefined ? (
            <ReportVisual result={result} chart={state.chart} />
          ) : null}
        </CardContent>
      </Card>

      {result !== undefined &&
      state.chart !== 'table' &&
      result.dimension !== null &&
      result.rows.length > 0 ? (
        <Card className="py-2">
          <CardContent className="px-2">
            <ReportTable result={result} measures={result.measures.map((m) => m.key)} />
          </CardContent>
        </Card>
      ) : null}

      {result !== undefined ? (
        <div className="grid gap-1 text-xs text-muted-foreground">
          {result.meta.truncated ? (
            <p>{t('rep.result.truncated', { count: result.rows.length })}</p>
          ) : null}
          {result.meta.currencies.length > 0 && result.currency !== null ? (
            <p>
              {t('rep.result.otherCurrencies', {
                currency: result.currency,
                list: result.meta.currencies.join(', '),
              })}
            </p>
          ) : null}
          {result.meta.notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </div>
      ) : null}
    </PageBody>
  );
}

export function ReportRunnerPage() {
  const { t } = useI18n();
  const { reportId } = useParams({ strict: false });
  const entry = useReportEntry(reportId ?? '');
  if (entry.isPending)
    return (
      <PageBody className="grid gap-4 pt-4">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-[360px]" />
      </PageBody>
    );
  if (entry.isError)
    return (
      <PageBody className="pt-10 text-center text-sm text-muted-foreground">
        {errorMessage(t, entry.error)}
      </PageBody>
    );
  return <Runner key={entry.data.id} entry={entry.data} />;
}
