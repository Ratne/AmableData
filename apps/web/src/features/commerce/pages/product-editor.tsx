import {
  BILLING_INTERVALS,
  isCurrencyCode,
  type BillingInterval,
  type Plan,
  type Product,
} from '@amable/api-types';
import { DashboardButton, PageBody, PageToolbar, usePageChrome } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { Switch } from '@amable/ui/ui/switch';
import { Textarea } from '@amable/ui/ui/textarea';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { Pencil, Plus, Save, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useI18n } from '../../../i18n';
import { CurrencySelect } from '../components/currency-select';
import {
  commerceKeys,
  useCategories,
  useCommerce,
  useCommerceMutation,
  useCommerceSettings,
  useMoney,
  usePermissions,
} from '../api/hooks';
import {
  ChoiceSelect,
  FormField,
  MoneyInput,
  PageState,
  PercentInput,
  Pill,
  SectionCard,
  intervalText,
} from '../components/common';
import { productDetailRoute } from '../routes';

export function ProductEditorPage() {
  const { productId } = useParams({ from: productDetailRoute.id });
  const { slug, api } = useCommerce();
  const isNew = productId === 'new';
  const product = useQuery({
    queryKey: commerceKeys.product(slug, productId),
    enabled: !isNew,
    queryFn: () => api.products.get(productId),
  });
  const settings = useCommerceSettings();
  if (isNew) {
    return (
      <PageState isPending={settings.isPending} error={null}>
        {() => (
          <ProductForm
            product={null}
            defaultCurrency={settings.data?.default_currency ?? 'EUR'}
            defaultTaxBps={settings.data?.default_tax_rate_bps ?? 0}
          />
        )}
      </PageState>
    );
  }
  return (
    <PageState isPending={product.isPending} error={product.error}>
      {() =>
        product.data ? (
          <ProductForm
            key={product.data.updated_at}
            product={product.data}
            defaultCurrency={product.data.currency}
            defaultTaxBps={product.data.tax_rate_bps}
          />
        ) : null
      }
    </PageState>
  );
}

function ProductForm({
  product,
  defaultCurrency,
  defaultTaxBps,
}: {
  product: Product | null;
  defaultCurrency: string;
  defaultTaxBps: number;
}) {
  const { t } = useI18n();
  const { slug, api } = useCommerce();
  const { can } = usePermissions();
  const navigate = useNavigate();
  const { categories } = useCategories();
  const editable = can('products:write');
  usePageChrome({
    title: product ? product.name : t('commerce.products.new'),
    ...(product
      ? {
          status: product.active ? t('commerce.common.active') : t('commerce.common.inactive'),
          statusTone: product.active ? ('success' as const) : ('neutral' as const),
        }
      : {}),
  });

  const [name, setName] = useState(product?.name ?? '');
  const [sku, setSku] = useState(product?.sku ?? '');
  const [categoryId, setCategoryId] = useState(product?.category_id ?? '');
  const [description, setDescription] = useState(product?.description ?? '');
  const [price, setPrice] = useState<number | null>(product?.price_minor ?? null);
  const [currency, setCurrency] = useState(product?.currency ?? defaultCurrency);
  const [tax, setTax] = useState<number | null>(product?.tax_rate_bps ?? defaultTaxBps);
  const [active, setActive] = useState(product?.active ?? true);

  const currencyValid = isCurrencyCode(currency);
  const skuValid = sku.trim() === '' || /^[\w.\-/]+$/.test(sku.trim());
  const valid = name.trim() !== '' && price !== null && tax !== null && currencyValid && skuValid;

  const save = useCommerceMutation({
    mutationFn: () => {
      const input = {
        name: name.trim(),
        sku: sku.trim() || null,
        category_id: categoryId || null,
        description: description.trim() || null,
        price_minor: price ?? 0,
        currency,
        tax_rate_bps: tax ?? 0,
        active,
      };
      return product ? api.products.update(product.id, input) : api.products.create(input);
    },
    success: t('commerce.common.saved'),
    onSuccess: (saved) => {
      if (!product)
        void navigate({
          to: '/t/$tenant/products/$productId',
          params: { tenant: slug, productId: saved.id },
          replace: true,
        });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) save.mutate(undefined);
  };

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
      <PageBody className="grid max-w-4xl gap-4">
        <SectionCard title={t('commerce.products.details')}>
          <fieldset disabled={!editable} className="grid gap-3 sm:grid-cols-2">
            <FormField label={t('commerce.field.name')} className="sm:col-span-2">
              {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}
            </FormField>
            <FormField
              label={t('commerce.field.sku')}
              error={skuValid ? null : t('commerce.products.skuInvalid')}
            >
              {(id) => (
                <Input
                  id={id}
                  value={sku}
                  aria-invalid={!skuValid}
                  onChange={(e) => setSku(e.target.value)}
                />
              )}
            </FormField>
            <FormField label={t('commerce.field.category')}>
              {(id) => (
                <ChoiceSelect
                  id={id}
                  value={categoryId}
                  onChange={setCategoryId}
                  emptyLabel={t('commerce.common.none')}
                  choices={categories.map((c) => ({ value: c.id, label: c.name }))}
                  className="w-full"
                  disabled={!editable}
                />
              )}
            </FormField>
            <FormField label={t('commerce.field.price')}>
              {(id) => (
                <MoneyInput
                  id={id}
                  value={price}
                  onChange={setPrice}
                  currency={currencyValid ? currency : 'EUR'}
                />
              )}
            </FormField>
            <FormField
              label={t('commerce.field.currency')}
              error={currencyValid ? null : t('commerce.settings.currencyInvalid')}
            >
              {(id) => (
                <CurrencySelect
                  id={id}
                  value={currency} defaultCurrency={defaultCurrency}
                  invalid={!currencyValid}
                  onChange={setCurrency}
                />
              )}
            </FormField>
            <FormField label={t('commerce.field.taxRate')} hint={t('commerce.products.taxHint')}>
              {(id) => <PercentInput id={id} value={tax} onChange={setTax} />}
            </FormField>
            <FormField label={t('commerce.field.status')}>
              {(id) => (
                <label className="flex h-9 items-center gap-2 text-sm">
                  <Switch id={id} checked={active} onCheckedChange={setActive} />
                  {active ? t('commerce.common.active') : t('commerce.common.inactive')}
                </label>
              )}
            </FormField>
            <FormField label={t('commerce.field.description')} className="sm:col-span-2">
              {(id) => (
                <Textarea
                  id={id}
                  rows={4}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              )}
            </FormField>
          </fieldset>
        </SectionCard>
        {product ? (
          <PlansSection product={product} editable={editable} />
        ) : (
          <p className="text-sm text-muted-foreground">{t('commerce.plan.saveFirst')}</p>
        )}
      </PageBody>
    </form>
  );
}

function PlansSection({ product, editable }: { product: Product; editable: boolean }) {
  const { t } = useI18n();
  const { api } = useCommerce();
  const money = useMoney();
  const [editing, setEditing] = useState<Plan | 'new' | null>(null);
  const remove = useCommerceMutation({
    mutationFn: (planId: string) => api.plans.remove(planId),
    success: t('commerce.plan.deleted'),
  });
  return (
    <SectionCard
      title={t('commerce.field.plans')}
      actions={
        editable ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing('new')}>
            <Plus aria-hidden /> {t('commerce.plan.new')}
          </Button>
        ) : null
      }
    >
      {product.plans.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('commerce.plan.empty')}</p>
      ) : (
        <ul className="divide-y">
          {product.plans.map((plan) => (
            <li key={plan.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{plan.name}</span>
                <span className="block text-xs text-muted-foreground">
                  {intervalText(t, plan.interval, plan.interval_count)}
                  {plan.trial_days > 0
                    ? ` · ${t('commerce.plan.trial', { days: plan.trial_days })}`
                    : ''}
                </span>
              </span>
              {plan.active ? null : <Pill tone="neutral">{t('commerce.common.inactive')}</Pill>}
              <span className="font-medium tabular-nums">
                {money(plan.price_minor, plan.currency)}
              </span>
              {editable ? (
                <span className="flex gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('commerce.common.edit')}
                    onClick={() => setEditing(plan)}
                  >
                    <Pencil aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('commerce.common.remove')}
                    onClick={() => remove.mutate(plan.id)}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {editing !== null ? (
        <PlanDialog
          product={product}
          plan={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </SectionCard>
  );
}

function PlanDialog({
  product,
  plan,
  onClose,
}: {
  product: Product;
  plan: Plan | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { api } = useCommerce();
  const [name, setName] = useState(plan?.name ?? '');
  const [interval, setBillingInterval] = useState<BillingInterval>(plan?.interval ?? 'month');
  const [count, setCount] = useState(plan?.interval_count ?? 1);
  const [trial, setTrial] = useState(plan?.trial_days ?? 0);
  const [price, setPrice] = useState<number | null>(plan?.price_minor ?? product.price_minor);
  const [active, setActive] = useState(plan?.active ?? true);
  const save = useCommerceMutation({
    mutationFn: () => {
      const input = {
        name: name.trim(),
        interval,
        interval_count: count,
        trial_days: trial,
        price_minor: price ?? 0,
        active,
      };
      return plan ? api.plans.update(plan.id, input) : api.plans.create(product.id, input);
    },
    success: t('commerce.common.saved'),
    onSuccess: onClose,
  });
  const valid = name.trim() !== '' && price !== null && count >= 1 && count <= 36 && trial >= 0;
  // A nested <form> would submit the product form: this dialog saves through its button only.
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <div className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{plan ? t('commerce.plan.edit') : t('commerce.plan.new')}</DialogTitle>
          </DialogHeader>
          <FormField label={t('commerce.field.name')}>
            {(id) => (
              <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} />
            )}
          </FormField>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label={t('commerce.plan.every')}>
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min={1}
                  max={36}
                  value={count}
                  onChange={(e) => setCount(Math.trunc(Number(e.target.value)) || 1)}
                />
              )}
            </FormField>
            <FormField label={t('commerce.plan.interval')}>
              {(id) => (
                <ChoiceSelect
                  id={id}
                  value={interval}
                  onChange={(value) => setBillingInterval(value as BillingInterval)}
                  choices={BILLING_INTERVALS.map((value) => ({
                    value,
                    label: t(`commerce.intervalUnit.${value}`),
                  }))}
                  className="w-full"
                />
              )}
            </FormField>
            <FormField label={t('commerce.field.price')}>
              {(id) => (
                <MoneyInput id={id} value={price} onChange={setPrice} currency={product.currency} />
              )}
            </FormField>
            <FormField label={t('commerce.plan.trialDays')}>
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min={0}
                  max={730}
                  value={trial}
                  onChange={(e) => setTrial(Math.max(0, Math.trunc(Number(e.target.value)) || 0))}
                />
              )}
            </FormField>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={active} onCheckedChange={setActive} />
            {active ? t('commerce.common.active') : t('commerce.common.inactive')}
          </label>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              disabled={!valid || save.isPending}
              onClick={() => save.mutate(undefined)}
            >
              {t('common.save')}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
