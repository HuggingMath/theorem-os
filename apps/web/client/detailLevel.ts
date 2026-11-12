import { collaborationDetailStorageKey } from './runAwareness';

/**
 * One 简洁/详细 choice for the whole workbench, kept per browser: the solve conversation, the collaboration surface and
 * the trajectory all read it, and switching any of them switches all. New readers start with 简洁.
 */
export type DetailLevel = 'simple' | 'full';
const listeners = new Set<(level: DetailLevel) => void>();
let current: DetailLevel | undefined;

export function detailLevel(): DetailLevel {
  if (current) return current;
  try { current = localStorage.getItem(collaborationDetailStorageKey) === 'full' ? 'full' : 'simple'; } catch { current = 'simple'; }
  return current;
}

export function setDetailLevel(level: DetailLevel) {
  if (detailLevel() === level) return;
  current = level;
  try { localStorage.setItem(collaborationDetailStorageKey, level); } catch { /* The choice lasts for this page only. */ }
  for (const listener of listeners) listener(level);
}

/** Calls `listener` on every later change; returns the unsubscribe. */
export function onDetailLevel(listener: (level: DetailLevel) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
