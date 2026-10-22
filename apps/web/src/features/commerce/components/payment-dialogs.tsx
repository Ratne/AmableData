import { PAYMENT_METHODS, type Order, type Payment } from '@amable/api-types';
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
import { Switch } from '@amable/ui/ui/switch';
import { Textarea } from '@amable/ui/ui/textarea';
import { useState, type FormEvent } from 'react';
import { useI18n } from '../../../i18n';
import { useCommerce, useCommerceMutation, useDates, useMoney } from '../api/hooks';
import { ChoiceSelect, FormField, MoneyInput } from './common';

type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Settled by a Stripe PaymentIntent of the workspace account (checkouts, offers, renewals). */
export function isStripePayment(payment: Pick<Payment, 'status' | 'transaction_id'>): boolean {
  return payment.status === 'succeeded' && (payment.transaction_id?.startsWith('pi_') ?? false);
}

/** Amount still refundable on an order (gross paid minus refunds). */
export function refundableMinor(order: Pick<Order, 'paid_minor' | 'refunded_minor'>): number {
  return Math.max(0, order.paid_minor - order.refunded_minor);
}

export function canRecordPayment(order: Pick<Order, 'status' | 'balance_minor'>): boolean {
  return (
    (order.status === 'unpaid' || order.status === 'partially_paid') && order.balance_minor > 0
  );
}

/** `POST /orders/{id}/payments` — defaults to the open balance. */
export function RecordPaymentDialog({
  order,
  open,
  onOpenChange,
}: {
  order: Order;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const { api } = useCommerce();
  const money = useMoney();
  const [amount, setAmount] = useState<number | null>(order.balance_minor);
  const [method, setMethod] = useState<PaymentMethod>('bank_transfer');
  const [transactionId, setTransactionId] = useState('');
  const [paidAt, setPaidAt] = useState('');
  const [notes, setNotes] = useState('');

  const record = useCommerceMutation({
    mutationFn: () =>
      api.orders.recordPayment(order.id, {
        amount_minor: amount ?? 0,
        method,
        ...(transactionId.trim() ? { transaction_id: transactionId.trim() } : {}),
        ...(paidAt ? { paid_at: new Date(`${paidAt}T12:00:00`).toISOString() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      }),
    success: t('commerce.payment.recorded'),
    onSuccess: () => onOpenChange(false),
  });

  const tooMuch = amount !== null && amount > order.balance_minor;
  const valid = amount !== null && amount > 0 && !tooMuch;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) record.mutate(undefined);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t('commerce.payment.recordTitle')}</DialogTitle>
            <DialogDescription>
              {t('commerce.payment.balance', {
                amount: money(order.balance_minor, order.currency),
              })}
            </DialogDescription>
          </DialogHeader>
          <FormField
            label={t('commerce.field.amount')}
            error={tooMuch ? t('commerce.payment.overBalance') : null}
          >
            {(id) => (
              <MoneyInput
                id={id}
                value={amount}
                onChange={setAmount}
                currency={order.currency}
                invalid={tooMuch}
              />
            )}
          </FormField>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label={t('commerce.field.method')}>
              {(id) => (
                <ChoiceSelect
                  id={id}
                  value={method}
                  onChange={(value) => setMethod(value as PaymentMethod)}
                  choices={PAYMENT_METHODS.map((m) => ({
                    value: m,
                    label: t(`commerce.method.${m}`),
                  }))}
                  className="w-full"
                />
              )}
            </FormField>
            <FormField label={t('commerce.field.paidAt')} hint={t('commerce.payment.paidAtHint')}>
              {(id) => (
                <Input
                  id={id}
                  type="date"
                  value={paidAt}
                  onChange={(e) => setPaidAt(e.target.value)}
                />
              )}
            </FormField>
          </div>
          <FormField label={t('commerce.field.transactionId')} hint={t('commerce.payment.txHint')}>
            {(id) => (
              <Input
                id={id}
                value={transactionId}
                onChange={(e) => setTransactionId(e.target.value)}
              />
            )}
          </FormField>
          <FormField label={t('commerce.field.notes')}>
            {(id) => (
              <Textarea id={id} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            )}
          </FormField>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!valid || record.isPending}>
              {t('commerce.payment.record')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** `POST /orders/{id}/refunds` — whole refundable amount by default, optionally one payment. */
export function RefundDialog({
  order,
  payments,
  open,
  onOpenChange,
}: {
  order: Order;
  payments: readonly Payment[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const { api } = useCommerce();
  const money = useMoney();
  const { date: dateLabel } = useDates();
  const refundable = refundableMinor(order);
  const eligible = payments.filter(
    (p) => p.status === 'succeeded' && p.amount_minor - p.refunded_minor > 0,
  );
  const onStripe = eligible.filter(isStripePayment);
  const stripeLimit = Math.min(
    refundable,
    onStripe.reduce((sum, p) => sum + p.amount_minor - p.refunded_minor, 0),
  );
  const [viaStripe, setViaStripe] = useState(onStripe.length > 0);
  const [paymentId, setPaymentId] = useState('');
  const [amount, setAmount] = useState<number | null>(viaStripe ? stripeLimit : refundable);
  const [reason, setReason] = useState('');
  const [transactionId, setTransactionId] = useState('');

  const choices = viaStripe ? onStripe : eligible;
  const selected = choices.find((p) => p.id === paymentId);
  const whole = viaStripe ? stripeLimit : refundable;
  const limit = selected ? selected.amount_minor - selected.refunded_minor : whole;

  const refund = useCommerceMutation({
    mutationFn: () =>
      api.orders.refund(order.id, {
        ...(amount !== null && (selected !== undefined || amount !== whole)
          ? { amount_minor: amount }
          : {}),
        ...(selected ? { payment_id: selected.id } : {}),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        ...(viaStripe
          ? { stripe: true }
          : transactionId.trim()
            ? { transaction_id: transactionId.trim() }
            : {}),
      }),
    success: viaStripe ? t('commerce.refund.stripeDone') : t('commerce.refund.recorded'),
    onSuccess: () => onOpenChange(false),
  });

  const tooMuch = amount !== null && amount > limit;
  const valid = amount !== null && amount > 0 && !tooMuch;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) refund.mutate(undefined);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t('commerce.refund.title')}</DialogTitle>
            <DialogDescription>
              {t('commerce.refund.refundable', { amount: money(refundable, order.currency) })}
            </DialogDescription>
          </DialogHeader>
          {onStripe.length > 0 ? (
            <label className="flex items-start gap-2 rounded-lg border p-3 text-sm">
              <Switch
                checked={viaStripe}
                onCheckedChange={(next) => {
                  setViaStripe(next);
                  setPaymentId('');
                  setAmount(next ? stripeLimit : refundable);
                }}
              />
              <span className="grid gap-0.5">
                <span className="font-medium">{t('commerce.refund.viaStripe')}</span>
                <span className="text-xs text-muted-foreground">
                  {viaStripe
                    ? t('commerce.refund.viaStripeHint', { amount: money(stripeLimit, order.currency) })
                    : t('commerce.refund.recordOnlyHint')}
                </span>
              </span>
            </label>
          ) : null}
          <FormField label={t('commerce.refund.payment')}>
            {(id) => (
              <ChoiceSelect
                id={id}
                value={paymentId}
                onChange={(value) => {
                  setPaymentId(value);
                  const payment = choices.find((p) => p.id === value);
                  setAmount(payment ? payment.amount_minor - payment.refunded_minor : whole);
                }}
                emptyLabel={t('commerce.refund.anyPayment')}
                choices={choices.map((p) => ({
                  value: p.id,
                  label: `${dateLabel(p.paid_at)} · ${t(`commerce.method.${p.method}`)} · ${money(
                    p.amount_minor - p.refunded_minor,
                    p.currency,
                  )}`,
                }))}
                className="w-full"
              />
            )}
          </FormField>
          <FormField
            label={t('commerce.field.amount')}
            error={
              tooMuch
                ? t('commerce.refund.overLimit', { amount: money(limit, order.currency) })
                : null
            }
          >
            {(id) => (
              <MoneyInput
                id={id}
                value={amount}
                onChange={setAmount}
                currency={order.currency}
                invalid={tooMuch}
              />
            )}
          </FormField>
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
          {viaStripe ? null : (
            <FormField label={t('commerce.field.transactionId')}>
              {(id) => (
                <Input
                  id={id}
                  value={transactionId}
                  onChange={(e) => setTransactionId(e.target.value)}
                />
              )}
            </FormField>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="destructive" disabled={!valid || refund.isPending}>
              {viaStripe ? t('commerce.refund.submitStripe') : t('commerce.refund.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
