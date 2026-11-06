import { Alert, AlertDescription, AlertTitle } from '@amable/ui/ui/alert';
import { Link } from '@tanstack/react-router';
import { MailWarning } from 'lucide-react';
import { useCallback, type ReactNode } from 'react';
import { useI18n } from '../../i18n';
import { isStepUpRequired } from '../../lib/step-up';
import { useSendingStatus } from './api';
import { CopyButton } from '../../components/feature-kit';

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
          <CopyButton text={value} />
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
  const dnsUpdate = status.data?.dns_update_needed ?? [];
  if (status.data !== undefined && status.data.state === 'verified' && dnsUpdate.length > 0) {
    return (
      <Alert variant="destructive" data-testid="sending-dns-update-banner">
        <MailWarning className="size-4" />
        <AlertTitle>{t('dev.domains.dnsChanged.bannerTitle')}</AlertTitle>
        {compact ? null : (
          <AlertDescription>
            <p>{t('dev.domains.dnsChanged.bannerBody', { count: String(dnsUpdate.length) })}</p>
            <p className="font-mono text-xs">{dnsUpdate.join(', ')}</p>
            <Link to="/t/$tenant/settings/domains" params={{ tenant: slug }} className="font-medium underline underline-offset-2">
              {t('dev.sending.updateDns')}
            </Link>
          </AlertDescription>
        )}
      </Alert>
    );
  }
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
