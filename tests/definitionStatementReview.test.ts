import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LeanStatementContext } from '../src/math/leanStatementContext';
import type { SolverRunState } from '../src/solver/archive';
import type { CooperativeResearch } from '../src/solver/cooperation';
import type { SolverProblem } from '../src/solver/problem';
import type { CooperativeTask, TaskRecord } from '../src/solver/tasks';
import { cooperativeResearch } from './helpers/cooperation';
import { leadWorker, localExample, solverState } from './helpers/solver';

const host = vi.hoisted(() => ({ capture: vi.fn(), sessions: vi.fn() }));
vi.mock('../src/solver/statementReview', async importOriginal => ({
  ...await importOriginal<typeof import('../src/solver/statementReview')>(), captureStatementContexts: host.capture,
}));
vi.mock('../src/runtime/codexSession', () => ({ createCodexMathSession: host.sessions }));

describe('statement review of a lemma that names a planned definition', () => {
  let directory: string, problem: SolverProblem, state: SolverRunState, cooperative: CooperativeResearch, controller: AbortController;
  let nodes: TaskRecord[];
  const context = (task: CooperativeTask): LeanStatementContext => ({ type: task.type!, constants: [], omitted: [] });

  beforeEach(() => {
    host.capture.mockReset().mockImplementation(async (_problem: SolverProblem, requested: CooperativeTask[]) =>
      new Map(requested.map(task => [task.id, context(task)])));
    host.sessions.mockReset().mockImplementation(() => { throw new Error('fixture_real_models_forbidden'); });
    let workspace: string;
    ({ directory, workspace, problem } = localExample('definition-statement-review-'));
    const tasks: CooperativeTask[] = [
      { id: 'double', kind: 'lemma', declaration: 'definition', objective: 'Twice a natural number.', type: 'Nat → Nat',
        theoremName: 'Tutorial.double', proofPath: 'Submission.lean', dependsOn: [], revision: 0 },
      { id: 'double_zero', kind: 'lemma', objective: 'double vanishes at zero.', type: 'double 0 = 0',
        theoremName: 'Tutorial.double_zero', proofPath: 'Submission.lean', dependsOn: ['double'], revision: 0,
        statementReview: true, informalStatement: 'Twice zero is zero.' },
      { id: 'plain', kind: 'lemma', objective: 'An unrelated helper.', type: 'True',
        theoremName: 'Tutorial.plain', proofPath: 'Submission.lean', dependsOn: [], revision: 0,
        statementReview: true, informalStatement: 'Truth holds.' },
    ];
    nodes = tasks.map(task => ({ task, status: 'pending', attempts: 0 }));
    state = solverState(problem, workspace, { runId: 'definition-statement-review', phase: 'running', environmentDigest: 'environment',
      cooperation: { canonicalCommit: problem.baseCommit, tasks: nodes } });
    controller = new AbortController();
    cooperative = cooperativeResearch({ state, workers: [leadWorker(problem, workspace, 'lead')], retrievalRoot: directory,
      signal: controller.signal, exclusiveCheck: operation => operation() });
  });
  afterEach(async () => {
    controller?.abort(); await cooperative?.stop(); expect(host.sessions).not.toHaveBeenCalled();
    vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true });
  });

  it('elaborates and requests its review only after the definition is integrated', async () => {
    await (cooperative as any).prepareStatementContexts();
    expect(host.capture).toHaveBeenCalledOnce();
    expect(host.capture.mock.calls[0][1].map((task: CooperativeTask) => task.id)).toEqual(['plain']);
    (cooperative as any).syncStatementReviews();
    expect(state.cooperation!.statementReviews!.map(review => review.taskId)).toEqual(['plain']);

    nodes[0].status = 'integrated';
    await (cooperative as any).prepareStatementContexts();
    expect(host.capture).toHaveBeenCalledTimes(2);
    expect(host.capture.mock.calls[1][1].map((task: CooperativeTask) => task.id)).toEqual(['double_zero']);
    (cooperative as any).syncStatementReviews();
    expect(state.cooperation!.statementReviews!.filter(review => review.status !== 'superseded').map(review => review.taskId).sort())
      .toEqual(['double_zero', 'plain']);
  });

  it('supersedes the review when the definition leaves the canonical graph', async () => {
    nodes[0].status = 'integrated';
    await (cooperative as any).prepareStatementContexts();
    (cooperative as any).syncStatementReviews();
    const review = state.cooperation!.statementReviews!.find(item => item.taskId === 'double_zero')!;
    expect(review.status).toBe('pending');
    nodes[0].status = 'pending';
    (cooperative as any).syncStatementReviews();
    expect(review.status).toBe('superseded');
    expect(state.cooperation!.statementReviews!.filter(item => item.taskId === 'double_zero' && item.status !== 'superseded')).toEqual([]);
  });
});
