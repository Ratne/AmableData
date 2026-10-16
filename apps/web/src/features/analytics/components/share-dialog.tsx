import type { Share, Site } from '@amable/api-types';
import { DashboardButton, DashboardConfirmDialog } from '@amable/ui';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { ExternalLink, Link2, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useI18n } from '../../../i18n';
import { analyticsApi, analyticsKeys, useAnalyticsMutation, useShares } from '../api';
import { useFormatters, useNow } from '../lib/format';
import { CopyButton } from './copy';
import { EmptyNote, ErrorState, ListSkeleton, StatusPill } from './ui';

/** Create, copy and revoke the public read-only links of a site. */
export function ShareManager({ tenant, site }: { tenant: string; site: Site }) {
  const { t } = useI18n();
  const f = useFormatters();
  const now = useNow(60_000);
  const shares = useShares(tenant, site.id);
  const api = analyticsApi(tenant);
  const [name, setName] = useState('');
  const [revoking, setRevoking] = useState<Share | null>(null);
  const invalidate = [analyticsKeys.site(tenant, site.id, 'shares')];
  const create = useAnalyticsMutation(
    tenant,
    (value: string) => api.shares.create(site.id, value),
    {
      invalidate,
      success: 'analytics.share.created',
      onSuccess: () => setName(''),
    },
  );
  const revoke = useAnalyticsMutation(tenant, (id: string) => api.shares.revoke(site.id, id), {
    invalidate,
    success: 'analytics.share.revoked',
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim()) create.mutate(name.trim());
  };

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={submit} className="flex gap-2">
        <Input
          value={name}
          maxLength={100}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('analytics.share.namePlaceholder')}
          aria-label={t('analytics.common.name')}
        />
        <DashboardButton
          type="submit"
          variant="primary"
          size="md"
          disabled={!name.trim() || create.isPending}
        >
          <Link2 aria-hidden />
          {t('analytics.share.create')}
        </DashboardButton>
      </form>
      {shares.error ? (
        <ErrorState error={shares.error} />
      ) : !shares.data ? (
        <ListSkeleton rows={3} />
      ) : shares.data.data.length === 0 ? (
        <EmptyNote>{t('analytics.share.empty')}</EmptyNote>
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border">
          {shares.data.data.map((share) => {
            const revoked = share.revoked_at !== null;
            return (
              <li key={share.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-center gap-2 text-sm">
                    <span className="truncate font-medium">{share.name}</span>
                    {revoked ? (
                      <StatusPill tone="neutral">{t('analytics.share.revokedPill')}</StatusPill>
                    ) : null}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {t('analytics.share.meta', {
                      created: f.date(share.created_at),
                      used: share.last_used_at
                        ? f.relative(share.last_used_at, now)
                        : t('analytics.common.never'),
                    })}
                  </span>
                </div>
                {!revoked ? (
                  <div className="flex items-center gap-1">
                    <CopyButton text={share.url} label={t('analytics.share.copyLink')} />
                    <a
                      href={share.url}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={t('analytics.share.open')}
                      className="inline-flex size-[30px] items-center justify-center rounded-lg text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
                    >
                      <ExternalLink className="size-3.5" aria-hidden />
                    </a>
                    <DashboardButton
                      variant="ghost"
                      size="icon"
                      aria-label={t('analytics.share.revoke')}
                      onClick={() => setRevoking(share)}
                    >
                      <Trash2 aria-hidden />
                    </DashboardButton>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <DashboardConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={t('analytics.share.revokeTitle', { name: revoking?.name ?? '' })}
        description={t('analytics.share.revokeBody')}
        confirmLabel={t('analytics.share.revoke')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onConfirm={() => {
          if (revoking) revoke.mutate(revoking.id);
          setRevoking(null);
        }}
      />
    </div>
  );
}

export function ShareDialog({
  tenant,
  site,
  onClose,
}: {
  tenant: string;
  site: Site;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('analytics.share.title', { site: site.name })}</DialogTitle>
          <DialogDescription>{t('analytics.share.hint')}</DialogDescription>
        </DialogHeader>
        <ShareManager tenant={tenant} site={site} />
      </DialogContent>
    </Dialog>
  );
}
