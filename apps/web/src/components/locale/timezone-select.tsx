import { SearchableSelect, type SearchableOption } from '@amable/ui/blocks/searchable-select';
import { useMemo } from 'react';
import { useI18n } from '../../i18n';
import { offsetKeywords, timeZoneLabel, timeZoneOptions } from './timezones';

export interface TimeZoneSelectProps {
  /** IANA id, or '' for none. */
  readonly value: string;
  readonly onChange: (zone: string) => void;
  readonly ariaLabel?: string;
  readonly id?: string;
  readonly disabled?: boolean;
  readonly invalid?: boolean;
  readonly autoFocus?: boolean;
  readonly allowEmpty?: boolean;
  readonly className?: string;
}

/** Every IANA zone grouped by region, labelled with its current UTC offset. */
export function TimeZoneSelect({
  value,
  onChange,
  allowEmpty = true,
  className,
  ...rest
}: TimeZoneSelectProps) {
  const { t, locale } = useI18n();
  const options = useMemo<SearchableOption[]>(() => {
    const now = new Date();
    return timeZoneOptions(now, value || null).map((zone) => {
      // Localized long name ("Ora legale dell'Europa centrale") is searchable too.
      let longName = '';
      try {
        longName =
          new Intl.DateTimeFormat(locale, { timeZone: zone.id, timeZoneName: 'long' })
            .formatToParts(now)
            .find((part) => part.type === 'timeZoneName')?.value ?? '';
      } catch {
        longName = '';
      }
      return {
        value: zone.id,
        label: zone.city,
        hint: zone.offset,
        group: t(`locale.timeZone.region.${zone.region}`),
        keywords: [zone.id, ...offsetKeywords(zone.offsetMinutes), longName],
      };
    });
  }, [locale, t, value]);

  return (
    <SearchableSelect
      {...rest}
      value={value}
      onChange={onChange}
      options={options}
      placeholder={t('locale.timeZone.placeholder')}
      searchPlaceholder={t('locale.timeZone.search')}
      emptyText={t('locale.timeZone.empty')}
      clearLabel={allowEmpty ? t('crm.common.clear') : undefined}
      className={className ?? 'w-full max-w-xs'}
      contentClassName="w-[22rem]"
      renderValue={(selected) =>
        selected ? (
          <span className="truncate">{timeZoneLabel(selected.value)}</span>
        ) : (
          <span className="truncate">{t('locale.timeZone.placeholder')}</span>
        )
      }
    />
  );
}
