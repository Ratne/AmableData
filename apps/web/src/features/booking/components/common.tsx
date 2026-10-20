import { usePageChrome } from '@amable/ui';
import { useNavigate } from '@tanstack/react-router';
import { useMemo, type ReactNode } from 'react';
import { useI18n } from '../../../i18n';
import { errorMessage, useBooking } from '../api/hooks';
import { ApiErrorNotice, QueryPageState } from '../../../components/feature-kit';

export {
  Pill,
  SectionCard,
  Choice,
  type Tone,
  FormField as Field,
} from '../../../components/feature-kit';

export function ErrorNotice({ error }: { error: unknown }) {
  const { t } = useI18n();
  return (
    <ApiErrorNotice
      error={error}
      message={errorMessage(t, error)}
      forbiddenTitle={t('booking.error.forbiddenTitle')}
    />
  );
}

export function PageState(props: {
  isPending: boolean;
  error: unknown;
  children: () => ReactNode;
}) {
  return <QueryPageState {...props} notice={(error) => <ErrorNotice error={error} />} />;
}

export type BookingSection = 'bookings' | 'calendars' | 'eventTypes';

const SECTION_PATHS: Record<
  BookingSection,
  '/t/$tenant/bookings' | '/t/$tenant/bookings/calendars' | '/t/$tenant/bookings/event-types'
> = {
  bookings: '/t/$tenant/bookings',
  calendars: '/t/$tenant/bookings/calendars',
  eventTypes: '/t/$tenant/bookings/event-types',
};

/** Header of the booking area: bookings / calendars / event types tabs. */
export function useBookingChrome(section: BookingSection, title?: string): void {
  const { t } = useI18n();
  const { slug } = useBooking();
  const navigate = useNavigate();
  usePageChrome({
    title: title ?? t('nav.bookings'),
    tabs: (['bookings', 'calendars', 'eventTypes'] as const).map((value) => ({
      value,
      label: t(`booking.tab.${value}`),
    })),
    tab: section,
    onTabChange: (value) => {
      const next = value as BookingSection;
      if (next !== section) void navigate({ to: SECTION_PATHS[next], params: { tenant: slug } });
    },
  });
}

/** IANA zones known to the browser (current value first when missing). */
export function useTimeZones(current: string): string[] {
  return useMemo(() => {
    let list: string[] = [];
    try {
      list =
        (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.(
          'timeZone',
        ) ?? [];
    } catch {
      list = [];
    }
    if (list.length === 0) list = ['UTC', 'Europe/Rome', 'Europe/London', 'America/New_York'];
    return list.includes(current) ? list : [current, ...list];
  }, [current]);
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
