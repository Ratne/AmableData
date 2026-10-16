import type { Tag, TagCategory } from '@amable/api-types/crm';
import {
  DashboardButton,
  DashboardConfirmDialog,
  ListTable,
  PageToolbar,
  usePageChrome,
  type ListTableColumn,
} from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
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
import { Textarea } from '@amable/ui/ui/textarea';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { FolderPlus, Pencil, Plus, Trash2, Users } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useI18n } from '../../../i18n';
import { listTableLabels } from '../../../lib/labels';
import {
  crmKeys,
  useCrm,
  useCrmMutation,
  usePermissions,
  useTagCategories,
} from '../api/hooks';
import { ChoiceSelect } from '../components/inputs';
import { ErrorNotice } from '../components/states';

type Editing =
  { kind: 'tag'; tag: Tag | null } | { kind: 'category'; category: TagCategory | null } | null;

function EditDialog({
  editing,
  onClose,
  categories,
}: {
  editing: Exclude<Editing, null>;
  onClose: () => void;
  categories: readonly TagCategory[];
}) {
  const { t } = useI18n();
  const { slug, api } = useCrm();
  const current = editing.kind === 'tag' ? editing.tag : editing.category;
  const [name, setName] = useState(current?.name ?? '');
  const [description, setDescription] = useState(current?.description ?? '');
  const [categoryId, setCategoryId] = useState(
    editing.kind === 'tag' ? (editing.tag?.category_id ?? '') : '',
  );
  const keys = [crmKeys.tags(slug), crmKeys.tagCategories(slug)];
  const save = useCrmMutation({
    mutationFn: async () => {
      const base = { name: name.trim(), description: description.trim() || null };
      if (editing.kind === 'tag') {
        const input = { ...base, category_id: categoryId || null };
        return editing.tag ? api.tags.update(editing.tag.id, input) : api.tags.create(input);
      }
      return editing.category
        ? api.tagCategories.update(editing.category.id, base)
        : api.tagCategories.create(base);
    },
    invalidate: keys,
    success: t('crm.common.saved'),
    onSuccess: onClose,
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim()) save.mutate(undefined);
  };
  const title =
    editing.kind === 'tag'
      ? editing.tag
        ? t('crm.tags.edit')
        : t('crm.tags.new')
      : editing.category
        ? t('crm.tags.editCategory')
        : t('crm.tags.newCategory');
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{t('crm.tags.dialogBody')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="tag-name">{t('crm.common.name')}</Label>
            <Input
              id="tag-name"
              value={name}
              maxLength={100}
              autoFocus
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          {editing.kind === 'tag' ? (
            <div className="grid gap-1.5">
              <Label>{t('crm.tags.category')}</Label>
              <ChoiceSelect
                value={categoryId}
                onChange={setCategoryId}
                ariaLabel={t('crm.tags.category')}
                choices={categories.map((c) => ({ value: c.id, label: c.name }))}
              />
            </div>
          ) : null}
          <div className="grid gap-1.5">
            <Label htmlFor="tag-description">{t('crm.field.description')}</Label>
            <Textarea
              id="tag-description"
              value={description}
              rows={3}
              maxLength={1000}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!name.trim() || save.isPending}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function TagsPage() {
  const { t } = useI18n();
  const { slug, api } = useCrm();
  const { can } = usePermissions();
  const navigate = useNavigate();
  const categories = useTagCategories();
  const [categoryFilter, setCategoryFilter] = useState('');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setQ(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  const serverCategory =
    categoryFilter === '' || categoryFilter === '__none' ? undefined : categoryFilter;
  const tags = useInfiniteQuery({
    queryKey: [...crmKeys.tags(slug), 'page', q, serverCategory ?? ''] as const,
    queryFn: ({ pageParam }) =>
      api.tags.list({
        limit: 100,
        cursor: pageParam,
        ...(q === '' ? {} : { q }),
        ...(serverCategory === undefined ? {} : { category_id: serverCategory }),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    placeholderData: keepPreviousData,
  });
  const loaded = tags.data?.pages.flatMap((page) => page.data) ?? [];
  const [editing, setEditing] = useState<Editing>(null);
  const [deletingCategory, setDeletingCategory] = useState<TagCategory | null>(null);
  usePageChrome({ title: t('nav.tags') });
  const categoryList = categories.data ?? [];
  const categoryName = new Map(categoryList.map((c) => [c.id, c.name]));
  const keys = [crmKeys.tags(slug), crmKeys.tagCategories(slug)];
  const removeCategory = useCrmMutation({
    mutationFn: (id: string) => api.tagCategories.remove(id),
    invalidate: keys,
    success: t('crm.tags.categoryDeleted'),
    onSuccess: () => setDeletingCategory(null),
  });
  const removeTags = useCrmMutation({
    mutationFn: (rows: Tag[]) => Promise.all(rows.map((row) => api.tags.remove(row.id))),
    invalidate: [crmKeys.root(slug)],
  });

  const restoreTags = useCrmMutation({
    mutationFn: (rows: Tag[]) => Promise.all(rows.map((row) => api.tags.restore(row.id))),
    invalidate: [crmKeys.root(slug)],
  });

  const rows = categoryFilter === '__none' ? loaded.filter((tag) => !tag.category_id) : loaded;
  const columns: ListTableColumn<Tag>[] = [
    {
      id: 'name',
      header: t('crm.common.name'),
      cell: (tag) => <span className="font-medium">{tag.name}</span>,
      sortable: true,
      sortValue: (tag) => tag.name,
    },
    {
      id: 'category',
      header: t('crm.tags.category'),
      cell: (tag) =>
        tag.category_id ? (
          (categoryName.get(tag.category_id) ?? '')
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
      sortable: true,
      sortValue: (tag) => (tag.category_id ? (categoryName.get(tag.category_id) ?? '') : ''),
    },
    {
      id: 'contacts',
      header: t('crm.field.contact_count'),
      cell: (tag) => tag.contact_count,
      sortable: true,
      sortValue: (tag) => tag.contact_count,
      firstDirection: 'desc',
      align: 'right',
    },
    {
      id: 'description',
      header: t('crm.field.description'),
      cell: (tag) => <span className="text-muted-foreground">{tag.description ?? ''}</span>,
      hideBelow: 'lg',
    },
  ];

  return (
    <div className="grid gap-0 lg:grid-cols-[16rem_1fr]">
      <aside className="border-r p-4" aria-label={t('crm.tags.categories')}>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {t('crm.tags.categories')}
          </h3>
          {can('settings:manage') ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={t('crm.tags.newCategory')}
              onClick={() => setEditing({ kind: 'category', category: null })}
            >
              <FolderPlus className="size-3.5" aria-hidden />
            </Button>
          ) : null}
        </div>
        <ul className="grid gap-0.5 text-sm">
          {[
            { id: '', name: t('crm.tags.allCategories') },
            { id: '__none', name: t('crm.tags.uncategorized') },
          ].map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className={`w-full rounded-md px-2 py-1.5 text-left hover:bg-muted ${categoryFilter === item.id ? 'bg-muted font-medium' : ''}`}
                onClick={() => setCategoryFilter(item.id)}
              >
                {item.name}
              </button>
            </li>
          ))}
          {categoryList.map((category) => (
            <li key={category.id} className="group flex items-center gap-1">
              <button
                type="button"
                className={`min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-left hover:bg-muted ${categoryFilter === category.id ? 'bg-muted font-medium' : ''}`}
                onClick={() => setCategoryFilter(category.id)}
              >
                {category.name}
              </button>
              {can('settings:manage') ? (
                <>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    aria-label={t('crm.tags.editCategory')}
                    onClick={() => setEditing({ kind: 'category', category })}
                  >
                    <Pencil className="size-3" aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    aria-label={t('crm.tags.deleteCategory')}
                    onClick={() => setDeletingCategory(category)}
                  >
                    <Trash2 className="size-3" aria-hidden />
                  </Button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      </aside>
      <div className="min-w-0">
        <PageToolbar
          filters={
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('crm.tagPicker.search')}
              aria-label={t('crm.tagPicker.search')}
              className="h-8 w-64"
            />
          }
          actions={
            can('tags:write') ? (
              <DashboardButton
                variant="primary"
                onClick={() => setEditing({ kind: 'tag', tag: null })}
              >
                <Plus aria-hidden /> {t('crm.tags.new')}
              </DashboardButton>
            ) : null
          }
        />
        {tags.error ? (
          <div className="px-4">
            <ErrorNotice error={tags.error} />
          </div>
        ) : null}
        <ListTable<Tag>
          rows={rows}
          getRowId={(tag) => tag.id}
          getRowLabel={(tag) => tag.name}
          columns={columns}
          labels={listTableLabels(t)}
          defaultSort={{ columnId: 'name', direction: 'asc' }}
          loading={tags.isPending}
          selectable={can('tags:write')}
          rowActions={(tag) => [
            {
              id: 'contacts',
              label: t('crm.tags.viewContacts'),
              icon: Users,
              onSelect: () =>
                void navigate({
                  to: '/t/$tenant/contacts',
                  params: { tenant: slug },
                  search: { tag: tag.id },
                }),
            },
            ...(can('tags:write')
              ? [
                  {
                    id: 'edit',
                    label: t('crm.common.edit'),
                    icon: Pencil,
                    onSelect: () => setEditing({ kind: 'tag', tag }),
                  },
                ]
              : []),
          ]}
          deletion={
            can('tags:write')
              ? {
                  onDelete: (rowsToDelete) =>
                    removeTags.mutateAsync(rowsToDelete).then(() => undefined),
                  onUndo: (rowsToRestore) =>
                    restoreTags.mutateAsync(rowsToRestore).then(() => undefined),
                }
              : undefined
          }
          onRowOpen={can('tags:write') ? (tag) => setEditing({ kind: 'tag', tag }) : undefined}
        />
        {tags.hasNextPage ? (
          <div className="flex justify-center p-3">
            <Button
              variant="outline"
              size="sm"
              disabled={tags.isFetchingNextPage}
              onClick={() => void tags.fetchNextPage()}
            >
              {t('crm.common.loadMore')}
            </Button>
          </div>
        ) : null}
      </div>
      {editing !== null ? (
        <EditDialog editing={editing} onClose={() => setEditing(null)} categories={categoryList} />
      ) : null}
      <DashboardConfirmDialog
        open={deletingCategory !== null}
        onOpenChange={(open) => (open ? undefined : setDeletingCategory(null))}
        title={t('crm.tags.confirmDeleteCategory', { name: deletingCategory?.name ?? '' })}
        description={t('crm.tags.confirmDeleteCategoryBody')}
        confirmLabel={t('list.delete')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onConfirm={() =>
          deletingCategory ? removeCategory.mutate(deletingCategory.id) : undefined
        }
      />
    </div>
  );
}
