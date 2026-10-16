import type { DashboardWidget, ReportCatalogEntry } from '@amable/api-types/reports';
import { cn } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Skeleton } from '@amable/ui/ui/skeleton';
import { Link } from '@tanstack/react-router';
import { ExternalLink, Pencil, Trash2 } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { useReportApi, useReportRun } from '../api/hooks';
import { measureLabel, reportName } from '../lib/labels';
import { ReportVisual } from './report-visual';

export interface DashboardWidgetCardProps {
  readonly widget: DashboardWidget;
  readonly entry: ReportCatalogEntry | undefined;
  readonly editing: boolean;
  readonly onEdit?: () => void;
  readonly onRemove?: () => void;
}

/** One widget: runs its report with the widget overrides and renders it at the cell size. */
export function DashboardWidgetCard({
  widget,
  entry,
  editing,
  onEdit,
  onRemove,
}: DashboardWidgetCardProps) {
  const { t } = useI18n();
  const { slug } = useReportApi();
  const run = useReportRun(widget.report_id, widget.overrides);
  const title =
    widget.title ??
    (entry !== undefined
      ? widget.type === 'kpi' &&
        widget.measures?.[0] !== undefined &&
        widget.measures[0] !== 'count'
        ? measureLabel(t, widget.measures[0])
        : reportName(t, entry)
      : widget.report_id);
  return (
    <div
      className="flex h-full flex-col overflow-hidden rounded-lg border bg-card"
      data-testid="dashboard-widget"
      data-widget-type={widget.type}
    >
      <div className={cn('flex items-center gap-1 border-b px-3 py-2', editing && 'pl-8')}>
        <span
          className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground"
          title={title}
        >
          {title}
        </span>
        {editing ? (
          <>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label={t('rep.widget.titleEdit')}
              onClick={onEdit}
            >
              <Pencil className="size-3" aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-destructive"
              aria-label={t('rep.widget.remove')}
              onClick={onRemove}
            >
              <Trash2 className="size-3" aria-hidden />
            </Button>
          </>
        ) : (
          <Button
            asChild
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={t('rep.widget.openReport')}
          >
            <Link
              to="/t/$tenant/reports/$reportId"
              params={{ tenant: slug, reportId: widget.report_id }}
            >
              <ExternalLink className="size-3" aria-hidden />
            </Link>
          </Button>
        )}
      </div>
      <div className={cn('min-h-0 flex-1 p-3', widget.type === 'table' && 'overflow-auto p-0')}>
        {run.isPending ? (
          <Skeleton className="h-full w-full" />
        ) : run.isError ? (
          <p className="flex h-full items-center justify-center text-xs text-muted-foreground">
            {t('rep.widget.error')}
          </p>
        ) : (
          <ReportVisual
            result={run.data}
            chart={widget.type}
            measures={widget.measures}
            fill
            maxRows={widget.type === 'table' ? (widget.overrides?.limit ?? 10) : undefined}
          />
        )}
      </div>
    </div>
  );
}
