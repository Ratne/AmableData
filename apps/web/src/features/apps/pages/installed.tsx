import { PageBody, PageToolbar, toast, usePageChrome } from '@amable/ui';
import { Alert, AlertDescription, AlertTitle } from '@amable/ui/ui/alert';
import { Button } from '@amable/ui/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@amable/ui/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@amable/ui/ui/dialog';
import { RadioGroup, RadioGroupItem } from '@amable/ui/ui/radio-group';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@amable/ui/ui/table';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, KeyRound, Pause, Play, Settings, ShieldCheck, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../../../i18n';
import { isStepUpRequired } from '../../../lib/step-up';
import { apiErrorCode, useTenantAccess } from '../../developers/api';
import { formatDateTime } from '../../developers/components';
import { appKeys, text, useAppsApi, type AppInstallView } from '../api';
import { AppIcon, ScopeList, StatusPill, useAppLabels, VerifiedBadge } from '../components';

function useInstallAction<T>(fn: (id: string) => Promise<T>, success: string) {
  const { slug } = useAppsApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['apps', slug] });
      toast.success(success);
    },
    onError: (error) => {
      if (!isStepUpRequired(error)) toast.error(apiErrorCode(error));
    },
  });
}

function Health({ install }: { install: AppInstallView }) {
  const { t, locale } = useI18n();
  const { slug, api } = useAppsApi();
  const detail = useQuery({ queryKey: appKeys.install(slug, install.id), queryFn: () => api.install(install.id) });
  const events = useQuery({ queryKey: appKeys.events(slug, install.id), queryFn: () => api.events(install.id) });
  const labels = useAppLabels();
  const health = detail.data?.health;
  if (health === undefined) return <p className="text-sm">{t('common.loading')}</p>;
  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        {health.totals.length === 0 ? <p className="col-span-full text-sm">{t('apps.health.none')}</p> : null}
        {health.totals.map((row) => (
          <div key={row.kind} className="rounded-lg border border-border p-2">
            <div className="text-xs text-(--obsidian-dashboard-shell-text-subtle)">{labels.metric(row.kind)}</div>
            <div className="font-medium">{t('apps.health.calls', { calls: row.calls, errors: row.errors })}</div>
            <div className="text-xs">{t('apps.health.avg', { ms: row.avg_ms })}</div>
          </div>
        ))}
      </div>
      <p className="text-xs text-(--obsidian-dashboard-shell-text-subtle)">
        {t('apps.health.deliveries', { queued: health.queued_deliveries, failed: health.failed_deliveries })} ·{' '}
        {t('apps.health.lastSuccess', { at: formatDateTime(locale, health.last_success_at) })} ·{' '}
        {t('apps.health.lastFailure', { at: formatDateTime(locale, health.last_failure_at) })}
      </p>
      {(events.data?.data.length ?? 0) > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>#</TableHead>
              <TableHead>{t('apps.events.type')}</TableHead>
              <TableHead>{t('apps.events.at')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.data!.data.slice(-20).reverse().map((e) => (
              <TableRow key={e.sequence}>
                <TableCell className="font-mono text-xs">{e.sequence}</TableCell>
                <TableCell className="font-mono text-xs">{e.type}</TableCell>
                <TableCell className="text-xs">{formatDateTime(locale, e.created_at)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
    </div>
  );
}

function InstallCard({ install, onUninstall }: { install: AppInstallView; onUninstall: () => void }) {
  const { t, locale } = useI18n();
  const { slug, api } = useAppsApi();
  const access = useTenantAccess();
  const [showHealth, setShowHealth] = useState(false);
  const settingsScreens = (install.manifest.extensions.ui ?? []).filter((ui) => ui.slot === 'app.settings');
  const approve = useInstallAction(api.approveScopes, t('apps.installed.approved'));
  const pause = useInstallAction(api.pause, t('apps.installed.pausedToast'));
  const resume = useInstallAction(api.resume, t('apps.installed.resumedToast'));
  const rotate = useInstallAction(api.rotateSecret, t('apps.installed.rotated'));
  const manage = access.can('apps:manage');
  const labels = useAppLabels();
  const reason = install.status_reason === null ? null : labels.reason(install.status_reason);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start gap-3 space-y-0">
        <AppIcon manifest={install.manifest} />
        <div className="grid min-w-0 flex-1 gap-1">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            {install.manifest.name}
            <StatusPill status={install.status} />
            <VerifiedBadge verified={install.verified} />
          </CardTitle>
          <p className="text-sm text-(--obsidian-dashboard-shell-text-subtle)">{text(install.manifest.tagline, locale)}</p>
          <p className="text-xs text-(--obsidian-dashboard-shell-text-subtle)">
            {t('apps.installed.since', { at: formatDateTime(locale, install.activated_at ?? install.created_at) })}
            {install.manifest.version !== undefined ? ` · ${t('apps.version', { version: install.manifest.version })}` : null}
            {' · API '}
            {install.api_version}
          </p>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3">
        {reason !== null && install.status !== 'active' ? <p className="text-sm">{reason}</p> : null}
        {install.status === 'uninstalling' && install.cleanup_until !== null ? (
          <p className="text-sm">
            {t(install.keep_data === true ? 'apps.installed.cleanupKeep' : 'apps.installed.cleanupDelete', {
              at: formatDateTime(locale, install.cleanup_until),
            })}
          </p>
        ) : null}
        {install.status === 'pending' ? <p className="text-sm">{t('apps.installed.pending')}</p> : null}
        {install.pending_scopes.length > 0 ? (
          <Alert>
            <ShieldCheck className="size-4" />
            <AlertTitle>{t('apps.installed.pendingScopes')}</AlertTitle>
            <AlertDescription className="grid gap-2">
              <ScopeList scopes={install.pending_scopes} sensitive={install.manifest.sensitive_scopes} />
              {manage ? (
                <div>
                  <Button size="sm" disabled={approve.isPending} onClick={() => approve.mutate(install.id)}>
                    {t('apps.installed.approve')}
                  </Button>
                </div>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}
        <details>
          <summary className="cursor-pointer text-sm font-medium">{t('apps.permissions')}</summary>
          <div className="pt-2">
            <ScopeList scopes={install.scopes} sensitive={install.manifest.sensitive_scopes} />
          </div>
        </details>
        {manage ? (
          <div className="flex flex-wrap gap-2">
            {install.status === 'active'
              ? settingsScreens.map((ui) => (
                  <Button key={ui.key} variant="outline" size="sm" asChild>
                    <Link to="/t/$tenant/apps/$appId/$screenKey" params={{ tenant: slug, appId: install.app_id, screenKey: ui.key }}>
                      <Settings className="size-4" />
                      {text(ui.title, locale)}
                    </Link>
                  </Button>
                ))
              : null}
            <Button variant="outline" size="sm" onClick={() => setShowHealth((v) => !v)}>
              {t('apps.health.title')}
            </Button>
            {install.status === 'active' ? (
              <Button variant="outline" size="sm" disabled={pause.isPending} onClick={() => pause.mutate(install.id)}>
                <Pause className="size-4" />
                {t('apps.installed.pause')}
              </Button>
            ) : null}
            {install.status === 'paused' ? (
              <Button variant="outline" size="sm" disabled={resume.isPending} onClick={() => resume.mutate(install.id)}>
                <Play className="size-4" />
                {t('apps.installed.resume')}
              </Button>
            ) : null}
            {install.status === 'active' || install.status === 'paused' ? (
              <Button
                variant="outline"
                size="sm"
                disabled={rotate.isPending}
                onClick={() => {
                  if (window.confirm(t('apps.installed.rotateConfirm'))) rotate.mutate(install.id);
                }}
              >
                <KeyRound className="size-4" />
                {t('apps.installed.rotate')}
              </Button>
            ) : null}
            {install.status !== 'uninstalling' ? (
              <Button variant="destructive" size="sm" onClick={onUninstall}>
                <Trash2 className="size-4" />
                {t('apps.installed.uninstall')}
              </Button>
            ) : null}
          </div>
        ) : null}
        {showHealth ? <Health install={install} /> : null}
      </CardContent>
    </Card>
  );
}

/** Settings → Apps → Installed. */
export function InstalledAppsPage() {
  const { t } = useI18n();
  const { slug, api } = useAppsApi();
  usePageChrome({ title: t('apps.installed.title') });
  const installs = useQuery({ queryKey: appKeys.installs(slug), queryFn: api.installs });
  const [target, setTarget] = useState<AppInstallView | null>(null);
  const [keep, setKeep] = useState<'keep' | 'delete'>('keep');
  const uninstall = useInstallAction((id: string) => api.uninstall(id, keep === 'keep'), t('apps.installed.uninstalled'));
  const rows = installs.data?.data ?? [];

  return (
    <>
      <PageToolbar
        filters={
          <Button variant="ghost" asChild>
            <Link to="/t/$tenant/settings/apps" params={{ tenant: slug }}>
              <ArrowLeft className="size-4" />
              {t('apps.title')}
            </Link>
          </Button>
        }
      />
      <PageBody className="grid max-w-4xl gap-4 pt-4">
        {installs.isPending ? <p className="text-sm">{t('common.loading')}</p> : null}
        {!installs.isPending && rows.length === 0 ? <p className="text-sm">{t('apps.installed.empty')}</p> : null}
        {rows.map((install) => (
          <InstallCard key={install.id} install={install} onUninstall={() => setTarget(install)} />
        ))}
      </PageBody>
      <Dialog open={target !== null} onOpenChange={(open) => (open ? undefined : setTarget(null))}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('apps.uninstall.title', { name: target?.manifest.name ?? '' })}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 text-sm">
            <p>{t('apps.uninstall.body')}</p>
            <RadioGroup value={keep} onValueChange={(v) => setKeep(v as 'keep' | 'delete')} className="grid gap-2">
              <label className="flex items-start gap-2">
                <RadioGroupItem value="keep" />
                <span>{t('apps.uninstall.keep')}</span>
              </label>
              <label className="flex items-start gap-2">
                <RadioGroupItem value="delete" />
                <span>{t('apps.uninstall.delete')}</span>
              </label>
            </RadioGroup>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={uninstall.isPending}
              onClick={() => {
                if (target !== null) uninstall.mutate(target.id, { onSuccess: () => setTarget(null) });
              }}
            >
              {t('apps.uninstall.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
