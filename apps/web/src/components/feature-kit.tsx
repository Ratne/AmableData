import { cn, PageBody } from '@amable/ui';
import { Alert, AlertDescription, AlertTitle } from '@amable/ui/ui/alert';
import { Badge } from '@amable/ui/ui/badge';
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
import { useI18n } from '../i18n';
import { TenantApiError } from '../lib/tenant-api';

/** Building blocks shared by the feature pages (status pills, error / loading states, form rows). */

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'bg-muted text-muted-foreground',
  success: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  warning: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  danger: 'bg-red-500/15 text-red-700 dark:text-red-300',
  info: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
};

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <Badge variant="outline" className={cn('border-transparent', TONE_CLASS[tone])}>
      {children}
    </Badge>
  );
}

/** Failed call of a feature page: a neutral notice for 403, a destructive one otherwise. */
export function ApiErrorNotice({
  error,
  message,
  forbiddenTitle,
}: {
  error: unknown;
  message: string;
  forbiddenTitle: string;
}) {
  const { t } = useI18n();
  const forbidden = error instanceof TenantApiError && error.status === 403;
  return (
    <Alert variant={forbidden ? 'default' : 'destructive'} role="alert">
      {forbidden ? <ShieldAlert aria-hidden /> : <TriangleAlert aria-hidden />}
      <AlertTitle>{forbidden ? forbiddenTitle : t('common.error')}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

/** Error notice, skeleton while pending, else the page (rendered lazily once the data is there). */
export function QueryPageState({
  isPending,
  error,
  notice,
  skeletons = 1,
  children,
}: {
  isPending: boolean;
  error: unknown;
  notice: (error: unknown) => ReactNode;
  skeletons?: number;
  children: () => ReactNode;
}) {
  if (error) return <PageBody className="pt-4">{notice(error)}</PageBody>;
  if (isPending) {
    return (
      <PageBody className="grid gap-3 pt-4">
        <Skeleton className="h-8 w-64" />
        {Array.from({ length: skeletons }, (_, index) => (
          <Skeleton key={index} className="h-40 w-full" />
        ))}
      </PageBody>
    );
  }
  return <>{children()}</>;
}

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

/** Radix Select forbids empty item values: this stands for "no value". */
const NONE = '__none__';

/** Select over string options; `noneLabel` adds an empty choice (`null`). */
export function Choice({
  id,
  value,
  options,
  onChange,
  noneLabel,
  disabled,
  className,
}: {
  id?: string;
  value: string | null;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string | null) => void;
  noneLabel?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Select
      value={value ?? NONE}
      onValueChange={(next) => onChange(next === NONE ? null : next)}
      disabled={disabled}
    >
      <SelectTrigger id={id} className={cn('w-full', className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {noneLabel !== undefined ? <SelectItem value={NONE}>{noneLabel}</SelectItem> : null}
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export interface ChoiceOption {
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
  choices: readonly ChoiceOption[];
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
