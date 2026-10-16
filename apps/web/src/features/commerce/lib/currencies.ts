import { CURRENCY_CODES, isCurrencyCode } from '@amable/api-types';

export interface CurrencyOption {
  readonly code: string;
  /** Localized name ("Euro", "Dollaro statunitense"); the code when Intl does not know it. */
  readonly name: string;
  /** Narrow symbol ("€", "$", "CHF"); the code when there is none. */
  readonly symbol: string;
}

const cache = new Map<string, CurrencyOption[]>();

function displayNames(locale: string): Intl.DisplayNames | null {
  try {
    return new Intl.DisplayNames([locale], { type: 'currency' });
  } catch {
    return null;
  }
}

export function currencySymbol(code: string, locale: string): string {
  try {
    const part = new Intl.NumberFormat(locale, { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' })
      .formatToParts(0)
      .find((p) => p.type === 'currency');
    return part?.value ?? code;
  } catch {
    return code;
  }
}

function option(code: string, locale: string, names: Intl.DisplayNames | null): CurrencyOption {
  let name = code;
  try {
    name = names?.of(code) ?? code;
  } catch {
    name = code;
  }
  return { code, name, symbol: currencySymbol(code, locale) };
}

/** Every active ISO 4217 currency for `locale`, alphabetical by code. */
export function allCurrencyOptions(locale: string): readonly CurrencyOption[] {
  const cached = cache.get(locale);
  if (cached !== undefined) return cached;
  const names = displayNames(locale);
  const list = CURRENCY_CODES.map((code) => option(code, locale, names));
  cache.set(locale, list);
  return list;
}

/**
 * Options of the select: `preferred` codes first (tenant default, common
 * ones), then the rest; a stored code outside the list (legacy data) stays
 * selectable so editing a record never silently changes it.
 */
export function currencyOptions(
  locale: string,
  preferred: readonly string[] = [],
  current = '',
): CurrencyOption[] {
  const all = allCurrencyOptions(locale);
  const byCode = new Map(all.map((o) => [o.code, o]));
  const head: CurrencyOption[] = [];
  const seen = new Set<string>();
  const extra = current !== '' && !isCurrencyCode(current) ? [current] : [];
  for (const code of [...extra, ...preferred]) {
    if (seen.has(code)) continue;
    const found = byCode.get(code) ?? (code === current ? option(code, locale, displayNames(locale)) : undefined);
    if (found === undefined) continue;
    seen.add(code);
    head.push(found);
  }
  return [...head, ...all.filter((o) => !seen.has(o.code))];
}
