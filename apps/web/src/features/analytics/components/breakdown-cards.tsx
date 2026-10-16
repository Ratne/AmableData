import type { AnalyticsBreakdownDimension, AttributionDimension, Funnel } from '@amable/api-types';
import { Link } from '@tanstack/react-router';
import { ArrowRight, ShieldCheck, ShieldX } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useI18n } from '../../../i18n';
import { useAttribution, useBots, useBreakdown, useFunnelResult, useFunnels } from '../api';
import { countryName } from '../lib/countries';
import { useFormatters } from '../lib/format';
import { botCategoryLabel, dimensionLabel, modelLabel } from '../lib/labels';
import { BreakdownList } from './breakdown-list';
import { DotMap } from './dot-map';
import { useReportScope } from './scope';
import { EmptyNote, ErrorState, Flag, ListSkeleton, Panel, Segmented } from './ui';

interface TabDef {
  readonly id: string;
  readonly label: string;
  readonly render: () => ReactNode;
}

export function TabbedCard({
  tabs,
  label,
  className,
}: {
  tabs: readonly TabDef[];
  label: string;
  className?: string;
}) {
  const [active, setActive] = useState(tabs[0]?.id ?? '');
  const current = tabs.find((tab) => tab.id === active) ?? tabs[0];
  return (
    <Panel
      className={className}
      title={<span className="text-muted-foreground">{label}</span>}
      actions={
        <Segmented
          label={label}
          value={current?.id ?? ''}
          onChange={setActive}
          options={tabs.map((tab) => ({ value: tab.id, label: tab.label }))}
        />
      }
    >
      <div key={current?.id}>{current?.render()}</div>
    </Panel>
  );
}

function dimTab(
  t: ReturnType<typeof useI18n>['t'],
  dimension: AnalyticsBreakdownDimension,
): TabDef {
  return {
    id: dimension,
    label: dimensionLabel(t, dimension),
    render: () => <BreakdownList dimension={dimension} />,
  };
}

const UTM_DIMENSIONS = ['utm_source', 'utm_medium', 'utm_term', 'utm_content'] as const;
type UtmDimension = (typeof UTM_DIMENSIONS)[number];

function UtmTab() {
  const { t } = useI18n();
  const [dimension, setDimension] = useState<UtmDimension>('utm_source');
  return (
    <div className="flex flex-col gap-2">
      <Segmented<UtmDimension>
        className="self-start"
        label={t('analytics.cards.utm')}
        value={dimension}
        onChange={setDimension}
        options={UTM_DIMENSIONS.map((d) => ({
          value: d,
          label: dimensionLabel(t, d).replace(/^UTM\s*/i, ''),
        }))}
      />
      <BreakdownList key={dimension} dimension={dimension} />
    </div>
  );
}

export function SourcesCard() {
  const { t } = useI18n();
  return (
    <TabbedCard
      label={t('analytics.cards.sources')}
      tabs={[
        dimTab(t, 'channel'),
        dimTab(t, 'referrer'),
        dimTab(t, 'campaign'),
        { id: 'utm', label: t('analytics.cards.utm'), render: () => <UtmTab /> },
      ]}
    />
  );
}

export function PagesCard() {
  const { t } = useI18n();
  return (
    <TabbedCard
      label={t('analytics.cards.pages')}
      tabs={[
        dimTab(t, 'page'),
        dimTab(t, 'entry_page'),
        dimTab(t, 'exit_link'),
        dimTab(t, 'hostname'),
      ]}
    />
  );
}

function MapTab() {
  const { t, locale } = useI18n();
  const f = useFormatters();
  const { source, query, onFilter } = useReportScope();
  const countries = useBreakdown(source, query, 'country', { limit: 100 });
  if (countries.error) return <ErrorState error={countries.error} compact />;
  const rows = countries.data?.rows ?? [];
  const values = rows
    .filter((row) => row.value)
    .map((row) => ({ country: row.value ?? '', visitors: row.visitors }));
  const total = rows.reduce((sum, row) => sum + row.visitors, 0);
  return (
    <div className="flex flex-col gap-3">
      <DotMap values={values} label={t('analytics.cards.mapLabel')} />
      {countries.data ? (
        <div className="flex flex-wrap gap-1.5">
          {rows.slice(0, 6).map((row) => (
            <button
              key={row.value ?? 'none'}
              type="button"
              disabled={!row.value || !onFilter}
              onClick={() =>
                row.value && onFilter?.({ dimension: 'country', op: 'is', value: row.value })
              }
              className="inline-flex h-7 items-center gap-1.5 rounded-full bg-foreground/[0.05] px-2.5 text-xs hover:bg-foreground/[0.09] disabled:cursor-default"
            >
              <Flag code={row.value} className="w-4 text-[13px]" />
              <span className="max-w-28 truncate">
                {countryName(row.value, locale) || t('analytics.breakdown.none')}
              </span>
              <span className="tabular-nums text-muted-foreground">
                {f.percent(total > 0 ? row.visitors / total : 0, 0)}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <ListSkeleton rows={1} />
      )}
    </div>
  );
}

export function LocationsCard() {
  const { t } = useI18n();
  return (
    <TabbedCard
      label={t('analytics.cards.locations')}
      tabs={[
        { id: 'map', label: t('analytics.cards.map'), render: () => <MapTab /> },
        dimTab(t, 'country'),
        dimTab(t, 'region'),
        dimTab(t, 'city'),
      ]}
    />
  );
}

export function TechCard() {
  const { t } = useI18n();
  return (
    <TabbedCard
      label={t('analytics.cards.technology')}
      tabs={[dimTab(t, 'browser'), dimTab(t, 'os'), dimTab(t, 'device')]}
    />
  );
}

function FunnelMini({ funnel }: { funnel: Funnel }) {
  const f = useFormatters();
  const { source, query } = useReportScope();
  const siteId = source?.kind === 'tenant' ? source.siteId : null;
  const tenant = source?.kind === 'tenant' ? source.tenant : '';
  const result = useFunnelResult(tenant, siteId, funnel.id, query);
  const rate = result.data?.conversion_rate ?? 0;
  return (
    <Link
      to="/t/$tenant/analytics/funnels"
      params={{ tenant }}
      search={{ site: siteId ?? undefined, funnel: funnel.id }}
      className="group flex flex-col gap-1.5 rounded-lg px-2 py-2 hover:bg-foreground/[0.04]"
    >
      <span className="flex items-center justify-between gap-2 text-[13px]">
        <span className="truncate">{funnel.name}</span>
        <span className="flex items-center gap-1 tabular-nums text-muted-foreground">
          {result.data
            ? `${f.compact(result.data.entered)} → ${f.compact(result.data.completed)}`
            : '…'}
          <span className="font-medium text-foreground">{f.percent(rate, 1)}</span>
          <ArrowRight
            className="size-3 opacity-0 transition-opacity group-hover:opacity-100"
            aria-hidden
          />
        </span>
      </span>
      <span className="flex h-1.5 gap-0.5 overflow-hidden rounded-full">
        {(result.data?.steps ?? funnel.steps.map(() => null)).map((step, i) => (
          <span
            key={i}
            className="flex-1 rounded-full bg-primary"
            style={{ opacity: step ? 0.2 + 0.8 * step.conversion_rate : 0.12 }}
          />
        ))}
      </span>
    </Link>
  );
}

function FunnelsTab() {
  const { t } = useI18n();
  const { source } = useReportScope();
  const tenant = source?.kind === 'tenant' ? source.tenant : '';
  const siteId = source?.kind === 'tenant' ? source.siteId : null;
  const funnels = useFunnels(tenant, siteId);
  if (funnels.error) return <ErrorState error={funnels.error} compact />;
  if (!funnels.data) return <ListSkeleton rows={3} />;
  if (funnels.data.data.length === 0)
    return (
      <EmptyNote>
        <span className="flex flex-col items-center gap-2">
          {t('analytics.funnels.emptyShort')}
          <Link
            to="/t/$tenant/analytics/funnels"
            params={{ tenant }}
            search={{ site: siteId ?? undefined }}
            className="text-primary hover:underline"
          >
            {t('analytics.funnels.create')}
          </Link>
        </span>
      </EmptyNote>
    );
  return (
    <div className="flex flex-col">
      {funnels.data.data.slice(0, 6).map((funnel) => (
        <FunnelMini key={funnel.id} funnel={funnel} />
      ))}
    </div>
  );
}

export function GoalsCard() {
  const { t } = useI18n();
  const { source } = useReportScope();
  const tabs: TabDef[] = [dimTab(t, 'goal')];
  if (source?.kind === 'tenant')
    tabs.push({ id: 'funnels', label: t('analytics.cards.funnels'), render: () => <FunnelsTab /> });
  return <TabbedCard label={t('analytics.cards.goals')} tabs={tabs} />;
}

function BotCategories() {
  const { t } = useI18n();
  const f = useFormatters();
  const { source, query } = useReportScope();
  const bots = useBots(source, query);
  if (bots.error) return <ErrorState error={bots.error} compact />;
  if (!bots.data) return <ListSkeleton rows={4} />;
  const { categories, total_hits: total } = bots.data;
  if (total === 0) return <EmptyNote>{t('analytics.bots.empty')}</EmptyNote>;
  const max = Math.max(1, ...categories.map((c) => c.hits));
  return (
    <ul className="flex flex-col gap-2 pt-1">
      {categories.map((category) => (
        <li key={category.value} className="flex flex-col gap-1">
          <span className="flex items-center justify-between text-[13px]">
            <span>{botCategoryLabel(t, category.value)}</span>
            <span className="tabular-nums text-muted-foreground">
              {f.compact(category.hits)} · {f.percent(category.hits / total, 0)}
            </span>
          </span>
          <span className="h-1.5 overflow-hidden rounded-full bg-foreground/[0.06]">
            <span
              className="block h-full rounded-full bg-chart-4"
              style={{ width: `${(category.hits / max) * 100}%` }}
            />
          </span>
        </li>
      ))}
    </ul>
  );
}

function BotList() {
  const { t } = useI18n();
  const f = useFormatters();
  const { source, query } = useReportScope();
  const bots = useBots(source, query);
  if (bots.error) return <ErrorState error={bots.error} compact />;
  if (!bots.data) return <ListSkeleton rows={5} />;
  if (bots.data.bots.length === 0) return <EmptyNote>{t('analytics.bots.empty')}</EmptyNote>;
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-3 px-2 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <span className="flex-1">{t('analytics.dim.bot')}</span>
        <span className="w-14 text-right">{t('analytics.breakdown.hits')}</span>
        <span className="w-24 text-right">{t('analytics.bots.verification')}</span>
      </div>
      <ul className="flex flex-col gap-0.5">
        {bots.data.bots.slice(0, 8).map((bot) => (
          <li
            key={bot.bot}
            className="flex h-9 items-center gap-3 rounded-md px-2 hover:bg-foreground/[0.03]"
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px]">{bot.bot}</span>
              <span className="truncate text-[11px] text-muted-foreground">
                {bot.provider} · {botCategoryLabel(t, bot.category)}
              </span>
            </span>
            <span className="w-14 text-right text-[12.5px] tabular-nums">
              {f.compact(bot.hits)}
            </span>
            <span className="flex w-24 items-center justify-end gap-2 text-[11px] tabular-nums">
              <span
                className="inline-flex items-center gap-0.5 text-success"
                title={t('analytics.bots.verified')}
              >
                <ShieldCheck className="size-3" aria-hidden />
                {f.compact(bot.verified_hits)}
              </span>
              <span
                className={`inline-flex items-center gap-0.5 ${bot.spoofed_hits > 0 ? 'text-destructive' : 'text-muted-foreground'}`}
                title={t('analytics.bots.spoofed')}
              >
                <ShieldX className="size-3" aria-hidden />
                {f.compact(bot.spoofed_hits)}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function BotPages() {
  const { t } = useI18n();
  const f = useFormatters();
  const { source, query } = useReportScope();
  const bots = useBots(source, query);
  if (bots.error) return <ErrorState error={bots.error} compact />;
  if (!bots.data) return <ListSkeleton rows={5} />;
  const pages = bots.data.pages.slice(0, 8);
  if (pages.length === 0) return <EmptyNote>{t('analytics.bots.empty')}</EmptyNote>;
  const max = Math.max(1, ...pages.map((page) => page.hits));
  return (
    <ul className="flex flex-col gap-0.5">
      {pages.map((page) => (
        <li key={page.path} className="relative flex h-8 items-center gap-3 rounded-md px-2">
          <span
            aria-hidden
            className="absolute inset-y-0 left-0 rounded-md bg-chart-4/10"
            style={{ width: `${(page.hits / max) * 100}%` }}
          />
          <span className="relative min-w-0 flex-1 truncate font-mono text-[12px]">
            {page.path}
          </span>
          <span className="relative w-14 text-right text-[12.5px] tabular-nums">
            {f.compact(page.hits)}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function BotsCard() {
  const { t } = useI18n();
  return (
    <TabbedCard
      label={t('analytics.cards.bots')}
      tabs={[
        {
          id: 'categories',
          label: t('analytics.bots.categories'),
          render: () => <BotCategories />,
        },
        { id: 'bots', label: t('analytics.bots.topBots'), render: () => <BotList /> },
        { id: 'pages', label: t('analytics.bots.crawledPages'), render: () => <BotPages /> },
      ]}
    />
  );
}

const ATTRIBUTION_TABS: readonly AttributionDimension[] = ['channel', 'source', 'campaign', 'entry_page'];

/** Revenue of the range credited per source value, every attribution model side by side. */
export function AttributionCard() {
  const { t } = useI18n();
  return (
    <TabbedCard
      className="xl:col-span-2"
      label={t('analytics.cards.attribution')}
      tabs={ATTRIBUTION_TABS.map((dimension) => ({
        id: dimension,
        label: dimensionLabel(t, dimension),
        render: () => <AttributionTable dimension={dimension} />,
      }))}
    />
  );
}

function AttributionTable({ dimension }: { dimension: AttributionDimension }) {
  const { t } = useI18n();
  const f = useFormatters();
  const { source, query, model } = useReportScope();
  const report = useAttribution(source, query, dimension);
  if (report.error) return <ErrorState error={report.error} compact />;
  if (!report.data) return <ListSkeleton rows={5} />;
  const { rows, models, currency, total_revenue_minor: total } = report.data;
  if (rows.length === 0 || total === 0)
    return <EmptyNote>{t('analytics.attribution.empty')}</EmptyNote>;
  return (
    <div className="overflow-x-auto pt-1">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-left text-[12px] text-muted-foreground">
            <th className="py-1.5 pr-3 font-normal">{dimensionLabel(t, dimension)}</th>
            {models.map((m) => (
              <th
                key={m}
                className={`py-1.5 pl-3 text-right font-normal ${m === model ? 'text-foreground' : ''}`}
              >
                {modelLabel(t, m)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.value ?? '∅'} className="border-t border-foreground/[0.06]">
              <td className="max-w-[16rem] truncate py-1.5 pr-3">
                {row.value ?? t('analytics.attribution.noTouch')}
              </td>
              {row.credits.map((c) => (
                <td
                  key={c.model}
                  className={`py-1.5 pl-3 text-right tabular-nums ${c.model === model ? 'font-medium' : 'text-muted-foreground'}`}
                  title={`${f.percent(c.revenue_minor / total, 1)} · ${c.conversions}`}
                >
                  {f.money(c.revenue_minor, currency)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
