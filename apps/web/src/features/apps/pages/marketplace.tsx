import { DashboardButton, DashboardFilterMenu, PageBody, PageToolbar, toast, usePageChrome } from '@amable/ui';
import { Alert, AlertDescription, AlertTitle } from '@amable/ui/ui/alert';
import { Button } from '@amable/ui/ui/button';
import { Card, CardContent } from '@amable/ui/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { Label } from '@amable/ui/ui/label';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { LayoutGrid, Link2, RefreshCw, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useI18n } from '../../../i18n';
import { apiErrorCode, useTenantAccess } from '../../developers/api';
import { appKeys, text, useAppsApi } from '../api';
import { AppIcon, StatusPill, useAppLabels } from '../components';

/** Settings → Apps: the marketplace catalog synced from the signed index. */
export function MarketplacePage() {
  const { t, locale } = useI18n();
  const { slug, api } = useAppsApi();
  const access = useTenantAccess();
  const navigate = useNavigate();
  const client = useQueryClient();
  const labels = useAppLabels();
  usePageChrome({ title: t('apps.title') });
  const catalog = useQuery({ queryKey: appKeys.catalog(slug), queryFn: api.catalog });
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [privateOpen, setPrivateOpen] = useState(false);
  const [manifestUrl, setManifestUrl] = useState('');

  const refresh = useMutation({
    mutationFn: api.refresh,
    onSuccess: () => client.invalidateQueries({ queryKey: appKeys.catalog(slug) }),
    onError: (error) => toast.error(apiErrorCode(error)),
  });
  const preview = useMutation({
    mutationFn: () => api.preview(manifestUrl.trim()),
    onSuccess: (result) => {
      setPrivateOpen(false);
      void navigate({
        to: '/t/$tenant/settings/apps/$appId',
        params: { tenant: slug, appId: result.manifest.id },
        search: { manifest_url: manifestUrl.trim() },
      });
    },
    onError: (error) => toast.error(t('apps.private.invalid', { code: apiErrorCode(error) })),
  });

  const items = catalog.data?.data ?? [];
  const categories = useMemo(() => [...new Set(items.flatMap((i) => i.manifest.categories))].sort(), [items]);
  const needle = query.trim().toLowerCase();
  const visible = items.filter(
    (item) =>
      (category === '' || item.manifest.categories.includes(category)) &&
      (needle === '' ||
        item.manifest.name.toLowerCase().includes(needle) ||
        text(item.manifest.tagline, locale).toLowerCase().includes(needle)),
  );

  return (
    <>
      <PageToolbar
        filters={
          <>
            <div className="relative">
              <Search className="absolute top-1/2 left-2 size-4 -translate-y-1/2 text-(--obsidian-dashboard-shell-text-subtle)" />
              <Input className="w-64 pl-8" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('apps.search')} />
            </div>
            {categories.length > 0 ? (
              <DashboardFilterMenu
                label={t('apps.category')}
                options={[{ value: '', label: t('apps.allCategories') }, ...categories.map((c) => ({ value: c, label: labels.category(c) }))]}
                value={category}
                onValueChange={setCategory}
              />
            ) : null}
          </>
        }
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/t/$tenant/settings/apps/installed" params={{ tenant: slug }}>
                <LayoutGrid className="size-4" />
                {t('apps.installed.title')}
              </Link>
            </Button>
            {access.can('apps:manage') ? (
              <Button variant="outline" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
                <RefreshCw className="size-4" />
                {t('apps.refresh')}
              </Button>
            ) : null}
            {access.can('apps:install') ? (
              <DashboardButton variant="primary" onClick={() => setPrivateOpen(true)}>
                <Link2 className="size-4" />
                {t('apps.private.action')}
              </DashboardButton>
            ) : null}
          </>
        }
      />
      <PageBody className="grid max-w-6xl gap-4 pt-4">
        <p className="text-sm text-(--obsidian-dashboard-shell-text-subtle)">{t('apps.intro')}</p>
        {catalog.data !== undefined && !catalog.data.enabled ? (
          <Alert>
            <AlertTitle>{t('apps.disabled.title')}</AlertTitle>
            <AlertDescription>{t('apps.disabled.body')}</AlertDescription>
          </Alert>
        ) : null}
        {catalog.data?.sync_error ? (
          <Alert variant="destructive">
            <AlertTitle>{t('apps.syncError')}</AlertTitle>
            <AlertDescription>{catalog.data.sync_error}</AlertDescription>
          </Alert>
        ) : null}
        {catalog.isPending ? <p className="text-sm">{t('common.loading')}</p> : null}
        {!catalog.isPending && visible.length === 0 && catalog.data?.enabled !== false ? (
          <p className="text-sm">{t('apps.empty')}</p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((item) => (
            <Link
              key={item.manifest.id}
              to="/t/$tenant/settings/apps/$appId"
              params={{ tenant: slug, appId: item.manifest.id }}
              className="rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <Card className="h-full transition-colors hover:border-(--obsidian-dashboard-shell-border-strong,#999)">
                <CardContent className="flex gap-3 p-4">
                  <AppIcon manifest={item.manifest} />
                  <div className="grid min-w-0 gap-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{item.manifest.name}</span>
                      {item.install !== null ? <StatusPill status={item.install.status} /> : null}
                    </div>
                    <p className="line-clamp-2 text-sm text-(--obsidian-dashboard-shell-text-subtle)">
                      {text(item.manifest.tagline, locale)}
                    </p>
                    <p className="text-xs text-(--obsidian-dashboard-shell-text-subtle)">
                      {item.manifest.developer.name} · {labels.pricing(item.manifest.pricing.model)}
                    </p>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </PageBody>

      <Dialog open={privateOpen} onOpenChange={setPrivateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('apps.private.title')}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <p className="text-sm">{t('apps.private.body')}</p>
            <div className="grid gap-1.5">
              <Label htmlFor="manifest-url">{t('apps.private.url')}</Label>
              <Input
                id="manifest-url"
                value={manifestUrl}
                onChange={(e) => setManifestUrl(e.target.value)}
                placeholder="https://my-app.example.com/amable-app.json"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPrivateOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button disabled={manifestUrl.trim() === '' || preview.isPending} onClick={() => preview.mutate()}>
              {t('apps.private.continue')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
