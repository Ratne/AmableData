import { randomScriptPath, type Site, type SiteSnippet } from '@amable/api-types';
import { DashboardButton, DashboardConfirmDialog } from '@amable/ui';
import { Skeleton } from '@amable/ui/ui/skeleton';
import { Shuffle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useI18n } from '../../../i18n';
import {
  analyticsApi,
  analyticsKeys,
  useAnalyticsMutation,
  useDeviceSignals,
  useIdentitySettings,
  useTrackingCoverage,
} from '../api';
import { CodeBlock } from '../components/copy';
import { EmptyNote, ErrorState, Panel, Segmented } from '../components/ui';
import { SwitchRow } from '../funnel-builder/panels/form-bits';
import { useFormatters } from '../lib/format';
import { resolveRange } from '../lib/range';

type Recipe = Exclude<keyof SiteSnippet['proxy'], 'path'>;

/** Neutral script path (rotatable) and the reverse-proxy recipes serving it first party. */
export function ScriptPathPanel({
  tenant,
  site,
  snippet,
}: {
  tenant: string;
  site: Site;
  snippet: SiteSnippet | undefined;
}) {
  const { t } = useI18n();
  const [recipe, setRecipe] = useState<Recipe>('cloudflare');
  const [confirming, setConfirming] = useState(false);
  const rotate = useAnalyticsMutation(
    tenant,
    () => analyticsApi(tenant).sites.update(site.id, { script_path: randomScriptPath() }),
    { success: 'analytics.path.rotated' },
  );
  return (
    <Panel
      title={t('analytics.path.title')}
      actions={
        <DashboardButton
          variant="secondary"
          onClick={() => setConfirming(true)}
          disabled={rotate.isPending}
        >
          <Shuffle aria-hidden />
          {t('analytics.path.rotate')}
        </DashboardButton>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">
          {t('analytics.path.hint', { path: `/${site.script_path}.js` })}
        </p>
        {snippet === undefined ? (
          <Skeleton className="h-28 w-full" />
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-medium">{t('analytics.path.proxy')}</span>
              <Segmented<Recipe>
                label={t('analytics.path.proxy')}
                value={recipe}
                onChange={setRecipe}
                options={[
                  { value: 'cloudflare', label: 'Cloudflare' },
                  { value: 'nginx', label: 'nginx' },
                  { value: 'next', label: 'Next.js' },
                  { value: 'vercel', label: 'Vercel' },
                ]}
              />
            </div>
            <CodeBlock code={snippet.proxy[recipe]} />
            <p className="text-xs text-muted-foreground">
              {t('analytics.path.proxyHint', { path: snippet.proxy.path })}
            </p>
          </>
        )}
      </div>
      <DashboardConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('analytics.path.rotateTitle')}
        description={t('analytics.path.rotateBody')}
        confirmLabel={t('analytics.path.rotate')}
        cancelLabel={t('common.cancel')}
        onConfirm={() => {
          rotate.mutate(undefined);
          setConfirming(false);
        }}
      />
    </Panel>
  );
}

/** Probabilistic merge of a new visitor by same-day IP + user agent (off by default). */
export function IdentityMatchingPanel({ tenant, site }: { tenant: string; site: Site }) {
  const { t } = useI18n();
  const settings = useIdentitySettings(tenant, site.id);
  const update = useAnalyticsMutation(
    tenant,
    (ipUa: boolean) => analyticsApi(tenant).sites.updateIdentitySettings(site.id, { ip_ua: ipUa }),
    { invalidate: [analyticsKeys.site(tenant, site.id, 'identity-settings')] },
  );
  return (
    <Panel title={t('analytics.matching.title')}>
      {settings.error ? (
        <ErrorState error={settings.error} />
      ) : !settings.data ? (
        <Skeleton className="h-12 w-full" />
      ) : (
        <SwitchRow
          label={t('analytics.matching.ipUa')}
          hint={t('analytics.matching.ipUaHint')}
          checked={settings.data.ip_ua}
          onChange={(checked) => update.mutate(checked)}
        />
      )}
    </Panel>
  );
}

const pct = (part: number, whole: number) => (whole === 0 ? 0 : part / whole);

/**
 * Device signals module and the `device_ip` rule (both off by default): what the
 * signals collected so far say, and the merges of the rule with "Unlink".
 */
export function DeviceRecognitionPanel({ tenant, site }: { tenant: string; site: Site }) {
  const { t } = useI18n();
  const f = useFormatters();
  const [confirmAll, setConfirmAll] = useState(false);
  const settings = useIdentitySettings(tenant, site.id);
  const report = useDeviceSignals(tenant, site.id);
  const reportKey = analyticsKeys.site(tenant, site.id, 'device-signals');
  const collect = useAnalyticsMutation(tenant, (on: boolean) =>
    analyticsApi(tenant).sites.update(site.id, { device_signals: on }),
  );
  const rule = useAnalyticsMutation(
    tenant,
    (on: boolean) => analyticsApi(tenant).sites.updateIdentitySettings(site.id, { device_ip: on }),
    { invalidate: [analyticsKeys.site(tenant, site.id, 'identity-settings')] },
  );
  const unmerge = useAnalyticsMutation(
    tenant,
    (ids: string[] | null) =>
      analyticsApi(tenant).sites.unmergeDevices(
        site.id,
        ids === null ? { all: true } : { child_visitor_ids: ids },
      ),
    { invalidate: [reportKey], success: 'analytics.device.unlinked' },
  );
  const data = report.data;
  const short = (id: string) => (id.length > 13 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);
  return (
    <Panel title={t('analytics.device.title')}>
      <div className="flex flex-col gap-3">
        {site.cookieless ? (
          <p className="text-xs text-muted-foreground">{t('analytics.device.cookieless')}</p>
        ) : (
          <SwitchRow
            label={t('analytics.device.collect')}
            hint={t('analytics.device.collectHint')}
            checked={site.device_signals}
            onChange={(checked) => collect.mutate(checked)}
          />
        )}
        {settings.data ? (
          <SwitchRow
            label={t('analytics.device.rule')}
            hint={t('analytics.device.ruleHint')}
            checked={settings.data.device_ip}
            onChange={(checked) => rule.mutate(checked)}
          />
        ) : null}
        {report.error ? (
          <ErrorState error={report.error} />
        ) : !data ? (
          <Skeleton className="h-20 w-full" />
        ) : data.collected === 0 ? (
          <EmptyNote>{t('analytics.device.empty')}</EmptyNote>
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
              {(
                [
                  ['collected', f.number(data.collected)],
                  ['devices', f.number(data.devices)],
                  ['wouldMerge', f.number(data.would_merge)],
                  [
                    'precision',
                    data.precision.checked === 0
                      ? '—'
                      : t('analytics.device.precisionValue', {
                          share: f.percent(pct(data.precision.correct, data.precision.checked)),
                          n: f.number(data.precision.checked),
                        }),
                  ],
                ] as const
              ).map(([key, value]) => (
                <div key={key} className="rounded-md border border-border/60 px-2 py-1.5">
                  <dt className="text-muted-foreground">{t(`analytics.device.${key}`)}</dt>
                  <dd className="font-medium tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-3 font-medium">{t('analytics.dim.os')}</th>
                    <th className="py-1 pr-3 font-medium">{t('analytics.dim.browser')}</th>
                    <th className="py-1 pr-3 text-right font-medium">
                      {t('analytics.device.visitors')}
                    </th>
                    <th className="py-1 pr-3 text-right font-medium">
                      {t('analytics.device.unique')}
                    </th>
                    <th className="py-1 text-right font-medium">{t('analytics.device.stable')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.groups.map((g) => (
                    <tr key={`${g.os}:${g.browser}`} className="border-t border-border/60">
                      <td className="py-1 pr-3">{g.os ?? '—'}</td>
                      <td className="py-1 pr-3">{g.browser ?? '—'}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">{f.number(g.visitors)}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">
                        {f.percent(g.unique_share)}
                      </td>
                      <td className="py-1 text-right tabular-nums">
                        {g.stable_share === null ? '—' : f.percent(g.stable_share)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">{t('analytics.device.hint')}</p>
          </>
        )}
        {data && data.merged > 0 ? (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-medium">
                {t('analytics.device.merges', { n: f.number(data.merged) })}
              </span>
              <DashboardButton
                variant="secondary"
                onClick={() => setConfirmAll(true)}
                disabled={unmerge.isPending}
              >
                {t('analytics.device.unlinkAll')}
              </DashboardButton>
            </div>
            <ul className="flex flex-col divide-y divide-border/60 text-xs">
              {data.merges.map((m) => (
                <li
                  key={m.child_visitor_id}
                  className="flex flex-wrap items-center justify-between gap-2 py-1"
                >
                  <span
                    className="font-mono"
                    title={`${m.child_visitor_id} → ${m.origin_visitor_id}`}
                  >
                    {short(m.child_visitor_id)} → {short(m.origin_visitor_id)}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="text-muted-foreground">
                      {f.dateTime(new Date(m.created_at).toISOString())}
                    </span>
                    <DashboardButton
                      variant="ghost"
                      onClick={() => unmerge.mutate([m.child_visitor_id])}
                      disabled={unmerge.isPending}
                    >
                      {t('analytics.device.unlink')}
                    </DashboardButton>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      <DashboardConfirmDialog
        open={confirmAll}
        onOpenChange={setConfirmAll}
        title={t('analytics.device.unlinkAllTitle')}
        description={t('analytics.device.unlinkAllBody')}
        confirmLabel={t('analytics.device.unlinkAll')}
        cancelLabel={t('common.cancel')}
        onConfirm={() => {
          unmerge.mutate(null);
          setConfirmAll(false);
        }}
      />
    </Panel>
  );
}

/** Above this share of shared-host sessions the panel suggests a tracking domain. */
const SHARED_HOST_ALERT = 0.2;

function DomainCallout({
  rows,
  onSetup,
}: {
  rows: Array<{ collector: string; sessions: number }>;
  onSetup?: () => void;
}) {
  const { t } = useI18n();
  const f = useFormatters();
  const total = rows.reduce((n, r) => n + r.sessions, 0);
  const shared = rows
    .filter((r) => r.collector === 'third_party')
    .reduce((n, r) => n + r.sessions, 0);
  const share = pct(shared, total);
  if (share < SHARED_HOST_ALERT) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
      <span>{t('analytics.coverage.domainCta', { share: f.percent(share) })}</span>
      {onSetup ? (
        <DashboardButton variant="secondary" onClick={onSetup}>
          {t('analytics.coverage.domainAction')}
        </DashboardButton>
      ) : null}
    </div>
  );
}

/** Last 30 days per browser and collector: where cookies survive, who gets identified. */
export function TrackingCoveragePanel({
  tenant,
  site,
  onSetupDomain,
}: {
  tenant: string;
  site: Site;
  /** Opens the tracking domain setup (shown when most sessions use the shared host). */
  onSetupDomain?: () => void;
}) {
  const { t } = useI18n();
  const f = useFormatters();
  const query = useMemo(
    () => ({ ...resolveRange('30d', site.timezone), timezone: site.timezone, filters: [] }),
    [site.timezone],
  );
  const coverage = useTrackingCoverage({ kind: 'tenant', tenant, siteId: site.id }, query);
  return (
    <Panel title={t('analytics.coverage.title')}>
      {coverage.error ? (
        <ErrorState error={coverage.error} />
      ) : !coverage.data ? (
        <Skeleton className="h-28 w-full" />
      ) : coverage.data.rows.length === 0 ? (
        <EmptyNote>{t('analytics.coverage.empty')}</EmptyNote>
      ) : (
        <div className="flex flex-col gap-2">
          <DomainCallout rows={coverage.data.rows} onSetup={onSetupDomain} />
          <p className="text-xs text-muted-foreground">{t('analytics.coverage.hint')}</p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3 font-medium">{t('analytics.dim.browser')}</th>
                  <th className="py-1 pr-3 font-medium">{t('analytics.coverage.collector')}</th>
                  <th className="py-1 pr-3 text-right font-medium">
                    {t('analytics.coverage.sessions')}
                  </th>
                  <th className="py-1 pr-3 text-right font-medium">
                    {t('analytics.coverage.returning')}
                  </th>
                  <th className="py-1 pr-3 text-right font-medium">
                    {t('analytics.coverage.identified')}
                  </th>
                  <th className="py-1 text-right font-medium">{t('analytics.coverage.ads')}</th>
                </tr>
              </thead>
              <tbody>
                {coverage.data.rows.map((row) => (
                  <tr key={`${row.browser}:${row.collector}`} className="border-t border-border/60">
                    <td className="py-1 pr-3">{row.browser}</td>
                    <td className="py-1 pr-3">{t(`analytics.coverage.mode.${row.collector}`)}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">{f.number(row.sessions)}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">
                      {f.percent(pct(row.returning_sessions, row.sessions))}
                    </td>
                    <td className="py-1 pr-3 text-right tabular-nums">
                      {f.percent(pct(row.identified_visitors, row.visitors))}
                    </td>
                    <td className="py-1 text-right tabular-nums">
                      {f.percent(pct(row.ad_sessions, row.sessions))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Panel>
  );
}
