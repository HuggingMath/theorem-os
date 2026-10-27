import { describe, expect, it } from 'vitest';
import { readThemePreference, resolveTheme, saveThemePreference, themeStorageKey } from '../apps/web/client/themePreference';

const memory = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key), values };
};

describe('theme preference', () => {
  it('follows the system until a choice is stored, and "system" removes the choice', () => {
    const storage = memory();
    expect(readThemePreference(storage)).toBe('system');
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(saveThemePreference(storage, 'dark')).toBe(true);
    expect(readThemePreference(storage)).toBe('dark');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
    expect(saveThemePreference(storage, 'system')).toBe(true);
    expect(storage.values.size).toBe(0);
  });

  it('treats unknown values and refused storage as following the system', () => {
    const storage = memory();
    storage.setItem(themeStorageKey, 'sepia');
    expect(readThemePreference(storage)).toBe('system');
    const refusing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } };
    expect(readThemePreference(refusing)).toBe('system');
    expect(saveThemePreference(refusing, 'light')).toBe(false);
  });
});
