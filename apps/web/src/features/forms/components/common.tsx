import { cn, PageBody } from '@amable/ui';
import { Alert, AlertDescription, AlertTitle } from '@amable/ui/ui/alert';
import { Label } from '@amable/ui/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@amable/ui/ui/select';
import { Skeleton } from '@amable/ui/ui/skeleton';
import { ShieldAlert, TriangleAlert } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { useI18n } from '../../../i18n';
import { FormsApiError } from '../api/client';
import { errorMessage } from '../api/hooks';

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

export function ErrorNotice({ error }: { error: unknown }) {
  const { t } = useI18n();
  const forbidden = error instanceof FormsApiError && error.status === 403;
  return (
    <Alert variant={forbidden ? 'default' : 'destructive'} role="alert">
      {forbidden ? <ShieldAlert aria-hidden /> : <TriangleAlert aria-hidden />}
      <AlertTitle>{forbidden ? t('forms.error.forbiddenTitle') : t('common.error')}</AlertTitle>
      <AlertDescription>{errorMessage(t, error)}</AlertDescription>
    </Alert>
  );
}

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

export function SectionCard({ title, actions, children }: { title: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        {actions ? <div className="flex items-center gap-1.5">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

const NONE = '__none__';

/** Select over string options; `noneLabel` adds an empty choice (`null`). */
export function Choice({
  id,
  value,
  options,
  onChange,
  noneLabel,
  disabled,
}: {
  id?: string;
  value: string | null;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string | null) => void;
  noneLabel?: string;
  disabled?: boolean;
}) {
  return (
    <Select
      value={value ?? NONE}
      onValueChange={(next) => onChange(next === NONE ? null : next)}
      disabled={disabled}
    >
      <SelectTrigger id={id} className="w-full">
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
