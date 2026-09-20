import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import {
  DENSITY_STORAGE_KEY,
  THEME_STORAGE_KEY,
  type Density,
  type ThemeName,
  type ThemePreference
} from '../ui/tokens';

/*
 * The theme is already on the document when this runs: public/theme-init.js set
 * data-theme from the same storage key before the first paint, so the page is
 * never drawn light and repainted dark. This provider owns the choice from then
 * on and keeps the attribute in step.
 */

interface ThemeContextValue {
  /** What the operator chose: a theme, or to follow the system. */
  preference: ThemePreference;
  /** What that resolves to right now. */
  theme: ThemeName;
  setPreference: (preference: ThemePreference) => void;
  density: Density;
  setDensity: (density: Density) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage disabled: the choice still applies to this session.
  }
}

function systemTheme(): ThemeName {
  if (typeof window === 'undefined' || !window.matchMedia) return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function readPreference(): ThemePreference {
  const stored = read(THEME_STORAGE_KEY);
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
}

function readDensity(): Density {
  return read(DENSITY_STORAGE_KEY) === 'compact' ? 'compact' : 'comfortable';
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readPreference);
  const [system, setSystem] = useState<ThemeName>(systemTheme);
  const [density, setDensityState] = useState<Density>(readDensity);

  const theme: ThemeName = preference === 'system' ? system : preference;

  // Following the system means following it while the console is open, not only
  // at load: an operator whose desktop switches at dusk should not have to
  // reload the page.
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => setSystem(event.matches ? 'dark' : 'light');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute('data-density', density);
  }, [density]);

  const setPreference = useCallback((next: ThemePreference) => {
    write(THEME_STORAGE_KEY, next);
    setPreferenceState(next);
  }, []);

  const setDensity = useCallback((next: Density) => {
    write(DENSITY_STORAGE_KEY, next);
    setDensityState(next);
  }, []);

  const value = useMemo(
    () => ({ preference, theme, setPreference, density, setDensity }),
    [preference, theme, setPreference, density, setDensity]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside a ThemeProvider');
  return value;
}
