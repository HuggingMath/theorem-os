import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureAutoLibraryDemand } from '../src/solver/autoLibraryDemand';
import { autoLibraryPlannerInput } from '../src/math/autoLibraryPlanner';
import { bindMathematicalGap } from '../src/solver/mathematicalGaps';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { commitSolverSources } from '../src/solver/problem';
import { taskVersion, type CooperativeTask } from '../src/solver/tasks';
import type { SolverRunState } from '../src/solver/archive';
import { leadWorker, localExample, solverState } from './helpers/solver';

let directory: string, state: SolverRunState;
beforeEach(() => {
  const example = localExample('auto-library-demand-', 'lead');
  directory = example.directory;
  const worktree = leadWorker(example.problem, example.workspace).worktree;
  const source: CooperativeTask = { id: 'helper', kind: 'lemma', objective: 'Find a smaller recurrence',
    dependsOn: [], revision: 0, proofPath: 'Submission.lean', theoremName: 'Tutorial.helper', type: 'True' };
  const goal: CooperativeTask = { id: 'goal', kind: 'goal', objective: 'Prove original target',
    dependsOn: [], revision: 0, ...example.problem.targets[0] };
  state = solverState(example.problem, example.workspace, { worktree, runId: 'gap-fixture', cooperation: {
    tasks: [source, goal, ...example.problem.targets.slice(1).map((target, index) => ({ ...goal,
      id: `other_goal_${index}`, ...target }))].map(task => ({ task, status: 'running', attempts: 1 })),
    groups: [{ group: { id: 'main', status: 'active', objective: 'Original route', revision: 0 }, turns: 0 }],
  } });
  const gap = { consumer: { taskId: goal.id, taskDigest: taskVersion(goal) }, previousGap: 'No recurrence',
    reduced: 'The base case is checked', remaining: 'Need the induction step', evidenceScope: 'Fixed consumer definitions',
    reconsiderWhen: ['A usable recurrence is proved'] };
  const finding = JSON.stringify({ taskId: source.id, taskDigest: taskVersion(source), conclusion: 'inconclusive', summary: 'Missing recurrence',
    mathematicalGap: gap, lemmaRequests: [{ id: 'recurrence', kind: 'lemma', objective: 'Prove the smaller step and apply to goal',
      theoremName: 'Tutorial.recurrence', proofPath: 'Submission.lean', type: '∀ n : Nat, n + 0 = n', dependsOn: [] }] });
  fs.writeFileSync(path.join(worktree, 'RESEARCH.md'), finding);
  const commit = commitSolverSources(example.problem, worktree);
  state.cooperation!.deliveries = [{ id: 'gap', taskId: source.id, taskDigest: taskVersion(source), producer: 'engineer', kind: 'research',
    status: 'advisory', summary: 'Missing recurrence', statement: '', premises: [], dependencies: [], remainingObligations: ['induction'],
    evidenceRefs: ['pinned-lemma-search'], createdAt: 1, finding, findingDigest: mathDigest(finding), commit,
    mathematicalGap: gap, mathematicalGapScope: bindMathematicalGap(gap, source, state.cooperation!,
      { problemReceiptDigest: example.problem.receiptDigest, environmentDigest: state.environmentDigest }) }];
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

describe('source-bound library demand', () => {
  it('captures a proof worker gap with typed requests and includes it in the planner identity', () => {
    const before = structuredClone(state), demand = captureAutoLibraryDemand(state, 'gap');
    expect(demand).toMatchObject({ runId: state.runId, deliveryId: 'gap', gap: { remaining: 'Need the induction step' },
      source: { taskId: 'helper' }, consumer: { taskId: 'goal' }, lemmaRequests: [{ id: 'recurrence', type: '∀ n : Nat, n + 0 = n' }] });
    const input = { challengeId: 'fixture', challenge: state.problem.contract.formalStatement, task: '', environment: 'standard',
      library: [], taken: [], module: 0, round: 1, maxRounds: 3 };
    const withDemand = autoLibraryPlannerInput({ ...input, demand });
    expect(withDemand.demand).toEqual(demand);
    expect(withDemand.inputDigest).not.toBe(autoLibraryPlannerInput(input).inputDigest);
    for (const changed of [{ ...demand, environmentDigest: 'changed' }, { ...demand, gap: { ...demand.gap, remaining: 'New gap' } },
      { ...demand, lemmaRequests: [] }])
      expect(autoLibraryPlannerInput({ ...input, demand: changed }).inputDigest).not.toBe(withDemand.inputDigest);
    expect(state).toEqual(before);
  });

  it.each(['stale-goal', 'changed-environment', 'private-source', 'bad-finding-hash', 'forged-report'] as const)(
    'rejects a %s demand', change => {
      const archive = state.cooperation!, delivery = archive.deliveries![0];
      if (change === 'stale-goal') archive.tasks[1].task = { ...archive.tasks[1].task, revision: 1 };
      if (change === 'changed-environment') state.environmentDigest = 'changed';
      if (change === 'private-source') {
        archive.tasks[0].task = { ...archive.tasks[0].task, sharing: 'group' };
        delivery.mathematicalGapScope!.source = archive.tasks[0].task;
        delivery.taskDigest = taskVersion(archive.tasks[0].task);
      }
      if (change === 'bad-finding-hash') delivery.findingDigest = '0'.repeat(64);
      if (change === 'forged-report') {
        delivery.finding = JSON.stringify({ ...JSON.parse(delivery.finding!), summary: 'Forged summary' });
        delivery.findingDigest = mathDigest(delivery.finding);
      }
      expect(() => captureAutoLibraryDemand(state, 'gap')).toThrow(/auto_library_demand_/u);
    });
});
