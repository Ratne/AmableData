import type {
  PerformanceFilter,
  PerformanceGroupBy,
  PerformanceReport,
  PerformanceRow,
} from '@amable/api-types';
import { cn } from '@amable/ui';
import { Skeleton } from '@amable/ui/ui/skeleton';
import { ChevronRight } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useI18n } from '../../../i18n';
import { usePerformanceReport } from '../api-reports-ads';
import { ErrorState } from '../components/ui';
import { useFormatters } from '../lib/format';
import { columnLabel, groupLabel, rowLabel } from './labels';
import {
  changeTone,
  childDimension,
  formatMetric,
  metricChange,
  reportedDeltaTone,
  rowsByKey,
  type DeltaTone,
  type PerformanceColumn,
  type PerformanceRequest,
} from './model';

const toneClass: Record<DeltaTone, string> = {
  positive: 'text-success',
  negative: 'text-destructive',
  neutral: 'text-muted-foreground',
};

function MetricCell({
  column,
  row,
  previous,
  currency,
  strong,
}: {
  column: PerformanceColumn;
  row: PerformanceRow;
  previous: PerformanceRow | null | undefined;
  currency: string;
  strong?: boolean;
}) {
  const f = useFormatters();
  const value = row[column];
  const reported = column === 'reported_vs_revenue_minor';
  const change = previous === undefined ? null : metricChange(value, previous?.[column] ?? null);
  return (
    <td className="whitespace-nowrap px-3 py-1.5 text-right align-top tabular-nums">
      <span
        className={cn(
          strong && 'font-medium',
          reported && value !== null && cn('font-medium', toneClass[reportedDeltaTone(value)]),
        )}
      >
        {reported && value !== null && value > 0 ? '+' : ''}
        {formatMetric(f, column, value, currency)}
      </span>
      {previous !== undefined ? (
        <span className={cn('block text-[10.5px]', toneClass[changeTone(column, change)])}>
          {change === null
            ? '—'
            : `${change > 0 ? '+' : change < 0 ? '−' : ''}${f.percent(Math.abs(change), 0)}`}
        </span>
      ) : null}
    </td>
  );
}

function HeaderRow({
  groupBy,
  columns,
}: {
  groupBy: PerformanceGroupBy;
  columns: readonly PerformanceColumn[];
}) {
  const { t } = useI18n();
  return (
    <tr className="border-b border-foreground/[0.06] text-[11px] text-muted-foreground">
      <th scope="col" className="sticky left-0 bg-background/80 px-3 py-2 text-left font-medium">
        {groupLabel(t, groupBy)}
      </th>
      {columns.map((column) => (
        <th
          key={column}
          scope="col"
          className="whitespace-nowrap px-3 py-2 text-right font-medium"
          title={column === 'reported_vs_revenue_minor' ? t('analytics.performance.reportedHint') : undefined}
        >
          {columnLabel(t, column)}
        </th>
      ))}
    </tr>
  );
}

interface RowProps {
  readonly row: PerformanceRow;
  readonly groupBy: PerformanceGroupBy;
  readonly columns: readonly PerformanceColumn[];
  readonly currency: string;
  readonly previous: Map<string | null, PerformanceRow> | null;
  readonly depth?: number;
  readonly lead?: ReactNode;
  readonly onOpen?: () => void;
}

function DataRow({ row, groupBy, columns, currency, previous, depth = 0, lead, onOpen }: RowProps) {
  const { t } = useI18n();
  const name = rowLabel(t, groupBy, row);
  return (
    <tr className="border-b border-foreground/[0.04] hover:bg-foreground/[0.025]">
      <th
        scope="row"
        className="sticky left-0 max-w-72 bg-background/80 px-3 py-1.5 text-left align-top font-normal"
        style={{ paddingLeft: 12 + depth * 18 }}
      >
        <span className="flex min-w-0 items-center gap-1">
          {lead}
          {onOpen ? (
            <button
              type="button"
              onClick={onOpen}
              title={t('analytics.performance.drillOpen', { name })}
              className={cn(
                'min-w-0 truncate text-left hover:text-primary hover:underline',
                row.key === null && 'italic text-muted-foreground',
              )}
            >
              {name}
            </button>
          ) : (
            <span className={cn('min-w-0 truncate', row.key === null && 'italic text-muted-foreground')}>
              {name}
            </span>
          )}
        </span>
      </th>
      {columns.map((column) => (
        <MetricCell
          key={column}
          column={column}
          row={row}
          previous={previous ? (previous.get(row.key) ?? null) : undefined}
          currency={currency}
        />
      ))}
    </tr>
  );
}

function TotalsRow({
  report,
  previous,
  columns,
}: {
  report: PerformanceReport;
  previous: PerformanceReport | undefined;
  columns: readonly PerformanceColumn[];
}) {
  const { t } = useI18n();
  return (
    <tr className="border-t border-foreground/[0.1] bg-foreground/[0.03]">
      <th scope="row" className="sticky left-0 px-3 py-2 text-left font-medium">
        {t('analytics.performance.total')}
      </th>
      {columns.map((column) => (
        <MetricCell
          key={column}
          column={column}
          row={report.totals}
          previous={previous ? previous.totals : undefined}
          currency={report.currency}
          strong
        />
      ))}
    </tr>
  );
}

function TableShell({ children }: { children: ReactNode }) {
  return (
    <div className="-mx-4 overflow-x-auto">
      <table className="w-full min-w-max border-collapse text-[12.5px]">{children}</table>
    </div>
  );
}

/** Flat table: the name opens the next level of the hierarchy (drill-down). */
export function PerformanceTable({
  report,
  previous,
  columns,
  onDrill,
}: {
  report: PerformanceReport;
  previous: PerformanceReport | undefined;
  columns: readonly PerformanceColumn[];
  onDrill?: (row: PerformanceRow) => void;
}) {
  const prev = previous ? rowsByKey(previous.rows) : null;
  const canDrill = onDrill !== undefined && childDimension(report.group_by) !== null;
  return (
    <TableShell>
      <thead>
        <HeaderRow groupBy={report.group_by} columns={columns} />
      </thead>
      <tbody>
        {report.rows.map((row) => (
          <DataRow
            key={row.key ?? '\u0000'}
            row={row}
            groupBy={report.group_by}
            columns={columns}
            currency={report.currency}
            previous={prev}
            onOpen={canDrill && row.key !== null ? () => onDrill(row) : undefined}
          />
        ))}
      </tbody>
      <tfoot>
        <TotalsRow report={report} previous={previous} columns={columns} />
      </tfoot>
    </TableShell>
  );
}

function ExpandButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={open ? t('analytics.performance.collapse') : t('analytics.performance.expand')}
      className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
    >
      <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} aria-hidden />
    </button>
  );
}

interface NestedContext {
  readonly tenant: string;
  readonly request: PerformanceRequest;
  readonly previousRequest: PerformanceRequest | null;
  readonly columns: readonly PerformanceColumn[];
}

function NestedRow({
  ctx,
  row,
  groupBy,
  currency,
  previous,
  depth,
  filters,
}: {
  ctx: NestedContext;
  row: PerformanceRow;
  groupBy: PerformanceGroupBy;
  currency: string;
  previous: Map<string | null, PerformanceRow> | null;
  depth: number;
  filters: readonly PerformanceFilter[];
}) {
  const [open, setOpen] = useState(false);
  const child = childDimension(groupBy);
  const expandable = child !== null && row.key !== null;
  return (
    <>
      <DataRow
        row={row}
        groupBy={groupBy}
        columns={ctx.columns}
        currency={currency}
        previous={previous}
        depth={depth}
        lead={
          expandable ? (
            <ExpandButton open={open} onToggle={() => setOpen((v) => !v)} />
          ) : (
            <span className="size-5 shrink-0" />
          )
        }
      />
      {open && expandable ? (
        <NestedLevel
          ctx={ctx}
          groupBy={child}
          depth={depth + 1}
          filters={[...filters, { dimension: groupBy, value: row.key ?? '' }]}
        />
      ) : null}
    </>
  );
}

function NestedLevel({
  ctx,
  groupBy,
  depth,
  filters,
}: {
  ctx: NestedContext;
  groupBy: PerformanceGroupBy;
  depth: number;
  filters: readonly PerformanceFilter[];
}) {
  const request = { ...ctx.request, group_by: groupBy, filters };
  const report = usePerformanceReport(ctx.tenant, request);
  const previous = usePerformanceReport(
    ctx.tenant,
    ctx.previousRequest ? { ...ctx.previousRequest, group_by: groupBy, filters } : null,
    ctx.previousRequest !== null,
  );
  const span = ctx.columns.length + 1;
  if (report.error)
    return (
      <tr>
        <td colSpan={span}>
          <ErrorState error={report.error} compact />
        </td>
      </tr>
    );
  if (!report.data)
    return (
      <tr>
        <td colSpan={span} className="px-3 py-1.5" style={{ paddingLeft: 12 + depth * 18 }}>
          <Skeleton className="h-5 w-full" />
        </td>
      </tr>
    );
  const prev = ctx.previousRequest && previous.data ? rowsByKey(previous.data.rows) : null;
  return (
    <>
      {report.data.rows.map((row) => (
        <NestedRow
          key={row.key ?? '\u0000'}
          ctx={ctx}
          row={row}
          groupBy={groupBy}
          currency={report.data.currency}
          previous={prev}
          depth={depth}
          filters={filters}
        />
      ))}
    </>
  );
}

/** Tree table: each platform / campaign / adset expands in place (one query per opened row). */
export function PerformanceNestedTable({
  tenant,
  report,
  previous,
  request,
  previousRequest,
  columns,
}: {
  tenant: string;
  report: PerformanceReport;
  previous: PerformanceReport | undefined;
  request: PerformanceRequest;
  previousRequest: PerformanceRequest | null;
  columns: readonly PerformanceColumn[];
}) {
  const ctx: NestedContext = { tenant, request, previousRequest, columns };
  const prev = previous ? rowsByKey(previous.rows) : null;
  return (
    <TableShell>
      <thead>
        <HeaderRow groupBy={report.group_by} columns={columns} />
      </thead>
      <tbody>
        {report.rows.map((row) => (
          <NestedRow
            key={row.key ?? '\u0000'}
            ctx={ctx}
            row={row}
            groupBy={report.group_by}
            currency={report.currency}
            previous={prev}
            depth={0}
            filters={request.filters ?? []}
          />
        ))}
      </tbody>
      <tfoot>
        <TotalsRow report={report} previous={previous} columns={columns} />
      </tfoot>
    </TableShell>
  );
}
