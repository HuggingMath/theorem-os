import { describe, expect, it } from 'vitest';
import type { WebRun } from '../apps/web/shared';
import { webLimits } from '../apps/web/shared';
import { compareResearchRuns, recoveryDescription, relatedResearchRuns } from '../apps/web/client/productFlow';
import { loadWebSample } from '../apps/web/sample';

const run = (change: Partial<WebRun> = {}): WebRun => ({
  id: 'run-a', title: 'Same display title', status: 'completed', phase: 'finished',
  createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:01:00.000Z',
  providerId: 'local', model: 'fixture', effort: 'low', environment: 'standard',
  source: 'theorem goal : True := by sorry', task: 'Prove the original statement', maxTurns: 2,
  maxRunSeconds: 600, workers: 2, coordination: 'cooperative', events: [], ...change,
});

describe('research comparison and continuation decisions', () => {
  it('compares exact problems without using titles as identity, and retains explicit changed-statement lineage', () => {
    const current = run(), same = run({ id: 'same', title: 'A new title' });
    const changed = run({ id: 'changed', source: 'theorem other : False := by sorry' });
    const environment = run({ id: 'environment', environment: 'mathlib' });
    const continued = run({ ...changed, id: 'continued', continueFrom: { runId: current.id, taskId: 'goal', commit: 'abc', label: 'saved version' } });
    expect(relatedResearchRuns([current, same, changed, environment, continued], current).map(item => item.id)).toEqual(['same', 'continued']);
    expect(compareResearchRuns(current, continued).comparable).toBe(false);
    expect(compareResearchRuns(current, same).comparable).toBe(true);
    expect(compareResearchRuns(current, run({ id: 'other', formalization: { id: 'formal', evidenceSha256: 'digest', original: 'a different original meaning', confirmedAt: current.createdAt } })).comparable).toBe(false);
  });

  it('keeps missing token use and goal progress unknown instead of showing zero or success', () => {
    const comparison = compareResearchRuns(run(), run({ id: 'b' }));
    expect(comparison.rows.find(row => row.label === '证明用量')).toMatchObject({ before: '未记录', after: '未记录' });
    expect(comparison.rows.find(row => row.label === '目标进展')).toMatchObject({ before: '未记录', after: '未记录' });
    expect(JSON.stringify(comparison)).not.toMatch(/NaN|undefined/u);
  });

  it('shows actual task and dependency changes while preserving the independent acceptance boundary', () => {
    const recorded = loadWebSample()!.run, before = structuredClone(recorded), after = structuredClone(recorded);
    before.id = 'before'; after.id = 'after';
    expect(after.observation?.plan?.tasks.length).toBeGreaterThan(0);
    after.observation!.plan!.tasks[0]!.dependsOn = ['a-new-prerequisite'];
    after.result = { status: 'limit_reached', proof: '', report: {} };
    const comparison = compareResearchRuns(before, after);
    expect(comparison.changedTasks).toContainEqual({ id: after.observation!.plan!.tasks[0]!.id,
      label: after.observation!.plan!.tasks[0]!.theoremName || after.observation!.plan!.tasks[0]!.id, kind: 'changed' });
    const progress = comparison.rows.find(row => row.label === '目标进展')!;
    expect(progress.before).toContain('已证明');
    expect(progress.after).not.toContain('已证明');
  });

  it('describes the real capped recovery limit and distinguishes carried reference code from acceptance', () => {
    const item = run();
    const limits = { ...webLimits, maxRunSeconds: 900 };
    const description = recoveryDescription(item, { id: 'budget', label: 'increase' }, limits);
    expect(description).toContain('10 分钟'); expect(description).toContain('15 分钟');
    expect(recoveryDescription(item, { id: 'turns', label: 'increase' }, { ...limits, maxTurns: 3 })).toContain('预填为 3');
    const checked = recoveryDescription(item, { id: 'continue-checked', label: 'continue', tasks: ['helper'] }, limits);
    expect(checked).toContain('helper'); expect(checked).toContain('作为参考'); expect(checked).toContain('重新检查');
    expect(recoveryDescription(item, { id: 'ask-failed', label: 'inspect', tasks: ['goal'] })).toContain('不启动新研究');
  });
});
