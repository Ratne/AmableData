import { cn } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { Label } from '@amable/ui/ui/label';
import { Switch } from '@amable/ui/ui/switch';
import { Plus, X } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useI18n } from '../../../../i18n';

/** Form building blocks of the builder side panels. */

export const selectClass =
  'h-8 w-full rounded-md border border-(--obsidian-dashboard-shell-border) bg-(--obsidian-dashboard-shell-control) px-2 text-xs text-foreground outline-none';

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
  hint,
  checked,
  onChange,
}: {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="grid gap-1">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={id} className="text-xs font-medium">
          {label}
        </Label>
        <Switch id={id} checked={checked} onCheckedChange={onChange} />
      </div>
      {hint ? <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** Text kept locally while typing; `parse` returns null for values not committed yet. */
function useDraftText<T>(value: T, format: (v: T) => string, parse: (raw: string) => T | null) {
  const [raw, setRaw] = useState(() => format(value));
  const formatted = format(value);
  useEffect(() => {
    setRaw((current) => {
      const parsed = parse(current);
      return parsed !== null && format(parsed) === formatted ? current : formatted;
    });
  }, [formatted]);
  return [raw, setRaw] as const;
}

const formatList = (v: readonly string[]) => v.join(', ');
const parseList = (raw: string) =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');

export function ListInput({
  value,
  onChange,
  placeholder,
}: {
  value: readonly string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
}) {
  const [raw, setRaw] = useDraftText(value, formatList, parseList);
  return (
    <Input
      className="h-8"
      value={raw}
      placeholder={placeholder}
      onChange={(e) => {
        setRaw(e.target.value);
        onChange(parseList(e.target.value));
      }}
    />
  );
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  integer = false,
  className,
  ariaLabel,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  integer?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  const parse = (raw: string): number | null => {
    const n = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(n)) return null;
    if (integer && !Number.isInteger(n)) return null;
    if ((min !== undefined && n < min) || (max !== undefined && n > max)) return null;
    return n;
  };
  const [raw, setRaw] = useDraftText(value, String, parse);
  const invalid = parse(raw) === null;
  return (
    <Input
      className={cn('h-8', invalid && 'border-destructive', className)}
      inputMode="decimal"
      aria-label={ariaLabel}
      aria-invalid={invalid}
      value={raw}
      onChange={(e) => {
        setRaw(e.target.value);
        const n = parse(e.target.value);
        if (n !== null) onChange(n);
      }}
    />
  );
}

/** Ordered key/value rows serialized as a record (data parameters, headers). */
export function KeyValueEditor({
  value,
  onChange,
  addLabel,
}: {
  value: Readonly<Record<string, string>> | undefined;
  onChange: (value: Record<string, string> | undefined) => void;
  addLabel: string;
}) {
  const { t } = useI18n();
  const toRows = (record: Readonly<Record<string, string>> | undefined) =>
    Object.entries(record ?? {}).map(([k, v]) => ({ k, v }));
  const [rows, setRows] = useState(() => toRows(value));
  const serialized = JSON.stringify(value ?? {});
  useEffect(() => {
    setRows((current) => {
      const mine = JSON.stringify(
        Object.fromEntries(current.filter((r) => r.k).map((r) => [r.k, r.v])),
      );
      return mine === serialized ? current : toRows(value);
    });
    // Only an external change of the record replaces the rows being edited.
  }, [serialized]);

  const commit = (next: { k: string; v: string }[]) => {
    setRows(next);
    const record = Object.fromEntries(next.filter((r) => r.k.trim()).map((r) => [r.k.trim(), r.v]));
    onChange(Object.keys(record).length > 0 ? record : undefined);
  };

  return (
    <div className="grid gap-1.5">
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Input
            className="h-8 flex-1"
            placeholder={t('analytics.funnelBuilder.panel.key')}
            value={row.k}
            onChange={(e) =>
              commit(rows.map((r, j) => (j === i ? { ...r, k: e.target.value } : r)))
            }
          />
          <Input
            className="h-8 flex-1"
            placeholder={t('analytics.funnelBuilder.panel.value')}
            value={row.v}
            onChange={(e) =>
              commit(rows.map((r, j) => (j === i ? { ...r, v: e.target.value } : r)))
            }
          />
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            aria-label={t('analytics.funnelBuilder.panel.remove')}
            onClick={() => commit(rows.filter((_, j) => j !== i))}
          >
            <X className="size-3.5" aria-hidden />
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        className="h-7 justify-self-start text-xs"
        onClick={() => setRows([...rows, { k: '', v: '' }])}
      >
        <Plus className="size-3.5" aria-hidden />
        {addLabel}
      </Button>
    </div>
  );
}
