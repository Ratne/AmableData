import { useParams } from '@tanstack/react-router';
import { Grid3x3 } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { tenantRoute } from '../../../routes/tenant';
import { AnalyticsFrame } from '../components/analytics-layout';
import { EmptyNote, Panel } from '../components/ui';

/** `/t/$tenant/analytics/cohorts` — placeholder until the report is implemented. */
export function AnalyticsCohortsPage() {
  const { tenant } = useParams({ from: tenantRoute.id });
  const { t } = useI18n();
  const title = t('analytics.cohorts.title');
  return (
    <AnalyticsFrame tenant={tenant} tab={null} title={title} showFilters={false}>
      {() => (
        <Panel title={title}>
          <EmptyNote className="flex-col gap-2">
            <Grid3x3 className="size-5" aria-hidden />
            {t('analytics.stub.soon')}
          </EmptyNote>
        </Panel>
      )}
    </AnalyticsFrame>
  );
}
