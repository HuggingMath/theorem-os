import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SolverRunState } from '../src/solver/archive';
import type { CooperativeResearch } from '../src/solver/cooperation';
import type { ResearchWorker } from '../src/solver/modules/organization';
import { commitSolverSources, type SolverProblem } from '../src/solver/problem';
import { readMathResponse } from '../src/solver/deliveries';
import { leadPlanDeliveryFile, parseCooperationPlan, type CooperativeAction } from '../src/solver/tasks';
import { cooperativeResearch } from './helpers/cooperation';
import { leadWorker, localExample, peerWorker, solverState } from './helpers/solver';

type LeadAction = Extract<CooperativeAction, { kind: 'lead' | 'assemble' }>;

describe('Lead plan revisions in a cooperative run', () => {
  const budget = { maxTurns: Infinity, remainingMs: Infinity };
  let directory: string, problem: SolverProblem, state: SolverRunState, workers: ResearchWorker[];
  let cooperative: CooperativeResearch, controller: AbortController;
  let events: { event: string; details?: Record<string, unknown> }[];
  const notes = () => path.join(workers[0].worktree, 'RESEARCH.md');
  const ids = () => state.cooperation!.tasks.map(node => node.task.id);
  const helper = (id: string) => ({ id, kind: 'lemma' as const, objective: `Prove the independent step ${id}.`,
    theoremName: `Tutorial.${id}`, proofPath: 'Submission.lean', type: 'True', dependsOn: [] });
  const start = async () => {
    const action = await cooperative.next(workers[0], budget);
    if (action?.kind !== 'lead' || !action.planNonce) throw new Error('fixture_expected_revision_dispatch');
    expect(cooperative.started(workers[0], action)).toBe(true);
    cooperative.activate(workers[0], action, vi.fn(async () => {}), async () => {});
    return action;
  };
  const publish = async (action: LeadAction, revision: Record<string, unknown>) => {
    fs.appendFileSync(path.join(workers[0].worktree, leadPlanDeliveryFile(action)!), JSON.stringify({ kind: 'plan',
      dispatchNonce: action.planNonce, baseVersion: action.planVersion, summary: 'Adopt one independent step.', ...revision }) + '\n');
    await cooperative.pulse();
  };
  const finish = async (action: LeadAction) => {
    cooperative.deactivate(workers[0]);
    await cooperative.deliver(workers[0], action, commitSolverSources(problem, workers[0].worktree));
  };
  const patchFence = (value: Record<string, unknown>) => '```math-plan\n' + JSON.stringify(value) + '\n```\n';

  beforeEach(() => {
    const example = localExample('solver-plan-patch-', 'lead');
    ({ directory, problem } = example);
    workers = [leadWorker(problem, example.workspace), peerWorker(example, 'engineer', { role: 'engineer' })];
    const plan = parseCooperationPlan(problem, { tasks: problem.targets.map((target, index) => ({
      id: `goal_${index}`, kind: 'goal', objective: `Prove ${target.theoremName}.`, ...target,
    })) });
    state = solverState(problem, example.workspace, { runId: 'plan-patch-fixture', phase: 'running',
      workers: workers.map(worker => ({ id: worker.id, role: worker.role, worktree: worker.worktree, phase: 'checking', turns: 0 })),
      cooperation: { tasks: plan.tasks.map(task => ({ task, status: 'pending', attempts: 0 })),
        groups: plan.groups.map(group => ({ group, turns: 0 })), error: 'fixture_request_new_plan' } });
    events = []; controller = new AbortController();
    cooperative = cooperativeResearch({ state, workers, retrievalRoot: directory, signal: controller.signal,
      emit: (event, details) => events.push({ event, details }) });
  });
  afterEach(async () => {
    controller.abort();
    await Promise.allSettled([cooperative.stop()]);
    vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true });
  });

  it('publishes a small revision live and shows the complete accepted graph to the next dispatch', async () => {
    const action = await start(), goals = ids();
    await publish(action, { upsert: [helper('patched_bridge')] });
    expect(ids()).toEqual([...goals, 'patched_bridge']);
    expect(events.filter(event => event.event === 'plan_published')).toHaveLength(1);
    fs.writeFileSync(notes(), 'A notes-only final response.\n');
    await finish(action);
    expect(state.cooperation!.planPublication?.finalized).toBe(true);
    expect(state.cooperation!.planEdited).toBe(true);
    (cooperative as any).syncPlanNotes();
    const text = fs.readFileSync(notes(), 'utf8');
    expect(readMathResponse(workers[0].worktree, 'math-plan').tasks.map((task: { id: string }) => task.id)).toEqual(ids());
    expect(text.split('\n').filter(line => line.startsWith('  {"id":"'))).toHaveLength(ids().length + 1);
    expect(text).toContain('A notes-only final response.');
  });

  it('accepts a live revision nested under tasks as the same top-level revision', async () => {
    // 2026-10-28 HoneycombFreeEnergy: two Lead decisions were rejected as a bare math_plan_invalid for this shape.
    const action = await start(), goals = ids();
    await publish(action, { tasks: { baseVersion: action.planVersion, upsert: [helper('nested_bridge')] } });
    expect(ids()).toEqual([...goals, 'nested_bridge']);
    expect(events.filter(event => event.event === 'plan_published')).toHaveLength(1);
    expect(state.cooperation!.planPublicationRejection).toBeUndefined();
  });

  it('publishes new pending helpers as unproved work without confusing their host and plan statuses', async () => {
    // BoundedRecovery, 2026-11-09: four new helper definitions carried status: pending.
    const action = await start(), goals = ids();
    await publish(action, { upsert: ['spectral', 'monotone', 'subsequence', 'limit'].map(id => ({
      ...helper(id), status: 'pending',
    })) });
    expect(ids()).toEqual([...goals, 'spectral', 'monotone', 'subsequence', 'limit']);
    expect(state.cooperation!.tasks.slice(-4).map(node => ({ status: node.status, taskStatus: node.task.status,
      proof: node.proof, integratedCheck: node.integratedCheck }))).toEqual(Array.from({ length: 4 }, () => ({
      status: 'pending', taskStatus: undefined, proof: undefined, integratedCheck: undefined,
    })));
    expect(events.filter(event => event.event === 'plan_published')).toHaveLength(1);
    expect(state.cooperation!.planPublicationRejection).toBeUndefined();
  });

  it('accepts a corrected changed plan saved at a scheduling checkpoint after rejecting its live event', async () => {
    const action = await start();
    await publish(action, { upsert: [{ ...helper('repaired_bridge'), status: 'integrated' }] });
    expect(state.cooperation!.planPublicationRejection?.reason).toContain('field":"status');
    expect(ids()).not.toContain('repaired_bridge');
    fs.writeFileSync(notes(), patchFence({ baseVersion: action.planVersion,
      upsert: [{ ...helper('repaired_bridge'), status: 'pending' }] }));
    cooperative.deactivate(workers[0]);
    await cooperative.deliver(workers[0], action, commitSolverSources(problem, workers[0].worktree), true, 'scheduling-checkpoint');
    expect(ids()).toContain('repaired_bridge');
    expect(state.cooperation!.tasks.find(node => node.task.id === 'repaired_bridge')).toMatchObject({ status: 'pending', attempts: 0 });
    expect(state.cooperation!.planPublicationRejection).toBeUndefined();
    expect(events.some(event => event.event === 'plan_rejected')).toBe(false);
  });

  it('rejects a live revision against a stale base without changing the graph', async () => {
    const action = await start(), before = ids();
    await publish(action, { baseVersion: 'stale-version', upsert: [helper('stale_bridge')] });
    expect(ids()).toEqual(before);
    expect(state.cooperation!.planPublicationRejection?.reason).toContain('math_plan_publication_version_conflict');
    await publish(action, { remove: ['missing_task'] });
    expect(state.cooperation!.planPublicationRejection?.reason).toContain('math_plan_patch_unknown_task');
    expect(state.cooperation!.planPublication).toBeUndefined();
  });

  it('accepts a final revision in RESEARCH.md and replaces it with the complete graph', async () => {
    const action = await start(), goals = ids();
    fs.writeFileSync(notes(), 'Route: one bridge closes the target.\n\n' +
      patchFence({ baseVersion: action.planVersion, upsert: [helper('final_bridge')] }));
    await finish(action);
    expect(ids()).toEqual([...goals, 'final_bridge']);
    expect(events.some(event => event.event === 'plan_rejected')).toBe(false);
    (cooperative as any).syncPlanNotes();
    const text = fs.readFileSync(notes(), 'utf8');
    expect(text).not.toContain('"upsert"');
    expect(text).toContain('Route: one bridge closes the target.');
    expect(readMathResponse(workers[0].worktree, 'math-plan').tasks.map((task: { id: string }) => task.id)).toEqual(ids());
  });

  it('treats the published revision repeated in final notes as already applied', async () => {
    const action = await start(), revision = { upsert: [helper('published_bridge')] };
    await publish(action, revision);
    const version = state.cooperation!.planVersion;
    fs.writeFileSync(notes(), patchFence({ baseVersion: action.planVersion, ...revision }));
    await finish(action);
    expect(events.some(event => event.event === 'plan_rejected')).toBe(false);
    expect(ids().filter(id => id === 'published_bridge')).toHaveLength(1);
    expect(state.cooperation!.planVersion).toBe(version);
  });

  it.each(['final', 'scheduling-checkpoint'] as const)
    ('keeps a new pending task publication when the same revision is repeated at %s', async mode => {
      const action = await start(), revision = { upsert: [{ ...helper('pending_bridge'), status: 'pending' }] };
      await publish(action, revision);
      const version = state.cooperation!.planVersion;
      fs.writeFileSync(notes(), patchFence({ baseVersion: action.planVersion, ...revision }));
      cooperative.deactivate(workers[0]);
      await cooperative.deliver(workers[0], action, commitSolverSources(problem, workers[0].worktree),
        mode !== 'final', mode === 'final' ? 'checkpoint' : mode);
      expect(events.some(event => event.event === 'plan_rejected')).toBe(false);
      expect(ids().filter(id => id === 'pending_bridge')).toHaveLength(1);
      expect(state.cooperation!.planVersion).toBe(version);
      const node = state.cooperation!.tasks.find(node => node.task.id === 'pending_bridge')!;
      expect(node.status).toBe('pending');
      expect(node.task.status).toBeUndefined();
      expect(node.proof).toBeUndefined();
      expect(node.integratedCheck).toBeUndefined();
    });

  it('rejects a final revision written against an older plan', async () => {
    const action = await start(), before = ids();
    fs.writeFileSync(notes(), patchFence({ baseVersion: 'older-plan', upsert: [helper('late_bridge')] }));
    await finish(action);
    expect(ids()).toEqual(before);
    expect(events.find(event => event.event === 'plan_rejected')?.details?.error).toContain('math_plan_patch_version_conflict');
  });

  it('keeps a live revision when the next final notes only inherit the host-synced graph', async () => {
    const first = await start();
    await publish(first, { upsert: [helper('first_bridge')] });
    fs.writeFileSync(notes(), 'First route notes.\n');
    await finish(first);
    state.cooperation!.error = 'fixture_request_second_revision';
    (cooperative as any).wakeLead('assembly-failed');
    const second = await start();
    expect(readMathResponse(workers[0].worktree, 'math-plan').tasks.map((task: { id: string }) => task.id)).toEqual(ids());
    await publish(second, { upsert: [helper('second_bridge')] });
    const version = state.cooperation!.planVersion;
    await finish(second);
    expect(ids()).toContain('second_bridge');
    expect(state.cooperation!.planVersion).toBe(version);
    expect(events.some(event => event.event === 'plan_rejected')).toBe(false);
  });

  it('reports peer changes since the previous started Lead turn in the next Lead context', async () => {
    const first = await cooperative.next(workers[0], budget);
    if (first?.kind !== 'lead') throw new Error('fixture_expected_lead_dispatch');
    expect(cooperative.contextState(first, workers[0]).leadInbox).toBeUndefined();
    expect(cooperative.started(workers[0], first)).toBe(true);
    expect(state.cooperation!.leadInboxBasis?.statuses).toEqual(Object.fromEntries(ids().map(id => [id, 'pending'])));
    cooperative.activate(workers[0], first, vi.fn(async () => {}), async () => {});
    await publish(first, { upsert: [helper('inbox_bridge')] });
    fs.writeFileSync(notes(), 'Notes.\n');
    await finish(first);
    state.cooperation!.deliveries = [...state.cooperation!.deliveries ?? [], { id: 'peer-finding', kind: 'research', producer: workers[1].id,
      taskId: 'goal_0', taskDigest: 'digest', status: 'advisory', statement: '', premises: [], dependencies: [], remainingObligations: [],
      summary: 'A peer found the missing bridge.', evidenceRefs: [], createdAt: Date.now() }];
    state.workers![1].scheduling = { status: 'idle', since: Date.now() - 60_000 };
    state.cooperation!.error = 'fixture_request_second_revision';
    (cooperative as any).wakeLead('assembly-failed');
    const second = await cooperative.next(workers[0], budget);
    if (second?.kind !== 'lead') throw new Error('fixture_expected_second_lead_dispatch');
    const inbox = cooperative.contextState(second, workers[0]).leadInbox!;
    expect(inbox.planChanged).toBe(true);
    expect(inbox.deliveries.map(item => item.id)).toEqual(['peer-finding']);
    expect(inbox.statusChanges).toEqual([{ taskId: 'inbox_bridge', to: 'pending' }]);
    expect(inbox.idleWorkers).toMatchObject([{ workerId: workers[1].id, role: 'engineer' }]);
  });

  it('collapses inherited plan fences into one readable accepted graph', () => {
    fs.writeFileSync(notes(), 'Prose before.\n\n```math\n{"tasks":[]}\n```\n\nMiddle prose.\n\n' +
      patchFence({ baseVersion: 'old', upsert: [] }) + '\n```lean\ntheorem kept : True := trivial\n```\n');
    state.cooperation!.planEdited = true;
    (cooperative as any).syncPlanNotes();
    const text = fs.readFileSync(notes(), 'utf8');
    expect(text.match(/```math/gu)).toHaveLength(1);
    expect(text).toContain('Prose before.'); expect(text).toContain('Middle prose.');
    expect(text).toContain('theorem kept : True := trivial');
    expect(readMathResponse(workers[0].worktree, 'math-plan').tasks.map((task: { id: string }) => task.id)).toEqual(ids());
  });
});
