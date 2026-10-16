import type { BookingDateOverride, BookingWeeklyRule } from '@amable/api-types';
import { Button } from '@amable/ui/ui/button';
import { Checkbox } from '@amable/ui/ui/checkbox';
import { Input } from '@amable/ui/ui/input';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../../../i18n';

/** Monday first, like the widget. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

function weekdayName(locale: string, weekday: number): string {
  // 2026-10-18 is a Sunday.
  return new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(Date.UTC(2026, 9, 18 + weekday, 12));
}

function TimeInput({ value, onChange, label }: { value: string; onChange: (value: string) => void; label: string }) {
  return (
    <Input
      type="time"
      aria-label={label}
      className="w-28"
      value={value === '24:00' ? '23:59' : value}
      step={300}
      onChange={(e) => onChange(e.target.value === '23:59' ? '24:00' : e.target.value)}
    />
  );
}

/** Weekly working hours: several ranges per weekday. */
export function WeeklyHoursEditor({
  rules,
  onChange,
  disabled,
}: {
  rules: readonly BookingWeeklyRule[];
  onChange: (rules: BookingWeeklyRule[]) => void;
  disabled?: boolean;
}) {
  const { t, locale } = useI18n();
  const update = (index: number, patch: Partial<BookingWeeklyRule>) =>
    onChange(rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));
  return (
    <div className="grid gap-2">
      {WEEK_ORDER.map((weekday) => {
        const entries = rules.map((rule, index) => ({ rule, index })).filter((e) => e.rule.weekday === weekday);
        const open = entries.length > 0;
        return (
          <div key={weekday} className="grid grid-cols-[9rem_1fr] items-start gap-3 border-b pb-2 last:border-b-0">
            <label className="flex items-center gap-2 pt-2 text-sm capitalize">
              <Checkbox
                checked={open}
                disabled={disabled}
                onCheckedChange={(checked) =>
                  onChange(
                    checked === true
                      ? [...rules, { weekday, start: '09:00', end: '17:00' }]
                      : rules.filter((rule) => rule.weekday !== weekday),
                  )
                }
              />
              {weekdayName(locale, weekday)}
            </label>
            <div className="grid gap-1.5">
              {!open ? <p className="pt-2 text-sm text-muted-foreground">{t('booking.hours.unavailable')}</p> : null}
              {entries.map(({ rule, index }) => (
                <div key={index} className="flex items-center gap-2">
                  <TimeInput label={t('booking.hours.from')} value={rule.start} onChange={(start) => update(index, { start })} />
                  <span className="text-muted-foreground">–</span>
                  <TimeInput label={t('booking.hours.to')} value={rule.end} onChange={(end) => update(index, { end })} />
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={t('booking.hours.removeRange')}
                    disabled={disabled}
                    onClick={() => onChange(rules.filter((_, i) => i !== index))}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </div>
              ))}
              {open ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="w-fit"
                  disabled={disabled}
                  onClick={() => onChange([...rules, { weekday, start: entries[entries.length - 1]?.rule.end ?? '13:00', end: '18:00' }])}
                >
                  <Plus aria-hidden /> {t('booking.hours.addRange')}
                </Button>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Date overrides: closed days or custom hours for specific dates. */
export function OverridesEditor({
  overrides,
  onChange,
  disabled,
}: {
  overrides: readonly BookingDateOverride[];
  onChange: (overrides: BookingDateOverride[]) => void;
  disabled?: boolean;
}) {
  const { t, locale } = useI18n();
  const [date, setDate] = useState('');
  const format = new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeZone: 'UTC' });
  const replace = (index: number, next: BookingDateOverride) => onChange(overrides.map((o, i) => (i === index ? next : o)));
  return (
    <div className="grid gap-3">
      {overrides.length === 0 ? <p className="text-sm text-muted-foreground">{t('booking.overrides.empty')}</p> : null}
      {overrides.map((override, index) => (
        <div key={override.date} className="grid gap-2 rounded-lg border p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium capitalize">{format.format(Date.parse(`${override.date}T12:00:00Z`))}</span>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={override.intervals.length === 0}
                  disabled={disabled}
                  onCheckedChange={(checked) =>
                    replace(index, { date: override.date, intervals: checked === true ? [] : [{ start: '09:00', end: '13:00' }] })
                  }
                />
                {t('booking.overrides.closed')}
              </label>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={t('booking.overrides.remove')}
                disabled={disabled}
                onClick={() => onChange(overrides.filter((_, i) => i !== index))}
              >
                <Trash2 aria-hidden />
              </Button>
            </div>
          </div>
          {override.intervals.map((range, rangeIndex) => (
            <div key={rangeIndex} className="flex items-center gap-2">
              <TimeInput
                label={t('booking.hours.from')}
                value={range.start}
                onChange={(start) =>
                  replace(index, { date: override.date, intervals: override.intervals.map((r, i) => (i === rangeIndex ? { ...r, start } : r)) })
                }
              />
              <span className="text-muted-foreground">–</span>
              <TimeInput
                label={t('booking.hours.to')}
                value={range.end}
                onChange={(end) =>
                  replace(index, { date: override.date, intervals: override.intervals.map((r, i) => (i === rangeIndex ? { ...r, end } : r)) })
                }
              />
            </div>
          ))}
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Input type="date" className="w-44" aria-label={t('booking.overrides.date')} value={date} disabled={disabled} onChange={(e) => setDate(e.target.value)} />
        <Button
          type="button"
          variant="outline"
          disabled={disabled || date === '' || overrides.some((o) => o.date === date)}
          onClick={() => {
            onChange([...overrides, { date, intervals: [] }].sort((a, b) => a.date.localeCompare(b.date)));
            setDate('');
          }}
        >
          <Plus aria-hidden /> {t('booking.overrides.add')}
        </Button>
      </div>
    </div>
  );
}
