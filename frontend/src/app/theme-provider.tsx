import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/**
 * light / dark / system theme, with no flash of the wrong theme.
 *
 * The flash is prevented by the inline script in `index.html`, which runs
 * before the first paint and sets `.dark` + `color-scheme` from the same
 * localStorage key this provider uses. React then mounts into an already
 * correct DOM and only reconciles later changes. Keep the two in sync — if you
 * change `STORAGE_KEY` or the class name, change it there too.
 *
 * `next-themes` would do this for us but is not a declared dependency of this
 * package, and the whole thing is 80 lines.
 *
 * The *preference* (light/dark/system) is a device setting, not account data,
 * so localStorage is the right home for it. Note that this is a display
 * preference and explicitly not a credential — D3's ban on localStorage is
 * about tokens.
 */

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'family.theme';
const DARK_CLASS = 'dark';

interface ThemeContextValue {
  /** What the user chose. */
  theme: ThemeMode;
  /** What is actually on screen right now. */
  resolvedTheme: ResolvedTheme;
  setTheme: (mode: ThemeMode) => void;
  /** light → dark → light. `system` resolves first, then flips. */
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'system';
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    // Private mode / storage blocked — fall through to the system default.
  }
  return 'system';
}

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyTheme(resolved: ResolvedTheme): void {
  const root = document.documentElement;
  root.classList.toggle(DARK_CLASS, resolved === 'dark');
  root.style.colorScheme = resolved;
  // Keep the iOS status bar / Android system bars in step with the app. The two
  // static `theme-color` tags in index.html cover the pre-hydration paint; this
  // handles an explicit override that disagrees with the OS setting.
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])');
  if (meta) meta.content = resolved === 'dark' ? '#211d19' : '#fdf8f2';
}

export function ThemeProvider(props: { children: ReactNode; defaultTheme?: ThemeMode }) {
  const [theme, setThemeState] = useState<ThemeMode>(() => readStoredTheme());
  const [systemDark, setSystemDark] = useState<boolean>(() => systemPrefersDark());

  // Track the OS preference so `system` stays live rather than sampled once.
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => {
      setSystemDark(event.matches);
    };
    query.addEventListener('change', onChange);
    return () => {
      query.removeEventListener('change', onChange);
    };
  }, []);

  const resolvedTheme: ResolvedTheme =
    theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;

  useEffect(() => {
    applyTheme(resolvedTheme);
  }, [resolvedTheme]);

  // Multiple PWA tabs / windows: keep them consistent.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      setThemeState(readStoredTheme());
    };
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const setTheme = useCallback((mode: ThemeMode) => {
    setThemeState(mode);
    try {
      window.localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // Non-fatal: the choice simply will not survive a reload.
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
  }, [resolvedTheme, setTheme]);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, setTheme, toggleTheme }),
    [theme, resolvedTheme, setTheme, toggleTheme],
  );

  return <ThemeContext value={value}>{props.children}</ThemeContext>;
}

export function useTheme(): ThemeContextValue {
  const context = use(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used inside <ThemeProvider>');
  }
  return context;
}

/** Russian labels for the theme switcher in Settings. */
export const THEME_LABELS_RU: Record<ThemeMode, string> = {
  light: 'Светлая',
  dark: 'Тёмная',
  system: 'Как в системе',
};
