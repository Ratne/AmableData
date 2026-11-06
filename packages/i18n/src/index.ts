import { en } from './catalogs/en';
import type { MessageKey } from './catalogs/en';
import { it } from './catalogs/it';
import { interpolate, resolveLocale, type Locale } from './locale';

/** Server entry (workers, tests): every catalog is bundled. The SPA uses `@amable/i18n/client`. */

export type { MessageKey };
export {
  DEFAULT_LOCALE,
  DEFAULT_THEME,
  formatDateTime,
  formatNumber,
  isLocale,
  isTheme,
  LOCALES,
  negotiateLocale,
  resolveLocale,
  THEMES,
  type Locale,
  type Theme,
} from './locale';

const catalogs: Readonly<Record<Locale, Readonly<Record<MessageKey, string>>>> = { en, it };

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
  return interpolate(catalogs[resolveLocale(locale)][key], vars);
}

export { renderSystemEmail, escapeHtml } from './emails';
export { renderEmailLayout } from './email-layout';
export type { EmailBlock, EmailLayoutInput, EmailLayoutOutput } from './email-layout';
export type { SystemEmailKind, SystemEmailVars, RenderedEmail } from './emails';
