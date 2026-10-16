import { cn } from '@amable/ui';
import { Badge } from '@amable/ui/ui/badge';
import { Button } from '@amable/ui/ui/button';
import { Calendar } from '@amable/ui/ui/calendar';
import { Checkbox } from '@amable/ui/ui/checkbox';
import { Input } from '@amable/ui/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@amable/ui/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@amable/ui/ui/select';
import { CalendarIcon, ChevronDown, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useI18n } from '../../../i18n';
import { useDirectory } from '../api/hooks';
import { TagPicker } from './tag-picker';

/** Radix Select forbids empty item values: this stands for "no value". */
export const NONE = '__none__';

export interface Choice {
  readonly value: string;
  readonly label: string;
}

export function ChoiceSelect({
  value,
  onChange,
  choices,
  placeholder,
  allowEmpty = true,
  disabled,
  className,
  ariaLabel,
  invalid,
  emptyLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  choices: readonly Choice[];
  /** Label of the "no value" item (default "— None —"). */
  emptyLabel?: string;
  placeholder?: string;
  allowEmpty?: boolean;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  invalid?: boolean;
}) {
  const { t } = useI18n();
  return (
    <Select
      value={value === '' ? NONE : value}
      onValueChange={(next) => onChange(next === NONE ? '' : next)}
      disabled={disabled}
    >
      <SelectTrigger
        size="sm"
        className={cn('min-w-36', className)}
        aria-label={ariaLabel}
        aria-invalid={invalid}
      >
        <SelectValue placeholder={placeholder ?? t('crm.common.select')} />
      </SelectTrigger>
      <SelectContent>
        {allowEmpty ? (
          <SelectItem value={NONE}>{emptyLabel ?? t('crm.common.none')}</SelectItem>
        ) : null}
        {choices.map((choice) => (
          <SelectItem key={choice.value} value={choice.value}>
            {choice.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Multi-select list box in a popover (LIST_BOX, USER_LIST_BOX, tag and "in" pickers). */
export function MultiChoice({
  values,
  onChange,
  choices,
  placeholder,
  disabled,
  ariaLabel,
  searchable = true,
  invalid,
}: {
  values: readonly string[];
  onChange: (values: string[]) => void;
  choices: readonly Choice[];
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  searchable?: boolean;
  invalid?: boolean;
}) {
  const { t } = useI18n();
  const [filter, setFilter] = useState('');
  const selected = new Set(values);
  const labelOf = new Map(choices.map((choice) => [choice.value, choice.label]));
  const visible = choices.filter((choice) =>
    choice.label.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  const toggle = (value: string) =>
    onChange(selected.has(value) ? values.filter((v) => v !== value) : [...values, value]);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          aria-label={ariaLabel}
          aria-invalid={invalid}
          className="h-auto min-h-8 min-w-36 max-w-full justify-between gap-1 px-2 py-1 font-normal"
        >
          <span className="flex min-w-0 flex-wrap gap-1">
            {values.length === 0 ? (
              <span className="text-muted-foreground">{placeholder ?? t('crm.common.select')}</span>
            ) : (
              values.map((value) => (
                <Badge key={value} variant="secondary" className="max-w-40 truncate">
                  {labelOf.get(value) ?? value}
                </Badge>
              ))
            )}
          </span>
          <ChevronDown className="size-3.5 shrink-0 opacity-60" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2" align="start">
        {searchable && choices.length > 6 ? (
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t('crm.common.filter')}
            className="mb-2 h-8"
            aria-label={t('crm.common.filter')}
          />
        ) : null}
        <div role="listbox" aria-multiselectable className="max-h-64 overflow-y-auto">
          {visible.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">{t('crm.common.noOptions')}</p>
          ) : (
            visible.map((choice) => (
              <label
                key={choice.value}
                role="option"
                aria-selected={selected.has(choice.value)}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
              >
                <Checkbox
                  checked={selected.has(choice.value)}
                  onCheckedChange={() => toggle(choice.value)}
                />
                <span className="truncate">{choice.label}</span>
              </label>
            ))
          )}
        </div>
        {values.length > 0 ? (
          <Button variant="ghost" size="sm" className="mt-1 w-full" onClick={() => onChange([])}>
            <X className="size-3.5" aria-hidden /> {t('crm.common.clear')}
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function parseIsoDate(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (match === null) return undefined;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export function isoDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Calendar popover bound to a `YYYY-MM-DD` string. */
export function DatePicker({
  value,
  onChange,
  disabled,
  ariaLabel,
  invalid,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
  invalid?: boolean;
  className?: string;
}) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const selected = parseIsoDate(value);
  const label = selected
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(selected)
    : t('crm.common.pickDate');
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          aria-label={ariaLabel}
          aria-invalid={invalid}
          className={cn('min-w-36 justify-start gap-2 font-normal', className)}
        >
          <CalendarIcon className="size-3.5 opacity-60" aria-hidden />
          <span className={selected ? '' : 'text-muted-foreground'}>{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={selected}
          defaultMonth={selected}
          captionLayout="dropdown"
          startMonth={new Date(1900, 0)}
          endMonth={new Date(2100, 11)}
          onSelect={(date) => {
            onChange(date ? isoDate(date) : '');
            setOpen(false);
          }}
        />
        {value !== '' ? (
          <div className="border-t p-2">
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={() => {
                onChange('');
                setOpen(false);
              }}
            >
              {t('crm.common.clear')}
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function localParts(iso: string): { date: string; time: string } {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return { date: '', time: '' };
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return { date: isoDate(date), time: `${pad(date.getHours())}:${pad(date.getMinutes())}` };
}

/** Local date + time inputs; emits an ISO 8601 UTC string (or '' when cleared). */
export function DateTimePicker({
  value,
  onChange,
  disabled,
  ariaLabel,
  invalid,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
  invalid?: boolean;
}) {
  const parts = localParts(value);
  const [time, setTime] = useState(parts.time || '09:00');
  const emit = (date: string, nextTime: string) => {
    if (date === '') return onChange('');
    const [h = '0', m = '0'] = nextTime.split(':');
    const local = parseIsoDate(date);
    if (local === undefined) return onChange('');
    local.setHours(Number(h), Number(m), 0, 0);
    onChange(local.toISOString());
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <DatePicker
        value={parts.date}
        onChange={(date) => emit(date, time)}
        disabled={disabled}
        ariaLabel={ariaLabel}
        invalid={invalid}
      />
      <Input
        type="time"
        value={parts.time || time}
        disabled={disabled || parts.date === ''}
        onChange={(event) => {
          setTime(event.target.value);
          emit(parts.date, event.target.value);
        }}
        className="h-8 w-28"
        aria-label={ariaLabel ? `${ariaLabel} (time)` : undefined}
      />
    </div>
  );
}

/** Member picker fed by `GET /api/t/:slug/directory`. */
export function UserSelect(props: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
  invalid?: boolean;
  emptyLabel?: string;
}) {
  const { members } = useDirectory();
  const choices = useMemo(() => members.map((m) => ({ value: m.id, label: m.name })), [members]);
  return <ChoiceSelect {...props} choices={choices} />;
}

export function UserMultiSelect(props: {
  values: readonly string[];
  onChange: (values: string[]) => void;
  disabled?: boolean;
  ariaLabel?: string;
  invalid?: boolean;
}) {
  const { members } = useDirectory();
  const choices = useMemo(() => members.map((m) => ({ value: m.id, label: m.name })), [members]);
  return <MultiChoice {...props} choices={choices} />;
}

/** Multi tag picker with server-side search (see `TagPicker`). */
export function TagMultiSelect({
  values,
  allowCreate = true,
  ...rest
}: {
  values: readonly string[];
  onChange: (values: string[]) => void;
  disabled?: boolean;
  ariaLabel?: string;
  placeholder?: string;
  allowCreate?: boolean;
  invalid?: boolean;
  className?: string;
}) {
  return <TagPicker {...rest} value={values} allowCreate={allowCreate} />;
}
