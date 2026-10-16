import { useQuery } from '@tanstack/react-query';
import { ArrowUpCircle, X } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../../i18n';
import { apiFetch, useMe } from '../../lib/api';

interface UpdateNotice {
  readonly current: string;
  readonly latest: string;
  readonly url: string;
}

const DISMISSED_KEY = 'amable.update.dismissed';

function readDismissed(): string | null {
  try {
    return window.localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

/** Self-hosted installations: tells workspace owners that a newer public release exists. */
export function UpdateBanner() {
  const { t } = useI18n();
  const me = useMe();
  const isOwner = me.data?.memberships.some((m) => m.role === 'owner') ?? false;
  const notice = useQuery({
    queryKey: ['me', 'update'],
    queryFn: async () => (await apiFetch<{ update: UpdateNotice | null }>('/api/me/update')).update,
    enabled: isOwner,
    staleTime: 60 * 60_000,
    retry: false,
  });
  const [dismissed, setDismissed] = useState(readDismissed);
  const update = notice.data;
  if (!update || dismissed === update.latest) return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISSED_KEY, update.latest);
    } catch {
      // Private mode: hidden for this page view only.
    }
    setDismissed(update.latest);
  };

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 border-b border-sky-500/30 bg-sky-500/10 px-4 py-1.5 text-xs text-sky-900 dark:text-sky-100"
    >
      <ArrowUpCircle className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        {t('shell.update.available', { latest: update.latest, current: update.current })}
      </span>
      <a
        href={update.url}
        target="_blank"
        rel="noreferrer"
        className="font-medium underline underline-offset-2"
      >
        {t('shell.update.notes')}
      </a>
      <button
        type="button"
        onClick={dismiss}
        aria-label={t('shell.update.dismiss')}
        title={t('shell.update.dismiss')}
        className="rounded p-0.5 hover:bg-sky-500/20"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}
