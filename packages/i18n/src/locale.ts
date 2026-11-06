/** Locale helpers shared by the server entry and the SPA entry; no catalog imports here. */

export const LOCALES = ['en', 'it'] as const;
export type Locale = (typeof LOCALES)[number];

/** English is the product default. */
export const DEFAULT_LOCALE: Locale = 'en';

export const THEMES = ['light', 'dark', 'system'] as const;
export type Theme = (typeof THEMES)[number];
export const DEFAULT_THEME: Theme = 'system';

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

export function isTheme(value: string): value is Theme {
  return (THEMES as readonly string[]).includes(value);
}

export function resolveLocale(value: string | null | undefined): Locale {
  return value !== null && value !== undefined && isLocale(value) ? value : DEFAULT_LOCALE;
}

/** Replaces `{name}` placeholders from `vars`; unknown names stay as written. */
export function interpolate(message: string, vars?: Readonly<Record<string, string | number>>): string {
  if (vars === undefined) return message;
  return message.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * Best supported locale from an Accept-Language header (pre-login rule: the
 * UI follows the browser until the user has a saved preference).
 */
export function negotiateLocale(acceptLanguage: string | null | undefined): Locale {
  if (acceptLanguage === null || acceptLanguage === undefined) return DEFAULT_LOCALE;
  const ranked = acceptLanguage
    .split(',')
    .map((part) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.find((p) => p.trim().startsWith('q='));
      return { tag: tag.toLowerCase(), q: q === undefined ? 1 : Number(q.trim().slice(2)) || 0 };
    })
    .sort((a, b) => b.q - a.q);
  for (const { tag } of ranked) {
    const base = tag.split('-')[0] ?? '';
    if (isLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}

// Intl constructors are costly and these helpers run per table row; formats are few, so cache them.
const MAX_CACHED_FORMATS = 200;
const dateFormats = new Map<string, Intl.DateTimeFormat>();
const numberFormats = new Map<string, Intl.NumberFormat>();

function cached<T>(cache: Map<string, T>, key: string, create: () => T): T {
  let format = cache.get(key);
  if (format === undefined) {
    format = create();
    if (cache.size >= MAX_CACHED_FORMATS) cache.clear();
    cache.set(key, format);
  }
  return format;
}

/** Intl formatting bound to a locale and (tenant) time zone. */
export function formatDateTime(
  locale: Locale,
  value: number | Date,
  timeZone?: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
): string {
  const key = `${locale}|${timeZone ?? ''}|${JSON.stringify(options)}`;
  return cached(dateFormats, key, () => new Intl.DateTimeFormat(locale, { ...options, timeZone })).format(value);
}

export function formatNumber(
  locale: Locale,
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  const key = `${locale}|${options === undefined ? '' : JSON.stringify(options)}`;
  return cached(numberFormats, key, () => new Intl.NumberFormat(locale, options)).format(value);
}
