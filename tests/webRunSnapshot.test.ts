import { describe, expect, it } from 'vitest';
import type { WebRun } from '../apps/web/shared';
import type { WebObservation } from '../apps/web/collaboration';
import { retainLatestRun } from '../apps/web/client/runSnapshot';

const at = (second: number) => new Date(Date.UTC(2026, 10, 9, 0, 0, second)).toISOString();
const observation = (solverRunId: string, sequence: number, status = 'pending') => ({
  solverRunId, sequence, inspection: { planApproval: { status } },
} as WebObservation);
const run = (changes: Partial<WebRun> = {}): WebRun => ({
  id: 'research', title: 'Prove True', status: 'running', phase: 'cooperative',
  createdAt: at(0), updatedAt: at(1), providerId: 'openai', model: 'fixture', effort: 'low', environment: 'standard',
  source: 'theorem original : True := by sorry', task: 'Prove True', maxTurns: 2, maxRunSeconds: 60, workers: 1,
  coordination: 'cooperative', events: [], ...changes,
});

describe('shared workbench run snapshots', () => {
  it('keeps a plan approved while an older chat response arrives', () => {
    const old = run({ solverAttempt: { solverRunId: 'solver', round: 0, sequence: 2 }, observation: observation('solver', 2) });
    const current = run({ updatedAt: at(2), solverAttempt: { solverRunId: 'solver', round: 0, sequence: 3 },
      observation: observation('solver', 3, 'approved') });
    expect(retainLatestRun(old, current).observation?.inspection.planApproval?.status).toBe('approved');
    expect(retainLatestRun(current, old).observation?.sequence).toBe(3);
  });

  it('keeps completion and its proof when a delayed running response arrives', () => {
    const old = run();
    const completed = run({ status: 'completed', phase: 'evaluated_passed', updatedAt: at(3), finishedAt: at(3),
      result: { status: 'evaluated_passed', proof: 'theorem original : True := by trivial', report: {} } });
    expect(retainLatestRun(old, completed)).toMatchObject({ status: 'completed', finishedAt: at(3), result: completed.result });
  });

  it('accepts host-declared restarts without carrying the previous solver observation', () => {
    const old = run({ solverAttempt: { solverRunId: 'first', round: 0, sequence: 4 }, observation: observation('first', 4) });
    const restarted = run({ solverAttempt: { solverRunId: 'next', round: 1, sequence: 4 } });
    const current = retainLatestRun(restarted, old);
    expect(current.solverAttempt?.solverRunId).toBe('next');
    expect(current.observation).toBeUndefined();
    expect(retainLatestRun(old, current).solverAttempt?.solverRunId).toBe('next');
    expect(retainLatestRun(old, current).observation).toBeUndefined();
  });

  it('ignores observations from another solver without a host declaration', () => {
    const current = run({ solverAttempt: { solverRunId: 'current', round: 1, sequence: 5 }, observation: observation('current', 5) });
    const unexpected = run({ observation: observation('other', 100) });
    expect(retainLatestRun(unexpected, current).observation?.solverRunId).toBe('current');
  });

  it('starts a different research from its own snapshot', () => {
    const previous = run({ updatedAt: at(10), observation: observation('first', 10) });
    const next = run({ id: 'another-research' });
    expect(retainLatestRun(next, previous)).toBe(next);
  });
});
