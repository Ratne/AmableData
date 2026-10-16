import { useParams } from '@tanstack/react-router';
import { tenantRoute } from '../../../routes/tenant';
import { AnalyticsFrame } from '../components/analytics-layout';
import { RealtimeView } from '../components/realtime-view';

export function AnalyticsRealtimePage() {
  const { tenant } = useParams({ from: tenantRoute.id });
  return (
    <AnalyticsFrame
      tenant={tenant}
      tab="realtime"
      showFilters={false}
      showSegments={false}
      showInterval={false}
      hideRange
    >
      {(state) => <RealtimeView source={state.source} />}
    </AnalyticsFrame>
  );
}
