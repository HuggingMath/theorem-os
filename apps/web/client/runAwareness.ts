import type { WebRun } from '../shared';
import { t } from '../i18n';

/**
 * Per-browser memory of the open run and of when the history was last seen. It holds no draft text or account
 * address; a run ID from another account simply matches nothing.
 */
export const resumeStorageKey = 'theorem-os.web-resume.v1';
export const notifyStorageKey = 'theorem-os.web-notify.v1';
/** 'full' once the reader opens the expert collaboration layer; anything else means the simple layer. */
export const collaborationDetailStorageKey = 'theorem-os.web-collaboration-detail.v1';
export type Resume = { selectedId: string; seenAt: string };
type ResumeStorage = Pick<Storage, 'getItem' | 'setItem'>;
// Reading window.localStorage itself throws where storage is blocked.
type StorageSource = () => ResumeStorage;
const terminal = (run: WebRun) => run.status !== 'queued' && run.status !== 'running';

export function readResume(storage: StorageSource): Resume | undefined {
  try {
    const value = JSON.parse(storage().getItem(resumeStorageKey) ?? 'null');
    return value && typeof value.selectedId === 'string' && /^[a-f0-9-]{0,36}$/u.test(value.selectedId) &&
      typeof value.seenAt === 'string' && Number.isFinite(Date.parse(value.seenAt)) ? { selectedId: value.selectedId, seenAt: value.seenAt } : undefined;
  } catch { return undefined; }
}

export function saveResume(storage: StorageSource, value: Resume) {
  try { storage().setItem(resumeStorageKey, JSON.stringify(value)); }
  catch { /* Storage is optional; the workbench falls back to the newest run. */ }
}

/** Runs that ended after the last visit, oldest first. */
export function finishedSince(runs: readonly WebRun[], seenAt: string): WebRun[] {
  const seen = Date.parse(seenAt);
  return runs.filter(run => terminal(run) && Date.parse(run.finishedAt ?? run.updatedAt) > seen)
    .sort((a, b) => (a.finishedAt ?? a.updatedAt).localeCompare(b.finishedAt ?? b.updatedAt));
}

/** Runs that were active in the previous list and have now ended. */
export function newlyFinished(previous: readonly WebRun[], current: readonly WebRun[]): WebRun[] {
  const active = new Set(previous.filter(run => !terminal(run)).map(run => run.id));
  return current.filter(run => active.has(run.id) && terminal(run));
}

/** A plan the owner can approve right now: drafted, not approved, and not being revised from their note. */
export const waitsForOwner = (run: WebRun) => run.status === 'running' &&
  run.observation?.inspection.planApproval?.status === 'pending' && !run.observation.inspection.planApproval.leadRevising;

/** Runs whose plan started waiting for the owner since the previous list; a run first seen already waiting is not new. */
export function newlyWaiting(previous: readonly WebRun[], current: readonly WebRun[]): WebRun[] {
  const before = new Map(previous.map(run => [run.id, run]));
  return current.filter(run => waitsForOwner(run) && before.has(run.id) && !waitsForOwner(before.get(run.id)!));
}

/**
 * A plan waiting for approval holds its run, so it comes before finished runs and the active count. With a run open the
 * tab is named after it (shortened), so two tabs on different runs can be told apart.
 */
export function documentTitle(base: string, active: number, unseen: number, waiting = 0, open = ''): string {
  const characters = [...open.trim()];
  const name = characters.length ? `${characters.length > 30 ? `${characters.slice(0, 29).join('')}…` : characters.join('')} · TheoremOS` : base;
  return waiting ? t('({0}) 等你批准计划 · {1}', waiting, name) : unseen ? t('({0}) 研究已结束 · {1}', unseen, name)
    : active ? t('{0} 项进行中 · {1}', active, name) : name;
}
