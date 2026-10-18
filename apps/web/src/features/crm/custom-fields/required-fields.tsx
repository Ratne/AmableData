import type {
  CustomField,
  CustomFieldEntityPath,
  CustomFieldLayout,
  CustomFieldValues,
} from '@amable/api-types/crm';
import { Label } from '@amable/ui/ui/label';
import { useMemo, useState } from 'react';
import { useI18n } from '../../../i18n';
import { useCustomFieldLayout } from '../api/hooks';
import { CustomFieldInput } from './field-input';
import { toWidgetValue, validateCustomFieldValue, type WidgetValue } from './validation';

function requiredFieldsOf(layout: CustomFieldLayout | undefined): CustomField[] {
  if (layout === undefined) return [];
  const all = [
    ...layout.tabs.flatMap((tab) => tab.groups.flatMap((group) => group.fields)),
    ...layout.ungrouped,
  ];
  return all.filter((field) => field.required);
}

export interface RequiredCustomFieldsState {
  /** False until the field layout is loaded. */
  readonly ready: boolean;
  readonly fields: readonly CustomField[];
  readonly values: Readonly<Record<string, WidgetValue>>;
  readonly errors: Readonly<Record<string, string>>;
  setValue(key: string, value: WidgetValue): void;
  /** Validated values, or null (errors shown) when one is missing or invalid. */
  collect(): CustomFieldValues | null;
  reset(): void;
}

/**
 * Required custom fields of `entity`, for create dialogs: the API rejects a
 * create that leaves any of them empty.
 */
export function useRequiredCustomFields(entity: CustomFieldEntityPath): RequiredCustomFieldsState {
  const { t } = useI18n();
  const layout = useCustomFieldLayout(entity);
  const fields = useMemo(() => requiredFieldsOf(layout.data), [layout.data]);
  const [values, setValues] = useState<Record<string, WidgetValue>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  return {
    ready: layout.data !== undefined,
    fields,
    values,
    errors,
    setValue(key, value) {
      setValues((prev) => ({ ...prev, [key]: value }));
      setErrors((prev) => {
        const { [key]: _removed, ...rest } = prev;
        return rest;
      });
    },
    collect() {
      const out: CustomFieldValues = {};
      const found: Record<string, string> = {};
      for (const field of fields) {
        const result = validateCustomFieldValue(
          field,
          values[field.key] ?? toWidgetValue(field.type, undefined),
        );
        if (!result.ok) found[field.key] = t(`crm.validation.${result.error}`, result.vars);
        else if (result.value !== null) out[field.key] = result.value;
      }
      setErrors(found);
      return Object.keys(found).length > 0 ? null : out;
    },
    reset() {
      setValues({});
      setErrors({});
    },
  };
}

export function RequiredCustomFields({
  state,
  disabled,
}: {
  state: RequiredCustomFieldsState;
  disabled?: boolean;
}) {
  if (state.fields.length === 0) return null;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {state.fields.map((field) => {
        const error = state.errors[field.key];
        return (
          <div key={field.id} className="grid gap-1.5">
            <Label>
              {field.label} <span aria-hidden>*</span>
            </Label>
            <CustomFieldInput
              field={field}
              value={state.values[field.key] ?? toWidgetValue(field.type, undefined)}
              onChange={(next) => state.setValue(field.key, next)}
              invalid={error !== undefined}
              disabled={disabled}
            />
            {error !== undefined ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
