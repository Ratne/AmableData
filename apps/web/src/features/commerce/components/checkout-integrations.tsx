import {
  CHECKOUT_CONNECTION_TYPES,
  type CheckoutConnection,
  type CheckoutConnectionType,
  type ConnectionTestResult,
  type CreateCheckoutConnectionInput,
} from '@amable/api-types';
import { Button } from '@amable/ui/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { Switch } from '@amable/ui/ui/switch';
import { useQuery } from '@tanstack/react-query';
import { FlaskConical, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useI18n } from '../../../i18n';
import { useStepUp } from '../../developers/components';
import { AdConversionFields, buildConversionConfig } from '../../forms/components/ad-conversion-fields';
import { commerceKeys, useCommerce, useCommerceMutation, useDates } from '../api/hooks';
import { ErrorNotice, FormField, Pill, SectionCard } from './common';

const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

type Editing = { connection: CheckoutConnection | null; type: CheckoutConnectionType };

/** "Integrations" tab of the checkout editor: Meta CAPI / TikTok Events API for paid orders. */
export function CheckoutIntegrations({ checkoutId, writable }: { checkoutId: string; writable: boolean }) {
  const { t } = useI18n();
  const { slug, api } = useCommerce();
  const { dateTime } = useDates();
  const key = commerceKeys.checkoutConnections(slug, checkoutId);
  const connections = useQuery({ queryKey: key, queryFn: async () => (await api.checkouts.connections.list(checkoutId)).data });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [testResult, setTestResult] = useState<{ name: string; result: ConnectionTestResult } | null>(null);
  const { guard, dialog: stepUpDialog } = useStepUp();
  const invalidate = [key];
  const toggle = useCommerceMutation({
    mutationFn: (c: CheckoutConnection) => api.checkouts.connections.update(checkoutId, c.id, { enabled: !c.enabled }),
    invalidate,
  });
  const remove = useCommerceMutation({
    mutationFn: (id: string) => api.checkouts.connections.remove(checkoutId, id),
    invalidate,
    success: t('checkout.integrations.deleted'),
  });
  const test = useCommerceMutation({
    mutationFn: (c: CheckoutConnection) => api.checkouts.connections.test(checkoutId, c.id).then((result) => ({ name: c.name, result })),
    invalidate,
    onSuccess: (result) => setTestResult(result),
  });

  return (
    <SectionCard
      title={t('checkout.tab.integrations')}
      actions={
        writable ? (
          <div className="flex flex-wrap gap-2">
            {CHECKOUT_CONNECTION_TYPES.map((type) => (
              <Button key={type} size="sm" variant="ghost" onClick={() => setEditing({ connection: null, type })}>
                <Plus aria-hidden /> {t(`forms.connector.${type}`)}
              </Button>
            ))}
          </div>
        ) : null
      }
    >
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">{t('checkout.integrations.intro')}</p>
        {connections.error ? <ErrorNotice error={connections.error} /> : null}
        {connections.data?.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t('checkout.integrations.empty')}</p>
        ) : null}
        {(connections.data ?? []).map((c) => (
          <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
            <div className="grid min-w-0 gap-1">
              <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                {c.name}
                <Pill tone="neutral">{t(`forms.connector.${c.type}`)}</Pill>
                {c.last_delivery ? (
                  <Pill tone={c.last_delivery.status === 'success' ? 'success' : c.last_delivery.status === 'skipped' ? 'neutral' : 'danger'}>
                    {t(`forms.delivery.${c.last_delivery.status}`)} · {dateTime(c.last_delivery.at)}
                  </Pill>
                ) : null}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                Pixel {str(c.config[c.type === 'facebook_capi' ? 'pixel_id' : 'pixel_code'])} · {str(c.config['event_name'], 'Purchase')}
                {str(c.config['test_event_code']) ? ' · test' : ''}
                {c.secret_hint ? ` · ${t('forms.connections.secret')} ${c.secret_hint}` : ''}
                {c.enabled ? '' : ` · ${t('forms.connections.disabled')}`}
              </span>
            </div>
            {writable ? (
              <div className="flex items-center gap-1">
                <Switch checked={c.enabled} aria-label={t('forms.connections.enabled')} onCheckedChange={() => toggle.mutate(c)} />
                <Button size="sm" variant="ghost" disabled={test.isPending} onClick={() => test.mutate(c)}>
                  <FlaskConical aria-hidden /> {t('forms.connections.test')}
                </Button>
                <Button size="icon" variant="ghost" aria-label={t('forms.action.edit')} onClick={() => setEditing({ connection: c, type: c.type })}>
                  <Pencil aria-hidden />
                </Button>
                <Button size="icon" variant="ghost" aria-label={t('checkout.integrations.delete')} onClick={() => remove.mutate(c.id)}>
                  <Trash2 aria-hidden />
                </Button>
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {editing !== null ? (
        <IntegrationDialog
          checkoutId={checkoutId}
          connection={editing.connection}
          type={editing.type}
          onClose={() => setEditing(null)}
          guard={guard}
        />
      ) : null}
      {stepUpDialog}
      <Dialog open={testResult !== null} onOpenChange={(open) => (open ? undefined : setTestResult(null))}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('forms.connections.testTitle', { name: testResult?.name ?? '' })}</DialogTitle>
          </DialogHeader>
          {testResult ? (
            <div className="grid gap-2 text-sm">
              <Pill tone={testResult.result.status === 'success' ? 'success' : testResult.result.status === 'skipped' ? 'neutral' : 'danger'}>
                {t(`forms.delivery.${testResult.result.status}`)}
                {testResult.result.status_code !== null ? ` · HTTP ${String(testResult.result.status_code)}` : ''}
              </Pill>
              {testResult.result.request ? <code className="block break-all text-xs text-muted-foreground">{testResult.result.request}</code> : null}
              {testResult.result.response ? <pre className="max-h-48 overflow-auto rounded bg-muted p-2 text-xs">{testResult.result.response}</pre> : null}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}

function IntegrationDialog({
  checkoutId,
  connection,
  type,
  onClose,
  guard,
}: {
  checkoutId: string;
  connection: CheckoutConnection | null;
  type: CheckoutConnectionType;
  onClose: () => void;
  guard: (error: unknown, retry: () => void) => boolean;
}) {
  const { t } = useI18n();
  const { slug, api } = useCommerce();
  const title = t(`forms.connector.${type}`);
  const [name, setName] = useState(connection?.name ?? title);
  const [config, setConfig] = useState<Record<string, unknown>>(connection?.config ?? { event_name: 'Purchase' });
  const [token, setToken] = useState('');
  const set = (patch: Record<string, unknown>) => setConfig((prev) => ({ ...prev, ...patch }));

  const save = useCommerceMutation({
    mutationFn: async () => {
      const built = buildConversionConfig(type, config, 'Purchase');
      if (connection !== null) {
        return api.checkouts.connections.update(checkoutId, connection.id, {
          name: name.trim(),
          config: built,
          ...(token.trim() === '' ? {} : { secret: token.trim() }),
        });
      }
      const input = { type, name: name.trim(), config: built, secret: token.trim() } as CreateCheckoutConnectionInput;
      return api.checkouts.connections.create(checkoutId, input);
    },
    invalidate: [commerceKeys.checkoutConnections(slug, checkoutId)],
    success: t('checkout.integrations.saved'),
    onSuccess: onClose,
    onError: (error) => guard(error, () => save.mutate(undefined)),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(undefined);
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{t('checkout.integrations.intro')}</DialogDescription>
          </DialogHeader>
          <FormField label={t('forms.field.name')}>{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</FormField>
          <AdConversionFields
            type={type}
            config={config}
            set={set}
            token={token}
            setToken={setToken}
            hasToken={connection?.has_secret ?? false}
            defaultEvent="Purchase"
            dedupHint={t('checkout.integrations.dedupHint')}
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={save.isPending || name.trim() === ''}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
