import type { PopupRef } from '@amable/builder';
import { Button } from '@amable/ui/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useI18n } from '../../../i18n';

/** Popups of the page: create, rename, delete, and open one to edit it in isolation. */
export function PopupsDialog({
  popups,
  disabled,
  onCreate,
  onEdit,
  onRename,
  onDelete,
  onClose,
}: {
  popups: PopupRef[];
  disabled?: boolean;
  onCreate: () => void;
  onEdit: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('landing.popups.title')}</DialogTitle>
          <DialogDescription>{t('landing.popups.description')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Button variant="outline" size="sm" disabled={disabled} onClick={onCreate}>
            <Plus aria-hidden /> {t('landing.popups.new')}
          </Button>
          {popups.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{t('landing.popups.empty')}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {popups.map((p) => (
                <li key={p.id} className="flex items-center gap-2 rounded-md border px-2 py-1.5">
                  <Input
                    aria-label={t('landing.popups.name')}
                    className="h-8 flex-1"
                    value={p.name}
                    disabled={disabled}
                    onChange={(e) => onRename(p.id, e.target.value)}
                  />
                  <Button size="sm" variant="outline" onClick={() => onEdit(p.id)}>
                    <Pencil aria-hidden /> {t('landing.popups.edit')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-destructive"
                    aria-label={t('landing.popups.delete')}
                    disabled={disabled}
                    onClick={() => onDelete(p.id)}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
