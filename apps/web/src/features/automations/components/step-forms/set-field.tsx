import { SETTABLE_CONTACT_FIELDS } from '@amable/api-types';
import { Input } from '@amable/ui/ui/input';
import { useI18n } from '../../../../i18n';
import { useCustomFields } from '../../../crm/api/hooks';
import { ChoiceSelect } from '../../../crm/components/inputs';
import { STANDARD_FIELD_LABELS } from '../../../crm/field-catalog';
import { Field, NumberInput, SwitchRow } from '../form-bits';
import type { FormProps } from './shared';

export function SetFieldForm({ step, onChange, disabled }: FormProps<'set_field'>) {
  const { t } = useI18n();
  const custom = useCustomFields('contacts');
  const choices = [
    ...SETTABLE_CONTACT_FIELDS.map((field) => {
      const key = STANDARD_FIELD_LABELS[field];
      return { value: field, label: key ? t(key) : field };
    }),
    ...custom.fields.map((f) => ({ value: `custom.${f.key}`, label: f.label })),
  ];
  const increment = step.mode === 'increment';
  return (
    <div className="grid gap-3">
      <Field label={t('auto.step.field')}>
        <ChoiceSelect
          value={step.field}
          allowEmpty={false}
          disabled={disabled}
          className="w-full"
          choices={choices}
          onChange={(field) => onChange({ ...step, field })}
        />
      </Field>
      <Field label={t('auto.step.mode')}>
        <ChoiceSelect
          value={step.mode ?? 'set'}
          allowEmpty={false}
          disabled={disabled}
          className="w-full"
          choices={[
            { value: 'set', label: t('auto.step.mode.set') },
            { value: 'increment', label: t('auto.step.mode.increment') },
          ]}
          onChange={(mode) =>
            onChange({
              ...step,
              mode: mode as 'set' | 'increment',
              value: mode === 'increment' ? Number(step.value) || 0 : step.value,
            })
          }
        />
      </Field>
      <Field label={t('auto.step.value')}>
        {increment || step.field === 'score_value' ? (
          <NumberInput
            value={typeof step.value === 'number' ? step.value : Number(step.value) || 0}
            disabled={disabled}
            onChange={(n) => onChange({ ...step, value: n ?? 0 })}
          />
        ) : (
          <Input
            value={step.value === null ? '' : String(step.value)}
            disabled={disabled || step.value === null}
            className="h-8"
            onChange={(e) => onChange({ ...step, value: e.target.value })}
          />
        )}
      </Field>
      {!increment ? (
        <SwitchRow
          label={t('auto.step.clear')}
          checked={step.value === null}
          disabled={disabled}
          onChange={(on) => onChange({ ...step, value: on ? null : '' })}
        />
      ) : null}
    </div>
  );
}
