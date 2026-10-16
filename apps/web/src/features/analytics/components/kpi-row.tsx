import { cn } from '@amable/ui';
import { Skeleton } from '@amable/ui/ui/skeleton';
import type { AnalyticsOverview } from '@amable/api-types';
import {
  ArrowDownRight,
  ArrowUpRight,
  Banknote,
  Clock,
  Coins,
  MousePointerClick,
  Radio,
  Target,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useI18n } from '../../../i18n';
import { useOverview, useRealtimeSnapshot } from '../api';
import { useFormatters } from '../lib/format';
import { isYmd, previousRange, relativeChange } from '../lib/range';
import { AnimatedNumber } from './animated-number';
import { useReportScope } from './scope';
import { ErrorState, PulseDot } from './ui';

/** Change vs the previous period; `lowerIsBetter` flips the colors (bounce rate). */
function DeltaPill({
  change,
  lowerIsBetter = false,
  title,
}: {
  change: number | null;
  lowerIsBetter?: boolean;
  title: string;
}) {
  const f = useFormatters();
  if (change === null) return null;
  const flat = Math.abs(change) < 0.0005;
  const good = flat ? null : change > 0 !== lowerIsBetter;
  const Arrow = flat ? null : change > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      title={title}
      className={cn(
        'ml-auto inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-px text-[11px] font-medium tabular-nums',
        good === null && 'bg-foreground/[0.06] text-muted-foreground',
        good === true && 'bg-success/10 text-success',
        good === false && 'bg-destructive/10 text-destructive',
      )}
    >
      {Arrow ? <Arrow className="size-3" aria-hidden /> : null}
      {f.percent(Math.abs(change), Math.abs(change) < 0.1 ? 1 : 0)}
    </span>
  );
}

export function KpiCard({
  icon: Icon,
  label,
  children,
  hint,
  delta,
  className,
}: {
  icon: LucideIcon;
  label: string;
  children: ReactNode;
  hint?: ReactNode;
  delta?: ReactNode;
  className?: string;
}) {
  return (
    <li
      className={cn(
        'group flex min-w-0 flex-col rounded-xl bg-foreground/[0.035] px-[15px] pb-3 pt-[13px] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--foreground)_4%,transparent)] transition-colors duration-150 hover:bg-foreground/[0.06] dark:bg-foreground/[0.045]',
        className,
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground">
        <Icon
          className="size-3.5 shrink-0 transition-colors group-hover:text-foreground"
          aria-hidden
        />
        <span className="truncate">{label}</span>
        {delta}
      </span>
      <span className="mt-2.5 min-w-0 truncate text-[23px] font-medium leading-[30px] tracking-[-0.015em] text-foreground">
        {children}
      </span>
      {hint ? (
        <span className="mt-0.5 truncate text-[11px] text-muted-foreground">{hint}</span>
      ) : null}
    </li>
  );
}

/** Visitors, revenue, conversion, RPV, bounce, duration and the live "online now" counter. */
export function KpiRow() {
  const { t } = useI18n();
  const f = useFormatters();
  const { source, query, currency } = useReportScope();
  const overview = useOverview(source, query);
  const comparable = isYmd(query.from) && isYmd(query.to);
  const before = comparable ? previousRange({ from: query.from, to: query.to }) : null;
  const previous = useOverview(source, before ? { ...query, ...before } : query, comparable);
  const realtime = useRealtimeSnapshot(source, { refetchInterval: 30_000 });

  if (overview.error) return <ErrorState error={overview.error} />;
  const data = overview.data;
  const prev = comparable ? previous.data : undefined;
  const vsTitle = before
    ? t('analytics.kpi.vsPrevious', {
        from: f.date(`${before.from}T12:00:00Z`, 'UTC'),
        to: f.date(`${before.to}T12:00:00Z`, 'UTC'),
      })
    : '';
  const delta = (pick: (o: AnalyticsOverview) => number, lowerIsBetter = false) =>
    data && prev ? (
      <DeltaPill
        change={relativeChange(pick(data), pick(prev))}
        lowerIsBetter={lowerIsBetter}
        title={vsTitle}
      />
    ) : null;
  const money = (value: number) => f.moneyCompact(Math.round(value), data?.currency ?? currency);
  const online = realtime.data?.online ?? data?.online ?? 0;

  return (
    <ul
      className="grid grid-cols-2 gap-[7px] sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-7"
      aria-label={t('analytics.kpi.label')}
    >
      {data ? (
        <>
          <KpiCard
            icon={Users}
            label={t('analytics.kpi.visitors')}
            delta={delta((o) => o.visitors)}
            hint={t('analytics.kpi.sessionsHint', {
              sessions: f.compact(data.sessions),
              pageviews: f.compact(data.pageviews),
            })}
          >
            <AnimatedNumber value={data.visitors} format={(v) => f.compact(Math.round(v))} />
          </KpiCard>
          <KpiCard
            icon={Banknote}
            label={t('analytics.kpi.revenue')}
            delta={delta((o) => o.revenue_minor)}
            hint={t('analytics.kpi.conversionsHint', { count: f.number(data.customers) })}
          >
            <AnimatedNumber value={data.revenue_minor} format={money} />
          </KpiCard>
          <KpiCard
            icon={Target}
            label={t('analytics.kpi.conversionRate')}
            delta={delta((o) => o.purchase_conversion_rate)}
            hint={t('analytics.kpi.goalsHint', { count: f.compact(data.goals) })}
          >
            <AnimatedNumber value={data.purchase_conversion_rate} format={(v) => f.percent(v, 2)} />
          </KpiCard>
          <KpiCard
            icon={Coins}
            label={t('analytics.kpi.revenuePerVisitor')}
            delta={delta((o) => o.revenue_per_visitor_minor)}
          >
            <AnimatedNumber
              value={data.revenue_per_visitor_minor}
              format={(v) => f.money(Math.round(v), data.currency || currency)}
            />
          </KpiCard>
          <KpiCard
            icon={MousePointerClick}
            label={t('analytics.kpi.bounceRate')}
            delta={delta((o) => o.bounce_rate, true)}
            hint={t('analytics.kpi.viewsPerSession', {
              value: f.number(data.views_per_session, 1),
            })}
          >
            <AnimatedNumber value={data.bounce_rate} format={(v) => f.percent(v, 1)} />
          </KpiCard>
          <KpiCard
            icon={Clock}
            label={t('analytics.kpi.sessionDuration')}
            delta={delta((o) => o.avg_session_duration_ms)}
          >
            <AnimatedNumber value={data.avg_session_duration_ms} format={f.duration} />
          </KpiCard>
          <KpiCard
            icon={Radio}
            label={t('analytics.kpi.online')}
            hint={t('analytics.kpi.onlineHint')}
            className="col-span-2 sm:col-span-1"
          >
            <span className="inline-flex items-center gap-2.5">
              <PulseDot />
              <AnimatedNumber value={online} format={(v) => f.number(Math.round(v))} />
            </span>
          </KpiCard>
        </>
      ) : (
        Array.from({ length: 7 }, (_, i) => (
          <li key={i} className="rounded-xl bg-foreground/[0.035] p-3.5">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="mt-3 h-7 w-24" />
          </li>
        ))
      )}
    </ul>
  );
}
