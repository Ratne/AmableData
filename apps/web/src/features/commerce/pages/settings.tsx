import { isCurrencyCode } from '@amable/api-types';
import type { CommerceSettings } from '@amable/api-types';
import { DashboardButton, PageBody, PageToolbar, usePageChrome } from '@amable/ui';
import { Input } from '@amable/ui/ui/input';
import { Save } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useI18n } from '../../../i18n';
import { CurrencySelect } from '../components/currency-select';
import {
  useCommerce,
  useCommerceMutation,
  useCommerceSettings,
  useMoney,
  usePermissions,
} from '../api/hooks';
import { FormField, PageState, PercentInput, SectionCard } from '../components/common';

const PREFIX = /^[A-Za-z0-9_-]{0,12}$/;

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
    <form onSubmit={submit}>
      <PageToolbar
        actions={
          editable ? (
            <DashboardButton variant="primary" type="submit" disabled={!valid || save.isPending}>
              <Save aria-hidden /> {t('common.save')}
            </DashboardButton>
          ) : null
        }
      />
      <PageBody className="grid max-w-3xl gap-4">
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
      </PageBody>
    </form>
  );
}
