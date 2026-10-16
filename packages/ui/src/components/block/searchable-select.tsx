import * as React from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';

import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

export interface SearchableOption {
  /** Unique; what `onChange` receives. */
  readonly value: string;
  readonly label: string;
  /** Muted text on the right (offset, dial code, native name…). */
  readonly hint?: string;
  readonly icon?: React.ReactNode;
  /** Extra search terms besides `value`, `label` and `hint`. */
  readonly keywords?: readonly string[];
  /** Heading; groups keep the order of their first option. */
  readonly group?: string;
}

export interface SearchableSelectProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly SearchableOption[];
  readonly placeholder: string;
  readonly searchPlaceholder: string;
  readonly emptyText: string;
  /** Adds a "clear" entry while a value is selected. */
  readonly clearLabel?: string;
  readonly ariaLabel?: string;
  readonly id?: string;
  readonly disabled?: boolean;
  readonly invalid?: boolean;
  readonly autoFocus?: boolean;
  readonly className?: string;
  readonly contentClassName?: string;
  /** Trigger content; defaults to icon + label of the selected option. */
  readonly renderValue?: (selected: SearchableOption | undefined) => React.ReactNode;
}

const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

/**
 * cmdk filter: every search word must occur in value/keywords (`UTC+1`-style
 * words must match a whole keyword so they skip `UTC+10`); options whose label
 * (first keyword) starts with the query rank first.
 */
export function searchableFilter(value: string, search: string, keywords?: string[]): number {
  const words = fold(search).split(/\s+/).filter(Boolean);
  if (words.length === 0) return 1;
  const haystack = fold([value, ...(keywords ?? [])].join(' '));
  const tokens = new Set(haystack.split(/\s+/));
  const hit = words.every((word) =>
    /^(utc|gmt)[+-]/.test(word) ? tokens.has(word) : haystack.includes(word),
  );
  if (!hit) return 0;
  const label = fold(keywords?.[0] ?? value);
  const first = words[0] ?? '';
  if (label.startsWith(first)) return 1;
  if (tokens.has(first)) return 0.9;
  if (label.split(/[\s/(),.-]+/).some((part) => part.startsWith(first))) return 0.8;
  return 0.5;
}

/** Searchable single-choice combobox (Popover + cmdk) for long option lists. */
export function SearchableSelect({
  value,
  onChange,
  options,
  placeholder,
  searchPlaceholder,
  emptyText,
  clearLabel,
  ariaLabel,
  id,
  disabled,
  invalid,
  autoFocus,
  className,
  contentClassName,
  renderValue,
}: SearchableSelectProps) {
  const [open, setOpen] = React.useState(false);
  const listRef = React.useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value);

  const groups = React.useMemo(() => {
    const byGroup = new Map<string, SearchableOption[]>();
    for (const option of options) {
      const key = option.group ?? '';
      const list = byGroup.get(key);
      if (list) list.push(option);
      else byGroup.set(key, [option]);
    }
    return [...byGroup.entries()];
  }, [options]);

  React.useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'center' });
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const choose = (next: string) => {
    onChange(next);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger asChild>
        <Button
          type="button"
          id={id}
          variant="outline"
          size="sm"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          aria-invalid={invalid}
          disabled={disabled}
          autoFocus={autoFocus}
          className={cn('h-8 min-w-0 justify-between gap-2 font-normal', className)}
        >
          <span
            className={cn('flex min-w-0 items-center gap-2', !selected && 'text-muted-foreground')}
          >
            {renderValue ? (
              renderValue(selected)
            ) : selected ? (
              <>
                {selected.icon}
                <span className="truncate">{selected.label}</span>
              </>
            ) : (
              <span className="truncate">{placeholder}</span>
            )}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className={cn('w-80 p-0', contentClassName)}
        onKeyDown={(event) => {
          // Keep Escape from also cancelling an enclosing inline editor.
          if (event.key === 'Escape') event.stopPropagation();
        }}
      >
        <Command defaultValue={value || undefined} filter={searchableFilter}>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList ref={listRef} className="max-h-72">
            <CommandEmpty>{emptyText}</CommandEmpty>
            {clearLabel && value !== '' ? (
              <CommandGroup>
                <CommandItem
                  value="__clear__"
                  keywords={[clearLabel]}
                  onSelect={() => choose('')}
                  className="text-muted-foreground"
                >
                  {clearLabel}
                </CommandItem>
              </CommandGroup>
            ) : null}
            {groups.map(([group, items]) => (
              <CommandGroup key={group} heading={group || undefined}>
                {items.map((option) => (
                  <CommandItem
                    key={option.value}
                    value={option.value}
                    keywords={[
                      option.label,
                      ...(option.hint ? [option.hint] : []),
                      ...(option.keywords ?? []),
                    ]}
                    onSelect={() => choose(option.value)}
                  >
                    {option.icon}
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {option.hint ? (
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {option.hint}
                      </span>
                    ) : null}
                    <Check
                      className={cn(
                        'size-3.5',
                        option.value === value ? 'opacity-100' : 'opacity-0',
                      )}
                      aria-hidden
                    />
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
