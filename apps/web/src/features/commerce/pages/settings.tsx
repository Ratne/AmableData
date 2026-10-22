import { isCurrencyCode } from '@amable/api-types';
import type { CommerceSettings, StripeCheckResult, StripeSettings } from '@amable/api-types';
import { DashboardButton, DashboardConfirmDialog, PageBody, PageToolbar, toast, usePageChrome } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, PlugZap, Save, Unplug } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useI18n } from '../../../i18n';
import { CurrencySelect } from '../components/currency-select';
import {
  commerceKeys,
  useCommerce,
  useCommerceMutation,
  useCommerceSettings,
  useMoney,
  usePermissions,
} from '../api/hooks';
import { ErrorNotice, FormField, PageState, PercentInput, Pill, SectionCard } from '../components/common';

const PREFIX = /^[A-Za-z0-9_-]{0,12}$/;
const FORM_ID = 'commerce-settings-form';
const STRIPE_PK = /^pk_(test|live)_[A-Za-z0-9]{10,250}$/;
const STRIPE_SK = /^(sk|rk)_(test|live)_[A-Za-z0-9]{10,250}$/;
const STRIPE_WHSEC = /^whsec_[A-Za-z0-9+/=]{10,250}$/;

export function CommerceSettingsPage() {
  const { t } = useI18n();
  const settings = useCommerceSettings();
  usePageChrome({ title: t('nav.commerceSettings') });
  return (
    <PageState isPending={settings.isPending} error={settings.error}>
      {() =>
        settings.data ? (
          <SettingsForm key={JSON.stringify(settings.data)} initial={settings.data} />
        ) : null
      }
    </PageState>
  );
}

function SettingsForm({ initial }: { initial: CommerceSettings }) {
  const { t } = useI18n();
  const { api } = useCommerce();
  const { can } = usePermissions();
  const money = useMoney();
  const editable = can('settings:manage');
  const [currency, setCurrency] = useState(initial.default_currency);
  const [orderPrefix, setOrderPrefix] = useState(initial.order_prefix);
  const [invoicePrefix, setInvoicePrefix] = useState(initial.invoice_prefix);
  const [terms, setTerms] = useState(String(initial.payment_terms_days));
  const [tax, setTax] = useState<number | null>(initial.default_tax_rate_bps);

  const currencyValid = isCurrencyCode(currency);
  const termsNumber = Math.trunc(Number(terms));
  const termsValid = terms.trim() !== '' && termsNumber >= 0 && termsNumber <= 365;
  const valid =
    currencyValid &&
    PREFIX.test(orderPrefix) &&
    PREFIX.test(invoicePrefix) &&
    termsValid &&
    tax !== null;

  const save = useCommerceMutation({
    mutationFn: () =>
      api.settings.update({
        default_currency: currency,
        order_prefix: orderPrefix,
        invoice_prefix: invoicePrefix,
        payment_terms_days: termsNumber,
        default_tax_rate_bps: tax ?? 0,
      }),
    success: t('commerce.common.saved'),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) save.mutate(undefined);
  };
  const year = new Date().getFullYear();

  return (
    <>
      <PageToolbar
        actions={
          editable ? (
            <DashboardButton variant="primary" type="submit" form={FORM_ID} disabled={!valid || save.isPending}>
              <Save aria-hidden /> {t('common.save')}
            </DashboardButton>
          ) : null
        }
      />
      <PageBody className="grid max-w-3xl gap-4">
        <form id={FORM_ID} onSubmit={submit} className="grid gap-4">
        <SectionCard title={t('commerce.settings.money')}>
          <fieldset disabled={!editable} className="grid gap-3 sm:grid-cols-2">
            <FormField
              label={t('commerce.settings.currency')}
              hint={
                currencyValid
                  ? t('commerce.settings.currencyHint', { example: money(123456, currency) })
                  : null
              }
              error={currencyValid ? null : t('commerce.settings.currencyInvalid')}
            >
              {(id) => (
                <CurrencySelect
                  id={id}
                  value={currency}
                  invalid={!currencyValid}
                  onChange={setCurrency}
                />
              )}
            </FormField>
            <FormField
              label={t('commerce.settings.defaultTax')}
              hint={t('commerce.settings.defaultTaxHint')}
            >
              {(id) => <PercentInput id={id} value={tax} onChange={setTax} />}
            </FormField>
          </fieldset>
        </SectionCard>
        <SectionCard title={t('commerce.settings.numbering')}>
          <fieldset disabled={!editable} className="grid gap-3 sm:grid-cols-2">
            <FormField
              label={t('commerce.settings.orderPrefix')}
              hint={t('commerce.settings.example', { example: `${orderPrefix}000123` })}
              error={PREFIX.test(orderPrefix) ? null : t('commerce.settings.prefixInvalid')}
            >
              {(id) => (
                <Input
                  id={id}
                  value={orderPrefix}
                  onChange={(e) => setOrderPrefix(e.target.value)}
                />
              )}
            </FormField>
            <FormField
              label={t('commerce.settings.invoicePrefix')}
              hint={t('commerce.settings.example', {
                example: `${invoicePrefix}${String(year)}-00001`,
              })}
              error={PREFIX.test(invoicePrefix) ? null : t('commerce.settings.prefixInvalid')}
            >
              {(id) => (
                <Input
                  id={id}
                  value={invoicePrefix}
                  onChange={(e) => setInvoicePrefix(e.target.value)}
                />
              )}
            </FormField>
            <FormField
              label={t('commerce.settings.paymentTerms')}
              hint={t('commerce.settings.paymentTermsHint')}
            >
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min={0}
                  max={365}
                  value={terms}
                  aria-invalid={!termsValid}
                  onChange={(e) => setTerms(e.target.value)}
                />
              )}
            </FormField>
          </fieldset>
        </SectionCard>
        </form>
        <StripeCard editable={editable} />
      </PageBody>
    </>
  );
}

function StripeCard({ editable }: { editable: boolean }) {
  const { t } = useI18n();
  const { slug, api } = useCommerce();
  const stripe = useQuery({ queryKey: commerceKeys.stripe(slug), queryFn: () => api.stripe.get(), enabled: editable });
  if (!editable) return null;
  return (
    <SectionCard title={t('commerce.stripe.title')}>
      {stripe.error ? <ErrorNotice error={stripe.error} /> : null}
      {stripe.data ? <StripeForm key={stripe.data.updated_at ?? 'new'} initial={stripe.data} /> : null}
    </SectionCard>
  );
}

function StripeForm({ initial }: { initial: StripeSettings }) {
  const { t } = useI18n();
  const { slug, api } = useCommerce();
  const queryClient = useQueryClient();
  const [publishable, setPublishable] = useState(initial.publishable_key ?? '');
  const [secret, setSecret] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [check, setCheck] = useState<StripeCheckResult | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [confirmSwitch, setConfirmSwitch] = useState(false);
  const publishableValid = STRIPE_PK.test(publishable.trim());
  const keyMode = /_live_/.test(publishable) ? 'live' : 'test';
  const switching = initial.configured && publishableValid && keyMode !== initial.mode;
  const secretValid = secret.trim() === '' ? initial.configured && !switching : STRIPE_SK.test(secret.trim());
  const webhookValid = webhookSecret.trim() === '' || STRIPE_WHSEC.test(webhookSecret.trim());
  const mixedModes = secret.trim() !== '' && STRIPE_SK.test(secret.trim()) && !secret.includes(`_${keyMode}_`);
  const adopt = (next: StripeSettings) => {
    queryClient.setQueryData(commerceKeys.stripe(slug), next);
  };
  const save = useCommerceMutation({
    mutationFn: () =>
      api.stripe.update({
        publishable_key: publishable.trim(),
        ...(secret.trim() !== '' ? { secret_key: secret.trim() } : {}),
        ...(webhookSecret.trim() !== '' ? { webhook_secret: webhookSecret.trim() } : {}),
      }),
    success: t('commerce.stripe.saved'),
    onSuccess: (next: StripeSettings) => {
      if (next.account_changed === true) toast.warning(t('commerce.stripe.accountChanged'));
      adopt(next);
    },
  });
  const verify = useCommerceMutation({
    mutationFn: () => api.stripe.check(),
    onSuccess: setCheck,
  });
  const disconnect = useCommerceMutation({
    mutationFn: () => api.stripe.disconnect(),
    success: t('commerce.stripe.disconnected'),
    onSuccess: adopt,
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!publishableValid || !secretValid || !webhookValid || mixedModes) return;
    if (switching) setConfirmSwitch(true);
    else save.mutate(undefined);
  };
  const switchWarning =
    initial.saved_payment_methods > 0
      ? t('commerce.stripe.switchWarning', { count: initial.saved_payment_methods })
      : t('commerce.stripe.switchWarningEmpty');

  return (
    <form onSubmit={submit} className="grid gap-3">
      <p className="text-sm text-muted-foreground">{t('commerce.stripe.intro')}</p>
      {initial.configured ? (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <Pill tone={initial.mode === 'live' ? 'success' : 'warning'}>
            {initial.mode === 'live' ? t('commerce.stripe.mode.live') : t('commerce.stripe.mode.test')}
          </Pill>
          {initial.webhook_secret_hint === null ? (
            <span className="text-amber-700 dark:text-amber-300">{t('commerce.stripe.webhookMissing')}</span>
          ) : null}
        </p>
      ) : null}
      <FormField
        label={t('commerce.stripe.publishable')}
        error={publishable === '' || publishableValid ? null : t('commerce.stripe.publishableInvalid')}
      >
        {(id) => (
          <Input id={id} className="font-mono" autoComplete="off" value={publishable} placeholder="pk_live_…" onChange={(e) => setPublishable(e.target.value)} />
        )}
      </FormField>
      {switching ? (
        <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          {switchWarning}
        </p>
      ) : null}
      <FormField
        label={t('commerce.stripe.secret')}
        hint={initial.secret_key_hint ? t('commerce.stripe.keepHint', { hint: initial.secret_key_hint }) : t('commerce.stripe.secretHint')}
        error={
          secret.trim() === ''
            ? switching
              ? t('commerce.stripe.secretForSwitch')
              : null
            : !secretValid
              ? t('commerce.stripe.secretInvalid')
              : mixedModes
                ? t('commerce.stripe.mixedModes')
                : null
        }
      >
        {(id) => (
          <Input id={id} type="password" className="font-mono" autoComplete="new-password" value={secret} placeholder="sk_live_… / rk_live_…" onChange={(e) => setSecret(e.target.value)} />
        )}
      </FormField>
      <FormField
        label={t('commerce.stripe.webhookSecret')}
        hint={initial.webhook_secret_hint ? t('commerce.stripe.keepHint', { hint: initial.webhook_secret_hint }) : t('commerce.stripe.webhookSecretHint')}
        error={webhookValid ? null : t('commerce.stripe.webhookSecretInvalid')}
      >
        {(id) => (
          <Input id={id} type="password" className="font-mono" autoComplete="new-password" value={webhookSecret} placeholder="whsec_…" onChange={(e) => setWebhookSecret(e.target.value)} />
        )}
      </FormField>
      {initial.webhook_url ? (
        <div className="grid gap-1 text-sm">
          <span className="font-medium">{t('commerce.stripe.webhookUrl')}</span>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto rounded bg-muted px-2 py-1.5 text-xs">{initial.webhook_url}</code>
            <Button type="button" variant="outline" size="sm" onClick={() => void navigator.clipboard.writeText(initial.webhook_url ?? '')}>
              <Copy aria-hidden /> {t('common.copy')}
            </Button>
          </div>
          <span className="text-xs text-muted-foreground">{t('commerce.stripe.webhookEvents')}</span>
        </div>
      ) : null}
      {check ? (
        <p role="status" className={check.ok ? 'text-sm text-emerald-700 dark:text-emerald-400' : 'text-sm text-destructive'}>
          {check.ok ? t('commerce.stripe.checkOk') : t('commerce.stripe.checkFailed', { message: check.message ?? '' })}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={!publishableValid || !secretValid || !webhookValid || mixedModes || save.isPending}>
          <Save aria-hidden /> {t('common.save')}
        </Button>
        {initial.configured ? (
          <>
            <Button type="button" variant="outline" disabled={verify.isPending} onClick={() => verify.mutate(undefined)}>
              <PlugZap aria-hidden /> {t('commerce.stripe.check')}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="text-destructive"
              disabled={disconnect.isPending}
              onClick={() => setConfirmDisconnect(true)}
            >
              <Unplug aria-hidden /> {t('commerce.stripe.disconnect')}
            </Button>
          </>
        ) : null}
      </div>
      <DashboardConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title={t('commerce.stripe.disconnectConfirm')}
        description={t('commerce.stripe.disconnectBody')}
        confirmLabel={t('commerce.stripe.disconnect')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onConfirm={() => {
          disconnect.mutate(undefined);
          setConfirmDisconnect(false);
        }}
      />
      <DashboardConfirmDialog
        open={confirmSwitch}
        onOpenChange={setConfirmSwitch}
        title={t(keyMode === 'live' ? 'commerce.stripe.switchToLive' : 'commerce.stripe.switchToTest')}
        description={switchWarning}
        confirmLabel={t('common.save')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onConfirm={() => {
          save.mutate(undefined);
          setConfirmSwitch(false);
        }}
      />
    </form>
  );
}
