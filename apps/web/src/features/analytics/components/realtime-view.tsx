import type { AnalyticsRealtime } from '@amable/api-types';
import { cn } from '@amable/ui';
import { Skeleton } from '@amable/ui/ui/skeleton';
import { useMemo } from 'react';
import { useI18n } from '../../../i18n';
import type { AnalyticsSource } from '../api';
import { COUNTRY_CENTROIDS, countryName } from '../lib/countries';
import { useFormatters } from '../lib/format';
import { useRealtimeFeed, type RealtimeStatus } from '../lib/realtime';
import { AnimatedNumber } from './animated-number';
import { Globe, type GlobeMarker } from './globe';
import { LiveFeed } from './live-feed';
import { EmptyNote, Flag, Panel, panelClass, PulseDot, StatusPill } from './ui';

function markersOf(snapshot: AnalyticsRealtime | null): GlobeMarker[] {
  if (!snapshot) return [];
  const out: GlobeMarker[] = [];
  for (const visitor of snapshot.visitors) {
    let lat = visitor.latitude;
    let lon = visitor.longitude;
    if (lat === null || lon === null) {
      const centroid = visitor.country
        ? COUNTRY_CENTROIDS.get(visitor.country.toUpperCase())
        : undefined;
      if (!centroid) continue;
      [lat, lon] = centroid;
    }
    out.push({
      id: visitor.visitor_id,
      lat,
      lon,
      weight: Math.min(1, 0.3 + visitor.pageviews / 10 + (visitor.revenue_minor > 0 ? 0.4 : 0)),
    });
  }
  return out;
}

function StatusBadge({ status }: { status: RealtimeStatus }) {
  const { t } = useI18n();
  if (status === 'live')
    return (
      <StatusPill tone="success">
        <PulseDot className="size-1.5 [&>span]:size-1.5" />
        {t('analytics.live.statusLive')}
      </StatusPill>
    );
  if (status === 'polling')
    return <StatusPill tone="warning">{t('analytics.live.statusPolling')}</StatusPill>;
  if (status === 'offline')
    return <StatusPill tone="danger">{t('analytics.live.statusOffline')}</StatusPill>;
  return <StatusPill tone="neutral">{t('analytics.live.statusConnecting')}</StatusPill>;
}

function CountList({
  rows,
  kind,
}: {
  rows: readonly { value: string | null; visitors: number }[];
  kind: 'page' | 'country' | 'referrer';
}) {
  const { t, locale } = useI18n();
  const f = useFormatters();
  if (rows.length === 0) return <EmptyNote>{t('analytics.live.nobody')}</EmptyNote>;
  const max = Math.max(1, ...rows.map((row) => row.visitors));
  return (
    <ul className="flex flex-col gap-0.5">
      {rows.slice(0, 8).map((row, index) => (
        <li
          key={`${row.value ?? '∅'}-${index}`}
          className="relative flex h-8 items-center gap-2 rounded-md px-2"
        >
          <span
            aria-hidden
            className="absolute inset-y-0 left-0 rounded-md bg-primary/[0.09] transition-[width] duration-500 dark:bg-primary/[0.16]"
            style={{ width: `${(row.visitors / max) * 100}%` }}
          />
          <span className="relative flex min-w-0 flex-1 items-center gap-2 text-[13px]">
            {kind === 'country' ? <Flag code={row.value} /> : null}
            <span className={cn('truncate', kind === 'page' && 'font-mono text-[12px]')}>
              {kind === 'country'
                ? countryName(row.value, locale) || t('analytics.breakdown.none')
                : (row.value ??
                  (kind === 'referrer'
                    ? t('analytics.live.direct')
                    : t('analytics.breakdown.none')))}
            </span>
          </span>
          <span className="relative text-[12.5px] tabular-nums">{f.number(row.visitors)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Globe, online counter, live feed and the last-30-minutes lists. */
export function RealtimeView({ source }: { source: AnalyticsSource | null }) {
  const { t } = useI18n();
  const f = useFormatters();
  const feed = useRealtimeFeed(source);
  const markers = useMemo(() => markersOf(feed.snapshot), [feed.snapshot]);
  const snapshot = feed.snapshot;
  const minutes = snapshot?.window_minutes ?? 30;

  return (
    <div className="flex flex-col gap-[7px]">
      <div className="grid grid-cols-1 gap-[7px] lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <section
          className={cn(panelClass, 'relative min-h-[420px] overflow-hidden lg:min-h-[560px]')}
        >
          <div className="absolute left-4 top-4 z-10 flex flex-col gap-1">
            <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
              {t('analytics.live.onlineNow')}
              <StatusBadge status={feed.status} />
            </span>
            <span className="flex items-center gap-3 text-[40px] font-medium leading-none tracking-[-0.02em]">
              <PulseDot className="size-2.5 [&>span]:size-2.5" />
              {snapshot ? (
                <AnimatedNumber value={snapshot.online} format={(v) => f.number(Math.round(v))} />
              ) : (
                <Skeleton className="h-10 w-16" />
              )}
            </span>
            <span className="text-xs text-muted-foreground">
              {t('analytics.live.windowVisitors', {
                count: f.number(snapshot?.visitors.length ?? 0),
                minutes,
              })}
            </span>
          </div>
          <Globe
            markers={markers}
            subscribe={feed.subscribe}
            label={t('analytics.live.globeLabel', { count: markers.length })}
            className="absolute inset-0"
          />
          <p className="pointer-events-none absolute bottom-3 right-4 text-[11px] text-muted-foreground">
            {t('analytics.live.dragHint')}
          </p>
        </section>
        <Panel
          title={t('analytics.live.feed')}
          className="max-h-[560px]"
          bodyClassName="overflow-y-auto"
          actions={
            <span className="text-[11px] text-muted-foreground">
              {t('analytics.live.lastMinutes', { minutes })}
            </span>
          }
        >
          {snapshot ? <LiveFeed events={feed.events} /> : <Skeleton className="h-64 w-full" />}
        </Panel>
      </div>
      <div className="grid grid-cols-1 gap-[7px] md:grid-cols-3">
        <Panel title={t('analytics.live.topPages')}>
          <CountList rows={snapshot?.pages ?? []} kind="page" />
        </Panel>
        <Panel title={t('analytics.live.topCountries')}>
          <CountList rows={snapshot?.countries ?? []} kind="country" />
        </Panel>
        <Panel title={t('analytics.live.topReferrers')}>
          <CountList rows={snapshot?.referrers ?? []} kind="referrer" />
        </Panel>
      </div>
    </div>
  );
}
