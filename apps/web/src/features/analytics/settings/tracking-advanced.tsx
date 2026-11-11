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
