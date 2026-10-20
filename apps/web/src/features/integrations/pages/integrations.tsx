import type { AddressLookupSettings } from '@amable/api-types/crm';
import { PageBody, usePageChrome } from '@amable/ui';
import { Badge } from '@amable/ui/ui/badge';
import { Button } from '@amable/ui/ui/button';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { MapPin, Store } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { AppIcon } from '../../apps/components';
import { SectionCard } from '../../../components/feature-kit';
import { PageState } from '../../commerce/components/common';
import { request } from '../../../lib/tenant-api';
import { useTenantSlug } from '../../crm/api/hooks';

export function IntegrationsPage() {
  const { t } = useI18n();
  const slug = useTenantSlug();
  usePageChrome({ title: t('nav.integrations') });
  const settings = useQuery({
    queryKey: ['tenant', slug, 'addressLookupSettings'] as const,
    queryFn: () =>
      request<AddressLookupSettings>(
        `/api/v2/t/${encodeURIComponent(slug)}/settings/addressLookup`,
      ),
  });
  return (
    <PageState isPending={settings.isPending} error={settings.error}>
      {() => (settings.data ? <AddressLookupCard settings={settings.data} /> : null)}
    </PageState>
  );
}

function AddressLookupCard({ settings }: { settings: AddressLookupSettings }) {
  const { t } = useI18n();
  const slug = useTenantSlug();
  const { app } = settings;
  return (
    <PageBody className="grid max-w-3xl gap-4">
      <SectionCard title={t('integrations.address.title')}>
        <div className="grid gap-4">
          <p className="text-sm text-muted-foreground">{t('integrations.address.intro')}</p>
          <div className="flex items-start gap-3 rounded-md border p-3">
            {app === null ? (
              <MapPin className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
            ) : (
              <AppIcon manifest={{ icon_url: app.icon_url, name: app.name }} size={24} />
            )}
            <div className="grid gap-1">
              <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                {app === null ? t('integrations.address.osm') : app.name}
                {app?.paused === true ? (
                  <Badge variant="outline">{t('integrations.address.paused')}</Badge>
                ) : null}
              </span>
              <span className="text-xs text-muted-foreground">
                {app !== null
                  ? settings.default_available
                    ? t('integrations.address.appHint')
                    : t('integrations.address.appHintNoFallback')
                  : settings.default_available
                    ? t('integrations.address.osmHint')
                    : t('integrations.address.osmOff')}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {app === null ? (
              <Button variant="outline" size="sm" asChild>
                <Link to="/t/$tenant/settings/apps" params={{ tenant: slug }}>
                  <Store className="size-4" aria-hidden />
                  {t('integrations.address.findApp')}
                </Link>
              </Button>
            ) : (
              <Button variant="outline" size="sm" asChild>
                <Link to="/t/$tenant/settings/apps/installed" params={{ tenant: slug }}>
                  <Store className="size-4" aria-hidden />
                  {t('integrations.address.manageApp')}
                </Link>
              </Button>
            )}
          </div>
        </div>
      </SectionCard>
    </PageBody>
  );
}
