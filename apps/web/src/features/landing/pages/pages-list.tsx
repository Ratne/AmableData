import {
  DashboardButton,
  DashboardFilterMenu,
  ListTable,
  PageBody,
  PageToolbar,
  usePageChrome,
  type ListTableColumn,
  type ListTableRowAction,
} from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { cn } from '@amable/ui';
import { useNavigate } from '@tanstack/react-router';
import {
  Copy,
  Download,
  ExternalLink,
  FolderInput,
  FolderTree,
  PenTool,
  Plus,
  Settings,
  Upload,
} from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
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
  landingKeys,
  useDates,
  useLanding,
  useLandingMutation,
  usePermissions,
} from '../api/hooks';
import type { ImportPageResponse, LandingPage, PageImportWarnings, PageStatus } from '../api/types';
import { ErrorNotice, FormField, normalizePath, Pill, slugifyTitle } from '../components/common';

type StatusFilter = 'all' | PageStatus;

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export function PagesListPage() {
  const { t } = useI18n();
  const { slug, api } = useLanding();
  const { can } = usePermissions();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { dateTime } = useDates();
  usePageChrome({ title: t('nav.landingPages') });
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 250);
  const [creating, setCreating] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [showFolders, setShowFolders] = useState(true);
  const writable = can('pages:write');
  const folders = useFolderSelection();
  const { tree } = useFolderTree('page');
  const itemsKey = landingKeys.root(slug);
  const moveTo = useMoveToDialog('page', itemsKey, tree.data);
  const folderFilter = folderQuery(folders.selection, folders.includeSubfolders);

  const pages = useInfiniteQuery({
    queryKey: [...landingKeys.list(slug, filter, q), folderFilter],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.pages.list({
        ...(filter === 'all' ? {} : { status: filter }),
        ...(q ? { q } : {}),
        ...folderFilter,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const rows = pages.data?.pages.flatMap((p) => p.data) ?? [];
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: landingKeys.root(slug) }),
      queryClient.invalidateQueries({ queryKey: folderKeys.tree(slug, 'page') }),
    ]);
  const openEditor = (page: LandingPage) =>
    void navigate({
      to: '/t/$tenant/landing-pages/$pageId/edit',
      params: { tenant: slug, pageId: page.id },
    });
  const openSettings = (page: LandingPage) =>
    void navigate({
      to: '/t/$tenant/landing-pages/$pageId/settings',
      params: { tenant: slug, pageId: page.id },
    });

  const duplicate = useLandingMutation({
    mutationFn: (id: string) => api.pages.duplicate(id),
    success: t('landing.list.duplicated'),
  });
  const exportZip = useLandingMutation({
    mutationFn: (id: string) => api.pages.exportZip(id),
    invalidate: [],
  });
  const importInput = useRef<HTMLInputElement>(null);
  const [importReport, setImportReport] = useState<ImportPageResponse | null>(null);
  const importZip = useLandingMutation({
    mutationFn: (file: File) => api.pages.importZip(file),
    success: t('landing.transfer.imported'),
    onSuccess: (result) => {
      if (hasImportWarnings(result.warnings)) setImportReport(result);
      else openEditor(result.page);
    },
  });

  const columns: ListTableColumn<LandingPage>[] = [
    {
      id: 'title',
      header: t('landing.field.title'),
      cell: (p) => (
        <DraggableItem enabled={writable} ids={() => draggedIds(p.id, selectedIds)}>
          <span className="truncate font-medium">{p.title || t('landing.untitled')}</span>
          {p.editor_kind === 'html' ? (
            <span className="ml-2" title={t('landing.kind.htmlHint')}>
              <Pill tone="neutral">{t('landing.kind.html')}</Pill>
            </span>
          ) : null}
        </DraggableItem>
      ),
      sortable: true,
      sortValue: (p) => p.title.toLowerCase(),
    },
    {
      id: 'path',
      header: t('landing.field.path'),
      cell: (p) => <code className="truncate text-xs text-muted-foreground">{p.path}</code>,
      sortable: true,
      sortValue: (p) => p.path,
    },
    {
      id: 'host',
      header: t('landing.field.host'),
      cell: (p) => <span className="truncate text-sm">{p.host ?? t('landing.host.default')}</span>,
      hideBelow: 'lg',
    },
    {
      id: 'status',
      header: t('landing.field.status'),
      cell: (p) => (
        <Pill tone={p.status === 'published' ? 'success' : 'neutral'}>
          {t(`landing.status.${p.status}`)}
        </Pill>
      ),
      sortable: true,
      sortValue: (p) => p.status,
    },
    {
      id: 'published',
      header: t('landing.field.published'),
      cell: (p) => (p.published_at ? dateTime(p.published_at) : '—'),
      sortable: true,
      sortValue: (p) => p.published_at ?? '',
      hideBelow: 'md',
    },
    {
      id: 'updated',
      header: t('landing.field.updated'),
      cell: (p) => dateTime(p.updated_at),
      sortable: true,
      sortValue: (p) => p.updated_at,
      hideBelow: 'lg',
    },
  ];

  const rowActions = (page: LandingPage): ListTableRowAction<LandingPage>[] => {
    const actions: ListTableRowAction<LandingPage>[] = [
      {
        id: 'edit',
        label: t('landing.action.edit'),
        icon: PenTool,
        onSelect: () => openEditor(page),
      },
      {
        id: 'settings',
        label: t('landing.action.settings'),
        icon: Settings,
        onSelect: () => openSettings(page),
      },
      {
        id: 'export',
        label: exportZip.isPending ? t('landing.transfer.exporting') : t('landing.transfer.export'),
        icon: Download,
        onSelect: () => exportZip.mutate(page.id),
      },
    ];
    if (page.status === 'published' && page.public_url) {
      const url = page.public_url;
      actions.push({
        id: 'live',
        label: t('landing.action.viewLive'),
        icon: ExternalLink,
        onSelect: () => void window.open(url, '_blank', 'noopener,noreferrer'),
      });
    }
    if (writable) {
      actions.push({
        id: 'duplicate',
        label: t('landing.action.duplicate'),
        icon: Copy,
        separatorBefore: true,
        onSelect: () => duplicate.mutate(page.id),
      });
      actions.push({
        id: 'move',
        label: t('folders.moveTo'),
        icon: FolderInput,
        onSelect: () => moveTo.open([page], page.title || page.path),
      });
    }
    return actions;
  };

  return (
    <div className="flex min-h-full">
      <FolderPanel
        kind="page"
        tree={tree.data}
        selection={folders.selection}
        onSelect={(selection) => {
          setSelectedIds([]);
          folders.select(selection);
        }}
        canWrite={writable}
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
            <>
              <DashboardButton
                onClick={() => setShowFolders((v) => !v)}
                aria-pressed={showFolders}
                aria-label={t('folders.toggle')}
                title={t('folders.toggle')}
                className="hidden md:inline-flex"
              >
                <FolderTree className="size-4" aria-hidden />
              </DashboardButton>
              <Input
                type="search"
                aria-label={t('landing.list.search')}
                placeholder={t('landing.list.search')}
                value={search}
                className="h-8 w-56"
                onChange={(e) => setSearch(e.target.value)}
              />
              <DashboardFilterMenu
                label={t('landing.field.status')}
                value={filter}
                onValueChange={(value) => setFilter(value as StatusFilter)}
                options={(['all', 'draft', 'published'] as const).map((value) => ({
                  value,
                  label: value === 'all' ? t('landing.filter.all') : t(`landing.status.${value}`),
                }))}
              />
            </>
          }
          actions={
            writable ? (
              <>
                <input
                  ref={importInput}
                  type="file"
                  accept=".zip,application/zip"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file) importZip.mutate(file);
                  }}
                />
                <DashboardButton
                  onClick={() => importInput.current?.click()}
                  disabled={importZip.isPending}
                  title={t('landing.transfer.importHint')}
                >
                  <Upload aria-hidden />{' '}
                  {importZip.isPending ? t('landing.transfer.importing') : t('landing.transfer.import')}
                </DashboardButton>
                <DashboardButton variant="primary" onClick={() => setCreating(true)}>
                  <Plus aria-hidden /> {t('landing.list.new')}
                </DashboardButton>
              </>
            ) : null
          }
        />
        <FolderBreadcrumb
          tree={tree.data}
          selection={folders.selection}
          onSelect={folders.select}
          includeSubfolders={folders.includeSubfolders}
          onIncludeSubfoldersChange={folders.setIncludeSubfolders}
        />
        {pages.error ? (
          <PageBody>
            <ErrorNotice error={pages.error} />
          </PageBody>
        ) : (
          <ListTable<LandingPage>
            className="px-4"
            rows={rows}
            getRowId={(p) => p.id}
            getRowLabel={(p) => p.title || p.path}
            columns={columns}
            labels={listTableLabels(t)}
            defaultSort={{ columnId: 'updated', direction: 'desc' }}
            selectable={writable}
            selectedIds={selectedIds}
            onSelectedIdsChange={setSelectedIds}
            bulkActions={
              writable
                ? [
                    {
                      id: 'move',
                      label: t('folders.moveTo'),
                      icon: FolderInput,
                      onSelect: (selected: LandingPage[]) =>
                        moveTo.open(
                          selected,
                          selected[0] ? selected[0].title || selected[0].path : null,
                        ),
                    },
                  ]
                : undefined
            }
            loading={pages.isPending}
            onRowOpen={openEditor}
            rowActions={rowActions}
            deletion={
              writable
                ? {
                    onDelete: async (selected) => {
                      await Promise.all(selected.map((p) => api.pages.remove(p.id)));
                      await refresh();
                    },
                    onUndo: async (selected) => {
                      await Promise.all(selected.map((p) => api.pages.restore(p.id)));
                      await refresh();
                    },
                    confirm: true,
                  }
                : undefined
            }
            emptyState={
              <p className="py-10 text-center text-sm text-muted-foreground">
                {t('landing.list.empty')}
              </p>
            }
            footer={
              pages.hasNextPage ? (
                <div className="flex justify-center py-3">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pages.isFetchingNextPage}
                    onClick={() => void pages.fetchNextPage()}
                  >
                    {t('landing.common.loadMore')}
                  </Button>
                </div>
              ) : undefined
            }
          />
        )}
      </div>
      {moveTo.dialog}
      {importReport ? (
        <ImportReportDialog
          report={importReport}
          onClose={() => setImportReport(null)}
          onOpen={() => {
            const page = importReport.page;
            setImportReport(null);
            openEditor(page);
          }}
        />
      ) : null}
      {creating ? (
        <CreatePageDialog
          folderId={createTarget(folders.selection)}
          onClose={() => setCreating(false)}
          onCreated={(page) => {
            setCreating(false);
            openEditor(page);
          }}
        />
      ) : null}
    </div>
  );
}

function hasImportWarnings(w: PageImportWarnings): boolean {
  return (
    w.relink.forms + w.relink.bookings + w.relink.checkouts > 0 ||
    w.media_missing.length > 0 ||
    w.media_skipped.length > 0 ||
    w.path_renamed !== null ||
    w.analytics_disconnected
  );
}

function ImportReportDialog({
  report,
  onClose,
  onOpen,
}: {
  report: ImportPageResponse;
  onClose: () => void;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const w = report.warnings;
  const items: string[] = [];
  if (w.relink.forms > 0) items.push(t('landing.transfer.relinkForms', { count: w.relink.forms }));
  if (w.relink.bookings > 0) items.push(t('landing.transfer.relinkBookings', { count: w.relink.bookings }));
  if (w.relink.checkouts > 0) items.push(t('landing.transfer.relinkCheckouts', { count: w.relink.checkouts }));
  if (w.media_missing.length > 0) items.push(t('landing.transfer.mediaMissing', { files: w.media_missing.join(', ') }));
  if (w.media_skipped.length > 0) items.push(t('landing.transfer.mediaSkipped', { files: w.media_skipped.join(', ') }));
  if (w.path_renamed !== null) items.push(t('landing.transfer.pathRenamed', { path: w.path_renamed }));
  if (w.analytics_disconnected) items.push(t('landing.transfer.analytics'));
  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('landing.transfer.reportTitle')}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {t('landing.transfer.reportMedia', { imported: report.media_imported, reused: report.media_reused })}
        </p>
        <ul className="grid list-disc gap-2 pl-5 text-sm">
          {items.map((item) => (
            <li key={item} className="break-words">
              {item}
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('landing.transfer.close')}
          </Button>
          <Button type="button" onClick={onOpen}>
            {t('landing.transfer.openEditor')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreatePageDialog({
  folderId,
  onClose,
  onCreated,
}: {
  folderId: string | null;
  onClose: () => void;
  onCreated: (page: LandingPage) => void;
}) {
  const { t } = useI18n();
  const { api } = useLanding();
  const [title, setTitle] = useState('');
  const [path, setPath] = useState('');
  const [pathTouched, setPathTouched] = useState(false);
  const effectivePath = pathTouched ? normalizePath(path) : slugifyTitle(title);
  const create = useLandingMutation({
    mutationFn: () =>
      api.pages.create({ title: title.trim(), path: effectivePath, folder_id: folderId }),
    success: t('landing.list.created'),
    onSuccess: (page) => onCreated(page),
  });
  const valid = title.trim() !== '' && effectivePath.length > 0;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) create.mutate(undefined);
  };
  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t('landing.list.new')}</DialogTitle>
          </DialogHeader>
          <FormField label={t('landing.field.title')} hint={t('landing.list.titleHint')}>
            {(id) => (
              <Input
                id={id}
                autoFocus
                value={title}
                maxLength={200}
                onChange={(e) => setTitle(e.target.value)}
              />
            )}
          </FormField>
          <FormField label={t('landing.field.path')} hint={t('landing.list.pathHint')}>
            {(id) => (
              <Input
                id={id}
                value={pathTouched ? path : effectivePath}
                maxLength={300}
                className="font-mono"
                onChange={(e) => {
                  setPathTouched(true);
                  setPath(e.target.value);
                }}
              />
            )}
          </FormField>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!valid || create.isPending}>
              {t('landing.list.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
