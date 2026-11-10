import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readSolverRunState, writeSolverRunState } from '../src/solver/archive';
import { buildResearchContext } from '../src/solver/modules/context';
import { prepareNextCheckDecisions } from '../src/solver/nextChecks';
import { queueResearchObservation } from '../src/solver/researchObservation';
import { parseCooperationPlan } from '../src/solver/tasks';
import { cooperativeResearch } from './helpers/cooperation';
import { leadWorker, localExample, peerWorker, solverState } from './helpers/solver';

const host = vi.hoisted(() => ({ createSession: vi.fn() }));
vi.mock('../src/runtime/codexSession', () => ({ createCodexMathSession: host.createSession }));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
  expect(host.createSession).not.toHaveBeenCalled(); host.createSession.mockReset();
});

async function fixture() {
  const example = localExample('definition-contract-flow-');
  const lead = leadWorker(example.problem, example.workspace);
  const author = peerWorker(example, 'author'), checker = peerWorker(example, 'checker');
  const proofPath = example.problem.targets[0].proofPath;
  const plan = parseCooperationPlan(example.problem, { tasks: [
    ...example.problem.targets.map((target, index) => ({ ...target, id: `goal_${index}`, kind: 'goal',
      objective: 'Prove the original target.', ...(index ? { status: 'paused' } : { dependsOn: ['left', 'right'] }) })),
    { id: 'witness', kind: 'lemma', declaration: 'definition', objective: 'Construct the shared witness.',
      theoremName: 'sharedWitness', type: 'ℕ', proofPath, ownerId: author.id },
    ...['left', 'right'].map(id => ({ id, kind: 'lemma', objective: `Apply the witness to ${id}.`,
      theoremName: `shared_${id}`, type: 'True', proofPath, dependsOn: ['witness'] })),
  ] });
  const state = solverState(example.problem, example.workspace, { runId: 'contract-check-fixture', phase: 'running',
    cooperation: { canonicalCommit: example.problem.baseCommit,
      tasks: plan.tasks.map(task => ({ task, status: 'pending', attempts: 0 })),
      groups: plan.groups.map(group => ({ group, turns: 0 })) } });
  const controller = new AbortController(), events: string[] = [];
  const cooperation = cooperativeResearch({ state, workers: [lead, author, checker], retrievalRoot: example.directory,
    signal: controller.signal, emit: event => events.push(event) });
  cleanup.push(async () => { controller.abort(); await cooperation.stop(); fs.rmSync(example.directory, { recursive: true, force: true }); });
  await cooperation.restore();
  return { ...example, state, lead, author, checker, plan, controller, cooperation, events };
}

it.each(['definition-paused', 'goal-paused', 'removed-path'])(
  'expires a pending check on %s and resumes the same record when its path returns', async scenario => {
    const f = await fixture();
    const record = f.state.cooperation!.nextChecks![0];
    const acceptPlan = (plan: typeof f.plan) => (f.cooperation as unknown as {
      acceptPlan(plan: typeof f.plan): Promise<void>;
    }).acceptPlan(plan);
    const changed = structuredClone(f.plan);
    if (scenario === 'definition-paused') changed.tasks.find(task => task.id === 'witness')!.status = 'paused';
    if (scenario === 'goal-paused') changed.tasks.find(task => task.id === 'goal_0')!.status = 'paused';
    if (scenario === 'removed-path') for (const id of ['left', 'right'])
      changed.tasks.find(task => task.id === id)!.dependsOn = [];
    await acceptPlan(changed);
    expect(record.status).toBe('stale');
    expect(f.state.cooperation!.tasks.filter(node => node.nextCheckId === record.id && node.task.status !== 'stopped')).toEqual([]);
    await acceptPlan(structuredClone(f.plan));
    expect(f.state.cooperation!.nextChecks).toHaveLength(1);
    expect(record.status).toBe('pending');
    expect(f.state.cooperation!.tasks.filter(node => node.nextCheckId === record.id)).toHaveLength(1);
    const action = await f.cooperation.next(f.checker, { maxTurns: Infinity, remainingMs: Infinity });
    expect(action?.kind).toBe('task');
    if (action?.kind === 'task') expect(action.task.id).toBe(record.taskId);
    expect(f.state.cooperation!.invalidTaskTransitions ?? []).toEqual([]);
    expect(f.events).toContain('next_check_resumed');
  });

it('dispatches an independent definition check, returns negative evidence to Lead, and preserves it through restart', async () => {
  const f = await fixture();
  const action = await f.cooperation.next(f.checker, { maxTurns: Infinity, remainingMs: Infinity });
  expect(action?.kind).toBe('task');
  if (action?.kind !== 'task') throw new Error('missing check');
  const record = f.state.cooperation!.nextChecks![0];
  expect(record.origin).toBe('definition-contract');
  expect(action.task.id).toBe(record.taskId);
  const view = f.cooperation.contextState(action, f.checker);
  expect(view.nextChecks?.map(check => check.id)).toContain(record.id);
  expect(f.cooperation.started(f.checker, action)).toBe(true);
  f.cooperation.activate(f.checker, action, async () => {}, async () => {});
  fs.writeFileSync(path.join(f.checker.worktree, 'RESEARCH.md'), 'Scoped interface check: retained evidence for a rejected argument.\n');
  queueResearchObservation({ worktree: f.checker.worktree, finding: {
    summary: 'The proposed construction argument uses the wrong function argument.',
    checkOutcome: { checkId: record.id, conclusion: 'refuted',
      summary: 'The scoped argument fails when the differentiated function is nonconstant.', evidenceRefs: ['RESEARCH.md'] } } });
  await f.cooperation.pulse(f.checker.id);
  expect(record.status).toBe('awaiting-decision');
  expect(record.outcome?.conclusion).toBe('refuted');
  const identity = { problemReceiptDigest: f.problem.receiptDigest, environmentDigest: f.state.environmentDigest };
  expect(() => prepareNextCheckDecisions(f.state.cooperation!, identity, structuredClone(f.plan), [{
    checkId: record.id, outcomeDeliveryId: record.outcome!.deliveryId, action: 'continue', reason: 'Keep trying anyway.',
  }])).toThrow('math_plan_next_check_counter_evidence_required');
  expect(f.state.cooperation!.tasks.some(node => node.proof || node.integratedCheck)).toBe(false);
  const file = path.join(f.directory, 'state.json'); writeSolverRunState(file, f.state);
  const restored = readSolverRunState(file);
  f.controller.abort(); await f.cooperation.stop();
  const resumed = cooperativeResearch({ state: restored, workers: [f.lead, f.author, f.checker], retrievalRoot: f.directory });
  cleanup.push(() => resumed.stop());
  await resumed.restore();
  expect(restored.cooperation!.nextChecks).toHaveLength(1);
  expect(restored.cooperation!.nextChecks![0]).toMatchObject({ id: record.id, status: 'awaiting-decision', origin: 'definition-contract' });
  expect(restored.cooperation!.tasks.filter(node => node.nextCheckId === record.id)).toHaveLength(1);
  const leadAction = await resumed.next(f.lead, { maxTurns: Infinity, remainingMs: Infinity });
  if (leadAction?.kind !== 'lead') throw new Error('missing Lead decision after restore');
  const context = buildResearchContext(f.problem, { ...restored, cooperation: resumed.contextState(leadAction, f.lead) },
    { root: f.directory, worktree: f.workspace, environment: {}, retrievalRoot: f.directory,
      taskText: 'Prove the original target.', assignment: leadAction, maxOptionalContextBytes: 0 });
  expect(JSON.stringify(context)).toContain('counterEvidenceDeliveryId');
  expect(f.events).toContain('next_check_outcome');
});
