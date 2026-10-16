import type { SavedSearch, SearchEntity, SearchQueryInput } from '@amable/api-types/crm';
import {
  cn,
  DashboardConfirmDialog,
  DashboardMenu,
  DashboardMenuContent,
  DashboardMenuItem,
  DashboardMenuTrigger,
} from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Checkbox } from '@amable/ui/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { Label } from '@amable/ui/ui/label';
import { Bookmark, Ellipsis, Pencil, Save, Trash2, Users } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useI18n } from '../../i18n';
import {
  crmKeys,
  useCrm,
  useCrmMutation,
  usePermissions,
  useSavedSearches,
} from '../crm/api/hooks';

function NameDialog({
  open,
  onOpenChange,
  title,
  initialName,
  initialShared,
  showShared,
  onSubmit,
  pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  initialName: string;
  initialShared: boolean;
  showShared: boolean;
  onSubmit: (name: string, shared: boolean) => void;
  pending: boolean;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(initialName);
  const [shared, setShared] = useState(initialShared);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() !== '') onSubmit(name.trim(), shared);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{t('search.saved.dialogBody')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="saved-search-name">{t('search.saved.name')}</Label>
            <Input
              id="saved-search-name"
              value={name}
              autoFocus
              maxLength={255}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          {showShared ? (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={shared} onCheckedChange={(value) => setShared(value === true)} />
              {t('search.saved.shared')}
            </label>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={pending || name.trim() === ''}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Saved searches of an entity: load one into the builder, save the current
 * query (new or overwrite), rename, delete.
 */
export function SavedSearchesSidebar({
  entity,
  activeId,
  currentQuery,
  onLoad,
  onSaved,
  className,
}: {
  entity: SearchEntity;
  activeId: string | null;
  /** Query to store (without limit/cursor). */
  currentQuery: SearchQueryInput;
  onLoad: (saved: SavedSearch | null) => void;
  onSaved: (saved: SavedSearch) => void;
  className?: string;
}) {
  const { t } = useI18n();
  const { slug, api } = useCrm();
  const { can } = usePermissions();
  const canWrite = can('saved_searches:write');
  const saved = useSavedSearches();
  const items = (saved.data ?? []).filter((item) => item.entity === entity);
  const active = items.find((item) => item.id === activeId) ?? null;
  const [dialog, setDialog] = useState<
    { mode: 'create' } | { mode: 'rename'; item: SavedSearch } | null
  >(null);
  const [deleting, setDeleting] = useState<SavedSearch | null>(null);
  const invalidate = [crmKeys.savedSearches(slug)];

  const create = useCrmMutation({
    mutationFn: (input: { name: string; shared: boolean }) =>
      api.savedSearches.create({ name: input.name, shared: input.shared, query: currentQuery }),
    invalidate,
    success: t('search.saved.created'),
    onSuccess: (result) => {
      setDialog(null);
      onSaved(result);
    },
  });
  const update = useCrmMutation({
    mutationFn: (input: {
      id: string;
      name?: string;
      shared?: boolean;
      query?: SearchQueryInput;
    }) =>
      api.savedSearches.update(input.id, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.shared !== undefined ? { shared: input.shared } : {}),
        ...(input.query !== undefined ? { query: input.query } : {}),
      }),
    invalidate,
    success: t('search.saved.updated'),
    onSuccess: () => setDialog(null),
  });
  const remove = useCrmMutation({
    mutationFn: (id: string) => api.savedSearches.remove(id),
    invalidate,
    success: t('search.saved.deleted'),
    onSuccess: (_result, id) => {
      setDeleting(null);
      if (id === activeId) onLoad(null);
    },
  });

  return (
    <aside className={cn('flex flex-col gap-2', className)} aria-label={t('search.saved.title')}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {t('search.saved.title')}
        </h3>
      </div>
      <button
        type="button"
        onClick={() => onLoad(null)}
        className={cn(
          'rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted',
          activeId === null && 'bg-muted font-medium',
        )}
      >
        {t('search.saved.all')}
      </button>
      <ul className="flex flex-col gap-0.5">
        {items.map((item) => (
          <li key={item.id} className="group flex items-center gap-1">
            <button
              type="button"
              onClick={() => onLoad(item)}
              aria-current={item.id === activeId ? 'true' : undefined}
              className={cn(
                'flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted',
                item.id === activeId && 'bg-muted font-medium',
              )}
            >
              <Bookmark className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate">{item.name}</span>
              {item.shared ? (
                <Users
                  className="size-3 shrink-0 text-muted-foreground"
                  aria-label={t('search.saved.shared')}
                />
              ) : null}
            </button>
            {canWrite ? (
              <DashboardMenu>
                <DashboardMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    aria-label={t('search.saved.actions', { name: item.name })}
                  >
                    <Ellipsis className="size-3.5" aria-hidden />
                  </Button>
                </DashboardMenuTrigger>
                <DashboardMenuContent align="end">
                  <DashboardMenuItem onSelect={() => setDialog({ mode: 'rename', item })}>
                    <Pencil className="size-3.5" aria-hidden /> {t('search.saved.rename')}
                  </DashboardMenuItem>
                  <DashboardMenuItem onSelect={() => setDeleting(item)}>
                    <Trash2 className="size-3.5" aria-hidden /> {t('list.delete')}
                  </DashboardMenuItem>
                </DashboardMenuContent>
              </DashboardMenu>
            ) : null}
          </li>
        ))}
        {items.length === 0 && !saved.isPending ? (
          <li className="px-2 py-1 text-xs text-muted-foreground">{t('search.saved.empty')}</li>
        ) : null}
      </ul>
      {canWrite ? (
        <div className="flex flex-col gap-1.5 border-t pt-2">
          <Button variant="outline" size="sm" onClick={() => setDialog({ mode: 'create' })}>
            <Save className="size-3.5" aria-hidden /> {t('search.saved.saveAs')}
          </Button>
          {active ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={update.isPending}
              onClick={() => update.mutate({ id: active.id, query: currentQuery })}
            >
              {t('search.saved.overwrite', { name: active.name })}
            </Button>
          ) : null}
        </div>
      ) : null}

      {dialog !== null ? (
        <NameDialog
          open
          onOpenChange={(open) => (open ? undefined : setDialog(null))}
          title={dialog.mode === 'create' ? t('search.saved.saveAs') : t('search.saved.rename')}
          initialName={dialog.mode === 'rename' ? dialog.item.name : ''}
          initialShared={dialog.mode === 'rename' ? dialog.item.shared : true}
          showShared
          pending={create.isPending || update.isPending}
          onSubmit={(name, shared) =>
            dialog.mode === 'create'
              ? create.mutate({ name, shared })
              : update.mutate({ id: dialog.item.id, name, shared })
          }
        />
      ) : null}
      <DashboardConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => (open ? undefined : setDeleting(null))}
        title={t('search.saved.confirmDelete', { name: deleting?.name ?? '' })}
        description={t('search.saved.confirmDeleteBody')}
        confirmLabel={t('list.delete')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onConfirm={() => (deleting ? remove.mutate(deleting.id) : undefined)}
      />
    </aside>
  );
}
