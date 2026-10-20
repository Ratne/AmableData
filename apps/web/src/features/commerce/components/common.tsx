import type { BillingInterval, OrderStatus, SubscriptionStatus } from '@amable/api-types';
import { cn } from '@amable/ui';
import { Input } from '@amable/ui/ui/input';
import { Select } from '@amable/ui/ui/select';
import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '../../../i18n';
import { errorMessage } from '../api/hooks';
import {
  bpsToInput,
  currencyExponent,
  minorToInput,
  parseBpsInput,
  parseMoneyInput,
} from '../lib/money';
import { ApiErrorNotice, Pill, type Tone, QueryPageState } from '../../../components/feature-kit';

export {
  ChoiceSelect,
  Facts,
  FormField,
  ListFooter,
  Pill,
  SearchInput,
  SectionCard,
  useDebounced,
  type ChoiceOption as Choice,
  type Tone,
} from '../../../components/feature-kit';

export function ErrorNotice({ error }: { error: unknown }) {
  const { t } = useI18n();
  return (
    <ApiErrorNotice
      error={error}
      message={errorMessage(t, error)}
      forbiddenTitle={t('commerce.error.forbiddenTitle')}
    />
  );
}

export function PageState(props: {
  isPending: boolean;
  error: unknown;
  children: () => ReactNode;
}) {
  return (
    <QueryPageState {...props} skeletons={2} notice={(error) => <ErrorNotice error={error} />} />
  );
}

type Translate = ReturnType<typeof useI18n>['t'];

/** "month" / "3 months" for a billing period. */
export function intervalText(t: Translate, interval: BillingInterval, count: number): string {
  return count === 1
    ? t(`commerce.interval.${interval}`)
    : t(`commerce.intervals.${interval}`, { count });
}

export const ORDER_STATUS_TONE: Record<OrderStatus, Tone> = {
  draft: 'neutral',
  unpaid: 'warning',
  partially_paid: 'info',
  paid: 'success',
  refunded: 'danger',
  cancelled: 'neutral',
};

export const SUBSCRIPTION_STATUS_TONE: Record<SubscriptionStatus, Tone> = {
  trialing: 'info',
  active: 'success',
  past_due: 'danger',
  paused: 'warning',
  cancelled: 'neutral',
};

export const INVOICE_STATUS_TONE: Record<'open' | 'paid' | 'void', Tone> = {
  open: 'warning',
  paid: 'success',
  void: 'neutral',
};

export function OrderStatusPill({ status }: { status: OrderStatus }) {
  const { t } = useI18n();
  return <Pill tone={ORDER_STATUS_TONE[status]}>{t(`commerce.orderStatus.${status}`)}</Pill>;
}

export function SubscriptionStatusPill({ status }: { status: SubscriptionStatus }) {
  const { t } = useI18n();
  return <Pill tone={SUBSCRIPTION_STATUS_TONE[status]}>{t(`commerce.subStatus.${status}`)}</Pill>;
}

export function InvoiceStatusPill({ status }: { status: 'open' | 'paid' | 'void' }) {
  const { t } = useI18n();
  return <Pill tone={INVOICE_STATUS_TONE[status]}>{t(`commerce.invoiceStatus.${status}`)}</Pill>;
}

/**
 * Amount input in the currency's major unit, emitting integer minor units
 * (`null` while empty/invalid). Text is kept while typing; external value
 * changes re-sync it.
 */
export function MoneyInput({
  id,
  value,
  onChange,
  currency,
  placeholder,
  disabled,
  invalid,
  className,
  ariaLabel,
}: {
  id?: string;
  value: number | null;
  onChange: (minor: number | null) => void;
  currency: string;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  const { locale } = useI18n();
  const [text, setText] = useState(() =>
    value === null ? '' : minorToInput(value, currency, locale),
  );
  useEffect(() => {
    setText((current) => {
      const parsed = parseMoneyInput(current, currency, locale);
      if (parsed === value) return current;
      return value === null ? '' : minorToInput(value, currency, locale);
    });
  }, [value, currency, locale]);
  const parsed = parseMoneyInput(text, currency, locale);
  const bad = invalid === true || (text.trim() !== '' && parsed === null);
  return (
    <div className={cn('relative', className)}>
      <Input
        id={id}
        inputMode={currencyExponent(currency) > 0 ? 'decimal' : 'numeric'}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={bad}
        aria-label={ariaLabel}
        className="pr-12 tabular-nums"
        onChange={(event) => {
          setText(event.target.value);
          onChange(parseMoneyInput(event.target.value, currency, locale));
        }}
      />
      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
        {currency}
      </span>
    </div>
  );
}

/** Percentage input emitting basis points (`22` → 2200). */
export function PercentInput({
  id,
  value,
  onChange,
  placeholder,
  disabled,
  className,
  ariaLabel,
}: {
  id?: string;
  value: number | null;
  onChange: (bps: number | null) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  const { locale } = useI18n();
  const [text, setText] = useState(() => (value === null ? '' : bpsToInput(value, locale)));
  useEffect(() => {
    setText((current) => {
      if (parseBpsInput(current, locale) === value) return current;
      return value === null ? '' : bpsToInput(value, locale);
    });
  }, [value, locale]);
  const bad = text.trim() !== '' && parseBpsInput(text, locale) === null;
  return (
    <div className={cn('relative', className)}>
      <Input
        id={id}
        inputMode="decimal"
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={bad}
        aria-label={ariaLabel}
        className="pr-8 tabular-nums"
        onChange={(event) => {
          setText(event.target.value);
          onChange(parseBpsInput(event.target.value, locale));
        }}
      />
      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
        %
      </span>
    </div>
  );
}

/** Radix Select forbids empty item values: this stands for "no value". */
