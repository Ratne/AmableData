import { DashboardButton, PageBody, PageToolbar, usePageChrome } from '@amable/ui';
import { Alert, AlertDescription, AlertTitle } from '@amable/ui/ui/alert';
import { Button } from '@amable/ui/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@amable/ui/ui/card';
import { Checkbox } from '@amable/ui/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { Label } from '@amable/ui/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@amable/ui/ui/table';
import { useQuery } from '@tanstack/react-query';
import { Plus, RefreshCw, RotateCcw, Send, ShieldAlert, Trash2, Webhook } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useI18n } from '../../../i18n';
import {
  devKeys,
  useDevelopersApi,
  useDevMutation,
  useTenantAccess,
  type DeliveryStatus,
  type WebhookDelivery,
  type WebhookEndpoint,
} from '../api';
import { formatDateTime, Pill, SecretReveal, useStepUp, type Tone } from '../components';

const DELIVERY_TONE: Record<DeliveryStatus, Tone> = {
  succeeded: 'success',
  retrying: 'warning',
  pending: 'neutral',
  failed: 'danger',
};

const VERIFY_SNIPPET = `// Node.js receiver: verify Amable-Signature (t=<unix>,v1=<hex>)
import { createHmac, timingSafeEqual } from 'node:crypto';
function verify(secret, header, rawBody) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;
  const expected = createHmac('sha256', secret).update(\`\${parts.t}.\${rawBody}\`).digest('hex');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}`;

function EventPicker({
  types,
  value,
  onChange,
}: {
  types: readonly string[];
  value: readonly string[];
  onChange: (next: string[]) => void;
}) {
  const { t } = useI18n();
  const all = value.includes('*');
  const groups = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const type of types) {
      const group = type.split('.')[0] ?? type;
      map.set(group, [...(map.get(group) ?? []), type]);
    }
    return [...map.entries()];
  }, [types]);
  return (
    <div className="grid gap-2">
      <label className="flex items-center gap-2 text-sm font-medium">
        <Checkbox checked={all} onCheckedChange={(checked) => onChange(checked === true ? ['*'] : [])} />
        {t('dev.webhooks.allEvents')}
      </label>
      {all ? null : (
        <div className="grid max-h-72 gap-3 overflow-y-auto rounded-lg border border-border p-3 sm:grid-cols-2">
          {groups.map(([group, list]) => (
            <fieldset key={group} className="grid gap-1">
              <legend className="text-xs font-semibold uppercase tracking-wide">{group}</legend>
              {list.map((type) => (
                <label key={type} className="flex items-center gap-2 font-mono text-xs">
                  <Checkbox
                    checked={value.includes(type)}
                    onCheckedChange={(checked) =>
                      onChange(checked === true ? [...value, type] : value.filter((v) => v !== type))
                    }
                  />
                  {type}
                </label>
              ))}
            </fieldset>
          ))}
        </div>
      )}
    </div>
  );
}

function DeliveryDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { t, locale } = useI18n();
  const { slug, api } = useDevelopersApi();
  const detail = useQuery({
    queryKey: ['developers', slug, 'delivery', id],
    queryFn: () => api.webhooks.delivery(id ?? ''),
    enabled: id !== null,
  });
  const replay = useDevMutation({
    mutationFn: (deliveryId: string) => api.webhooks.replay(deliveryId),
    invalidate: [devKeys.root(slug)],
    success: t('dev.webhooks.replayed'),
    onSuccess: onClose,
  });
  const d = detail.data;
  return (
    <Dialog open={id !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{d ? `${d.event_type} · ${d.event_id}` : t('common.loading')}</DialogTitle>
        </DialogHeader>
        {d ? (
          <div className="grid gap-3 text-sm">
            <div className="flex flex-wrap gap-2">
              <Pill tone={DELIVERY_TONE[d.status]}>{t(`dev.webhooks.status.${d.status}`)}</Pill>
              <span>{t('dev.webhooks.attempts', { count: d.attempts })}</span>
              {d.last_status !== null ? <span>HTTP {d.last_status}</span> : null}
              {d.duration_ms !== null ? <span>{d.duration_ms} ms</span> : null}
              {d.next_attempt_at ? <span>{t('dev.webhooks.nextAttempt', { at: formatDateTime(locale, d.next_attempt_at) })}</span> : null}
            </div>
            {d.last_error && d.last_status === null ? <p className="text-red-600">{d.last_error}</p> : null}
            <Label>{t('dev.webhooks.payload')}</Label>
            <pre className="max-h-64 overflow-auto rounded-lg border border-border p-3 font-mono text-xs">{JSON.stringify(d.payload, null, 2)}</pre>
            <Label>{t('dev.webhooks.response')}</Label>
            <pre className="max-h-40 overflow-auto rounded-lg border border-border p-3 font-mono text-xs">{d.last_response ?? '—'}</pre>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('dev.close')}
          </Button>
          <Button disabled={d === undefined || replay.isPending} onClick={() => d && replay.mutate(d.id)}>
            <RotateCcw className="size-4" />
            {t('dev.webhooks.replay')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EndpointPanel({ endpoint }: { endpoint: WebhookEndpoint }) {
  const { t, locale } = useI18n();
  const { slug, api } = useDevelopersApi();
  const [filter, setFilter] = useState<DeliveryStatus | 'all'>('all');
  const [openDelivery, setOpenDelivery] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const { guard, dialog: stepUpDialog } = useStepUp();
  const deliveries = useQuery({
    queryKey: devKeys.deliveries(slug, endpoint.id, filter),
    queryFn: () => api.webhooks.deliveries(endpoint.id, filter === 'all' ? undefined : filter),
    refetchInterval: 5000,
  });
  const invalidate = [devKeys.webhooks(slug), devKeys.root(slug)];
  const test = useDevMutation({
    mutationFn: () => api.webhooks.test(endpoint.id),
    invalidate,
    success: t('dev.webhooks.testSent'),
  });
  const toggle = useDevMutation({
    mutationFn: () => api.webhooks.update(endpoint.id, { status: endpoint.status === 'active' ? 'disabled' : 'active' }),
    invalidate,
  });
  const rotate = useDevMutation({
    mutationFn: () => api.webhooks.rotate(endpoint.id),
    invalidate,
    onSuccess: (result) => setSecret(result.secret),
    onError: (error) => guard(error, () => rotate.mutate(undefined)),
  });
  const remove = useDevMutation({ mutationFn: () => api.webhooks.remove(endpoint.id), invalidate, success: t('dev.webhooks.deleted') });
  const rows: WebhookDelivery[] = deliveries.data?.data ?? [];

  return (
    <Card data-testid="webhook-endpoint">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2">
            <Webhook className="size-4 shrink-0" />
            <span className="truncate font-mono text-sm">{endpoint.url}</span>
            <Pill tone={endpoint.status === 'active' ? 'success' : 'danger'}>{t(`dev.webhooks.endpoint.${endpoint.status}`)}</Pill>
          </span>
          <span className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => test.mutate(undefined)} disabled={test.isPending}>
              <Send className="size-4" />
              {t('dev.webhooks.sendTest')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => rotate.mutate(undefined)}>
              <RefreshCw className="size-4" />
              {t('dev.webhooks.rotate')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => toggle.mutate(undefined)}>
              {endpoint.status === 'active' ? t('dev.webhooks.disable') : t('dev.webhooks.enable')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (window.confirm(t('dev.webhooks.confirmDelete'))) remove.mutate(undefined);
              }}
            >
              <Trash2 className="size-4" />
            </Button>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        {endpoint.status === 'disabled' && endpoint.disabled_reason === 'failures' ? (
          <Alert variant="destructive">
            <ShieldAlert className="size-4" />
            <AlertTitle>{t('dev.webhooks.autoDisabled', { count: endpoint.consecutive_failures })}</AlertTitle>
          </Alert>
        ) : null}
        {secret !== null ? <SecretReveal title={t('dev.webhooks.newSecret')} value={secret} hint={t('dev.webhooks.secretHint')} /> : null}
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-(--obsidian-dashboard-shell-text-subtle)">
          {endpoint.description ? <span>{endpoint.description}</span> : null}
          <span>
            {t('dev.webhooks.events')}: <span className="font-mono text-xs">{endpoint.event_types.includes('*') ? t('dev.webhooks.allEvents') : endpoint.event_types.join(', ')}</span>
          </span>
          <span>
            {t('dev.webhooks.secret')}: <span className="font-mono text-xs">whsec_…{endpoint.secret_hint}</span>
          </span>
          <span>{t('dev.webhooks.lastSuccess', { at: formatDateTime(locale, endpoint.last_success_at) })}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{t('dev.webhooks.log')}</span>
          {(['all', 'succeeded', 'retrying', 'failed'] as const).map((f) => (
            <Button key={f} size="sm" variant={filter === f ? 'default' : 'outline'} onClick={() => setFilter(f)}>
              {f === 'all' ? t('dev.webhooks.filterAll') : t(`dev.webhooks.status.${f}`)}
            </Button>
          ))}
        </div>
        {rows.length === 0 ? (
          <p>{t('dev.webhooks.noDeliveries')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('dev.webhooks.when')}</TableHead>
                <TableHead>{t('dev.webhooks.event')}</TableHead>
                <TableHead>{t('dev.webhooks.result')}</TableHead>
                <TableHead>{t('dev.webhooks.attemptsCol')}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((d) => (
                <TableRow key={d.id} className="cursor-pointer" onClick={() => setOpenDelivery(d.id)}>
                  <TableCell>{formatDateTime(locale, d.created_at)}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {d.event_type}
                    {d.replay_of ? <span className="ml-1 text-(--obsidian-dashboard-shell-text-subtle)">↻</span> : null}
                  </TableCell>
                  <TableCell>
                    <Pill tone={DELIVERY_TONE[d.status]}>{t(`dev.webhooks.status.${d.status}`)}</Pill>{' '}
                    {d.last_status !== null ? <span className="text-xs">HTTP {d.last_status}</span> : d.last_error ? <span className="text-xs">{d.last_error}</span> : null}
                  </TableCell>
                  <TableCell>{d.attempts}</TableCell>
                  <TableCell className="text-right text-xs underline">{t('dev.webhooks.details')}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <DeliveryDialog id={openDelivery} onClose={() => setOpenDelivery(null)} />
      {stepUpDialog}
    </Card>
  );
}

export function WebhooksPage() {
  const { t } = useI18n();
  const { slug, api } = useDevelopersApi();
  const access = useTenantAccess();
  usePageChrome({ title: t('dev.webhooks.title') });
  const allowed = access.can('webhooks:manage');
  const endpoints = useQuery({ queryKey: devKeys.webhooks(slug), queryFn: api.webhooks.list, enabled: allowed });
  const types = useQuery({ queryKey: devKeys.eventTypes(slug), queryFn: api.webhooks.eventTypes, enabled: allowed, staleTime: Infinity });
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [events, setEvents] = useState<string[]>(['*']);
  const [created, setCreated] = useState<string | null>(null);
  const { guard, dialog: stepUpDialog } = useStepUp();

  const create = useDevMutation({
    mutationFn: () => api.webhooks.create({ url: url.trim(), event_types: events, ...(description.trim() ? { description: description.trim() } : {}) }),
    invalidate: [devKeys.webhooks(slug)],
    onSuccess: (result) => {
      setCreated(result.secret);
      setOpen(false);
      setUrl('');
      setDescription('');
      setEvents(['*']);
    },
    onError: (error) => guard(error, () => create.mutate(undefined)),
  });

  if (access.ready && !allowed) return <PageBody className="pt-4 text-sm">{t('dev.noAccess')}</PageBody>;

  return (
    <>
      <PageToolbar
        actions={
          <DashboardButton variant="primary" onClick={() => setOpen(true)}>
            <Plus className="size-4" />
            {t('dev.webhooks.new')}
          </DashboardButton>
        }
      />
      <PageBody className="grid max-w-5xl gap-4 pt-4">
        <p className="text-sm text-(--obsidian-dashboard-shell-text-subtle)">{t('dev.webhooks.intro')}</p>
        {created !== null ? (
          <div className="grid gap-2">
            <SecretReveal title={t('dev.webhooks.createdTitle')} value={created} hint={t('dev.webhooks.secretHint')} />
            <div>
              <Button variant="ghost" size="sm" onClick={() => setCreated(null)}>
                {t('dev.done')}
              </Button>
            </div>
          </div>
        ) : null}
        {(endpoints.data?.data ?? []).map((endpoint) => (
          <EndpointPanel key={endpoint.id} endpoint={endpoint} />
        ))}
        {endpoints.data?.data.length === 0 ? <p className="text-sm">{t('dev.webhooks.empty')}</p> : null}
        <Card>
          <CardHeader>
            <CardTitle>{t('dev.webhooks.verifyTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            <p>{t('dev.webhooks.verifyBody')}</p>
            <pre className="overflow-x-auto rounded-lg border border-border p-3 font-mono text-xs">{VERIFY_SNIPPET}</pre>
          </CardContent>
        </Card>
      </PageBody>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('dev.webhooks.new')}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="wh-url">{t('dev.webhooks.url')}</Label>
              <Input id="wh-url" type="url" placeholder="https://example.com/webhooks/amable" value={url} onChange={(e) => setUrl(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="wh-desc">{t('dev.webhooks.description')}</Label>
              <Input id="wh-desc" value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>{t('dev.webhooks.events')}</Label>
              <EventPicker types={types.data?.data ?? []} value={events} onChange={setEvents} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button disabled={url.trim() === '' || events.length === 0 || create.isPending} onClick={() => create.mutate(undefined)}>
              {t('dev.webhooks.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {stepUpDialog}
    </>
  );
}
