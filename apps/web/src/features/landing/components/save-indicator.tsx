import { Spinner } from '@amable/ui/ui/spinner';
import { Check, CloudOff } from 'lucide-react';
import { useI18n } from '../../../i18n';
import type { SaveState } from '../hooks/use-builder-document';

/** Draft save status of the page editors (canvas and HTML source). */
export function SaveIndicator({ state, dirty, editable }: { state: SaveState; dirty: boolean; editable: boolean }) {
  const { t } = useI18n();
  if (!editable) return null;
  if (state === 'saving') {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground" role="status">
        <Spinner className="size-3" /> {t('landing.editor.saving')}
      </span>
    );
  }
  if (state === 'error') {
    return (
      <span className="flex items-center gap-1 text-xs text-destructive" role="status">
        <CloudOff aria-hidden className="size-3.5" /> {t('landing.editor.saveFailed')}
      </span>
    );
  }
  if (dirty) return <span className="text-xs text-muted-foreground" role="status">{t('landing.editor.unsaved')}</span>;
  return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground" role="status">
      <Check aria-hidden className="size-3.5" /> {t('landing.editor.allSaved')}
    </span>
  );
}
