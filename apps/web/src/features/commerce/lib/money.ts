/**
 * Money on the client: the API speaks integer minor units + ISO 4217 currency
 * and tax rates in basis points. Display goes through Intl for the user's
 * locale; input parsing is string-based so no float rounding creeps in.
 */

const exponentCache = new Map<string, number>();
const currencyFormatCache = new Map<string, Intl.NumberFormat>();

/** Minor-unit digits of a currency (EUR 2, JPY 0, KWD 3); 2 for unknown codes. */
export function currencyExponent(currency: string): number {
  const cached = exponentCache.get(currency);
  if (cached !== undefined) return cached;
  let digits = 2;
  try {
    digits =
      new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2;
  } catch {
    digits = 2;
  }
  exponentCache.set(currency, digits);
  return digits;
}

function currencyFormat(locale: string, currency: string): Intl.NumberFormat | null {
  const key = `${locale}|${currency}`;
  const cached = currencyFormatCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const format = new Intl.NumberFormat(locale, { style: 'currency', currency });
    currencyFormatCache.set(key, format);
    return format;
  } catch {
    return null;
  }
}

/** Integer minor units → decimal string with `.` (exact, no floats). */
export function minorToDecimal(minor: number, currency: string): string {
  const exponent = currencyExponent(currency);
  const negative = minor < 0;
  const digits = String(Math.abs(Math.trunc(minor))).padStart(exponent + 1, '0');
  const whole = exponent === 0 ? digits : digits.slice(0, -exponent);
  const fraction = exponent === 0 ? '' : digits.slice(-exponent);
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** `formatMoney(123456, 'EUR', 'it')` → `1.234,56 €`. */
export function formatMoney(minor: number, currency: string, locale: string): string {
  const format = currencyFormat(locale, currency);
  const decimal = minorToDecimal(minor, currency);
  if (format === null) return `${decimal} ${currency}`;
  // Intl accepts decimal strings (exact for large values); the cast keeps older lib typings happy.
  return format.format(decimal as unknown as number);
}

/** Decimal separator of a locale (`.` for en, `,` for it). */
export function decimalSeparator(locale: string): string {
  const part = new Intl.NumberFormat(locale).formatToParts(1.5).find((p) => p.type === 'decimal');
  return part?.value ?? '.';
}

/** Minor units → editable text in the locale's notation, without grouping (`12,50`). */
export function minorToInput(minor: number, currency: string, locale: string): string {
  const decimal = minorToDecimal(minor, currency);
  return decimal.replace('.', decimalSeparator(locale));
}

/**
 * Normalizes a typed number to `123.45` notation. Accepts both `,` and `.`:
 * with both present the rightmost is the decimal mark; a lone separator is
 * the decimal mark unless it is the locale's grouping char followed by
 * exactly three digits (or repeated, e.g. `1.000.000` in Italian).
 */
function normalizeNumber(text: string, locale: string): string | null {
  const cleaned = text.trim().replace(/[\s\u00a0\u202f']/g, '');
  if (cleaned === '') return null;
  if (!/^[\d.,]+$/.test(cleaned)) return null;
  const hasComma = cleaned.includes(',');
  const hasDot = cleaned.includes('.');
  if (hasComma && hasDot) {
    const decimalMark = cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.') ? ',' : '.';
    const group = decimalMark === ',' ? '.' : ',';
    const parts = cleaned.split(group).join('').split(decimalMark);
    return parts.length === 2 ? `${parts[0] ?? ''}.${parts[1] ?? ''}` : null;
  }
  if (!hasComma && !hasDot) return cleaned;
  const sep = hasComma ? ',' : '.';
  const parts = cleaned.split(sep);
  const isGroup =
    sep !== decimalSeparator(locale) &&
    parts.slice(1).every((p) => p.length === 3) &&
    (parts.length > 2 || parts[1]?.length === 3);
  if (isGroup) return parts.join('');
  return parts.length === 2 ? `${parts[0] ?? ''}.${parts[1] ?? ''}` : null;
}

/** Parses user input into minor units; `null` when empty, malformed or too precise. */
export function parseMoneyInput(text: string, currency: string, locale: string): number | null {
  const normalized = normalizeNumber(text, locale);
  if (normalized === null) return null;
  const match = /^(\d*)(?:\.(\d*))?$/.exec(normalized);
  if (match === null) return null;
  const whole = match[1] ?? '';
  const fraction = match[2] ?? '';
  if (whole === '' && fraction === '') return null;
  const exponent = currencyExponent(currency);
  if (fraction.length > exponent) return null;
  const minor = Number(`${whole || '0'}${fraction.padEnd(exponent, '0')}`);
  return Number.isSafeInteger(minor) ? minor : null;
}

/** Basis points → percentage text (`2200` → `22%`, `550` → `5.5%` / `5,5%`). */
export function formatBps(bps: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: 2,
  }).format(bps / 10_000);
}

/** Basis points → editable percentage (`2250` → `22,5` in Italian). */
export function bpsToInput(bps: number, locale: string): string {
  const whole = Math.trunc(bps / 100);
  const fraction = String(bps % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return fraction ? `${String(whole)}${decimalSeparator(locale)}${fraction}` : String(whole);
}

/** Percentage text → basis points (`22` → 2200, `5,5` → 550); max two decimals, 0–100%. */
export function parseBpsInput(text: string, locale: string): number | null {
  const normalized = normalizeNumber(text.replace('%', ''), locale);
  if (normalized === null) return null;
  const match = /^(\d+)(?:\.(\d{0,2}))?$/.exec(normalized);
  if (match === null) return null;
  const bps = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return bps <= 10_000 ? bps : null;
}
