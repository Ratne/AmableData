import { isCurrencyCode, type CreatePromoCodeInput, type PromoCode } from '@amable/api-types';
import {
  DashboardButton,
  ListTable,
  PageBody,
  PageToolbar,
  usePageChrome,
  type ListTableColumn,
} from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { RadioGroup, RadioGroupItem } from '@amable/ui/ui/radio-group';
import { Switch } from '@amable/ui/ui/switch';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useI18n } from '../../../i18n';
import { CurrencySelect } from '../components/currency-select';
import { listTableLabels } from '../../../lib/labels';
import { fetchAllPages } from '../../../lib/api';
import {
  commerceKeys,
  useCatalog,
  useCommerce,
  useCommerceMutation,
  useCommerceSettings,
  useDates,
  useMoney,
  usePermissions,
} from '../api/hooks';
import { ErrorNotice, FormField, MoneyInput, PercentInput, Pill } from '../components/common';
import { formatBps } from '../lib/money';

/** `YYYY-MM-DD` (local) of an ISO timestamp, for date inputs. */
function toDateInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fromDateInput(value: string, endOfDay: boolean): string | null {
  if (!value) return null;
  return new Date(`${value}T${endOfDay ? '23:59:59' : '00:00:00'}`).toISOString();
}

function promoState(
  promo: PromoCode,
  now: number,
): 'active' | 'scheduled' | 'expired' | 'exhausted' | 'inactive' {
  if (!promo.active) return 'inactive';
  if (promo.max_redemptions !== null && promo.redemptions >= promo.max_redemptions)
    return 'exhausted';
  if (promo.ends_at && Date.parse(promo.ends_at) < now) return 'expired';
  if (promo.starts_at && Date.parse(promo.starts_at) > now) return 'scheduled';
  return 'active';
}

const STATE_TONE = {
  active: 'success',
  scheduled: 'info',
  expired: 'neutral',
  exhausted: 'warning',
  inactive: 'neutral',
} as const;

export function PromotionsPage() {
  const { t, locale } = useI18n();
  const { slug, api } = useCommerce();
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const money = useMoney();
  const { date } = useDates();
  usePageChrome({ title: t('nav.promotions') });
  const [editing, setEditing] = useState<PromoCode | 'new' | null>(null);
  const promos = useQuery({
    queryKey: commerceKeys.promoCodes(slug),
    queryFn: () => fetchAllPages((cursor) => api.promoCodes.list({ cursor, limit: 200 })),
  });
  const now = Date.now();
  const editable = can('products:write');

  const columns: ListTableColumn<PromoCode>[] = [
    {
      id: 'code',
      header: t('commerce.field.code'),
      cell: (p) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-mono font-medium">{p.code}</span>
          {p.description ? (
            <span className="truncate text-xs text-muted-foreground">{p.description}</span>
          ) : null}
        </span>
      ),
      sortable: true,
      sortValue: (p) => p.code,
    },
    {
      id: 'discount',
      header: t('commerce.field.discount'),
      cell: (p) =>
        p.kind === 'percent'
          ? formatBps(p.percent_bps ?? 0, locale)
          : money(p.amount_minor ?? 0, p.currency ?? 'EUR'),
    },
    {
      id: 'usage',
      header: t('commerce.promo.usage'),
      cell: (p) =>
        p.max_redemptions !== null
          ? `${String(p.redemptions)} / ${String(p.max_redemptions)}`
          : p.redemptions,
      align: 'right',
      sortable: true,
      sortValue: (p) => p.redemptions,
      hideBelow: 'md',
    },
    {
      id: 'window',
      header: t('commerce.promo.validity'),
      cell: (p) =>
        p.starts_at || p.ends_at
          ? `${p.starts_at ? date(p.starts_at) : '…'} – ${p.ends_at ? date(p.ends_at) : '…'}`
          : t('commerce.promo.always'),
      hideBelow: 'lg',
    },
    {
      id: 'state',
      header: t('commerce.field.status'),
      cell: (p) => {
        const state = promoState(p, now);
        return <Pill tone={STATE_TONE[state]}>{t(`commerce.promo.state.${state}`)}</Pill>;
      },
    },
  ];

  return (
    <>
      <PageToolbar
        actions={
          editable ? (
            <DashboardButton variant="primary" onClick={() => setEditing('new')}>
              <Plus aria-hidden /> {t('commerce.promo.new')}
            </DashboardButton>
          ) : null
        }
      />
      {promos.error ? (
        <PageBody>
          <ErrorNotice error={promos.error} />
        </PageBody>
      ) : (
        <ListTable<PromoCode>
          className="px-4"
          rows={promos.data ?? []}
          getRowId={(p) => p.id}
          getRowLabel={(p) => p.code}
          columns={columns}
          labels={listTableLabels(t)}
          defaultSort={{ columnId: 'code', direction: 'asc' }}
          selectable={editable}
          loading={promos.isPending}
          onRowOpen={editable ? (p) => setEditing(p) : undefined}
          deletion={
            editable
              ? {
                  onDelete: async (rows) => {
                    await Promise.all(rows.map((p) => api.promoCodes.remove(p.id)));
                    await queryClient.invalidateQueries({
                      queryKey: commerceKeys.promoCodes(slug),
                    });
                  },
                }
              : undefined
          }
          emptyState={
            <p className="py-10 text-center text-sm text-muted-foreground">
              {t('commerce.promo.empty')}
            </p>
          }
        />
      )}
      {editing !== null ? (
        <PromoDialog promo={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      ) : null}
    </>
  );
}

function PromoDialog({ promo, onClose }: { promo: PromoCode | null; onClose: () => void }) {
  const { t } = useI18n();
  const { api } = useCommerce();
  const settings = useCommerceSettings();
  const catalog = useCatalog();
  const [code, setCode] = useState(promo?.code ?? '');
  const [description, setDescription] = useState(promo?.description ?? '');
  const [kind, setKind] = useState<'percent' | 'fixed'>(promo?.kind ?? 'percent');
  const [percent, setPercent] = useState<number | null>(promo?.percent_bps ?? 1000);
  const [currencyChoice, setCurrency] = useState<string | null>(promo?.currency ?? null);
  const currency = currencyChoice ?? settings.data?.default_currency ?? 'EUR';
  const [amount, setAmount] = useState<number | null>(promo?.amount_minor ?? null);
  const [minSubtotal, setMinSubtotal] = useState<number | null>(promo?.min_subtotal_minor ?? null);
  const [maxRedemptions, setMaxRedemptions] = useState(promo?.max_redemptions?.toString() ?? '');
  const [maxPerContact, setMaxPerContact] = useState(promo?.max_per_contact?.toString() ?? '');
  const [startsAt, setStartsAt] = useState(toDateInput(promo?.starts_at ?? null));
  const [endsAt, setEndsAt] = useState(toDateInput(promo?.ends_at ?? null));
  const [productIds, setProductIds] = useState<string[]>(promo?.product_ids ?? []);
  const [active, setActive] = useState(promo?.active ?? true);

  const limit = (text: string) => {
    const n = Math.trunc(Number(text));
    return text.trim() === '' || !Number.isFinite(n) || n < 1 ? null : n;
  };
  const codeValid = promo !== null || /^[A-Za-z0-9_-]{3,40}$/.test(code.trim());
  const valueValid =
    kind === 'percent' ? percent !== null && percent >= 1 : amount !== null && amount > 0;
  const windowValid = !startsAt || !endsAt || startsAt <= endsAt;
  const valid = codeValid && valueValid && windowValid && isCurrencyCode(currency);

  const save = useCommerceMutation({
    mutationFn: () => {
      const shared = {
        description: description.trim() || null,
        percent_bps: kind === 'percent' ? percent : null,
        amount_minor: kind === 'fixed' ? amount : null,
        currency: kind === 'fixed' || minSubtotal !== null ? currency : null,
        min_subtotal_minor: minSubtotal,
        product_ids: productIds.length > 0 ? productIds : null,
        max_redemptions: limit(maxRedemptions),
        max_per_contact: limit(maxPerContact),
        starts_at: fromDateInput(startsAt, false),
        ends_at: fromDateInput(endsAt, true),
        active,
      };
      if (promo) return api.promoCodes.update(promo.id, shared);
      const input: CreatePromoCodeInput = { ...shared, code: code.trim(), kind };
      return api.promoCodes.create(input);
    },
    success: t('commerce.common.saved'),
    onSuccess: onClose,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) save.mutate(undefined);
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>
              {promo ? t('commerce.promo.edit', { code: promo.code }) : t('commerce.promo.new')}
            </DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField
              label={t('commerce.field.code')}
              hint={promo ? t('commerce.promo.immutable') : t('commerce.promo.codeHint')}
              error={codeValid ? null : t('commerce.promo.codeInvalid')}
            >
              {(id) => (
                <Input
                  id={id}
                  autoFocus={promo === null}
                  value={code}
                  disabled={promo !== null}
                  className="font-mono uppercase"
                  onChange={(e) => setCode(e.target.value)}
                />
              )}
            </FormField>
            <FormField label={t('commerce.field.description')}>
              {(id) => (
                <Input
                  id={id}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              )}
            </FormField>
          </div>
          <FormField label={t('commerce.promo.kind')}>
            {() => (
              <RadioGroup
                value={kind}
                onValueChange={(value) => setKind(value === 'fixed' ? 'fixed' : 'percent')}
                disabled={promo !== null}
                className="flex gap-4"
              >
                <label className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="percent" /> {t('commerce.promo.percent')}
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="fixed" /> {t('commerce.promo.fixed')}
                </label>
              </RadioGroup>
            )}
          </FormField>
          <FormField label={t('commerce.field.currency')} hint={t('commerce.promo.currencyHint')}>
            {(id) => (
              <CurrencySelect
                id={id}
                value={currency}
                onChange={setCurrency}
                {...(settings.data ? { defaultCurrency: settings.data.default_currency } : {})}
              />
            )}
          </FormField>
          <div className="grid gap-3 sm:grid-cols-2">
            {kind === 'percent' ? (
              <FormField label={t('commerce.promo.percentOff')}>
                {(id) => <PercentInput id={id} value={percent} onChange={setPercent} />}
              </FormField>
            ) : (
              <FormField label={t('commerce.promo.amountOff')}>
                {(id) => (
                  <MoneyInput id={id} value={amount} onChange={setAmount} currency={currency} />
                )}
              </FormField>
            )}
            <FormField label={t('commerce.promo.minSubtotal')}>
              {(id) => (
                <MoneyInput
                  id={id}
                  value={minSubtotal}
                  onChange={setMinSubtotal}
                  currency={currency}
                />
              )}
            </FormField>
            <FormField
              label={t('commerce.promo.maxRedemptions')}
              hint={t('commerce.promo.unlimitedHint')}
            >
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min={1}
                  value={maxRedemptions}
                  onChange={(e) => setMaxRedemptions(e.target.value)}
                />
              )}
            </FormField>
            <FormField
              label={t('commerce.promo.maxPerContact')}
              hint={t('commerce.promo.unlimitedHint')}
            >
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min={1}
                  value={maxPerContact}
                  onChange={(e) => setMaxPerContact(e.target.value)}
                />
              )}
            </FormField>
            <FormField label={t('commerce.promo.startsAt')}>
              {(id) => (
                <Input
                  id={id}
                  type="date"
                  value={startsAt}
                  onChange={(e) => setStartsAt(e.target.value)}
                />
              )}
            </FormField>
            <FormField
              label={t('commerce.promo.endsAt')}
              error={windowValid ? null : t('commerce.promo.windowInvalid')}
            >
              {(id) => (
                <Input
                  id={id}
                  type="date"
                  value={endsAt}
                  onChange={(e) => setEndsAt(e.target.value)}
                />
              )}
            </FormField>
          </div>
          <FormField label={t('commerce.promo.products')} hint={t('commerce.promo.productsHint')}>
            {() => (
              <div className="grid max-h-40 gap-1 overflow-y-auto rounded-lg border p-2">
                {catalog.products.map((product) => (
                  <label key={product.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      checked={productIds.includes(product.id)}
                      onChange={(e) =>
                        setProductIds((ids) =>
                          e.target.checked
                            ? [...ids, product.id]
                            : ids.filter((id) => id !== product.id),
                        )
                      }
                    />
                    <span className="truncate">{product.name}</span>
                  </label>
                ))}
              </div>
            )}
          </FormField>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={active} onCheckedChange={setActive} />
            {active ? t('commerce.common.active') : t('commerce.common.inactive')}
          </label>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!valid || save.isPending}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
