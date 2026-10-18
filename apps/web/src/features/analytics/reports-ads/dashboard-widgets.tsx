import { Skeleton } from '@amable/ui/ui/skeleton';
import { Link } from '@tanstack/react-router';
import { Banknote, Coins, Radar, TrendingUp } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { isForbidden } from '../api';
import { usePerformanceReport, useTrackingQuality } from '../api-reports-ads';
import { KpiCard } from '../components/kpi-row';
import { useReportScope } from '../components/scope';
import { ErrorState, panelClass } from '../components/ui';
import { useFormatters } from '../lib/format';
import { formatMetric, performanceRequest } from './model';

/** Spend, ROAS, attributed revenue (last click, per platform) and tracking quality of the range. */
export function AdsDashboardWidgets() {
  const { t } = useI18n();
  const f = useFormatters();
  const { source, query, timezone, tenant } = useReportScope();
  const siteId = source?.kind === 'tenant' ? source.siteId : null;
  const range = { from: query.from, to: query.to, ...(timezone ? { timezone } : {}) };
  const performance = usePerformanceReport(
    tenant ?? '',
    siteId && tenant
      ? performanceRequest(siteId, range, {
          model: 'last_click',
          windowDays: 7,
          basis: 'click_date',
          groupBy: 'platform',
          drill: [],
        })
      : null,
  );
  const quality = useTrackingQuality(tenant ?? '', tenant ? siteId : null, range);
  if (!siteId || !tenant) return null;
  if (isForbidden(performance.error)) return null;

  const totals = performance.data?.totals;
  const currency = performance.data?.currency ?? 'EUR';
  const loading = <Skeleton className="h-7 w-24" />;
  const q = quality.data;

  return (
    <section className={`${panelClass} flex flex-col gap-2 px-4 pb-4 pt-3`}>
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-[13px] font-medium">{t('analytics.adsWidgets.title')}</h2>
        <Link
          to="/t/$tenant/analytics/performance"
          params={{ tenant }}
          search={{ site: siteId }}
          className="text-xs text-muted-foreground hover:text-foreground hover:underline"
        >
          {t('analytics.adsWidgets.open')}
        </Link>
      </header>
      {performance.error ? (
        <ErrorState error={performance.error} compact />
      ) : (
        <ul className="grid grid-cols-2 gap-[7px] lg:grid-cols-4">
          <KpiCard icon={Banknote} label={t('analytics.adsWidgets.spend')}>
            {totals ? f.money(totals.cost_minor, currency) : loading}
          </KpiCard>
          <KpiCard icon={TrendingUp} label={t('analytics.adsWidgets.roas')} hint={t('analytics.adsWidgets.modelHint')}>
            {totals ? formatMetric(f, 'roas', totals.roas, currency) : loading}
          </KpiCard>
          <KpiCard icon={Coins} label={t('analytics.adsWidgets.revenue')} hint={t('analytics.adsWidgets.modelHint')}>
            {totals ? f.money(totals.revenue_minor, currency) : loading}
          </KpiCard>
          <KpiCard
            icon={Radar}
            label={t('analytics.adsWidgets.quality')}
            hint={
              q
                ? t('analytics.adsWidgets.qualityHint', {
                    conversions: f.number(q.conversions),
                    identity: f.number(q.with_identity),
                    click: f.number(q.with_click_id),
                  })
                : undefined
            }
          >
            {quality.error ? '—' : q ? (q.conversions === 0 ? '—' : f.percent(q.score, 0)) : loading}
          </KpiCard>
        </ul>
      )}
    </section>
  );
}
