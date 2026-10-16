import { ArrowDown, ArrowUp, ChevronsUpDown, Ellipsis, Trash2, X } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  forwardRef,
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type MouseEvent,
  type ReactNode,
} from 'react';
import {
  DashboardButton,
  DashboardConfirmDialog,
  DashboardMenu,
  DashboardMenuContent,
  DashboardMenuItem,
  DashboardMenuSeparator,
  DashboardMenuTrigger,
} from '../components/block/dashboard-shell';
import { cn } from '../lib/utils';

/**
 * The standard list page table (contacts, companies, orders, products,
 * broadcasts, automations, saved reports). Adapted from the ObsidianUI
 * Dashboard Shell table page: multi-select with a floating bulk bar, sortable
 * headers, per-row menu, delete with confirmation and undo.
 *
 * Render it inside `AppShell` (it reads the shell palette variables).
 */

type IconComponent = ComponentType<{
  className?: string;
  'aria-hidden'?: boolean | 'true' | 'false';
}>;

export type SortDirection = 'asc' | 'desc';

export interface ListTableSort {
  readonly columnId: string;
  readonly direction: SortDirection;
}

export interface ListTableColumn<T> {
  readonly id: string;
  readonly header: ReactNode;
  readonly cell: (row: T) => ReactNode;
  /** Shows the sort button. Client-side sorting needs `sortValue` (unless the table is `manualSorting`). */
  readonly sortable?: boolean;
  readonly sortValue?: (row: T) => string | number | Date | null | undefined;
  /** Direction of the first click: text reads A→Z first, numbers and dates newest/biggest first. */
  readonly firstDirection?: SortDirection;
  /** Collapses the column on narrow containers. */
  readonly hideBelow?: 'md' | 'lg' | 'xl' | '2xl';
  readonly align?: 'left' | 'right';
  readonly className?: string;
}

export interface ListTableRowAction<T> {
  readonly id: string;
  readonly label: ReactNode;
  readonly icon?: IconComponent;
  readonly onSelect: (row: T) => void;
  readonly tone?: 'default' | 'danger';
  readonly separatorBefore?: boolean;
}

export interface ListTableBulkAction<T> {
  readonly id: string;
  readonly label: ReactNode;
  readonly icon?: IconComponent;
  readonly onSelect: (rows: T[]) => void | Promise<void>;
  readonly tone?: 'default' | 'danger';
}

export interface ListTableDeletion<T> {
  /** Performs the delete (server-side soft delete). Rows disappear optimistically and come back if this rejects. */
  readonly onDelete: (rows: T[]) => void | Promise<void>;
  /** Restores the rows; when present, the "deleted" toast offers Undo. */
  readonly onUndo?: (rows: T[]) => void | Promise<void>;
  /** Ask before deleting. Default true. */
  readonly confirm?: boolean;
}

export interface ListTableLabels {
  readonly selectAll: string;
  readonly selectRow: (label: string) => string;
  readonly rowActions: (label: string) => string;
  readonly selectedCount: (count: number) => string;
  readonly clearSelection: string;
  readonly delete: string;
  readonly undo: string;
  readonly cancel: string;
  readonly deleted: (count: number, label: string) => string;
  readonly deleteFailed: string;
  readonly confirmDeleteTitle: (count: number, label: string) => string;
  readonly confirmDeleteDescription: (count: number) => string;
  readonly empty: string;
  readonly loading: string;
}

export const DEFAULT_LIST_TABLE_LABELS: ListTableLabels = {
  selectAll: 'Select all rows in view',
  selectRow: (label) => `Select ${label}`,
  rowActions: (label) => `Actions for ${label}`,
  selectedCount: (count) => `${String(count)} selected`,
  clearSelection: 'Clear selection',
  delete: 'Delete',
  undo: 'Undo',
  cancel: 'Cancel',
  deleted: (count, label) => (count === 1 ? `${label} deleted` : `${String(count)} items deleted`),
  deleteFailed: 'Could not delete. Nothing was changed.',
  confirmDeleteTitle: (count, label) =>
    count === 1 ? `Delete ${label}?` : `Delete ${String(count)} items?`,
  confirmDeleteDescription: () => 'You can undo right after.',
  empty: 'Nothing here yet.',
  loading: 'Loading…',
};

export interface ListTableProps<T> {
  readonly rows: readonly T[];
  readonly getRowId: (row: T) => string;
  /** Human name of a row, used in labels and messages. */
  readonly getRowLabel: (row: T) => string;
  readonly columns: readonly ListTableColumn<T>[];

  /** Controlled sort. Omit for internal state. */
  readonly sort?: ListTableSort | null;
  readonly defaultSort?: ListTableSort | null;
  readonly onSortChange?: (sort: ListTableSort) => void;
  /** Rows arrive already sorted (server-side); the table only reports sort changes. */
  readonly manualSorting?: boolean;

  /** Multi-select with checkboxes and the floating bulk bar. Default true. */
  readonly selectable?: boolean;
  readonly selectedIds?: readonly string[];
  readonly onSelectedIdsChange?: (ids: string[]) => void;

  readonly rowActions?:
    readonly ListTableRowAction<T>[] | ((row: T) => readonly ListTableRowAction<T>[]);
  readonly bulkActions?: readonly ListTableBulkAction<T>[];
  /** Adds Delete to the row menu and bulk bar, with confirmation and undo. */
  readonly deletion?: ListTableDeletion<T>;

  /** Row click opens the record; without it a row click toggles selection. */
  readonly onRowOpen?: (row: T) => void;
  readonly loading?: boolean;
  readonly emptyState?: ReactNode;
  /** Below the table: pagination, totals. */
  readonly footer?: ReactNode;
  readonly labels?: Partial<ListTableLabels>;
  readonly className?: string;
}

const EASE_OUT = [0.25, 1, 0.5, 1] as const;
const TOAST_MS = 6000;
const cell = 'px-3 py-2.5 align-middle @lg/table:px-4';
const hideBelowClass = {
  md: 'hidden @md/table:table-cell',
  lg: 'hidden @lg/table:table-cell',
  xl: 'hidden @xl/table:table-cell',
  '2xl': 'hidden @2xl/table:table-cell',
} as const;

type Toast = { readonly id: number; readonly message: string; readonly undo?: () => void };

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

function useControllable<T>(value: T | undefined, initial: T, onChange?: (next: T) => void) {
  const [inner, setInner] = useState(initial);
  const controlled = value !== undefined;
  const set = useCallback(
    (next: T) => {
      if (!controlled) setInner(next);
      onChange?.(next);
    },
    [controlled, onChange],
  );
  return [controlled ? value : inner, set] as const;
}

export function ListTable<T>({
  rows,
  getRowId,
  getRowLabel,
  columns,
  sort: sortProp,
  defaultSort = null,
  onSortChange,
  manualSorting = false,
  selectable = true,
  selectedIds: selectedProp,
  onSelectedIdsChange,
  rowActions,
  bulkActions = [],
  deletion,
  onRowOpen,
  loading = false,
  emptyState,
  footer,
  labels: labelOverrides,
  className,
}: ListTableProps<T>) {
  const labels = { ...DEFAULT_LIST_TABLE_LABELS, ...labelOverrides };
  const reduceMotion = useReducedMotion();
  const [sort, setSort] = useControllable<ListTableSort | null>(
    sortProp,
    defaultSort,
    onSortChange as ((next: ListTableSort | null) => void) | undefined,
  );
  const [selectedIds, setSelectedIds] = useControllable<readonly string[]>(
    selectedProp,
    [],
    onSelectedIdsChange as ((next: readonly string[]) => void) | undefined,
  );
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(() => new Set());
  const [pendingDelete, setPendingDelete] = useState<{ open: boolean; rows: T[] }>({
    open: false,
    rows: [],
  });
  const [toast, setToast] = useState<Toast | null>(null);
  const lastToggled = useRef<number | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const visibleRows = useMemo(() => {
    const shown = rows.filter((row) => !hiddenIds.has(getRowId(row)));
    if (manualSorting || sort === null) return shown;
    const column = columns.find((candidate) => candidate.id === sort.columnId);
    const value = column?.sortValue;
    if (!value) return shown;
    const sorted = [...shown].sort((a, b) => compareValues(value(a), value(b)));
    return sort.direction === 'desc' ? sorted.reverse() : sorted;
  }, [columns, getRowId, hiddenIds, manualSorting, rows, sort]);

  // Selection only acts on rows you can see, so a hidden row is never deleted by surprise.
  const visibleIds = useMemo(() => visibleRows.map(getRowId), [getRowId, visibleRows]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedRows = visibleRows.filter((row) => selectedSet.has(getRowId(row)));
  const allSelected = visibleRows.length > 0 && selectedRows.length === visibleRows.length;

  const toggleRow = (index: number, shiftKey: boolean) => {
    const id = visibleIds[index];
    if (id === undefined) return;
    const next = new Set(selectedIds);
    const selecting = !next.has(id);
    const anchor = lastToggled.current;
    if (shiftKey && anchor !== null && anchor !== index) {
      const [from, to] = anchor < index ? [anchor, index] : [index, anchor];
      visibleIds
        .slice(from, to + 1)
        .forEach((rangeId) => (selecting ? next.add(rangeId) : next.delete(rangeId)));
    } else if (selecting) {
      next.add(id);
    } else {
      next.delete(id);
    }
    lastToggled.current = index;
    setSelectedIds([...next]);
  };

  const toggleAll = () => {
    const visible = new Set(visibleIds);
    setSelectedIds(
      allSelected
        ? selectedIds.filter((id) => !visible.has(id))
        : [...new Set([...selectedIds, ...visibleIds])],
    );
  };

  const onSort = (column: ListTableColumn<T>) => {
    const first = column.firstDirection ?? 'asc';
    const next: ListTableSort =
      sort?.columnId === column.id
        ? { columnId: column.id, direction: sort.direction === 'asc' ? 'desc' : 'asc' }
        : { columnId: column.id, direction: first };
    setSort(next);
  };

  const runDelete = async (targets: T[]) => {
    if (!deletion || targets.length === 0) return;
    const ids = targets.map(getRowId);
    const label = getRowLabel(targets[0] as T);
    setHiddenIds((current) => new Set([...current, ...ids]));
    setSelectedIds(selectedIds.filter((id) => !ids.includes(id)));
    const unhide = () =>
      setHiddenIds((current) => {
        const next = new Set(current);
        ids.forEach((id) => next.delete(id));
        return next;
      });
    try {
      await deletion.onDelete(targets);
    } catch {
      unhide();
      setToast({ id: Date.now(), message: labels.deleteFailed });
      return;
    }
    const onUndo = deletion.onUndo;
    setToast({
      id: Date.now(),
      message: labels.deleted(targets.length, label),
      undo: onUndo
        ? () => {
            setToast(null);
            void Promise.resolve(onUndo(targets)).then(unhide, () =>
              setToast({ id: Date.now(), message: labels.deleteFailed }),
            );
          }
        : undefined,
    });
  };

  const requestDelete = (targets: T[]) => {
    if (!deletion) return;
    if (deletion.confirm === false) void runDelete(targets);
    else setPendingDelete({ open: true, rows: targets });
  };

  const onRowClick = (event: MouseEvent<HTMLTableRowElement>, row: T, index: number) => {
    if ((event.target as HTMLElement).closest("button, a, input, [role='menuitem']")) return;
    if (onRowOpen) onRowOpen(row);
    else if (selectable) toggleRow(index, event.shiftKey);
  };

  const actionsFor = (row: T): readonly ListTableRowAction<T>[] =>
    typeof rowActions === 'function' ? rowActions(row) : (rowActions ?? []);
  const hasRowMenu = rowActions !== undefined || deletion !== undefined;
  const colSpan = columns.length + (selectable ? 1 : 0) + (hasRowMenu ? 1 : 0);

  return (
    <div className={cn('@container/table flex min-h-full flex-col', className)}>
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-y border-(--obsidian-dashboard-shell-border) text-xs text-(--obsidian-dashboard-shell-text-subtle)">
            {selectable && (
              <th scope="col" className="w-10 py-2.5 pr-0 pl-3 @lg/table:pl-4">
                <Checkbox
                  checked={allSelected}
                  indeterminate={selectedRows.length > 0 && !allSelected}
                  onChange={toggleAll}
                  label={labels.selectAll}
                  disabled={visibleRows.length === 0}
                />
              </th>
            )}
            {columns.map((column) => (
              <HeaderCell key={column.id} column={column} sort={sort} onSort={onSort} />
            ))}
            {hasRowMenu && (
              <th scope="col" className="w-10 py-2.5 pr-3 pl-0 @lg/table:pr-4">
                <span className="sr-only">{labels.rowActions('')}</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {loading && visibleRows.length === 0 ? (
            <tr>
              <td
                colSpan={colSpan}
                className="px-4 py-16 text-center text-xs text-(--obsidian-dashboard-shell-text-subtle)"
              >
                {labels.loading}
              </td>
            </tr>
          ) : visibleRows.length === 0 ? (
            <tr>
              <td
                colSpan={colSpan}
                className="px-4 py-16 text-center text-sm text-(--obsidian-dashboard-shell-text-subtle)"
              >
                {emptyState ?? labels.empty}
              </td>
            </tr>
          ) : null}
          <AnimatePresence initial={false}>
            {visibleRows.map((row, index) => {
              const id = getRowId(row);
              const label = getRowLabel(row);
              const isSelected = selectedSet.has(id);
              const actions = actionsFor(row);
              return (
                <motion.tr
                  key={id}
                  layout={reduceMotion ? false : 'position'}
                  initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
                  animate={{ opacity: 1, x: 0, y: 0, filter: 'blur(0px)' }}
                  exit={
                    reduceMotion
                      ? { opacity: 0, transition: { duration: 0 } }
                      : {
                          opacity: 0,
                          x: 28,
                          filter: 'blur(3px)',
                          transition: { duration: 0.22, ease: [0.4, 0, 1, 1] },
                        }
                  }
                  transition={
                    reduceMotion
                      ? { duration: 0 }
                      : {
                          duration: 0.22,
                          ease: EASE_OUT,
                          layout: { type: 'spring', stiffness: 500, damping: 40 },
                        }
                  }
                  data-selected={isSelected}
                  onClick={(event) => onRowClick(event, row, index)}
                  className={cn(
                    'group/row border-b border-(--obsidian-dashboard-shell-border) transition-colors duration-200 last:border-b-0 hover:bg-(--obsidian-dashboard-shell-hover) data-[selected=true]:bg-[color-mix(in_oklab,var(--obsidian-dashboard-shell-accent)_9%,transparent)] motion-reduce:transition-none',
                    (onRowOpen || selectable) && 'cursor-pointer',
                  )}
                >
                  {selectable && (
                    <td className="relative w-10 py-2.5 pr-0 pl-3 align-middle before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:scale-y-0 before:rounded-full before:bg-(--obsidian-dashboard-shell-accent) before:transition-[scale] before:duration-200 before:ease-[cubic-bezier(0.25,1,0.5,1)] group-data-[selected=true]/row:before:scale-y-100 motion-reduce:before:transition-none @lg/table:pl-4">
                      <Checkbox
                        checked={isSelected}
                        onChange={(shiftKey) => toggleRow(index, shiftKey)}
                        label={labels.selectRow(label)}
                      />
                    </td>
                  )}
                  {columns.map((column) => (
                    <td
                      key={column.id}
                      className={cn(
                        cell,
                        column.hideBelow && hideBelowClass[column.hideBelow],
                        column.align === 'right' && 'text-right',
                        column.className,
                      )}
                    >
                      {column.cell(row)}
                    </td>
                  ))}
                  {hasRowMenu && (
                    <td className="w-10 py-2.5 pr-3 pl-0 text-right align-middle @lg/table:pr-4">
                      {actions.length > 0 || deletion ? (
                        <DashboardMenu>
                          <DashboardMenuTrigger asChild>
                            <DashboardButton
                              variant="ghost"
                              size="icon"
                              aria-label={labels.rowActions(label)}
                              className="size-7"
                            >
                              <Ellipsis aria-hidden />
                            </DashboardButton>
                          </DashboardMenuTrigger>
                          <DashboardMenuContent align="end" className="min-w-48">
                            {actions.map((action) => (
                              <Fragment key={action.id}>
                                {action.separatorBefore ? <DashboardMenuSeparator /> : null}
                                <DashboardMenuItem
                                  onSelect={() => action.onSelect(row)}
                                  className={cn(
                                    action.tone === 'danger' &&
                                      'text-(--obsidian-dashboard-shell-danger) data-[highlighted]:text-(--obsidian-dashboard-shell-danger)',
                                  )}
                                >
                                  {action.icon ? <action.icon aria-hidden /> : null}
                                  {action.label}
                                </DashboardMenuItem>
                              </Fragment>
                            ))}
                            {deletion ? (
                              <>
                                {actions.length > 0 ? <DashboardMenuSeparator /> : null}
                                <DashboardMenuItem
                                  onSelect={() => requestDelete([row])}
                                  className="text-(--obsidian-dashboard-shell-danger) data-[highlighted]:text-(--obsidian-dashboard-shell-danger)"
                                >
                                  <Trash2 aria-hidden />
                                  {labels.delete}
                                </DashboardMenuItem>
                              </>
                            ) : null}
                          </DashboardMenuContent>
                        </DashboardMenu>
                      ) : null}
                    </td>
                  )}
                </motion.tr>
              );
            })}
          </AnimatePresence>
        </tbody>
      </table>

      {footer ? <div className="mt-auto">{footer}</div> : null}

      <div className="pointer-events-none sticky bottom-3 z-10 flex flex-col items-center gap-2 px-3 pt-3">
        <AnimatePresence>
          {selectable && selectedRows.length > 0 && (
            <FloatingBar key="selection">
              <span className="px-2 text-xs tabular-nums">
                {labels.selectedCount(selectedRows.length)}
              </span>
              {bulkActions.length > 0 || deletion ? <BarDivider /> : null}
              {bulkActions.map((action) => (
                <DashboardButton
                  key={action.id}
                  variant="ghost"
                  size="sm"
                  className={cn(
                    action.tone === 'danger' &&
                      'text-(--obsidian-dashboard-shell-danger) hover:text-(--obsidian-dashboard-shell-danger)',
                  )}
                  onClick={() => void action.onSelect(selectedRows)}
                >
                  {action.icon ? <action.icon aria-hidden /> : null}
                  {action.label}
                </DashboardButton>
              ))}
              {deletion ? (
                <DashboardButton
                  variant="ghost"
                  size="sm"
                  className="text-(--obsidian-dashboard-shell-danger) hover:text-(--obsidian-dashboard-shell-danger)"
                  onClick={() => requestDelete(selectedRows)}
                >
                  <Trash2 aria-hidden />
                  {labels.delete}
                </DashboardButton>
              ) : null}
              <BarDivider />
              <DashboardButton
                variant="ghost"
                size="icon"
                aria-label={labels.clearSelection}
                onClick={() => setSelectedIds([])}
              >
                <X aria-hidden />
              </DashboardButton>
            </FloatingBar>
          )}
        </AnimatePresence>
        <div role="status" className="flex justify-center">
          <AnimatePresence mode="popLayout">
            {toast && (
              <FloatingBar key={toast.id}>
                <span className="px-2 text-xs">{toast.message}</span>
                {toast.undo ? (
                  <DashboardButton variant="secondary" size="sm" onClick={toast.undo}>
                    {labels.undo}
                  </DashboardButton>
                ) : null}
              </FloatingBar>
            )}
          </AnimatePresence>
        </div>
      </div>

      <DashboardConfirmDialog
        open={pendingDelete.open}
        onOpenChange={(open) => setPendingDelete((current) => ({ ...current, open }))}
        tone="danger"
        title={labels.confirmDeleteTitle(
          pendingDelete.rows.length,
          pendingDelete.rows[0] ? getRowLabel(pendingDelete.rows[0]) : '',
        )}
        description={labels.confirmDeleteDescription(pendingDelete.rows.length)}
        confirmLabel={labels.delete}
        cancelLabel={labels.cancel}
        onConfirm={() => void runDelete(pendingDelete.rows)}
      />
    </div>
  );
}

function HeaderCell<T>({
  column,
  sort,
  onSort,
}: {
  column: ListTableColumn<T>;
  sort: ListTableSort | null;
  onSort: (column: ListTableColumn<T>) => void;
}) {
  const className = cn(
    cell,
    'font-normal',
    column.hideBelow && hideBelowClass[column.hideBelow],
    column.align === 'right' && 'text-right',
  );
  if (!column.sortable) {
    return (
      <th scope="col" className={className}>
        {column.header}
      </th>
    );
  }
  const isActive = sort?.columnId === column.id;
  const ascending = sort?.direction === 'asc';
  const Icon = !isActive ? ChevronsUpDown : ascending ? ArrowUp : ArrowDown;
  return (
    <th
      scope="col"
      aria-sort={isActive ? (ascending ? 'ascending' : 'descending') : undefined}
      className={className}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={cn(
          '-mx-1.5 inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 outline-none transition-colors duration-150 hover:bg-(--obsidian-dashboard-shell-muted) hover:text-(--obsidian-dashboard-shell-foreground) focus-visible:ring-2 focus-visible:ring-(--obsidian-dashboard-shell-ring)',
          isActive && 'text-(--obsidian-dashboard-shell-foreground)',
        )}
      >
        {column.header}
        <Icon aria-hidden className={cn('size-3', !isActive && 'opacity-60')} />
      </button>
    </th>
  );
}

interface CheckboxProps {
  readonly checked: boolean;
  readonly indeterminate?: boolean;
  readonly onChange: (shiftKey: boolean) => void;
  readonly label: string;
  readonly disabled?: boolean;
}

// A native input underneath keeps keyboard, form, and screen reader behavior; the marks on top only draw the state.
const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { checked, indeterminate = false, onChange, label, disabled },
  forwarded,
) {
  const local = useRef<HTMLInputElement | null>(null);
  const shift = useRef(false);
  useEffect(() => {
    if (local.current) local.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <span className="relative grid size-4 place-items-center">
      <input
        ref={(node) => {
          local.current = node;
          if (typeof forwarded === 'function') forwarded(node);
          else if (forwarded) forwarded.current = node;
        }}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onClick={(event) => {
          shift.current = event.shiftKey;
        }}
        onChange={() => onChange(shift.current)}
        aria-label={label}
        className="peer col-start-1 row-start-1 size-4 cursor-pointer appearance-none rounded-[5px] bg-(--obsidian-dashboard-shell-control) shadow-[0_0_0_1px_var(--obsidian-dashboard-shell-border-strong),0_1px_2px_rgb(0_0_0/0.06)] outline-none transition-[background-color,box-shadow,scale] duration-200 ease-[cubic-bezier(0.25,1,0.5,1)] [&:not(:checked,:indeterminate):hover]:shadow-[0_0_0_1px_var(--obsidian-dashboard-shell-ring),0_1px_2px_rgb(0_0_0/0.06)] focus-visible:ring-2 focus-visible:ring-(--obsidian-dashboard-shell-ring) focus-visible:ring-offset-1 focus-visible:ring-offset-(--obsidian-dashboard-shell-background) active:scale-[0.85] active:duration-75 checked:bg-(--obsidian-dashboard-shell-accent) checked:shadow-[0_0_0_1px_var(--obsidian-dashboard-shell-accent),inset_0_1px_0_rgb(255_255_255/0.2)] indeterminate:bg-(--obsidian-dashboard-shell-accent) indeterminate:shadow-[0_0_0_1px_var(--obsidian-dashboard-shell-accent),inset_0_1px_0_rgb(255_255_255/0.2)] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
      />
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        className="pointer-events-none col-start-1 row-start-1 size-4 scale-75 text-(--obsidian-dashboard-shell-accent-foreground) opacity-0 transition-[opacity,scale] duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)] peer-checked:scale-100 peer-checked:opacity-100 motion-reduce:transition-none"
      >
        <path
          d="M4.5 8.25 7 10.5l4.5-5"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span
        aria-hidden
        className="pointer-events-none col-start-1 row-start-1 h-[1.75px] w-2 scale-x-0 rounded-full bg-(--obsidian-dashboard-shell-accent-foreground) transition-[scale] duration-200 ease-[cubic-bezier(0.25,1,0.5,1)] peer-indeterminate:scale-x-100 motion-reduce:transition-none"
      />
    </span>
  );
});

function FloatingBar({ children }: { children: ReactNode }) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      initial={
        reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.97, filter: 'blur(4px)' }
      }
      animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.98, filter: 'blur(2px)' }}
      transition={{ duration: reduceMotion ? 0 : 0.2, ease: EASE_OUT }}
      className="pointer-events-auto flex max-w-full items-center gap-1 overflow-x-auto rounded-xl bg-(--obsidian-dashboard-shell-menu) p-1 text-(--obsidian-dashboard-shell-foreground) shadow-(--obsidian-dashboard-shell-menu-shadow) backdrop-blur-xl backdrop-saturate-150"
    >
      {children}
    </motion.div>
  );
}

function BarDivider() {
  return (
    <span
      aria-hidden
      className="mx-0.5 h-4 w-px shrink-0 bg-(--obsidian-dashboard-shell-border-strong)"
    />
  );
}
