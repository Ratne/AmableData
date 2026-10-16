import type { Automation, AutomationStatus } from '@amable/api-types';
import {
  cn,
  DashboardButton,
  ListTable,
  PageToolbar,
  usePageChrome,
  type ListTableColumn,
} from '@amable/ui';
import { Badge } from '@amable/ui/ui/badge';
import { Button } from '@amable/ui/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { useNavigate } from '@tanstack/react-router';
import { Copy, FolderInput, FolderTree, Plus, Workflow } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useI18n } from '../../../i18n';
import { listTableLabels } from '../../../lib/labels';
import { folderKeys, useFolderTree } from '../../folders/api';
import {
  DraggableItem,
  FolderBreadcrumb,
  useMoveToDialog,
} from '../../folders/components/folder-list';
import { FolderPanel } from '../../folders/components/folder-panel';
import { createTarget, draggedIds, folderQuery } from '../../folders/lib/tree';
import { useFolderSelection } from '../../folders/use-folder-selection';
import {
  automationKeys,
  useAutomationApi,
  useAutomationMutation,
  useAutomationPermissions,
  useAutomations,
} from '../api/hooks';
import { Field } from '../components/form-bits';

type Tab = AutomationStatus | 'all';

const STATUS_TONE: Record<AutomationStatus, string> = {
  active: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  draft: 'bg-muted text-muted-foreground',
  inactive: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
};

function CreateDialog({
  open,
  onOpenChange,
  folderId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folderId: string | null;
}) {
  const { t } = useI18n();
  const { slug, api } = useAutomationApi();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const create = useAutomationMutation({
    mutationFn: (value: string) => api.create({ name: value, folder_id: folderId }),
    invalidate: [automationKeys.root(slug), folderKeys.tree(slug, 'automation')],
    success: t('auto.list.created'),
    onSuccess: (created) => {
      onOpenChange(false);
      void navigate({
        to: '/t/$tenant/automations/$automationId',
        params: { tenant: slug, automationId: created.id },
      });
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() !== '') create.mutate(name.trim());
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t('auto.new')}</DialogTitle>
          </DialogHeader>
          <Field label={t('auto.name')}>
            <Input
              autoFocus
              value={name}
              maxLength={255}
              onChange={(e) => setName(e.target.value)}
              data-testid="new-automation-name"
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('auto.cancel')}
            </Button>
            <Button type="submit" disabled={name.trim() === '' || create.isPending}>
              {t('auto.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** `/t/$tenant/automations` — list with status, active contacts and last publication. */
export function AutomationsListPage() {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const { slug, api } = useAutomationApi();
  const perms = useAutomationPermissions();
  const [tab, setTab] = useState<Tab>('all');
  const [creating, setCreating] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [showFolders, setShowFolders] = useState(true);
  const folders = useFolderSelection();
  const { tree } = useFolderTree('automation');
  const itemsKey = automationKeys.root(slug);
  const moveTo = useMoveToDialog('automation', itemsKey, tree.data);
  const list = useAutomations(tab, folderQuery(folders.selection, folders.includeSubfolders));
  usePageChrome({
    title: t('auto.title'),
    tabs: (['all', 'active', 'draft', 'inactive'] as const).map((value) => ({
      value,
      label: value === 'all' ? t('auto.list.all') : t(`auto.status.${value}`),
    })),
    tab,
    onTabChange: (value) => setTab(value as Tab),
  });

  const date = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(iso),
    );
  const open = (row: Automation) =>
    void navigate({
      to: '/t/$tenant/automations/$automationId',
      params: { tenant: slug, automationId: row.id },
    });

  const duplicate = useAutomationMutation({
    mutationFn: async (row: Automation) => {
      const source = await api.get(row.id);
      return api.create({
        name: `${row.name} (copy)`.slice(0, 255),
        description: source.description,
        settings: source.settings,
        graph: source.draft_graph,
        folder_id: source.folder_id,
      });
    },
    invalidate: [automationKeys.root(slug), folderKeys.tree(slug, 'automation')],
    success: t('auto.list.created'),
  });

  const columns: ListTableColumn<Automation>[] = [
    {
      id: 'name',
      header: t('auto.col.name'),
      sortable: true,
      sortValue: (row) => row.name,
      cell: (row) => (
        <DraggableItem enabled={perms.canWrite} ids={() => draggedIds(row.id, selectedIds)}>
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium">{row.name}</span>
            {row.description ? (
              <span className="truncate text-xs text-muted-foreground">{row.description}</span>
            ) : null}
          </span>
        </DraggableItem>
      ),
    },
    {
      id: 'status',
      header: t('auto.col.status'),
      sortable: true,
      sortValue: (row) => row.status,
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-1">
          <Badge className={cn('border-0', STATUS_TONE[row.status])}>
            {t(`auto.status.${row.status}`)}
          </Badge>
          {row.has_unpublished_changes && row.published_version !== null ? (
            <Badge variant="outline" className="text-[10px]">
              {t('auto.status.unpublished')}
            </Badge>
          ) : null}
        </span>
      ),
    },
    {
      id: 'active',
      header: t('auto.col.active'),
      align: 'right',
      sortable: true,
      sortValue: (row) => row.active_enrollments,
      cell: (row) => (
        <span className="font-mono tabular-nums">
          {row.active_enrollments.toLocaleString(locale)}
        </span>
      ),
    },
    {
      id: 'published',
      header: t('auto.col.published'),
      hideBelow: 'md',
      sortable: true,
      sortValue: (row) =>
        row.published_version ? new Date(row.published_version.published_at) : null,
      cell: (row) =>
        row.published_version ? (
          <span className="text-sm">
            {t('auto.list.version', {
              n: row.published_version.number,
              date: date(row.published_version.published_at),
            })}
          </span>
        ) : (
          <span className="text-sm text-muted-foreground">{t('auto.list.never')}</span>
        ),
    },
    {
      id: 'updated',
      header: t('auto.col.updated'),
      hideBelow: 'lg',
      sortable: true,
      sortValue: (row) => new Date(row.updated_at),
      cell: (row) => <span className="text-sm text-muted-foreground">{date(row.updated_at)}</span>,
    },
  ];

  return (
    <div className="flex min-h-full">
      <FolderPanel
        kind="automation"
        tree={tree.data}
        selection={folders.selection}
        onSelect={(selection) => {
          setSelectedIds([]);
          folders.select(selection);
        }}
        canWrite={perms.canWrite}
        itemsKey={itemsKey}
        onDropItems={(ids, folderId) => {
          moveTo.move.mutate({ ids, folderId });
          setSelectedIds([]);
        }}
        className={cn(
          'sticky top-0 max-h-dvh w-60 shrink-0 self-start overflow-y-auto border-r p-3',
          showFolders ? 'hidden md:flex' : 'hidden',
        )}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <PageToolbar
          filters={
            <DashboardButton
              onClick={() => setShowFolders((v) => !v)}
              aria-pressed={showFolders}
              aria-label={t('folders.toggle')}
              title={t('folders.toggle')}
              className="hidden md:inline-flex"
            >
              <FolderTree className="size-4" aria-hidden />
            </DashboardButton>
          }
          actions={
            perms.canWrite ? (
              <DashboardButton
                variant="primary"
                onClick={() => setCreating(true)}
                data-testid="new-automation"
              >
                <Plus className="size-4" aria-hidden /> {t('auto.new')}
              </DashboardButton>
            ) : undefined
          }
        />
        <FolderBreadcrumb
          tree={tree.data}
          selection={folders.selection}
          onSelect={folders.select}
          includeSubfolders={folders.includeSubfolders}
          onIncludeSubfoldersChange={folders.setIncludeSubfolders}
        />
        <ListTable<Automation>
          rows={list.data ?? []}
          selectedIds={selectedIds}
          onSelectedIdsChange={setSelectedIds}
          {...(perms.canWrite
            ? {
                bulkActions: [
                  {
                    id: 'move',
                    label: t('folders.moveTo'),
                    icon: FolderInput,
                    onSelect: (rows: Automation[]) => moveTo.open(rows, rows[0]?.name ?? null),
                  },
                ],
              }
            : {})}
          getRowId={(row) => row.id}
          getRowLabel={(row) => row.name}
          columns={columns}
          labels={listTableLabels(t)}
          defaultSort={{ columnId: 'updated', direction: 'desc' }}
          loading={list.isPending}
          onRowOpen={open}
          rowActions={(row) => [
            { id: 'open', label: t('auto.open'), onSelect: () => open(row) },
            ...(perms.canWrite
              ? [
                  {
                    id: 'duplicate',
                    label: t('auto.duplicate'),
                    icon: Copy,
                    onSelect: () => duplicate.mutate(row),
                  },
                  {
                    id: 'move',
                    label: t('folders.moveTo'),
                    icon: FolderInput,
                    onSelect: () => moveTo.open([row], row.name),
                  },
                ]
              : []),
          ]}
          {...(perms.canWrite
            ? {
                deletion: {
                  confirm: true,
                  onDelete: async (rows: readonly Automation[]) => {
                    for (const row of rows) await api.remove(row.id);
                    await list.refetch();
                    await tree.refetch();
                  },
                },
              }
            : {})}
          emptyState={
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <Workflow className="size-8 text-muted-foreground" aria-hidden />
              <p className="text-sm font-medium">{t('auto.list.empty')}</p>
              <p className="max-w-sm text-xs text-muted-foreground">{t('auto.list.emptyHint')}</p>
            </div>
          }
        />
      </div>
      <CreateDialog
        open={creating}
        onOpenChange={setCreating}
        folderId={createTarget(folders.selection)}
      />
      {moveTo.dialog}
    </div>
  );
}
