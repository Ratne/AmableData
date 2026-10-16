import { cn } from '@amable/ui';
import { Skeleton } from '@amable/ui/ui/skeleton';
import { useParams } from '@tanstack/react-router';
import { BarChart3, Link2Off } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../../i18n';
import { isNotFound, usePublicShareInfo, type AnalyticsSource } from '../api';
import {
  GoalsCard,
  LocationsCard,
  PagesCard,
  SourcesCard,
  TechCard,
} from '../components/breakdown-cards';
import { FilterBar, RangeControls } from '../components/controls';
import { KpiRow } from '../components/kpi-row';
import { MainChart } from '../components/main-chart';
import { RealtimeView } from '../components/realtime-view';
import { ReportScopeProvider, type ReportScope } from '../components/scope';
import { ErrorState, Segmented } from '../components/ui';
import { usePublicQueryState } from '../lib/query-state';
import { analyticsShareRoute } from '../routes';

type View = 'dashboard' | 'realtime';

export function PublicSharePage() {
  const { token } = useParams({ from: analyticsShareRoute.id });
  const { t } = useI18n();
  const info = usePublicShareInfo(token);
  const timezone = info.data?.site.timezone;
  const controls = usePublicQueryState(timezone);
  const [view, setView] = useState<View>('dashboard');
  const source = useMemo<AnalyticsSource>(() => ({ kind: 'public', token }), [token]);

  useEffect(() => {
    if (info.data) document.title = `${info.data.site.name} · ${t('common.appName')}`;
  }, [info.data, t]);

  const scope: ReportScope = {
    source: info.data ? source : null,
    query: controls.query,
    interval: controls.interval,
    model: controls.model,
    currency: info.data?.site.currency ?? 'EUR',
    timezone,
    tenant: null,
    onFilter: controls.addFilter,
  };

  return (
    <div className="obsidian-dashboard-shell-layer min-h-dvh bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <BarChart3 className="size-4" aria-hidden />
          </span>
          <div className="flex min-w-0 flex-col">
            {info.data ? (
              <>
                <h1 className="truncate text-sm font-semibold">{info.data.site.name}</h1>
                <span className="truncate text-xs text-muted-foreground">
                  {t('analytics.public.subtitle', { name: info.data.share.name })}
                </span>
              </>
            ) : (
              <Skeleton className="h-8 w-40" />
            )}
          </div>
          {info.data ? (
            <Segmented<View>
              className="ml-auto"
              label={t('analytics.title')}
              value={view}
              onChange={setView}
              options={[
                { value: 'dashboard', label: t('analytics.tabs.dashboard') },
                { value: 'realtime', label: t('analytics.tabs.realtime') },
              ]}
            />
          ) : null}
        </div>
      </header>

      <main className="mx-auto flex max-w-7xl flex-col gap-[7px] px-4 pb-10 pt-4">
        {info.error ? (
          isNotFound(info.error) ? (
            <div className="mx-auto mt-20 flex max-w-sm flex-col items-center gap-3 text-center">
              <Link2Off className="size-6 text-muted-foreground" aria-hidden />
              <h1 className="text-base font-medium">{t('analytics.public.invalidTitle')}</h1>
              <p className="text-sm text-muted-foreground">{t('analytics.public.invalidBody')}</p>
            </div>
          ) : (
            <ErrorState error={info.error} />
          )
        ) : !info.data ? (
          <div className="grid gap-3">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-72 w-full" />
          </div>
        ) : (
          <ReportScopeProvider value={scope}>
            {view === 'dashboard' ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <RangeControls controls={controls} />
                </div>
                <div className={cn('-mx-4', controls.filters.length === 0 && '-mb-2')}>
                  <FilterBar controls={controls} />
                </div>
                <KpiRow />
                <MainChart />
                <div className="grid grid-cols-1 gap-[7px] xl:grid-cols-2">
                  <SourcesCard />
                  <PagesCard />
                  <LocationsCard />
                  <TechCard />
                  <GoalsCard />
                </div>
              </>
            ) : (
              <RealtimeView source={source} />
            )}
          </ReportScopeProvider>
        )}
        <footer className="pt-6 text-center text-[11px] text-muted-foreground">
          {t('analytics.public.poweredBy', { app: t('common.appName') })}
        </footer>
      </main>
    </div>
  );
}
