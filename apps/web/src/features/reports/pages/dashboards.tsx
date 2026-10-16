import type { Dashboard } from '@amable/api-types/reports';
import { DashboardConfirmDialog, PageBody, PageToolbar, usePageChrome } from '@amable/ui';
import { Badge } from '@amable/ui/ui/badge';
import { Button } from '@amable/ui/ui/button';
import { Skeleton } from '@amable/ui/ui/skeleton';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft, Home, LayoutGrid, Lock, Plus, Trash2, Users } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../../../i18n';
import { useMe } from '../../../lib/api';
import { errorMessage } from '../../crm/api/hooks';
import {
  reportKeys,
  useDashboard,
  useDashboards,
  useReportApi,
  useReportMutation,
  useReportPermissions,
} from '../api/hooks';
import { DashboardSettingsDialog } from '../components/dashboard-settings-dialog';
import { DashboardView } from '../components/dashboard-view';

export function DashboardsListPage() {
  const { t } = useI18n();
  usePageChrome({ title: t('rep.dash.title') });
  const navigate = useNavigate();
  const { slug, api } = useReportApi();
  const perms = useReportPermissions();
  const me = useMe();
  const dashboards = useDashboards();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Dashboard | null>(null);
  const create = useReportMutation({
    mutationFn: (input: { name: string; shared: boolean; is_default: boolean }) =>
      api.createDashboard(input),
    invalidate: [reportKeys.dashboards(slug)],
    success: t('rep.dash.saved'),
    onSuccess: (created) => {
      setCreating(false);
      void navigate({
        to: '/t/$tenant/reports/dashboards/$dashboardId',
        params: { tenant: slug, dashboardId: created.id },
      });
    },
  });
  const remove = useReportMutation({
    mutationFn: (id: string) => api.deleteDashboard(id),
    invalidate: [reportKeys.dashboards(slug)],
    success: t('rep.dash.deleted'),
  });
  const canDelete = (d: Dashboard) =>
    perms.canCreate && (d.owner_id === me.data?.user.id || perms.canManageAll);

  return (
    <>
      <PageToolbar
        filters={<p className="text-sm text-muted-foreground">{t('rep.dash.subtitle')}</p>}
        actions={
          perms.canCreate ? (
            <Button size="sm" onClick={() => setCreating(true)} data-testid="dashboard-new">
              <Plus className="size-4" aria-hidden /> {t('rep.dash.new')}
            </Button>
          ) : null
        }
      />
      <PageBody>
        {dashboards.isPending ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
        ) : dashboards.isError ? (
          <p className="text-sm text-muted-foreground">{errorMessage(t, dashboards.error)}</p>
        ) : dashboards.data.length === 0 ? (
          <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
            {t('rep.dash.empty')}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {dashboards.data.map((d) => (
              <div
                key={d.id}
                className="group relative grid gap-2 rounded-lg border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-muted/40"
              >
                <Link
                  to="/t/$tenant/reports/dashboards/$dashboardId"
                  params={{ tenant: slug, dashboardId: d.id }}
                  className="absolute inset-0 rounded-lg"
                  aria-label={d.name}
                />
                <div className="flex items-center gap-2">
                  <LayoutGrid className="size-4 text-muted-foreground" aria-hidden />
                  <span className="flex-1 truncate font-medium">{d.name}</span>
                  {canDelete(d) ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="relative z-10 size-7 text-destructive opacity-0 group-hover:opacity-100"
                      aria-label={t('rep.delete')}
                      onClick={() => setDeleting(d)}
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                    </Button>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  {d.is_default ? (
                    <Badge variant="secondary" className="gap-1">
                      <Home className="size-3" aria-hidden /> {t('rep.dash.isDefault')}
                    </Badge>
                  ) : null}
                  <Badge variant="outline" className="gap-1">
                    {d.shared ? (
                      <Users className="size-3" aria-hidden />
                    ) : (
                      <Lock className="size-3" aria-hidden />
                    )}
                    {d.shared ? t('rep.shared') : t('rep.private')}
                  </Badge>
                  <span>{t('rep.dash.widgets', { count: d.widgets.length })}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </PageBody>
      <DashboardSettingsDialog
        open={creating}
        onOpenChange={setCreating}
        title={t('rep.dash.new')}
        initial={{ name: '', shared: false, is_default: false }}
        canSetDefault={perms.canManageAll}
        pending={create.isPending}
        onSubmit={(settings) => create.mutate(settings)}
      />
      <DashboardConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={t('rep.delete')}
        description={t('rep.dash.deleteConfirm', { name: deleting?.name ?? '' })}
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

export function DashboardDetailPage() {
  const { t } = useI18n();
  const { slug } = useReportApi();
  const { dashboardId } = useParams({ strict: false });
  const dashboard = useDashboard(dashboardId ?? '');
  usePageChrome({ title: dashboard.data?.name ?? t('rep.dash.title') });
  return (
    <PageBody className="pt-4">
      {dashboard.isPending ? (
        <Skeleton className="h-[480px]" />
      ) : dashboard.isError ? (
        <p className="pt-10 text-center text-sm text-muted-foreground">
          {errorMessage(t, dashboard.error)}
        </p>
      ) : (
        <DashboardView
          dashboard={dashboard.data}
          leading={
            <Button
              asChild
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={t('rep.dash.manage')}
            >
              <Link to="/t/$tenant/reports/dashboards" params={{ tenant: slug }}>
                <ArrowLeft className="size-4" aria-hidden />
              </Link>
            </Button>
          }
        />
      )}
    </PageBody>
  );
}
