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
import {
  applyTheme,
  readBootPrefs,
  resolveTheme,
  systemTheme,
  writePrefsCookie,
  type ResolvedTheme,
  type ThemePreference,
} from './prefs';

interface ThemeContextValue {
  readonly theme: ThemePreference;
  readonly resolvedTheme: ResolvedTheme;
  readonly setTheme: (theme: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export interface ThemeProviderProps {
  /** Defaults to the boot prefs (`window.__AMABLE__` / `amb_prefs` cookie), then `system`. */
  readonly initialTheme?: ThemePreference;
  /** Persist the user's choice, e.g. `PATCH /api/me/preferences`. Errors are the caller's to handle. */
  readonly onThemeChange?: (theme: ThemePreference) => void;
  readonly children: ReactNode;
}

export function ThemeProvider({ initialTheme, onThemeChange, children }: ThemeProviderProps) {
  const [theme, setThemeState] = useState<ThemePreference>(
    () => initialTheme ?? readBootPrefs().theme ?? 'system',
  );
  const [system, setSystem] = useState<ResolvedTheme>(() => systemTheme());
  const onChangeRef = useRef(onThemeChange);
  onChangeRef.current = onThemeChange;

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setSystem(query.matches ? 'dark' : 'light');
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  const resolvedTheme = theme === 'system' ? system : resolveTheme(theme);

  useEffect(() => {
    applyTheme(resolvedTheme, theme);
  }, [resolvedTheme, theme]);

  const setTheme = useCallback((next: ThemePreference) => {
    setThemeState(next);
    writePrefsCookie({ theme: next });
    onChangeRef.current?.(next);
  }, []);

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (value === null) throw new Error('useTheme must be used inside <ThemeProvider>');
  return value;
}
