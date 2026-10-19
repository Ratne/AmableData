import { cn } from '@amable/ui';
import { searchableFilter } from '@amable/ui/blocks/searchable-select';
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
import { Check, ChevronDown, Plus, X } from 'lucide-react';
import { useMemo, useState, type KeyboardEvent } from 'react';
import { useI18n } from '../../../../i18n';
import type { ValueOption } from '../condition-ui';

const CUSTOM = '__custom__';
/** `ConditionRule.values` / tag lists accept at most this many entries. */
const MAX_VALUES = 200;

export interface ValueSelectProps {
  readonly value: readonly string[];
  readonly onChange: (values: string[]) => void;
  readonly options: readonly ValueOption[];
  /** Accept typed values besides the options. */
  readonly custom?: boolean;
  /** Typed values must be numbers. */
  readonly numeric?: boolean;
  /** One value: picking replaces it and closes. */
  readonly single?: boolean;
  readonly loading?: boolean;
  readonly max?: number;
  readonly maxLength?: number;
  readonly placeholder?: string;
  readonly ariaLabel?: string;
  readonly className?: string;
}

/** Searchable chips picker of the builder panels: known options, backend suggestions and typed values. */
export function ValueSelect({
  value,
  onChange,
  options,
  custom = false,
  numeric = false,
  single = false,
  loading = false,
  max = MAX_VALUES,
  maxLength = 255,
  placeholder,
  ariaLabel,
  className,
}: ValueSelectProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const byValue = useMemo(() => new Map(options.map((o) => [o.value, o])), [options]);
  const selected = new Set(value);
  const full = !single && value.length >= max;
  const labelOf = (v: string) => {
    const option = byValue.get(v);
    return option ? `${option.icon ? `${option.icon} ` : ''}${option.label}` : v;
  };

  const results = useMemo(() => {
    if (query.trim() === '') return options;
    return options
      .map((o) => ({
        o,
        score: searchableFilter(o.value, query, [o.label, ...(o.hint ? [o.hint] : []), ...(o.keywords ?? [])]),
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.o);
  }, [options, query]);

  const typed = query.trim().slice(0, maxLength);
  const typedValid = typed !== '' && (!numeric || Number.isFinite(Number(typed)));
  const exact = options.some(
    (o) => o.value.toLowerCase() === typed.toLowerCase() || o.label.toLowerCase() === typed.toLowerCase(),
  );
  const offerCustom = custom && typedValid && !exact && !selected.has(typed);

  const pick = (v: string) => {
    if (single) {
      onChange([v]);
      setOpen(false);
      setQuery('');
      return;
    }
    if (selected.has(v)) onChange(value.filter((x) => x !== v));
    else if (!full) onChange([...value, v]);
    setQuery('');
  };
  const remove = (v: string) => onChange(value.filter((x) => x !== v));

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace' && query === '' && value.length > 0 && !single) {
      event.preventDefault();
      onChange(value.slice(0, -1));
    }
    if (event.key === 'Escape') {
      event.stopPropagation();
      setOpen(false);
    }
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
            'flex min-h-8 w-full min-w-0 flex-wrap items-center gap-1 rounded-md border border-(--obsidian-dashboard-shell-border) bg-(--obsidian-dashboard-shell-control) px-1.5 py-1 text-xs',
            className,
          )}
        >
          {single
            ? null
            : value.map((v) => (
                <Badge key={v} variant="secondary" className="max-w-full gap-1 pr-0.5 font-normal">
                  <span className="truncate">{labelOf(v)}</span>
                  <button
                    type="button"
                    className="rounded-sm p-0.5 hover:bg-muted-foreground/20"
                    onClick={() => remove(v)}
                    aria-label={t('analytics.funnelBuilder.value.remove', { value: labelOf(v) })}
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                </Badge>
              ))}
          <PopoverTrigger asChild>
            <button
              type="button"
              role="combobox"
              aria-expanded={open}
              aria-label={ariaLabel}
              className={cn(
                'flex min-w-16 flex-1 items-center justify-between gap-1 rounded px-1 py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                !(single && value[0] !== undefined) && 'text-muted-foreground',
              )}
            >
              <span className="truncate">
                {single && value[0] !== undefined
                  ? labelOf(value[0])
                  : value.length === 0
                    ? (placeholder ?? t('analytics.funnelBuilder.value.pick'))
                    : full
                      ? ''
                      : t('analytics.funnelBuilder.value.add')}
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
        <Command shouldFilter={false} loop>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            onKeyDown={onInputKeyDown}
            placeholder={t('analytics.funnelBuilder.value.search')}
            aria-label={t('analytics.funnelBuilder.value.search')}
          />
          <CommandList className="max-h-64">
            {loading ? (
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                <Spinner className="size-3.5" /> {t('analytics.funnelBuilder.value.loading')}
              </div>
            ) : null}
            {!loading && !offerCustom ? (
              <CommandEmpty>
                {custom
                  ? t('analytics.funnelBuilder.value.emptyCustom')
                  : t('analytics.funnelBuilder.value.empty')}
              </CommandEmpty>
            ) : null}
            {offerCustom ? (
              <CommandGroup>
                <CommandItem value={CUSTOM} onSelect={() => pick(typed)} disabled={full}>
                  <Plus className="size-3.5" aria-hidden />
                  <span className="truncate">
                    {t('analytics.funnelBuilder.value.create', { value: typed })}
                  </span>
                </CommandItem>
              </CommandGroup>
            ) : null}
            {results.length > 0 ? (
              <CommandGroup>
                {results.map((option) => {
                  const isSelected = selected.has(option.value);
                  return (
                    <CommandItem
                      key={option.value}
                      value={option.value}
                      onSelect={() => pick(option.value)}
                      disabled={full && !isSelected}
                      data-checked={isSelected}
                    >
                      <Check
                        className={cn('size-3.5', isSelected ? 'opacity-100' : 'opacity-0')}
                        aria-hidden
                      />
                      {option.icon ? <span aria-hidden>{option.icon}</span> : null}
                      <span className="min-w-0 flex-1 truncate">{option.label}</span>
                      {option.hint ? (
                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                          {option.hint}
                        </span>
                      ) : null}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
