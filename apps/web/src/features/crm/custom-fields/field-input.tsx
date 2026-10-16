import type { CustomField, CustomFieldOption, CustomFieldType } from '@amable/api-types/crm';
import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { RadioGroup, RadioGroupItem } from '@amable/ui/ui/radio-group';
import { Textarea } from '@amable/ui/ui/textarea';
import { Eye, EyeOff } from 'lucide-react';
import { useId, useState } from 'react';
import { PhoneInput } from '../../../components/locale/phone-input';
import { useI18n } from '../../../i18n';
import {
  ChoiceSelect,
  DatePicker,
  DateTimePicker,
  MultiChoice,
  UserMultiSelect,
  UserSelect,
} from '../components/inputs';
import type { WidgetValue } from './validation';

export type FieldInputDefinition = Pick<
  CustomField,
  'key' | 'label' | 'type' | 'options' | 'config' | 'sensitive'
>;

export interface CustomFieldInputProps {
  readonly field: FieldInputDefinition;
  readonly value: WidgetValue;
  readonly onChange: (value: WidgetValue) => void;
  readonly disabled?: boolean;
  readonly invalid?: boolean;
  readonly autoFocus?: boolean;
}

const asText = (value: WidgetValue): string => (typeof value === 'string' ? value : '');
const asList = (value: WidgetValue): readonly string[] => (Array.isArray(value) ? value : []);

function choicesOf(options: readonly CustomFieldOption[]) {
  return options.map((option) => ({ value: option.value, label: option.label }));
}

/** Monday-first day names / month names in the UI language. */
export function weekdayChoices(locale: string) {
  const format = new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' });
  // 2024-01-01 is a Monday.
  return Array.from({ length: 7 }, (_, index) => ({
    value: String(index + 1),
    label: format.format(Date.UTC(2024, 0, 1 + index)),
  }));
}

export function monthChoices(locale: string) {
  const format = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' });
  return Array.from({ length: 12 }, (_, index) => ({
    value: String(index + 1),
    label: format.format(Date.UTC(2024, index, 1)),
  }));
}

export function currencySymbol(locale: string, currency: string): string {
  try {
    const part = new Intl.NumberFormat(locale, { style: 'currency', currency })
      .formatToParts(0)
      .find((p) => p.type === 'currency');
    return part?.value ?? currency;
  } catch {
    return currency;
  }
}

/** Cascading selects over the DRILLDOWN option tree (1–3 levels). */
function DrilldownInput({ field, value, onChange, disabled, invalid }: CustomFieldInputProps) {
  const path = asList(value);
  const levels: Array<readonly CustomFieldOption[]> = [field.options];
  for (const step of path) {
    const current = levels[levels.length - 1] ?? [];
    const match = current.find((option) => option.value === step);
    const children = (match?.children ?? []) as readonly CustomFieldOption[];
    if (children.length === 0 || levels.length >= 3) break;
    levels.push(children);
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {levels.map((options, depth) => (
        <ChoiceSelect
          key={depth}
          value={path[depth] ?? ''}
          choices={choicesOf(options)}
          disabled={disabled}
          invalid={invalid}
          ariaLabel={`${field.label} ${String(depth + 1)}`}
          onChange={(next) =>
            onChange(next === '' ? path.slice(0, depth) : [...path.slice(0, depth), next])
          }
        />
      ))}
    </div>
  );
}

/** Input with a masked display for sensitive identifiers (SSN / national id). */
function SensitiveInput({
  field,
  value,
  onChange,
  disabled,
  invalid,
  autoFocus,
}: CustomFieldInputProps) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);
  return (
    <div className="flex items-center gap-1">
      <Input
        type={visible ? 'text' : 'password'}
        autoComplete="off"
        value={asText(value)}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        aria-invalid={invalid}
        aria-label={field.label}
        autoFocus={autoFocus}
        placeholder={field.config.format === 'us_ssn' ? 'NNN-NN-NNNN' : undefined}
        className="h-8 font-mono"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8"
        aria-label={visible ? t('crm.field.hide') : t('crm.field.reveal')}
        onClick={() => setVisible((current) => !current)}
      >
        {visible ? (
          <EyeOff className="size-4" aria-hidden />
        ) : (
          <Eye className="size-4" aria-hidden />
        )}
      </Button>
    </div>
  );
}

const INPUT_TYPE: Partial<Record<CustomFieldType, string>> = {
  EMAIL: 'email',
  WEBSITE: 'url',
};

/** One editor per custom field type (24 types). */
export function CustomFieldInput(props: CustomFieldInputProps) {
  const { field, value, onChange, disabled, invalid, autoFocus } = props;
  const { t, locale } = useI18n();
  const radioName = useId();
  const common = {
    disabled,
    'aria-invalid': invalid,
    'aria-label': field.label,
    autoFocus,
  };

  switch (field.type) {
    case 'TEXT':
    case 'NAME':
    case 'EMAIL':
    case 'WEBSITE':
      return (
        <Input
          {...common}
          type={INPUT_TYPE[field.type] ?? 'text'}
          value={asText(value)}
          maxLength={field.config.max_length}
          onChange={(event) => onChange(event.target.value)}
          className="h-8"
        />
      );
    case 'PHONE_NUMBER':
      return (
        <PhoneInput
          value={asText(value)}
          onChange={onChange}
          disabled={disabled}
          invalid={invalid}
          autoFocus={autoFocus}
          ariaLabel={field.label}
          className="max-w-72"
        />
      );
    case 'STATE':
      return (
        <Input
          {...common}
          value={asText(value)}
          placeholder="IT-MI"
          onChange={(event) => onChange(event.target.value.toUpperCase())}
          className="h-8 w-28 uppercase"
        />
      );
    case 'TEXT_AREA':
      return (
        <Textarea
          {...common}
          value={asText(value)}
          maxLength={field.config.max_length}
          rows={4}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    case 'SOCIAL_SECURITY_NUMBER':
      return <SensitiveInput {...props} />;
    case 'CURRENCY':
    case 'DECIMAL_NUMBER':
    case 'PERCENT':
    case 'WHOLE_NUMBER':
    case 'YEAR': {
      const prefix =
        field.type === 'CURRENCY' ? currencySymbol(locale, field.config.currency ?? 'EUR') : null;
      const decimals = field.config.decimals ?? (field.type === 'DECIMAL_NUMBER' ? 6 : 2);
      const integer = field.type === 'WHOLE_NUMBER' || field.type === 'YEAR';
      return (
        <div className="flex items-center gap-1.5">
          {prefix ? <span className="text-sm text-muted-foreground">{prefix}</span> : null}
          <Input
            {...common}
            type="text"
            inputMode={integer ? 'numeric' : 'decimal'}
            value={asText(value)}
            placeholder={
              field.type === 'YEAR' ? 'YYYY' : integer ? '0' : (0).toFixed(Math.min(decimals, 2))
            }
            onChange={(event) => onChange(event.target.value)}
            className="h-8 w-36 tabular-nums"
          />
          {field.type === 'PERCENT' ? (
            <span className="text-sm text-muted-foreground">%</span>
          ) : null}
        </div>
      );
    }
    case 'DAY_OF_WEEK':
      return (
        <ChoiceSelect
          value={asText(value)}
          onChange={onChange}
          choices={weekdayChoices(locale)}
          disabled={disabled}
          invalid={invalid}
          ariaLabel={field.label}
        />
      );
    case 'MONTH':
      return (
        <ChoiceSelect
          value={asText(value)}
          onChange={onChange}
          choices={monthChoices(locale)}
          disabled={disabled}
          invalid={invalid}
          ariaLabel={field.label}
        />
      );
    case 'YES_NO':
      return (
        <ChoiceSelect
          value={value === true ? 'true' : value === false ? 'false' : asText(value)}
          onChange={(next) => onChange(next === '' ? null : next === 'true')}
          choices={[
            { value: 'true', label: t('crm.common.yes') },
            { value: 'false', label: t('crm.common.no') },
          ]}
          disabled={disabled}
          invalid={invalid}
          ariaLabel={field.label}
        />
      );
    case 'DATE':
      return (
        <DatePicker
          value={asText(value)}
          onChange={onChange}
          disabled={disabled}
          invalid={invalid}
          ariaLabel={field.label}
        />
      );
    case 'DATE_TIME':
      return (
        <DateTimePicker
          value={asText(value)}
          onChange={onChange}
          disabled={disabled}
          invalid={invalid}
          ariaLabel={field.label}
        />
      );
    case 'DROPDOWN':
      return (
        <ChoiceSelect
          value={asText(value)}
          onChange={onChange}
          choices={choicesOf(field.options)}
          disabled={disabled}
          invalid={invalid}
          ariaLabel={field.label}
        />
      );
    case 'RADIO':
      return (
        <RadioGroup
          value={asText(value)}
          onValueChange={onChange}
          disabled={disabled}
          aria-label={field.label}
          aria-invalid={invalid}
          className="flex flex-wrap gap-x-4 gap-y-2"
        >
          {field.options.map((option) => {
            const id = `${radioName}-${option.value}`;
            return (
              <label key={option.value} htmlFor={id} className="flex items-center gap-1.5 text-sm">
                <RadioGroupItem id={id} value={option.value} />
                {option.label}
              </label>
            );
          })}
        </RadioGroup>
      );
    case 'LIST_BOX':
      return (
        <MultiChoice
          values={asList(value)}
          onChange={onChange}
          choices={choicesOf(field.options)}
          disabled={disabled}
          invalid={invalid}
          ariaLabel={field.label}
        />
      );
    case 'USER':
      return (
        <UserSelect
          value={asText(value)}
          onChange={onChange}
          disabled={disabled}
          invalid={invalid}
          ariaLabel={field.label}
        />
      );
    case 'USER_LIST_BOX':
      return (
        <UserMultiSelect
          values={asList(value)}
          onChange={onChange}
          disabled={disabled}
          invalid={invalid}
          ariaLabel={field.label}
        />
      );
    case 'DRILLDOWN':
      return <DrilldownInput {...props} />;
  }
}
