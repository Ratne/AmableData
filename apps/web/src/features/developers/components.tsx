import { Alert, AlertDescription, AlertTitle } from '@amable/ui/ui/alert';
import { Button } from '@amable/ui/ui/button';
import { Link } from '@tanstack/react-router';
import { Check, Copy, MailWarning } from 'lucide-react';
import { useCallback, useState, type ReactNode } from 'react';
import { useI18n } from '../../i18n';
import { isStepUpRequired } from '../../lib/step-up';
import { useSendingStatus } from './api';

/**
 * The step-up dialog itself is app-wide (`StepUpProvider` + `stepUpFetch`):
 * the request is replayed after the second factor. A `step_up_required`
 * error that still reaches a mutation means the user closed the dialog, so
 * `guard` swallows it instead of showing a permission error.
 */
export function useStepUp() {
  const guard = useCallback((error: unknown, _retry: () => void): boolean => isStepUpRequired(error), []);
  return { guard, dialog: null };
}

export function CopyButton({ value, label }: { value: string; label?: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      {label ?? (copied ? t('dev.copied') : t('dev.copy'))}
    </Button>
  );
}

/** One-time secret display (API key, webhook signing secret). */
export function SecretReveal({ title, value, hint }: { title: string; value: string; hint: string }) {
  return (
    <Alert>
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="grid gap-2">
        <p>{hint}</p>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded bg-(--obsidian-dashboard-shell-panel-muted,#0000000d) px-2 py-1 font-mono text-xs" data-testid="secret-value">
            {value}
          </code>
          <CopyButton value={value} />
        </div>
      </AlertDescription>
    </Alert>
  );
}

export type Tone = 'success' | 'warning' | 'danger' | 'neutral';

const TONE_CLASS: Record<Tone, string> = {
  success: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  warning: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  danger: 'bg-red-500/15 text-red-700 dark:text-red-300',
  neutral: 'bg-zinc-500/15 text-zinc-700 dark:text-zinc-300',
};

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${TONE_CLASS[tone]}`}>{children}</span>;
}

/**
 * Warning shown on email surfaces (broadcasts, automation email steps, templates)
 * while the tenant has no verified sending domain: marketing email is blocked.
 */
export function SendingDomainBanner({ slug, compact = false }: { slug: string; compact?: boolean }) {
  const { t } = useI18n();
  const status = useSendingStatus(slug);
  if (status.data === undefined || status.data.state === 'verified') return null;
  const override = status.data.state === 'dev_override';
  return (
    <Alert variant={override ? 'default' : 'destructive'} data-testid="sending-domain-banner">
      <MailWarning className="size-4" />
      <AlertTitle>{override ? t('dev.sending.overrideTitle') : t('dev.sending.blockedTitle')}</AlertTitle>
      {compact ? null : (
        <AlertDescription>
          <p>{override ? t('dev.sending.overrideBody') : t('dev.sending.blockedBody')}</p>
          <Link
            to="/t/$tenant/settings/domains"
            params={{ tenant: slug }}
            className="font-medium underline underline-offset-2"
          >
            {t('dev.sending.connect')}
          </Link>
        </AlertDescription>
      )}
    </Alert>
  );
}

export function formatDateTime(locale: string, value: string | number | null): string {
  if (value === null) return '—';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}
