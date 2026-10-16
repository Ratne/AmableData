import type { ReportCatalogEntry } from '@amable/api-types/reports';
import { DashboardConfirmDialog, PageBody, PageToolbar, usePageChrome } from '@amable/ui';
import { Badge } from '@amable/ui/ui/badge';
import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { Skeleton } from '@amable/ui/ui/skeleton';
import { Link, useNavigate } from '@tanstack/react-router';
import { Lock, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useI18n } from '../../../i18n';
import {
  useReportApi,
  useReportCatalog,
  useReportMutation,
  useReportPermissions,
} from '../api/hooks';
import { CHART_ICONS } from '../components/report-toolbar';
import { groupByArea } from '../lib/areas';
import { dynamicLabel, reportDescription, reportName } from '../lib/labels';

function ReportCard({
  entry,
  slug,
  canEdit,
  onDelete,
}: {
  entry: ReportCatalogEntry;
  slug: string;
  canEdit: boolean;
  onDelete: (entry: ReportCatalogEntry) => void;
}) {
  const { t } = useI18n();
  const Icon = CHART_ICONS[entry.chart];
  const name = reportName(t, entry);
  return (
    <div className="group relative flex min-h-24 flex-col gap-1 rounded-lg border bg-card p-3 transition-colors hover:border-primary/40 hover:bg-muted/40">
      <Link
        to="/t/$tenant/reports/$reportId"
        params={{ tenant: slug, reportId: entry.id }}
        className="absolute inset-0 rounded-lg focus-visible:outline-2 focus-visible:outline-ring"
        aria-label={name}
      />
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="flex-1 text-sm font-medium leading-snug">{name}</span>
        {entry.kind === 'custom' && entry.shared === false ? (
          <Lock className="size-3.5 text-muted-foreground" aria-label={t('rep.private')} />
        ) : null}
      </div>
      <p className="line-clamp-2 text-xs text-muted-foreground">{reportDescription(t, entry)}</p>
      {entry.kind === 'custom' && canEdit ? (
        <div className="relative z-10 mt-auto flex justify-end gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <Button asChild variant="ghost" size="icon" className="size-7" aria-label={t('rep.edit')}>
            <Link
              to="/t/$tenant/reports/builder/$customId"
              params={{ tenant: slug, customId: entry.id }}
            >
              <Pencil className="size-3.5" aria-hidden />
            </Link>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-destructive"
            aria-label={t('rep.delete')}
            onClick={() => onDelete(entry)}
          >
            <Trash2 className="size-3.5" aria-hidden />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function ReportsCatalogPage() {
  const { t } = useI18n();
  usePageChrome({ title: t('rep.title') });
  const navigate = useNavigate();
  const { slug, api } = useReportApi();
  const perms = useReportPermissions();
  const catalog = useReportCatalog();
  const [query, setQuery] = useState('');
  const [deleting, setDeleting] = useState<ReportCatalogEntry | null>(null);
  const remove = useReportMutation({
    mutationFn: (id: string) => api.deleteCustomReport(id),
    success: t('rep.deleted'),
  });

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const entries = (catalog.data?.data ?? []).filter((entry) => {
      if (needle === '') return true;
      return `${reportName(t, entry)} ${reportDescription(t, entry)}`
        .toLowerCase()
        .includes(needle);
    });
    return groupByArea(entries);
  }, [catalog.data, query, t]);

  return (
    <>
      <PageToolbar
        filters={
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-2 size-4 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('rep.search')}
              aria-label={t('rep.search')}
              className="h-8 w-64 pl-8"
            />
          </div>
        }
        actions={
          perms.canCreate ? (
            <Button
              size="sm"
              onClick={() =>
                void navigate({ to: '/t/$tenant/reports/builder', params: { tenant: slug } })
              }
            >
              <Plus className="size-4" aria-hidden /> {t('rep.newReport')}
            </Button>
          ) : null
        }
      />
      <PageBody className="grid gap-6">
        {catalog.isPending ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
        ) : catalog.isError ? (
          <p className="text-sm text-muted-foreground">{t('rep.forbidden')}</p>
        ) : groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('rep.empty')}</p>
        ) : (
          groups.map((group) => (
            <section key={group.area} className="grid gap-2" aria-labelledby={`area-${group.area}`}>
              <h2
                id={`area-${group.area}`}
                className="flex items-center gap-2 text-sm font-semibold"
              >
                {dynamicLabel(t, `rep.area.${group.area}`, group.area)}
                <Badge variant="secondary" className="font-normal tabular-nums">
                  {group.entries.length}
                </Badge>
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {group.entries.map((entry) => (
                  <ReportCard
                    key={entry.id}
                    entry={entry}
                    slug={slug}
                    canEdit={perms.canCreate}
                    onDelete={setDeleting}
                  />
                ))}
              </div>
            </section>
          ))
        )}
      </PageBody>
      <DashboardConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={t('rep.delete')}
        description={t('rep.deleteConfirm', { name: deleting?.name ?? '' })}
        confirmLabel={t('rep.delete')}
        cancelLabel={t('rep.cancel')}
        tone="danger"
        onConfirm={() => {
          if (deleting !== null) remove.mutate(deleting.id);
          setDeleting(null);
        }}
      />
    </>
  );
}
