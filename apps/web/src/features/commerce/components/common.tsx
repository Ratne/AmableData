import type { BillingInterval, OrderStatus, SubscriptionStatus } from '@amable/api-types';
import { cn, PageBody } from '@amable/ui';
import { Alert, AlertDescription, AlertTitle } from '@amable/ui/ui/alert';
import { Input } from '@amable/ui/ui/input';
import { Label } from '@amable/ui/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@amable/ui/ui/select';
import { Skeleton } from '@amable/ui/ui/skeleton';
import { ShieldAlert, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useI18n } from '../../../i18n';
import { CommerceApiError } from '../api/client';
import { errorMessage } from '../api/hooks';
import {
  bpsToInput,
  currencyExponent,
  minorToInput,
  parseBpsInput,
  parseMoneyInput,
} from '../lib/money';

type Translate = ReturnType<typeof useI18n>['t'];

/** "month" / "3 months" for a billing period. */
export function intervalText(t: Translate, interval: BillingInterval, count: number): string {
  return count === 1
    ? t(`commerce.interval.${interval}`)
    : t(`commerce.intervals.${interval}`, { count });
}

export function ErrorNotice({ error }: { error: unknown }) {
  const { t } = useI18n();
  const forbidden = error instanceof CommerceApiError && error.status === 403;
  return (
    <Alert variant={forbidden ? 'default' : 'destructive'} role="alert">
      {forbidden ? <ShieldAlert aria-hidden /> : <TriangleAlert aria-hidden />}
      <AlertTitle>{forbidden ? t('commerce.error.forbiddenTitle') : t('common.error')}</AlertTitle>
      <AlertDescription>{errorMessage(t, error)}</AlertDescription>
    </Alert>
  );
}

/** Loading skeleton / error for a whole page body. */
export function PageState({
  isPending,
  error,
  children,
}: {
  isPending: boolean;
  error: unknown;
  children: () => ReactNode;
}) {
  if (error) {
    return (
      <PageBody className="pt-4">
        <ErrorNotice error={error} />
      </PageBody>
    );
  }
  if (isPending) {
    return (
      <PageBody className="grid gap-3 pt-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </PageBody>
    );
  }
  return <>{children()}</>;
}

export function SectionCard({
  title,
  actions,
  children,
  className,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('rounded-xl border bg-card p-4', className)}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        {actions ? <div className="flex items-center gap-1.5">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'bg-muted text-muted-foreground',
  success: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  warning: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  danger: 'bg-red-500/15 text-red-700 dark:text-red-300',
  info: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
};

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex w-fit items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        TONE_CLASS[tone],
      )}
    >
      {children}
    </span>
  );
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

/** Labelled form row. */
export function FormField({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: (id: string) => ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn('grid content-start gap-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      {children(id)}
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
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
export const NONE = '__none__';

export interface Choice {
  readonly value: string;
  readonly label: string;
}

export function ChoiceSelect({
  id,
  value,
  onChange,
  choices,
  placeholder,
  emptyLabel,
  disabled,
  className,
  ariaLabel,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  choices: readonly Choice[];
  placeholder?: string;
  /** When set, an extra first option maps to `''`. */
  emptyLabel?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <Select
      value={value === '' ? NONE : value}
      onValueChange={(next) => onChange(next === NONE ? '' : next)}
      disabled={disabled}
    >
      <SelectTrigger id={id} size="sm" className={cn('min-w-36', className)} aria-label={ariaLabel}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {emptyLabel !== undefined ? <SelectItem value={NONE}>{emptyLabel}</SelectItem> : null}
        {choices.map((choice) => (
          <SelectItem key={choice.value} value={choice.value}>
            {choice.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Two-column key/value list used by detail pages. */
export function Facts({ rows }: { rows: ReadonlyArray<readonly [ReactNode, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-2 text-sm">
      {rows.map(([label, value], index) => (
        <div key={index} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <Input
      type="search"
      value={value}
      placeholder={placeholder}
      aria-label={placeholder}
      className="h-8 w-56"
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/** Table footer: summary on the left, "load more" for cursor pages on the right. */
export function ListFooter({
  summary,
  hasMore,
  loading,
  onMore,
}: {
  summary?: ReactNode;
  hasMore: boolean;
  loading: boolean;
  onMore: () => void;
}) {
  const { t } = useI18n();
  if (!summary && !hasMore) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-1 py-3 text-sm text-muted-foreground">
      <div className="tabular-nums">{summary}</div>
      {hasMore ? (
        <button
          type="button"
          className="rounded-md px-3 py-1.5 font-medium text-foreground hover:bg-muted disabled:opacity-50"
          disabled={loading}
          onClick={onMore}
        >
          {loading ? t('common.loading') : t('commerce.common.loadMore')}
        </button>
      ) : null}
    </div>
  );
}

/** Debounced copy of a value (search boxes). */
export function useDebounced<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
