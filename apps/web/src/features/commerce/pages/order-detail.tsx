import type { Order, Payment, Refund } from '@amable/api-types';
import {
  DashboardButton,
  DashboardConfirmDialog,
  PageBody,
  PageToolbar,
  usePageChrome,
} from '@amable/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  Ban,
  CheckCircle2,
  CircleDollarSign,
  FileText,
  Plus,
  Repeat,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useI18n } from '../../../i18n';
import {
  commerceKeys,
  useCommerce,
  useCommerceMutation,
  useContactNames,
  useDates,
  useMoney,
  usePermissions,
} from '../api/hooks';
import { OrderStatusPill, PageState, Pill, SectionCard } from '../components/common';
import {
  canRecordPayment,
  RecordPaymentDialog,
  RefundDialog,
  refundableMinor,
} from '../components/payment-dialogs';
import { TotalsTable } from '../components/totals-table';
import { orderDetailRoute } from '../routes';

interface TimelineEntry {
  readonly at: string;
  readonly icon: ReactNode;
  readonly label: string;
  readonly detail?: string;
}

/** Status history derived from the order timestamps, payments and refunds. */
export function buildTimeline(
  order: Order,
  payments: readonly Payment[],
  refunds: readonly Refund[],
  labels: {
    created: string;
    finalized: string;
    paid: string;
    cancelled: string;
    payment: (amount: string) => string;
    failedPayment: (amount: string) => string;
    refund: (amount: string) => string;
  },
  money: (minor: number, currency: string) => string,
): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    { at: order.created_at, icon: <Plus aria-hidden />, label: labels.created },
  ];
  if (order.finalized_at)
    entries.push({
      at: order.finalized_at,
      icon: <FileText aria-hidden />,
      label: labels.finalized,
    });
  for (const payment of payments) {
    const amount = money(payment.amount_minor, payment.currency);
    entries.push({
      at: payment.paid_at,
      icon: <CircleDollarSign aria-hidden />,
      label: payment.status === 'succeeded' ? labels.payment(amount) : labels.failedPayment(amount),
      detail: payment.failure_reason ?? payment.transaction_id ?? undefined,
    });
  }
  for (const refund of refunds) {
    entries.push({
      at: refund.refunded_at,
      icon: <RotateCcw aria-hidden />,
      label: labels.refund(money(refund.amount_minor, refund.currency)),
      detail: refund.reason ?? undefined,
    });
  }
  if (order.paid_at)
    entries.push({ at: order.paid_at, icon: <CheckCircle2 aria-hidden />, label: labels.paid });
  if (order.cancelled_at)
    entries.push({ at: order.cancelled_at, icon: <Ban aria-hidden />, label: labels.cancelled });
  return entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export function OrderDetailPage() {
  const { orderId } = useParams({ from: orderDetailRoute.id });
  const { t } = useI18n();
  const { slug, api } = useCommerce();
  const { can } = usePermissions();
  const navigate = useNavigate();
  const money = useMoney();
  const { date, dateTime } = useDates();

  const order = useQuery({
    queryKey: commerceKeys.order(slug, orderId),
    queryFn: () => api.orders.get(orderId),
  });
  const payments = useQuery({
    queryKey: [...commerceKeys.order(slug, orderId), 'payments'],
    queryFn: async () => (await api.orders.payments(orderId)).data,
  });
  const refunds = useQuery({
    queryKey: [...commerceKeys.order(slug, orderId), 'refunds'],
    queryFn: async () => (await api.orders.refunds(orderId)).data,
  });
  const contacts = useContactNames(order.data ? [order.data.contact_id] : []);

  const [paying, setPaying] = useState(false);
  const [refunding, setRefunding] = useState(false);
  const [confirm, setConfirm] = useState<'cancel' | 'delete' | null>(null);

  const finalize = useCommerceMutation({
    mutationFn: () => api.orders.finalize(orderId),
    success: t('commerce.order.finalized'),
  });
  const cancel = useCommerceMutation({
    mutationFn: () => api.orders.cancel(orderId),
    success: t('commerce.order.cancelled'),
  });
  const remove = useCommerceMutation({
    mutationFn: () => api.orders.remove(orderId),
    success: t('commerce.order.deleted'),
    onSuccess: () => void navigate({ to: '/t/$tenant/orders', params: { tenant: slug } }),
  });

  usePageChrome({
    title: order.data ? t('commerce.order.title', { number: order.data.number }) : t('nav.orders'),
    ...(order.data
      ? {
          status: t(`commerce.orderStatus.${order.data.status}`),
          statusTone:
            order.data.status === 'paid'
              ? 'success'
              : order.data.status === 'unpaid' || order.data.status === 'partially_paid'
                ? 'warning'
                : 'neutral',
        }
      : {}),
  });

  return (
    <PageState isPending={order.isPending} error={order.error}>
      {() => {
        const o = order.data;
        if (!o) return null;
        const paymentRows = payments.data ?? [];
        const refundRows = refunds.data ?? [];
        const retainsMoney = refundableMinor(o) > 0;
        const canCancel = o.status !== 'draft' && o.status !== 'cancelled' && !retainsMoney;
        const timeline = buildTimeline(
          o,
          paymentRows,
          refundRows,
          {
            created: t('commerce.timeline.created'),
            finalized: t('commerce.timeline.finalized'),
            paid: t('commerce.timeline.paid'),
            cancelled: t('commerce.timeline.cancelled'),
            payment: (amount) => t('commerce.timeline.payment', { amount }),
            failedPayment: (amount) => t('commerce.timeline.failedPayment', { amount }),
            refund: (amount) => t('commerce.timeline.refund', { amount }),
          },
          money,
        );
        return (
          <>
            <PageToolbar
              filters={
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <OrderStatusPill status={o.status} />
                  <span>{t(`commerce.source.${o.source}`)}</span>
                  <span>·</span>
                  <span>{date(o.order_date)}</span>
                </div>
              }
              actions={
                <>
                  {o.invoice ? (
                    <DashboardButton
                      variant="ghost"
                      onClick={() =>
                        void navigate({
                          to: '/t/$tenant/invoices/$invoiceId',
                          params: { tenant: slug, invoiceId: o.invoice?.id ?? '' },
                        })
                      }
                    >
                      <FileText aria-hidden />{' '}
                      {t('commerce.order.invoice', { number: o.invoice.number })}
                    </DashboardButton>
                  ) : null}
                  {o.status === 'draft' && can('orders:write') ? (
                    <>
                      <DashboardButton variant="ghost" onClick={() => setConfirm('delete')}>
                        <Trash2 aria-hidden /> {t('commerce.order.deleteDraft')}
                      </DashboardButton>
                      <DashboardButton
                        variant="primary"
                        disabled={finalize.isPending}
                        onClick={() => finalize.mutate(undefined)}
                      >
                        <CheckCircle2 aria-hidden /> {t('commerce.order.finalize')}
                      </DashboardButton>
                    </>
                  ) : null}
                  {canCancel && can('orders:write') ? (
                    <DashboardButton variant="ghost" onClick={() => setConfirm('cancel')}>
                      <Ban aria-hidden /> {t('commerce.order.cancel')}
                    </DashboardButton>
                  ) : null}
                  {retainsMoney && can('orders:refund') ? (
                    <DashboardButton variant="secondary" onClick={() => setRefunding(true)}>
                      <RotateCcw aria-hidden /> {t('commerce.refund.title')}
                    </DashboardButton>
                  ) : null}
                  {canRecordPayment(o) && can('orders:write') ? (
                    <DashboardButton variant="primary" onClick={() => setPaying(true)}>
                      <CircleDollarSign aria-hidden /> {t('commerce.payment.record')}
                    </DashboardButton>
                  ) : null}
                </>
              }
            />
            <PageBody className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
              <div className="grid min-w-0 content-start gap-4">
                <SectionCard title={t('commerce.order.items')}>
                  <TotalsTable order={o} />
                </SectionCard>

                <SectionCard title={t('commerce.order.payments')}>
                  {paymentRows.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {t('commerce.order.noPayments')}
                    </p>
                  ) : (
                    <ul className="divide-y text-sm">
                      {paymentRows.map((p) => (
                        <li key={p.id} className="flex flex-wrap items-center gap-3 py-2">
                          <span className="shrink-0 whitespace-nowrap text-muted-foreground">
                            {dateTime(p.paid_at)}
                          </span>
                          <span>{t(`commerce.method.${p.method}`)}</span>
                          {p.status === 'failed' ? (
                            <Pill tone="danger">{t('commerce.payment.failed')}</Pill>
                          ) : null}
                          {p.refunded_minor > 0 ? (
                            <Pill tone="warning">
                              {t('commerce.payment.refundedPart', {
                                amount: money(p.refunded_minor, p.currency),
                              })}
                            </Pill>
                          ) : null}
                          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                            {p.transaction_id ?? p.notes ?? ''}
                          </span>
                          <span className="font-medium tabular-nums">
                            {money(p.amount_minor, p.currency)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </SectionCard>

                {refundRows.length > 0 ? (
                  <SectionCard title={t('commerce.order.refunds')}>
                    <ul className="divide-y text-sm">
                      {refundRows.map((r) => (
                        <li key={r.id} className="flex flex-wrap items-center gap-3 py-2">
                          <span className="shrink-0 whitespace-nowrap text-muted-foreground">
                            {dateTime(r.refunded_at)}
                          </span>
                          <span className="min-w-0 flex-1 truncate">{r.reason ?? ''}</span>
                          <span className="font-medium tabular-nums text-red-600 dark:text-red-400">
                            −{money(r.amount_minor, r.currency)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </SectionCard>
                ) : null}

                {o.notes ? (
                  <SectionCard title={t('commerce.field.notes')}>
                    <p className="text-sm whitespace-pre-wrap">{o.notes}</p>
                  </SectionCard>
                ) : null}
              </div>

              <div className="grid content-start gap-4">
                <SectionCard title={t('commerce.order.summary')}>
                  <dl className="grid grid-cols-2 gap-y-1.5 text-sm">
                    <dt className="text-muted-foreground">{t('commerce.field.contact')}</dt>
                    <dd className="truncate text-right">
                      <Link
                        to="/t/$tenant/contacts/$contactId"
                        params={{ tenant: slug, contactId: o.contact_id }}
                        className="font-medium hover:underline"
                      >
                        {contacts.nameOf(o.contact_id)}
                      </Link>
                    </dd>
                    <dt className="text-muted-foreground">{t('commerce.field.total')}</dt>
                    <dd className="text-right font-medium tabular-nums">
                      {money(o.total_minor, o.currency)}
                    </dd>
                    <dt className="text-muted-foreground">{t('commerce.field.paid')}</dt>
                    <dd className="text-right tabular-nums">{money(o.paid_minor, o.currency)}</dd>
                    {o.refunded_minor > 0 ? (
                      <>
                        <dt className="text-muted-foreground">{t('commerce.field.refunded')}</dt>
                        <dd className="text-right tabular-nums">
                          {money(o.refunded_minor, o.currency)}
                        </dd>
                      </>
                    ) : null}
                    <dt className="text-muted-foreground">{t('commerce.field.balance')}</dt>
                    <dd className="text-right font-medium tabular-nums">
                      {money(o.balance_minor, o.currency)}
                    </dd>
                    <dt className="text-muted-foreground">{t('commerce.field.dueAt')}</dt>
                    <dd className="text-right">{date(o.due_at)}</dd>
                    {o.subscription_id ? (
                      <>
                        <dt className="text-muted-foreground">
                          {t('commerce.field.subscription')}
                        </dt>
                        <dd className="text-right">
                          <Link
                            to="/t/$tenant/subscriptions/$subscriptionId"
                            params={{ tenant: slug, subscriptionId: o.subscription_id }}
                            className="inline-flex items-center gap-1 hover:underline"
                          >
                            <Repeat className="size-3.5" aria-hidden />
                            {date(o.billing_period_start)} – {date(o.billing_period_end)}
                          </Link>
                        </dd>
                      </>
                    ) : null}
                  </dl>
                </SectionCard>

                <SectionCard title={t('commerce.order.timeline')}>
                  <ol className="relative grid gap-3 border-l pl-4">
                    {timeline.map((entry, index) => (
                      <li key={index} className="relative text-sm">
                        <span className="absolute top-0.5 -left-[1.4rem] flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground [&_svg]:size-3">
                          {entry.icon}
                        </span>
                        <p className="font-medium">{entry.label}</p>
                        <p className="text-xs text-muted-foreground">
                          {dateTime(entry.at)}
                          {entry.detail ? ` · ${entry.detail}` : ''}
                        </p>
                      </li>
                    ))}
                  </ol>
                </SectionCard>
              </div>
            </PageBody>

            {paying ? <RecordPaymentDialog order={o} open onOpenChange={setPaying} /> : null}
            {refunding ? (
              <RefundDialog order={o} payments={paymentRows} open onOpenChange={setRefunding} />
            ) : null}
            <DashboardConfirmDialog
              open={confirm !== null}
              onOpenChange={(open) => (open ? undefined : setConfirm(null))}
              title={
                confirm === 'delete'
                  ? t('commerce.order.deleteDraftConfirm')
                  : t('commerce.order.cancelConfirm', { number: o.number })
              }
              description={
                confirm === 'delete'
                  ? t('commerce.order.deleteDraftBody')
                  : t('commerce.order.cancelBody')
              }
              confirmLabel={
                confirm === 'delete' ? t('commerce.order.deleteDraft') : t('commerce.order.cancel')
              }
              cancelLabel={t('common.cancel')}
              tone="danger"
              onConfirm={() => {
                if (confirm === 'delete') remove.mutate(undefined);
                else cancel.mutate(undefined);
                setConfirm(null);
              }}
            />
          </>
        );
      }}
    </PageState>
  );
}
