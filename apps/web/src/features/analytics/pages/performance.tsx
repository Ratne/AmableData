import { useParams } from '@tanstack/react-router';
import { Gauge } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { tenantRoute } from '../../../routes/tenant';
import { AnalyticsFrame } from '../components/analytics-layout';
import { EmptyNote, Panel } from '../components/ui';

/** `/t/$tenant/analytics/performance` — placeholder until the report is implemented. */
export function AnalyticsPerformancePage() {
  const { tenant } = useParams({ from: tenantRoute.id });
  const { t } = useI18n();
  const title = t('analytics.performance.title');
  return (
    <AnalyticsFrame tenant={tenant} tab={null} title={title} showFilters={false}>
      {() => (
        <Panel title={title}>
          <EmptyNote className="flex-col gap-2">
            <Gauge className="size-5" aria-hidden />
            {t('analytics.stub.soon')}
          </EmptyNote>
        </Panel>
      )}
    </AnalyticsFrame>
  );
}
