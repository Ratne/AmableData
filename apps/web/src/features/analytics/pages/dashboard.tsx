import type { Site } from '@amable/api-types';
import { Link, useParams } from '@tanstack/react-router';
import { Code2 } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { tenantRoute } from '../../../routes/tenant';
import { useInstallCheck } from '../api';
import { AnalyticsFrame } from '../components/analytics-layout';
import {
  AttributionCard,
  BotsCard,
  GoalsCard,
  LocationsCard,
  PagesCard,
  SourcesCard,
  TechCard,
} from '../components/breakdown-cards';
import { KpiRow } from '../components/kpi-row';
import { MainChart } from '../components/main-chart';
import { panelClass } from '../components/ui';
import { AdsDashboardWidgets } from '../reports-ads/dashboard-widgets';

/** Shown until the site's first event: where to find the snippet. */
function InstallBanner({ tenant, site }: { tenant: string; site: Site }) {
  const { t } = useI18n();
  const check = useInstallCheck(tenant, site.id);
  if (!check.data || check.data.receiving || check.data.last_event_at !== null) return null;
  return (
    <div className={`${panelClass} flex flex-wrap items-center gap-3 px-4 py-3`}>
      <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Code2 className="size-4" aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium">{t('analytics.tracking.waiting')}</span>
        <span className="text-xs text-muted-foreground">{t('analytics.tracking.waitingHint')}</span>
      </span>
      <Link
        to="/t/$tenant/analytics/settings"
        params={{ tenant }}
        search={{ site: site.id, tab: 'tracking' }}
        className="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        {t('analytics.dashboard.installCta')}
      </Link>
    </div>
  );
}

export function AnalyticsDashboardPage() {
  const { tenant } = useParams({ from: tenantRoute.id });
  return (
    <AnalyticsFrame tenant={tenant} tab="dashboard" showModel>
      {({ site }) => (
        <>
          <InstallBanner tenant={tenant} site={site} />
          <KpiRow />
          <MainChart />
          <AdsDashboardWidgets />
          <div className="grid grid-cols-1 gap-[7px] xl:grid-cols-2">
            <SourcesCard />
            <PagesCard />
            <LocationsCard />
            <TechCard />
            <GoalsCard />
            <BotsCard />
            <AttributionCard />
          </div>
        </>
      )}
    </AnalyticsFrame>
  );
}
