import type { RealtimeEvent } from '@amable/api-types';
import { cn } from '@amable/ui';
import { Banknote, ExternalLink, Eye, Target, UserCheck } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { countryName } from '../lib/countries';
import { avatarHue, initials, useFormatters, useNow } from '../lib/format';
import { EmptyNote, Flag, Initials } from './ui';
import '../analytics.css';

function EventBadge({ event }: { event: RealtimeEvent }) {
  const { t } = useI18n();
  const f = useFormatters();
  const base =
    'inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-1.5 text-[11px] font-medium';
  switch (event.type) {
    case 'payment':
      return (
        <span className={cn(base, 'bg-warning/15 text-warning')}>
          <Banknote className="size-3" aria-hidden />
          {event.amount_minor !== null && event.currency
            ? f.money(event.amount_minor, event.currency)
            : t('analytics.live.payment')}
        </span>
      );
    case 'goal':
      return (
        <span className={cn(base, 'bg-success/12 text-success')}>
          <Target className="size-3" aria-hidden />
          {event.name ?? t('analytics.live.goal')}
        </span>
      );
    case 'identify':
      return (
        <span className={cn(base, 'bg-primary/12 text-primary')}>
          <UserCheck className="size-3" aria-hidden />
          {t('analytics.live.identified')}
        </span>
      );
    case 'external_link':
      return (
        <span className={cn(base, 'bg-foreground/[0.06] text-muted-foreground')}>
          <ExternalLink className="size-3" aria-hidden />
          {event.name ?? t('analytics.live.outbound')}
        </span>
      );
    case 'pageview':
      return (
        <span className={cn(base, 'bg-foreground/[0.06] text-muted-foreground')}>
          <Eye className="size-3" aria-hidden />
          {t('analytics.live.pageview')}
        </span>
      );
  }
}

/** Live event stream in the Active Sessions look: identity, page, badges, relative time. */
export function LiveFeed({
  events,
  className,
}: {
  events: readonly RealtimeEvent[];
  className?: string;
}) {
  const { t, locale } = useI18n();
  const f = useFormatters();
  const now = useNow(5_000);
  if (events.length === 0)
    return <EmptyNote className={className}>{t('analytics.live.waiting')}</EmptyNote>;
  return (
    <ul className={cn('flex flex-col', className)} aria-live="polite" aria-relevant="additions">
      {events.map((event, index) => {
        const place = [event.city, countryName(event.country, locale)].filter(Boolean).join(', ');
        const who = event.label ?? (place || t('analytics.live.anonymous'));
        return (
          <li
            key={`${event.ts}-${event.visitor_id}-${event.type}-${index}`}
            className="flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-foreground/[0.035] motion-safe:animate-[amb-feed-in_320ms_cubic-bezier(0.22,1,0.36,1)]"
          >
            {event.label ? (
              <Initials text={initials(event.label)} hue={avatarHue(event.visitor_id)} size={30} />
            ) : (
              <span className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-foreground/[0.05]">
                <Flag code={event.country} />
              </span>
            )}
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="flex min-w-0 items-center gap-1.5 text-[13px]">
                <span className="truncate font-medium">{who}</span>
                {event.label && place ? (
                  <span className="truncate text-xs text-muted-foreground">{place}</span>
                ) : null}
              </span>
              <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                <span className="truncate font-mono text-[11.5px]">{event.path ?? '—'}</span>
                {event.channel ? (
                  <span className="hidden truncate sm:inline">· {event.channel}</span>
                ) : null}
              </span>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <EventBadge event={event} />
              <time dateTime={event.ts} className="text-[11px] tabular-nums text-muted-foreground">
                {f.relative(event.ts, now)}
              </time>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
