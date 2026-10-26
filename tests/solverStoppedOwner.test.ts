import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SolverRunState } from '../src/solver/archive';
import type { CooperativeResearch } from '../src/solver/cooperation';
import { directSolverModules } from '../src/solver/modules';
import { assessTaskResponsibility, type ResearchWorker } from '../src/solver/modules/organization';
import { researchCanAdvance } from '../src/solver/modules/search';
import { parseCooperationPlan, type TaskRecord } from '../src/solver/tasks';
import { cooperativeResearch } from './helpers/cooperation';
import { leadWorker, localExample, peerWorker, solverState } from './helpers/solver';

const record = (fields: Partial<TaskRecord['task']>, extra: Partial<TaskRecord> = {}): TaskRecord => ({
  task: { id: 'reserved', kind: 'research', revision: 0, objective: 'Investigate.', dependsOn: [], ...fields } as TaskRecord['task'],
  status: 'pending', attempts: 0, ...extra });

describe('reservations of stopped workers', () => {
  const live = { id: 'peer-b', role: 'researcher' as const };

  it('releases owner, engineer and saved-assignment pins only for a stopped worker', () => {
    const stopped = new Set(['peer-a']);
    const owned = record({ ownerId: 'peer-a' });
    expect(assessTaskResponsibility(owned, live, { tasks: [owned] })).toEqual({ kind: 'blocked', reason: 'owner' });
    expect(assessTaskResponsibility(owned, live, { tasks: [owned], stopped })).toEqual({ kind: 'matches' });
    expect(assessTaskResponsibility(owned, live, { tasks: [owned], stopped: new Set(['other']) }))
      .toEqual({ kind: 'blocked', reason: 'owner' });
    const saved = record({}, { assignment: { workerId: 'peer-a' } as TaskRecord['assignment'] });
    expect(assessTaskResponsibility(saved, live, { tasks: [saved] })).toEqual({ kind: 'blocked', reason: 'saved-assignment' });
    expect(assessTaskResponsibility(saved, live, { tasks: [saved], stopped })).toEqual({ kind: 'matches' });
    const goal = record({ id: 'goal', kind: 'goal', groupId: 'main' });
    const groups = [{ group: { id: 'main', objective: 'Main', status: 'active' as const, revision: 0, engineerId: 'peer-a' }, turns: 0 }];
    expect(assessTaskResponsibility(goal, live, { tasks: [goal], groups })).toEqual({ kind: 'blocked', reason: 'engineer' });
    expect(assessTaskResponsibility(goal, live, { tasks: [goal], groups, stopped })).toEqual({ kind: 'matches' });
  });

  it('keeps a stopped worker capacity exploration pinned', () => {
    const exploration = record({ ownerId: 'peer-a' }, { capacityExploration: { workerId: 'peer-a' } as TaskRecord['capacityExploration'] });
    expect(assessTaskResponsibility(exploration, live, { tasks: [exploration], stopped: new Set(['peer-a']) }))
      .toEqual({ kind: 'blocked', reason: 'owner' });
  });

  it('lets an owned task advance once its stopped owner is released', () => {
    const owned = record({ ownerId: 'peer-a' });
    expect(researchCanAdvance([owned], undefined, new Set(['peer-b']))).toBe(false);
    expect(researchCanAdvance([owned], undefined, new Set(['peer-b']), undefined, undefined, new Set(['peer-a']))).toBe(true);
    const exploration = record({ ownerId: 'peer-a' }, { capacityExploration: { workerId: 'peer-a' } as TaskRecord['capacityExploration'] });
    expect(researchCanAdvance([exploration], undefined, new Set(['peer-b']), undefined, undefined, new Set(['peer-a']))).toBe(false);
  });
});

describe('cooperative dispatch after an owner stops', () => {
  let directory: string, state: SolverRunState, lead: ResearchWorker, owner: ResearchWorker, peer: ResearchWorker;
  let cooperative: CooperativeResearch;
  const budget = { maxTurns: Infinity, remainingMs: Infinity };

  beforeEach(() => {
    const example = localExample('solver-stopped-owner-', 'lead'), { workspace, problem } = example;
    directory = example.directory;
    lead = leadWorker(problem, workspace);
    owner = peerWorker(example, 'peer-a');
    peer = peerWorker(example, 'peer-b');
    const plan = parseCooperationPlan(problem, { tasks: [
      ...problem.targets.map((target, index) => ({ id: `goal_${index}`, kind: 'goal',
        objective: `Prove ${target.theoremName}`, proofPath: target.proofPath,
        theoremName: target.theoremName, status: 'paused' })),
      { id: 'reserved', kind: 'research', objective: 'Investigate a concrete route.', ownerId: owner.id },
    ] });
    state = solverState(problem, workspace, { runId: 'stopped-owner-fixture', phase: 'running',
      evaluatorDigest: 'evaluation', model: 'fixture', effort: 'fixture', cooperation: { canonicalCommit: problem.baseCommit,
        tasks: plan.tasks.map(task => ({ task, status: 'pending', attempts: 0 })),
        groups: plan.groups.map(group => ({ group, turns: 0 })) } });
    const unexpectedModel = () => { throw new Error('fixture_models_forbidden'); };
    cooperative = cooperativeResearch({ state, workers: [lead, owner, peer], retrievalRoot: directory,
      modules: { ...directSolverModules, M1: { ...directSolverModules.M1, open: unexpectedModel } } });
  });
  afterEach(async () => {
    await cooperative.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('gives a stopped owner\'s reserved task to an eligible live peer', async () => {
    const reserved = () => state.cooperation!.tasks.find(node => node.task.id === 'reserved')!;
    const first = await cooperative.next(owner, budget);
    expect(first).toMatchObject({ kind: 'task', task: { id: 'reserved' } });
    expect(cooperative.started(owner, first!)).toBe(true);
    cooperative.stopped(owner, 'math_source_outside_ownership');
    expect(reserved()).toMatchObject({ status: 'pending', assignment: { workerId: owner.id } });
    const next = await cooperative.next(peer, budget);
    expect(next).toMatchObject({ kind: 'task', task: { id: 'reserved', ownerId: owner.id }, assignment: { workerId: peer.id } });
    expect(cooperative.started(peer, next!)).toBe(true);
    expect(reserved().status).toBe('running');
  });
});
