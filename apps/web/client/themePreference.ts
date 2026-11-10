/**
 * Light or dark interface. The reader's choice lives in localStorage and applies to the workbench, login and share
 * pages; without a choice the page follows the system. The resolved theme is written to <html data-theme>, which is
 * the only thing the stylesheet reads, so the dark tokens never depend on the system's colour scheme and a choice always
 * wins. They apply on screens only; a printed page uses the light tokens.
 */
export type ThemePreference = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

export const themeStorageKey = 'theorem-os.web-theme.v1';
// Matches the topbar of each theme, so the browser chrome around the page continues it.
const chrome: Record<Theme, string> = { light: '#f5f4ee', dark: '#1b1a18' };

export function readThemePreference(storage: Pick<Storage, 'getItem'> | (() => Pick<Storage, 'getItem'>) = () => localStorage): ThemePreference {
  try {
    const value = (typeof storage === 'function' ? storage() : storage).getItem(themeStorageKey);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch { return 'system'; }
}

/** Stores the choice; 'system' removes it. Returns false when the browser refuses storage. */
export function saveThemePreference(storage: Pick<Storage, 'setItem' | 'removeItem'> | (() => Pick<Storage, 'setItem' | 'removeItem'>), preference: ThemePreference): boolean {
  try {
    const target = typeof storage === 'function' ? storage() : storage;
    if (preference === 'system') target.removeItem(themeStorageKey);
    else target.setItem(themeStorageKey, preference);
    return true;
  } catch { return false; }
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): Theme {
  return preference === 'system' ? systemDark ? 'dark' : 'light' : preference;
}

const darkQuery = () => matchMedia('(prefers-color-scheme: dark)');

/** Applies the stored choice (or the system theme) to the document and returns the resolved theme. */
export function applyTheme(preference = readThemePreference()): Theme {
  const theme = resolveTheme(preference, darkQuery().matches), root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.themePreference = preference;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', chrome[theme]);
  return theme;
}

/** Keeps the page in step with the system theme and with choices made in other tabs. */
export function followThemeChanges(changed?: (theme: Theme) => void) {
  darkQuery().addEventListener('change', () => changed?.(applyTheme()));
  addEventListener('storage', event => { if (event.key === themeStorageKey || event.key === null) changed?.(applyTheme()); });
}
