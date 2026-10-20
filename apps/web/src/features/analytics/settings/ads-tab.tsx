import {
  AD_PLATFORMS,
  OUTBOUND_STATUSES,
  OUTBOUND_TARGETS,
  type AdConnection,
  type AdConnectionStatus,
  type AdPlatform,
  type OutboundConversionJob,
  type OutboundStatus,
  type OutboundTarget,
  type Site,
} from '@amable/api-types';
import type { MessageKey } from '@amable/i18n';
import { DashboardButton, DashboardConfirmDialog, DashboardFilterMenu, toast } from '@amable/ui';
import { Checkbox } from '@amable/ui/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { Label } from '@amable/ui/ui/label';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { CalendarClock, Crosshair, Plug, RefreshCw, Send, Unplug } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useI18n } from '../../../i18n';
import { ApiError } from '../../../lib/api';
import { analyticsErrorMessage, useAnalyticsMutation } from '../api';
import {
  funnelKeys,
  funnelsApi,
  rememberAdsOAuth,
  useAdConnections,
  useOutbound,
} from '../api-funnels';
import { EmptyNote, ErrorState, ListSkeleton, Panel, StatusPill } from '../components/ui';
import { useFormatters, useNow } from '../lib/format';
import { analyticsSettingsRoute, type SettingsSearch } from '../routes';

const STATUS_TONE: Record<AdConnectionStatus, 'success' | 'warning' | 'danger' | 'neutral'> = {
  active: 'success',
  auth_expired: 'warning',
  error: 'danger',
  disconnected: 'neutral',
};

const OUTBOUND_TONE: Record<OutboundStatus, 'success' | 'warning' | 'danger' | 'neutral'> = {
  pending: 'warning',
  sent: 'success',
  failed: 'danger',
  skipped: 'neutral',
};

/** Longest backfill range accepted by the API. */
const BACKFILL_MAX_DAYS = 90;
const DAY_MS = 86_400_000;

function isPlatform(value: string): value is AdPlatform {
  return (AD_PLATFORMS as readonly string[]).includes(value);
}

function ymd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function adsErrorToast(t: (key: MessageKey) => string, error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.code === 'integration_unavailable') toast.error(t('analytics.ads.connections.error.unavailable'));
  else if (error.code === 'ads_auth_expired') toast.error(t('analytics.ads.connections.error.authExpired'));
  else if (error.code === 'ads_provider_unavailable' || error.code === 'ads_provider_error')
    toast.error(t('analytics.ads.connections.error.provider'));
  else return false;
  return true;
}

/** Finishes the dev fake OAuth round-trip that lands on `?tab=ads&platform=…&state=…&code=…`. */
function useFakeCallback(tenant: string, site: Site) {
  const { t } = useI18n();
  const search = useSearch({ from: analyticsSettingsRoute.id });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const handled = useRef<string | null>(null);
  useEffect(() => {
    const { platform, state, code } = search;
    if (!platform || !state || !code || handled.current === state) return;
    handled.current = state;
    const clean = () =>
      void navigate({
        to: '/t/$tenant/analytics/settings',
        params: { tenant },
        search: (previous: SettingsSearch) => ({
          ...previous,
          tab: 'ads',
          platform: undefined,
          state: undefined,
          code: undefined,
        }),
        replace: true,
      });
    if (!isPlatform(platform)) {
      clean();
      return;
    }
    funnelsApi(tenant)
      .ads.callback(site.id, platform, { state, code })
      .then(() => {
        toast.success(t('analytics.ads.connections.connected'));
        return queryClient.invalidateQueries({ queryKey: funnelKeys.ads(tenant, site.id) });
      })
      .catch((error: unknown) => {
        if (!adsErrorToast(t, error)) toast.error(analyticsErrorMessage(t, error));
      })
      .finally(clean);
  }, [search, site.id, tenant, navigate, queryClient, t]);
}

function BackfillDialog({
  tenant,
  site,
  connection,
  onClose,
}: {
  tenant: string;
  site: Site;
  connection: AdConnection;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const today = ymd(Date.now());
  const [from, setFrom] = useState(ymd(Date.now() - 29 * DAY_MS));
  const [to, setTo] = useState(today);
  const days = Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1;
  const valid = Number.isFinite(days) && days >= 1 && days <= BACKFILL_MAX_DAYS;
  const backfill = useAnalyticsMutation(
    tenant,
    () => funnelsApi(tenant).ads.backfill(site.id, connection.id, { from, to }),
    {
      invalidate: [funnelKeys.ads(tenant, site.id)],
      onSuccess: (result) => {
        toast.success(t('analytics.ads.connections.backfilled', { rows: result.rows }));
        onClose();
      },
      onError: (error) => adsErrorToast(t, error),
    },
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) backfill.mutate(undefined);
  };
  const input =
    'h-8 rounded-md border border-(--obsidian-dashboard-shell-border) bg-(--obsidian-dashboard-shell-control) px-2 text-xs';
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t('analytics.ads.connections.backfillTitle')}</DialogTitle>
            <DialogDescription>
              {t('analytics.ads.connections.backfillHint', { max: BACKFILL_MAX_DAYS })}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1">
              <Label htmlFor="amb-backfill-from" className="text-xs">
                {t('analytics.controls.from')}
              </Label>
              <input
                id="amb-backfill-from"
                type="date"
                className={input}
                value={from}
                max={to}
                onChange={(e) => e.target.value && setFrom(e.target.value)}
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="amb-backfill-to" className="text-xs">
                {t('analytics.controls.to')}
              </Label>
              <input
                id="amb-backfill-to"
                type="date"
                className={input}
                value={to}
                min={from}
                max={today}
                onChange={(e) => e.target.value && setTo(e.target.value)}
              />
            </div>
          </div>
          {!valid ? (
            <span className="text-xs text-destructive">
              {t('analytics.ads.connections.backfillInvalid', { max: BACKFILL_MAX_DAYS })}
            </span>
          ) : null}
          <DialogFooter>
            <DashboardButton variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </DashboardButton>
            <DashboardButton type="submit" variant="primary" disabled={!valid || backfill.isPending}>
              {t('analytics.ads.connections.backfill')}
            </DashboardButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Platforms whose server-side conversions need a dataset/pixel ID set on the connection. */
const PIXEL_PLATFORMS: readonly AdPlatform[] = ['meta', 'tiktok'];
const PIXEL_ID = /^[A-Za-z0-9_-]{4,64}$/;
const TEST_CODE = /^[A-Za-z0-9_-]{1,64}$/;

function PixelDialog({
  tenant,
  site,
  connection,
  onClose,
}: {
  tenant: string;
  site: Site;
  connection: AdConnection;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [pixel, setPixel] = useState(connection.pixel_id ?? '');
  const [testCode, setTestCode] = useState(connection.test_event_code ?? '');
  const pixelValue = pixel.trim();
  const testValue = testCode.trim();
  const valid =
    (pixelValue === '' || PIXEL_ID.test(pixelValue)) && (testValue === '' || TEST_CODE.test(testValue));
  const platform = connection.platform === 'tiktok' ? 'tiktok' : 'meta';
  const save = useAnalyticsMutation(
    tenant,
    () =>
      funnelsApi(tenant).ads.settings(site.id, connection.id, {
        pixel_id: pixelValue || null,
        test_event_code: testValue || null,
      }),
    {
      invalidate: [funnelKeys.ads(tenant, site.id)],
      success: 'analytics.ads.pixel.saved',
      onSuccess: onClose,
    },
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) save.mutate(undefined);
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t('analytics.ads.pixel.title')}</DialogTitle>
            <DialogDescription>{t(`analytics.ads.pixel.hint.${platform}`)}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="amb-ads-pixel">{t(`analytics.ads.pixel.id.${platform}`)}</Label>
            <Input
              id="amb-ads-pixel"
              className="font-mono"
              value={pixel}
              maxLength={64}
              autoFocus
              aria-invalid={pixelValue !== '' && !PIXEL_ID.test(pixelValue)}
              onChange={(event) => setPixel(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="amb-ads-test-code">{t('analytics.ads.pixel.testCode')}</Label>
            <Input
              id="amb-ads-test-code"
              className="font-mono"
              value={testCode}
              maxLength={64}
              aria-invalid={testValue !== '' && !TEST_CODE.test(testValue)}
              onChange={(event) => setTestCode(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t('analytics.ads.pixel.testCodeHint')}</p>
          </div>
          <DialogFooter>
            <DashboardButton variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </DashboardButton>
            <DashboardButton type="submit" variant="primary" disabled={!valid || save.isPending}>
              {t('common.save')}
            </DashboardButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ConnectionsPanel({
  tenant,
  site,
  canConfigure,
}: {
  tenant: string;
  site: Site;
  canConfigure: boolean;
}) {
  const { t } = useI18n();
  const f = useFormatters();
  const now = useNow(60_000);
  const connections = useAdConnections(tenant, site.id);
  const [backfilling, setBackfilling] = useState<AdConnection | null>(null);
  const [pixelOf, setPixelOf] = useState<AdConnection | null>(null);
  const [disconnecting, setDisconnecting] = useState<AdConnection | null>(null);
  const api = funnelsApi(tenant);
  const connect = useAnalyticsMutation(
    tenant,
    (platform: AdPlatform) => api.ads.connect(site.id, platform),
    {
      invalidate: [],
      onSuccess: (result, platform) => {
        rememberAdsOAuth(result.state, { site_id: site.id, platform, slug: tenant });
        window.location.assign(result.authorize_url);
      },
      onError: (error) => adsErrorToast(t, error),
    },
  );
  const disconnect = useAnalyticsMutation(
    tenant,
    (id: string) => api.ads.disconnect(site.id, id),
    {
      invalidate: [funnelKeys.ads(tenant, site.id)],
      success: 'analytics.ads.connections.disconnected',
      onError: (error) => adsErrorToast(t, error),
    },
  );

  const data = connections.data;
  return (
    <Panel title={t('analytics.ads.connections.title')}>
      <p className="mb-3 text-xs text-muted-foreground">
        {t('analytics.ads.connections.hint')}
        {data?.fake ? ` ${t('analytics.ads.connections.fake')}` : ''}
      </p>
      {connections.error ? (
        <ErrorState error={connections.error} />
      ) : !data ? (
        <ListSkeleton rows={3} />
      ) : (
        <div className="grid gap-3 lg:grid-cols-3">
          {AD_PLATFORMS.map((platform) => {
            const rows = data.data.filter((c) => c.platform === platform);
            const available = data.available.includes(platform);
            return (
              <section
                key={platform}
                className="flex flex-col gap-2 rounded-lg bg-foreground/[0.03] p-3"
                data-testid={`ads-platform-${platform}`}
              >
                <header className="flex items-center gap-2">
                  <span className="flex-1 text-sm font-medium">
                    {t(`analytics.ads.connections.platform.${platform}`)}
                  </span>
                  {canConfigure ? (
                    <DashboardButton
                      variant="secondary"
                      size="sm"
                      disabled={!available || connect.isPending}
                      title={available ? undefined : t('analytics.ads.connections.notConfigured')}
                      onClick={() => connect.mutate(platform)}
                    >
                      <Plug aria-hidden />
                      {rows.some((c) => c.status === 'auth_expired')
                        ? t('analytics.ads.connections.reconnect')
                        : t('analytics.ads.connections.connect')}
                    </DashboardButton>
                  ) : null}
                </header>
                {!available ? (
                  <p className="text-[11px] text-muted-foreground">
                    {t('analytics.ads.connections.notConfigured')}
                  </p>
                ) : null}
                {rows.length === 0 ? (
                  <EmptyNote className="min-h-12 py-2">
                    {t('analytics.ads.connections.empty')}
                  </EmptyNote>
                ) : (
                  <ul className="flex flex-col divide-y divide-foreground/[0.06]">
                    {rows.map((c) => (
                      <li key={c.id} className="flex flex-col gap-1 py-2">
                        <span className="flex flex-wrap items-center gap-1.5 text-xs">
                          <span className="min-w-0 truncate font-medium">
                            {c.account_name ?? c.account_id}
                          </span>
                          <StatusPill tone={STATUS_TONE[c.status]}>
                            {t(`analytics.ads.connections.status.${c.status}`)}
                          </StatusPill>
                        </span>
                        <span className="text-[11px] text-muted-foreground">
                          {c.account_id}
                          {c.currency ? ` · ${c.currency}` : ''} ·{' '}
                          {t('analytics.ads.connections.lastSync', {
                            when: c.last_sync_at
                              ? f.relative(new Date(c.last_sync_at).toISOString(), now)
                              : t('analytics.common.never'),
                          })}
                        </span>
                        {PIXEL_PLATFORMS.includes(c.platform) && c.status !== 'disconnected' ? (
                          c.pixel_id ? (
                            <span className="text-[11px] text-muted-foreground">
                              {t(`analytics.ads.pixel.id.${c.platform === 'tiktok' ? 'tiktok' : 'meta'}`)}:{' '}
                              <span className="font-mono">{c.pixel_id}</span>
                              {c.test_event_code ? ` · ${t('analytics.ads.pixel.testMode')}` : ''}
                            </span>
                          ) : (
                            <span className="rounded bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300">
                              {t('analytics.ads.pixel.missing')}
                            </span>
                          )
                        ) : null}
                        {c.last_error ? (
                          <span className="rounded bg-destructive/[0.07] px-2 py-1 text-[11px] text-destructive">
                            {c.last_error}
                          </span>
                        ) : null}
                        {canConfigure && c.status !== 'disconnected' ? (
                          <span className="flex flex-wrap gap-1">
                            {PIXEL_PLATFORMS.includes(c.platform) ? (
                              <DashboardButton variant="ghost" size="sm" onClick={() => setPixelOf(c)}>
                                <Crosshair aria-hidden />
                                {t('analytics.ads.pixel.button')}
                              </DashboardButton>
                            ) : null}
                            <DashboardButton
                              variant="ghost"
                              size="sm"
                              onClick={() => setBackfilling(c)}
                            >
                              <CalendarClock aria-hidden />
                              {t('analytics.ads.connections.backfill')}
                            </DashboardButton>
                            <DashboardButton
                              variant="ghost"
                              size="sm"
                              onClick={() => setDisconnecting(c)}
                            >
                              <Unplug aria-hidden />
                              {t('analytics.ads.connections.disconnect')}
                            </DashboardButton>
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
      {backfilling ? (
        <BackfillDialog
          tenant={tenant}
          site={site}
          connection={backfilling}
          onClose={() => setBackfilling(null)}
        />
      ) : null}
      {pixelOf ? (
        <PixelDialog
          tenant={tenant}
          site={site}
          connection={pixelOf}
          onClose={() => setPixelOf(null)}
        />
      ) : null}
      <DashboardConfirmDialog
        open={disconnecting !== null}
        onOpenChange={(open) => !open && setDisconnecting(null)}
        title={t('analytics.ads.connections.disconnectTitle', {
          account: disconnecting?.account_name ?? disconnecting?.account_id ?? '',
        })}
        description={t('analytics.ads.connections.disconnectBody')}
        confirmLabel={t('analytics.ads.connections.disconnect')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onConfirm={() => {
          if (disconnecting) disconnect.mutate(disconnecting.id);
          setDisconnecting(null);
        }}
      />
    </Panel>
  );
}

const ALL = 'all';

function OutboundPanel({
  tenant,
  site,
  canConfigure,
}: {
  tenant: string;
  site: Site;
  canConfigure: boolean;
}) {
  const { t } = useI18n();
  const f = useFormatters();
  const now = useNow(30_000);
  const [status, setStatus] = useState<OutboundStatus | typeof ALL>(ALL);
  const [platform, setPlatform] = useState<OutboundTarget | typeof ALL>(ALL);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const log = useOutbound(tenant, site.id, {
    ...(status !== ALL ? { status } : {}),
    ...(platform !== ALL ? { platform } : {}),
    limit: 200,
  });
  const api = funnelsApi(tenant);
  const requeued = (result: { requeued: number }) =>
    toast.success(t('analytics.ads.outbound.requeued', { count: result.requeued }));
  const resendOne = useAnalyticsMutation(tenant, (id: string) => api.outbound.resend(site.id, id), {
    invalidate: [funnelKeys.outbound(tenant, site.id)],
    onSuccess: requeued,
  });
  const resendSelected = useAnalyticsMutation(
    tenant,
    () => api.outbound.resendMany(site.id, { ids: [...selected] }),
    {
      invalidate: [funnelKeys.outbound(tenant, site.id)],
      onSuccess: (result) => {
        requeued(result);
        setSelected(new Set());
      },
    },
  );
  const resendFailed = useAnalyticsMutation(
    tenant,
    () => api.outbound.resendMany(site.id, platform !== ALL ? { platform } : {}),
    { invalidate: [funnelKeys.outbound(tenant, site.id)], onSuccess: requeued },
  );

  const jobs = log.data?.data ?? [];
  const failed = jobs.filter((j) => j.status === 'failed');
  const toggle = (job: OutboundConversionJob, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(job.id);
      else next.delete(job.id);
      return next;
    });
  const value = (job: OutboundConversionJob) =>
    job.payload.value_minor !== null && job.payload.value_minor !== undefined && job.payload.currency
      ? f.money(job.payload.value_minor, job.payload.currency)
      : '—';

  return (
    <Panel
      title={t('analytics.ads.outbound.title')}
      actions={
        <>
          <DashboardFilterMenu
            label={t('analytics.ads.outbound.status')}
            value={status}
            options={[
              { value: ALL, label: t('analytics.ads.outbound.all') },
              ...OUTBOUND_STATUSES.map((s) => ({
                value: s,
                label: t(`analytics.ads.outbound.status.${s}`),
              })),
            ]}
            onValueChange={(v) => {
              setStatus(v as OutboundStatus | typeof ALL);
              setSelected(new Set());
            }}
          />
          <DashboardFilterMenu
            label={t('analytics.ads.outbound.platform')}
            value={platform}
            options={[
              { value: ALL, label: t('analytics.ads.outbound.allPlatforms') },
              ...OUTBOUND_TARGETS.map((p) => ({
                value: p,
                label: t(`analytics.ads.connections.platform.${p}`),
              })),
            ]}
            onValueChange={(v) => {
              setPlatform(v as OutboundTarget | typeof ALL);
              setSelected(new Set());
            }}
          />
          {canConfigure ? (
            <>
              <DashboardButton
                variant="secondary"
                size="sm"
                disabled={selected.size === 0 || resendSelected.isPending}
                onClick={() => resendSelected.mutate(undefined)}
              >
                <Send aria-hidden />
                {t('analytics.ads.outbound.resendSelected', { count: selected.size })}
              </DashboardButton>
              <DashboardButton
                variant="ghost"
                size="sm"
                disabled={(log.data?.stats.failed ?? 0) === 0 || resendFailed.isPending}
                onClick={() => resendFailed.mutate(undefined)}
              >
                <RefreshCw aria-hidden />
                {t('analytics.ads.outbound.resendFailed')}
              </DashboardButton>
            </>
          ) : null}
        </>
      }
    >
      <p className="mb-2 text-xs text-muted-foreground">{t('analytics.ads.outbound.hint')}</p>
      {log.data ? (
        <div className="mb-2 flex flex-wrap gap-1.5" data-testid="outbound-stats">
          {OUTBOUND_STATUSES.map((s) => (
            <StatusPill key={s} tone={OUTBOUND_TONE[s]}>
              {t(`analytics.ads.outbound.status.${s}`)} · {f.number(log.data.stats[s])}
            </StatusPill>
          ))}
          {log.data.truncated ? (
            <StatusPill tone="warning">
              {t('analytics.ads.outbound.truncated', { count: f.number(jobs.length) })}
            </StatusPill>
          ) : null}
        </div>
      ) : null}
      {log.error ? (
        <ErrorState error={log.error} />
      ) : !log.data ? (
        <ListSkeleton rows={4} />
      ) : jobs.length === 0 ? (
        <EmptyNote>{t('analytics.ads.outbound.empty')}</EmptyNote>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[46rem] text-xs">
            <thead>
              <tr className="text-left text-[11px] text-muted-foreground">
                <th className="w-8 py-1">
                  {canConfigure && failed.length > 0 ? (
                    <Checkbox
                      aria-label={t('analytics.ads.outbound.selectAll')}
                      checked={failed.every((j) => selected.has(j.id))}
                      onCheckedChange={(on) =>
                        setSelected(on === true ? new Set(failed.map((j) => j.id)) : new Set())
                      }
                    />
                  ) : null}
                </th>
                <th className="py-1 font-medium">{t('analytics.ads.outbound.when')}</th>
                <th className="py-1 font-medium">{t('analytics.ads.outbound.platform')}</th>
                <th className="py-1 font-medium">{t('analytics.ads.outbound.event')}</th>
                <th className="py-1 text-right font-medium">{t('analytics.ads.outbound.value')}</th>
                <th className="py-1 pl-4 font-medium">{t('analytics.ads.outbound.status')}</th>
                <th className="py-1 text-right font-medium">{t('analytics.ads.outbound.attempts')}</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody className="divide-y divide-foreground/[0.06]">
              {jobs.map((job) => (
                <tr key={job.id} className="align-top" data-testid={`outbound-${job.id}`}>
                  <td className="py-1.5">
                    {canConfigure && job.status === 'failed' ? (
                      <Checkbox
                        aria-label={t('analytics.ads.outbound.select')}
                        checked={selected.has(job.id)}
                        onCheckedChange={(on) => toggle(job, on === true)}
                      />
                    ) : null}
                  </td>
                  <td className="py-1.5 whitespace-nowrap">
                    {f.relative(new Date(job.created_at).toISOString(), now)}
                  </td>
                  <td className="py-1.5">{t(`analytics.ads.connections.platform.${job.platform}`)}</td>
                  <td className="py-1.5">
                    <span className="font-mono">{job.payload.event_name}</span>
                    {job.last_error ? (
                      <span className="mt-0.5 block max-w-[22rem] truncate text-[11px] text-destructive" title={job.last_error}>
                        {job.last_error}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">{value(job)}</td>
                  <td className="py-1.5 pl-4">
                    <StatusPill tone={OUTBOUND_TONE[job.status]}>
                      {t(`analytics.ads.outbound.status.${job.status}`)}
                    </StatusPill>
                  </td>
                  <td className="py-1.5 text-right tabular-nums">{job.attempts}</td>
                  <td className="py-1.5 text-right">
                    {canConfigure && job.status === 'failed' ? (
                      <DashboardButton
                        variant="ghost"
                        size="sm"
                        disabled={resendOne.isPending}
                        onClick={() => resendOne.mutate(job.id)}
                      >
                        <Send aria-hidden />
                        {t('analytics.ads.outbound.resend')}
                      </DashboardButton>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/** Settings tab `ads`: ad platform connections (OAuth, backfill) and the outbound conversion log. */
export function AdsTab({
  tenant,
  site,
  canConfigure,
}: {
  tenant: string;
  site: Site;
  canConfigure: boolean;
}) {
  useFakeCallback(tenant, site);
  return (
    <>
      <ConnectionsPanel tenant={tenant} site={site} canConfigure={canConfigure} />
      <OutboundPanel tenant={tenant} site={site} canConfigure={canConfigure} />
    </>
  );
}
