import { PageBody, PageToolbar, toast, usePageChrome } from '@amable/ui';
import { Alert, AlertDescription, AlertTitle } from '@amable/ui/ui/alert';
import { Badge } from '@amable/ui/ui/badge';
import { Button } from '@amable/ui/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@amable/ui/ui/card';
import { Checkbox } from '@amable/ui/ui/checkbox';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../../../i18n';
import { isStepUpRequired } from '../../../lib/step-up';
import { apiErrorCode, useTenantAccess } from '../../developers/api';
import { appKeys, authorizeParams, text, useAppsApi, type AppInstallView, type AppManifestView } from '../api';
import type { AppDetailSearch } from '../search';
import { AppIcon, ExtensionList, ScopeList, StatusPill, useAppLabels, VerifiedBadge } from '../components';

/** App page and consent screen (catalog app, or private app from `?manifest_url=`). */
export function AppDetailPage() {
  const { t, locale } = useI18n();
  const { slug, api } = useAppsApi();
  const { appId = '' } = useParams({ strict: false });
  const search = useSearch({ strict: false }) as AppDetailSearch;
  const access = useTenantAccess();
  const privateUrl = search.manifest_url;
  const listed = useQuery({
    queryKey: appKeys.app(slug, appId),
    queryFn: () => api.app(appId),
    enabled: privateUrl === undefined,
    retry: false,
  });
  const preview = useQuery({
    queryKey: ['apps', slug, 'preview', privateUrl ?? ''],
    queryFn: () => api.preview(privateUrl!),
    enabled: privateUrl !== undefined,
    retry: false,
  });
  const manifest: AppManifestView | undefined = privateUrl === undefined ? listed.data?.manifest : preview.data?.manifest;
  const install: AppInstallView | null = privateUrl === undefined ? (listed.data?.install ?? null) : null;
  usePageChrome({ title: manifest?.name ?? t('apps.title') });
  const [accepted, setAccepted] = useState(false);
  const labels = useAppLabels();

  const authorize = useMutation({
    mutationFn: () =>
      api.authorize({
        ...(privateUrl === undefined ? { app_id: appId } : { manifest_url: privateUrl }),
        ...authorizeParams(search as Record<string, unknown>),
      }),
    onSuccess: (result) => window.location.assign(result.redirect_url),
    onError: (error) => {
      if (!isStepUpRequired(error)) toast.error(t('apps.install.failed', { code: apiErrorCode(error) }));
    },
  });

  const error = privateUrl === undefined ? listed.error : preview.error;
  if (error !== null) {
    return <PageBody className="pt-4 text-sm">{t('apps.notFound', { code: apiErrorCode(error) })}</PageBody>;
  }
  if (manifest === undefined) return <PageBody className="pt-4 text-sm">{t('common.loading')}</PageBody>;

  const running = install !== null && ['active', 'paused', 'uninstalling', 'pending'].includes(install.status);
  const canInstall = access.can('apps:install') && (!running || install?.status === 'pending');

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
      <PageBody className="grid max-w-5xl gap-4 pt-4 lg:grid-cols-[1fr_22rem]">
        <div className="grid content-start gap-4">
          <div className="flex items-start gap-4">
            <AppIcon manifest={manifest} size={64} />
            <div className="grid gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold">{manifest.name}</h2>
                <VerifiedBadge verified={privateUrl === undefined} />
                {install !== null ? <StatusPill status={install.status} /> : null}
              </div>
              <p className="text-sm text-(--obsidian-dashboard-shell-text-subtle)">{text(manifest.tagline, locale)}</p>
              <p className="text-xs text-(--obsidian-dashboard-shell-text-subtle)">
                {t('apps.by', { developer: manifest.developer.name })}
                {manifest.version !== undefined ? ` · ${t('apps.version', { version: manifest.version })}` : null}
              </p>
            </div>
          </div>
          {privateUrl !== undefined ? (
            <Alert>
              <AlertTitle>{t('apps.private.warningTitle')}</AlertTitle>
              <AlertDescription>{t('apps.private.warningBody', { url: privateUrl })}</AlertDescription>
            </Alert>
          ) : null}
          <Card>
            <CardContent className="whitespace-pre-line pt-6 text-sm">{text(manifest.description, locale)}</CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('apps.adds')}</CardTitle>
            </CardHeader>
            <CardContent>
              <ExtensionList manifest={manifest} locale={locale} />
            </CardContent>
          </Card>
        </div>

        <div className="grid content-start gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('apps.permissions')}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              <ScopeList scopes={manifest.scopes} sensitive={manifest.sensitive_scopes} />
              {manifest.privacy.handles_personal_data ? (
                <p className="text-xs text-(--obsidian-dashboard-shell-text-subtle)">{t('apps.personalData')}</p>
              ) : null}
              {canInstall ? (
                <>
                  <label className="flex items-start gap-2 text-sm">
                    <Checkbox checked={accepted} onCheckedChange={(v) => setAccepted(v === true)} />
                    <span>{t('apps.install.consent', { name: manifest.name })}</span>
                  </label>
                  <Button disabled={!accepted || authorize.isPending} onClick={() => authorize.mutate()}>
                    {install?.status === 'pending' ? t('apps.install.retry') : t('apps.install.action')}
                  </Button>
                  <p className="text-xs text-(--obsidian-dashboard-shell-text-subtle)">{t('apps.install.redirect')}</p>
                </>
              ) : running ? (
                <Button variant="outline" asChild>
                  <Link to="/t/$tenant/settings/apps/installed" params={{ tenant: slug }}>
                    {t('apps.install.manage')}
                  </Link>
                </Button>
              ) : null}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="grid gap-2 pt-6 text-sm">
              <div className="flex items-center justify-between">
                <span>{t('apps.pricing.label')}</span>
                <Badge variant="secondary">{labels.pricing(manifest.pricing.model)}</Badge>
              </div>
              {manifest.pricing.note !== undefined ? (
                <p className="text-xs text-(--obsidian-dashboard-shell-text-subtle)">{manifest.pricing.note}</p>
              ) : null}
              {[
                [t('apps.link.homepage'), manifest.homepage],
                [t('apps.link.support'), manifest.support_url],
                [t('apps.link.privacy'), manifest.privacy_url],
              ].map(([label, href]) =>
                href === undefined ? null : (
                  <a key={label} href={href} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 underline underline-offset-2">
                    {label}
                    <ExternalLink className="size-3" />
                  </a>
                ),
              )}
            </CardContent>
          </Card>
        </div>
      </PageBody>
    </>
  );
}
