import type { Site } from '@amable/api-types';
import { DashboardButton, PageBody, PageToolbar, usePageChrome } from '@amable/ui';
import { Skeleton } from '@amable/ui/ui/skeleton';
import { Link, useNavigate } from '@tanstack/react-router';
import { BarChart3, Settings2, Share2 } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useI18n } from '../../../i18n';
import { useAnalyticsPermissions } from '../lib/permissions';
import { useAnalyticsQueryState, type AnalyticsState } from '../lib/query-state';
import { FilterBar, ModelPicker, RangeControls, SitePicker } from './controls';
import { ReportScopeProvider, type ReportScope } from './scope';
import { SegmentsMenu } from './segments-menu';
import { ShareDialog } from './share-dialog';
import { ErrorState, panelClass } from './ui';

export type AnalyticsTab = 'dashboard' | 'realtime' | 'insights' | 'visitors' | 'funnels';

const TAB_PATHS = {
  dashboard: '/t/$tenant/analytics',
  realtime: '/t/$tenant/analytics/realtime',
  insights: '/t/$tenant/analytics/insights',
  visitors: '/t/$tenant/analytics/visitors',
  funnels: '/t/$tenant/analytics/funnels',
} as const;

function isTab(value: string): value is AnalyticsTab {
  return value in TAB_PATHS;
}

/** Header of the analytics pages: title and the Dashboard/Realtime/Insights/Visitors/Funnels tabs. */
export function useAnalyticsChrome(
  state: AnalyticsState,
  tab: AnalyticsTab | null,
  title?: string,
) {
  const { t } = useI18n();
  const navigate = useNavigate();
  usePageChrome({
    title: title ?? t('analytics.title'),
    tabs: [
      { value: 'dashboard', label: t('analytics.tabs.dashboard') },
      { value: 'realtime', label: t('analytics.tabs.realtime') },
      { value: 'insights', label: t('analytics.tabs.insights') },
      { value: 'visitors', label: t('analytics.tabs.visitors') },
      { value: 'funnels', label: t('analytics.tabs.funnels') },
    ],
    tab: tab ?? undefined,
    onTabChange: (value) => {
      if (!isTab(value)) return;
      void navigate({
        to: TAB_PATHS[value],
        params: { tenant: state.tenant },
        search: state.linkSearch,
      });
    },
  });
}

export function scopeOf(state: AnalyticsState): ReportScope {
  return {
    source: state.source,
    query: state.query,
    interval: state.interval,
    model: state.model,
    currency: state.site?.currency ?? 'EUR',
    timezone: state.site?.timezone,
    tenant: state.tenant,
    onFilter: state.addFilter,
  };
}

function NoSites({ tenant }: { tenant: string }) {
  const { t } = useI18n();
  const permissions = useAnalyticsPermissions(tenant);
  return (
    <PageBody className="pt-6">
      <div
        className={`${panelClass} mx-auto flex max-w-xl flex-col items-center gap-3 px-6 py-12 text-center`}
      >
        <span className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <BarChart3 className="size-5" aria-hidden />
        </span>
        <h2 className="text-base font-medium">{t('analytics.empty.title')}</h2>
        <p className="max-w-sm text-sm text-muted-foreground">{t('analytics.empty.body')}</p>
        {permissions.configure ? (
          <Link
            to="/t/$tenant/analytics/settings"
            params={{ tenant }}
            search={{ tab: 'sites', create: '1' }}
            className="mt-1 inline-flex h-8 items-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            {t('analytics.empty.cta')}
          </Link>
        ) : (
          <p className="text-xs text-muted-foreground">{t('analytics.empty.askAdmin')}</p>
        )}
      </div>
    </PageBody>
  );
}

function PageSkeleton() {
  return (
    <PageBody className="grid gap-3 pt-4">
      <Skeleton className="h-8 w-72" />
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
      <Skeleton className="h-72 w-full" />
    </PageBody>
  );
}

/**
 * Frame of every workspace analytics page: header tabs, toolbar (site, range,
 * interval, attribution, segments, settings/share), filter chips and the
 * report scope. Renders the empty state when the workspace has no site.
 */
export function AnalyticsFrame({
  tenant,
  tab,
  title,
  showModel = false,
  showInterval = true,
  showFilters = true,
  showSegments = true,
  hideRange = false,
  toolbarExtra,
  children,
}: {
  tenant: string;
  tab: AnalyticsTab | null;
  title?: string;
  showModel?: boolean;
  showInterval?: boolean;
  showFilters?: boolean;
  showSegments?: boolean;
  hideRange?: boolean;
  toolbarExtra?: ReactNode;
  children: (state: AnalyticsState & { site: Site }) => ReactNode;
}) {
  const { t } = useI18n();
  const state = useAnalyticsQueryState(tenant);
  const permissions = useAnalyticsPermissions(tenant);
  const [sharing, setSharing] = useState(false);
  useAnalyticsChrome(state, tab, title);
  const scope = useMemo(() => scopeOf(state), [state]);

  if (state.sites.error)
    return (
      <PageBody className="pt-4">
        <ErrorState error={state.sites.error} />
      </PageBody>
    );
  if (state.sites.isPending) return <PageSkeleton />;
  const site = state.site;
  if (!site) return <NoSites tenant={tenant} />;

  return (
    <ReportScopeProvider value={scope}>
      <PageToolbar
        filters={
          <>
            <SitePicker
              sites={state.sites.data ?? []}
              site={site}
              onChange={(id) => state.update({ site: id, f: undefined })}
            />
            {hideRange ? null : <RangeControls controls={state} showInterval={showInterval} />}
            {showModel ? <ModelPicker controls={state} /> : null}
            {showSegments ? <SegmentsMenu state={state} /> : null}
            {toolbarExtra}
          </>
        }
        actions={
          <>
            {permissions.configure ? (
              <DashboardButton variant="ghost" size="sm" onClick={() => setSharing(true)}>
                <Share2 aria-hidden />
                <span className="hidden sm:inline">{t('analytics.actions.share')}</span>
              </DashboardButton>
            ) : null}
            <Link
              to="/t/$tenant/analytics/settings"
              params={{ tenant }}
              search={{ site: site.id }}
              className="inline-flex h-[30px] items-center gap-1.5 rounded-lg px-[9px] text-xs text-(--obsidian-dashboard-shell-text-subtle) hover:bg-(--obsidian-dashboard-shell-muted) hover:text-foreground"
            >
              <Settings2 className="size-3" aria-hidden />
              <span className="hidden sm:inline">{t('analytics.actions.settings')}</span>
            </Link>
          </>
        }
      />
      {showFilters ? <FilterBar controls={state} /> : null}
      <PageBody className="flex flex-col gap-[7px]">{children({ ...state, site })}</PageBody>
      {sharing ? (
        <ShareDialog tenant={tenant} site={site} onClose={() => setSharing(false)} />
      ) : null}
    </ReportScopeProvider>
  );
}
