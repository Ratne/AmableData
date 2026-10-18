const ZERO_DECIMAL = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'ISK',
  'JPY',
  'KMF',
  'KRW',
  'PYG',
  'RWF',
  'UGX',
  'UYI',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
]);
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

/** ISO 4217 minor unit exponent (2 unless listed). */
export function currencyExponent(currency: string): number {
  const code = currency.toUpperCase();
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  return 2;
}

/** Major-unit amount (`"12.345"` or `12.345`) → integer minor units, half-up. */
export function decimalToMinor(
  value: string | number | null | undefined,
  currency: string,
): number {
  if (value === null || value === undefined || value === '') return 0;
  const exp = currencyExponent(currency);
  const text = typeof value === 'number' ? value.toFixed(exp + 3) : value.trim();
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(text);
  if (match === null) return 0;
  const [, sign = '', int = '', frac = ''] = match;
  const digits = BigInt((int || '0') + frac.padEnd(exp, '0').slice(0, exp));
  const roundUp = (frac[exp] ?? '0') >= '5' ? 1n : 0n;
  const minor = Number(digits + roundUp);
  return sign === '-' ? -minor : minor;
}

/** Google Ads micros (1e-6 of a major unit) → integer minor units, half-up. */
export function microsToMinor(
  micros: string | number | null | undefined,
  currency: string,
): number {
  if (micros === null || micros === undefined || micros === '') return 0;
  const value = BigInt(typeof micros === 'number' ? Math.round(micros) : micros);
  const divisor = 10n ** BigInt(6 - currencyExponent(currency));
  const half = divisor / 2n;
  const minor = value >= 0n ? (value + half) / divisor : -((-value + half) / divisor);
  return Number(minor);
}

/** Integer minor units → major-unit number, as the conversion APIs expect `value`. */
export function minorToMajor(minor: number, currency: string): number {
  const exp = currencyExponent(currency);
  return Number((minor / 10 ** exp).toFixed(exp));
}
