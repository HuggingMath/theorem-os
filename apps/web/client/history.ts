import type { WebRun } from '../shared';
import { isAcceptedRun, isFaultedRun } from '../presentation';
import { t } from '../i18n';

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
