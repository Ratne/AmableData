import type {
  AdsReport,
  Integration,
  IntegrationProvider,
  SearchConsoleReport,
  Site,
} from '@amable/api-types';
import { DashboardButton, DashboardConfirmDialog } from '@amable/ui';
import { Skeleton } from '@amable/ui/ui/skeleton';
import { FlaskConical, Megaphone, RefreshCw, Search, Unplug } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../../../i18n';
import {
  analyticsApi,
  analyticsKeys,
  useAdsReport,
  useAnalyticsMutation,
  useIntegrations,
  useSearchConsoleReport,
  type AnalyticsQuery,
  type AnalyticsSource,
} from '../api';
import { EmptyNote, ErrorState, Panel, Segmented, StatusPill } from '../components/ui';
import { useFormatters, useNow } from '../lib/format';

const PROVIDER_META: Record<IntegrationProvider, { icon: typeof Megaphone }> = {
  meta_ads: { icon: Megaphone },
  search_console: { icon: Search },
};

function IntegrationCard({
  tenant,
  site,
  integration,
  canConfigure,
}: {
  tenant: string;
  site: Site;
  integration: Integration;
  canConfigure: boolean;
}) {
  const { t } = useI18n();
  const f = useFormatters();
  const now = useNow(60_000);
  const api = analyticsApi(tenant);
  const [disconnecting, setDisconnecting] = useState(false);
  const invalidate = [analyticsKeys.root(tenant)];
  const connect = useAnalyticsMutation(
    tenant,
    () => api.integrations.connect(site.id, integration.provider),
    {
      invalidate: [],
      onSuccess: (result) => window.location.assign(result.authorize_url),
    },
  );
  const sync = useAnalyticsMutation(
    tenant,
    () => api.integrations.sync(site.id, integration.provider),
    {
      invalidate,
      success: 'analytics.integrations.synced',
    },
  );
  const disconnect = useAnalyticsMutation(
    tenant,
    () => api.integrations.disconnect(site.id, integration.provider),
    {
      invalidate,
      success: 'analytics.integrations.disconnectedToast',
    },
  );
  const Icon = PROVIDER_META[integration.provider].icon;
  const connected = integration.status === 'connected';

  return (
    <Panel>
      <div className="flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Icon className="size-5" aria-hidden />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="text-sm font-medium">
                {t(`analytics.integrations.${integration.provider}.name`)}
              </span>
              {!integration.available ? (
                <StatusPill tone="neutral">{t('analytics.integrations.notConfigured')}</StatusPill>
              ) : integration.status === 'connected' ? (
                <StatusPill tone="success">{t('analytics.integrations.connected')}</StatusPill>
              ) : integration.status === 'error' ? (
                <StatusPill tone="danger">{t('analytics.integrations.error')}</StatusPill>
              ) : (
                <StatusPill tone="neutral">{t('analytics.integrations.disconnected')}</StatusPill>
              )}
              {integration.fake ? (
                <StatusPill tone="warning">
                  <FlaskConical className="size-3" aria-hidden />
                  {t('analytics.integrations.devData')}
                </StatusPill>
              ) : null}
            </span>
            <span className="text-xs text-muted-foreground">
              {t(`analytics.integrations.${integration.provider}.hint`)}
            </span>
          </div>
        </div>
        {connected ? (
          <dl className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <dt className="text-muted-foreground">{t('analytics.integrations.account')}</dt>
              <dd className="truncate">{integration.account_name ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('analytics.integrations.lastSync')}</dt>
              <dd>
                {integration.last_sync_at
                  ? f.relative(integration.last_sync_at, now)
                  : t('analytics.common.never')}
              </dd>
            </div>
          </dl>
        ) : null}
        {integration.last_error ? (
          <p className="text-xs text-destructive">{integration.last_error}</p>
        ) : null}
        {!integration.available ? (
          <p className="text-xs text-muted-foreground">{t('analytics.integrations.unavailable')}</p>
        ) : canConfigure ? (
          <div className="flex flex-wrap gap-1.5">
            {connected ? (
              <>
                <DashboardButton
                  variant="secondary"
                  onClick={() => sync.mutate(undefined)}
                  disabled={sync.isPending}
                >
                  <RefreshCw className={sync.isPending ? 'animate-spin' : undefined} aria-hidden />
                  {t('analytics.integrations.syncNow')}
                </DashboardButton>
                <DashboardButton variant="ghost" onClick={() => setDisconnecting(true)}>
                  <Unplug aria-hidden />
                  {t('analytics.integrations.disconnect')}
                </DashboardButton>
              </>
            ) : (
              <DashboardButton
                variant="primary"
                onClick={() => connect.mutate(undefined)}
                disabled={connect.isPending}
              >
                {t('analytics.integrations.connect')}
              </DashboardButton>
            )}
          </div>
        ) : null}
      </div>
      <DashboardConfirmDialog
        open={disconnecting}
        onOpenChange={setDisconnecting}
        title={t('analytics.integrations.disconnectTitle', {
          name: t(`analytics.integrations.${integration.provider}.name`),
        })}
        description={t('analytics.integrations.disconnectBody')}
        confirmLabel={t('analytics.integrations.disconnect')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onConfirm={() => {
          disconnect.mutate(undefined);
          setDisconnecting(false);
        }}
      />
    </Panel>
  );
}

const th =
  'pb-1.5 text-right text-[11px] font-medium uppercase tracking-wide text-muted-foreground';
const td = 'py-1.5 text-right tabular-nums';

function AdsTable({ report }: { report: AdsReport }) {
  const { t } = useI18n();
  const f = useFormatters();
  const money = (minor: number | null) =>
    minor === null ? '—' : f.moneyCompact(minor, report.currency);
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-2 gap-2 md:grid-cols-5">
        {[
          { label: t('analytics.ads.spend'), value: money(report.totals.spend_minor) },
          { label: t('analytics.kpi.revenue'), value: money(report.totals.revenue_minor) },
          {
            label: 'ROAS',
            value: report.totals.roas === null ? '—' : `${f.number(report.totals.roas, 2)}×`,
          },
          { label: t('analytics.ads.clicks'), value: f.compact(report.totals.clicks) },
          { label: t('analytics.ads.impressions'), value: f.compact(report.totals.impressions) },
        ].map((item) => (
          <div key={item.label} className="rounded-lg bg-foreground/[0.035] px-3 py-2">
            <dt className="text-[11px] text-muted-foreground">{item.label}</dt>
            <dd className="text-lg font-medium tabular-nums">{item.value}</dd>
          </div>
        ))}
      </dl>
      {report.campaigns.length === 0 ? (
        <EmptyNote>{t('analytics.ads.empty')}</EmptyNote>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-[13px]">
            <thead>
              <tr>
                <th className={`${th} text-left`}>{t('analytics.dim.campaign')}</th>
                <th className={th}>{t('analytics.ads.spend')}</th>
                <th className={th}>{t('analytics.ads.clicks')}</th>
                <th className={th}>{t('analytics.kpi.visitors')}</th>
                <th className={th}>{t('analytics.insights.customers')}</th>
                <th className={th}>{t('analytics.kpi.revenue')}</th>
                <th className={th}>ROAS</th>
                <th className={th}>CPA</th>
              </tr>
            </thead>
            <tbody>
              {report.campaigns.map((campaign) => (
                <tr key={campaign.campaign_id} className="border-t border-foreground/[0.06]">
                  <td className="max-w-56 truncate py-1.5">{campaign.campaign_name}</td>
                  <td className={td}>{money(campaign.spend_minor)}</td>
                  <td className={td}>{f.compact(campaign.clicks)}</td>
                  <td className={td}>{f.compact(campaign.visitors)}</td>
                  <td className={td}>{f.compact(campaign.customers)}</td>
                  <td className={td}>{money(campaign.revenue_minor)}</td>
                  <td
                    className={`${td} font-medium ${campaign.roas !== null && campaign.roas >= 1 ? 'text-success' : ''}`}
                  >
                    {campaign.roas === null ? '—' : `${f.number(campaign.roas, 2)}×`}
                  </td>
                  <td className={td}>{money(campaign.cost_per_acquisition_minor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SearchTable({ report }: { report: SearchConsoleReport }) {
  const { t } = useI18n();
  const f = useFormatters();
  const [kind, setKind] = useState<'queries' | 'pages'>('queries');
  const rows = report[kind];
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {[
          { label: t('analytics.ads.clicks'), value: f.compact(report.totals.clicks) },
          { label: t('analytics.ads.impressions'), value: f.compact(report.totals.impressions) },
          { label: 'CTR', value: f.percent(report.totals.ctr, 1) },
          { label: t('analytics.search.position'), value: f.number(report.totals.position, 1) },
        ].map((item) => (
          <div key={item.label} className="rounded-lg bg-foreground/[0.035] px-3 py-2">
            <dt className="text-[11px] text-muted-foreground">{item.label}</dt>
            <dd className="text-lg font-medium tabular-nums">{item.value}</dd>
          </div>
        ))}
      </dl>
      <Segmented
        className="self-start"
        label={t('analytics.search.title')}
        value={kind}
        onChange={setKind}
        options={[
          { value: 'queries', label: t('analytics.search.queries') },
          { value: 'pages', label: t('analytics.search.pages') },
        ]}
      />
      {rows.length === 0 ? (
        <EmptyNote>{t('analytics.breakdown.empty')}</EmptyNote>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-[13px]">
            <thead>
              <tr>
                <th className={`${th} text-left`}>
                  {kind === 'queries' ? t('analytics.search.query') : t('analytics.dim.page')}
                </th>
                <th className={th}>{t('analytics.ads.clicks')}</th>
                <th className={th}>{t('analytics.ads.impressions')}</th>
                <th className={th}>CTR</th>
                <th className={th}>{t('analytics.search.position')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 50).map((row) => (
                <tr key={row.key} className="border-t border-foreground/[0.06]">
                  <td
                    className={`max-w-72 truncate py-1.5 ${kind === 'pages' ? 'font-mono text-[12px]' : ''}`}
                  >
                    {row.key}
                  </td>
                  <td className={td}>{f.compact(row.clicks)}</td>
                  <td className={td}>{f.compact(row.impressions)}</td>
                  <td className={td}>{f.percent(row.ctr, 1)}</td>
                  <td className={td}>{f.number(row.position, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function IntegrationsTab({
  tenant,
  site,
  query,
  canConfigure,
}: {
  tenant: string;
  site: Site;
  query: AnalyticsQuery;
  canConfigure: boolean;
}) {
  const { t } = useI18n();
  const integrations = useIntegrations(tenant, site.id);
  const source: AnalyticsSource = { kind: 'tenant', tenant, siteId: site.id };
  const list = integrations.data?.data ?? [];
  const ads = list.find((item) => item.provider === 'meta_ads');
  const search = list.find((item) => item.provider === 'search_console');
  const adsReport = useAdsReport(source, query, ads?.status === 'connected');
  const searchReport = useSearchConsoleReport(source, query, search?.status === 'connected');

  if (integrations.error) return <ErrorState error={integrations.error} />;
  if (!integrations.data)
    return (
      <div className="grid gap-[7px] md:grid-cols-2">
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </div>
    );

  return (
    <div className="flex flex-col gap-[7px]">
      <div className="grid grid-cols-1 gap-[7px] md:grid-cols-2">
        {list.map((integration) => (
          <IntegrationCard
            key={integration.provider}
            tenant={tenant}
            site={site}
            integration={integration}
            canConfigure={canConfigure}
          />
        ))}
      </div>
      {ads?.status === 'connected' ? (
        <Panel title={t('analytics.ads.title')}>
          {adsReport.error ? (
            <ErrorState error={adsReport.error} />
          ) : adsReport.data ? (
            <AdsTable report={adsReport.data} />
          ) : (
            <Skeleton className="h-40 w-full" />
          )}
        </Panel>
      ) : null}
      {search?.status === 'connected' ? (
        <Panel title={t('analytics.search.title')}>
          {searchReport.error ? (
            <ErrorState error={searchReport.error} />
          ) : searchReport.data ? (
            <SearchTable report={searchReport.data} />
          ) : (
            <Skeleton className="h-40 w-full" />
          )}
        </Panel>
      ) : null}
    </div>
  );
}
