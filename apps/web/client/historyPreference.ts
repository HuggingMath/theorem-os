/**
 * The docked research history starts folded until the reader saves a choice. theme.js marks <html data-history-collapsed> before the
 * first paint, so the workspace starts at its final width instead of jumping when app.js reads the same choice.
 */
export const historyStorageKey = 'theoremos-history-collapsed-v1';

export function readHistoryCollapsed(storage: () => Pick<Storage, 'getItem'>): boolean {
  try {
    const saved = storage().getItem(historyStorageKey);
    return saved === null || saved === 'true';
  } catch { return true; }
}

export function markHistoryCollapsed(collapsed: boolean) {
  if (collapsed) document.documentElement.dataset.historyCollapsed = 'true';
  else document.documentElement.removeAttribute('data-history-collapsed');
}
