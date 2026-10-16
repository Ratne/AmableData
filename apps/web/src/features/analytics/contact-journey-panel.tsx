import type { ContactJourney, JourneyItem, JourneyItemKind } from '@amable/api-types';
import { cn } from '@amable/ui';
import { Skeleton } from '@amable/ui/ui/skeleton';
import { Link, useParams } from '@tanstack/react-router';
import {
  Banknote,
  CalendarCheck,
  ClipboardList,
  Eye,
  Globe2,
  Mail,
  ShieldAlert,
  ShoppingBag,
  Target,
  UserCheck,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useI18n } from '../../i18n';
import { tenantRoute } from '../../routes/tenant';
import { isForbidden, useContactJourney } from './api';
import { ScoreGauge, TimeToConversionFacts, TouchSummary } from './components/journey-bits';
import { EmptyNote, ErrorState, panelClass, StatusPill } from './components/ui';
import { shortId, useFormatters, useNow } from './lib/format';

const KIND_ICONS: Record<JourneyItemKind, { icon: LucideIcon; tone: string }> = {
  session: { icon: Eye, tone: 'bg-primary/12 text-primary' },
  goal: { icon: Target, tone: 'bg-success/12 text-success' },
  payment: { icon: Banknote, tone: 'bg-warning/15 text-warning' },
  email: { icon: Mail, tone: 'bg-chart-4/15 text-chart-4' },
  order: { icon: ShoppingBag, tone: 'bg-warning/15 text-warning' },
  form: { icon: ClipboardList, tone: 'bg-foreground/[0.06] text-foreground' },
  booking: { icon: CalendarCheck, tone: 'bg-chart-2/15 text-chart-2' },
  identified: { icon: UserCheck, tone: 'bg-primary/12 text-primary' },
};

function Section({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('flex min-w-0 flex-col gap-2', className)}>
      <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h4>
      {children}
    </section>
  );
}

const LINK_SOURCES = ['form', 'booking', 'email', 'identify', 'order', 'api'] as const;
type LinkSource = (typeof LINK_SOURCES)[number];
const isLinkSource = (value: string): value is LinkSource =>
  (LINK_SOURCES as readonly string[]).includes(value);

function TimelineItem({ item }: { item: JourneyItem }) {
  const { t } = useI18n();
  const f = useFormatters();
  const now = useNow(60_000);
  const meta = KIND_ICONS[item.kind];
  const Icon = meta.icon;
  return (
    <li className="group relative flex gap-3 pb-3 last:pb-0">
      <span
        aria-hidden
        className="absolute bottom-0 left-[11px] top-6 w-px bg-foreground/[0.08] group-last:hidden"
      />
      <span
        className={cn(
          'relative flex size-6 shrink-0 items-center justify-center rounded-full',
          meta.tone,
        )}
      >
        <Icon className="size-3" aria-hidden />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="min-w-0 truncate text-[13px]">
            <span className="text-muted-foreground">
              {t(`analytics.journey.kind.${item.kind}`)}
            </span>{' '}
            <span
              className={cn(
                'font-medium',
                (item.kind === 'session' || item.kind === 'goal') && 'font-mono text-[12px]',
              )}
            >
              {item.kind === 'identified' && isLinkSource(item.title)
                ? t(`analytics.journey.linkSource.${item.title}`)
                : item.title}
            </span>
          </span>
          <time
            dateTime={item.ts}
            title={f.dateTime(item.ts)}
            className="shrink-0 text-[11px] text-muted-foreground"
          >
            {f.relative(item.ts, now)}
          </time>
        </div>
        {item.detail || item.channel || item.amount_minor !== null ? (
          <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            {item.channel && !item.detail?.startsWith(item.channel) ? <span>{item.channel}</span> : null}
            {item.detail ? <span className="truncate">{item.detail}</span> : null}
            {item.amount_minor !== null && item.currency ? (
              <StatusPill tone="warning">{f.money(item.amount_minor, item.currency)}</StatusPill>
            ) : null}
            {item.kind === 'order' && item.ref ? (
              <span className="font-mono text-[11px]">#{item.ref}</span>
            ) : null}
          </span>
        ) : null}
        {item.pages && item.pages.length > 0 ? (
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {item.pages.slice(0, 6).join(' → ')}
            {item.pages.length > 6 ? ` +${item.pages.length - 6}` : ''}
          </span>
        ) : null}
      </div>
    </li>
  );
}

function JourneyBody({ tenant, journey }: { tenant: string; journey: ContactJourney }) {
  const { t } = useI18n();
  const f = useFormatters();
  const { totals } = journey;
  const currency = journey.sites[0]?.currency ?? journey.totals.revenue[0]?.currency ?? 'EUR';
  const revenue =
    totals.revenue.length > 0
      ? totals.revenue.map((r) => f.money(r.amount_minor, r.currency)).join(' + ')
      : '—';
  const siteName = (siteId: string) =>
    journey.sites.find((site) => site.site_id === siteId)?.name ?? siteId;
  const stats = [
    { label: t('analytics.visitors.sessions'), value: f.number(totals.sessions) },
    { label: t('analytics.visitors.pageviews'), value: f.number(totals.pageviews) },
    { label: t('analytics.profile.goals'), value: f.number(totals.goals) },
    { label: t('analytics.kpi.revenue'), value: revenue },
    { label: t('analytics.journey.orders'), value: f.number(totals.orders) },
    {
      label: t('analytics.journey.emails'),
      value: t('analytics.journey.emailsValue', {
        opened: f.number(totals.emails_opened),
        clicked: f.number(totals.emails_clicked),
      }),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {journey.first_visit ? (
        <div className="flex items-start gap-3 rounded-lg bg-foreground/[0.03] px-3 py-2.5">
          <Globe2 className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
          <div className="flex min-w-0 flex-col gap-0.5 text-[13px]">
            <span>
              {t('analytics.journey.firstVisit', {
                date: f.dateTime(journey.first_visit.ts),
                site: siteName(journey.first_visit.site_id),
              })}
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {[
                journey.first_visit.channel,
                journey.first_visit.source ?? journey.first_visit.referrer_host,
                journey.first_visit.campaign,
              ]
                .filter(Boolean)
                .join(' · ')}
              {journey.first_visit.entry_page ? (
                <>
                  {' · '}
                  <span className="font-mono">{journey.first_visit.entry_page}</span>
                </>
              ) : null}
            </span>
          </div>
        </div>
      ) : null}

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {stats.map((stat) => (
          <div key={stat.label} className="rounded-lg bg-foreground/[0.03] px-3 py-2">
            <dt className="text-[11px] text-muted-foreground">{stat.label}</dt>
            <dd className="truncate text-sm font-medium tabular-nums">{stat.value}</dd>
          </div>
        ))}
      </dl>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <TouchSummary label={t('analytics.journey.firstTouch')} touch={journey.first_touch} />
        <TouchSummary
          label={t('analytics.journey.lastTouch')}
          touch={journey.last_non_direct_touch}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Section title={t('analytics.journey.timeToConversion')}>
          <TimeToConversionFacts value={journey.time_to_conversion} />
        </Section>
        <Section title={t('analytics.prediction.title')}>
          <ScoreGauge prediction={journey.prediction} currency={currency} compact />
        </Section>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Section title={t('analytics.journey.sources')}>
          {journey.sources.length === 0 ? (
            <span className="text-xs text-muted-foreground">—</span>
          ) : (
            <ul className="flex flex-col gap-1 text-xs">
              {journey.sources.slice(0, 6).map((source, index) => (
                <li
                  key={`${source.channel}-${source.source ?? ''}-${index}`}
                  className="flex justify-between gap-2"
                >
                  <span className="truncate">
                    {source.channel}
                    {source.source ? (
                      <span className="text-muted-foreground"> · {source.source}</span>
                    ) : null}
                  </span>
                  <span className="tabular-nums text-muted-foreground">{source.sessions}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title={t('analytics.journey.topPages')}>
          {journey.top_pages.length === 0 ? (
            <span className="text-xs text-muted-foreground">—</span>
          ) : (
            <ul className="flex flex-col gap-1 text-xs">
              {journey.top_pages.slice(0, 6).map((page) => (
                <li key={page.path} className="flex justify-between gap-2">
                  <span className="truncate font-mono text-[11.5px]">{page.path}</span>
                  <span className="tabular-nums text-muted-foreground">{page.count}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title={t('analytics.profile.goals')}>
          {journey.goals.length === 0 ? (
            <span className="text-xs text-muted-foreground">—</span>
          ) : (
            <ul className="flex flex-col gap-1 text-xs">
              {journey.goals.slice(0, 6).map((goal) => (
                <li key={goal.name} className="flex justify-between gap-2">
                  <span className="truncate font-mono text-[11.5px]">{goal.name}</span>
                  <span className="tabular-nums text-muted-foreground">×{goal.count}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      {journey.visitors.length > 0 ? (
        <Section title={t('analytics.journey.visitorIds')}>
          <div className="flex flex-wrap gap-1">
            {journey.visitors.map((visitor) => (
              <Link
                key={`${visitor.site_id}-${visitor.visitor_id}`}
                to="/t/$tenant/analytics/visitors/$visitorId"
                params={{ tenant, visitorId: visitor.visitor_id }}
                search={{ site: visitor.site_id }}
                title={t('analytics.journey.linkedVia', {
                  source: visitor.source,
                  site: siteName(visitor.site_id),
                })}
                className="rounded bg-foreground/[0.05] px-1.5 py-0.5 font-mono text-[11px] hover:bg-primary/10 hover:text-primary"
              >
                {shortId(visitor.visitor_id)}
              </Link>
            ))}
          </div>
        </Section>
      ) : null}

      <Section title={t('analytics.journey.timeline')}>
        {journey.items.length === 0 ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          <ol className="flex flex-col">
            {journey.items.map((item, index) => (
              <TimelineItem key={`${item.kind}-${item.ts}-${item.ref ?? index}`} item={item} />
            ))}
          </ol>
        )}
      </Section>
    </div>
  );
}

/**
 * Website activity of a CRM contact across all sites: first visit, totals,
 * sources, touches, time to conversion, prediction and a compact timeline.
 * Self-contained (own query); renders a small note without
 * `analytics:journey_read`.
 */
export function ContactJourneyPanel({
  tenant: tenantProp,
  contactId,
  className,
}: {
  /** Workspace slug; defaults to the `$tenant` of the current route (CRM contact page slot). */
  tenant?: string;
  contactId: string;
  className?: string;
}) {
  const { t } = useI18n();
  const { tenant: routeTenant } = useParams({ from: tenantRoute.id });
  const tenant = tenantProp ?? routeTenant;
  const journey = useContactJourney(tenant, contactId);
  const data = journey.data;
  const empty =
    data !== undefined &&
    data.items.length === 0 &&
    data.totals.sessions === 0 &&
    data.first_visit === null;

  return (
    <section
      className={cn(panelClass, 'flex flex-col gap-3 p-4', className)}
      aria-label={t('analytics.journey.title')}
    >
      <header className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <Globe2 className="size-4 text-muted-foreground" aria-hidden />
          {t('analytics.journey.title')}
        </h3>
        {data?.prediction ? (
          <StatusPill
            tone={
              data.prediction.score >= 70
                ? 'success'
                : data.prediction.score >= 40
                  ? 'warning'
                  : 'neutral'
            }
          >
            {t('analytics.visitors.scoreTitle', { score: Math.round(data.prediction.score) })}
          </StatusPill>
        ) : null}
      </header>
      {journey.error ? (
        isForbidden(journey.error) ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ShieldAlert className="size-3.5" aria-hidden />
            {t('analytics.journey.noAccess')}
          </p>
        ) : (
          <ErrorState error={journey.error} compact />
        )
      ) : !data ? (
        <div className="flex flex-col gap-2" aria-busy>
          <Skeleton className="h-12 w-full" />
          <div className="grid grid-cols-3 gap-2">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
          <Skeleton className="h-24 w-full" />
        </div>
      ) : empty ? (
        <EmptyNote className="flex-col gap-1">
          <span className="text-sm text-foreground">{t('analytics.journey.empty')}</span>
          <span>{t('analytics.journey.emptyHint')}</span>
        </EmptyNote>
      ) : (
        <JourneyBody tenant={tenant} journey={data} />
      )}
    </section>
  );
}
