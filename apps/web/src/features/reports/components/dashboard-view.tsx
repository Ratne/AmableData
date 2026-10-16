import type { Dashboard, DashboardWidget } from '@amable/api-types/reports';
import { toast } from '@amable/ui';
import { Badge } from '@amable/ui/ui/badge';
import { Button } from '@amable/ui/ui/button';
import { useNavigate } from '@tanstack/react-router';
import { Check, Copy, LayoutGrid, Plus, Settings2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../../../i18n';
import { useMe } from '../../../lib/api';
import {
  reportKeys,
  useReportApi,
  useReportCatalog,
  useReportMutation,
  useReportPermissions,
} from '../api/hooks';
import { parseWidgets, serializeWidgets } from '../lib/layout';
import { DashboardSettingsDialog, type DashboardSettings } from './dashboard-settings-dialog';
import { DashboardWidgetCard } from './dashboard-widget';
import { WidgetDialog } from './widget-dialog';
import { WidgetGrid } from './widget-grid';

export interface DashboardViewProps {
  readonly dashboard: Dashboard;
  /** Extra header content (left side), e.g. a back link. */
  readonly leading?: ReactNode;
}

/** Widget dashboard with edit mode: drag / resize, add / edit / remove widgets, settings. */
export function DashboardView({ dashboard, leading }: DashboardViewProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { slug, api } = useReportApi();
  const perms = useReportPermissions();
  const me = useMe();
  const catalog = useReportCatalog();
  const entries = useMemo(() => catalog.data?.data ?? [], [catalog.data]);
  const [widgets, setWidgets] = useState<DashboardWidget[]>(() => parseWidgets(dashboard.widgets));
  const [editing, setEditing] = useState(false);
  const [widgetDialog, setWidgetDialog] = useState<{ widget: DashboardWidget | null } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const saved = useRef(JSON.stringify(serializeWidgets(widgets)));

  useEffect(() => {
    const next = parseWidgets(dashboard.widgets);
    saved.current = JSON.stringify(serializeWidgets(next));
    setWidgets(next);
  }, [dashboard.widgets]);

  const isOwner = dashboard.owner_id !== null && dashboard.owner_id === me.data?.user.id;
  const canEdit = !dashboard.builtin && perms.canCreate && (isOwner || perms.canManageAll);

  const persist = useReportMutation({
    mutationFn: (next: DashboardWidget[]) => api.updateDashboard(dashboard.id, { widgets: next }),
    invalidate: [reportKeys.dashboards(slug)],
    onError: () => {
      toast.error(t('rep.dash.saveFailed'));
      return true;
    },
  });
  const update = useReportMutation({
    mutationFn: (settings: DashboardSettings) => api.updateDashboard(dashboard.id, settings),
    invalidate: [reportKeys.dashboards(slug)],
    success: t('rep.dash.saved'),
    onSuccess: () => setSettingsOpen(false),
  });
  const copy = useReportMutation({
    mutationFn: (settings: DashboardSettings) =>
      api.createDashboard({ ...settings, widgets: serializeWidgets(widgets) }),
    invalidate: [reportKeys.dashboards(slug)],
    success: t('rep.dash.saved'),
    onSuccess: (created) => {
      setSettingsOpen(false);
      void navigate({
        to: '/t/$tenant/reports/dashboards/$dashboardId',
        params: { tenant: slug, dashboardId: created.id },
      });
    },
  });

  const commit = (next: DashboardWidget[]) => {
    setWidgets(next);
    const body = serializeWidgets(next);
    const text = JSON.stringify(body);
    if (text === saved.current) return;
    saved.current = text;
    persist.mutate(body);
  };

  const entryOf = (reportId: string) => entries.find((e) => e.id === reportId);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {leading}
          <h1 className="truncate text-lg font-semibold">
            {dashboard.builtin ? t('rep.home.title') : dashboard.name}
          </h1>
          {dashboard.is_default ? (
            <Badge variant="secondary">{t('rep.dash.isDefault')}</Badge>
          ) : null}
          {dashboard.builtin ? <Badge variant="outline">{t('rep.dash.builtin')}</Badge> : null}
          {!dashboard.builtin ? (
            <Badge variant="outline">{dashboard.shared ? t('rep.shared') : t('rep.private')}</Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {canEdit && editing ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setWidgetDialog({ widget: null })}
                data-testid="widget-add"
              >
                <Plus className="size-3.5" aria-hidden /> {t('rep.dash.addWidget')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
                <Settings2 className="size-3.5" aria-hidden /> {t('rep.dash.settings')}
              </Button>
              <Button size="sm" onClick={() => setEditing(false)} data-testid="dashboard-done">
                <Check className="size-3.5" aria-hidden /> {t('rep.dash.done')}
              </Button>
            </>
          ) : canEdit ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditing(true)}
              data-testid="dashboard-edit"
            >
              <LayoutGrid className="size-3.5" aria-hidden /> {t('rep.dash.edit')}
            </Button>
          ) : dashboard.builtin && perms.canCreate ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSettingsOpen(true)}
              title={t('rep.dash.customizeHint')}
              data-testid="dashboard-customize"
            >
              <Copy className="size-3.5" aria-hidden /> {t('rep.dash.customize')}
            </Button>
          ) : null}
        </div>
      </div>

      {widgets.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          {t('rep.dash.emptyWidgets')}
          {canEdit ? (
            <div className="mt-3">
              <Button
                size="sm"
                onClick={() => {
                  setEditing(true);
                  setWidgetDialog({ widget: null });
                }}
              >
                <Plus className="size-3.5" aria-hidden /> {t('rep.dash.addWidget')}
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <WidgetGrid
          widgets={widgets}
          editing={editing}
          onLayoutChange={commit}
          renderWidget={(widget) => (
            <DashboardWidgetCard
              widget={widget}
              entry={entryOf(widget.report_id)}
              editing={editing}
              onEdit={() => setWidgetDialog({ widget })}
              onRemove={() => commit(widgets.filter((w) => w.id !== widget.id))}
            />
          )}
        />
      )}

      <WidgetDialog
        open={widgetDialog !== null}
        onOpenChange={(open) => {
          if (!open) setWidgetDialog(null);
        }}
        widget={widgetDialog?.widget ?? null}
        others={widgets}
        catalog={entries}
        onSubmit={(widget) => {
          const exists = widgets.some((w) => w.id === widget.id);
          commit(
            exists ? widgets.map((w) => (w.id === widget.id ? widget : w)) : [...widgets, widget],
          );
          setWidgetDialog(null);
        }}
      />

      <DashboardSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        title={dashboard.builtin ? t('rep.dash.customize') : t('rep.dash.settings')}
        initial={{
          name: dashboard.builtin ? t('rep.home.title') : dashboard.name,
          shared: dashboard.builtin ? perms.canManageAll : dashboard.shared,
          is_default: dashboard.builtin ? perms.canManageAll : dashboard.is_default,
        }}
        canSetDefault={perms.canManageAll}
        pending={update.isPending || copy.isPending}
        onSubmit={(settings) =>
          dashboard.builtin ? copy.mutate(settings) : update.mutate(settings)
        }
      />
    </div>
  );
}
