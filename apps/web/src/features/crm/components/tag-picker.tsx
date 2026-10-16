import type { Tag } from '@amable/api-types/crm';
import { cn, toast } from '@amable/ui';
import { Badge } from '@amable/ui/ui/badge';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@amable/ui/ui/command';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@amable/ui/ui/popover';
import { Spinner } from '@amable/ui/ui/spinner';
import {
  keepPreviousData,
  useInfiniteQuery,
  useQueries,
  useQueryClient,
} from '@tanstack/react-query';
import { Check, ChevronDown, Plus, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useI18n } from '../../../i18n';
import { crmKeys, errorMessage, useCrm, usePermissions } from '../api/hooks';
import {
  idBatches,
  shouldOfferCreate,
  TAG_PAGE_SIZE,
  TAG_SEARCH_DEBOUNCE_MS,
  toggleTag,
} from './tag-picker-model';

const STALE_MS = 60_000;

/** Debounced value (search as you type). */
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** Server-side tag search (`GET /tags?q=`), paginated by cursor. */
export function useTagSearch(query: string, enabled: boolean) {
  const { slug, api } = useCrm();
  const q = query.trim();
  return useInfiniteQuery({
    queryKey: [...crmKeys.tags(slug), 'search', q] as const,
    queryFn: ({ pageParam }) =>
      api.tags.list({ limit: TAG_PAGE_SIZE, ...(q === '' ? {} : { q }), cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    enabled,
    staleTime: STALE_MS,
    placeholderData: keepPreviousData,
  });
}

/**
 * Tags by id (`GET /tags?ids=`, 100 per call) for chip labels and lists that
 * show tag names; never loads the whole tag table.
 */
export function useTagLookup(ids: readonly string[]): {
  byId: ReadonlyMap<string, Tag>;
  nameOf: (id: string) => string;
  isPending: boolean;
} {
  const { slug, api } = useCrm();
  const batches = useMemo(() => idBatches([...ids].sort()), [ids]);
  const { tags, isPending } = useQueries({
    queries: batches.map((batch) => ({
      queryKey: [...crmKeys.tags(slug), 'ids', batch.join(',')] as const,
      queryFn: async () => (await api.tags.list({ ids: batch.join(','), limit: batch.length })).data,
      staleTime: STALE_MS,
      placeholderData: keepPreviousData,
    })),
    combine: (results) => ({
      tags: results.flatMap((result) => result.data ?? []),
      isPending: results.some((result) => result.isPending),
    }),
  });
  const byId = useMemo(() => new Map(tags.map((tag) => [tag.id, tag])), [tags]);
  const nameOf = useCallback((id: string) => byId.get(id)?.name ?? id, [byId]);
  return { byId, nameOf, isPending };
}

export interface TagPickerProps {
  /** Selected tag ids (at most one when `multiple` is false). */
  readonly value: readonly string[];
  readonly onChange: (ids: string[]) => void;
  readonly multiple?: boolean;
  /** Offer "Create «name»" (only shown with `tags:write`). Default true. */
  readonly allowCreate?: boolean;
  readonly max?: number;
  readonly placeholder?: string;
  readonly ariaLabel?: string;
  readonly id?: string;
  readonly disabled?: boolean;
  readonly invalid?: boolean;
  readonly className?: string;
}

/**
 * Tag picker for tenants with thousands of tags: search as you type on the
 * server (debounced, paginated, prefix matches first), chips for the
 * selection, keyboard navigation (↑ ↓ Enter, Backspace removes the last chip,
 * Esc closes) and an optional "create" entry.
 */
export function TagPicker({
  value,
  onChange,
  multiple = true,
  allowCreate = true,
  max,
  placeholder,
  ariaLabel,
  id,
  disabled,
  invalid,
  className,
}: TagPickerProps) {
  const { t } = useI18n();
  const { slug, api } = useCrm();
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [known, setKnown] = useState<ReadonlyMap<string, Tag>>(new Map());
  const debounced = useDebounced(query, TAG_SEARCH_DEBOUNCE_MS);
  const search = useTagSearch(debounced, open);
  const lookup = useTagLookup(value);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => search.data?.pages.flatMap((page) => page.data) ?? [], [search.data]);
  const selected = new Set(value);
  const labelOf = (tagId: string) => known.get(tagId)?.name ?? lookup.byId.get(tagId)?.name ?? '…';
  const canCreate =
    allowCreate &&
    can('tags:write') &&
    debounced.trim() === query.trim() &&
    !search.isFetching &&
    shouldOfferCreate(query, results.map((tag) => tag.name));
  const full = multiple && max !== undefined && value.length >= max;
  const firstValue = canCreate ? '__create__' : (results[0]?.id ?? '');
  const [active, setActive] = useState('');
  useEffect(() => setActive(firstValue), [firstValue]);

  const remember = (tag: Tag) =>
    setKnown((prev) => {
      const next = new Map(prev);
      next.set(tag.id, tag);
      return next;
    });

  const pick = (tag: Tag) => {
    remember(tag);
    onChange(toggleTag(value, tag.id, { multiple, ...(max === undefined ? {} : { max }) }));
    if (!multiple) setOpen(false);
  };

  const create = async () => {
    const name = query.trim();
    setCreating(true);
    try {
      const tag = await api.tags.create({ name });
      remember(tag);
      onChange(multiple ? [...value, tag.id] : [tag.id]);
      setQuery('');
      await queryClient.invalidateQueries({ queryKey: crmKeys.tags(slug) });
      toast.success(t('crm.tagPicker.created', { name: tag.name }));
      if (!multiple) setOpen(false);
    } catch (error) {
      toast.error(errorMessage(t, error));
    } finally {
      setCreating(false);
    }
  };

  const remove = (tagId: string) => onChange(value.filter((v) => v !== tagId));

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace' && query === '' && value.length > 0) {
      event.preventDefault();
      onChange(value.slice(0, -1));
    }
    if (event.key === 'Escape') {
      event.stopPropagation();
      setOpen(false);
    }
  };

  const onListScroll = () => {
    const el = listRef.current;
    if (el === null || !search.hasNextPage || search.isFetchingNextPage) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 48) void search.fetchNextPage();
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <PopoverAnchor asChild>
        <div
          className={cn(
            'flex min-h-8 min-w-44 max-w-full flex-wrap items-center gap-1 rounded-md border border-input bg-transparent px-1.5 py-1 text-sm shadow-xs',
            invalid && 'border-destructive',
            disabled && 'pointer-events-none opacity-50',
            className,
          )}
        >
          {value.map((tagId) => (
            <Badge key={tagId} variant="secondary" className="max-w-48 gap-1 pr-0.5">
              <span className="truncate">{labelOf(tagId)}</span>
              <button
                type="button"
                className="rounded-sm p-0.5 hover:bg-muted-foreground/20"
                onClick={() => remove(tagId)}
                aria-label={t('crm.tagPicker.remove', { name: labelOf(tagId) })}
                disabled={disabled}
              >
                <X className="size-3" aria-hidden />
              </button>
            </Badge>
          ))}
          <PopoverTrigger asChild>
            <button
              type="button"
              id={id}
              role="combobox"
              aria-expanded={open}
              aria-label={ariaLabel ?? t('crm.tagPicker.placeholder')}
              aria-invalid={invalid}
              disabled={disabled}
              className="flex min-w-16 flex-1 items-center justify-between gap-1 rounded px-1 py-0.5 text-left text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <span className="truncate">
                {value.length === 0
                  ? (placeholder ?? t('crm.tagPicker.placeholder'))
                  : multiple && !full
                    ? t('crm.tagPicker.add')
                    : ''}
              </span>
              <ChevronDown className="size-3.5 shrink-0 opacity-60" aria-hidden />
            </button>
          </PopoverTrigger>
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        className="w-72 p-0"
        onKeyDown={(event) => {
          if (event.key === 'Escape') event.stopPropagation();
        }}
      >
        <Command shouldFilter={false} loop value={active} onValueChange={setActive}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            onKeyDown={onInputKeyDown}
            placeholder={t('crm.tagPicker.search')}
            aria-label={t('crm.tagPicker.search')}
          />
          <CommandList ref={listRef} onScroll={onListScroll} className="max-h-64">
            {search.isPending ? (
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                <Spinner className="size-3.5" /> {t('crm.tagPicker.searching')}
              </div>
            ) : (
              <CommandEmpty>{t('crm.tagPicker.empty')}</CommandEmpty>
            )}
            {canCreate ? (
              <CommandGroup>
                <CommandItem value="__create__" onSelect={() => void create()} disabled={creating || full}>
                  <Plus className="size-3.5" aria-hidden />
                  <span className="truncate">{t('crm.tagPicker.create', { name: query.trim() })}</span>
                </CommandItem>
              </CommandGroup>
            ) : null}
            {results.length > 0 ? (
              <CommandGroup>
                {results.map((tag) => {
                  const isSelected = selected.has(tag.id);
                  return (
                    <CommandItem
                      key={tag.id}
                      value={tag.id}
                      onSelect={() => pick(tag)}
                      disabled={full && !isSelected}
                      data-checked={isSelected}
                    >
                      <Check className={cn('size-3.5', isSelected ? 'opacity-100' : 'opacity-0')} aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{tag.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {tag.contact_count}
                      </span>
                    </CommandItem>
                  );
                })}
                {search.hasNextPage ? (
                  <CommandItem
                    value="__more__"
                    onSelect={() => void search.fetchNextPage()}
                    className="justify-center text-xs text-muted-foreground"
                  >
                    {search.isFetchingNextPage ? <Spinner className="size-3.5" /> : null}
                    {t('crm.common.loadMore')}
                  </CommandItem>
                ) : null}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** Single-tag variant: `value` is one id or ''. */
export function TagSelect({
  value,
  onChange,
  ...rest
}: Omit<TagPickerProps, 'value' | 'onChange' | 'multiple' | 'max'> & {
  readonly value: string;
  readonly onChange: (id: string) => void;
}) {
  const ids = useMemo(() => (value === '' ? [] : [value]), [value]);
  return <TagPicker {...rest} multiple={false} value={ids} onChange={(next) => onChange(next[0] ?? '')} />;
}
