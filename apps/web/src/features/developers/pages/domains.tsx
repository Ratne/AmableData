import { PageBody, usePageChrome } from '@amable/ui';
import { Alert, AlertDescription, AlertTitle } from '@amable/ui/ui/alert';
import { Button } from '@amable/ui/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@amable/ui/ui/card';
import { Input } from '@amable/ui/ui/input';
import { Label } from '@amable/ui/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@amable/ui/ui/table';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Circle, Cloud, Globe, Link2, Mail, ShieldCheck, Trash2, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../../../i18n';
import { apiErrorCode, devKeys, useDevelopersApi, useDevMutation, useTenantAccess, type DomainKind, type TenantDomain } from '../api';
import { CopyButton, formatDateTime, Pill, SendingDomainBanner, useStepUp } from '../components';

const KIND_ICON = { sending: Mail, tracking: Link2, app: Globe } as const;

function Step({ done, label }: { done: boolean; label: string }) {
  return (
    <span className={`flex items-center gap-1 text-xs ${done ? 'text-emerald-600' : 'text-(--obsidian-dashboard-shell-text-subtle)'}`}>
      {done ? <CheckCircle2 className="size-3.5" /> : <Circle className="size-3.5" />}
      {label}
    </span>
  );
}

function DomainCard({ domain, automation }: { domain: TenantDomain; automation: 'cloudflare' | 'fake' | 'manual' }) {
  const { t, locale } = useI18n();
  const { slug, api } = useDevelopersApi();
  const invalidate = [devKeys.domains(slug), devKeys.sending(slug), ['email']];
  const { guard, dialog: stepUpDialog } = useStepUp();
  const apply = useDevMutation({
    mutationFn: () => api.domains.applyDns(domain.id),
    invalidate,
    success: t('dev.domains.dnsApplied'),
    onError: (error) => guard(error, () => apply.mutate(undefined)),
  });
  const verify = useDevMutation({ mutationFn: () => api.domains.verify(domain.id), invalidate });
  const remove = useDevMutation({
    mutationFn: () => api.domains.remove(domain.id),
    invalidate,
    success: t('dev.domains.removed'),
    onError: (error) => guard(error, () => remove.mutate(undefined)),
  });
  const Icon = KIND_ICON[domain.kind];
  const verified = domain.status === 'verified';
  const pathSite = domain.kind === 'app' && domain.paths.length > 0;
  const dnsChanged = domain.dns_changed_at !== null;
  const applyLabel = domain.dns_applied_at ? t('dev.domains.reapply') : t('dev.domains.apply');

  return (
    <Card data-testid={`domain-${domain.kind}`} className={dnsChanged ? 'border-amber-500 ring-1 ring-amber-500' : undefined}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <Icon className="size-4" />
            <span className="font-mono text-sm">{domain.hostname}</span>
            <Pill tone="neutral">{t(`dev.domains.kind.${domain.kind}`)}</Pill>
            <Pill tone={verified ? 'success' : domain.status === 'failed' ? 'danger' : 'warning'}>{t(`dev.domains.status.${domain.status}`)}</Pill>
            {dnsChanged ? <Pill tone="warning">{t('dev.domains.dnsChanged.pill')}</Pill> : null}
          </span>
          <span className="flex flex-wrap gap-2">
            {automation !== 'manual' ? (
              <Button size="sm" variant="outline" disabled={apply.isPending} onClick={() => apply.mutate(undefined)}>
                <Cloud className="size-4" />
                {applyLabel}
              </Button>
            ) : null}
            <Button size="sm" disabled={verify.isPending} onClick={() => verify.mutate(undefined)}>
              <ShieldCheck className="size-4" />
              {t('dev.domains.verify')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (window.confirm(t('dev.domains.confirmRemove', { host: domain.hostname }))) remove.mutate(undefined);
              }}
            >
              <Trash2 className="size-4" />
            </Button>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        {dnsChanged ? (
          <Alert data-testid="domain-dns-changed">
            <TriangleAlert className="size-4" />
            <AlertTitle>{t('dev.domains.dnsChanged.title')}</AlertTitle>
            <AlertDescription className="grid gap-1">
              <p>{t('dev.domains.dnsChanged.body', { at: formatDateTime(locale, domain.dns_changed_at) })}</p>
              <p>
                {automation === 'manual'
                  ? t('dev.domains.dnsChanged.stepManual')
                  : t('dev.domains.dnsChanged.stepAuto', { button: applyLabel })}
              </p>
              <p>{t('dev.domains.dnsChanged.stepVerify', { button: t('dev.domains.verify') })}</p>
            </AlertDescription>
          </Alert>
        ) : null}
        <div className="flex flex-wrap gap-4">
          <Step done label={t('dev.domains.step.added')} />
          <Step done={domain.dns_applied_at !== null || verified} label={automation === 'manual' ? t('dev.domains.step.dnsManual') : t('dev.domains.step.dns')} />
          <Step done={verified} label={t('dev.domains.step.verified')} />
        </div>
        <p className="text-(--obsidian-dashboard-shell-text-subtle)">{t(`dev.domains.help.${pathSite ? 'paths' : domain.kind}`)}</p>
        {domain.records.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('dev.domains.type')}</TableHead>
                <TableHead>{t('dev.domains.name')}</TableHead>
                <TableHead>{t('dev.domains.value')}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {domain.records.map((r) => (
                <TableRow key={`${r.type}:${r.name}:${r.value}`}>
                  <TableCell className="font-mono text-xs">{r.type}</TableCell>
                  <TableCell className="font-mono text-xs break-all">{r.name}</TableCell>
                  <TableCell className="font-mono text-xs break-all">{r.value}</TableCell>
                  <TableCell className="text-right">
                    <CopyButton value={r.value} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
        {domain.routes.length > 0 ? (
          <div className="grid gap-1">
            <Label>{t('dev.domains.routes')}</Label>
            <ul className="grid gap-0.5 font-mono text-xs">
              {domain.routes.map((r) => (
                <li key={r}>{r} → amable-edge</li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-(--obsidian-dashboard-shell-text-subtle)">
          {domain.zone_id ? <span>{t('dev.domains.zone', { zone: domain.zone_id })}</span> : null}
          <span>{t('dev.domains.checked', { at: formatDateTime(locale, domain.checked_at) })}</span>
          {domain.last_error ? <span className="text-red-600">{t('dev.domains.lastError', { error: domain.last_error })}</span> : null}
          {apply.error && apiErrorCode(apply.error) !== 'step_up_required' ? (
            <span className="text-red-600">{apiErrorCode(apply.error)}</span>
          ) : null}
        </div>
      </CardContent>
      {stepUpDialog}
    </Card>
  );
}

export function DomainsPage() {
  const { t } = useI18n();
  const { slug, api } = useDevelopersApi();
  const access = useTenantAccess();
  usePageChrome({ title: t('dev.domains.title') });
  const allowed = access.can('domains:manage');
  const domains = useQuery({ queryKey: devKeys.domains(slug), queryFn: api.domains.list, enabled: allowed });
  const [kind, setKind] = useState<DomainKind>('sending');
  const [hostname, setHostname] = useState('');
  const [paths, setPaths] = useState('');
  const { guard, dialog: stepUpDialog } = useStepUp();
  const add = useDevMutation({
    mutationFn: () =>
      api.domains.add({
        kind,
        hostname: hostname.trim(),
        ...(kind === 'app' ? { paths: paths.split(/[\s,]+/).filter((p) => p !== '') } : {}),
      }),
    invalidate: [devKeys.domains(slug), devKeys.sending(slug)],
    success: t('dev.domains.added'),
    onSuccess: () => {
      setHostname('');
      setPaths('');
    },
    onError: (error) => guard(error, () => add.mutate(undefined)),
  });

  if (access.ready && !allowed) return <PageBody className="pt-4 text-sm">{t('dev.noAccess')}</PageBody>;
  const list = domains.data;
  const automation = list?.automation ?? 'manual';

  return (
    <PageBody className="grid max-w-5xl gap-4 pt-4">
      <SendingDomainBanner slug={slug} />
      <Card>
        <CardHeader>
          <CardTitle>{t('dev.domains.connect')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <p className="text-sm text-(--obsidian-dashboard-shell-text-subtle)">
            {t(`dev.domains.automation.${automation}`)}
            {list ? ` ${t('dev.domains.edgeHost', { host: list.edge_hostname })}` : ''}
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            {(['sending', 'tracking', 'app'] as const).map((k) => {
              const Icon = KIND_ICON[k];
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className={`grid gap-1 rounded-lg border p-3 text-left text-sm transition ${kind === k ? 'border-primary ring-1 ring-primary' : 'border-border hover:bg-accent'}`}
                >
                  <span className="flex items-center gap-2 font-medium">
                    <Icon className="size-4" />
                    {t(`dev.domains.kind.${k}`)}
                  </span>
                  <span className="text-xs text-(--obsidian-dashboard-shell-text-subtle)">{t(`dev.domains.kindHelp.${k}`)}</span>
                </button>
              );
            })}
          </div>
          <form
            className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              add.mutate(undefined);
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="domain-host">{t('dev.domains.hostname')}</Label>
              <Input
                id="domain-host"
                value={hostname}
                onChange={(e) => setHostname(e.target.value)}
                placeholder={kind === 'sending' ? 'mail.example.com' : kind === 'tracking' ? 'links.example.com' : 'www.example.com'}
              />
            </div>
            {kind === 'app' ? (
              <div className="grid gap-1.5">
                <Label htmlFor="domain-paths">{t('dev.domains.paths')}</Label>
                <Input id="domain-paths" value={paths} onChange={(e) => setPaths(e.target.value)} placeholder="/offers, /events" />
              </div>
            ) : (
              <div />
            )}
            <Button type="submit" disabled={hostname.trim() === '' || add.isPending}>
              {t('dev.domains.add')}
            </Button>
          </form>
          {kind === 'app' ? <p className="text-xs text-(--obsidian-dashboard-shell-text-subtle)">{t('dev.domains.pathsHelp')}</p> : null}
        </CardContent>
      </Card>
      {(list?.data ?? []).map((domain) => (
        <DomainCard key={domain.id} domain={domain} automation={automation} />
      ))}
      {list?.data.length === 0 ? <p className="text-sm">{t('dev.domains.empty')}</p> : null}
      {stepUpDialog}
    </PageBody>
  );
}
