import type { CustomFieldValueInput, Tag } from '@amable/api-types/crm';
import { Badge } from '@amable/ui/ui/badge';
import type { ReactNode } from 'react';
import { formatCustomValue } from '../custom-fields/display';
import type { FieldMeta } from '../field-catalog';

export interface CellContext {
  readonly locale: string;
  readonly nameOf: (userId: string) => string;
  readonly tagsById: ReadonlyMap<string, Tag>;
  readonly yes: string;
  readonly no: string;
}

export function formatDate(
  locale: string,
  iso: string | null | undefined,
  withTime = false,
): string {
  if (iso === null || iso === undefined || iso === '') return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Intl.DateTimeFormat(
    locale,
    withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' },
  ).format(ms);
}

export function formatMoney(locale: string, minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

/** Sum of amounts per currency (largest first), never mixing currencies. */
export function totalsByCurrency(
  items: readonly { value_minor: number; currency: string }[],
): { currency: string; minor: number }[] {
  const sums = new Map<string, number>();
  for (const item of items) sums.set(item.currency, (sums.get(item.currency) ?? 0) + item.value_minor);
  return [...sums.entries()]
    .map(([currency, minor]) => ({ currency, minor }))
    .sort((a, b) => b.minor - a.minor || a.currency.localeCompare(b.currency));
}

export function formatTotals(
  locale: string,
  items: readonly { value_minor: number; currency: string }[],
  fallbackCurrency: string,
): string {
  const totals = totalsByCurrency(items);
  if (totals.length === 0) return formatMoney(locale, 0, fallbackCurrency);
  return totals.map((total) => formatMoney(locale, total.minor, total.currency)).join(' + ');
}

export function TagBadges({
  ids,
  tagsById,
  max = 3,
}: {
  ids: readonly string[];
  tagsById: ReadonlyMap<string, Tag>;
  max?: number;
}) {
  if (ids.length === 0) return null;
  const shown = ids.slice(0, max);
  return (
    <span className="flex flex-wrap gap-1">
      {shown.map((id) => (
        <Badge key={id} variant="secondary" className="max-w-32 truncate">
          {tagsById.get(id)?.name ?? id}
        </Badge>
      ))}
      {ids.length > max ? <Badge variant="outline">+{String(ids.length - max)}</Badge> : null}
    </span>
  );
}

/** Table cell of a query-builder column value. */
export function renderSearchValue(
  meta: FieldMeta | undefined,
  value: unknown,
  ctx: CellContext,
): ReactNode {
  if (value === null || value === undefined || value === '')
    return <span className="text-muted-foreground">—</span>;
  if (meta?.field === 'tags' && Array.isArray(value)) {
    return <TagBadges ids={value as string[]} tagsById={ctx.tagsById} />;
  }
  if (meta?.custom) {
    return formatCustomValue(meta.custom, value as CustomFieldValueInput, ctx) || '—';
  }
  if (meta?.choices && typeof value === 'string') {
    return meta.choices.find((choice) => choice.value === value)?.label ?? value;
  }
  switch (meta?.kind) {
    case 'datetime_ms':
    case 'datetime_iso':
      return formatDate(ctx.locale, String(value), true);
    case 'date': {
      const ms = Date.parse(`${String(value)}T00:00:00Z`);
      return Number.isNaN(ms)
        ? String(value)
        : new Intl.DateTimeFormat(ctx.locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(ms);
    }
    case 'number':
      return typeof value === 'number'
        ? new Intl.NumberFormat(ctx.locale).format(value)
        : String(value);
    case 'boolean':
      return value === true ? ctx.yes : ctx.no;
    default:
      return Array.isArray(value) ? value.join(', ') : String(value);
  }
}
