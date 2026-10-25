import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readSolverRunState, writeSolverRunState, type SolverRunState } from '../src/solver/archive';
import { CooperativeResearch, parseCooperationPlan } from '../src/solver/cooperation';
import type { ResearchWorker } from '../src/solver/modules/organization';
import { commitSolverSources, type SolverProblem } from '../src/solver/problem';
import { checkSolverRunState } from '../src/solver/stateInvariants';
import { leadPlanDeliveryFile, type CooperativeAction, type CooperativeTask } from '../src/solver/tasks';
import { cooperativeResearch } from './helpers/cooperation';
import { leadWorker, localExample, peerWorker, solverState } from './helpers/solver';
import { failedBatch, verifiedBatch } from './helpers/verifier';

const host = vi.hoisted(() => ({ verify: vi.fn(), createSession: vi.fn(), failing: false }));
vi.mock('../src/math/verifier', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/verifier')>(),
  checkManyFormalVerifications: host.verify,
  resolveMathematicsLakePackagesCache: () => undefined,
}));
vi.mock('../src/runtime/codexSession', () => ({ createCodexMathSession: host.createSession }));

/** mulberry32: small, seedable and stable across platforms. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const PROOFS: Record<string, [string, string]> = {
  'Tutorial.add_zero': ['n + 0 = n := ', 'by rfl'],
  'Tutorial.zero_add': ['0 + n = n := ', 'by exact Nat.zero_add n'],
};
const budget = { maxTurns: Infinity, remainingMs: Infinity };
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

type Slot = { promise: Promise<CooperativeAction | undefined>; done?: { action: CooperativeAction | undefined } };
type Outcome = { status: 'assembled' | 'deadlock' | 'violation' | 'exhausted'; steps: number; trace: string[];
  detail?: unknown };

/**
 * Drives the real cooperation layer the way research.ts does (next → started → activate → deliver/interrupted/
 * stopped → deactivate) with scripted writers. Faults are drawn from a seeded stream, so any failure replays.
 */
async function simulate(seed: number, cleanup: (() => Promise<void>)[], maxSteps = 120): Promise<Outcome> {
  const draw = random(seed), trace: string[] = [];
  const example = localExample(`coordination-simulation-${seed}-`);
  const { directory, workspace } = example;
  const problem: SolverProblem = example.problem;
  const lead = leadWorker(problem, workspace);
  // The smallest realistic roster: goals belong to the engineer role, lemmas to provers, research to researchers.
  const peers = [peerWorker(example, 'engineer', { role: 'engineer' }), peerWorker(example, 'prover-1', { role: 'prover' }),
    peerWorker(example, 'researcher-1', { role: 'researcher' })];
  const workers = [lead, ...peers];
  const goals: CooperativeTask[] = problem.targets.map((target, index) => ({ id: `goal_${index}`, kind: 'goal',
    objective: `Prove ${target.theoremName}.`, theoremName: target.theoremName, proofPath: target.proofPath,
    dependsOn: [], revision: 0 }));
  const plan = parseCooperationPlan(problem, { tasks: goals });
  const planGraph = () => parseCooperationPlan(problem, {
    tasks: state.cooperation!.tasks.map(node => node.task), groups: state.cooperation!.groups?.map(route => route.group) });
  fs.writeFileSync(path.join(workspace, 'RESEARCH.md'), '```math-plan\n' + JSON.stringify(plan) + '\n```');
  let state: SolverRunState = solverState(problem, workspace, { runId: `simulation-${seed}`, phase: 'running', failures: [],
    workers: workers.map(worker => ({ id: worker.id, role: worker.role, worktree: worker.worktree, phase: 'running', turns: 0 })),
    cooperation: { canonicalCommit: problem.baseCommit, tasks: plan.tasks.map(task => ({ task, status: 'pending', attempts: 0 })),
      groups: plan.groups.map(group => ({ group, turns: 0 })) } });
  const events: string[] = [];
  let controller = new AbortController();
  const create = () => cooperativeResearch({ state, workers, retrievalRoot: directory, signal: controller.signal,
    emit: (event, details) => { events.push(event); if (process.env.THEOREM_OS_SIMULATION_DEBUG && /wait|refill/u.test(event))
      trace.push(`event ${event} ${JSON.stringify(details).slice(0, 600)}`); } });
  let cooperative: CooperativeResearch = create();
  cleanup.push(async () => { controller.abort(); await cooperative.stop().catch(() => {}); fs.rmSync(directory, { recursive: true, force: true }); });
  await cooperative.restore();
  const live = new Set(workers.map(worker => worker.id));
  let slots = new Map<string, Slot>(), crashes = 0, helpers = 0;
  const request = (worker: ResearchWorker) => {
    const slot: Slot = { promise: cooperative.next(worker, budget) };
    slot.promise.then(action => { slot.done = { action }; }, error => { slot.done = { action: undefined }; trace.push(`next-error ${worker.id} ${error}`); });
    slots.set(worker.id, slot);
  };
  const source = (worker: ResearchWorker) => path.join(worker.worktree, problem.projectRelative, 'Submission.lean');
  const prove = (worker: ResearchWorker, theorem: string, wrong: boolean) => {
    // Repairs continue from the failed source, so replace whatever body the seed carries.
    const text = fs.readFileSync(source(worker), 'utf8');
    if (!PROOFS[theorem]) {
      const name = theorem.split('.').at(-1)!, index = name.split('_').at(-1)!;
      const line = `theorem ${name} : ${index} = ${index} := ${wrong ? 'by simp' : 'rfl'}`;
      fs.writeFileSync(source(worker), new RegExp(`^theorem ${name} .*$`, 'mu').test(text)
        ? text.replace(new RegExp(`^theorem ${name} .*$`, 'mu'), line) : text.replace('end Tutorial', `${line}\n\nend Tutorial`));
      return commitSolverSources(problem, worker.worktree);
    }
    const [statement, body] = PROOFS[theorem]!;
    fs.writeFileSync(source(worker), text.replace(new RegExp(`${statement.replace(/[+]/gu, '\\+')}.*$`, 'mu'),
      statement + (wrong ? 'by simp' : body)));
    return commitSolverSources(problem, worker.worktree);
  };
  // Scheduling fields belong to research.ts; here liveness is judged by the dispatch loop itself.
  const violations = () => checkSolverRunState(state).filter(item => !item.code.startsWith('quiescent_') &&
    item.severity === 'error');

  for (let step = 0; step < maxSteps; step++) {
    for (const worker of workers) if (live.has(worker.id) && !slots.has(worker.id)) request(worker);
    // Real-time grace for host timers; a dispatch that never resolves is the lost wake-up being searched for.
    for (let wait = 0; wait < 40 && ![...slots.values()].some(slot => slot.done); wait++) await settle();
    const ready = workers.filter(worker => slots.get(worker.id)?.done);
    if (!ready.length) return { status: 'deadlock', steps: step, trace, detail: {
      tasks: state.cooperation!.tasks.map(node => [node.task.id, node.status, node.assignment?.workerId]),
      live: [...live], events: events.slice(-15) } };
    const broken = violations();
    if (broken.length) return { status: 'violation', steps: step, trace, detail: broken };
    if (draw() < 0.06) {
      // Whole-process restart: unsaved slots are dropped exactly as a killed host drops them.
      trace.push(`${step} restart`);
      controller.abort(); await cooperative.stop();
      const file = path.join(directory, 'state.json');
      writeSolverRunState(file, state); state = readSolverRunState(file);
      controller = new AbortController(); cooperative = create(); slots = new Map();
      // A new process starts every worker again, including one that crashed before the restart.
      for (const item of workers) live.add(item.id);
      await cooperative.restore();
      continue;
    }
    const worker = ready[Math.floor(draw() * ready.length)]!;
    const action = slots.get(worker.id)!.done!.action;
    slots.delete(worker.id);
    if (!action) {
      trace.push(`${step} ${worker.id} no-work`);
      cooperative.stopped(worker); live.delete(worker.id);
      if (worker.id === lead.id) return { status: 'deadlock', steps: step, trace, detail: { reason: 'lead stopped before assembly',
        tasks: state.cooperation!.tasks.map(node => [node.task.id, node.status, node.assignment?.workerId, node.attempts]),
        live: [...live], waits: state.workers!.map(item => [item.id, item.scheduling?.wait?.stage,
          item.scheduling?.wait?.candidates.map(candidate => candidate.reason)]), events: events.slice(-10) } };
      continue;
    }
    if (action.kind === 'assemble') { trace.push(`${step} assemble`); return { status: 'assembled', steps: step, trace }; }
    if (!cooperative.started(worker, action)) { trace.push(`${step} ${worker.id} ${action.kind} stale`); cooperative.release(worker, action); continue; }
    cooperative.activate(worker, action, async () => {}, async () => {});
    const roll = draw();
    try {
      if (action.kind === 'task') {
        const label = `${step} ${worker.id} ${action.task.id}`;
        // Losing the only engineer leaves goals unownable by design; crash only spare capacity.
        if (roll < 0.12 && worker.role !== 'engineer' && worker.id !== lead.id && crashes < 1) {
          trace.push(`${label} crash`); crashes++;
          cooperative.deactivate(worker); cooperative.stopped(worker, 'math_worker_failed'); live.delete(worker.id);
          continue;
        }
        if (roll < 0.3) { trace.push(`${label} interrupted`); cooperative.interrupted(worker, action); continue; }
        const wrong = roll < 0.5;
        const before = fs.readFileSync(source(worker), 'utf8');
        trace.push(`${label} ${wrong ? 'wrong' : 'proof'}` + (process.env.THEOREM_OS_SIMULATION_DEBUG
          ? ` seeded=${JSON.stringify(before.split('\n').filter(line => line.includes(':=')))}` : ''));
        host.failing = wrong;
        try {
          const result = await cooperative.deliver(worker, action, prove(worker, action.task.theoremName!, wrong));
          if (process.env.THEOREM_OS_SIMULATION_DEBUG) trace.push(`  -> passed=${result.check?.passed} status=${
            state.cooperation!.tasks.find(node => node.task.id === action.task.id)?.status} feedback=${
            (state.cooperation!.tasks.find(node => node.task.id === action.task.id)?.feedback ?? '').slice(0, 300)}`);
        }
        catch (error) {
          return { status: 'violation', steps: step, trace, detail: { thrown: String(error), events: events.slice(-12),
            tasks: state.cooperation!.tasks.map(node => [node.task.id, node.status, node.assignment?.workerId,
              Boolean(node.proof), Boolean(node.pendingValidation)]) } };
        }
      } else if (action.kind === 'lead') {
        // A failed original route is reconsidered in an ordinary plan turn; there is no separate recovery dispatch.
        const failed = state.cooperation!.tasks.filter(node => node.status === 'blocked' && node.attempts > 0).map(node => node.task.id);
        const mode = roll < 0.15 ? 'interrupted' : failed.length ? 'replan' : 'plan';
        trace.push(`${step} lead ${mode}${action.coordination ? ' coordination' : ''}`);
        if (mode === 'interrupted') { cooperative.interrupted(worker, action); continue; }
        // The bounded protocol: one complete event in the dispatch's delivery log, then the turn ends.
        let graph = planGraph();
        if (mode === 'replan') {
          // A new typed input for the failed tasks: the answer a real Lead gives after a failed route.
          const helper: CooperativeTask = { id: `helper_${++helpers}`, kind: 'lemma', objective: 'Prove the auxiliary fact.',
            // Lemma inputs are compared by type, not name: each new input must state a different fact.
            theoremName: `Tutorial.helper_${helpers}`, proofPath: 'Submission.lean', type: `${helpers} = ${helpers}`,
            dependsOn: [], revision: 0 };
          graph = parseCooperationPlan(problem, { ...graph, tasks: [...graph.tasks.map(item => failed.includes(item.id)
            ? { ...item, dependsOn: [...item.dependsOn, helper.id] } : item), helper] });
        }
        const file = leadPlanDeliveryFile(action);
        if (file) fs.appendFileSync(path.join(worker.worktree, file), JSON.stringify({ kind: 'plan',
          dispatchNonce: action.planNonce ?? action.initialPlanNonce, baseVersion: action.planVersion,
          summary: mode === 'replan' ? 'Split the failed inference through a new helper.'
            : 'The current graph remains the complete next step.', ...graph }) + '\n');
        else fs.writeFileSync(path.join(worker.worktree, 'RESEARCH.md'), '```math-plan\n' + JSON.stringify(graph) + '\n```\n');
        await cooperative.pulse(worker.id);
        await cooperative.deliver(worker, action, commitSolverSources(problem, worker.worktree));
      } else {
        trace.push(`${step} ${worker.id} ${action.kind} released`);
        cooperative.release(worker, action);
      }
    } finally { host.failing = false; cooperative.deactivate(worker); }
  }
  return { status: 'exhausted', steps: maxSteps, trace, detail: state.cooperation!.tasks.map(node => [node.task.id, node.status]) };
}

describe('seeded coordination simulation with fault injection', () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const run of cleanup.splice(0)) await run();
    expect(host.createSession).not.toHaveBeenCalled();
  });
  host.verify.mockImplementation(async request => {
    const batch = verifiedBatch(request, { sessionId: 'simulation', checks: true });
    return host.failing ? failedBatch(batch, { stdoutPreview: file => `${file}:3:1: error: unsolved goals`, goalsRemaining: 1 }) : batch;
  });
  host.createSession.mockImplementation(() => { throw new Error('real_models_are_not_used_in_simulation'); });

  const seeds = Number(process.env.THEOREM_OS_SIMULATION_SEEDS ?? 12);
  const first = Number(process.env.THEOREM_OS_SIMULATION_FIRST_SEED ?? 1);
  it.each(Array.from({ length: seeds }, (_, index) => first + index))('seed %i reaches assembly without lost work', async seed => {
    // Throws outside a task delivery (restore, Lead delivery) are failures too; the seed replays them.
    const outcome = await simulate(seed, cleanup).catch(error => ({ status: 'thrown', detail: String(error) }));
    if (outcome.status !== 'assembled') console.error(JSON.stringify({ seed, ...outcome }, null, 1));
    expect(outcome.status).toBe('assembled');
  }, 60_000);
});
