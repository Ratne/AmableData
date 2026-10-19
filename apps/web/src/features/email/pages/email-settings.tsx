import type { EmailSettings } from '@amable/api-types';
import type { MessageKey } from '@amable/i18n';
import { DashboardButton, PageBody, PageToolbar, usePageChrome } from '@amable/ui';
import { Alert, AlertDescription, AlertTitle } from '@amable/ui/ui/alert';
import { Badge } from '@amable/ui/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@amable/ui/ui/card';
import { Input } from '@amable/ui/ui/input';
import { Label } from '@amable/ui/ui/label';
import { Textarea } from '@amable/ui/ui/textarea';
import { useQuery } from '@tanstack/react-query';
import { Globe, Save, ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useI18n } from '../../../i18n';
import { emailKeys, useEmailApi, useEmailMutation, usePermissions } from '../api';
import { blockText, percent } from '../components';

const STATE_KEYS: Readonly<Record<EmailSettings['sending']['state'], MessageKey>> = {
  verified: 'email.settings.state.verified',
  unverified: 'email.settings.state.unverified',
  dev_override: 'email.settings.state.dev_override',
};

export function EmailSettingsPage() {
  const { t } = useI18n();
  const { slug, api } = useEmailApi();
  const { can } = usePermissions();
  usePageChrome({ title: t('email.settings.title') });
  const settings = useQuery({ queryKey: emailKeys.settings(slug), queryFn: api.settings.get });
  const [form, setForm] = useState({ from_name: '', from_email: '', reply_to: '', physical_address: '', timezone: 'UTC', rate: '600' });
  useEffect(() => {
    const s = settings.data;
    if (s === undefined) return;
    setForm({
      from_name: s.from_name ?? '',
      from_email: s.from_email ?? '',
      reply_to: s.reply_to ?? '',
      physical_address: s.physical_address ?? '',
      timezone: s.timezone,
      rate: String(s.rate_per_minute),
    });
  }, [settings.data]);
  const save = useEmailMutation({
    mutationFn: () =>
      api.settings.update({
        from_name: form.from_name || null,
        from_email: form.from_email || null,
        reply_to: form.reply_to || null,
        physical_address: form.physical_address || null,
        timezone: form.timezone,
        rate_per_minute: Number(form.rate) || 600,
      }),
    invalidate: [emailKeys.settings(slug)],
    success: t('email.common.saved'),
  });
  const resume = useEmailMutation({ mutationFn: () => api.settings.resume(), invalidate: [emailKeys.settings(slug)] });
  const editable = can('settings:manage');
  const s = settings.data;
  const field = (key: keyof typeof form) => ({
    value: form[key],
    disabled: !editable,
    onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value })),
  });

  return (
    <>
      <PageToolbar
        actions={
          editable ? (
            <DashboardButton variant="primary" onClick={() => save.mutate(undefined)} disabled={save.isPending}>
              <Save className="size-4" />
              {t('email.common.save')}
            </DashboardButton>
          ) : null
        }
      />
      <PageBody className="grid max-w-5xl gap-4 pt-4 lg:grid-cols-2">
        {s?.suspension.suspended ? (
          <Alert variant="destructive" className="lg:col-span-2">
            <ShieldAlert className="size-4" />
            <AlertTitle>{t('email.settings.suspended', { reason: s.suspension.reason ?? '' })}</AlertTitle>
            <AlertDescription>
              {editable ? (
                <DashboardButton onClick={() => resume.mutate(undefined)}>{t('email.settings.resume')}</DashboardButton>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}
        <Card>
          <CardHeader>
            <CardTitle>{t('email.settings.sender')}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="set-from-name">{t('email.common.fromName')}</Label>
              <Input id="set-from-name" {...field('from_name')} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="set-from-email">{t('email.settings.fromEmail')}</Label>
              <Input id="set-from-email" type="email" {...field('from_email')} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="set-reply">{t('email.common.replyTo')}</Label>
              <Input id="set-reply" type="email" aria-describedby="set-reply-hint" {...field('reply_to')} />
              <p id="set-reply-hint" className="text-xs text-muted-foreground">{t('email.settings.replyToHint')}</p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="set-address">{t('email.settings.physicalAddress')}</Label>
              <Textarea id="set-address" rows={2} {...field('physical_address')} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="set-tz">{t('email.settings.timezone')}</Label>
              <Input id="set-tz" list="email-timezones" {...field('timezone')} />
              <datalist id="email-timezones">
                {Intl.supportedValuesOf('timeZone').map((tz) => (
                  <option key={tz} value={tz} />
                ))}
              </datalist>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="set-rate">{t('email.settings.rate')}</Label>
              <Input id="set-rate" type="number" min={1} max={10000} {...field('rate')} />
            </div>
          </CardContent>
        </Card>
        <div className="grid content-start gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Globe className="size-4" />
                {t('email.settings.domains')}
                {s ? <Badge variant={s.sending.state === 'unverified' ? 'destructive' : 'secondary'}>{t(STATE_KEYS[s.sending.state])}</Badge> : null}
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm">
              <p className="text-(--obsidian-dashboard-shell-text-subtle)">{t('email.settings.domainsPlaceholder')}</p>
              {s && s.sending.domains.length === 0 ? <p>{t('email.settings.noDomains')}</p> : null}
              {s?.sending.domains.map((d) => (
                <div key={`${d.kind}:${d.hostname}`} className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs">{d.hostname}</span>
                  <span className="flex gap-1">
                    <Badge variant="outline">{d.kind}</Badge>
                    <Badge variant={d.status === 'verified' ? 'secondary' : 'destructive'}>{d.status}</Badge>
                  </span>
                </div>
              ))}
              {s ? (
                <p className="text-xs">
                  {t('email.settings.trackingOrigin')}: <span className="font-mono">{s.sending.tracking_origin}</span>
                </p>
              ) : null}
              {s ? (
                <p className={s.sending.can_send ? 'text-emerald-600' : 'text-amber-600'}>
                  {s.sending.can_send
                    ? t('email.settings.canSend')
                    : t('email.settings.cannotSend', { reason: blockText(t, s.sending.block_reason) })}
                </p>
              ) : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('email.settings.warmup')}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm">
              {s === undefined ? null : s.warmup.started_at === null ? (
                <p>{t('email.settings.warmupNotStarted')}</p>
              ) : s.warmup.daily_cap === null ? (
                <p>{t('email.settings.warmupDone', { sent: s.warmup.sent_today })}</p>
              ) : (
                <p>{t('email.settings.warmupDay', { day: s.warmup.day + 1, sent: s.warmup.sent_today, cap: s.warmup.daily_cap })}</p>
              )}
              {s ? (
                <p className="text-(--obsidian-dashboard-shell-text-subtle)">
                  {t('email.settings.health', {
                    days: s.health.window_days,
                    sent: s.health.sent,
                    bounce: `${percent(s.health.bounce_rate)}%`,
                    complaint: `${percent(s.health.complaint_rate)}%`,
                  })}
                </p>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </PageBody>
    </>
  );
}
