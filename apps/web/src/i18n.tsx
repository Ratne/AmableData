import {
  cachedCatalog,
  DEFAULT_LOCALE,
  isLocale,
  loadCatalog,
  resolveLocale,
  translate,
  type Catalog,
  type Locale,
  type MessageKey,
} from '@amable/i18n/client';
import { readBootPrefs, writePrefsCookie } from '@amable/ui';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/**
 * React binding of @amable/i18n for the SPA. Initial locale: what the core
 * worker injected (`window.__AMABLE__.locale`, from the user row or cookie),
 * else the browser language, else English. Only the active language's catalog
 * is downloaded; nothing renders until the first one is ready, and on a switch
 * the previous language stays on screen until the new one has loaded.
 */

type Translate = (key: MessageKey, vars?: Readonly<Record<string, string | number>>) => string;

interface I18nContextValue {
  readonly locale: Locale;
  readonly setLocale: (locale: Locale) => void;
  readonly t: Translate;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function initialLocale(): Locale {
  const boot = readBootPrefs().locale;
  if (boot !== undefined && isLocale(boot)) return boot;
  const browser = (navigator.language || '').split('-')[0] ?? '';
  return resolveLocale(browser);
}

interface Active {
  readonly locale: Locale;
  readonly catalog: Catalog;
}

function cachedActive(locale: Locale): Active | null {
  const catalog = cachedCatalog(locale);
  return catalog === undefined ? null : { locale, catalog };
}

export function I18nProvider({
  onLocaleChange,
  children,
}: {
  onLocaleChange?: (locale: Locale) => void;
  children: ReactNode;
}) {
  const [requested, setRequested] = useState<Locale>(initialLocale);
  const [active, setActive] = useState<Active | null>(() => cachedActive(requested));
  const onChange = useRef(onLocaleChange);
  onChange.current = onLocaleChange;

  useEffect(() => {
    if (active?.locale === requested) return;
    let cancelled = false;
    loadCatalog(requested).then(
      (catalog) => {
        if (!cancelled) setActive({ locale: requested, catalog });
      },
      (error: unknown) => {
        console.error('i18n: catalog failed to load', error);
        if (!cancelled && requested !== DEFAULT_LOCALE) setRequested(DEFAULT_LOCALE);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [requested, active?.locale]);

  const locale = active?.locale ?? requested;
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setRequested(next);
    writePrefsCookie({ locale: next });
    onChange.current?.(next);
  }, []);

  const catalog = active?.catalog;
  const t = useCallback<Translate>(
    (key, vars) => (catalog === undefined ? key : translate(catalog, key, vars)),
    [catalog],
  );
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
  if (active === null) return null;
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);
  if (value === null) throw new Error('useI18n must be used inside <I18nProvider>');
  return value;
}
