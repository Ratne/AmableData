import { cn } from '@amable/ui';
import { SearchableSelect, type SearchableOption } from '@amable/ui/blocks/searchable-select';
import { Input } from '@amable/ui/ui/input';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import {
  PHONE_COUNTRIES,
  composeE164,
  defaultPhoneCountry,
  flagEmoji,
  formatDial,
  parsePhone,
  primaryDial,
  regionName,
} from './phone-countries';

/** Dialling country preselected for new numbers (UI language + browser region). */
export function useDefaultPhoneCountry(): string {
  const { locale } = useI18n();
  return useMemo(() => {
    const languages =
      typeof navigator === 'undefined'
        ? []
        : navigator.languages?.length
          ? navigator.languages
          : [navigator.language];
    return defaultPhoneCountry(locale, languages);
  }, [locale]);
}

export interface PhoneInputProps {
  /** E.164 (`+393331234567`); legacy values without `+` use `defaultCountry`. */
  readonly value: string;
  readonly onChange: (e164: string) => void;
  readonly defaultCountry?: string;
  readonly ariaLabel?: string;
  readonly id?: string;
  readonly disabled?: boolean;
  readonly invalid?: boolean;
  readonly autoFocus?: boolean;
  readonly className?: string;
  readonly inputClassName?: string;
}

/** Calling-code picker (flag + prefix, searchable by country or code) and the national number. */
export function PhoneInput({
  value,
  onChange,
  defaultCountry,
  ariaLabel,
  id,
  disabled,
  invalid,
  autoFocus,
  className,
  inputClassName,
}: PhoneInputProps) {
  const { t, locale } = useI18n();
  const localDefault = useDefaultPhoneCountry();
  const fallback = defaultCountry ?? localDefault;
  const [country, setCountry] = useState(() => parsePhone(value, fallback).country);
  const [national, setNational] = useState(() => parsePhone(value, fallback).national);
  const emitted = useRef(value);

  useEffect(() => {
    if (value === emitted.current) return;
    emitted.current = value;
    const parsed = parsePhone(value, fallback);
    setCountry(parsed.country);
    setNational(parsed.national);
  }, [value, fallback]);

  const emit = (nextCountry: string, nextNational: string) => {
    setCountry(nextCountry);
    setNational(nextNational);
    const next = composeE164(nextCountry, nextNational);
    emitted.current = next;
    onChange(next);
  };

  const options = useMemo<SearchableOption[]>(() => {
    const collator = new Intl.Collator(locale);
    return PHONE_COUNTRIES.map((entry) => ({
      value: entry.code,
      label: regionName(entry.code, locale),
      hint: formatDial(entry.dials[0] ?? ''),
      icon: (
        <span aria-hidden className="text-base leading-none">
          {flagEmoji(entry.code)}
        </span>
      ),
      keywords: [
        entry.code,
        regionName(entry.code, 'en'),
        ...entry.dials.flatMap((dial) => [dial, `+${dial}`]),
      ],
    })).sort((a, b) => collator.compare(a.label, b.label));
  }, [locale]);

  return (
    <div className={cn('flex min-w-0 items-center gap-1.5', className)}>
      <SearchableSelect
        value={country}
        onChange={(next) => {
          if (next !== '') emit(next, national);
        }}
        options={options}
        ariaLabel={t('locale.phone.country')}
        placeholder={t('locale.phone.country')}
        searchPlaceholder={t('locale.phone.search')}
        emptyText={t('locale.phone.empty')}
        disabled={disabled}
        invalid={invalid}
        className="w-auto shrink-0 px-2"
        renderValue={() => (
          <>
            <span aria-hidden className="text-base leading-none">
              {flagEmoji(country)}
            </span>
            <span className="tabular-nums">{formatDial(primaryDial(country))}</span>
          </>
        )}
      />
      <Input
        id={id}
        type="tel"
        inputMode="tel"
        autoComplete="tel-national"
        value={national}
        aria-label={ariaLabel ?? t('locale.phone.number')}
        aria-invalid={invalid}
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder={t('locale.phone.number')}
        className={cn('h-8 min-w-28 flex-1', inputClassName)}
        onChange={(event) => {
          const text = event.target.value;
          const trimmed = text.trim();
          if (trimmed.startsWith('+') || trimmed.startsWith('00')) {
            const parsed = parsePhone(trimmed, country);
            emit(parsed.country, parsed.national);
          } else {
            emit(country, text.replace(/[^\d\s().-]/g, ''));
          }
        }}
      />
    </div>
  );
}
