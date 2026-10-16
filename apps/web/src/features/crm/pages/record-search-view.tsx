import type { SavedSearch, SearchQueryInput } from '@amable/api-types/crm';
import {
  cn,
  DashboardButton,
  ListTable,
  PageToolbar,
  type ListTableBulkAction,
  type ListTableColumn,
  type ListTableDeletion,
  type ListTableRowAction,
  type ListTableSort,
} from '@amable/ui';
import { Badge } from '@amable/ui/ui/badge';
import { Checkbox } from '@amable/ui/ui/checkbox';
import { Input } from '@amable/ui/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@amable/ui/ui/popover';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Columns3, SlidersHorizontal } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../../../i18n';
import { listTableLabels } from '../../../lib/labels';
import { QueryBuilder } from '../../search/query-builder';
import {
  countConditions,
  emptyGroup,
  fromFilterGroup,
  tagCondition,
  toFilterGroup,
  type UiGroup,
} from '../../search/query-model';
import { SavedSearchesSidebar } from '../../search/saved-searches';
import { crmKeys, useCrm, useDirectory, useSavedSearches } from '../api/hooks';
import { useTagLookup } from '../components/tag-picker';
import { renderSearchValue, type CellContext } from '../components/cells';
import { ErrorNotice } from '../components/states';
import { useFieldCatalog } from '../field-catalog';

export type SearchRow = Record<string, unknown> & { readonly id: string };

const PAGE_SIZE = 50;
/** Rendered by the name column, never as separate columns. */
const NAME_FIELDS = new Set(['given_name', 'family_name', 'name']);

export interface RecordSearchViewProps {
  readonly entity: 'contact' | 'company';
  /** Columns always fetched (the name cell needs them). */
  readonly requiredColumns: readonly string[];
  readonly defaultColumns: readonly string[];
  readonly nameColumn: {
    readonly header: string;
    readonly sortField: string;
    readonly render: (row: SearchRow) => ReactNode;
  };
  readonly rowLabel: (row: SearchRow) => string;
  readonly onOpen: (row: SearchRow) => void;
  readonly deletion?: ListTableDeletion<SearchRow>;
  readonly bulkActions?: readonly ListTableBulkAction<SearchRow>[];
  readonly rowActions?: (row: SearchRow) => readonly ListTableRowAction<SearchRow>[];
  readonly toolbarActions?: ReactNode;
  readonly initialSavedId?: string;
  /** Starts filtered on contacts having this tag. */
  readonly initialTagId?: string;
  readonly emptyState?: ReactNode;
}

function useStoredColumns(storageKey: string, fallback: readonly string[]) {
  const [columns, setColumns] = useState<string[]>(() => {
    try {
      const stored = window.localStorage.getItem(storageKey);
      const parsed: unknown = stored ? JSON.parse(stored) : null;
      if (Array.isArray(parsed) && parsed.every((c) => typeof c === 'string')) return parsed;
    } catch {
      // ignore unreadable storage
    }
    return [...fallback];
  });
  const update = (next: string[]) => {
    setColumns(next);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // storage full or disabled: the choice still applies to this session
    }
  };
  return [columns, update] as const;
}

/**
 * List of contacts or companies driven by the query builder (`POST /search`):
 * free text, advanced filter tree, saved searches, column chooser (custom
 * fields included), server-side sort and cursor pagination.
 */
export function RecordSearchView(props: RecordSearchViewProps) {
  const { entity } = props;
  const { t, locale } = useI18n();
  const { slug, api } = useCrm();
  const catalog = useFieldCatalog(entity);
  const { nameOf } = useDirectory();
  const savedSearches = useSavedSearches();

  const [q, setQ] = useState('');
  const [root, setRoot] = useState<UiGroup>(() =>
    props.initialTagId
      ? { ...emptyGroup(), conditions: [{ ...tagCondition('any'), tagIds: [props.initialTagId] }] }
      : emptyGroup(),
  );
  const [showFilters, setShowFilters] = useState(props.initialTagId !== undefined);
  const [sort, setSort] = useState<ListTableSort>({ columnId: 'created_at', direction: 'desc' });
  const [columns, setColumns] = useStoredColumns(
    `amb.crm.columns.${entity}.${slug}`,
    props.defaultColumns,
  );
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const filter = useMemo(() => toFilterGroup(root, catalog.kinds), [root, catalog.kinds]);
  const visibleColumns = columns.filter(
    (column) =>
      !NAME_FIELDS.has(column) && (catalog.byField.get(column)?.selectable ?? catalog.isPending),
  );
  const sortField = sort.columnId === '__name' ? props.nameColumn.sortField : sort.columnId;

  const queryKey = JSON.stringify({
    entity,
    ...(q.trim() !== '' ? { q: q.trim() } : {}),
    ...(filter !== undefined ? { filter } : {}),
    columns: [...new Set([...props.requiredColumns, ...visibleColumns])],
    sort: { field: sortField, direction: sort.direction },
  } satisfies SearchQueryInput);

  const [debouncedKey, setDebouncedKey] = useState(queryKey);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedKey(queryKey), 250);
    return () => window.clearTimeout(timer);
  }, [queryKey]);
  // A new query restarts from the first page.
  useEffect(() => {
    setCursors([undefined]);
    setSelectedIds([]);
  }, [debouncedKey]);

  const page = cursors.length - 1;
  const cursor = cursors[page];
  const results = useQuery({
    queryKey: [...crmKeys.search(slug), debouncedKey, cursor ?? ''],
    queryFn: () =>
      api.search.query({
        ...(JSON.parse(debouncedKey) as SearchQueryInput),
        limit: PAGE_SIZE,
        ...(cursor !== undefined ? { cursor } : {}),
        include_total: true,
      }),
    enabled: !catalog.isPending,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const rows = (results.data?.data ?? []) as SearchRow[];
  const total = results.data?.total ?? null;
  const rowTagIds = useMemo(
    () =>
      rows.flatMap((row) => {
        const tags = row['tags'];
        return Array.isArray(tags) ? tags.filter((id): id is string => typeof id === 'string') : [];
      }),
    [rows],
  );
  const { byId: tagsById } = useTagLookup(rowTagIds);

  // Open a saved search passed in the URL (Searches page → contacts).
  const appliedInitial = useRef(false);
  useEffect(() => {
    if (appliedInitial.current || props.initialSavedId === undefined) return;
    const found = savedSearches.data?.find((item) => item.id === props.initialSavedId);
    if (found !== undefined && !catalog.isPending) {
      appliedInitial.current = true;
      loadSaved(found);
    }
  }, [savedSearches.data, props.initialSavedId, catalog.isPending]);

  function loadSaved(saved: SavedSearch | null) {
    setSavedId(saved?.id ?? null);
    if (saved === null) {
      setQ('');
      setRoot(emptyGroup());
      return;
    }
    setQ(saved.query.q ?? '');
    setRoot(fromFilterGroup(saved.query.filter));
    setShowFilters(saved.query.filter !== undefined);
    const savedColumns = (saved.query.columns ?? []).filter((column) => !NAME_FIELDS.has(column));
    if (savedColumns.length > 0) setColumns(savedColumns);
    if (saved.query.sort) {
      setSort({
        columnId:
          saved.query.sort.field === props.nameColumn.sortField ? '__name' : saved.query.sort.field,
        direction: saved.query.sort.direction,
      });
    }
  }

  const cellContext: CellContext = {
    locale,
    nameOf,
    tagsById,
    yes: t('crm.common.yes'),
    no: t('crm.common.no'),
  };
  const tableColumns: ListTableColumn<SearchRow>[] = [
    {
      id: '__name',
      header: props.nameColumn.header,
      cell: props.nameColumn.render,
      sortable: true,
      firstDirection: 'asc',
    },
    ...visibleColumns.map((column, index): ListTableColumn<SearchRow> => {
      const meta = catalog.byField.get(column);
      return {
        id: column,
        header: meta?.label ?? column,
        cell: (row) => renderSearchValue(meta, row[column], cellContext),
        sortable: meta?.sortable ?? false,
        firstDirection: meta?.kind === 'number' || meta?.kind?.startsWith('date') ? 'desc' : 'asc',
        hideBelow: index > 3 ? 'xl' : index > 1 ? 'lg' : undefined,
      };
    }),
  ];

  const selectable = catalog.fields.filter(
    (field) => field.selectable && !NAME_FIELDS.has(field.field),
  );
  const filterCount = countConditions(filter);
  const from = page * PAGE_SIZE + (rows.length > 0 ? 1 : 0);
  const to = page * PAGE_SIZE + rows.length;

  const currentQuery: SearchQueryInput = {
    entity,
    ...(q.trim() !== '' ? { q: q.trim() } : {}),
    ...(filter !== undefined ? { filter } : {}),
    columns: visibleColumns,
    sort: { field: sortField, direction: sort.direction },
  };

  return (
    <div className="flex min-h-0 flex-1">
      <SavedSearchesSidebar
        entity={entity}
        activeId={savedId}
        currentQuery={currentQuery}
        onLoad={loadSaved}
        onSaved={(saved) => setSavedId(saved.id)}
        className="hidden w-56 shrink-0 border-r p-4 lg:flex"
      />
      <div className="flex min-w-0 flex-1 flex-col overflow-x-auto">
        <PageToolbar
          filters={
            <>
              <Input
                type="search"
                value={q}
                onChange={(event) => setQ(event.target.value)}
                placeholder={t('search.quick')}
                aria-label={t('search.quick')}
                className="h-8 w-56"
              />
              <DashboardButton
                variant={showFilters ? 'secondary' : 'ghost'}
                size="sm"
                aria-expanded={showFilters}
                onClick={() => setShowFilters((current) => !current)}
              >
                <SlidersHorizontal className="size-4" aria-hidden />
                {t('search.advanced')}
                {filterCount > 0 ? <Badge variant="secondary">{filterCount}</Badge> : null}
              </DashboardButton>
              <Popover>
                <PopoverTrigger asChild>
                  <DashboardButton variant="ghost" size="sm">
                    <Columns3 className="size-4" aria-hidden />
                    {t('search.columns')}
                  </DashboardButton>
                </PopoverTrigger>
                <PopoverContent align="start" className="max-h-96 w-64 overflow-y-auto p-2">
                  <p className="px-2 pb-1 text-xs text-muted-foreground">
                    {t('search.columnsHint')}
                  </p>
                  {selectable.map((field) => (
                    <label
                      key={field.field}
                      className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
                    >
                      <Checkbox
                        checked={columns.includes(field.field)}
                        onCheckedChange={(checked) =>
                          setColumns(
                            checked === true
                              ? [...columns, field.field]
                              : columns.filter((c) => c !== field.field),
                          )
                        }
                      />
                      <span className="truncate">{field.label}</span>
                      {field.custom ? (
                        <Badge variant="outline" className="ml-auto text-[10px]">
                          {t('search.customBadge')}
                        </Badge>
                      ) : null}
                    </label>
                  ))}
                </PopoverContent>
              </Popover>
            </>
          }
          actions={props.toolbarActions}
        />
        {showFilters ? (
          <div
            className="mx-4 mb-3 rounded-xl border bg-card p-3"
            aria-label={t('search.advanced')}
          >
            <QueryBuilder
              root={root}
              onChange={setRoot}
              fields={catalog.fields}
              allowTags={entity === 'contact'}
            />
          </div>
        ) : null}
        {results.error ? (
          <div className="px-4 pb-3">
            <ErrorNotice error={results.error} />
          </div>
        ) : null}
        <ListTable<SearchRow>
          rows={rows}
          getRowId={(row) => row.id}
          getRowLabel={props.rowLabel}
          columns={tableColumns}
          labels={listTableLabels(t)}
          manualSorting
          sort={sort}
          onSortChange={setSort}
          selectedIds={selectedIds}
          onSelectedIdsChange={setSelectedIds}
          bulkActions={props.bulkActions}
          rowActions={props.rowActions}
          deletion={props.deletion}
          onRowOpen={props.onOpen}
          loading={results.isPending}
          emptyState={props.emptyState}
          className={cn(results.isFetching && !results.isPending && 'opacity-80')}
          footer={
            <div className="flex items-center justify-between gap-2 px-1 py-2 text-xs text-muted-foreground">
              <span aria-live="polite">
                {total !== null
                  ? t('search.range', { from, to, total })
                  : t('search.rangeNoTotal', { from, to })}
              </span>
              <span className="flex gap-1">
                <DashboardButton
                  variant="ghost"
                  size="sm"
                  disabled={page === 0}
                  onClick={() => setCursors((stack) => stack.slice(0, -1))}
                  aria-label={t('search.prevPage')}
                >
                  <ChevronLeft className="size-4" aria-hidden />
                </DashboardButton>
                <DashboardButton
                  variant="ghost"
                  size="sm"
                  disabled={!results.data?.next_cursor}
                  onClick={() => {
                    const next = results.data?.next_cursor;
                    if (next) setCursors((stack) => [...stack, next]);
                  }}
                  aria-label={t('search.nextPage')}
                >
                  <ChevronRight className="size-4" aria-hidden />
                </DashboardButton>
              </span>
            </div>
          }
        />
      </div>
    </div>
  );
}
