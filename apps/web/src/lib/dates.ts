/** Date formatting of the dashboard (medium dates, short or second-precision times). */

type DateInput = string | number | null | undefined;
type Style = 'date' | 'minutes' | 'seconds';

const STYLES: Record<Style, Intl.DateTimeFormatOptions> = {
  date: { dateStyle: 'medium' },
  minutes: { dateStyle: 'medium', timeStyle: 'short' },
  seconds: { dateStyle: 'medium', timeStyle: 'medium' },
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(locale: string, style: Style): Intl.DateTimeFormat {
  const key = `${locale}|${style}`;
  let format = formatters.get(key);
  if (format === undefined) {
    format = new Intl.DateTimeFormat(locale, STYLES[style]);
    formatters.set(key, format);
  }
  return format;
}

function toMs(value: string | number): number {
  return typeof value === 'number' ? value : Date.parse(value);
}

/** Medium date (with the time when `withTime`); '' when empty, the raw text when unparseable. */
export function formatDate(locale: string, value: DateInput, withTime = false): string {
  if (value === null || value === undefined || value === '') return '';
  const ms = toMs(value);
  if (Number.isNaN(ms)) return String(value);
  return formatter(locale, withTime ? 'minutes' : 'date').format(ms);
}

/** Medium date and time; '—' when empty. */
export function formatDateTime(locale: string, value: DateInput, options: { seconds?: boolean } = {}): string {
  if (value === null || value === undefined || value === '') return '—';
  const ms = toMs(value);
  if (Number.isNaN(ms)) return String(value);
  return formatter(locale, options.seconds === true ? 'seconds' : 'minutes').format(ms);
}
