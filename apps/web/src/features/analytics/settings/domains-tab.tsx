import type { Site, TrackingDomain, TrackingDomainStatus } from '@amable/api-types';
import type { MessageKey } from '@amable/i18n';
import { DashboardButton, DashboardConfirmDialog, toast } from '@amable/ui';
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
import { Globe, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useI18n } from '../../../i18n';
import { ApiError } from '../../../lib/api';
import { useAnalyticsMutation } from '../api';
import {
  trackingDomainKeys,
  trackingDomainsApi,
  useTrackingDomains,
} from '../api-tracking-domains';
import { CopyButton } from '../components/copy';
import { EmptyNote, ErrorState, ListSkeleton, Panel, StatusPill } from '../components/ui';
import { useFormatters, useNow } from '../lib/format';

const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const STATUS_TONE: Record<TrackingDomainStatus, 'success' | 'warning' | 'danger'> = {
  active: 'success',
  pending_dns: 'warning',
  pending_ssl: 'warning',
  error: 'danger',
};

/** Toast for the errors specific to tracking domains; true when handled. */
function domainErrorToast(t: (key: MessageKey) => string, error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.status === 409) toast.error(t('analytics.domains.error.taken'));
  else if (error.status === 422) toast.error(t('analytics.domains.error.invalid'));
  else if (error.code === 'tracking_domains_unavailable')
    toast.error(t('analytics.domains.error.unavailable'));
  else if (error.code === 'tracking_domain_provider_error')
    toast.error(t('analytics.domains.error.provider'));
  else return false;
  return true;
}

function AddDomainDialog({
  tenant,
  site,
  onClose,
}: {
  tenant: string;
  site: Site;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [hostname, setHostname] = useState('');
  const value = hostname
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  const valid = HOSTNAME_RE.test(value);
  const create = useAnalyticsMutation(
    tenant,
    () => trackingDomainsApi(tenant).create({ site_id: site.id, hostname: value }),
    {
      invalidate: [trackingDomainKeys.list(tenant, site.id)],
      success: 'analytics.domains.added',
      onSuccess: onClose,
      onError: (error) => domainErrorToast(t, error),
    },
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) create.mutate(undefined);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t('analytics.domains.newTitle')}</DialogTitle>
            <DialogDescription>{t('analytics.domains.newHint')}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="amb-tracking-hostname">{t('analytics.domains.hostname')}</Label>
            <Input
              id="amb-tracking-hostname"
              value={hostname}
              placeholder="track.example.com"
              maxLength={253}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setHostname(event.target.value)}
              aria-invalid={hostname !== '' && !valid}
              autoFocus
            />
            {hostname !== '' && !valid ? (
              <span className="text-xs text-destructive">
                {t('analytics.domains.error.invalid')}
              </span>
            ) : null}
          </div>
          <DialogFooter>
            <DashboardButton variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </DashboardButton>
            <DashboardButton type="submit" variant="primary" disabled={!valid || create.isPending}>
              {t('analytics.domains.add')}
            </DashboardButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DnsRecordRow({ type, name, value }: { type: string; name: string; value: string }) {
  const { t } = useI18n();
  return (
    <div className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 py-2 sm:grid-cols-[3.5rem_minmax(0,1fr)_minmax(0,1fr)]">
      <code className="font-mono text-[11px] font-semibold">{type}</code>
      <div className="flex min-w-0 items-center gap-2">
        <code className="min-w-0 flex-1 truncate font-mono text-[11.5px]" title={name}>
          {name}
        </code>
        <CopyButton text={name} label={t('analytics.domains.copyName')} />
      </div>
      <div className="col-start-2 flex min-w-0 items-center gap-2 sm:col-start-3">
        <code className="min-w-0 flex-1 truncate font-mono text-[11.5px]" title={value}>
          {value}
        </code>
        <CopyButton text={value} label={t('analytics.domains.copyValue')} />
      </div>
    </div>
  );
}

function DomainItem({
  tenant,
  domain,
  canConfigure,
  onDelete,
}: {
  tenant: string;
  domain: TrackingDomain;
  canConfigure: boolean;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const f = useFormatters();
  const now = useNow(60_000);
  const check = useAnalyticsMutation(tenant, () => trackingDomainsApi(tenant).check(domain.id), {
    invalidate: [trackingDomainKeys.list(tenant, domain.site_id)],
    onSuccess: (result) =>
      result.status === 'active'
        ? toast.success(t('analytics.domains.nowActive'))
        : toast.message(t(`analytics.domains.status.${result.status}`)),
    onError: (error) => domainErrorToast(t, error),
  });
  const active = domain.status === 'active';

  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <Globe className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex flex-wrap items-center gap-1.5 text-sm">
            <span className="truncate font-medium">{domain.hostname}</span>
            <StatusPill tone={STATUS_TONE[domain.status]}>
              {t(`analytics.domains.status.${domain.status}`)}
            </StatusPill>
          </span>
          <span className="text-xs text-muted-foreground">
            {t('analytics.domains.checked', {
              when: domain.checked_at
                ? f.relative(new Date(domain.checked_at).toISOString(), now)
                : t('analytics.common.never'),
            })}
          </span>
        </div>
        {canConfigure ? (
          <>
            <DashboardButton
              variant="secondary"
              size="sm"
              onClick={() => check.mutate(undefined)}
              disabled={check.isPending}
            >
              <RefreshCw className={check.isPending ? 'animate-spin' : undefined} aria-hidden />
              {t('analytics.domains.checkNow')}
            </DashboardButton>
            <DashboardButton
              variant="ghost"
              size="icon"
              aria-label={t('analytics.domains.delete')}
              onClick={onDelete}
            >
              <Trash2 aria-hidden />
            </DashboardButton>
          </>
        ) : null}
      </div>
      {domain.error ? (
        <p className="rounded-md bg-destructive/[0.07] px-2.5 py-1.5 text-xs text-destructive">
          {domain.error}
        </p>
      ) : null}
      {active ? null : (
        <div className="rounded-lg bg-foreground/[0.03] px-3 py-1">
          <p className="pt-2 text-xs text-muted-foreground">
            {t('analytics.domains.instructions')}
          </p>
          <div className="divide-y divide-foreground/[0.06]">
            <DnsRecordRow
              type="CNAME"
              name={domain.dns.cname_name}
              value={domain.dns.cname_target}
            />
            {domain.dns.txt_name && domain.dns.txt_value ? (
              <DnsRecordRow type="TXT" name={domain.dns.txt_name} value={domain.dns.txt_value} />
            ) : null}
          </div>
        </div>
      )}
    </li>
  );
}

/** Settings tab `domains`: custom tracking hostnames of the site (CNAME to the edge). */
export function DomainsTab({
  tenant,
  site,
  canConfigure,
}: {
  tenant: string;
  site: Site;
  canConfigure: boolean;
}) {
  const { t } = useI18n();
  const domains = useTrackingDomains(tenant, site.id);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<TrackingDomain | null>(null);
  const remove = useAnalyticsMutation(
    tenant,
    (id: string) => trackingDomainsApi(tenant).remove(id),
    {
      invalidate: [trackingDomainKeys.list(tenant, site.id)],
      success: 'analytics.domains.deleted',
      onError: (error) => domainErrorToast(t, error),
    },
  );

  return (
    <Panel
      title={t('analytics.domains.title')}
      actions={
        canConfigure ? (
          <DashboardButton variant="primary" onClick={() => setAdding(true)}>
            <Plus aria-hidden />
            {t('analytics.domains.new')}
          </DashboardButton>
        ) : null
      }
    >
      <p className="mb-3 text-xs text-muted-foreground">{t('analytics.domains.hint')}</p>
      {domains.error ? (
        <ErrorState error={domains.error} />
      ) : !domains.data ? (
        <ListSkeleton rows={2} />
      ) : domains.data.data.length === 0 ? (
        <EmptyNote>{t('analytics.domains.empty')}</EmptyNote>
      ) : (
        <ul className="flex flex-col divide-y divide-foreground/[0.06]">
          {domains.data.data.map((domain) => (
            <DomainItem
              key={domain.id}
              tenant={tenant}
              domain={domain}
              canConfigure={canConfigure}
              onDelete={() => setDeleting(domain)}
            />
          ))}
        </ul>
      )}
      {adding ? (
        <AddDomainDialog tenant={tenant} site={site} onClose={() => setAdding(false)} />
      ) : null}
      <DashboardConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('analytics.domains.deleteTitle', { hostname: deleting?.hostname ?? '' })}
        description={t('analytics.domains.deleteBody')}
        confirmLabel={t('analytics.domains.delete')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
          setDeleting(null);
        }}
      />
    </Panel>
  );
}
