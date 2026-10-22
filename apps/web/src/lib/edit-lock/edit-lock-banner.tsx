import { Button } from '@amable/ui/ui/button';
import { Spinner } from '@amable/ui/ui/spinner';
import { Lock } from 'lucide-react';
import { useI18n } from '../../i18n';
import type { EditLock } from './use-edit-lock';

/** Who is editing, for everyone but the holder; the takeover button when allowed. */
export function EditLockBanner({ lock, canTakeover }: { lock: EditLock; canTakeover: boolean }) {
  const { t } = useI18n();
  const { status, waiting } = lock;
  const holderName = lock.holder?.user_name ?? null;
  if (status === 'holder' || status === 'disabled') return null;
  if (status === 'unavailable') {
    return <div className="border-b bg-muted px-4 py-1.5 text-xs text-muted-foreground">{t('common.lock.unavailable')}</div>;
  }
  if (status === 'connecting' || status === 'offline') {
    return (
      <div className="flex items-center gap-2 border-b bg-muted px-4 py-1.5 text-xs text-muted-foreground" role="status">
        <Spinner className="size-3" /> {status === 'connecting' ? t('common.lock.connecting') : t('common.lock.offline')}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm text-amber-800 dark:text-amber-200" role="alert">
      <Lock aria-hidden className="size-4" />
      <span className="font-medium">
        {holderName ? t('common.lock.heldBy', { name: holderName }) : t('common.lock.heldBySomeone')}
      </span>
      <span className="text-xs">{waiting > 1 ? t('common.lock.waitingMany', { count: waiting }) : t('common.lock.waiting')}</span>
      {canTakeover ? (
        <Button type="button" size="sm" variant="outline" className="ml-auto" onClick={lock.takeover}>
          {t('common.lock.takeover')}
        </Button>
      ) : null}
    </div>
  );
}
