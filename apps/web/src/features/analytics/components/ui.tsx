import { cn } from '@amable/ui';
import { Skeleton } from '@amable/ui/ui/skeleton';
import { ShieldAlert, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useI18n } from '../../../i18n';
import { ApiError } from '../../../lib/api';
import { analyticsErrorMessage, isForbidden } from '../api';
import { countryFlag } from '../lib/countries';

/** Card surface of the analytics block: soft fill + hairline inset ring. */
export const panelClass =
  'rounded-[14px] bg-foreground/[0.03] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--foreground)_6%,transparent)] dark:bg-foreground/[0.04]';

export function Panel({
  title,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn(panelClass, 'flex min-w-0 flex-col', className)}>
      {title || actions ? (
        <header className="flex min-h-11 flex-wrap items-center justify-between gap-2 px-4 pt-3">
          {title ? <h2 className="text-[13px] font-medium text-foreground">{title}</h2> : <span />}
          {actions ? <div className="flex flex-wrap items-center gap-1.5">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cn('min-w-0 flex-1 px-4 pb-4 pt-2', bodyClassName)}>{children}</div>
    </section>
  );
}

export interface SegmentOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

/** Compact pill tabs (the block's Segmented control). */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn(
        'inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-lg bg-foreground/[0.05] p-0.5',
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(option.value)}
            className={cn(
              'h-6 shrink-0 whitespace-nowrap rounded-md px-2 text-xs font-medium transition-colors',
              active
                ? 'bg-background text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.08),0_0_0_1px_color-mix(in_oklab,var(--foreground)_6%,transparent)] dark:bg-foreground/[0.1]'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function PulseDot({
  className,
  tone = 'success',
}: {
  className?: string;
  tone?: 'success' | 'primary';
}) {
  const color = tone === 'success' ? 'bg-success' : 'bg-primary';
  return (
    <span className={cn('relative inline-flex size-2', className)} aria-hidden>
      <span
        className={cn('absolute inline-flex size-full animate-ping rounded-full opacity-60', color)}
      />
      <span className={cn('relative inline-flex size-2 rounded-full', color)} />
    </span>
  );
}

export function Flag({ code, className }: { code: string | null | undefined; className?: string }) {
  return (
    <span
      className={cn('inline-block w-5 shrink-0 text-center text-[15px] leading-none', className)}
      aria-hidden
    >
      {countryFlag(code)}
    </span>
  );
}

export function Initials({
  text,
  hue,
  size = 28,
  className,
}: {
  text: string;
  hue: number;
  size?: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-medium text-white',
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(9, size * 0.38),
        background: `linear-gradient(135deg, hsl(${hue} 70% 58%), hsl(${(hue + 30) % 360} 65% 44%))`,
      }}
    >
      {text}
    </span>
  );
}

export function ErrorState({ error, compact }: { error: unknown; compact?: boolean }) {
  const { t } = useI18n();
  const forbidden = isForbidden(error);
  const Icon = forbidden ? ShieldAlert : TriangleAlert;
  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-2.5 rounded-lg text-sm',
        compact ? 'p-2 text-xs' : 'p-4',
        forbidden ? 'text-muted-foreground' : 'text-destructive',
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>
        {analyticsErrorMessage(t, error)}
        {error instanceof ApiError && error.status === 401 ? (
          <>
            {' '}
            <a href="/login" className="font-medium underline underline-offset-2">
              {t('auth.login.submit')}
            </a>
          </>
        ) : null}
      </span>
    </div>
  );
}

export function EmptyNote({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'flex min-h-24 items-center justify-center px-4 py-6 text-center text-xs text-muted-foreground',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-1.5" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-7 w-full" style={{ opacity: 1 - i * 0.12 }} />
      ))}
    </div>
  );
}

/** Label + value pair for profile and settings cards. */
export function Fact({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-sm text-foreground">{children}</dd>
    </div>
  );
}

export function StatusPill({
  tone,
  children,
}: {
  tone: 'success' | 'warning' | 'neutral' | 'danger';
  children: ReactNode;
}) {
  const tones = {
    success: 'bg-success/12 text-success',
    warning: 'bg-warning/15 text-warning',
    neutral: 'bg-foreground/[0.06] text-muted-foreground',
    danger: 'bg-destructive/12 text-destructive',
  } as const;
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-full px-2 text-[11px] font-medium',
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}
