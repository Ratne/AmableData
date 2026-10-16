import type { Order } from '@amable/api-types';
import { DashboardButton, PageBody, PageToolbar, toast, usePageChrome } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { Textarea } from '@amable/ui/ui/textarea';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { ArrowLeft, ArrowRight, Check, Loader2, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../../i18n';
import { CommerceApiError } from '../api/client';
import {
  commerceKeys,
  errorMessage,
  useCatalog,
  useCommerce,
  useCommerceSettings,
  useMoney,
  usePermissions,
} from '../api/hooks';
import {
  ChoiceSelect,
  ErrorNotice,
  FormField,
  MoneyInput,
  PercentInput,
  SectionCard,
  intervalText,
} from '../components/common';
import { ContactPicker, contactLabel, type PickedContact } from '../components/contact-picker';
import { TotalsTable } from '../components/totals-table';
import { formatBps } from '../lib/money';
import {
  buildDraftCreate,
  buildDraftUpdate,
  buildSubscriptionInputs,
  canPriceOrder,
  draftSignature,
  EMPTY_WIZARD,
  type WizardLine,
  type WizardState,
} from '../lib/order-draft';

type Step = 'contact' | 'items' | 'review';
const STEPS: readonly Step[] = ['contact', 'items', 'review'];

interface DraftState {
  readonly order: Order;
  readonly signature: string;
}

let lineSeq = 0;
const nextKey = () => {
  lineSeq += 1;
  return `l${String(lineSeq)}`;
};

export function OrderWizardPage() {
  const { t, locale } = useI18n();
  const { slug, api } = useCommerce();
  const { can, ready } = usePermissions();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const money = useMoney();
  const search: { contact?: string } = useSearch({ strict: false });
  const catalog = useCatalog();
  const settings = useCommerceSettings();
  usePageChrome({ title: t('commerce.wizard.title') });

  const [step, setStep] = useState<Step>('contact');
  const [contact, setContact] = useState<PickedContact | null>(null);
  const [state, setState] = useState<WizardState>(EMPTY_WIZARD);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [pricing, setPricing] = useState(false);
  const [priceError, setPriceError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);
  const pricingRun = useRef(0);

  // Preselected contact (?contact=…), e.g. from the contact page.
  const preset = useQuery({
    queryKey: [...commerceKeys.contacts(slug), 'one', search.contact ?? ''],
    enabled: search.contact !== undefined && contact === null,
    queryFn: () => api.contacts.get(search.contact ?? ''),
  });
  const presetApplied = useRef(false);
  useEffect(() => {
    if (preset.data === undefined || presetApplied.current) return;
    presetApplied.current = true;
    setContact(contactLabel(preset.data));
    setState((s) => ({ ...s, contactId: preset.data.id }));
    setStep('items');
  }, [preset.data]);

  const update = (patch: Partial<WizardState>) => setState((s) => ({ ...s, ...patch }));
  const setLine = (key: string, patch: Partial<WizardLine>) =>
    setState((s) => ({
      ...s,
      lines: s.lines.map((line) =>
        line.key === key ? ({ ...line, ...patch } as WizardLine) : line,
      ),
    }));

  const currency = (() => {
    const first = state.lines.find((line) => line.kind === 'product');
    if (first?.kind === 'product') return catalog.byId.get(first.productId)?.currency ?? 'EUR';
    return settings.data?.default_currency ?? 'EUR';
  })();

  const signature = draftSignature(state);
  const priceable = canPriceOrder(state);

  // Debounced server-side pricing of the draft while on the review step.
  useEffect(() => {
    if (step !== 'review' || !priceable) return;
    if (draft !== null && draft.signature === signature) return;
    const run = ++pricingRun.current;
    const timer = window.setTimeout(() => {
      setPricing(true);
      setPriceError(null);
      const sameContact = draft !== null && draft.order.contact_id === state.contactId;
      const work = async (): Promise<Order> => {
        if (sameContact && draft !== null)
          return api.orders.update(draft.order.id, buildDraftUpdate(state));
        if (draft !== null) await api.orders.remove(draft.order.id).catch(() => undefined);
        return api.orders.create(buildDraftCreate(state));
      };
      work()
        .then((order) => {
          if (run === pricingRun.current) setDraft({ order, signature });
        })
        .catch((error: unknown) => {
          if (run === pricingRun.current) setPriceError(error);
        })
        .finally(() => {
          if (run === pricingRun.current) setPricing(false);
        });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [step, priceable, signature, draft, state, api]);

  const previewFresh = draft !== null && draft.signature === signature && !pricing;
  const promoError =
    priceError instanceof CommerceApiError &&
    (priceError.details.some((d) => d.path.startsWith('promo')) ||
      /promo/i.test(priceError.detail ?? ''))
      ? errorMessage(t, priceError)
      : null;

  const finish = async () => {
    setSubmitting(true);
    try {
      let orderId: string | null = null;
      if (state.lines.length > 0) {
        if (!previewFresh || draft === null) return;
        const order = await api.orders.finalize(draft.order.id);
        orderId = order.id;
      }
      const subscriptions = [];
      for (const input of buildSubscriptionInputs(state)) {
        subscriptions.push(await api.subscriptions.create(input));
      }
      await queryClient.invalidateQueries({ queryKey: commerceKeys.root(slug) });
      toast.success(t('commerce.wizard.created'));
      if (orderId !== null) {
        void navigate({ to: '/t/$tenant/orders/$orderId', params: { tenant: slug, orderId } });
      } else if (subscriptions[0]) {
        void navigate({
          to: '/t/$tenant/subscriptions/$subscriptionId',
          params: { tenant: slug, subscriptionId: subscriptions[0].id },
        });
      }
    } catch (error) {
      toast.error(errorMessage(t, error));
    } finally {
      setSubmitting(false);
    }
  };

  const discard = async () => {
    if (draft !== null) await api.orders.remove(draft.order.id).catch(() => undefined);
    await queryClient.invalidateQueries({ queryKey: commerceKeys.orders(slug) });
    void navigate({ to: '/t/$tenant/orders', params: { tenant: slug } });
  };

  if (ready && !can('orders:write')) {
    return (
      <PageBody className="pt-4">
        <ErrorNotice error={new CommerceApiError(403, 'forbidden', null, [])} />
      </PageBody>
    );
  }

  const activeProducts = catalog.products.filter((p) => p.active);
  const activePlans = catalog.plans.filter((entry) => entry.plan.active && entry.product.active);
  const stepIndex = STEPS.indexOf(step);
  const canNext =
    step === 'contact'
      ? state.contactId !== null
      : state.lines.length > 0 || state.plans.length > 0;

  return (
    <>
      <PageToolbar
        filters={
          <ol
            className="flex flex-wrap items-center gap-2 text-sm"
            aria-label={t('commerce.wizard.steps')}
          >
            {STEPS.map((s, index) => (
              <li key={s} className="flex items-center gap-2">
                <span
                  aria-current={s === step ? 'step' : undefined}
                  className={`flex size-6 items-center justify-center rounded-full text-xs font-medium ${
                    index < stepIndex
                      ? 'bg-primary text-primary-foreground'
                      : s === step
                        ? 'border-2 border-primary text-foreground'
                        : 'border text-muted-foreground'
                  }`}
                >
                  {index < stepIndex ? <Check className="size-3.5" aria-hidden /> : index + 1}
                </span>
                <span className={s === step ? 'font-medium' : 'text-muted-foreground'}>
                  {t(`commerce.wizard.step.${s}`)}
                </span>
                {index < STEPS.length - 1 ? <span className="text-muted-foreground">›</span> : null}
              </li>
            ))}
          </ol>
        }
        actions={
          <DashboardButton variant="ghost" onClick={() => void discard()}>
            {t('commerce.wizard.discard')}
          </DashboardButton>
        }
      />
      <PageBody className="grid max-w-5xl gap-4">
        {step === 'contact' ? (
          <SectionCard title={t('commerce.wizard.step.contact')}>
            <ContactPicker
              value={contact}
              onChange={(picked) => {
                setContact(picked);
                update({ contactId: picked?.id ?? null });
              }}
            />
          </SectionCard>
        ) : null}

        {step === 'items' ? (
          <>
            <SectionCard
              title={t('commerce.wizard.products')}
              actions={
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    update({
                      lines: [
                        ...state.lines,
                        {
                          key: nextKey(),
                          kind: 'custom',
                          name: '',
                          quantity: 1,
                          unitPriceMinor: 0,
                          taxRateBps: settings.data?.default_tax_rate_bps ?? 0,
                        },
                      ],
                    })
                  }
                >
                  <Plus aria-hidden /> {t('commerce.wizard.customLine')}
                </Button>
              }
            >
              <div className="mb-3 max-w-md">
                <ChoiceSelect
                  value=""
                  onChange={(productId) => {
                    const product = catalog.byId.get(productId);
                    if (!product) return;
                    update({
                      lines: [
                        ...state.lines,
                        {
                          key: nextKey(),
                          kind: 'product',
                          productId,
                          name: product.name,
                          quantity: 1,
                          unitPriceMinor: null,
                          taxRateBps: null,
                        },
                      ],
                    });
                  }}
                  placeholder={t('commerce.wizard.addProduct')}
                  ariaLabel={t('commerce.wizard.addProduct')}
                  choices={activeProducts.map((p) => ({
                    value: p.id,
                    label: `${p.name}${p.sku ? ` (${p.sku})` : ''} — ${money(p.price_minor, p.currency)}`,
                  }))}
                  className="w-full"
                />
              </div>
              {state.lines.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('commerce.wizard.noLines')}</p>
              ) : (
                <div className="grid gap-2">
                  {state.lines.map((line) => {
                    const product =
                      line.kind === 'product' ? catalog.byId.get(line.productId) : undefined;
                    return (
                      <div
                        key={line.key}
                        className="grid items-end gap-2 rounded-lg border p-2 sm:grid-cols-[minmax(0,1fr)_5rem_9rem_6rem_auto]"
                      >
                        {line.kind === 'product' ? (
                          <div className="min-w-0 self-center">
                            <p className="truncate text-sm font-medium">{line.name}</p>
                            <p className="truncate text-xs text-muted-foreground">
                              {product?.sku ?? ''}
                            </p>
                          </div>
                        ) : (
                          <Input
                            value={line.name}
                            placeholder={t('commerce.wizard.lineName')}
                            aria-label={t('commerce.wizard.lineName')}
                            onChange={(e) => setLine(line.key, { name: e.target.value })}
                          />
                        )}
                        <Input
                          type="number"
                          min={1}
                          value={line.quantity}
                          aria-label={t('commerce.field.quantity')}
                          onChange={(e) =>
                            setLine(line.key, {
                              quantity: Math.max(1, Math.trunc(Number(e.target.value)) || 1),
                            })
                          }
                        />
                        <MoneyInput
                          currency={product?.currency ?? currency}
                          value={line.unitPriceMinor}
                          ariaLabel={t('commerce.field.unitPrice')}
                          placeholder={
                            product ? money(product.price_minor, product.currency) : undefined
                          }
                          onChange={(minor) =>
                            setLine(
                              line.key,
                              line.kind === 'product'
                                ? { unitPriceMinor: minor }
                                : { unitPriceMinor: minor ?? 0 },
                            )
                          }
                        />
                        <PercentInput
                          value={line.taxRateBps}
                          ariaLabel={t('commerce.field.taxRate')}
                          placeholder={
                            product ? formatBps(product.tax_rate_bps, locale) : undefined
                          }
                          onChange={(bps) =>
                            setLine(
                              line.key,
                              line.kind === 'product'
                                ? { taxRateBps: bps }
                                : { taxRateBps: bps ?? 0 },
                            )
                          }
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('commerce.common.remove')}
                          onClick={() =>
                            update({ lines: state.lines.filter((l) => l.key !== line.key) })
                          }
                        >
                          <Trash2 aria-hidden />
                        </Button>
                      </div>
                    );
                  })}
                  <p className="text-xs text-muted-foreground">
                    {t('commerce.wizard.overrideHint')}
                  </p>
                </div>
              )}
            </SectionCard>

            <SectionCard title={t('commerce.wizard.plans')}>
              <p className="mb-3 text-sm text-muted-foreground">{t('commerce.wizard.plansHint')}</p>
              <div className="mb-3 max-w-md">
                <ChoiceSelect
                  value=""
                  onChange={(planId) => {
                    const entry = catalog.planById.get(planId);
                    if (!entry) return;
                    update({
                      plans: [
                        ...state.plans,
                        {
                          key: nextKey(),
                          planId,
                          name: `${entry.product.name} — ${entry.plan.name}`,
                          quantity: 1,
                        },
                      ],
                    });
                  }}
                  placeholder={t('commerce.wizard.addPlan')}
                  ariaLabel={t('commerce.wizard.addPlan')}
                  choices={activePlans.map(({ plan, product }) => ({
                    value: plan.id,
                    label: `${product.name} — ${plan.name} · ${money(plan.price_minor, plan.currency)} / ${intervalText(t, plan.interval, plan.interval_count)}`,
                  }))}
                  className="w-full"
                />
              </div>
              {state.plans.length > 0 ? (
                <ul className="grid gap-2">
                  {state.plans.map((plan) => {
                    const entry = catalog.planById.get(plan.planId);
                    return (
                      <li
                        key={plan.key}
                        className="grid items-center gap-2 rounded-lg border p-2 sm:grid-cols-[minmax(0,1fr)_5rem_auto]"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{plan.name}</p>
                          {entry ? (
                            <p className="text-xs text-muted-foreground">
                              {money(entry.plan.price_minor, entry.plan.currency)} /{' '}
                              {intervalText(t, entry.plan.interval, entry.plan.interval_count)}
                              {entry.plan.trial_days > 0
                                ? ` · ${t('commerce.plan.trial', { days: entry.plan.trial_days })}`
                                : ''}
                            </p>
                          ) : null}
                        </div>
                        <Input
                          type="number"
                          min={1}
                          value={plan.quantity}
                          aria-label={t('commerce.field.quantity')}
                          onChange={(e) =>
                            update({
                              plans: state.plans.map((p) =>
                                p.key === plan.key
                                  ? {
                                      ...p,
                                      quantity: Math.max(
                                        1,
                                        Math.trunc(Number(e.target.value)) || 1,
                                      ),
                                    }
                                  : p,
                              ),
                            })
                          }
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('commerce.common.remove')}
                          onClick={() =>
                            update({ plans: state.plans.filter((p) => p.key !== plan.key) })
                          }
                        >
                          <Trash2 aria-hidden />
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </SectionCard>
          </>
        ) : null}

        {step === 'review' ? (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
            <SectionCard
              title={t('commerce.wizard.preview')}
              actions={
                pricing ? (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" aria-hidden />
                    {t('commerce.wizard.pricing')}
                  </span>
                ) : null
              }
            >
              {state.lines.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('commerce.wizard.onlyPlans')}</p>
              ) : priceError !== null && promoError === null ? (
                <ErrorNotice error={priceError} />
              ) : draft !== null ? (
                <div className={previewFresh ? '' : 'opacity-60 transition-opacity'}>
                  <TotalsTable order={draft.order} />
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
              )}
              {state.plans.length > 0 ? (
                <div className="mt-4 border-t pt-3 text-sm">
                  <p className="mb-1 font-medium">{t('commerce.wizard.plansOnConfirm')}</p>
                  <ul className="grid gap-1 text-muted-foreground">
                    {state.plans.map((plan) => (
                      <li key={plan.key}>
                        {plan.quantity} × {plan.name}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </SectionCard>
            <div className="grid content-start gap-4">
              <SectionCard title={t('commerce.wizard.adjustments')}>
                <div className="grid gap-3">
                  <FormField label={t('commerce.field.contact')}>
                    {() => <p className="text-sm font-medium">{contact?.name || contact?.email}</p>}
                  </FormField>
                  <FormField label={t('commerce.field.promoCode')} error={promoError}>
                    {(id) => (
                      <Input
                        id={id}
                        value={state.promoCode}
                        aria-invalid={promoError !== null}
                        className="uppercase"
                        onChange={(e) => update({ promoCode: e.target.value })}
                      />
                    )}
                  </FormField>
                  <FormField label={t('commerce.field.shipping')}>
                    {(id) => (
                      <MoneyInput
                        id={id}
                        currency={currency}
                        value={state.shippingMinor}
                        onChange={(minor) => update({ shippingMinor: minor ?? 0 })}
                      />
                    )}
                  </FormField>
                  <FormField label={t('commerce.field.notes')}>
                    {(id) => (
                      <Textarea
                        id={id}
                        rows={3}
                        value={state.notes}
                        onChange={(e) => update({ notes: e.target.value })}
                      />
                    )}
                  </FormField>
                </div>
              </SectionCard>
            </div>
          </div>
        ) : null}

        <div className="flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={stepIndex === 0}
            onClick={() => setStep(STEPS[stepIndex - 1] ?? 'contact')}
          >
            <ArrowLeft aria-hidden /> {t('common.back')}
          </Button>
          <div className="flex items-center gap-2">
            {step === 'review' && draft !== null && previewFresh ? (
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  void navigate({
                    to: '/t/$tenant/orders/$orderId',
                    params: { tenant: slug, orderId: draft.order.id },
                  })
                }
              >
                {t('commerce.wizard.saveDraft')}
              </Button>
            ) : null}
            {step === 'review' ? (
              <Button
                type="button"
                disabled={
                  submitting ||
                  (state.lines.length > 0 && (!previewFresh || priceError !== null)) ||
                  (state.lines.length === 0 && state.plans.length === 0)
                }
                onClick={() => void finish()}
              >
                <Check aria-hidden /> {t('commerce.wizard.confirm')}
              </Button>
            ) : (
              <Button
                type="button"
                disabled={!canNext}
                onClick={() => setStep(STEPS[stepIndex + 1] ?? 'review')}
              >
                {t('common.continue')} <ArrowRight aria-hidden />
              </Button>
            )}
          </div>
        </div>
      </PageBody>
    </>
  );
}
