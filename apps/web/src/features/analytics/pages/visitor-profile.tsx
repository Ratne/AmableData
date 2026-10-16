import type { VisitorProfile, VisitorSession } from '@amable/api-types';
import { PageBody, PageToolbar } from '@amable/ui';
import { Skeleton } from '@amable/ui/ui/skeleton';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, ArrowRight, Banknote, Contact, Eye, FileText, Target } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { tenantRoute } from '../../../routes/tenant';
import { isNotFound, useVisitorProfile } from '../api';
import { useAnalyticsChrome } from '../components/analytics-layout';
import { AnimatedNumber } from '../components/animated-number';
import { ScoreGauge, TimeToConversionFacts, TouchSummary } from '../components/journey-bits';
import { KpiCard } from '../components/kpi-row';
import { EmptyNote, ErrorState, Fact, Flag, Initials, Panel, StatusPill } from '../components/ui';
import { DeviceIcon, visitorName } from '../components/visitor-bits';
import { countryName } from '../lib/countries';
import { avatarHue, initials, shortId, useFormatters, useNow } from '../lib/format';
import { useAnalyticsQueryState } from '../lib/query-state';
import { analyticsVisitorRoute } from '../routes';

function SessionItem({ session, currency }: { session: VisitorSession; currency: string }) {
  const { t, locale } = useI18n();
  const f = useFormatters();
  const source = session.source ?? session.referrer_host ?? session.utm_source;
  return (
    <li className="group relative pb-5 pl-8 last:pb-0">
      <span
        aria-hidden
        className="absolute bottom-0 left-[11px] top-6 w-px bg-foreground/[0.08] group-last:hidden"
      />
      <span
        aria-hidden
        className="absolute left-0 top-0.5 flex size-6 items-center justify-center rounded-full bg-primary/12 text-primary"
      >
        <Eye className="size-3" />
      </span>
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
          <span className="font-medium">{session.channel}</span>
          {source ? <span className="text-muted-foreground">· {source}</span> : null}
          {session.utm_campaign ? (
            <StatusPill tone="neutral">{session.utm_campaign}</StatusPill>
          ) : null}
          {session.revenue_minor > 0 ? (
            <StatusPill tone="warning">
              <Banknote className="size-3" aria-hidden />
              {f.money(session.revenue_minor, currency)}
            </StatusPill>
          ) : null}
          <span className="ml-auto text-xs text-muted-foreground">
            {f.dateTime(session.started_at)} · {f.duration(session.duration_ms)}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <Flag code={session.country} className="w-4 text-[13px]" />
          <span>
            {[session.city, countryName(session.country, locale)].filter(Boolean).join(', ') || '—'}
          </span>
          <span>·</span>
          <DeviceIcon device={session.device} className="size-3" />
          <span>{[session.browser, session.os].filter(Boolean).join(' · ') || '—'}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1 font-mono text-[11.5px]">
          <span className="rounded bg-foreground/[0.05] px-1.5 py-0.5">
            {session.entry_page ?? '—'}
          </span>
          <ArrowRight className="size-3 text-muted-foreground" aria-hidden />
          <span className="rounded bg-foreground/[0.05] px-1.5 py-0.5">
            {session.exit_page ?? '—'}
          </span>
        </div>
        {session.pageviews.length > 0 || session.goals.length > 0 ? (
          <ol className="mt-0.5 flex flex-col gap-0.5 border-l border-foreground/[0.08] pl-3 text-xs">
            {[
              ...session.pageviews.map((pv) => ({
                kind: 'page' as const,
                ts: pv.ts,
                text: pv.path,
              })),
              ...session.goals.map((goal) => ({
                kind: 'goal' as const,
                ts: goal.ts,
                text: goal.name,
              })),
            ]
              .sort((a, b) => a.ts.localeCompare(b.ts))
              .slice(0, 30)
              .map((item, index) => (
                <li key={`${item.ts}-${index}`} className="flex items-center gap-2">
                  <span className="min-w-11 shrink-0 whitespace-nowrap tabular-nums text-muted-foreground">
                    {f.time(item.ts)}
                  </span>
                  {item.kind === 'goal' ? (
                    <span className="inline-flex items-center gap-1 text-success">
                      <Target className="size-3" aria-hidden />
                      {item.text}
                    </span>
                  ) : (
                    <span className="truncate font-mono text-[11.5px]">{item.text}</span>
                  )}
                </li>
              ))}
          </ol>
        ) : null}
        {session.pageviews.length > 30 ? (
          <span className="text-[11px] text-muted-foreground">
            {t('analytics.profile.morePages', { count: session.pageviews.length - 30 })}
          </span>
        ) : null}
      </div>
    </li>
  );
}

function ProfileBody({ tenant, profile }: { tenant: string; profile: VisitorProfile }) {
  const { t, locale } = useI18n();
  const f = useFormatters();
  const now = useNow(60_000);
  const { visitor, currency } = profile;
  const identified = !!(visitor.name ?? visitor.email);
  const traits = Object.entries(profile.traits ?? {});

  return (
    <>
      <div className="grid grid-cols-1 gap-[7px] xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <Panel>
          <div className="flex items-start gap-3">
            {identified ? (
              <Initials
                text={initials(visitor.name, visitor.email)}
                hue={avatarHue(visitor.contact_id ?? visitor.visitor_id)}
                size={44}
              />
            ) : (
              <span className="flex size-11 items-center justify-center rounded-full bg-foreground/[0.06] text-sm font-medium text-muted-foreground">
                {visitor.visitor_id.slice(0, 2).toUpperCase()}
              </span>
            )}
            <div className="flex min-w-0 flex-1 flex-col">
              <h2 className="truncate text-base font-medium">
                {visitorName(visitor, t('analytics.visitors.anonymous'))}
              </h2>
              {visitor.email && visitor.name ? (
                <span className="truncate text-sm text-muted-foreground">{visitor.email}</span>
              ) : null}
              <span className="mt-1 flex flex-wrap items-center gap-1.5">
                {visitor.customer ? (
                  <StatusPill tone="success">{t('analytics.profile.customer')}</StatusPill>
                ) : null}
                {identified ? (
                  <StatusPill tone="neutral">{t('analytics.visitors.identified')}</StatusPill>
                ) : null}
              </span>
            </div>
            {visitor.contact_id ? (
              <Link
                to="/t/$tenant/contacts/$contactId"
                params={{ tenant, contactId: visitor.contact_id }}
                className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-primary hover:bg-primary/10"
              >
                <Contact className="size-3.5" aria-hidden />
                {t('analytics.profile.openContact')}
              </Link>
            ) : null}
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-3">
            <Fact label={t('analytics.dim.country')}>
              <span className="flex items-center gap-1.5">
                <Flag code={visitor.country} />
                {countryName(visitor.country, locale) || '—'}
              </span>
            </Fact>
            <Fact label={t('analytics.visitors.device')}>
              {[visitor.device, visitor.browser, visitor.os].filter(Boolean).join(' · ') || '—'}
            </Fact>
            <Fact label={t('analytics.profile.firstSeen')}>{f.dateTime(visitor.first_seen)}</Fact>
            <Fact label={t('analytics.visitors.lastSeen')}>
              {f.relative(visitor.last_seen, now)}
            </Fact>
            {visitor.user_id ? (
              <Fact label={t('analytics.profile.userId')}>{visitor.user_id}</Fact>
            ) : null}
            <Fact label={t('analytics.profile.visitorId')}>
              <span className="font-mono text-xs">{shortId(visitor.visitor_id)}</span>
            </Fact>
          </dl>
          {traits.length > 0 ? (
            <div className="mt-4">
              <h3 className="mb-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
                {t('analytics.profile.traits')}
              </h3>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                {traits.map(([key, value]) => (
                  <div key={key} className="contents">
                    <dt className="truncate text-muted-foreground">{key}</dt>
                    <dd className="truncate">{String(value)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
          {profile.linked_visitor_ids.length > 0 ? (
            <div className="mt-4">
              <h3 className="mb-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
                {t('analytics.profile.linked')}
              </h3>
              <div className="flex flex-wrap gap-1">
                {profile.linked_visitor_ids.map((id) => (
                  <span
                    key={id}
                    className="rounded bg-foreground/[0.05] px-1.5 py-0.5 font-mono text-[11px]"
                  >
                    {shortId(id)}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </Panel>

        <div className="flex flex-col gap-[7px]">
          <ul className="grid grid-cols-2 gap-[7px] md:grid-cols-4">
            <KpiCard icon={Eye} label={t('analytics.visitors.sessions')}>
              <AnimatedNumber value={visitor.sessions} format={(v) => f.number(Math.round(v))} />
            </KpiCard>
            <KpiCard icon={FileText} label={t('analytics.visitors.pageviews')}>
              <AnimatedNumber value={visitor.pageviews} format={(v) => f.number(Math.round(v))} />
            </KpiCard>
            <KpiCard icon={Target} label={t('analytics.profile.goals')}>
              <AnimatedNumber value={visitor.goals} format={(v) => f.number(Math.round(v))} />
            </KpiCard>
            <KpiCard icon={Banknote} label={t('analytics.kpi.revenue')}>
              <AnimatedNumber
                value={visitor.revenue_minor}
                format={(v) => f.money(Math.round(v), currency)}
              />
            </KpiCard>
          </ul>
          <div className="grid grid-cols-1 gap-[7px] md:grid-cols-2">
            <Panel title={t('analytics.prediction.title')}>
              <ScoreGauge prediction={visitor.prediction} currency={currency} />
            </Panel>
            <Panel title={t('analytics.journey.timeToConversion')}>
              <TimeToConversionFacts value={profile.time_to_conversion} />
            </Panel>
          </div>
          <div className="grid grid-cols-1 gap-[7px] sm:grid-cols-2">
            <TouchSummary label={t('analytics.journey.firstTouch')} touch={profile.first_touch} />
            <TouchSummary
              label={t('analytics.journey.lastTouch')}
              touch={profile.last_non_direct_touch}
            />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-[7px] xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Panel title={t('analytics.profile.timeline', { count: profile.sessions.length })}>
          {profile.sessions.length === 0 ? (
            <EmptyNote>{t('analytics.profile.noSessions')}</EmptyNote>
          ) : (
            <ol className="flex flex-col pt-1">
              {profile.sessions.map((session) => (
                <SessionItem key={session.id} session={session} currency={currency} />
              ))}
            </ol>
          )}
        </Panel>
        <div className="flex flex-col gap-[7px]">
          <Panel title={t('analytics.profile.payments')}>
            {profile.payments.length === 0 ? (
              <EmptyNote className="min-h-12 py-3">{t('analytics.profile.noPayments')}</EmptyNote>
            ) : (
              <ul className="flex flex-col gap-1">
                {profile.payments.map((payment) => (
                  <li
                    key={payment.transaction_id}
                    className="flex items-center justify-between gap-2 text-[13px]"
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">
                        {f.money(payment.amount_minor, payment.currency)}
                      </span>
                      <span className="truncate text-[11px] text-muted-foreground">
                        {f.dateTime(payment.ts)} · {payment.source}
                        {payment.renewal ? ` · ${t('analytics.profile.renewal')}` : ''}
                      </span>
                    </span>
                    {payment.refunded_minor > 0 ? (
                      <StatusPill tone="danger">
                        {t('analytics.profile.refunded', {
                          amount: f.money(payment.refunded_minor, payment.currency),
                        })}
                      </StatusPill>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title={t('analytics.profile.completedGoals')}>
            {profile.completed_goals.length === 0 ? (
              <EmptyNote className="min-h-12 py-3">{t('analytics.profile.noGoals')}</EmptyNote>
            ) : (
              <ul className="flex flex-col gap-1">
                {profile.completed_goals.map((goal) => (
                  <li
                    key={goal.name}
                    className="flex items-center justify-between gap-2 text-[13px]"
                  >
                    <span className="inline-flex min-w-0 items-center gap-1.5">
                      <Target className="size-3.5 shrink-0 text-success" aria-hidden />
                      <span className="truncate font-mono text-[12px]">{goal.name}</span>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      ×{goal.count} · {f.relative(goal.last_at, now)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title={t('analytics.profile.visitedPages')}>
            {profile.visited_pages.length === 0 ? (
              <EmptyNote className="min-h-12 py-3">—</EmptyNote>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {profile.visited_pages.slice(0, 15).map((page) => (
                  <li
                    key={page.path}
                    className="flex items-center justify-between gap-2 text-[12.5px]"
                  >
                    <span className="truncate font-mono text-[12px]">{page.path}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {page.count}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}

export function AnalyticsVisitorPage() {
  const { tenant } = useParams({ from: tenantRoute.id });
  const { visitorId } = useParams({ from: analyticsVisitorRoute.id });
  const { t } = useI18n();
  const state = useAnalyticsQueryState(tenant);
  const profile = useVisitorProfile(tenant, state.site?.id ?? null, visitorId);
  const name = profile.data
    ? visitorName(profile.data.visitor, t('analytics.visitors.anonymous'))
    : t('analytics.profile.title');
  useAnalyticsChrome(state, 'visitors', name);

  return (
    <>
      <PageToolbar
        filters={
          <Link
            to="/t/$tenant/analytics/visitors"
            params={{ tenant }}
            search={state.linkSearch}
            className="inline-flex h-[30px] items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" aria-hidden />
            {t('analytics.profile.back')}
          </Link>
        }
      />
      <PageBody className="flex flex-col gap-[7px]">
        {profile.error ? (
          isNotFound(profile.error) ? (
            <EmptyNote>{t('analytics.profile.notFound')}</EmptyNote>
          ) : (
            <ErrorState error={profile.error} />
          )
        ) : !profile.data ? (
          <div className="grid gap-[7px] xl:grid-cols-3">
            <Skeleton className="h-64" />
            <Skeleton className="h-64 xl:col-span-2" />
          </div>
        ) : (
          <ProfileBody tenant={tenant} profile={profile.data} />
        )}
      </PageBody>
    </>
  );
}
