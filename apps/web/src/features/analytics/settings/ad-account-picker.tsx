import type { AdConnection, AdPlatform } from '@amable/api-types';
import { DashboardButton } from '@amable/ui';
import { Checkbox } from '@amable/ui/ui/checkbox';
import { Input } from '@amable/ui/ui/input';
import { LoaderCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useI18n } from '../../../i18n';
import { useAnalyticsMutation } from '../api';
import { funnelKeys, funnelsApi, type AdAccountSelection } from '../api-funnels';

/**
 * Ad accounts of a fresh authorization: the user picks which ones to connect
 * (already connected ones start checked). Cancelling drops the authorization.
 */
export function AdAccountPicker({
  tenant,
  siteId,
  platform,
  selection,
  onConnected,
  onCancelled,
}: {
  tenant: string;
  siteId: string;
  platform: AdPlatform;
  selection: AdAccountSelection;
  onConnected: (connections: AdConnection[]) => void;
  onCancelled: () => void;
}) {
  const { t } = useI18n();
  const api = funnelsApi(tenant);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        selection.accounts
          .filter((a) => a.connected)
          .slice(0, selection.max)
          .map((a) => a.account_id),
      ),
  );
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return selection.accounts;
    return selection.accounts.filter(
      (a) => a.name.toLowerCase().includes(needle) || a.account_id.toLowerCase().includes(needle),
    );
  }, [query, selection.accounts]);
  const connect = useAnalyticsMutation(
    tenant,
    () => api.ads.pickAccounts(siteId, platform, { grant_id: selection.grant_id, account_ids: [...picked] }),
    {
      invalidate: [funnelKeys.ads(tenant, siteId)],
      success: 'analytics.ads.connections.connected',
      onSuccess: (result) => onConnected(result.data),
    },
  );
  const cancel = () => {
    void api.ads.cancelAuthorization(siteId, platform, selection.grant_id).catch(() => undefined);
    onCancelled();
  };
  const toggle = (accountId: string, on: boolean) =>
    setPicked((current) => {
      const next = new Set(current);
      if (on) next.add(accountId);
      else next.delete(accountId);
      return next;
    });
  const full = picked.size >= selection.max;

  return (
    <div className="flex w-full flex-col gap-3 text-left" data-testid="ad-account-picker">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold">{t('analytics.ads.pick.title')}</h2>
        <p className="text-xs text-muted-foreground">
          {t('analytics.ads.pick.hint', { count: selection.accounts.length, max: selection.max })}
        </p>
      </div>
      <Input
        value={query}
        placeholder={t('analytics.ads.pick.search')}
        aria-label={t('analytics.ads.pick.search')}
        onChange={(event) => setQuery(event.target.value)}
        disabled={connect.isPending}
      />
      <ul className="flex max-h-[50dvh] flex-col divide-y divide-foreground/[0.06] overflow-y-auto rounded-md border border-foreground/[0.08]">
        {visible.length === 0 ? (
          <li className="px-3 py-4 text-center text-xs text-muted-foreground">{t('analytics.ads.pick.none')}</li>
        ) : (
          visible.map((account) => {
            const checked = picked.has(account.account_id);
            const id = `amb-ad-account-${account.account_id}`;
            return (
              <li key={account.account_id} className="flex items-center gap-3 px-3 py-2">
                <Checkbox
                  id={id}
                  checked={checked}
                  disabled={connect.isPending || (!checked && full)}
                  onCheckedChange={(on) => toggle(account.account_id, on === true)}
                />
                <label htmlFor={id} className="flex min-w-0 flex-1 cursor-pointer flex-col">
                  <span className="truncate text-sm font-medium">{account.name || account.account_id}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {account.account_id} · {account.currency}
                    {account.connected ? ` · ${t('analytics.ads.pick.connected')}` : ''}
                  </span>
                </label>
              </li>
            );
          })
        )}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex-1 text-xs text-muted-foreground">
          {connect.isPending ? (
            <span className="inline-flex items-center gap-1.5">
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
              {t('analytics.ads.pick.connecting')}
            </span>
          ) : (
            t('analytics.ads.pick.selected', { count: picked.size, max: selection.max })
          )}
        </span>
        <DashboardButton variant="secondary" onClick={cancel} disabled={connect.isPending}>
          {t('common.cancel')}
        </DashboardButton>
        <DashboardButton
          variant="primary"
          disabled={picked.size === 0 || connect.isPending}
          onClick={() => connect.mutate(undefined)}
        >
          {t('analytics.ads.pick.connect')}
        </DashboardButton>
      </div>
    </div>
  );
}
