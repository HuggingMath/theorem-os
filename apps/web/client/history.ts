import type { WebRun } from '../shared';
import { isAcceptedRun, isFaultedRun } from '../presentation';
import { t } from '../i18n';
import { waitsForOwner } from './runAwareness';

export type RunFilter = 'all' | 'active' | 'passed' | 'unproved' | 'cancelled' | 'error';

export function filterRuns(runs: readonly WebRun[], query: string, filter: RunFilter): WebRun[] {
  const terms = query.normalize('NFKC').toLowerCase().trim().split(/\s+/).filter(Boolean);
  return runs.filter(run => {
    // The same split as the history badges: a run whose provider or environment failed shows 运行失败 and is listed with the errors.
    const accepted = isAcceptedRun(run), faulted = isFaultedRun(run);
    const matchesStatus = filter === 'all'
      || filter === 'active' && (run.status === 'queued' || run.status === 'running')
      || filter === 'passed' && accepted
      || filter === 'unproved' && run.status === 'completed' && !accepted && !faulted
      || filter === 'cancelled' && run.status === 'cancelled'
      || filter === 'error' && faulted;
    if (!matchesStatus) return false;
    const searchable = [run.title, run.task, run.model, run.id, run.source,
      run.environment === 'mathlib' ? t('Mathlib 数学库') : t('Lean 标准库')].join('\n').normalize('NFKC').toLowerCase();
    return terms.every(term => searchable.includes(term));
  });
}

/** The history's two groups: runs whose plan waits for the owner's approval come first, each group keeping its order. */
export function ownerFirst(runs: readonly WebRun[]): { waiting: WebRun[]; others: WebRun[] } {
  const waiting: WebRun[] = [], others: WebRun[] = [];
  for (const run of runs) (waitsForOwner(run) ? waiting : others).push(run);
  return { waiting, others };
}

/** The runs started from a version of run `id` (从这一版继续), oldest first: what came of the problem afterwards. */
export function continuationsOf(runs: readonly WebRun[], id: string): WebRun[] {
  return runs.filter(run => run.continueFrom?.runId === id && run.id !== id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
