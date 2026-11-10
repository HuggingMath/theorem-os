import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SolverRunState } from '../src/solver/archive';
import type { CooperativeResearch } from '../src/solver/cooperation';
import { directSolverModules } from '../src/solver/modules';
import type { ResearchWorker } from '../src/solver/modules/organization';
import { commitSolverSources } from '../src/solver/problem';
import { recordRouteBlockers, refreshRouteBlockers, validateBlockerProposals } from '../src/solver/routeControl';
import { checkSolverRunState } from '../src/solver/stateInvariants';
import { taskConnectionCheckCurrent } from '../src/solver/taskConnections';
import { parseCooperationPlan, taskVersion, type CooperativeAction } from '../src/solver/tasks';
import { cooperativeResearch } from './helpers/cooperation';
import { leadWorker, localExample, peerWorker, solverState } from './helpers/solver';

type TaskAction = Extract<CooperativeAction, { kind: 'task' }>;

describe('assignment reservation cleanup', () => {
  const budget = { maxTurns: Infinity, remainingMs: Infinity };
  let directory: string, state: SolverRunState, cooperative: CooperativeResearch;
  let lead: ResearchWorker, engineer: ResearchWorker, sourceWorker: ResearchWorker;
  const node = (id: string) => state.cooperation!.tasks.find(item => item.task.id === id)!;
  const group = () => state.cooperation!.groups![0];
  const next = async () => {
    const action = await cooperative.next(engineer, budget);
    if (action?.kind !== 'task') throw new Error('fixture_expected_task');
    return action;
  };
  const retain = (action: TaskAction) => {
    fs.writeFileSync(path.join(engineer.worktree, 'RESEARCH.md'), 'Retained route and exact remaining inference.\n');
    const commit = commitSolverSources(state.problem, engineer.worktree);
    cooperative.retainContextDraft(engineer, action, commit);
    return state.cooperation!.researchDrafts![action.task.id];
  };

  beforeEach(() => {
    const example = localExample('solver-assignment-release-', 'lead');
    directory = example.directory;
    lead = leadWorker(example.problem, example.workspace);
    engineer = peerWorker(example, 'engineer', { role: 'engineer' });
    sourceWorker = peerWorker(example, 'source');
    const plan = parseCooperationPlan(example.problem, { tasks: [
      { id: 'prior', kind: 'research', objective: 'Prior mathematical evidence.', ownerId: sourceWorker.id },
      { id: 'investigate', kind: 'research', objective: 'Investigate the exact remaining inference.',
        ownerId: engineer.id, dependsOn: ['prior'] },
      ...example.problem.targets.map((target, index) => ({ id: `goal_${index}`, kind: 'goal', objective: 'Original target.',
        theoremName: target.theoremName, proofPath: target.proofPath, status: 'paused' })),
    ], groups: [{ id: 'main', objective: 'Original problem.', maxConcurrent: 1, engineerId: engineer.id }] });
    state = solverState(example.problem, example.workspace, { runId: 'assignment-release-fixture', phase: 'running',
      workers: [lead, engineer, sourceWorker].map(worker => ({ ...worker, phase: 'running', turns: 0 })),
      cooperation: { canonicalCommit: example.problem.baseCommit,
        tasks: plan.tasks.map(task => ({ task, status: task.id === 'prior' ? 'completed' : 'pending', attempts: 0 })),
        groups: plan.groups.map(group => ({ group, turns: 0 })) } });
    const forbidden = () => { throw new Error('fixture_model_or_verifier_forbidden'); };
    cooperative = cooperativeResearch({ state, workers: [lead, engineer, sourceWorker], retrievalRoot: directory,
      modules: { ...directSolverModules, M1: { ...directSolverModules.M1, open: forbidden },
        M2: { ...directSolverModules.M2, check: forbidden, checkTask: forbidden } } });
  });
  afterEach(async () => {
    await cooperative.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it.each(['release', 'interrupted'] as const)(
    'reclaims a superseded %s reservation and keeps its draft available for inspection', async cleanup => {
      const action = await next();
      if (cleanup === 'interrupted') expect(cooperative.started(engineer, action)).toBe(true);
      const draft = retain(action);
      expect(node('investigate').status).toBe('running');
      expect(group()?.busy).toBe(1);
      node('prior').task = { ...node('prior').task, revision: node('prior').task.revision + 1 };
      expect(cooperative.current(action)).toBe(false);
      expect(cooperative.started(engineer, action)).toBe(false);

      cooperative[cleanup](engineer, action);

      expect(node('investigate').status).toBe('pending');
      expect(node('investigate').assignment).toBeUndefined();
      expect(group()?.busy).toBe(0);
      expect(state.cooperation!.researchDrafts!.investigate).toBe(draft);
      expect(checkSolverRunState(state).filter(item => item.code === 'worker_multiple_running_tasks')).toEqual([]);
      const successor = await next();
      expect(successor.task.id).toBe('investigate');
      expect(successor.assignment).not.toBe(action.assignment);
      expect(successor.assignment.dependencies).toEqual([{ taskId: 'prior', taskDigest: taskVersion(node('prior').task) }]);
      expect(cooperative.started(engineer, successor)).toBe(true);

      // A delayed callback for the old dispatch cannot revoke the new writer.
      cooperative[cleanup](engineer, action);
      expect(node('investigate').status).toBe('running');
      expect(node('investigate').assignment).toBe(successor.assignment);
      expect(group()?.busy).toBe(1);
    });

  it('does not release a matching-looking assignment object owned by a newer dispatch', async () => {
    const action = await next();
    const successor = { ...action.assignment, assignmentId: 'successor' };
    node('investigate').assignment = successor;
    cooperative.release(engineer, action);
    cooperative.interrupted(engineer, action);
    expect(node('investigate')).toMatchObject({ status: 'running', assignment: successor });
  });

  it('ignores cleanup by another worker or for a removed task', async () => {
    const action = await next();
    cooperative.release(sourceWorker, action);
    cooperative.interrupted(sourceWorker, action);
    expect(node('investigate').status).toBe('running');
    state.cooperation!.tasks = state.cooperation!.tasks.filter(item => item.task.id !== action.task.id);
    expect(() => cooperative.release(engineer, action)).not.toThrow();
    expect(() => cooperative.interrupted(engineer, action)).not.toThrow();
  });

  it('renews a conditional connection when restoring a draft onto newer canonical sources', async () => {
    node('investigate').task = { ...node('investigate').task, status: 'paused' };
    node('prior').task = { ...node('prior').task, kind: 'lemma', type: 'True',
      theoremName: 'Tutorial.input', proofPath: 'Submission.lean' };
    node('prior').status = 'pending';
    node('goal_0').task = { ...node('goal_0').task, status: 'active', ownerId: engineer.id, dependsOn: ['prior'] };
    const action = await next();
    expect(action.task.id).toBe('goal_0');
    expect(taskConnectionCheckCurrent(action.task, action.assignment, state.cooperation!.tasks)).toBe(true);
    const draft = retain(action);
    cooperative.interrupted(engineer, action);
    draft.suspended = true;
    const canonicalFile = path.join(lead.worktree, state.problem.projectRelative, 'Submission.lean');
    fs.appendFileSync(canonicalFile, '\n-- Canonical sources advanced while this task was suspended.\n');
    state.cooperation!.canonicalCommit = commitSolverSources(state.problem, lead.worktree);

    const resumed = await next();

    expect(resumed.assignment.assignmentId).not.toBe(action.assignment.assignmentId);
    expect(resumed.assignment.seedCommit).not.toBe(action.assignment.seedCommit);
    expect(resumed.assignment.connectionCheck).toMatchObject({ assignmentId: resumed.assignment.assignmentId,
      seedCommit: resumed.assignment.seedCommit, workerId: engineer.id });
    expect(taskConnectionCheckCurrent(resumed.task, resumed.assignment, state.cooperation!.tasks)).toBe(true);
    expect(cooperative.current(resumed)).toBe(true);
    expect(state.cooperation!.researchDrafts!.goal_0.assignmentId).toBe(resumed.assignment.assignmentId);
    expect(cooperative.started(engineer, resumed)).toBe(true);
    expect(fs.readFileSync(path.join(engineer.worktree, 'RESEARCH.md'), 'utf8')).toContain('Retained route');
  });

  it('dispatches a revised research question after a formal plan edit without discarding typed obstruction history', async () => {
    await cooperative.pulse();
    // Dispatch initializes the same versioned plan used by the normal edit queue.
    const initial = await next();
    cooperative.release(engineer, initial);
    const records = state.cooperation!.blockers ??= [];
    for (const item of [node('investigate'), node('goal_0')]) {
      const proposals = validateBlockerProposals([{ mechanism: 'unchanged-research-checkpoint',
        scope: 'assigned-local-inference/checkpoint:previous-output' }], item.task, state.cooperation!.tasks);
      for (let count = 0; count < 2; count++) recordRouteBlockers(records, proposals, item.task,
        state.cooperation!.tasks, state.environmentDigest, state.problem.receiptDigest);
    }
    refreshRouteBlockers(records, state.cooperation!.tasks, state.environmentDigest, state.problem.receiptDigest);
    expect(node('investigate').routeParking).toHaveLength(1);
    expect(node('goal_0').routeParking).toHaveLength(1);
    const revised = { ...node('investigate').task, revision: 1,
      objective: 'Find the exact bounded averaging lemma and its application to the remaining operator norm estimate.' };
    fs.appendFileSync(path.join(directory, 'edits.jsonl'), JSON.stringify({ id: 'new-research-input',
      baseVersion: state.cooperation!.planVersion,
      tasks: state.cooperation!.tasks.map(item => item.task.id === revised.id ? revised : item.task),
      groups: state.cooperation!.groups!.map(item => item.group) }) + '\n');

    await cooperative.pulse();

    const edit = state.cooperation!.edits!.at(-1)!;
    expect(edit.status, edit.reason).toBe('applied');
    expect(node('investigate')).toMatchObject({ status: 'pending', task: { revision: 1 }, routeParking: [] });
    expect(records.find(record => record.taskId === revised.id)).toMatchObject({ status: 'reopened', reopenedReason: 'contract-changed' });
    expect(records.find(record => record.taskId === 'goal_0')).toMatchObject({ status: 'parked', count: 2 });
    expect(node('goal_0').routeParking).toHaveLength(1);
    expect((await next()).task.id).toBe(revised.id);
  });
});
