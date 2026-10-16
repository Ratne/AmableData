import type { Site, SiteWithSecret } from '@amable/api-types';
import { DashboardButton, DashboardConfirmDialog } from '@amable/ui';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@amable/ui/ui/dialog';
import { Globe2, KeyRound, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../../../i18n';
import { useStepUp } from '../../developers/components';
import { analyticsApi, analyticsKeys, useAnalyticsMutation } from '../api';
import { CodeBlock, SecretReveal } from '../components/copy';
import { EmptyNote, Panel, StatusPill } from '../components/ui';
import { useFormatters } from '../lib/format';
import { modelLabel } from '../lib/labels';
import { SiteFormDialog, type SiteFormValue } from './site-form';

export function SitesTab({
  tenant,
  sites,
  canConfigure,
  createOpen,
  onCreateOpenChange,
  onSiteCreated,
}: {
  tenant: string;
  sites: readonly Site[];
  canConfigure: boolean;
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
  onSiteCreated: (site: Site) => void;
}) {
  const { t } = useI18n();
  const f = useFormatters();
  const api = analyticsApi(tenant);
  const [editing, setEditing] = useState<Site | null>(null);
  const [deleting, setDeleting] = useState<Site | null>(null);
  const [rolling, setRolling] = useState<Site | null>(null);
  const [created, setCreated] = useState<SiteWithSecret | null>(null);
  const [secret, setSecret] = useState<{ site: Site; secret: string } | null>(null);
  const invalidate = [analyticsKeys.root(tenant)];

  const create = useAnalyticsMutation(tenant, (value: SiteFormValue) => api.sites.create(value), {
    invalidate,
    onSuccess: (result) => {
      onCreateOpenChange(false);
      setCreated(result);
      onSiteCreated(result.site);
    },
  });
  const update = useAnalyticsMutation(
    tenant,
    (input: { id: string; value: SiteFormValue }) => api.sites.update(input.id, input.value),
    { invalidate, success: 'analytics.sites.updated', onSuccess: () => setEditing(null) },
  );
  const remove = useAnalyticsMutation(tenant, (id: string) => api.sites.remove(id), {
    invalidate,
    success: 'analytics.sites.deleted',
  });
  const { guard, dialog: stepUpDialog } = useStepUp();
  const roll = useAnalyticsMutation(tenant, (site: Site) => api.sites.rollSecret(site.id), {
    invalidate,
    onSuccess: (result, site) => setSecret({ site, secret: result.secret }),
    onError: (error, site) => guard(error, () => roll.mutate(site)),
  });

  return (
    <div className="flex flex-col gap-[7px]">
      <Panel
        title={t('analytics.sites.title')}
        actions={
          canConfigure ? (
            <DashboardButton variant="primary" onClick={() => onCreateOpenChange(true)}>
              <Plus aria-hidden />
              {t('analytics.sites.new')}
            </DashboardButton>
          ) : null
        }
      >
        {sites.length === 0 ? (
          <EmptyNote>{t('analytics.empty.body')}</EmptyNote>
        ) : (
          <ul className="flex flex-col divide-y divide-foreground/[0.06]">
            {sites.map((site) => (
              <li key={site.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Globe2 className="size-4" aria-hidden />
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-1.5 text-sm">
                    <span className="font-medium">{site.name}</span>
                    {site.cookieless ? (
                      <StatusPill tone="neutral">{t('analytics.sites.cookieless')}</StatusPill>
                    ) : null}
                    {site.allow_localhost ? (
                      <StatusPill tone="neutral">localhost</StatusPill>
                    ) : null}
                    {!site.has_secret ? (
                      <StatusPill tone="warning">{t('analytics.sites.noSecret')}</StatusPill>
                    ) : null}
                  </span>
                  <span className="flex flex-wrap gap-1">
                    {site.hostnames.map((host) => (
                      <span
                        key={host}
                        className="rounded bg-foreground/[0.05] px-1.5 py-0.5 font-mono text-[11px]"
                      >
                        {host}
                      </span>
                    ))}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t('analytics.sites.meta', {
                      timezone: site.timezone,
                      currency: site.currency,
                      retention:
                        site.retention_days === 0
                          ? t('analytics.sites.forever')
                          : t('analytics.sites.days', { count: site.retention_days }),
                      model: modelLabel(t, site.attribution_model),
                      created: f.date(site.created_at),
                    })}
                  </span>
                </div>
                {canConfigure ? (
                  <div className="flex items-center gap-1">
                    <DashboardButton variant="secondary" onClick={() => setRolling(site)}>
                      <KeyRound aria-hidden />
                      {t('analytics.sites.rollSecret')}
                    </DashboardButton>
                    <DashboardButton
                      variant="ghost"
                      size="icon"
                      aria-label={t('analytics.common.edit')}
                      onClick={() => setEditing(site)}
                    >
                      <Pencil aria-hidden />
                    </DashboardButton>
                    <DashboardButton
                      variant="ghost"
                      size="icon"
                      aria-label={t('analytics.common.delete')}
                      onClick={() => setDeleting(site)}
                    >
                      <Trash2 aria-hidden />
                    </DashboardButton>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {createOpen ? (
        <SiteFormDialog
          site={null}
          pending={create.isPending}
          onClose={() => onCreateOpenChange(false)}
          onSubmit={(value) => create.mutate(value)}
        />
      ) : null}
      {editing ? (
        <SiteFormDialog
          site={editing}
          pending={update.isPending}
          onClose={() => setEditing(null)}
          onSubmit={(value) => update.mutate({ id: editing.id, value })}
        />
      ) : null}

      {created ? (
        <Dialog open onOpenChange={(open) => !open && setCreated(null)}>
          <DialogContent className="sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>
                {t('analytics.sites.createdTitle', { name: created.site.name })}
              </DialogTitle>
              <DialogDescription>{t('analytics.sites.createdHint')}</DialogDescription>
            </DialogHeader>
            <SecretReveal secret={created.secret} />
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">{t('analytics.tracking.snippet')}</span>
              <CodeBlock code={created.snippet.html} />
            </div>
          </DialogContent>
        </Dialog>
      ) : null}

      {secret ? (
        <Dialog open onOpenChange={(open) => !open && setSecret(null)}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>
                {t('analytics.sites.newSecretTitle', { name: secret.site.name })}
              </DialogTitle>
              <DialogDescription>{t('analytics.sites.newSecretHint')}</DialogDescription>
            </DialogHeader>
            <SecretReveal secret={secret.secret} />
          </DialogContent>
        </Dialog>
      ) : null}

      <DashboardConfirmDialog
        open={rolling !== null}
        onOpenChange={(open) => !open && setRolling(null)}
        title={t('analytics.sites.rollTitle', { name: rolling?.name ?? '' })}
        description={t('analytics.sites.rollBody')}
        confirmLabel={t('analytics.sites.rollSecret')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onConfirm={() => {
          if (rolling) roll.mutate(rolling);
          setRolling(null);
        }}
      />
      <DashboardConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('analytics.sites.deleteTitle', { name: deleting?.name ?? '' })}
        description={t('analytics.sites.deleteBody')}
        confirmLabel={t('analytics.common.delete')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
          setDeleting(null);
        }}
      />
      {stepUpDialog}
    </div>
  );
}
