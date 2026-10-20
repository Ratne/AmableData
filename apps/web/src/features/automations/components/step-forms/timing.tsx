import { useI18n } from '../../../../i18n';
import { ChoiceSelect, DatePicker } from '../../../crm/components/inputs';
import { clean } from '../../lib/clean';
import {
  DurationInput,
  Field,
  SendWindowEditor,
  SwitchRow,
  TimeInput,
  TimeZoneSelect,
} from '../form-bits';
import { DateFieldSelect } from '../goal-panel';
import { DEFAULT_WINDOW, type FormProps } from './shared';

export function DelayForm({ step, onChange, disabled }: FormProps<'delay'>) {
  const { t } = useI18n();
  return (
    <div className="grid gap-3">
      <DurationInput
        value={step.duration}
        disabled={disabled}
        onChange={(duration) => onChange({ ...step, duration })}
      />
      <SwitchRow
        label={t('auto.step.window')}
        checked={step.window !== undefined}
        disabled={disabled}
        onChange={(on) =>
          onChange(clean({ ...step, window: on ? { ...DEFAULT_WINDOW } : undefined }))
        }
      />
      {step.window ? (
        <SendWindowEditor
          value={step.window}
          disabled={disabled}
          onChange={(window) => onChange({ ...step, window })}
        />
      ) : null}
    </div>
  );
}

export function WaitUntilForm({ step, onChange, disabled }: FormProps<'wait_until'>) {
  const { t } = useI18n();
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t('auto.step.date')}>
          <DatePicker
            value={step.date}
            disabled={disabled}
            onChange={(date) => onChange({ ...step, date })}
          />
        </Field>
        <Field label={t('auto.step.time')}>
          <TimeInput
            value={step.time}
            disabled={disabled}
            onChange={(time) => onChange({ ...step, time })}
          />
        </Field>
      </div>
      <Field label={t('auto.step.timeZone')}>
        <TimeZoneSelect
          value={step.time_zone}
          emptyLabel={t('auto.step.contactZone')}
          disabled={disabled}
          onChange={(time_zone) => onChange(clean({ ...step, time_zone }))}
        />
      </Field>
    </div>
  );
}

export function FieldTimerForm({ step, onChange, disabled }: FormProps<'field_timer'>) {
  const { t } = useI18n();
  return (
    <div className="grid gap-3">
      <Field label={t('auto.step.field')}>
        <DateFieldSelect
          value={step.field}
          disabled={disabled}
          onChange={(field) => onChange({ ...step, field })}
        />
      </Field>
      <SwitchRow
        label={t('auto.step.offset')}
        checked={step.offset !== undefined}
        disabled={disabled}
        onChange={(on) =>
          onChange(
            clean({
              ...step,
              offset: on
                ? { amount: 1, unit: 'days' as const, direction: 'before' as const }
                : undefined,
            }),
          )
        }
      />
      {step.offset ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <DurationInput
            value={{ amount: step.offset.amount, unit: step.offset.unit }}
            disabled={disabled}
            onChange={(d) => step.offset && onChange({ ...step, offset: { ...step.offset, ...d } })}
          />
          <ChoiceSelect
            value={step.offset.direction}
            allowEmpty={false}
            disabled={disabled}
            className="w-28"
            choices={[
              { value: 'before', label: t('auto.step.before') },
              { value: 'after', label: t('auto.step.after') },
            ]}
            onChange={(direction) =>
              step.offset &&
              onChange({
                ...step,
                offset: { ...step.offset, direction: direction as 'before' | 'after' },
              })
            }
          />
        </div>
      ) : null}
      <Field label={t('auto.step.time')}>
        <TimeInput
          value={step.time ?? '09:00'}
          disabled={disabled}
          onChange={(time) => onChange({ ...step, time })}
        />
      </Field>
      <SwitchRow
        label={t('auto.step.yearly')}
        checked={step.yearly === true}
        disabled={disabled}
        onChange={(yearly) => onChange(clean({ ...step, yearly: yearly || undefined }))}
      />
      <Field label={t('auto.step.ifMissing')}>
        <ChoiceSelect
          value={step.if_missing ?? 'skip'}
          allowEmpty={false}
          disabled={disabled}
          className="w-full"
          choices={[
            { value: 'skip', label: t('auto.step.ifMissing.skip') },
            { value: 'stop', label: t('auto.step.ifMissing.stop') },
          ]}
          onChange={(v) => onChange({ ...step, if_missing: v as 'skip' | 'stop' })}
        />
      </Field>
      <Field label={t('auto.step.timeZone')}>
        <TimeZoneSelect
          value={step.time_zone}
          emptyLabel={t('auto.step.contactZone')}
          disabled={disabled}
          onChange={(time_zone) => onChange(clean({ ...step, time_zone }))}
        />
      </Field>
    </div>
  );
}
