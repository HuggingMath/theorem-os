import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCooperationPlan, type CooperativeResearch } from '../src/solver/cooperation';
import type { SolverRunState } from '../src/solver/archive';
import { checkSolverRunState } from '../src/solver/stateInvariants';
import { MAX_INVALID_TASK_TRANSITIONS } from '../src/solver/taskLifecycle';
import { cooperativeResearch } from './helpers/cooperation';
import { leadWorker, localExample, peerWorker, solverState } from './helpers/solver';

describe('live task transitions', () => {
  let directory: string, state: SolverRunState, cooperative: CooperativeResearch, emit: ReturnType<typeof vi.fn>;
  const controller = new AbortController();
  const start = () => {
    const example = localExample('solver-task-lifecycle-', 'lead'), { workspace, problem } = example;
    directory = example.directory;
    const workers = [leadWorker(problem, workspace, 'lead'), peerWorker(example, 'proof')];
    const parsed = parseCooperationPlan(problem, { tasks: [{ id: 'helper', kind: 'lemma', objective: 'Prove helper',
      theoremName: 'Tutorial.helper', type: 'True', proofPath: 'Submission.lean', ownerId: 'proof' },
    ...problem.targets.map((target, index) => ({ id: `original_goal_${index + 1}`, kind: 'goal', objective: 'Original',
      theoremName: target.theoremName, proofPath: target.proofPath, status: 'paused' }))] });
    state = solverState(problem, workspace, { runId: 'lifecycle-fixture', phase: 'running', cooperation: {
      canonicalCommit: problem.baseCommit, tasks: parsed.tasks.map(task => ({ task, status: 'pending', attempts: 0 })) } });
    emit = vi.fn();
    cooperative = cooperativeResearch({ state, workers, retrievalRoot: directory, signal: controller.signal, emit });
  };
  const move = (...args: unknown[]) => (cooperative as any).moveTask(...args);
  afterEach(async () => { await cooperative.stop(); fs.rmSync(directory, { recursive: true, force: true }); });

  it('applies an illegal change but records and reports it at the mutation site', () => {
    start();
    const node = state.cooperation!.tasks[0];
    move(node, 'running', 'dispatched');
    expect(state.cooperation!.invalidTaskTransitions).toBeUndefined();
    move(node, 'completed', 'research-completed');
    move(node, 'running', 'dispatched');
    expect(node.status).toBe('running');
    const record = { taskId: 'helper', from: 'completed', to: 'running', cause: 'dispatched' };
    expect(state.cooperation!.invalidTaskTransitions).toEqual([expect.objectContaining(record)]);
    expect(emit).toHaveBeenCalledWith('task_transition_invalid', expect.objectContaining(record));
    expect(checkSolverRunState(state).map(item => item.code)).toContain('task_transition_invalid');
  });

  it('does not record changes to staged copies and keeps only the latest records', () => {
    start();
    const node = state.cooperation!.tasks[0];
    move({ ...node, status: 'completed' }, 'running', 'dispatched');
    expect(state.cooperation!.invalidTaskTransitions).toBeUndefined();
    for (let index = 0; index <= MAX_INVALID_TASK_TRANSITIONS; index++) {
      move(node, 'completed', 'research-completed'); move(node, 'running', 'dispatched');
    }
    expect(state.cooperation!.invalidTaskTransitions).toHaveLength(MAX_INVALID_TASK_TRANSITIONS);
  });
});
