import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MathAgentOptions, MathAgentSession } from '../src/runtime/codexSession';
import { readSolverRunState, writeSolverRunState } from '../src/solver/archive';
import { CooperativeResearch } from '../src/solver/cooperation';
import { parseLeadPlan } from '../src/solver/cooperationShared';
import { routeAllowsTask } from '../src/solver/modules/search';
import { runResearchWorkers } from '../src/solver/research';
import { parseCooperationPlan } from '../src/solver/tasks';
import { deferred } from './helpers/async';
import { workerAccess, workerDeliveryModules } from './helpers/cooperation';
import { leadWorker, localExample, peerWorker, solverState } from './helpers/solver';
import './helpers/solverTeamRouteRetirement';

vi.mock('../src/math/mathBuildManifest', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/mathBuildManifest')>(), readMathBuildManifest: vi.fn(),
}));

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
const budget = { maxTurns: 100, remainingMs: 30_000 };

class FixtureResearch extends CooperativeResearch {
  async publish(value: unknown) {
    return this.acceptPlan(parseLeadPlan(this.input.state.problem, value, this.planPatchBase()));
  }
}

function fixture(startWithPlan = true) {
  const example = localExample('retire-cooperative-route-');
  directories.push(example.directory);
  const { problem, workspace } = example;
  const lead = leadWorker(problem, workspace), peer = peerWorker(example, 'peer');
  const workers = [lead, peer], file = path.join(example.directory, 'state.json');
  const originalGoals = problem.targets.map((target, index) => ({
    id: 'goal_' + index, kind: 'goal', objective: 'Prove ' + target.theoremName, ...target,
    status: 'paused',
  }));
  const tasks = [
    { id: 'dead_active', kind: 'research', groupId: 'dead', objective: 'Check the failing approach.', ownerId: peer.id },
    { id: 'dead_queued', kind: 'research', groupId: 'dead', objective: 'Extend the failing approach.', ownerId: peer.id,
      dependsOn: ['dead_active'] },
    { id: 'live_ready', kind: 'research', objective: 'Explore the independent approach.', ownerId: peer.id, status: 'paused' },
    ...originalGoals,
  ];
  const groups = [{ id: 'main', objective: 'Frozen goal and viable route' },
    { id: 'dead', objective: 'A candidate route to falsify', maxConcurrent: 1 }];
  const parsed = parseCooperationPlan(problem, { tasks, groups });
  const state = solverState(problem, workspace, { runId: 'route-retirement-fixture', phase: 'running',
    workers: workers.map(worker => ({ ...worker, phase: 'running', turns: 0 })),
    ...(startWithPlan ? { cooperation: { canonicalCommit: problem.baseCommit,
      tasks: parsed.tasks.map(task => ({ task, status: 'pending' as const, attempts: 0 })),
      groups: parsed.groups.map(group => ({ group, turns: 0 })) } } : {}) });
  const controller = new AbortController();
  const emit = vi.fn();
  const research = (snapshot = state) => new FixtureResearch({
    state: snapshot, workers, access: workerAccess(workers, example.directory), modules: workerDeliveryModules,
    signal: controller.signal, save: () => writeSolverRunState(file, snapshot), emit,
    exclusiveCheck: async check => check(),
  });
  return { ...example, state, file, lead, peer, originalGoals, groups, research, emit };
}

describe('cooperative route retirement', () => {
  it('atomically saves retirement, interrupts the active branch, and dispatches a viable successor', async () => {
    const f = fixture(), research = f.research();
    try {
      const action = await research.next(f.peer, budget);
      if (action?.kind !== 'task') throw new Error('Expected a route assignment.');
      expect(action.task.id).toBe('dead_active');
      expect(research.started(f.peer, action)).toBe(true);
      const interrupt = vi.fn(async () => {
        const saved = readSolverRunState(f.file).cooperation!;
        expect(saved.retiredRoutes).toMatchObject([{ routeId: 'dead', reason: 'Counterexample at zero', evidenceRefs: ['probe-zero'] }]);
        expect(saved.tasks.find(node => node.task.id === 'dead_active')?.status).toBe('blocked');
        expect(saved.groups?.find(route => route.group.id === 'dead')?.busy).toBe(0);
      });
      research.activate(f.peer, action, interrupt, async () => {});
      const baseVersion = f.state.cooperation!.planVersion;
      await expect(research.publish({ baseVersion, retireRoutes: [{ routeId: 'dead', reason: '' }] }))
        .rejects.toThrow('math_plan_invalid_retire_routes');
      expect(interrupt).not.toHaveBeenCalled();
      expect(research.current(action)).toBe(true);
      await research.publish({ baseVersion, upsert: [{ id: 'live_ready', status: 'active' }],
        retireRoutes: [{ routeId: 'dead', reason: 'Counterexample at zero', evidenceRefs: ['probe-zero'] }] });
      expect(f.emit).toHaveBeenCalledWith('cooperative_route_retired', expect.objectContaining({ routeId: 'dead' }));
      expect(interrupt).toHaveBeenCalledTimes(1);
      // Observe errors inside the awaited interruption callback as well.
      await interrupt.mock.results[0].value;
      expect(research.current(action)).toBe(false);
      expect(f.state.cooperation!.tasks.filter(node => node.task.groupId === 'dead').map(node =>
        ({ status: node.status, policy: node.task.status, attempts: node.attempts, owner: node.assignment?.workerId })))
        .toEqual([{ status: 'blocked', policy: 'stopped', attempts: 1, owner: undefined },
          { status: 'blocked', policy: 'stopped', attempts: 0, owner: undefined }]);
      research.interrupted(f.peer, action);
      research.deactivate(f.peer);
      expect(await research.next(f.peer, budget)).toMatchObject({ kind: 'task', task: { id: 'live_ready' } });
      expect(JSON.parse(fs.readFileSync(path.join(f.peer.worktree, 'COOPERATION.json'), 'utf8')).retiredRoutes)
        .toMatchObject([{ routeId: 'dead', source: 'lead' }]);

      const restored = readSolverRunState(f.file);
      const resumed = f.research(restored);
      try {
        await resumed.publish({ baseVersion: restored.cooperation!.planVersion,
          groups: f.groups, upsert: [{ id: 'dead_queued', status: 'active' },
            { id: 'replacement', kind: 'research', groupId: 'dead', objective: 'Retry the retired route.' }] });
        const dead = restored.cooperation!.tasks.filter(node => node.task.groupId === 'dead');
        expect(dead).toHaveLength(3);
        expect(dead.every(node => node.task.status === 'stopped' && node.status === 'blocked')).toBe(true);
        expect(dead.map(node => node.attempts)).toEqual([1, 0, 0]);
      } finally { await resumed.stop(); }
    } finally { await research.stop(); }
  });

  it('prunes an alternate proof route and keeps its shared foundation available to the surviving route', async () => {
    const f = fixture(false), research = f.research();
    try {
      const goal = f.originalGoals[0], proofPath = goal.proofPath;
      const lemma = (id: string, dependsOn: string[] = []) => ({
        id, kind: 'lemma', objective: 'Prove the finite claim ' + id, theoremName: id, proofPath, type: 'True', dependsOn,
      });
      const routes = ['dead', 'live'].map(route => ({ id: route, targetTaskId: goal.id,
        closingTaskId: route + '_closing', prerequisiteTaskIds: ['shared_foundation'] }));
      const tasks = [...f.originalGoals, lemma('shared_foundation'), lemma('dead_only'),
        lemma('dead_closing', ['dead_only', 'shared_foundation']), lemma('live_closing', ['shared_foundation'])];
      await research.publish({ tasks, proofRoutes: routes });
      const state = f.state.cooperation!;
      await research.publish({ baseVersion: state.planVersion, retireRoutes: [{ routeId: 'dead', reason: 'Witness disproves its closing step.' }] });
      expect(state.proofRoutes?.map(route => route.id)).toEqual(['live']);
      expect(state.retiredRouteTasks).toMatchObject({ dead_only: 'dead', dead_closing: 'dead' });
      const byId = new Map(state.tasks.map(node => [node.task.id, node]));
      const allowed = (id: string) => routeAllowsTask(byId.get(id)!.task, state.tasks, state.groups);
      expect(allowed('shared_foundation')).toBe(true);
      expect(allowed('dead_only')).toBe(false);
      expect(allowed('dead_closing')).toBe(false);
      expect(allowed('live_closing')).toBe(true);
    } finally { await research.stop(); }
  });

  it('installs the primary portfolio foundation ahead of its original consumers and imports gate tombstones', async () => {
    const f = fixture(false);
    const [goal] = f.originalGoals;
    f.state.portfolioExploration = { phase: 'completed', durationMs: 500, scouts: [], gate: {
      primaryRouteId: 'main', retiredRoutes: [{ routeId: 'dead', reason: 'The boundary case fails.', retiredAt: 1, source: 'portfolio' }],
      foundationLemmas: [{ id: 'portfolio_base', theoremName: 'portfolio_base', proofPath: goal.proofPath,
        objective: 'Prove the reusable base inequality.', type: '(n : Nat) → n = n' }],
    } };
    const research = f.research();
    try {
      await research.publish({ groups: f.groups, tasks: [...f.originalGoals.map(task => ({ ...task, status: 'active' })),
        { id: 'wrong_direction', kind: 'research', objective: 'Repeat the falsified route.', groupId: 'dead' }] });
      const state = f.state.cooperation!, byId = new Map(state.tasks.map(node => [node.task.id, node]));
      expect(state.retiredRoutes).toMatchObject([{ routeId: 'dead', source: 'portfolio' }]);
      expect(byId.get('wrong_direction')).toMatchObject({ status: 'blocked', task: { status: 'stopped' } });
      expect(byId.get(goal.id)?.task.dependsOn).toContain('portfolio_base');
      expect(byId.get('portfolio_base')).toMatchObject({ status: 'pending', attempts: 0,
        task: { kind: 'lemma', theoremName: 'portfolio_base', sharing: 'problem' } });
      expect(byId.get(goal.id)?.integratedCheck).toBeUndefined();
    } finally { await research.stop(); }
  });
});

it('asks Lead to publish and delegate once per turn when its planning command limit is exceeded', async () => {
  const f = fixture(false), workers = [f.lead, f.peer];
  const controller = new AbortController(), started = deferred(), done = deferred<string>();
  const notify = vi.fn(async () => {});
  const open = vi.fn(async (_options: MathAgentOptions): Promise<MathAgentSession> => ({
    threadId: 'lead-guardrail-thread', notify, interrupt: async () => { done.resolve('interrupted'); },
    close: async () => { done.resolve('interrupted'); },
    run: async (_message, _messageId, _workspace, onStarted) => {
      onStarted('lead-guardrail-turn'); started.resolve();
      return done.promise;
    },
  }));
  const completion = runResearchWorkers({
    state: f.state, workers, access: workerAccess(workers, f.directory), root: f.directory,
    buildFile: path.join(f.directory, 'build.json'), taskText: 'Prove the original targets.',
    modules: { ...workerDeliveryModules, M1: { ...workerDeliveryModules.M1, open } },
    executable: 'offline-fixture', profile: 'offline-fixture', signal: controller.signal,
    deadline: Infinity, maxTurnMs: Infinity, maxTurns: 2, maxTotalTokens: 0, leadMaxPlanningCommands: 2,
    save: () => {}, emit: f.emit,
  });
  try {
    await Promise.race([started.promise, completion.then(() => { throw new Error('Lead never started.'); })]);
    const activity = open.mock.calls[0][0].onActivity!;
    const command = () => {
      activity({ event: 'item_started', itemType: 'commandExecution' });
      activity({ event: 'command_output', itemType: 'commandExecution' });
      activity({ event: 'item_completed', itemType: 'commandExecution' });
    };
    command(); command();
    expect(notify).not.toHaveBeenCalled();
    command(); command();
    expect(notify).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/publish the plan now.*Delegate further computations/u),
      { waitForRequest: true });
    expect(f.emit.mock.calls.filter(([event]) => event === 'lead_planning_command_guardrail_triggered')).toEqual([
      ['lead_planning_command_guardrail_triggered', expect.objectContaining({ workerId: 'solver', commandCount: 3, limit: 2 })],
    ]);
  } finally {
    controller.abort(new Error('fixture_complete'));
    await expect(completion).rejects.toThrow('fixture_complete');
  }
});
