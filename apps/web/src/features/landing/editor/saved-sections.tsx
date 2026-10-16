import { cloneNodeWithNewIds, getWidgetDef, type ElementNode } from '@amable/builder';
import { DashboardConfirmDialog } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { Spinner } from '@amable/ui/ui/spinner';
import { useQuery } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useI18n } from '../../../i18n';
import { landingKeys, useLanding, useLandingMutation, usePermissions } from '../api/hooks';
import type { SavedSection } from '../api/types';
import { ErrorNotice, FormField } from '../components/common';
import { useBuilderLabel } from '../lib/builder-i18n';

/** Saves the selected subtree as a reusable section. */
export function SaveSectionDialog({ node, onClose }: { node: ElementNode; onClose: () => void }) {
  const { t } = useI18n();
  const { slug, api } = useLanding();
  const label = useBuilderLabel();
  const [name, setName] = useState(() => label(getWidgetDef(node.type)?.title) || node.type);
  const [category, setCategory] = useState('');
  const save = useLandingMutation({
    mutationFn: () => api.savedSections.create({ name: name.trim(), category: category.trim() || null, node }),
    invalidate: [landingKeys.savedSections(slug)],
    success: (section) => t('landing.sections.saved', { name: section.name }),
    onSuccess: () => onClose(),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() !== '') save.mutate(undefined);
  };
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t('landing.sections.save')}</DialogTitle>
            <DialogDescription>{t('landing.sections.saveHint')}</DialogDescription>
          </DialogHeader>
          <FormField label={t('landing.sections.name')}>
            {(id) => <Input id={id} autoFocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />}
          </FormField>
          <FormField label={t('landing.sections.category')} hint={t('landing.sections.categoryHint')}>
            {(id) => <Input id={id} value={category} maxLength={60} onChange={(e) => setCategory(e.target.value)} />}
          </FormField>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={name.trim() === '' || save.isPending}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Library of saved sections: insert (fresh ids) or delete. */
export function SavedSectionsPicker({
  disabled,
  onClose,
  onInsert,
}: {
  disabled?: boolean;
  onClose: () => void;
  onInsert: (node: ElementNode) => void;
}) {
  const { t } = useI18n();
  const { slug, api } = useLanding();
  const { can } = usePermissions();
  const label = useBuilderLabel();
  const [filter, setFilter] = useState('');
  const [deleting, setDeleting] = useState<SavedSection | null>(null);
  const sections = useQuery({ queryKey: landingKeys.savedSections(slug), queryFn: () => api.savedSections.list() });
  const remove = useLandingMutation({
    mutationFn: (id: string) => api.savedSections.remove(id),
    invalidate: [landingKeys.savedSections(slug)],
    success: t('landing.sections.deleted'),
  });
  const needle = filter.trim().toLowerCase();
  const rows = (sections.data ?? []).filter(
    (s) => !needle || s.name.toLowerCase().includes(needle) || (s.category ?? '').toLowerCase().includes(needle),
  );
  const groups = new Map<string, SavedSection[]>();
  for (const row of rows) {
    const key = row.category ?? '';
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('landing.sections.title')}</DialogTitle>
          <DialogDescription>{t('landing.sections.description')}</DialogDescription>
        </DialogHeader>
        <Input type="search" className="h-8" placeholder={t('landing.sections.filter')} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="max-h-96 overflow-auto">
          {sections.error ? (
            <ErrorNotice error={sections.error} />
          ) : sections.isPending ? (
            <div className="flex justify-center py-6">
              <Spinner />
            </div>
          ) : rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{t('landing.sections.empty')}</p>
          ) : (
            [...groups.entries()]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([category, items]) => (
                <div key={category || '_'} className="mb-3">
                  <p className="mb-1 text-[11px] font-semibold text-muted-foreground uppercase">{category || t('landing.sections.uncategorized')}</p>
                  <ul className="flex flex-col gap-1">
                    {items.map((s) => (
                      <li key={s.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">{s.name}</div>
                          <div className="text-xs text-muted-foreground">{label(getWidgetDef(s.node.type)?.title) || s.node.type}</div>
                        </div>
                        <div className="flex items-center gap-1">
                          <Button
                            size="sm"
                            disabled={disabled}
                            onClick={() => {
                              onInsert(cloneNodeWithNewIds(s.node));
                              onClose();
                            }}
                          >
                            {t('landing.sections.insert')}
                          </Button>
                          {can('pages:write') ? (
                            <Button variant="ghost" size="icon" className="text-destructive" aria-label={t('landing.sections.delete')} onClick={() => setDeleting(s)}>
                              <Trash2 aria-hidden />
                            </Button>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))
          )}
        </div>
        <DashboardConfirmDialog
          open={deleting !== null}
          onOpenChange={(open) => (open ? undefined : setDeleting(null))}
          title={t('landing.sections.deleteTitle', { name: deleting?.name ?? '' })}
          description={t('landing.sections.deleteBody')}
          confirmLabel={t('landing.sections.delete')}
          cancelLabel={t('common.cancel')}
          tone="danger"
          onConfirm={() => {
            if (deleting) remove.mutate(deleting.id);
            setDeleting(null);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
