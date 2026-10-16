import type { CustomFieldOption, CustomFieldValueInput } from '@amable/api-types/crm';
import type { FieldInputDefinition } from './field-input';
import { monthChoices, weekdayChoices } from './field-input';

export interface DisplayContext {
  readonly locale: string;
  readonly nameOf: (userId: string) => string;
  readonly yes: string;
  readonly no: string;
}

function optionLabel(options: readonly CustomFieldOption[], value: string): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

function drilldownLabels(options: readonly CustomFieldOption[], path: readonly string[]): string[] {
  const labels: string[] = [];
  let level: readonly CustomFieldOption[] = options;
  for (const step of path) {
    const match = level.find((option) => option.value === step);
    labels.push(match?.label ?? step);
    level = (match?.children ?? []) as readonly CustomFieldOption[];
  }
  return labels;
}

/** Read-only text of a custom field value in the UI language. Masked values pass through. */
export function formatCustomValue(
  field: FieldInputDefinition,
  value: CustomFieldValueInput | undefined,
  context: DisplayContext,
): string {
  if (value === undefined || value === null || value === '') return '';
  if (Array.isArray(value) && value.length === 0) return '';
  const { locale } = context;
  const number = typeof value === 'number' ? value : null;
  try {
    switch (field.type) {
      case 'CURRENCY':
        return number === null
          ? String(value)
          : new Intl.NumberFormat(locale, {
              style: 'currency',
              currency: field.config.currency ?? 'EUR',
              maximumFractionDigits: field.config.decimals ?? 2,
            }).format(number);
      case 'PERCENT':
        return number === null
          ? String(value)
          : `${new Intl.NumberFormat(locale, { maximumFractionDigits: field.config.decimals ?? 2 }).format(number)} %`;
      case 'DECIMAL_NUMBER':
      case 'WHOLE_NUMBER':
        return number === null
          ? String(value)
          : new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(number);
      case 'DAY_OF_WEEK':
        return weekdayChoices(locale)[Number(value) - 1]?.label ?? String(value);
      case 'MONTH':
        return monthChoices(locale)[Number(value) - 1]?.label ?? String(value);
      case 'YES_NO':
        return value === true ? context.yes : value === false ? context.no : String(value);
      case 'DATE': {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
        if (match === null) return String(value);
        return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(
          Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
        );
      }
      case 'DATE_TIME': {
        const ms = Date.parse(String(value));
        return Number.isNaN(ms)
          ? String(value)
          : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(ms);
      }
      case 'DROPDOWN':
      case 'RADIO':
        return optionLabel(field.options, String(value));
      case 'LIST_BOX':
        return (Array.isArray(value) ? value : [String(value)])
          .map((item) => optionLabel(field.options, item))
          .join(', ');
      case 'DRILLDOWN':
        return drilldownLabels(
          field.options,
          Array.isArray(value) ? value : String(value).split(' > '),
        ).join(' › ');
      case 'USER':
        return context.nameOf(String(value));
      case 'USER_LIST_BOX':
        return (Array.isArray(value) ? value : [String(value)]).map(context.nameOf).join(', ');
      default:
        return Array.isArray(value) ? value.join(', ') : String(value);
    }
  } catch {
    return String(value);
  }
}

/** A sensitive value the server masked for this member (no `contacts:read_sensitive`). */
export function isMaskedValue(value: CustomFieldValueInput | undefined): boolean {
  return typeof value === 'string' && /^\*{4,}/.test(value);
}
