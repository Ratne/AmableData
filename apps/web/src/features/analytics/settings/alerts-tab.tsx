import type { Alert, Site } from '@amable/api-types';
import { DashboardButton, DashboardConfirmDialog } from '@amable/ui';
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
import { Switch } from '@amable/ui/ui/switch';
import { Bell, Pencil, Plus, Send, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useI18n } from '../../../i18n';
import { analyticsApi, analyticsKeys, useAnalyticsMutation, useAlerts } from '../api';
import { SecretReveal } from '../components/copy';
import { EmptyNote, ErrorState, ListSkeleton, Panel, StatusPill } from '../components/ui';
import { useFormatters, useNow } from '../lib/format';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GOAL = /^[a-z0-9_]{1,64}$/;

function AlertDialog({
  tenant,
  site,
  alert,
  onClose,
}: {
  tenant: string;
  site: Site;
  alert: Alert | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const api = analyticsApi(tenant);
  const [name, setName] = useState(alert?.name ?? '');
  const [goal, setGoal] = useState(alert?.goal ?? '');
  const [emails, setEmails] = useState((alert?.email_recipients ?? []).join(', '));
  const [webhook, setWebhook] = useState(alert?.webhook_url ?? '');
  const [enabled, setEnabled] = useState(alert?.enabled ?? true);
  const [secret, setSecret] = useState<string | null>(null);
  const invalidate = [analyticsKeys.site(tenant, site.id, 'alerts')];

  const recipients = emails
    .split(/[\s,;]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  const goalValue = goal.trim().toLowerCase();
  const valid =
    name.trim().length > 0 &&
    GOAL.test(goalValue) &&
    recipients.length <= 10 &&
    recipients.every((value) => EMAIL.test(value)) &&
    (webhook.trim() === '' || webhook.trim().startsWith('https://')) &&
    (recipients.length > 0 || webhook.trim() !== '');

  const save = useAnalyticsMutation(
    tenant,
    async () => {
      const input = {
        name: name.trim(),
        goal: goalValue,
        enabled,
        email_recipients: recipients,
        webhook_url: webhook.trim() || null,
      };
      const saved = alert
        ? await api.alerts.update(site.id, alert.id, input)
        : await api.alerts.create(site.id, input);
      return saved.webhook_secret;
    },
    {
      invalidate,
      success: alert ? 'analytics.alerts.updated' : 'analytics.alerts.created',
      onSuccess: (webhookSecret) => {
        if (webhookSecret) setSecret(webhookSecret);
        else onClose();
      },
    },
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) save.mutate(undefined);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        {secret ? (
          <div className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>{t('analytics.alerts.secretTitle')}</DialogTitle>
              <DialogDescription>{t('analytics.alerts.secretHint')}</DialogDescription>
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
              <DialogTitle>
                {alert ? t('analytics.alerts.editTitle') : t('analytics.alerts.newTitle')}
              </DialogTitle>
              <DialogDescription>{t('analytics.alerts.formHint')}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="amb-alert-name">{t('analytics.common.name')}</Label>
              <Input
                id="amb-alert-name"
                value={name}
                maxLength={100}
                onChange={(event) => setName(event.target.value)}
                autoFocus
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="amb-alert-goal">{t('analytics.dim.goal')}</Label>
              <Input
                id="amb-alert-goal"
                className="font-mono"
                value={goal}
                maxLength={64}
                placeholder="signup"
                aria-invalid={goal !== '' && !GOAL.test(goalValue)}
                onChange={(event) => setGoal(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t('analytics.alerts.goalHint')}</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="amb-alert-emails">{t('analytics.alerts.emails')}</Label>
              <Input
                id="amb-alert-emails"
                value={emails}
                placeholder="team@example.com, sales@example.com"
                onChange={(event) => setEmails(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="amb-alert-webhook">{t('analytics.alerts.webhook')}</Label>
              <Input
                id="amb-alert-webhook"
                type="url"
                value={webhook}
                placeholder="https://example.com/hooks/amable"
                onChange={(event) => setWebhook(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t('analytics.alerts.webhookHint')}</p>
            </div>
            <label className="flex items-center justify-between gap-4 rounded-lg border p-3 text-sm">
              {t('analytics.alerts.enabled')}
              <Switch checked={enabled} onCheckedChange={setEnabled} />
            </label>
            <DialogFooter>
              <DashboardButton variant="secondary" onClick={onClose}>
                {t('common.cancel')}
              </DashboardButton>
              <DashboardButton type="submit" variant="primary" disabled={!valid || save.isPending}>
                {t('common.save')}
              </DashboardButton>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function AlertsTab({
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
  const alerts = useAlerts(tenant, site.id);
  const api = analyticsApi(tenant);
  const [editing, setEditing] = useState<Alert | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Alert | null>(null);
  const invalidate = [analyticsKeys.site(tenant, site.id, 'alerts')];
  const toggle = useAnalyticsMutation(
    tenant,
    (input: { id: string; enabled: boolean }) =>
      api.alerts.update(site.id, input.id, { enabled: input.enabled }),
    { invalidate },
  );
  const test = useAnalyticsMutation(tenant, (id: string) => api.alerts.test(site.id, id), {
    invalidate,
    success: 'analytics.alerts.testQueued',
  });
  const remove = useAnalyticsMutation(tenant, (id: string) => api.alerts.remove(site.id, id), {
    invalidate,
    success: 'analytics.alerts.deleted',
  });

  return (
    <Panel
      title={t('analytics.alerts.title')}
      actions={
        canConfigure ? (
          <DashboardButton variant="primary" onClick={() => setEditing('new')}>
            <Plus aria-hidden />
            {t('analytics.alerts.new')}
          </DashboardButton>
        ) : null
      }
    >
      <p className="mb-3 text-xs text-muted-foreground">{t('analytics.alerts.hint')}</p>
      {alerts.error ? (
        <ErrorState error={alerts.error} />
      ) : !alerts.data ? (
        <ListSkeleton rows={3} />
      ) : alerts.data.data.length === 0 ? (
        <EmptyNote>{t('analytics.alerts.empty')}</EmptyNote>
      ) : (
        <ul className="flex flex-col divide-y divide-foreground/[0.06]">
          {alerts.data.data.map((alert) => (
            <li key={alert.id} className="flex flex-wrap items-center gap-3 py-2.5">
              <Bell className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="flex flex-wrap items-center gap-1.5 text-sm">
                  <span className="font-medium">{alert.name}</span>
                  <code className="rounded bg-foreground/[0.05] px-1.5 font-mono text-[11px]">
                    {alert.goal}
                  </code>
                  {alert.webhook_url ? (
                    <StatusPill tone="neutral">{t('analytics.alerts.webhookPill')}</StatusPill>
                  ) : null}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {t('analytics.alerts.meta', {
                    emails: alert.email_recipients.length,
                    last: alert.last_triggered_at
                      ? f.relative(alert.last_triggered_at, now)
                      : t('analytics.common.never'),
                    deliveries: alert.deliveries_24h,
                  })}
                </span>
              </div>
              {canConfigure ? (
                <div className="flex items-center gap-1">
                  <Switch
                    checked={alert.enabled}
                    aria-label={t('analytics.alerts.enabled')}
                    onCheckedChange={(enabled) => toggle.mutate({ id: alert.id, enabled })}
                  />
                  <DashboardButton
                    variant="secondary"
                    onClick={() => test.mutate(alert.id)}
                    disabled={test.isPending}
                  >
                    <Send aria-hidden />
                    {t('analytics.alerts.test')}
                  </DashboardButton>
                  <DashboardButton
                    variant="ghost"
                    size="icon"
                    aria-label={t('analytics.common.edit')}
                    onClick={() => setEditing(alert)}
                  >
                    <Pencil aria-hidden />
                  </DashboardButton>
                  <DashboardButton
                    variant="ghost"
                    size="icon"
                    aria-label={t('analytics.common.delete')}
                    onClick={() => setDeleting(alert)}
                  >
                    <Trash2 aria-hidden />
                  </DashboardButton>
                </div>
              ) : (
                <StatusPill tone={alert.enabled ? 'success' : 'neutral'}>
                  {alert.enabled ? t('analytics.alerts.on') : t('analytics.alerts.off')}
                </StatusPill>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing ? (
        <AlertDialog
          tenant={tenant}
          site={site}
          alert={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <DashboardConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('analytics.alerts.deleteTitle', { name: deleting?.name ?? '' })}
        confirmLabel={t('analytics.common.delete')}
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
