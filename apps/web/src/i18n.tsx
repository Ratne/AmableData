import {
  isLocale,
  resolveLocale,
  t as translate,
  type Locale,
  type MessageKey,
} from '@amable/i18n';
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
 * else the browser language, else English.
 */

type Translate = (key: MessageKey, vars?: Readonly<Record<string, string | number>>) => string;

interface I18nContextValue {
  readonly locale: Locale;
  readonly setLocale: (locale: Locale) => void;
  readonly t: Translate;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function initialLocale(): Locale {
  const boot = readBootPrefs().locale;
  if (boot !== undefined && isLocale(boot)) return boot;
  const browser = (navigator.language || '').split('-')[0] ?? '';
  return resolveLocale(browser);
}

export function I18nProvider({
  onLocaleChange,
  children,
}: {
  onLocaleChange?: (locale: Locale) => void;
  children: ReactNode;
}) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const onChange = useRef(onLocaleChange);
  onChange.current = onLocaleChange;

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    writePrefsCookie({ locale: next });
    onChange.current?.(next);
  }, []);

  const t = useCallback<Translate>((key, vars) => translate(locale, key, vars), [locale]);
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);
  if (value === null) throw new Error('useI18n must be used inside <I18nProvider>');
  return value;
}
