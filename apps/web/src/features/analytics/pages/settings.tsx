import { INTEGRATION_PROVIDERS, type IntegrationProvider } from '@amable/api-types';
import { PageBody, PageToolbar, toast, usePageChrome } from '@amable/ui';
import { Skeleton } from '@amable/ui/ui/skeleton';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { ArrowLeft, ShieldAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../../i18n';
import { tenantRoute } from '../../../routes/tenant';
import { analyticsApi, analyticsErrorMessage, analyticsKeys } from '../api';
import { RangeControls, SitePicker } from '../components/controls';
import { ShareManager } from '../components/share-dialog';
import { ErrorState, Panel } from '../components/ui';
import { useAnalyticsPermissions } from '../lib/permissions';
import { useAnalyticsQueryState } from '../lib/query-state';
import {
  analyticsSettingsRoute,
  SETTINGS_TABS,
  type SettingsSearch,
  type SettingsTab,
} from '../routes';
import { AdsTab } from '../settings/ads-tab';
import { AlertsTab } from '../settings/alerts-tab';
import { DomainsTab } from '../settings/domains-tab';
import { IntegrationsTab } from '../settings/integrations-tab';
import { KeysTab } from '../settings/keys-tab';
import { PredictionTab } from '../settings/prediction-tab';
import { SitesTab } from '../settings/sites-tab';
import { TrackingTab } from '../settings/tracking-tab';

function isProvider(value: string): value is IntegrationProvider {
  return (INTEGRATION_PROVIDERS as readonly string[]).includes(value);
}

function isSettingsTab(value: string): value is SettingsTab {
  return (SETTINGS_TABS as readonly string[]).includes(value);
}

/** Finishes an OAuth round-trip (`?integration=…&state=…&code=…`) once, then cleans the URL. */
function useIntegrationCallback(tenant: string, siteId: string | null) {
  const { t } = useI18n();
  const search = useSearch({ from: analyticsSettingsRoute.id });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const handled = useRef<string | null>(null);

  useEffect(() => {
    const { integration, state, code } = search;
    if (!integration || !state || !code || !siteId) return;
    if (handled.current === state) return;
    handled.current = state;
    const clean = () =>
      void navigate({
        to: '/t/$tenant/analytics/settings',
        params: { tenant },
        search: (previous: SettingsSearch) => ({
          ...previous,
          tab: 'integrations',
          integration: undefined,
          state: undefined,
          code: undefined,
        }),
        replace: true,
      });
    if (!isProvider(integration)) {
      clean();
      return;
    }
    analyticsApi(tenant)
      .integrations.callback(siteId, integration, { state, code })
      .then(() => {
        toast.success(t('analytics.integrations.connectedToast'));
        return queryClient.invalidateQueries({ queryKey: analyticsKeys.root(tenant) });
      })
      .catch((error: unknown) => toast.error(analyticsErrorMessage(t, error)))
      .finally(clean);
  }, [search, siteId, tenant, navigate, queryClient, t]);
}

export function AnalyticsSettingsPage() {
  const { tenant } = useParams({ from: tenantRoute.id });
  const { t } = useI18n();
  const search = useSearch({ from: analyticsSettingsRoute.id });
  const navigate = useNavigate();
  const state = useAnalyticsQueryState(tenant);
  const permissions = useAnalyticsPermissions(tenant);
  const tab: SettingsTab = search.tab ?? 'sites';
  const [createOpen, setCreateOpen] = useState(search.create === '1');
  useIntegrationCallback(tenant, state.site?.id ?? null);

  const setTab = (next: SettingsTab) =>
    void navigate({
      to: '/t/$tenant/analytics/settings',
      params: { tenant },
      search: (previous: SettingsSearch) => ({ ...previous, tab: next, create: undefined }),
      replace: true,
    });

  usePageChrome({
    title: t('analytics.settings.title'),
    tabs: SETTINGS_TABS.map((value) => ({ value, label: t(`analytics.settings.tab.${value}`) })),
    tab,
    onTabChange: (value) => {
      if (isSettingsTab(value)) setTab(value);
    },
  });

  const sites = state.sites.data ?? [];
  const site = state.site;
  const perSite = tab !== 'sites';

  const body = () => {
    if (state.sites.error) return <ErrorState error={state.sites.error} />;
    if (state.sites.isPending) return <Skeleton className="h-48 w-full" />;
    if (tab === 'sites' || !site)
      return (
        <SitesTab
          tenant={tenant}
          sites={sites}
          canConfigure={permissions.configure}
          createOpen={createOpen}
          onCreateOpenChange={setCreateOpen}
          onSiteCreated={(created) => state.update({ site: created.id })}
        />
      );
    switch (tab) {
      case 'tracking':
        return <TrackingTab tenant={tenant} site={site} />;
      case 'keys':
        return <KeysTab tenant={tenant} site={site} canConfigure={permissions.configure} />;
      case 'alerts':
        return <AlertsTab tenant={tenant} site={site} canConfigure={permissions.configure} />;
      case 'sharing':
        return (
          <Panel title={t('analytics.share.title', { site: site.name })}>
            <p className="mb-3 text-xs text-muted-foreground">{t('analytics.share.hint')}</p>
            <ShareManager tenant={tenant} site={site} />
          </Panel>
        );
      case 'integrations':
        return (
          <IntegrationsTab
            tenant={tenant}
            site={site}
            query={state.query}
            canConfigure={permissions.configure}
          />
        );
      case 'prediction':
        return <PredictionTab tenant={tenant} site={site} canConfigure={permissions.configure} />;
      case 'domains':
        return <DomainsTab tenant={tenant} site={site} canConfigure={permissions.configure} />;
      case 'ads':
        return <AdsTab tenant={tenant} site={site} canConfigure={permissions.configure} />;
    }
  };

  return (
    <>
      <PageToolbar
        filters={
          <>
            <Link
              to="/t/$tenant/analytics"
              params={{ tenant }}
              search={state.linkSearch}
              className="inline-flex h-[30px] items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground"
            >
              <ArrowLeft className="size-3.5" aria-hidden />
              {t('analytics.settings.back')}
            </Link>
            {perSite && site ? (
              <SitePicker sites={sites} site={site} onChange={(id) => state.update({ site: id })} />
            ) : null}
            {tab === 'integrations' && site ? (
              <RangeControls controls={state} showInterval={false} />
            ) : null}
          </>
        }
      />
      <PageBody className="flex flex-col gap-[7px]">
        {permissions.ready && !permissions.configure ? (
          <div className="flex items-start gap-2 rounded-lg bg-foreground/[0.04] p-3 text-xs text-muted-foreground">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            {t('analytics.settings.readOnly')}
          </div>
        ) : null}
        {body()}
      </PageBody>
    </>
  );
}
