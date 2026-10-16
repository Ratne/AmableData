import type { AddressSuggestion, AddressSuggestionsResponse } from '@amable/api-types/crm';
import { cn } from '@amable/ui';
import { Input } from '@amable/ui/ui/input';
import { Spinner } from '@amable/ui/ui/spinner';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { MapPin, Search } from 'lucide-react';
import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { useI18n } from '../../../i18n';
import { request } from '../api/client';
import { useCrm } from '../api/hooks';

const MIN_CHARS = 3;
const DEBOUNCE_MS = 350;

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export interface AddressSearchProps {
  /** ISO country the suggestions are restricted to (the address's own, else the tenant default). */
  readonly country?: string | null;
  readonly onPick: (suggestion: AddressSuggestion) => void;
}

/**
 * Free-text address search (`GET /addressSuggestions`) that fills the fields below it.
 * Hidden when the installation turned lookup off; when the geocoder fails the
 * fields stay editable by hand and a hint says so.
 */
export function AddressSearch({ country, onPick }: AddressSearchProps) {
  const { t, locale } = useI18n();
  const { slug } = useCrm();
  const listId = useId();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const q = useDebounced(text.trim(), DEBOUNCE_MS);
  const countryCode = country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : undefined;

  const search = useQuery({
    queryKey: ['crm', slug, 'addressSuggestions', q, locale, countryCode] as const,
    queryFn: ({ signal }) =>
      request<AddressSuggestionsResponse>(
        `/api/v2/t/${encodeURIComponent(slug)}/addressSuggestions`,
        { query: { q, lang: locale, ...(countryCode ? { country: countryCode } : {}) }, signal },
      ),
    enabled: q.length >= MIN_CHARS,
    staleTime: 10 * 60_000,
    retry: false,
    placeholderData: keepPreviousData,
  });

  if (search.data?.enabled === false) return null;

  const suggestions = q.length >= MIN_CHARS ? (search.data?.data ?? []) : [];
  const showList = open && text.trim().length >= MIN_CHARS;

  const pick = (suggestion: AddressSuggestion) => {
    onPick(suggestion);
    setText('');
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Enter in the search box never submits the surrounding address form.
    if (event.key === 'Enter') event.preventDefault();
    if (!showList) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (suggestions.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => (i + step + suggestions.length) % suggestions.length);
    } else if (event.key === 'Enter') {
      const chosen = suggestions[active];
      if (chosen) pick(chosen);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div className="relative col-span-full">
      <Search
        className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        value={text}
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label={t('crm.address.search')}
        placeholder={t('crm.address.search')}
        className="h-8 pl-7"
        autoComplete="off"
        onChange={(e) => {
          setText(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {search.isFetching ? (
        <Spinner className="absolute top-1/2 right-2 size-3.5 -translate-y-1/2" aria-hidden />
      ) : null}
      {showList ? (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-50 mt-1 max-h-64 w-full overflow-auto rounded-md border bg-popover p-1 text-sm shadow-md"
        >
          {search.isError ? (
            <li className="px-2 py-1.5 text-muted-foreground">{t('crm.address.searchUnavailable')}</li>
          ) : suggestions.length === 0 ? (
            <li className="px-2 py-1.5 text-muted-foreground">
              {search.isFetching || q !== text.trim() ? t('crm.address.searching') : t('crm.address.searchEmpty')}
            </li>
          ) : (
            suggestions.map((s, index) => (
              <li
                key={s.label}
                role="option"
                aria-selected={index === active}
                className={cn(
                  'flex cursor-pointer items-start gap-2 rounded-sm px-2 py-1.5',
                  index === active && 'bg-accent text-accent-foreground',
                )}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(s);
                }}
              >
                <MapPin className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span>{s.label}</span>
              </li>
            ))
          )}
          {suggestions.length > 0 && search.data?.provider ? (
            <li aria-hidden className="mt-1 border-t px-2 pt-1 text-right text-[10px] text-muted-foreground">
              {t(search.data.provider === 'mapbox' ? 'crm.address.attributionMapbox' : 'crm.address.attributionOsm')}
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
