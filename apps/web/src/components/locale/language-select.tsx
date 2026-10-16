import { SearchableSelect, type SearchableOption } from '@amable/ui/blocks/searchable-select';
import { useMemo } from 'react';
import { useI18n } from '../../i18n';
import { languageName, languageOptions } from './languages';

export interface LanguageSelectProps {
  /** ISO 639-1 code (a stored BCP-47 tag is shown as is), or '' for none. */
  readonly value: string;
  readonly onChange: (code: string) => void;
  readonly ariaLabel?: string;
  readonly id?: string;
  readonly disabled?: boolean;
  readonly invalid?: boolean;
  readonly autoFocus?: boolean;
  readonly allowEmpty?: boolean;
  readonly className?: string;
}

/** Every ISO 639-1 language, named in the UI language with its native name alongside. */
export function LanguageSelect({
  value,
  onChange,
  allowEmpty = true,
  className,
  ...rest
}: LanguageSelectProps) {
  const { t, locale } = useI18n();
  const options = useMemo<SearchableOption[]>(
    () =>
      languageOptions(locale, value || null).map((language) => ({
        value: language.code,
        label: language.name,
        hint: language.nativeName || language.code,
        keywords: [language.code, languageName(language.code, 'en')],
      })),
    [locale, value],
  );
  return (
    <SearchableSelect
      {...rest}
      value={value}
      onChange={onChange}
      options={options}
      placeholder={t('locale.language.placeholder')}
      searchPlaceholder={t('locale.language.search')}
      emptyText={t('locale.language.empty')}
      clearLabel={allowEmpty ? t('crm.common.clear') : undefined}
      className={className ?? 'w-full max-w-xs'}
    />
  );
}
