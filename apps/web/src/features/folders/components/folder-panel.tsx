import type { Folder, FolderKind, FolderTree } from '@amable/api-types';
import {
  cn,
  DashboardMenu,
  DashboardMenuContent,
  DashboardMenuItem,
  DashboardMenuSeparator,
  DashboardMenuTrigger,
  toast,
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
import type { QueryKey } from '@tanstack/react-query';
import {
  ChevronRight,
  Ellipsis,
  Folder as FolderIcon,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Inbox,
  Layers,
  Pencil,
  Trash2,
} from 'lucide-react';
import {
  useEffect,
  useMemo,
  useState,
  type DragEvent,
  type FormEvent,
  type ReactNode,
} from 'react';
import { useI18n } from '../../../i18n';
import { useFolderMutation } from '../api';
import {
  canMoveFolder,
  FOLDER_MIME,
  indexFolders,
  readDrag,
  revealPath,
  subtreeIds,
  type FolderIndex,
  type FolderSelection,
} from '../lib/tree';

type Translate = ReturnType<typeof useI18n>['t'];

function useExpanded(kind: FolderKind) {
  const key = `amable.folders.${kind}.expanded`;
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const raw: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
      return new Set(
        Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [],
      );
    } catch {
      return new Set();
    }
  });
  const update = (next: Set<string>) => {
    setExpanded(next);
    localStorage.setItem(key, JSON.stringify([...next]));
  };
  return {
    expanded,
    toggle: (id: string) => {
      const next = new Set(expanded);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      update(next);
    },
    open: (ids: readonly string[]) => {
      if (ids.every((id) => expanded.has(id))) return;
      update(new Set([...expanded, ...ids]));
    },
  };
}

/** Server rule mirrored for drop feedback; returns the toast text of a refused drop. */
function folderDropError(
  t: Translate,
  index: FolderIndex,
  folderId: string,
  target: string | null,
  maxDepth: number,
) {
  const check = canMoveFolder(index, folderId, target, maxDepth);
  if (check === 'cycle') return t('folders.cannotDropInside');
  if (check === 'depth') return t('folders.depthLimit', { n: maxDepth });
  return null;
}

export interface FolderPanelProps {
  readonly kind: FolderKind;
  readonly tree: FolderTree | undefined;
  readonly selection: FolderSelection;
  readonly onSelect: (selection: FolderSelection) => void;
  readonly canWrite: boolean;
  /** Query key of the item list, refreshed after every folder change. */
  readonly itemsKey: QueryKey;
  /** Items dropped on a folder (`null` = Unfiled). */
  readonly onDropItems: (ids: readonly string[], folderId: string | null) => void;
  readonly className?: string;
}

/** Left panel of a list page: All / Unfiled / the folder tree, with drag & drop and folder actions. */
export function FolderPanel({
  kind,
  tree,
  selection,
  onSelect,
  canWrite,
  itemsKey,
  onDropItems,
  className,
}: FolderPanelProps) {
  const { t, locale } = useI18n();
  const folders = useMemo(() => tree?.data ?? [], [tree]);
  const index = useMemo(() => indexFolders(folders), [folders]);
  const maxDepth = tree?.max_depth ?? 5;
  const { expanded, toggle, open } = useExpanded(kind);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [naming, setNaming] = useState<
    { mode: 'create'; parent: Folder | null } | { mode: 'rename'; folder: Folder } | null
  >(null);
  const [deleting, setDeleting] = useState<Folder | null>(null);
  const [movingFolder, setMovingFolder] = useState<Folder | null>(null);

  useEffect(() => {
    if (selection !== 'all' && selection !== 'none' && index.byId.has(selection))
      open(revealPath(index, selection));
    // `open` is recreated on every render; the path only depends on the selection and the tree.
  }, [selection, index]);

  const moveFolder = useFolderMutation(
    kind,
    itemsKey,
    (api, input: { id: string; parent: string | null }) =>
      api.update(input.id, { parent_id: input.parent }),
    () => t('folders.moved'),
  );

  const count = (n: number) => n.toLocaleString(locale);

  const dropHandlers = (
    target: string | null,
    key: string,
    accepts: 'any' | 'items' | 'folders',
  ) => ({
    onDragOver: (event: DragEvent) => {
      if (!canWrite) return;
      const types = event.dataTransfer.types;
      const isFolder = types.includes(FOLDER_MIME);
      if (accepts === 'items' && isFolder) return;
      if (accepts === 'folders' && !isFolder) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      if (dropTarget !== key) setDropTarget(key);
    },
    onDragLeave: (event: DragEvent) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      if (dropTarget === key) setDropTarget(null);
    },
    onDrop: (event: DragEvent) => {
      setDropTarget(null);
      const payload = readDrag(event.dataTransfer);
      if (payload === null || !canWrite) return;
      event.preventDefault();
      if (payload.type === 'items') {
        if (accepts !== 'folders') onDropItems(payload.ids, target);
        return;
      }
      if (accepts === 'items' || payload.id === target) return;
      const refused = folderDropError(t, index, payload.id, target, maxDepth);
      if (refused !== null) {
        toast.error(refused);
        return;
      }
      if (canMoveFolder(index, payload.id, target, maxDepth) === 'ok') {
        moveFolder.mutate({ id: payload.id, parent: target });
        if (target !== null) open([target]);
      }
    },
  });

  const rowClass = (active: boolean, dropping: boolean) =>
    cn(
      'group flex h-8 w-full min-w-0 items-center gap-1.5 rounded-md pr-1 text-left text-sm transition-colors',
      'text-(--obsidian-dashboard-shell-text-muted) hover:bg-(--obsidian-dashboard-shell-hover) hover:text-(--obsidian-dashboard-shell-foreground)',
      active &&
        'bg-(--obsidian-dashboard-shell-hover) font-medium text-(--obsidian-dashboard-shell-foreground)',
      dropping &&
        'ring-2 ring-(--obsidian-dashboard-shell-ring) bg-(--obsidian-dashboard-shell-accent)/10',
    );

  const renderNodes = (parentId: string | null): ReactNode =>
    (index.children.get(parentId) ?? []).map((folder) => {
      const children = index.children.get(folder.id) ?? [];
      const isOpen = expanded.has(folder.id);
      const active = selection === folder.id;
      return (
        <li
          key={folder.id}
          role="treeitem"
          aria-expanded={children.length > 0 ? isOpen : undefined}
          aria-selected={active}
        >
          <div
            className={rowClass(active, dropTarget === folder.id)}
            style={{ paddingLeft: `${String((folder.depth - 1) * 14 + 2)}px` }}
            draggable={canWrite}
            onDragStart={(event) => {
              event.dataTransfer.setData(FOLDER_MIME, folder.id);
              event.dataTransfer.effectAllowed = 'move';
            }}
            onDragEnd={() => setDropTarget(null)}
            data-testid={`folder-${folder.name}`}
            {...dropHandlers(folder.id, folder.id, 'any')}
          >
            <button
              type="button"
              className={cn(
                'flex size-5 shrink-0 items-center justify-center rounded',
                children.length === 0 && 'invisible',
              )}
              aria-label={t(isOpen ? 'folders.collapse' : 'folders.expand', { name: folder.name })}
              onClick={() => toggle(folder.id)}
            >
              <ChevronRight
                className={cn('size-3.5 transition-transform', isOpen && 'rotate-90')}
                aria-hidden
              />
            </button>
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1.5"
              onClick={() => onSelect(folder.id)}
            >
              {active ? (
                <FolderOpen className="size-4 shrink-0" aria-hidden />
              ) : (
                <FolderIcon className="size-4 shrink-0" aria-hidden />
              )}
              <span className="truncate">{folder.name}</span>
            </button>
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-(--obsidian-dashboard-shell-text-subtle) group-hover:hidden">
              {count(folder.total_count)}
            </span>
            {canWrite ? (
              <DashboardMenu>
                <DashboardMenuTrigger asChild>
                  <button
                    type="button"
                    className="hidden size-6 shrink-0 items-center justify-center rounded group-hover:flex data-[state=open]:flex"
                    aria-label={t('folders.actions', { name: folder.name })}
                  >
                    <Ellipsis className="size-4" aria-hidden />
                  </button>
                </DashboardMenuTrigger>
                <DashboardMenuContent align="start">
                  <DashboardMenuItem
                    disabled={folder.depth >= maxDepth}
                    onSelect={() => setNaming({ mode: 'create', parent: folder })}
                  >
                    <FolderPlus aria-hidden /> {t('folders.newSub')}
                  </DashboardMenuItem>
                  <DashboardMenuItem onSelect={() => setNaming({ mode: 'rename', folder })}>
                    <Pencil aria-hidden /> {t('folders.rename')}
                  </DashboardMenuItem>
                  <DashboardMenuItem onSelect={() => setMovingFolder(folder)}>
                    <FolderInput aria-hidden /> {t('folders.moveTo')}
                  </DashboardMenuItem>
                  <DashboardMenuSeparator />
                  <DashboardMenuItem
                    className="text-(--obsidian-dashboard-shell-danger) data-[highlighted]:text-(--obsidian-dashboard-shell-danger)"
                    onSelect={() => setDeleting(folder)}
                  >
                    <Trash2 aria-hidden /> {t('folders.delete')}
                  </DashboardMenuItem>
                </DashboardMenuContent>
              </DashboardMenu>
            ) : null}
          </div>
          {children.length > 0 && isOpen ? <ul role="group">{renderNodes(folder.id)}</ul> : null}
        </li>
      );
    });

  return (
    <nav
      className={cn('flex min-h-0 flex-col gap-1', className)}
      aria-label={t('folders.title')}
      data-testid={`folder-panel-${kind}`}
    >
      <div className="flex h-8 items-center justify-between pl-2">
        <span className="text-xs font-medium uppercase tracking-wide text-(--obsidian-dashboard-shell-text-subtle)">
          {t('folders.title')}
        </span>
        {canWrite ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={t('folders.new')}
            title={t('folders.new')}
            onClick={() => setNaming({ mode: 'create', parent: null })}
            data-testid="new-folder"
          >
            <FolderPlus className="size-4" aria-hidden />
          </Button>
        ) : null}
      </div>
      <div
        className={rowClass(selection === 'all', dropTarget === 'all')}
        {...dropHandlers(null, 'all', 'folders')}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 pl-2"
          onClick={() => onSelect('all')}
        >
          <Layers className="size-4 shrink-0" aria-hidden />
          <span className="truncate">{t('folders.all')}</span>
        </button>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-(--obsidian-dashboard-shell-text-subtle)">
          {tree ? count(tree.total_count) : ''}
        </span>
      </div>
      <div
        className={rowClass(selection === 'none', dropTarget === 'none')}
        {...dropHandlers(null, 'none', 'items')}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 pl-2"
          onClick={() => onSelect('none')}
          data-testid="folder-unfiled"
        >
          <Inbox className="size-4 shrink-0" aria-hidden />
          <span className="truncate">{t('folders.unfiled')}</span>
        </button>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-(--obsidian-dashboard-shell-text-subtle)">
          {tree ? count(tree.unfiled_count) : ''}
        </span>
      </div>
      <div className="my-1 h-px bg-(--obsidian-dashboard-shell-border)" />
      {folders.length === 0 ? (
        <p className="px-2 py-1 text-xs text-(--obsidian-dashboard-shell-text-subtle)">
          {t('folders.empty')}
          {canWrite ? <span className="block">{t('folders.dragHint')}</span> : null}
        </p>
      ) : (
        <ul role="tree" aria-label={t('folders.title')} className="min-h-0 overflow-y-auto">
          {renderNodes(null)}
        </ul>
      )}

      {naming !== null ? (
        <FolderNameDialog
          kind={kind}
          itemsKey={itemsKey}
          state={naming}
          onClose={() => setNaming(null)}
          onCreated={(folder) => {
            if (folder.parent_id !== null) open([folder.parent_id]);
          }}
        />
      ) : null}
      {deleting !== null ? (
        <DeleteFolderDialog
          kind={kind}
          itemsKey={itemsKey}
          folder={deleting}
          index={index}
          onClose={() => setDeleting(null)}
          onDeleted={(folder) => {
            if (
              selection !== 'all' &&
              selection !== 'none' &&
              subtreeIds(index, folder.id).has(selection)
            ) {
              onSelect(folder.parent_id ?? 'all');
            }
          }}
        />
      ) : null}
      {movingFolder !== null ? (
        <FolderPickerDialog
          title={t('folders.moveFolderTitle', { name: movingFolder.name })}
          folders={folders}
          rootLabel={t('folders.root')}
          initial={movingFolder.parent_id}
          disabled={(target) =>
            folderDropError(t, index, movingFolder.id, target, maxDepth) !== null
          }
          pending={moveFolder.isPending}
          onClose={() => setMovingFolder(null)}
          onConfirm={(target) => {
            moveFolder.mutate(
              { id: movingFolder.id, parent: target },
              { onSuccess: () => setMovingFolder(null) },
            );
          }}
        />
      ) : null}
    </nav>
  );
}

function FolderNameDialog({
  kind,
  itemsKey,
  state,
  onClose,
  onCreated,
}: {
  kind: FolderKind;
  itemsKey: QueryKey;
  state: { mode: 'create'; parent: Folder | null } | { mode: 'rename'; folder: Folder };
  onClose: () => void;
  onCreated: (folder: Folder) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(state.mode === 'rename' ? state.folder.name : '');
  const save = useFolderMutation(
    kind,
    itemsKey,
    (api, value: string) =>
      state.mode === 'rename'
        ? api.update(state.folder.id, { name: value })
        : api.create({ name: value, parent_id: state.parent?.id ?? null }),
    () => t(state.mode === 'rename' ? 'folders.renamed' : 'folders.created'),
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = name.trim();
    if (value === '') return;
    save.mutate(value, {
      onSuccess: (folder) => {
        if (state.mode === 'create') onCreated(folder);
        onClose();
      },
    });
  };
  const title =
    state.mode === 'rename'
      ? t('folders.rename')
      : state.parent === null
        ? t('folders.new')
        : `${t('folders.newSub')} · ${state.parent.name}`;
  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            aria-label={t('folders.name')}
            placeholder={t('folders.name')}
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            data-testid="folder-name"
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('folders.cancel')}
            </Button>
            <Button type="submit" disabled={name.trim() === '' || save.isPending}>
              {state.mode === 'rename' ? t('folders.save') : t('folders.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteFolderDialog({
  kind,
  itemsKey,
  folder,
  index,
  onClose,
  onDeleted,
}: {
  kind: FolderKind;
  itemsKey: QueryKey;
  folder: Folder;
  index: FolderIndex;
  onClose: () => void;
  onDeleted: (folder: Folder) => void;
}) {
  const { t } = useI18n();
  const subfolders = (index.children.get(folder.id) ?? []).length;
  const empty = subfolders === 0 && folder.item_count === 0;
  const [moveContents, setMoveContents] = useState(false);
  const parentName =
    folder.parent_id === null
      ? t('folders.root')
      : (index.byId.get(folder.parent_id)?.name ?? t('folders.root'));
  const remove = useFolderMutation(
    kind,
    itemsKey,
    (api, mode: 'empty' | 'move_to_parent') => api.remove(folder.id, mode),
    () => t('folders.deleted'),
  );
  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('folders.deleteTitle', { name: folder.name })}</DialogTitle>
          <DialogDescription>
            {empty
              ? t('folders.deleteEmpty')
              : t('folders.deleteNotEmpty', { folders: subfolders, items: folder.item_count })}
          </DialogDescription>
        </DialogHeader>
        {empty ? null : (
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={moveContents}
              onCheckedChange={(value) => setMoveContents(value === true)}
              data-testid="folder-delete-move"
            />
            <span>{t('folders.deleteMoveToParent', { parent: parentName })}</span>
          </label>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('folders.cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={(!empty && !moveContents) || remove.isPending}
            onClick={() =>
              remove.mutate(empty ? 'empty' : 'move_to_parent', {
                onSuccess: () => {
                  onDeleted(folder);
                  onClose();
                },
              })
            }
            data-testid="folder-delete-confirm"
          >
            {t('folders.deleteConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Destination picker: the root (Unfiled / Top level) and every folder, with disabled targets greyed out. */
export function FolderPickerDialog({
  title,
  description,
  folders,
  rootLabel,
  initial,
  disabled,
  pending,
  onClose,
  onConfirm,
}: {
  title: string;
  description?: string;
  folders: readonly Folder[];
  rootLabel: string;
  /** Current location (confirming it again is disabled); undefined when the items are spread over several. */
  initial?: string | null;
  disabled?: (target: string | null) => boolean;
  pending?: boolean;
  onClose: () => void;
  onConfirm: (target: string | null) => void;
}) {
  const { t } = useI18n();
  const [target, setTarget] = useState<string | null | undefined>(initial);
  const option = (id: string | null, label: string, depth: number, icon: ReactNode) => {
    const off = disabled?.(id) === true;
    const active = target === id;
    return (
      <li key={id ?? '__root'}>
        <button
          type="button"
          role="radio"
          aria-checked={active}
          disabled={off}
          className={cn(
            'flex h-8 w-full items-center gap-2 rounded-md pr-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40',
            active && 'bg-primary/10 font-medium text-primary',
          )}
          style={{ paddingLeft: `${String(depth * 14 + 8)}px` }}
          onClick={() => setTarget(id)}
          onDoubleClick={() => (off ? undefined : onConfirm(id))}
        >
          {icon}
          <span className="truncate">{label}</span>
        </button>
      </li>
    );
  };
  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description ?? t('folders.moveDescription')}</DialogDescription>
        </DialogHeader>
        <ul
          role="radiogroup"
          aria-label={title}
          className="max-h-80 overflow-y-auto rounded-md border p-1"
          data-testid="folder-picker"
        >
          {option(null, rootLabel, 0, <Inbox className="size-4 shrink-0" aria-hidden />)}
          {folders.map((folder) =>
            option(
              folder.id,
              folder.name,
              folder.depth,
              <FolderIcon className="size-4 shrink-0" aria-hidden />,
            ),
          )}
        </ul>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('folders.cancel')}
          </Button>
          <Button
            type="button"
            disabled={
              pending === true ||
              target === undefined ||
              target === initial ||
              disabled?.(target) === true
            }
            onClick={() => (target === undefined ? undefined : onConfirm(target))}
            data-testid="folder-picker-confirm"
          >
            {t('folders.moveHere')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
