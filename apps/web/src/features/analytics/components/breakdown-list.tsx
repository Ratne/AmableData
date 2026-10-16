import type { AnalyticsBreakdownDimension, AnalyticsBreakdownRow } from '@amable/api-types';
import { ATTRIBUTION_DIMENSIONS } from '@amable/api-types';
import { cn } from '@amable/ui';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { Maximize2 } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useI18n } from '../../../i18n';
import { useBreakdown, useOverview } from '../api';
import { countryName } from '../lib/countries';
import { useFormatters } from '../lib/format';
import { dimensionLabel } from '../lib/labels';
import { isFilterDimension } from '../lib/query-state';
import { useReportScope } from './scope';
import { EmptyNote, ErrorState, Flag, ListSkeleton } from './ui';

const PATH_DIMENSIONS = new Set<AnalyticsBreakdownDimension>(['page', 'entry_page', 'exit_page']);

export function isAttributed(dimension: AnalyticsBreakdownDimension): boolean {
  return (ATTRIBUTION_DIMENSIONS as readonly string[]).includes(dimension);
}

function RowLabel({
  dimension,
  value,
}: {
  dimension: AnalyticsBreakdownDimension;
  value: string | null;
}) {
  const { t, locale } = useI18n();
  if (value === null || value === '')
    return <span className="italic text-muted-foreground">{t('analytics.breakdown.none')}</span>;
  if (dimension === 'country')
    return (
      <span className="flex min-w-0 items-center gap-2">
        <Flag code={value} />
        <span className="truncate">{countryName(value, locale)}</span>
      </span>
    );
  if (PATH_DIMENSIONS.has(dimension))
    return <span className="truncate font-mono text-[12px]">{value}</span>;
  return <span className="truncate">{value}</span>;
}

interface Column {
  readonly id: string;
  readonly header: string;
  readonly cell: (row: AnalyticsBreakdownRow) => ReactNode;
}

function useColumns(dimension: AnalyticsBreakdownDimension, totalVisitors: number): Column[] {
  const { t } = useI18n();
  const f = useFormatters();
  const { currency } = useReportScope();
  if (dimension === 'bot' || dimension === 'bot_category')
    return [
      {
        id: 'hits',
        header: t('analytics.breakdown.hits'),
        cell: (row) => f.compact(row.hits ?? row.visitors),
      },
    ];
  if (dimension === 'goal')
    return [
      {
        id: 'visitors',
        header: t('analytics.breakdown.uniques'),
        cell: (row) => f.compact(row.visitors),
      },
      {
        id: 'completions',
        header: t('analytics.breakdown.completions'),
        cell: (row) => f.compact(row.completions ?? 0),
      },
      {
        id: 'cr',
        header: t('analytics.breakdown.conversion'),
        cell: (row) => f.percent(totalVisitors > 0 ? row.visitors / totalVisitors : 0, 1),
      },
    ];
  if (dimension === 'exit_link')
    return [
      {
        id: 'visitors',
        header: t('analytics.kpi.visitors'),
        cell: (row) => f.compact(row.visitors),
      },
      {
        id: 'hits',
        header: t('analytics.breakdown.clicks'),
        cell: (row) => f.compact(row.hits ?? row.pageviews ?? 0),
      },
    ];
  if (dimension === 'page')
    return [
      { id: 'visitors', header: t('analytics.kpi.visitors'), cell: (row) => f.compact(row.visitors) },
      {
        id: 'pageviews',
        header: t('analytics.breakdown.views'),
        cell: (row) => f.compact(row.pageviews ?? 0),
      },
    ];
  const columns: Column[] = [
    { id: 'visitors', header: t('analytics.kpi.visitors'), cell: (row) => f.compact(row.visitors) },
    {
      id: 'revenue',
      header: isAttributed(dimension)
        ? t('analytics.breakdown.attributedRevenue')
        : t('analytics.kpi.revenue'),
      cell: (row) => (row.revenue_minor ? f.moneyCompact(row.revenue_minor, currency) : '—'),
    },
  ];
  return columns;
}

export function BreakdownRows({
  dimension,
  rows,
  totalVisitors,
  scroll,
}: {
  dimension: AnalyticsBreakdownDimension;
  rows: readonly AnalyticsBreakdownRow[];
  totalVisitors: number;
  scroll?: boolean;
}) {
  const { t } = useI18n();
  const { onFilter } = useReportScope();
  const columns = useColumns(dimension, totalVisitors);
  const metric = (row: AnalyticsBreakdownRow) =>
    dimension === 'bot' || dimension === 'bot_category' ? (row.hits ?? row.visitors) : row.visitors;
  const max = Math.max(1, ...rows.map(metric));
  const filterable = isFilterDimension(dimension) && !!onFilter;

  return (
    <div className={cn('flex flex-col', scroll && 'max-h-[60vh] overflow-y-auto pr-1')}>
      <div className="flex items-center gap-3 px-2 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">{dimensionLabel(t, dimension)}</span>
        {columns.map((column) => (
          <span key={column.id} className="w-16 shrink-0 truncate text-right" title={column.header}>
            {column.header}
          </span>
        ))}
      </div>
      <ul className="flex flex-col gap-0.5">
        {rows.map((row, index) => {
          const clickable = filterable && row.value !== null && row.value !== '';
          const content = (
            <>
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 rounded-md bg-primary/[0.09] transition-[width] duration-500 ease-out group-hover:bg-primary/[0.14] dark:bg-primary/[0.16]"
                style={{ width: `${Math.max(1.5, (metric(row) / max) * 100)}%` }}
              />
              <span className="relative flex min-w-0 flex-1 items-center text-[13px] text-foreground">
                <RowLabel dimension={dimension} value={row.value} />
              </span>
              {columns.map((column) => (
                <span
                  key={column.id}
                  className="relative w-16 shrink-0 text-right text-[12.5px] tabular-nums text-foreground/85"
                >
                  {column.cell(row)}
                </span>
              ))}
            </>
          );
          return (
            <li key={`${row.value ?? '∅'}-${index}`}>
              {clickable ? (
                <button
                  type="button"
                  title={t('analytics.breakdown.filterBy', { value: row.value ?? '' })}
                  onClick={() => {
                    if (isFilterDimension(dimension))
                      onFilter?.({ dimension, op: 'is', value: row.value ?? '' });
                  }}
                  className="group relative flex h-8 w-full items-center gap-3 rounded-md px-2 text-left focus-visible:outline-2 focus-visible:outline-ring"
                >
                  {content}
                </button>
              ) : (
                <div className="group relative flex h-8 items-center gap-3 rounded-md px-2">
                  {content}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Breakdown of one dimension with proportional bars; rows add an `is` filter on click. */
export function BreakdownList({
  dimension,
  limit = 8,
  allowExpand = true,
}: {
  dimension: AnalyticsBreakdownDimension;
  limit?: number;
  allowExpand?: boolean;
}) {
  const { t } = useI18n();
  const { source, query, model } = useReportScope();
  const attributedModel = isAttributed(dimension) ? model : undefined;
  const breakdown = useBreakdown(source, query, dimension, { model: attributedModel, limit });
  const overview = useOverview(source, query);
  const [expanded, setExpanded] = useState(false);
  const total = overview.data?.visitors ?? 0;

  if (breakdown.error) return <ErrorState error={breakdown.error} compact />;
  if (!breakdown.data) return <ListSkeleton rows={Math.min(limit, 6)} />;
  const rows = breakdown.data.rows;
  if (rows.length === 0) return <EmptyNote>{t('analytics.breakdown.empty')}</EmptyNote>;

  return (
    <div className="flex flex-col">
      <BreakdownRows dimension={dimension} rows={rows} totalVisitors={total} />
      {allowExpand && rows.length >= limit ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-2 inline-flex items-center gap-1.5 self-center rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground"
        >
          <Maximize2 className="size-3" aria-hidden />
          {t('analytics.breakdown.details')}
        </button>
      ) : null}
      {expanded ? (
        <BreakdownDialog dimension={dimension} onClose={() => setExpanded(false)} />
      ) : null}
    </div>
  );
}

function BreakdownDialog({
  dimension,
  onClose,
}: {
  dimension: AnalyticsBreakdownDimension;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { source, query, model } = useReportScope();
  const breakdown = useBreakdown(source, query, dimension, {
    model: isAttributed(dimension) ? model : undefined,
    limit: 200,
  });
  const overview = useOverview(source, query);
  const [needle, setNeedle] = useState('');
  const rows = useMemo(() => {
    const all = breakdown.data?.rows ?? [];
    const q = needle.trim().toLowerCase();
    return q ? all.filter((row) => (row.value ?? '').toLowerCase().includes(q)) : all;
  }, [breakdown.data, needle]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{dimensionLabel(t, dimension)}</DialogTitle>
          <DialogDescription>{t('analytics.breakdown.detailsHint')}</DialogDescription>
        </DialogHeader>
        <Input
          value={needle}
          onChange={(event) => setNeedle(event.target.value)}
          placeholder={t('analytics.breakdown.search')}
          aria-label={t('analytics.breakdown.search')}
        />
        {breakdown.error ? (
          <ErrorState error={breakdown.error} />
        ) : !breakdown.data ? (
          <ListSkeleton rows={8} />
        ) : (
          <BreakdownRows
            dimension={dimension}
            rows={rows}
            totalVisitors={overview.data?.visitors ?? 0}
            scroll
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
