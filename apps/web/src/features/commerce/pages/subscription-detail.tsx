import type { Subscription } from '@amable/api-types';
import { DashboardButton, PageBody, PageToolbar, usePageChrome } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { RadioGroup, RadioGroupItem } from '@amable/ui/ui/radio-group';
import { Textarea } from '@amable/ui/ui/textarea';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeftRight, Ban, Pause, Play } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useI18n } from '../../../i18n';
import {
  commerceKeys,
  useCatalog,
  useCommerce,
  useCommerceMutation,
  useContactNames,
  useDates,
  useMoney,
  usePermissions,
} from '../api/hooks';
import {
  ChoiceSelect,
  Facts,
  FormField,
  OrderStatusPill,
  PageState,
  SectionCard,
  SubscriptionStatusPill,
  intervalText,
} from '../components/common';
import { formatBps } from '../lib/money';
import { subscriptionDetailRoute } from '../routes';

export function canPause(s: Pick<Subscription, 'status'>): boolean {
  return s.status === 'active' || s.status === 'past_due';
}

export function canResume(s: Pick<Subscription, 'status' | 'cancel_at_period_end'>): boolean {
  return s.status === 'paused' || (s.status !== 'cancelled' && s.cancel_at_period_end);
}

export function SubscriptionDetailPage() {
  const { subscriptionId } = useParams({ from: subscriptionDetailRoute.id });
  const { t, locale } = useI18n();
  const { slug, api } = useCommerce();
  const { can } = usePermissions();
  const navigate = useNavigate();
  const money = useMoney();
  const { date, dateTime } = useDates();
  const catalog = useCatalog();

  const sub = useQuery({
    queryKey: commerceKeys.subscription(slug, subscriptionId),
    queryFn: () => api.subscriptions.get(subscriptionId),
  });
  const orders = useQuery({
    queryKey: [...commerceKeys.orders(slug), 'bySubscription', subscriptionId],
    queryFn: async () =>
      (await api.orders.list({ subscription_id: subscriptionId, limit: 50 })).data,
  });
  const contacts = useContactNames(sub.data ? [sub.data.contact_id] : []);
  const [dialog, setDialog] = useState<'cancel' | 'change' | null>(null);

  const pause = useCommerceMutation({
    mutationFn: () => api.subscriptions.pause(subscriptionId),
    success: t('commerce.sub.paused'),
  });
  const resume = useCommerceMutation({
    mutationFn: () => api.subscriptions.resume(subscriptionId),
    success: t('commerce.sub.resumed'),
  });

  const entry = sub.data ? catalog.planById.get(sub.data.plan_id) : undefined;
  usePageChrome({
    title: entry ? `${entry.product.name} — ${entry.plan.name}` : t('nav.subscriptions'),
    ...(sub.data
      ? {
          status: t(`commerce.subStatus.${sub.data.status}`),
          statusTone:
            sub.data.status === 'active' || sub.data.status === 'trialing'
              ? ('success' as const)
              : sub.data.status === 'cancelled'
                ? ('neutral' as const)
                : ('warning' as const),
        }
      : {}),
  });

  return (
    <PageState isPending={sub.isPending} error={sub.error}>
      {() => {
        const s = sub.data;
        if (!s) return null;
        const writable = can('subscriptions:write');
        return (
          <>
            <PageToolbar
              filters={<SubscriptionStatusPill status={s.status} />}
              actions={
                writable && s.status !== 'cancelled' ? (
                  <>
                    {canResume(s) ? (
                      <DashboardButton
                        variant="primary"
                        disabled={resume.isPending}
                        onClick={() => resume.mutate(undefined)}
                      >
                        <Play aria-hidden /> {t('commerce.sub.resume')}
                      </DashboardButton>
                    ) : null}
                    {canPause(s) ? (
                      <DashboardButton
                        variant="ghost"
                        disabled={pause.isPending}
                        onClick={() => pause.mutate(undefined)}
                      >
                        <Pause aria-hidden /> {t('commerce.sub.pause')}
                      </DashboardButton>
                    ) : null}
                    <DashboardButton variant="ghost" onClick={() => setDialog('change')}>
                      <ArrowLeftRight aria-hidden /> {t('commerce.sub.changePlan')}
                    </DashboardButton>
                    <DashboardButton variant="ghost" onClick={() => setDialog('cancel')}>
                      <Ban aria-hidden /> {t('commerce.sub.cancel')}
                    </DashboardButton>
                  </>
                ) : null
              }
            />
            <PageBody className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <SectionCard title={t('commerce.sub.details')}>
                <Facts
                  rows={[
                    [
                      t('commerce.field.contact'),
                      <Link
                        key="c"
                        to="/t/$tenant/contacts/$contactId"
                        params={{ tenant: slug, contactId: s.contact_id }}
                        className="font-medium hover:underline"
                      >
                        {contacts.nameOf(s.contact_id)}
                      </Link>,
                    ],
                    [
                      t('commerce.field.plan'),
                      entry ? (
                        <Link
                          key="p"
                          to="/t/$tenant/products/$productId"
                          params={{ tenant: slug, productId: s.product_id }}
                          className="hover:underline"
                        >
                          {entry.product.name} — {entry.plan.name}
                        </Link>
                      ) : (
                        '—'
                      ),
                    ],
                    [
                      t('commerce.field.amount'),
                      `${money(s.amount_minor, s.currency)} / ${intervalText(t, s.interval, s.interval_count)}`,
                    ],
                    [
                      t('commerce.field.quantity'),
                      `${String(s.quantity)} × ${money(s.unit_price_minor, s.currency)}`,
                    ],
                    [t('commerce.field.taxRate'), formatBps(s.tax_rate_bps, locale)],
                    ...(s.discount
                      ? [
                          [
                            t('commerce.sub.discount'),
                            [
                              s.discount.promo_code ?? '',
                              s.discount.kind === 'percent'
                                ? `−${formatBps(s.discount.percent_bps ?? 0, locale)}`
                                : `−${money(s.discount.amount_minor ?? 0, s.currency)}`,
                              s.discount.periods_left === null
                                ? t('commerce.sub.discountForever')
                                : t('commerce.sub.discountPeriodsLeft', { count: s.discount.periods_left }),
                            ]
                              .filter(Boolean)
                              .join(' · '),
                          ] as const,
                        ]
                      : []),
                    [t('commerce.sub.autopay'), s.autopay ? t('commerce.sub.autopayOn') : t('commerce.sub.autopayOff')],
                    [t('commerce.sub.started'), date(s.started_at)],
                    ...(s.trial_ends_at
                      ? [[t('commerce.sub.trialEnds'), date(s.trial_ends_at)] as const]
                      : []),
                    [
                      t('commerce.sub.currentPeriod'),
                      s.current_period_start
                        ? `${date(s.current_period_start)} – ${date(s.current_period_end)}`
                        : '—',
                    ],
                    [
                      t('commerce.sub.nextBill'),
                      s.cancel_at_period_end
                        ? t('commerce.sub.endsOn', { date: date(s.current_period_end) })
                        : date(s.next_bill_at),
                    ],
                    ...(s.paused_at
                      ? [[t('commerce.sub.pausedAt'), dateTime(s.paused_at)] as const]
                      : []),
                    ...(s.ended_at
                      ? [[t('commerce.sub.endedAt'), dateTime(s.ended_at)] as const]
                      : []),
                    ...(s.cancel_reason
                      ? [[t('commerce.field.reason'), s.cancel_reason] as const]
                      : []),
                  ]}
                />
              </SectionCard>
              <SectionCard title={t('commerce.sub.orders')}>
                {orders.isPending ? (
                  <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
                ) : (orders.data ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('commerce.sub.noOrders')}</p>
                ) : (
                  <ul className="divide-y text-sm">
                    {(orders.data ?? []).map((o) => (
                      <li key={o.id}>
                        <button
                          type="button"
                          className="flex w-full items-center gap-3 py-2 text-left hover:bg-muted/50"
                          onClick={() =>
                            void navigate({
                              to: '/t/$tenant/orders/$orderId',
                              params: { tenant: slug, orderId: o.id },
                            })
                          }
                        >
                          <span className="w-28 font-medium tabular-nums">{o.number}</span>
                          <span className="flex-1 whitespace-nowrap text-muted-foreground">
                            {date(o.billing_period_start ?? o.order_date)}
                          </span>
                          <OrderStatusPill status={o.status} />
                          <span className="w-28 text-right tabular-nums">
                            {money(o.total_minor, o.currency)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </SectionCard>
            </PageBody>
            {dialog === 'cancel' ? <CancelDialog sub={s} onClose={() => setDialog(null)} /> : null}
            {dialog === 'change' ? (
              <ChangePlanDialog sub={s} onClose={() => setDialog(null)} />
            ) : null}
          </>
        );
      }}
    </PageState>
  );
}

function CancelDialog({ sub, onClose }: { sub: Subscription; onClose: () => void }) {
  const { t } = useI18n();
  const { api } = useCommerce();
  const { date } = useDates();
  const [when, setWhen] = useState<'period_end' | 'now'>(
    sub.cancel_at_period_end || sub.status === 'paused' ? 'now' : 'period_end',
  );
  const [reason, setReason] = useState('');
  const cancel = useCommerceMutation({
    mutationFn: () =>
      api.subscriptions.cancel(sub.id, {
        at_period_end: when === 'period_end',
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      }),
    success: t('commerce.sub.cancelled'),
    onSuccess: onClose,
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    cancel.mutate(undefined);
  };
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t('commerce.sub.cancelTitle')}</DialogTitle>
          </DialogHeader>
          <RadioGroup
            value={when}
            onValueChange={(value) => setWhen(value === 'now' ? 'now' : 'period_end')}
            className="grid gap-2"
          >
            {!sub.cancel_at_period_end && sub.current_period_end ? (
              <label className="flex items-center gap-2 text-sm">
                <RadioGroupItem value="period_end" />
                {t('commerce.sub.cancelAtEnd', { date: date(sub.current_period_end) })}
              </label>
            ) : null}
            <label className="flex items-center gap-2 text-sm">
              <RadioGroupItem value="now" /> {t('commerce.sub.cancelNow')}
            </label>
          </RadioGroup>
          <FormField label={t('commerce.field.reason')}>
            {(id) => (
              <Textarea
                id={id}
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            )}
          </FormField>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="destructive" disabled={cancel.isPending}>
              {t('commerce.sub.cancel')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ChangePlanDialog({ sub, onClose }: { sub: Subscription; onClose: () => void }) {
  const { t } = useI18n();
  const { api } = useCommerce();
  const money = useMoney();
  const catalog = useCatalog();
  const [planId, setPlanId] = useState('');
  const [quantity, setQuantity] = useState(sub.quantity);
  const change = useCommerceMutation({
    mutationFn: () =>
      api.subscriptions.changePlan(sub.id, {
        plan_id: planId,
        ...(quantity !== sub.quantity ? { quantity } : {}),
      }),
    success: t('commerce.sub.planChanged'),
    onSuccess: onClose,
  });
  const choices = catalog.plans
    .filter(({ plan }) => plan.active && plan.id !== sub.plan_id && plan.currency === sub.currency)
    .map(({ plan, product }) => ({
      value: plan.id,
      label: `${product.name} — ${plan.name} · ${money(plan.price_minor, plan.currency)} / ${intervalText(t, plan.interval, plan.interval_count)}`,
    }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (planId) change.mutate(undefined);
  };
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t('commerce.sub.changePlan')}</DialogTitle>
            <DialogDescription>{t('commerce.sub.changePlanHint')}</DialogDescription>
          </DialogHeader>
          <FormField label={t('commerce.field.plan')}>
            {(id) => (
              <ChoiceSelect
                id={id}
                value={planId}
                onChange={setPlanId}
                choices={choices}
                placeholder={t('commerce.sub.choosePlan')}
                className="w-full"
              />
            )}
          </FormField>
          <FormField label={t('commerce.field.quantity')}>
            {(id) => (
              <Input
                id={id}
                type="number"
                min={1}
                value={quantity}
                onChange={(e) => setQuantity(Math.max(1, Math.trunc(Number(e.target.value)) || 1))}
              />
            )}
          </FormField>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!planId || change.isPending}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
