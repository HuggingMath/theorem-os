import { describe, expect, it } from 'vitest';
import { answerGoalProgress, observeGoalProgress, parseGoalProgressDecision, resetGoalProgressClock,
  type GoalProgressState } from '../src/solver/goalProgress';
import { captureObligationSnapshot } from '../src/solver/obligationProgress';
import { taskVersion, type TaskRecord } from '../src/solver/tasks';
import { integratedProof } from './helpers/taskProof';

const node = (id: string, kind: 'goal' | 'lemma' = 'lemma', dependsOn: string[] = []): TaskRecord => ({
  task: { id, kind, objective: id, dependsOn, revision: 1, proofPath: 'Main.lean', theoremName: id,
    type: '∀ n : Nat, n + 0 = n' }, status: 'pending', attempts: 0 });
function fixture() {
  const helper = node('helper'), goal = node('original', 'goal', ['helper']);
  const tasks = [goal, helper], targets = [{ proofPath: 'Main.lean', theoremName: 'original' }];
  let state: GoalProgressState | undefined;
  const observe = (now: number, active: string[] = ['helper']) => {
    const result = observeGoalProgress(state, { targets, tasks, problemReceiptDigest: 'frozen',
      snapshot: captureObligationSnapshot(tasks, { environmentDigest: 'environment' }),
      activeTaskIds: new Set(active), now, intervalMs: 100 });
    state = result.state; return result;
  };
  return { tasks, helper, goal, observe, state: () => state! };
}

describe('goal progress observation', () => {
  it('requests one review while a goal path is busy without checked progress', () => {
    const f = fixture(); f.observe(0);
    expect(f.observe(99).requested).toBe(false);
    expect(f.observe(100).requested).toBe(true);
    const pending = f.state().pending;
    expect(pending?.goalIds).toEqual(['original']);
    expect(f.observe(500).requested).toBe(false);
    expect(f.state().pending).toBe(pending);
    expect(f.state().goals[0].closed).toBe(false);
  });

  it('does not count running labels, idle time or offline downtime', () => {
    const f = fixture(); f.observe(0); f.observe(40, []);
    f.helper.status = 'running';
    expect(f.observe(10_000, []).state.goals[0].activeMs).toBe(40);
    const restored = JSON.parse(JSON.stringify(f.state())); resetGoalProgressClock(restored, 20_000);
    const resumed = observeGoalProgress(restored, { problemReceiptDigest: 'frozen',
      targets: [{ proofPath: 'Main.lean', theoremName: 'original' }], tasks: f.tasks,
      snapshot: captureObligationSnapshot(f.tasks), activeTaskIds: new Set(['helper']), now: 20_000, intervalMs: 100 });
    expect(resumed.state.goals[0].activeMs).toBe(40);
    expect(observeGoalProgress(resumed.state, { problemReceiptDigest: 'frozen',
      targets: [{ proofPath: 'Main.lean', theoremName: 'original' }], tasks: f.tasks,
      snapshot: captureObligationSnapshot(f.tasks), activeTaskIds: new Set(['helper']), now: 20_060, intervalMs: 100 }).requested).toBe(true);
  });

  it('ignores description revisions, task renaming, advisory findings and off-path proofs', () => {
    const f = fixture(); f.observe(0);
    f.goal.task = { ...f.goal.task, id: 'renamed-task', revision: 8, objective: 'New prose' };
    const offPath = node('unrelated'); integratedProof(offPath); f.tasks.push(offPath);
    f.tasks.push({ ...node('notes'), task: { ...node('notes').task, kind: 'research' }, status: 'completed', finding: 'A new note.' });
    expect(f.observe(100).requested).toBe(true);
    expect(f.state().pending?.goalIds).toEqual(['renamed-task']);
  });

  it('respects a deliberately paused original goal while shared supporting work continues', () => {
    const f = fixture(); f.goal.task.status = 'paused'; f.observe(0);
    expect(f.observe(10_000).requested).toBe(false);
    expect(f.state().goals[0].activeMs).toBe(0);
    f.goal.task.status = 'active'; f.observe(10_000);
    expect(f.observe(10_100).requested).toBe(true);
  });

  it('restarts only for new relevant checked inputs, preserving seen evidence across loss and replay', () => {
    const f = fixture(); f.observe(0); f.observe(70);
    integratedProof(f.helper);
    expect(f.observe(80).resumed).toEqual(['original']);
    expect(f.state().goals[0].activeMs).toBe(0);
    const proof = f.helper.integratedCheck; f.helper.integratedCheck = undefined;
    f.observe(100); f.helper.integratedCheck = proof;
    expect(f.observe(150).resumed).toEqual([]);
    // A new receipt id for the same mathematical proof is the same input.
    integratedProof(f.helper, { receiptId: 'replayed-receipt' });
    expect(f.observe(180).requested).toBe(true);
  });

  it('does not restart for a rechecked helper with a new name or objective', () => {
    const f = fixture(); integratedProof(f.helper); f.observe(0);
    f.helper.task = { ...f.helper.task, theoremName: 'same_math_new_name', objective: 'rephrased', revision: 2 };
    integratedProof(f.helper, { receiptId: 'different-receipt' });
    expect(f.observe(100).requested).toBe(true);
  });

  it('records newly reduced checked conditions as progress without accepting the original', () => {
    const f = fixture(), premise = node('premise'); f.tasks.push(premise);
    const proof = integratedProof(f.helper);
    proof.conditions = [{ taskId: premise.task.id, taskDigest: taskVersion(premise.task) }];
    f.observe(0); f.observe(80);
    proof.conditions = [];
    expect(f.observe(90).resumed).toEqual(['original']);
    expect(f.state().goals[0]).toMatchObject({ activeMs: 0, closed: false });
    expect(f.observe(190).requested).toBe(true);
  });

  it('keeps clocks per frozen goal and one coalesced pending review', () => {
    const f = fixture(), second = node('second', 'goal');
    f.tasks.push(second);
    const targets = [f.goal.task, second.task].map(({ proofPath, theoremName }) => ({ proofPath: proofPath!, theoremName: theoremName! }));
    let state: GoalProgressState | undefined;
    const observe = (now: number) => {
      const result = observeGoalProgress(state, { problemReceiptDigest: 'frozen', targets, tasks: f.tasks,
        snapshot: captureObligationSnapshot(f.tasks, { environmentDigest: 'environment' }),
        activeTaskIds: new Set(['helper', 'second']), now, intervalMs: 100 }); state = result.state; return result;
    };
    observe(0); integratedProof(f.helper); observe(60);
    expect(observe(100).state.pending?.goalIds).toEqual(['second']);
    const result = observe(160);
    expect(result.requested).toBe(false);
    expect(result.nextDelayMs).toBeUndefined();
    expect(answerGoalProgress(state!, { id: state!.pending!.id, reason: 'Retain this route and check the induction step.' }, 160)).toBe(true);
    expect(observe(160).state.pending?.goalIds).toEqual(['original']);
  });

  it('requires an explicit current review answer and cancels a review on real progress', () => {
    const f = fixture(); f.observe(0); f.observe(100);
    expect(answerGoalProgress(f.state(), { id: 'old-review', reason: 'obsolete' }, 101)).toBe(false);
    integratedProof(f.helper); f.observe(110);
    expect(f.state().pending).toBeUndefined();
    expect(f.state().decisions).toBeUndefined();
    expect(parseGoalProgressDecision({ progressReview: { id: 'current', reason: 'Keep the proof; verify the base case.' } }))
      .toEqual({ id: 'current', reason: 'Keep the proof; verify the base case.' });
    expect(() => parseGoalProgressDecision({ progressReview: { id: 'current', reason: ' ' } })).toThrow('math_plan_progress_review_invalid');
  });
});
