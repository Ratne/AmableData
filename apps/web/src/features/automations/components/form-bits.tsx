import type { Duration, SendWindow } from '@amable/api-types';
import { cn } from '@amable/ui';
import { Input } from '@amable/ui/ui/input';
import { Label } from '@amable/ui/ui/label';
import { Switch } from '@amable/ui/ui/switch';
import { Toggle } from '@amable/ui/ui/toggle';
import { useId, useMemo, type ReactNode } from 'react';
import { useI18n } from '../../../i18n';
import { ChoiceSelect, MultiChoice, type Choice } from '../../crm/components/inputs';
import { useReferences } from '../api/hooks';

/** Small form building blocks shared by the goal, step, settings and decision editors. */

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
      {children}
      {hint ? <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function SwitchRow({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-3">
      <Label htmlFor={id} className="text-sm font-normal">
        {label}
      </Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

/** Integer input that keeps empty text while typing (`null` = empty). */
export function NumberInput({
  value,
  onChange,
  min,
  max,
  className,
  ariaLabel,
  disabled,
  placeholder,
}: {
  value: number | null | undefined;
  onChange: (value: number | null) => void;
  min?: number;
  max?: number;
  className?: string;
  ariaLabel?: string;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <Input
      type="number"
      inputMode="numeric"
      value={value === null || value === undefined ? '' : String(value)}
      min={min}
      max={max}
      disabled={disabled}
      placeholder={placeholder}
      aria-label={ariaLabel}
      className={cn('h-8', className)}
      onChange={(event) => {
        const text = event.target.value;
        if (text === '') return onChange(null);
        const n = Math.trunc(Number(text));
        if (Number.isFinite(n)) onChange(n);
      }}
    />
  );
}

export function DurationInput({
  value,
  onChange,
  disabled,
}: {
  value: Duration;
  onChange: (value: Duration) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-1.5">
      <NumberInput
        value={value.amount}
        min={0}
        className="w-20"
        ariaLabel={t('auto.step.amount')}
        disabled={disabled}
        onChange={(amount) => onChange({ ...value, amount: Math.max(0, amount ?? 0) })}
      />
      <ChoiceSelect
        value={value.unit}
        allowEmpty={false}
        disabled={disabled}
        ariaLabel={t('auto.step.unit')}
        className="w-32"
        choices={(['minutes', 'hours', 'days', 'weeks'] as const).map((unit) => ({
          value: unit,
          label: t(`auto.unit.${unit}`),
        }))}
        onChange={(unit) => onChange({ ...value, unit: unit as Duration['unit'] })}
      />
    </div>
  );
}

export function TimeInput({
  value,
  onChange,
  ariaLabel,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  return (
    <Input
      type="time"
      value={value}
      step={60}
      disabled={disabled}
      aria-label={ariaLabel}
      className="h-8 w-28"
      onChange={(event) => onChange(event.target.value.slice(0, 5))}
    />
  );
}

let zoneCache: string[] | null = null;
function timeZones(): string[] {
  zoneCache ??=
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['UTC'];
  return zoneCache;
}

/** IANA zone picker; empty value = the documented fallback (`emptyLabel`). */
export function TimeZoneSelect({
  value,
  onChange,
  emptyLabel,
  disabled,
}: {
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  emptyLabel: string;
  disabled?: boolean;
}) {
  const listId = useId();
  const zones = useMemo(() => ['tenant', ...timeZones()], []);
  return (
    <>
      <Input
        list={listId}
        value={value ?? ''}
        placeholder={emptyLabel}
        disabled={disabled}
        className="h-8"
        onChange={(event) => {
          const next = event.target.value.trim();
          onChange(next === '' ? undefined : next);
        }}
      />
      <datalist id={listId}>
        {zones.map((zone) => (
          <option key={zone} value={zone} />
        ))}
      </datalist>
    </>
  );
}

export function SendWindowEditor({
  value,
  onChange,
  disabled,
}: {
  value: SendWindow;
  onChange: (value: SendWindow) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const days = value.days ?? [1, 2, 3, 4, 5, 6, 7];
  return (
    <div className="grid gap-2 rounded-md border border-dashed p-2">
      <div className="flex flex-wrap gap-1" role="group" aria-label={t('auto.step.days')}>
        {[1, 2, 3, 4, 5, 6, 7].map((day) => (
          <Toggle
            key={day}
            size="sm"
            variant="outline"
            disabled={disabled}
            pressed={days.includes(day)}
            className="h-7 px-2 text-xs"
            onPressedChange={(pressed) => {
              const next = pressed ? [...days, day].sort() : days.filter((d) => d !== day);
              if (next.length === 0) return;
              const { days: _ignored, ...rest } = value;
              onChange(next.length === 7 ? rest : { ...rest, days: next });
            }}
          >
            {t(`auto.day.${day}` as 'auto.day.1')}
          </Toggle>
        ))}
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {t('auto.step.from')}
        <TimeInput
          value={value.start}
          disabled={disabled}
          ariaLabel={t('auto.step.from')}
          onChange={(start) => onChange({ ...value, start })}
        />
        {t('auto.step.to')}
        <TimeInput
          value={value.end}
          disabled={disabled}
          ariaLabel={t('auto.step.to')}
          onChange={(end) => onChange({ ...value, end })}
        />
      </div>
    </div>
  );
}

function splitIds(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/**
 * Multi picker over another module's list endpoint; falls back to a free
 * text list of ids when the endpoint does not exist (module not installed).
 */
export function ReferenceMultiPicker({
  path,
  values,
  onChange,
  placeholder,
  disabled,
}: {
  path: string;
  values: readonly string[];
  onChange: (values: string[]) => void;
  placeholder: string;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const refs = useReferences(path);
  if (refs.data === null || refs.isError) {
    return (
      <Input
        value={values.join(', ')}
        placeholder={t('auto.goal.idsHint')}
        disabled={disabled}
        className="h-8"
        onChange={(event) => onChange(splitIds(event.target.value))}
      />
    );
  }
  const choices: Choice[] = (refs.data ?? []).map((ref) => ({ value: ref.id, label: ref.name }));
  return (
    <MultiChoice
      values={values}
      choices={choices}
      placeholder={placeholder}
      disabled={disabled}
      onChange={onChange}
    />
  );
}

export function ReferenceSelect({
  path,
  value,
  onChange,
  placeholder,
  allowEmpty = true,
  disabled,
}: {
  path: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  allowEmpty?: boolean;
  disabled?: boolean;
}) {
  const refs = useReferences(path);
  if (refs.data === null || refs.isError) {
    return (
      <Input
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        className="h-8"
        onChange={(e) => onChange(e.target.value.trim())}
      />
    );
  }
  return (
    <ChoiceSelect
      value={value}
      allowEmpty={allowEmpty}
      placeholder={placeholder}
      disabled={disabled}
      className="w-full"
      choices={(refs.data ?? []).map((ref) => ({ value: ref.id, label: ref.name }))}
      onChange={onChange}
    />
  );
}
