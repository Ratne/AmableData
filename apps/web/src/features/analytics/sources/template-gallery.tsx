import type { TrafficSourceTemplateDef } from '@amable/api-types';
import { DashboardButton } from '@amable/ui';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { Megaphone } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../../../i18n';
import { useTrafficSourceTemplates } from '../api-funnels';
import { EmptyNote, ErrorState, ListSkeleton } from '../components/ui';

/** Template picker opened by "New source": each card starts the editor prefilled. */
export function TemplateGalleryDialog({
  tenant,
  onPick,
  onClose,
}: {
  tenant: string;
  onPick: (template: TrafficSourceTemplateDef) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const templates = useTrafficSourceTemplates(tenant);
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const list = (templates.data ?? []).filter(
    (tpl) =>
      !needle ||
      tpl.name.toLowerCase().includes(needle) ||
      (tpl.source.category ?? '').toLowerCase().includes(needle),
  );
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('analytics.sources.gallery.title')}</DialogTitle>
          <DialogDescription>{t('analytics.sources.gallery.hint')}</DialogDescription>
        </DialogHeader>
        <Input
          className="h-8"
          placeholder={t('analytics.sources.gallery.search')}
          aria-label={t('analytics.sources.gallery.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {templates.error ? (
          <ErrorState error={templates.error} />
        ) : !templates.data ? (
          <ListSkeleton rows={3} />
        ) : list.length === 0 ? (
          <EmptyNote>{t('analytics.sources.gallery.empty')}</EmptyNote>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {list.map((tpl) => (
              <li key={tpl.template}>
                <button
                  type="button"
                  onClick={() => onPick(tpl)}
                  className="flex w-full items-start gap-3 rounded-lg border p-3 text-left hover:bg-muted"
                  data-testid={`source-template-${tpl.template}`}
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <Megaphone className="size-4" aria-hidden />
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium">{tpl.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {t('analytics.sources.gallery.meta', {
                        category: tpl.source.category ?? t('analytics.sources.gallery.noCategory'),
                        fields: (tpl.source.fields ?? []).length,
                      })}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <DashboardButton variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </DashboardButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
