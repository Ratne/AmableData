import { isCurrencyCode } from '@amable/api-types';
import { SearchableSelect, type SearchableOption } from '@amable/ui/blocks/searchable-select';
import { useMemo } from 'react';
import { useI18n } from '../../../i18n';
import { currencyOptions } from '../lib/currencies';

const COMMON = ['EUR', 'USD', 'GBP', 'CHF'];

export interface CurrencySelectProps {
  /** ISO 4217 code, or '' for none (only with `allowEmpty`). */
  readonly value: string;
  readonly onChange: (code: string) => void;
  /** Listed first (usually the tenant default currency). */
  readonly defaultCurrency?: string;
  readonly allowEmpty?: boolean;
  readonly id?: string;
  readonly ariaLabel?: string;
  readonly disabled?: boolean;
  readonly invalid?: boolean;
  readonly className?: string;
}

/** Searchable ISO 4217 picker: code, localized name and symbol, searchable by any of them. */
export function CurrencySelect({
  value,
  onChange,
  defaultCurrency,
  allowEmpty = false,
  className,
  invalid,
  ...rest
}: CurrencySelectProps) {
  const { t, locale } = useI18n();
  const options = useMemo<SearchableOption[]>(
    () =>
      currencyOptions(locale, [...(defaultCurrency ? [defaultCurrency] : []), ...COMMON], value).map((c) => ({
        value: c.code,
        label: `${c.code} · ${c.name}`,
        hint: c.symbol === c.code ? undefined : c.symbol,
        keywords: [c.code, c.name, c.symbol],
      })),
    [defaultCurrency, locale, value],
  );
  return (
    <SearchableSelect
      {...rest}
      value={value}
      onChange={onChange}
      options={options}
      invalid={invalid ?? (value !== '' && !isCurrencyCode(value))}
      placeholder={t('commerce.currency.placeholder')}
      searchPlaceholder={t('commerce.currency.search')}
      emptyText={t('commerce.currency.empty')}
      clearLabel={allowEmpty ? t('crm.common.clear') : undefined}
      className={className ?? 'w-full max-w-xs'}
      contentClassName="w-80"
    />
  );
}
