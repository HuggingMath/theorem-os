import { describe, expect, it } from 'vitest';
import { historyStorageKey, readHistoryCollapsed } from '../apps/web/client/historyPreference';

describe('history preference', () => {
  it.each([
    { saved: null, collapsed: true, label: 'starts folded without a saved choice' },
    { saved: 'false', collapsed: false, label: 'keeps an explicitly expanded history open' },
    { saved: 'true', collapsed: true, label: 'keeps an explicitly folded history closed' },
    { saved: 'unknown', collapsed: false, label: 'preserves the existing handling of unknown saved values' },
  ])('$label', ({ saved, collapsed }) => {
    const storage = { getItem: (key: string) => key === historyStorageKey ? saved : null };
    expect(readHistoryCollapsed(() => storage)).toBe(collapsed);
  });

  it('starts folded when reading the saved choice is denied', () => {
    const storage = { getItem: () => { throw new Error('denied'); } };
    expect(readHistoryCollapsed(() => storage)).toBe(true);
  });

  it('starts folded when access to the storage object itself is denied', () => {
    const denied = () => { throw new DOMException('Access denied', 'SecurityError'); };
    expect(readHistoryCollapsed(denied)).toBe(true);
  });
});
