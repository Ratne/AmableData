import type { MeasureKind, ReportResult } from '@amable/api-types/reports';
import { currencyExponent } from '../../commerce/lib/money';

/** Formatting of report values by measure kind (money = integer minor units of the result currency). */

export interface ValueFormatter {
  (kind: MeasureKind, value: number | null | undefined, options?: { compact?: boolean }): string;
}

export function createValueFormatter(locale: string, currency: string | null): ValueFormatter {
  const exponent = currency === null ? 2 : currencyExponent(currency);
  const integer = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const decimal = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const compactNumber = new Intl.NumberFormat(locale, {
    notation: 'compact',
    maximumFractionDigits: 1,
  });
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });
  const money = (compact: boolean) => {
    if (currency === null) return compact ? compactNumber : decimal;
    try {
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
        ...(compact
          ? { notation: 'compact', maximumFractionDigits: 1 }
          : { minimumFractionDigits: exponent, maximumFractionDigits: exponent }),
      });
    } catch {
      return decimal;
    }
  };
  const moneyFull = money(false);
  const moneyCompact = money(true);
  return (kind, value, options) => {
    if (value === null || value === undefined || !Number.isFinite(value)) return '—';
    const compact = options?.compact === true;
    switch (kind) {
      case 'money':
        return (compact ? moneyCompact : moneyFull).format(value / 10 ** exponent);
      case 'ratio':
        return percent.format(value);
      case 'count':
        return (compact && Math.abs(value) >= 10_000 ? compactNumber : integer).format(value);
      case 'days':
      case 'number':
        return (compact && Math.abs(value) >= 10_000 ? compactNumber : decimal).format(value);
    }
  };
}

/** Value in chart units (money in major units so axes read naturally). */
export function chartValue(
  kind: MeasureKind,
  value: number | null | undefined,
  currency: string | null,
): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return kind === 'money'
    ? value / 10 ** (currency === null ? 2 : currencyExponent(currency))
    : value;
}

/** Relative change of `current` over `previous`, or null when not meaningful. */
export function relativeChange(
  current: number | null | undefined,
  previous: number | null | undefined,
): number | null {
  if (current === null || current === undefined || previous === null || previous === undefined)
    return null;
  if (previous === 0) return current === 0 ? 0 : null;
  return (current - previous) / Math.abs(previous);
}

export function measureKind(result: ReportResult, key: string): MeasureKind {
  return result.measures.find((m) => m.key === key)?.kind ?? 'number';
}
