import type { FolderKind, FolderTree } from '@amable/api-types';
import { cn } from '@amable/ui';
import { Switch } from '@amable/ui/ui/switch';
import type { QueryKey } from '@tanstack/react-query';
import { ChevronRight, GripVertical } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useI18n } from '../../../i18n';
import { useFolderMutation } from '../api';
import { ancestorsOf, indexFolders, ITEMS_MIME, type FolderSelection } from '../lib/tree';
import { FolderPickerDialog } from './folder-panel';

/** "All › Campaigns › 2026" above the list, with the include-subfolders switch for a folder. */
export function FolderBreadcrumb({
  tree,
  selection,
  onSelect,
  includeSubfolders,
  onIncludeSubfoldersChange,
}: {
  tree: FolderTree | undefined;
  selection: FolderSelection;
  onSelect: (selection: FolderSelection) => void;
  includeSubfolders: boolean;
  onIncludeSubfoldersChange: (value: boolean) => void;
}) {
  const { t } = useI18n();
  const index = useMemo(() => indexFolders(tree?.data ?? []), [tree]);
  const chain = selection === 'all' || selection === 'none' ? [] : ancestorsOf(index, selection);
  const isFolder = chain.length > 0;
  if (selection === 'all') return null;
  const crumb = (label: string, target: FolderSelection | null, key: string) => (
    <li key={key} className="flex min-w-0 items-center gap-1">
      {key === 'all' ? null : (
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      )}
      {target === null ? (
        <span className="truncate font-medium" aria-current="page">
          {label}
        </span>
      ) : (
        <button
          type="button"
          className="truncate text-muted-foreground hover:text-foreground hover:underline"
          onClick={() => onSelect(target)}
        >
          {label}
        </button>
      )}
    </li>
  );
  return (
    <div className="flex min-h-8 flex-wrap items-center justify-between gap-2 px-4">
      <nav aria-label={t('folders.breadcrumb')} className="min-w-0">
        <ol
          className="flex min-w-0 flex-wrap items-center gap-1 text-sm"
          data-testid="folder-breadcrumb"
        >
          {crumb(t('folders.all'), selection === 'all' ? null : 'all', 'all')}
          {selection === 'none' ? crumb(t('folders.unfiled'), null, 'none') : null}
          {chain.map((folder, i) =>
            crumb(folder.name, i === chain.length - 1 ? null : folder.id, folder.id),
          )}
        </ol>
      </nav>
      {isFolder ? (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch
            checked={includeSubfolders}
            onCheckedChange={onIncludeSubfoldersChange}
            data-testid="include-subfolders"
          />
          {t('folders.includeSub')}
        </label>
      ) : null}
    </div>
  );
}

/** Wraps a row's main cell so it can be dragged onto a folder (with the whole selection when the row is selected). */
export function DraggableItem({
  ids,
  enabled,
  children,
  className,
}: {
  ids: () => readonly string[];
  enabled: boolean;
  children: ReactNode;
  className?: string;
}) {
  const { t } = useI18n();
  if (!enabled) return <>{children}</>;
  return (
    <span
      draggable
      title={t('folders.dragItems')}
      className={cn(
        'group/drag flex min-w-0 cursor-grab items-center gap-1 active:cursor-grabbing',
        className,
      )}
      onDragStart={(event) => {
        const dragged = ids();
        event.dataTransfer.setData(ITEMS_MIME, JSON.stringify(dragged));
        event.dataTransfer.setData('text/plain', String(dragged.length));
        event.dataTransfer.effectAllowed = 'move';
      }}
    >
      <GripVertical
        className="-ml-1 size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/drag:opacity-100"
        aria-hidden
      />
      {children}
    </span>
  );
}

/** Moves items into a folder (drag & drop or the picker) and toasts where they went. */
export function useMoveItems(kind: FolderKind, itemsKey: QueryKey, tree: FolderTree | undefined) {
  const { t } = useI18n();
  const names = useMemo(() => new Map((tree?.data ?? []).map((f) => [f.id, f.name])), [tree]);
  return useFolderMutation(
    kind,
    itemsKey,
    (api, input: { ids: readonly string[]; folderId: string | null }) =>
      api.moveItems(input.ids, input.folderId),
    (result) => {
      const folder =
        result.folder_id === null ? t('folders.unfiled') : (names.get(result.folder_id) ?? '');
      return result.moved === 1
        ? t('folders.itemsMovedOne', { folder })
        : t('folders.itemsMoved', { n: result.moved, folder });
    },
  );
}

/** "Move to…" for one or many items. */
export function useMoveToDialog(
  kind: FolderKind,
  itemsKey: QueryKey,
  tree: FolderTree | undefined,
) {
  const { t } = useI18n();
  const move = useMoveItems(kind, itemsKey, tree);
  const [state, setState] = useState<{
    ids: string[];
    label: string | null;
    current: string | null | undefined;
  } | null>(null);
  const dialog =
    state === null ? null : (
      <FolderPickerDialog
        title={
          state.ids.length === 1 && state.label !== null
            ? t('folders.moveTitleOne', { name: state.label })
            : t('folders.moveTitle', { n: state.ids.length })
        }
        folders={tree?.data ?? []}
        rootLabel={t('folders.unfiled')}
        initial={state.current}
        pending={move.isPending}
        onClose={() => setState(null)}
        onConfirm={(target) =>
          move.mutate({ ids: state.ids, folderId: target }, { onSuccess: () => setState(null) })
        }
      />
    );
  return {
    move,
    dialog,
    open: (
      items: ReadonlyArray<{ id: string; folder_id: string | null }>,
      label: string | null,
    ) => {
      const folders = new Set(items.map((item) => item.folder_id));
      setState({
        ids: items.map((item) => item.id),
        label: items.length === 1 ? label : null,
        current: folders.size === 1 ? [...folders][0] : undefined,
      });
    },
  };
}
