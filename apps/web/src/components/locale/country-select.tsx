import { SearchableSelect, type SearchableOption } from '@amable/ui/blocks/searchable-select';
import { useMemo } from 'react';
import { useI18n } from '../../i18n';
import { flagEmoji, PHONE_COUNTRIES, regionName } from './phone-countries';

export interface CountrySelectProps {
  /** ISO 3166-1 alpha-2, or '' for none. */
  readonly value: string;
  readonly onChange: (code: string) => void;
  readonly ariaLabel?: string;
  readonly disabled?: boolean;
  readonly className?: string;
}

/** Every country with its flag, named in the UI language; searchable by name or ISO code. */
export function CountrySelect({ value, onChange, className, ...rest }: CountrySelectProps) {
  const { t, locale } = useI18n();
  const options = useMemo<SearchableOption[]>(
    () =>
      PHONE_COUNTRIES.map(({ code }) => ({
        value: code,
        label: regionName(code, locale),
        hint: code,
        icon: <span aria-hidden>{flagEmoji(code)}</span>,
        keywords: [code, regionName(code, 'en')],
      })).sort((a, b) => a.label.localeCompare(b.label, locale)),
    [locale],
  );
  return (
    <SearchableSelect
      {...rest}
      value={value}
      onChange={onChange}
      options={options}
      placeholder={t('locale.country.placeholder')}
      searchPlaceholder={t('locale.country.search')}
      emptyText={t('locale.country.empty')}
      clearLabel={t('crm.common.clear')}
      className={className ?? 'w-full'}
    />
  );
}
