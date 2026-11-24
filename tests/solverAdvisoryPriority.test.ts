import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MathAgentOptions, MathAgentSession } from '../src/runtime/codexSession';
import type { SolverRunState } from '../src/solver/archive';
import { CooperativeResearch } from '../src/solver/cooperation';
import { directSolverModules } from '../src/solver/modules';
import type { ResearchWorker } from '../src/solver/modules/organization';
import { commitSolverSources, type SolverProblem } from '../src/solver/problem';
import { runResearchWorkers } from '../src/solver/research';
import { parseCooperationPlan, taskVersion, type CooperativeAction } from '../src/solver/tasks';
import { deferred } from './helpers/async';
import { cooperativeResearch, workerAccess } from './helpers/cooperation';
import { leadWorker, localExample, peerWorker, solverState } from './helpers/solver';

vi.mock('../src/math/mathBuildManifest', () => ({ readMathBuildManifest: vi.fn() }));

const budget = { maxTurns: Infinity, remainingMs: Infinity };
type TaskAction = Extract<CooperativeAction, { kind: 'task' }>;

describe('advisory turns yielding to executable proof work', () => {
  let directory: string, problem: SolverProblem, state: SolverRunState;
  let lead: ResearchWorker, peer: ResearchWorker, engineer: ResearchWorker;
  let cooperative: CooperativeResearch, controller: AbortController, action: TaskAction;
  const node = (id: string) => state.cooperation!.tasks.find(item => item.task.id === id)!;
  const refresh = () => (cooperative as any).changed();
  const publishTypedWork = () => {
    node('checked_bridge').task = { ...node('checked_bridge').task, status: 'active' }; refresh();
  };
  const shouldYield = () => Boolean(cooperative.proofHandoffTarget(engineer, action));

  beforeEach(async () => {
    const example = localExample('solver-advisory-priority-', 'lead');
    ({ directory, problem } = example);
    lead = leadWorker(problem, example.workspace);
    peer = peerWorker(example, 'researcher-1'); engineer = peerWorker(example, 'engineer', { role: 'engineer' });
    const workers = [lead, peer, engineer];
    const plan = parseCooperationPlan(problem, { tasks: [
      { id: 'bridge_audit', kind: 'research', reviewScope: 'feasibility', ownerId: engineer.id,
        objective: 'Check the exact library interface and retain the verified construction for its proof consumer.' },
      { id: 'checked_bridge', kind: 'lemma', status: 'paused', ownerId: engineer.id, type: 'True',
        proofPath: 'Submission.lean', theoremName: 'Tutorial.checked_bridge',
        objective: 'Integrate the exact helper produced by the library audit.' },
      ...problem.targets.map((target, index) => ({ id: `goal_${index}`, kind: 'goal', ownerId: peer.id,
        objective: `Prove ${target.theoremName}.`, theoremName: target.theoremName,
        proofPath: target.proofPath, dependsOn: ['checked_bridge'] })),
    ], groups: [{ id: 'main', objective: 'Close the original goals.', engineerId: peer.id, maxConcurrent: 1 }] });
    state = solverState(problem, example.workspace, { runId: 'advisory-priority-fixture', phase: 'running',
      workers: workers.map(worker => ({ ...worker, phase: 'running', turns: 0 })),
      cooperation: { canonicalCommit: problem.baseCommit,
        tasks: plan.tasks.map(task => ({ task, status: 'pending', attempts: 0 })),
        groups: plan.groups.map(group => ({ group, turns: 0 })) } });
    controller = new AbortController();
    cooperative = cooperativeResearch({ state, workers, retrievalRoot: directory, signal: controller.signal,
      continuousResearch: true });
    state.cooperation!.planVersion = (cooperative as any).planVersion();
    const assigned = await cooperative.next(engineer, budget);
    if (assigned?.kind !== 'task') throw new Error('fixture_expected_audit');
    action = assigned;
    expect(action.task.id).toBe('bridge_audit');
    expect(cooperative.started(engineer, action)).toBe(true);
    cooperative.activate(engineer, action, async () => {}, async () => {});
  });
  afterEach(async () => {
    controller?.abort(); await cooperative?.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  });

  it('yields an independent feasibility review when its assigned proof work becomes executable, even in a full group', () => {
    expect(shouldYield()).toBe(false);
    publishTypedWork();
    expect(state.cooperation!.groups![0].busy).toBe(1);
    const before = JSON.stringify(state.cooperation);
    expect(shouldYield()).toBe(true);
    expect(JSON.stringify(state.cooperation)).toBe(before);
    expect(cooperative.current(action)).toBe(true);
  });

  it.each(['research', 'sketch'] as const)('also yields a running %s task without changing its responsibility', kind => {
    const current = node(action.task.id);
    current.task = { ...current.task, kind, reviewScope: undefined };
    // Refresh this fixture's current dispatch rather than simulating a stale publication.
    action = { ...action, task: current.task };
    current.assignment!.taskDigest = taskVersion(current.task);
    publishTypedWork();
    expect(shouldYield()).toBe(true);
  });

  it.each(['owner', 'saved-assignment'] as const)('does not release a review for typed work pinned to another peer by %s', pin => {
    const helper = node('checked_bridge');
    if (pin === 'owner') helper.task = { ...helper.task, ownerId: peer.id };
    else {
      helper.task = { ...helper.task, ownerId: undefined };
      helper.assignment = { taskId: helper.task.id, taskDigest: taskVersion(helper.task), workerId: peer.id,
        seedCommit: problem.baseCommit, assignmentId: 'other-peer-saved-proof' };
    }
    publishTypedWork();
    if (helper.assignment) helper.assignment.taskDigest = taskVersion(helper.task);
    expect(shouldYield()).toBe(false);
  });

  it('waits for actual advisory prerequisites and host preparation before yielding', () => {
    const helper = node('checked_bridge');
    helper.task = { ...helper.task, dependsOn: ['bridge_audit'] }; publishTypedWork();
    expect(shouldYield()).toBe(false);
    helper.task = { ...helper.task, dependsOn: [] };
    (cooperative as any).preparingTaskTypes.set(helper, { workerId: engineer.id });
    expect(shouldYield()).toBe(false);
    (cooperative as any).preparingTaskTypes.delete(helper);
    expect(shouldYield()).toBe(true);
  });

  it.each(['M3', 'M5'] as const)('respects the configured %s when no proof dispatch is allowed', module => {
    publishTypedWork();
    expect(shouldYield()).toBe(true);
    const modules = (cooperative as any).input.modules;
    if (module === 'M3') vi.spyOn(modules.M3, 'ready').mockReturnValue([]);
    else vi.spyOn(modules.M5, 'assign').mockReturnValue(undefined);
    expect(shouldYield()).toBe(false);
  });

  it('does not discount a slot held by another worker or yield an in-flight proof', () => {
    publishTypedWork();
    expect(cooperative.proofHandoffTarget(peer, action)).toBeUndefined();
    const current = node(action.task.id);
    current.task = { ...current.task, kind: 'lemma', reviewScope: undefined, proofPath: 'Submission.lean',
      theoremName: 'Tutorial.active_proof', type: 'True' };
    current.assignment!.taskDigest = taskVersion(current.task);
    action = { ...action, task: current.task };
    expect(shouldYield()).toBe(false);
  });

  it('keeps running when full dispatch would choose a higher-priority review', async () => {
    publishTypedWork();
    state.cooperation!.tasks.push({
      status: 'pending', attempts: 0,
      task: { ...node('bridge_audit').task, id: 'fresh_review', objective: 'Independently test the other route before formalization.' },
    });
    refresh();
    expect(shouldYield()).toBe(false);
    cooperative.deactivate(engineer);
    cooperative.interrupted(engineer, action);
    const replacement = await cooperative.next(engineer, budget);
    expect(replacement).toMatchObject({ kind: 'task', task: { id: 'fresh_review', kind: 'research' } });
  });

  it('accounts for a statement review that would take the released slot before a proof', async () => {
    publishTypedWork();
    vi.spyOn(directSolverModules.M5, 'reviewer').mockImplementation(available => available.find(worker => worker.id === engineer.id));
    const helper = node('checked_bridge');
    state.cooperation!.statementReviews = [{
      id: 'bridge-statement-review', taskId: helper.task.id, taskDigest: taskVersion(helper.task),
      snapshotDigest: 'fixture-snapshot', environmentDigest: state.environmentDigest, commit: problem.baseCommit,
      leanStatement: 'True', intendedStatement: 'True holds.', premises: [], dependencies: [],
      workspace: engineer.worktree, files: [], status: 'pending',
    }];
    expect(shouldYield()).toBe(false);
    cooperative.deactivate(engineer);
    cooperative.interrupted(engineer, action);
    expect(await cooperative.next(engineer, budget)).toMatchObject({ kind: 'backtranslate', taskId: helper.task.id });
  });

  it('keeps the researcher on task when an idle peer would pick up the same proof', () => {
    const group = state.cooperation!.groups![0];
    group.group = { ...group.group, maxConcurrent: 2 };
    node('checked_bridge').task = { ...node('checked_bridge').task, ownerId: undefined };
    publishTypedWork();
    expect(shouldYield()).toBe(false);
    group.group = { ...group.group, maxConcurrent: 1 }; refresh();
    expect(shouldYield()).toBe(true);
  });

  it('ignores an executable lemma that is outside the active proof route', () => {
    for (const goal of state.cooperation!.tasks.filter(item => item.task.kind === 'goal'))
      goal.task = { ...goal.task, status: 'paused' };
    publishTypedWork();
    expect(shouldYield()).toBe(false);
  });

  it('retains repeated early handoffs without parking research or spending its unchanged checkpoints', async () => {
    const current = node(action.task.id);
    current.task = { ...current.task, reviewScope: undefined };
    current.assignment!.taskDigest = taskVersion(current.task);
    action = { ...action, task: current.task };
    const notes = 'A partial reduction with one remaining estimate.\n';
    fs.writeFileSync(path.join(engineer.worktree, 'RESEARCH.md'), notes);
    const commit = commitSolverSources(problem, engineer.worktree);
    cooperative.deactivate(engineer);
    await cooperative.deliver(engineer, action, commit, true, 'scheduling-checkpoint');
    expect(state.cooperation!.researchCheckpoints?.bridge_audit).toMatchObject({ count: 1, paused: false });

    for (let i = 0; i < 3; i++) {
      const resumed = await cooperative.next(engineer, budget);
      if (resumed?.kind !== 'task') throw new Error('fixture_expected_resumed_research');
      expect(resumed.task.id).toBe('bridge_audit');
      const saved = commitSolverSources(problem, engineer.worktree);
      await cooperative.deliver(engineer, resumed, saved, true, 'proof-handoff');
    }
    expect(current.status).toBe('pending');
    expect(state.cooperation!.researchCheckpoints?.bridge_audit).toMatchObject({ count: 1, paused: false });
    expect(state.cooperation!.researchDrafts?.bridge_audit?.assignmentId).toBe(action.assignment.assignmentId);
    expect(state.cooperation!.blockers?.some(item => item.mechanism === 'unchanged-research-checkpoint')).not.toBe(true);
  });

  it('retains a yielded review as an exact-input draft, runs its proof consumer, and can resume the review', async () => {
    publishTypedWork();
    expect(shouldYield()).toBe(true);
    const notes = 'Inspected only the pinned library. The helper has a checked construction.\n' +
      '```lean\nexample : True := by trivial\n```\nNo completed review verdict.\n';
    fs.writeFileSync(path.join(engineer.worktree, 'RESEARCH.md'), notes);
    const commit = commitSolverSources(problem, engineer.worktree);
    cooperative.deactivate(engineer);
    await cooperative.deliver(engineer, action, commit, true, 'scheduling-checkpoint');
    const audit = node('bridge_audit'), draft = state.cooperation!.researchDrafts!.bridge_audit;
    expect(audit.status).toBe('pending'); expect(audit.finding).toBeUndefined();
    expect(audit.researchCompletion).toBeUndefined();
    expect(draft).toMatchObject({ commit, workerId: engineer.id,
      feasibilityInputDigest: action.assignment.feasibilityInputDigest });
    expect(state.cooperation!.deliveries?.some(record => record.kind === 'research') ?? false).toBe(false);

    const typed = await cooperative.next(engineer, budget);
    if (typed?.kind !== 'task') throw new Error('fixture_expected_typed_work');
    expect(typed.task.id).toBe('checked_bridge');
    expect(audit.status).toBe('pending');
    expect(state.cooperation!.researchDrafts!.bridge_audit).toMatchObject({ commit, suspended: true });
    cooperative.interrupted(engineer, typed);
    node('checked_bridge').task = { ...node('checked_bridge').task, status: 'paused' }; refresh();
    const resumed = await cooperative.next(engineer, budget);
    if (resumed?.kind !== 'task') throw new Error('fixture_expected_resumed_review');
    expect(resumed.task.id).toBe('bridge_audit');
    expect(resumed.assignment.feasibilityInputDigest).toBe(action.assignment.feasibilityInputDigest);
    expect(resumed.assignment.assignmentId).toBe(action.assignment.assignmentId);
    expect(fs.readFileSync(path.join(engineer.worktree, 'RESEARCH.md'), 'utf8')).toBe(notes);
    expect(audit.finding).toBeUndefined(); expect(audit.researchCompletion).toBeUndefined();
  });

  it('keeps an unfinished review as a draft when the model saves notes and naturally returns after a typed-work notice', async () => {
    cooperative.deactivate(engineer); cooperative.interrupted(engineer, action); await cooperative.stop();
    for (const goal of state.cooperation!.tasks.filter(item => item.task.kind === 'goal'))
      goal.task = { ...goal.task, status: 'paused' };
    vi.useFakeTimers();
    vi.spyOn(CooperativeResearch.prototype, 'start').mockImplementation(() => {});
    const started = deferred(), done = deferred<string>(), saved = deferred();
    const notes = 'Saved exact pinned-library observations and reproduction commands.\nThe independent review is unfinished.\n';
    const notify = vi.fn(async (message: string) => {
      if (message.includes('A typed proof task is now ready')) {
        fs.writeFileSync(path.join(engineer.worktree, 'RESEARCH.md'), notes);
        done.resolve('completed');
      }
    });
    const open = vi.fn(async (options: MathAgentOptions): Promise<MathAgentSession> => ({
      threadId: 'natural-review-handoff', notify, advisoryNotifications: 'native-history',
      interrupt: async () => { done.resolve('interrupted'); },
      close: async () => { done.resolve('interrupted'); },
      run: async (_message, _id, _workspace, onStarted) => {
        onStarted('natural-review-turn'); options.onActivity?.({ event: 'reasoning' });
        started.resolve(); return done.promise;
      },
    }));
    const workers = [lead, peer, engineer];
    const completion = runResearchWorkers({ state, workers,
      modules: { ...directSolverModules, M1: { ...directSolverModules.M1, open },
        M4: { ...directSolverModules.M4, build: () => ({ instructions: 'Offline natural-return fixture.',
          message: 'Review the precise pinned inputs.', scope: 'original-problem-and-allowed-library',
          sources: { problemReceiptDigest: problem.receiptDigest } }) } },
      access: workerAccess(workers, directory), root: directory, buildFile: path.join(directory, 'build.json'),
      taskText: 'Prove the original targets.', executable: 'offline-fixture', profile: 'offline-fixture',
      signal: controller.signal, deadline: Infinity, maxTurnMs: Infinity, maxTurns: 2, maxTotalTokens: 0,
      goalProgressReviewMs: 24 * 3_600_000, save: () => {},
      emit: event => { if (event === 'feasibility_review_checkpoint_saved') saved.resolve(); },
    });
    try {
      await Promise.race([started.promise, completion.then(() => { throw new Error('fixture_expected_review_turn'); })]);
      // The helper becomes eligible on an active goal's path once the review has started.
      for (const goal of state.cooperation!.tasks.filter(item => item.task.kind === 'goal'))
        goal.task = { ...goal.task, status: 'active' };
      publishTypedWork();
      await vi.advanceTimersByTimeAsync(5_000);
      await Promise.race([saved.promise, completion.then(() => { throw new Error('fixture_expected_saved_review'); })]);
      expect(notify).toHaveBeenCalledWith(expect.stringContaining('A typed proof task is now ready'), { mode: 'advisory' });
      const audit = node('bridge_audit');
      expect(audit.status).toBe('pending');
      expect(audit.finding).toBeUndefined(); expect(audit.researchCompletion).toBeUndefined();
      expect(state.cooperation!.researchDrafts!.bridge_audit).toMatchObject({ workerId: engineer.id,
        feasibilityInputDigest: action.assignment.feasibilityInputDigest });
      expect(state.cooperation!.deliveries?.some(record => record.kind === 'research') ?? false).toBe(false);
    } finally {
      controller.abort(); done.resolve('interrupted'); await Promise.allSettled([completion]);
    }
  });
});
