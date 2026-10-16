import type { VisitorSummary } from '@amable/api-types';
import { DashboardButton, DashboardFilterMenu, ListTable, type ListTableColumn } from '@amable/ui';
import { Input } from '@amable/ui/ui/input';
import { useNavigate, useParams } from '@tanstack/react-router';
import { Search, UserRound } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../../i18n';
import { listTableLabels } from '../../../lib/labels';
import { tenantRoute } from '../../../routes/tenant';
import { useVisitors, type VisitorsParams } from '../api';
import { AnalyticsFrame } from '../components/analytics-layout';
import { useReportScope } from '../components/scope';
import { EmptyNote, ErrorState, Flag } from '../components/ui';
import { DeviceIcon, ScoreBadge, VisitorIdentity, visitorName } from '../components/visitor-bits';
import { countryName } from '../lib/countries';
import { useFormatters, useNow } from '../lib/format';
import type { AnalyticsSearch } from '../lib/query-state';

type Tri = 'all' | 'true' | 'false';

function VisitorsTable({ tenant, linkSearch }: { tenant: string; linkSearch: AnalyticsSearch }) {
  const { t, locale } = useI18n();
  const f = useFormatters();
  const now = useNow(60_000);
  const navigate = useNavigate();
  const { source, query, currency } = useReportScope();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [identified, setIdentified] = useState<Tri>('all');
  const [customers, setCustomers] = useState<Tri>('all');
  const [sort, setSort] = useState<VisitorsParams['sort']>('last_seen');

  useEffect(() => {
    const id = window.setTimeout(() => setQ(text.trim()), 300);
    return () => window.clearTimeout(id);
  }, [text]);

  const params: VisitorsParams = {
    sort,
    ...(q ? { q } : {}),
    ...(identified !== 'all' ? { identified } : {}),
    ...(customers !== 'all' ? { customers } : {}),
  };
  const visitors = useVisitors(source, query, params);
  const rows = useMemo(
    () => visitors.data?.pages.flatMap((page) => page.data) ?? [],
    [visitors.data],
  );

  const columns: ListTableColumn<VisitorSummary>[] = [
    {
      id: 'visitor',
      header: t('analytics.visitors.visitor'),
      cell: (row) => <VisitorIdentity visitor={row} />,
    },
    {
      id: 'country',
      header: t('analytics.dim.country'),
      hideBelow: 'md',
      cell: (row) => (
        <span className="flex items-center gap-1.5 text-[13px]">
          <Flag code={row.country} />
          <span className="truncate">{countryName(row.country, locale) || '—'}</span>
        </span>
      ),
    },
    {
      id: 'device',
      header: t('analytics.visitors.device'),
      hideBelow: 'lg',
      cell: (row) => (
        <span className="flex items-center gap-1.5 text-[13px]">
          <DeviceIcon device={row.device} />
          <span className="truncate">
            {[row.browser, row.os].filter(Boolean).join(' · ') || '—'}
          </span>
        </span>
      ),
    },
    {
      id: 'channel',
      header: t('analytics.visitors.firstChannel'),
      hideBelow: 'xl',
      cell: (row) => (
        <span className="flex min-w-0 flex-col text-[13px]">
          <span className="truncate">{row.first_channel ?? '—'}</span>
          {row.first_source ? (
            <span className="truncate text-[11px] text-muted-foreground">{row.first_source}</span>
          ) : null}
        </span>
      ),
    },
    {
      id: 'sessions',
      header: t('analytics.visitors.sessions'),
      align: 'right',
      hideBelow: 'md',
      cell: (row) => f.number(row.sessions),
    },
    {
      id: 'pageviews',
      header: t('analytics.visitors.pageviews'),
      align: 'right',
      hideBelow: 'lg',
      cell: (row) => f.number(row.pageviews),
    },
    {
      id: 'revenue',
      header: t('analytics.kpi.revenue'),
      align: 'right',
      cell: (row) =>
        row.revenue_minor > 0 ? (
          <span className="whitespace-nowrap font-medium">{f.money(row.revenue_minor, currency)}</span>
        ) : (
          '—'
        ),
    },
    {
      id: 'score',
      header: t('analytics.visitors.score'),
      align: 'right',
      hideBelow: 'md',
      cell: (row) => <ScoreBadge prediction={row.prediction} />,
    },
    {
      id: 'lastSeen',
      header: t('analytics.visitors.lastSeen'),
      align: 'right',
      hideBelow: 'md',
      cell: (row) => (
        <span className="whitespace-nowrap text-muted-foreground">{f.relative(row.last_seen, now)}</span>
      ),
    },
  ];

  const tri = (value: string): Tri => (value === 'true' || value === 'false' ? value : 'all');

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={t('analytics.visitors.search')}
            aria-label={t('analytics.visitors.search')}
            className="h-8 pl-8 text-sm"
          />
        </div>
        <DashboardFilterMenu
          label={t('analytics.visitors.identity')}
          value={identified}
          onValueChange={(value) => setIdentified(tri(value))}
          options={[
            { value: 'all', label: t('analytics.visitors.all') },
            { value: 'true', label: t('analytics.visitors.identified') },
            { value: 'false', label: t('analytics.visitors.anonymousOnly') },
          ]}
        />
        <DashboardFilterMenu
          label={t('analytics.visitors.customers')}
          value={customers}
          onValueChange={(value) => setCustomers(tri(value))}
          options={[
            { value: 'all', label: t('analytics.visitors.all') },
            { value: 'true', label: t('analytics.visitors.customersOnly') },
            { value: 'false', label: t('analytics.visitors.nonCustomers') },
          ]}
        />
        <DashboardFilterMenu
          label={t('analytics.visitors.sortBy')}
          value={sort}
          onValueChange={(value) => setSort(value as VisitorsParams['sort'])}
          options={[
            { value: 'last_seen', label: t('analytics.visitors.lastSeen') },
            { value: 'revenue', label: t('analytics.kpi.revenue') },
            { value: 'score', label: t('analytics.visitors.score') },
            { value: 'sessions', label: t('analytics.visitors.sessions') },
          ]}
        />
      </div>
      {visitors.error ? (
        <ErrorState error={visitors.error} />
      ) : (
        <ListTable<VisitorSummary>
          rows={rows}
          getRowId={(row) => row.visitor_id}
          getRowLabel={(row) => visitorName(row, t('analytics.visitors.anonymous'))}
          columns={columns}
          labels={listTableLabels(t)}
          selectable={false}
          manualSorting
          loading={visitors.isPending}
          onRowOpen={(row) =>
            void navigate({
              to: '/t/$tenant/analytics/visitors/$visitorId',
              params: { tenant, visitorId: row.visitor_id },
              search: linkSearch,
            })
          }
          emptyState={
            <EmptyNote>
              <span className="flex flex-col items-center gap-2">
                <UserRound className="size-5" aria-hidden />
                {t('analytics.visitors.empty')}
              </span>
            </EmptyNote>
          }
          footer={
            visitors.hasNextPage ? (
              <div className="flex justify-center py-3">
                <DashboardButton
                  variant="secondary"
                  onClick={() => void visitors.fetchNextPage()}
                  disabled={visitors.isFetchingNextPage}
                >
                  {t('analytics.common.loadMore')}
                </DashboardButton>
              </div>
            ) : null
          }
        />
      )}
    </>
  );
}

export function AnalyticsVisitorsPage() {
  const { tenant } = useParams({ from: tenantRoute.id });
  return (
    <AnalyticsFrame tenant={tenant} tab="visitors" showInterval={false}>
      {(state) => <VisitorsTable tenant={tenant} linkSearch={state.linkSearch} />}
    </AnalyticsFrame>
  );
}
