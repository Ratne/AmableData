import type { Automation } from '@amable/api-types';
import { cn } from '@amable/ui';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@amable/ui/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@amable/ui/ui/popover';
import { Spinner } from '@amable/ui/ui/spinner';
import { ChevronDown, Folder, Workflow } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../../i18n';
import { useFolderTree } from '../../folders/api';
import { ancestorsOf, indexFolders } from '../../folders/lib/tree';
import { useAutomationSearch } from '../api/contact-tabs';

const SEARCH_DEBOUNCE_MS = 250;

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** "Parent › Child" of the automation folder (empty when unfiled). */
function useFolderPath(): (folderId: string | null) => string {
  const { tree } = useFolderTree('automation');
  const index = useMemo(() => indexFolders(tree.data?.data ?? []), [tree.data]);
  return (folderId) =>
    folderId === null
      ? ''
      : ancestorsOf(index, folderId)
          .map((folder) => folder.name)
          .join(' › ');
}

/**
 * Picks one published automation with a server-side search (debounced,
 * paginated: "load more" or scroll to the end), showing the folder path of
 * each result.
 */
export function AutomationPicker({
  value,
  onChange,
  className,
}: {
  value: Automation | null;
  onChange: (automation: Automation | null) => void;
  className?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query, SEARCH_DEBOUNCE_MS);
  const search = useAutomationSearch(debounced, open);
  const folderPath = useFolderPath();
  const listRef = useRef<HTMLDivElement>(null);
  const results = useMemo(() => search.data?.pages.flatMap((page) => page.data) ?? [], [search.data]);
  const [active, setActive] = useState('');
  const firstId = results[0]?.id ?? '';
  useEffect(() => setActive(firstId), [firstId]);

  const onListScroll = () => {
    const el = listRef.current;
    if (el === null || !search.hasNextPage || search.isFetchingNextPage) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 48) void search.fetchNextPage();
  };

  const selectedPath = value === null ? '' : folderPath(value.folder_id);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label={t('crm.contactAutomations.choose')}
          className={cn(
            'flex h-8 min-w-56 items-center gap-2 rounded-md border border-input bg-transparent px-2.5 text-left text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
            className,
          )}
        >
          <Workflow className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          {value === null ? (
            <span className="flex-1 truncate text-muted-foreground">
              {t('crm.contactAutomations.choose')}
            </span>
          ) : (
            <span className="min-w-0 flex-1 truncate">
              {selectedPath === '' ? null : (
                <span className="text-muted-foreground">{selectedPath} › </span>
              )}
              {value.name}
            </span>
          )}
          <ChevronDown className="size-3.5 shrink-0 opacity-60" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 p-0"
        onKeyDown={(event) => {
          if (event.key === 'Escape') event.stopPropagation();
        }}
      >
        <Command shouldFilter={false} loop value={active} onValueChange={setActive}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={t('crm.contactAutomations.search')}
            aria-label={t('crm.contactAutomations.search')}
          />
          <CommandList ref={listRef} onScroll={onListScroll} className="max-h-72">
            {search.isPending ? (
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                <Spinner className="size-3.5" /> {t('crm.tagPicker.searching')}
              </div>
            ) : (
              <CommandEmpty>
                {debounced.trim() === ''
                  ? t('crm.contactAutomations.noneToAdd')
                  : t('crm.contactAutomations.noMatch')}
              </CommandEmpty>
            )}
            {results.length > 0 ? (
              <CommandGroup>
                {results.map((automation) => {
                  const path = folderPath(automation.folder_id);
                  return (
                    <CommandItem
                      key={automation.id}
                      value={automation.id}
                      onSelect={() => {
                        onChange(automation);
                        setOpen(false);
                      }}
                      data-checked={value?.id === automation.id}
                    >
                      <span className="grid min-w-0 flex-1">
                        <span className="truncate">{automation.name}</span>
                        {path === '' ? null : (
                          <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                            <Folder className="size-3 shrink-0" aria-hidden />
                            <span className="truncate">{path}</span>
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {automation.active_enrollments}
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
