/**
 * Boot preferences contract between the core worker and the SPA (see the vault
 * note moduli/ui.md). The worker's SPA middleware, before first paint:
 *
 * - injects `<script nonce>window.__AMABLE__ = { locale, theme, authenticated, turnstileSiteKey }</script>`;
 * - sets `lang`, `data-theme` and (for dark, or system+dark) the `dark` class on `<html>`;
 * - resolves values from the user row, else the `amb_prefs` cookie (`<locale>.<theme>`),
 *   else Accept-Language + system theme.
 *
 * Under the Vite dev server nothing is injected: the cookie, then the system, apply.
 */

export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type ResolvedTheme = 'light' | 'dark';

export interface BootPrefs {
  readonly theme?: ThemePreference;
  readonly locale?: string;
}

/** Shape injected by the core worker; only `theme` and `locale` are read here. */
export interface InjectedBootConfig {
  readonly locale?: string;
  readonly theme?: string;
  readonly authenticated?: boolean;
  readonly turnstileSiteKey?: string | null;
}

declare global {
  interface Window {
    __AMABLE__?: InjectedBootConfig;
  }
}

export const PREFS_COOKIE = 'amb_prefs';

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (THEME_PREFERENCES as readonly string[]).includes(value);
}

function readCookiePrefs(): BootPrefs {
  if (typeof document === 'undefined') return {};
  const raw = document.cookie
    .split('; ')
    .find((part) => part.startsWith(`${PREFS_COOKIE}=`))
    ?.slice(PREFS_COOKIE.length + 1);
  if (!raw) return {};
  const [locale = '', theme = ''] = decodeURIComponent(raw).split('.');
  return { ...(locale ? { locale } : {}), ...(isThemePreference(theme) ? { theme } : {}) };
}

/** Server-injected values win over the cookie; unknown values are ignored. */
export function readBootPrefs(): BootPrefs {
  const cookie = readCookiePrefs();
  const injected = typeof window === 'undefined' ? undefined : window.__AMABLE__;
  const theme = isThemePreference(injected?.theme) ? injected.theme : cookie.theme;
  const locale = typeof injected?.locale === 'string' ? injected.locale : cookie.locale;
  return { ...(theme ? { theme } : {}), ...(locale ? { locale } : {}) };
}

/**
 * Mirrors a change into the cookie (same `<locale>.<theme>` format the server
 * writes) so the next load is right before `PATCH /api/me/preferences` lands,
 * and for signed-out pages.
 */
export function writePrefsCookie(
  prefs: BootPrefs,
  fallback: { locale: string; theme: ThemePreference } = { locale: 'en', theme: 'system' },
): void {
  if (typeof document === 'undefined') return;
  const current = readBootPrefs();
  const locale = prefs.locale ?? current.locale ?? fallback.locale;
  const theme = prefs.theme ?? current.theme ?? fallback.theme;
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${PREFS_COOKIE}=${encodeURIComponent(`${locale}.${theme}`)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
}

export function systemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === 'system' ? systemTheme() : preference;
}

/** Applies the resolved theme to `<html>`; safe to call before React renders. */
export function applyTheme(resolved: ResolvedTheme, preference?: ThemePreference): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  root.style.colorScheme = resolved;
  if (preference) root.dataset['theme'] = preference;
}
