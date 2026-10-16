import type { Site, SiteKey, SiteKeyScope } from '@amable/api-types';
import { DashboardButton, DashboardConfirmDialog } from '@amable/ui';
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
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useI18n } from '../../../i18n';
import { useStepUp } from '../../developers/components';
import { analyticsApi, analyticsKeys, useAnalyticsMutation, useSiteKeys } from '../api';
import { SecretReveal } from '../components/copy';
import { EmptyNote, ErrorState, ListSkeleton, Panel, StatusPill } from '../components/ui';
import { useFormatters, useNow } from '../lib/format';

function CreateKeyDialog({
  tenant,
  site,
  onClose,
}: {
  tenant: string;
  site: Site;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const api = analyticsApi(tenant);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<SiteKeyScope[]>(['read']);
  const [secret, setSecret] = useState<string | null>(null);
  const { guard, dialog: stepUpDialog } = useStepUp();
  const create = useAnalyticsMutation(
    tenant,
    () => api.sites.createKey(site.id, { name: name.trim(), scopes }),
    {
      invalidate: [analyticsKeys.site(tenant, site.id, 'keys')],
      onSuccess: (result) => setSecret(result.secret),
      onError: (error) => guard(error, () => create.mutate(undefined)),
    },
  );
  const toggle = (scope: SiteKeyScope, on: boolean) =>
    setScopes((current) =>
      on ? [...new Set([...current, scope])] : current.filter((item) => item !== scope),
    );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() && scopes.length > 0) create.mutate(undefined);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        {secret ? (
          <div className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>{t('analytics.keys.createdTitle')}</DialogTitle>
              <DialogDescription>{t('analytics.keys.createdHint')}</DialogDescription>
            </DialogHeader>
            <SecretReveal secret={secret} />
            <DialogFooter>
              <DashboardButton variant="primary" onClick={onClose}>
                {t('analytics.common.done')}
              </DashboardButton>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>{t('analytics.keys.newTitle')}</DialogTitle>
              <DialogDescription>{t('analytics.keys.newHint')}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="amb-key-name">{t('analytics.common.name')}</Label>
              <Input
                id="amb-key-name"
                value={name}
                maxLength={100}
                onChange={(event) => setName(event.target.value)}
                autoFocus
              />
            </div>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">{t('analytics.keys.scopes')}</legend>
              {(['read', 'write'] as const).map((scope) => (
                <label key={scope} className="flex items-start gap-2.5 text-sm">
                  <Checkbox
                    checked={scopes.includes(scope)}
                    onCheckedChange={(checked) => toggle(scope, checked === true)}
                  />
                  <span className="flex flex-col">
                    <span className="font-medium">{t(`analytics.keys.scope.${scope}`)}</span>
                    <span className="text-xs text-muted-foreground">
                      {t(`analytics.keys.scopeHint.${scope}`)}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
            <DialogFooter>
              <DashboardButton variant="secondary" onClick={onClose}>
                {t('common.cancel')}
              </DashboardButton>
              <DashboardButton
                type="submit"
                variant="primary"
                disabled={!name.trim() || scopes.length === 0 || create.isPending}
              >
                {t('analytics.keys.create')}
              </DashboardButton>
            </DialogFooter>
          </form>
        )}
        {stepUpDialog}
      </DialogContent>
    </Dialog>
  );
}

export function KeysTab({
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
  const keys = useSiteKeys(tenant, site.id);
  const api = analyticsApi(tenant);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<SiteKey | null>(null);
  const revoke = useAnalyticsMutation(tenant, (id: string) => api.sites.revokeKey(site.id, id), {
    invalidate: [analyticsKeys.site(tenant, site.id, 'keys')],
    success: 'analytics.keys.revoked',
  });

  return (
    <Panel
      title={t('analytics.keys.title')}
      actions={
        canConfigure ? (
          <DashboardButton variant="primary" onClick={() => setCreating(true)}>
            <Plus aria-hidden />
            {t('analytics.keys.new')}
          </DashboardButton>
        ) : null
      }
    >
      <p className="mb-3 text-xs text-muted-foreground">{t('analytics.keys.hint')}</p>
      {keys.error ? (
        <ErrorState error={keys.error} />
      ) : !keys.data ? (
        <ListSkeleton rows={3} />
      ) : keys.data.data.length === 0 ? (
        <EmptyNote>{t('analytics.keys.empty')}</EmptyNote>
      ) : (
        <ul className="flex flex-col divide-y divide-foreground/[0.06]">
          {keys.data.data.map((key) => (
            <li key={key.id} className="flex flex-wrap items-center gap-3 py-2.5">
              <KeyRound className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="flex flex-wrap items-center gap-1.5 text-sm">
                  <span className="font-medium">{key.name}</span>
                  <code className="rounded bg-foreground/[0.05] px-1.5 font-mono text-[11px]">
                    {key.prefix}…
                  </code>
                  {key.scopes.map((scope) => (
                    <StatusPill key={scope} tone={scope === 'write' ? 'warning' : 'neutral'}>
                      {t(`analytics.keys.scope.${scope}`)}
                    </StatusPill>
                  ))}
                  {key.revoked_at ? (
                    <StatusPill tone="danger">{t('analytics.keys.revokedPill')}</StatusPill>
                  ) : null}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t('analytics.keys.meta', {
                    created: f.date(key.created_at),
                    used: key.last_used_at
                      ? f.relative(key.last_used_at, now)
                      : t('analytics.common.never'),
                  })}
                </span>
              </div>
              {canConfigure && !key.revoked_at ? (
                <DashboardButton
                  variant="ghost"
                  size="icon"
                  aria-label={t('analytics.keys.revoke')}
                  onClick={() => setRevoking(key)}
                >
                  <Trash2 aria-hidden />
                </DashboardButton>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {creating ? (
        <CreateKeyDialog tenant={tenant} site={site} onClose={() => setCreating(false)} />
      ) : null}
      <DashboardConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={t('analytics.keys.revokeTitle', { name: revoking?.name ?? '' })}
        description={t('analytics.keys.revokeBody')}
        confirmLabel={t('analytics.keys.revoke')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onConfirm={() => {
          if (revoking) revoke.mutate(revoking.id);
          setRevoking(null);
        }}
      />
    </Panel>
  );
}
