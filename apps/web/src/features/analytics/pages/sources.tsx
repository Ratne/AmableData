import { useParams } from '@tanstack/react-router';
import { Megaphone } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { tenantRoute } from '../../../routes/tenant';
import { AnalyticsFrame } from '../components/analytics-layout';
import { EmptyNote, Panel } from '../components/ui';

/** `/t/$tenant/analytics/sources` — placeholder until the report is implemented. */
export function AnalyticsSourcesPage() {
  const { tenant } = useParams({ from: tenantRoute.id });
  const { t } = useI18n();
  const title = t('analytics.sources.title');
  return (
    <AnalyticsFrame tenant={tenant} tab={null} title={title} showFilters={false}>
      {() => (
        <Panel title={title}>
          <EmptyNote className="flex-col gap-2">
            <Megaphone className="size-5" aria-hidden />
            {t('analytics.stub.soon')}
          </EmptyNote>
        </Panel>
      )}
    </AnalyticsFrame>
  );
}
