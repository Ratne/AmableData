import { en } from './catalogs/en';
import type { MessageKey } from './catalogs/en';
import { it } from './catalogs/it';

export type { MessageKey };

export const LOCALES = ['en', 'it'] as const;
export type Locale = (typeof LOCALES)[number];

/** English is the product default. */
export const DEFAULT_LOCALE: Locale = 'en';

export const THEMES = ['light', 'dark', 'system'] as const;
export type Theme = (typeof THEMES)[number];
export const DEFAULT_THEME: Theme = 'system';

const catalogs: Readonly<Record<Locale, Readonly<Record<MessageKey, string>>>> = { en, it };

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

export function isTheme(value: string): value is Theme {
  return (THEMES as readonly string[]).includes(value);
}

export function resolveLocale(value: string | null | undefined): Locale {
  return value !== null && value !== undefined && isLocale(value) ? value : DEFAULT_LOCALE;
}

/**
 * Typed message accessor. Unknown locales fall back to English; keys are
 * checked at compile time, so a missing translation cannot ship.
 * `{name}` placeholders are replaced from `vars`.
 */
export function t(
  locale: string,
  key: MessageKey,
  vars?: Readonly<Record<string, string | number>>,
): string {
  const message = catalogs[resolveLocale(locale)][key];
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

/** Intl formatting bound to a locale and (tenant) time zone. */
export function formatDateTime(
  locale: Locale,
  value: number | Date,
  timeZone?: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
): string {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(value);
}

export function formatNumber(
  locale: Locale,
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

export { renderSystemEmail, escapeHtml } from './emails';
export { renderEmailLayout } from './email-layout';
export type { EmailBlock, EmailLayoutInput, EmailLayoutOutput } from './email-layout';
export type { SystemEmailKind, SystemEmailVars, RenderedEmail } from './emails';
