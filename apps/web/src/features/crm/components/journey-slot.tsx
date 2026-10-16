import { Skeleton } from '@amable/ui/ui/skeleton';
import { lazy, Suspense, type ComponentType } from 'react';
import { useI18n } from '../../../i18n';

/*
 * Slot for the analytics module's visitor journey of a contact. The panel is
 * resolved through a glob, so this builds whether or not the analytics module
 * ships `ContactJourneyPanel` yet; until it does the tab shows a notice.
 */

type JourneyPanel = ComponentType<{ contactId: string }>;
type JourneyModule = { ContactJourneyPanel?: JourneyPanel };

const candidates = import.meta.glob<JourneyModule>([
  '../../analytics/index.ts',
  '../../analytics/index.tsx',
  '../../analytics/components/contact-journey-panel.tsx',
]);

function JourneyUnavailable() {
  const { t } = useI18n();
  return <p className="text-sm text-muted-foreground">{t('crm.journey.unavailable')}</p>;
}

async function loadPanel(): Promise<{ default: JourneyPanel }> {
  for (const load of Object.values(candidates)) {
    const panel = (await load()).ContactJourneyPanel;
    if (typeof panel === 'function') return { default: panel };
  }
  return { default: JourneyUnavailable };
}

const LazyJourney = lazy(loadPanel);

export function ContactJourneySlot({ contactId }: { contactId: string }) {
  return (
    <Suspense fallback={<Skeleton className="h-32 w-full" />}>
      <LazyJourney contactId={contactId} />
    </Suspense>
  );
}
