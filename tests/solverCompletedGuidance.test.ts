import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MathAgentSession } from '../src/runtime/codexSession';
import { CooperativeResearch } from '../src/solver/cooperation';
import { readHumanGuidance } from '../src/solver/humanGuidance';
import { directSolverModules, type SolverModules } from '../src/solver/modules';
import { runResearchWorkers } from '../src/solver/research';
import { leadPlanDeliveryFile, parseCooperationPlan, taskVersion, type CooperativeAction } from '../src/solver/tasks';
import { WorkerProofLifecycle } from '../src/solver/workerProofLifecycle';
import { workerAccess } from './helpers/cooperation';
import { leadWorker, localExample, peerWorker, solverState } from './helpers/solver';

const runtime = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock('../src/math/mathBuildManifest', () => ({ readMathBuildManifest: vi.fn() }));
vi.mock('../src/math/verifier', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/verifier')>(), checkManyFormalVerifications: runtime.verify,
  resolveMathematicsLakePackagesCache: () => undefined,
}));

describe('completed final guidance before ordinary plan delivery', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks(); });

  async function fixture(mode: 'accepted' | 'published-plan' | 'proof-intercept' | 'interrupted' | 'stale-turn' | 'wrong-owner' |
    'wrong-scope' | 'unknown-evidence' | 'invalid-candidate') {
    runtime.verify.mockReset().mockImplementation(() => { throw new Error('fixture_unexpected_proof_check'); });
    const example = localExample('solver-completed-guidance-', 'lead');
    const { directory, workspace, problem } = example;
    const workers = [leadWorker(problem, workspace), peerWorker(example, 'engineer', { role: 'engineer' })];
    const plan = parseCooperationPlan(problem, { tasks: problem.targets.map((target, index) => ({
      id: `goal_${index}`, kind: 'goal', objective: `Prove ${target.theoremName}.`, ...target,
    })) });
    const state = solverState(problem, workspace, { runId: 'completed-guidance-fixture', phase: 'prepared', planApproval: true,
      workers: workers.map(worker => ({ ...worker, phase: 'prepared', turns: 0 })),
      cooperation: { canonicalCommit: problem.baseCommit,
        tasks: plan.tasks.map(task => ({ task, status: 'pending', attempts: 0 })),
        groups: plan.groups.map(group => ({ group, turns: 0 })) } });
    if (mode === 'proof-intercept') {
      state.planApproval = false;
      state.cooperation!.tasks.forEach((node, index) => {
        node.task.status = index === 0 ? 'active' : 'paused'; node.task.ownerId = workers[1].id;
      });
    }
    const stateFile = path.join(directory, 'state.json'), guidanceFile = path.join(directory, 'human-guidance.json');
    const now = new Date().toISOString(), guidanceId = 'explicit-direction';
    fs.writeFileSync(guidanceFile, JSON.stringify({ schema: 'theorem-os.human-guidance.v1', runId: state.runId, records: [{
      id: guidanceId, recipient: mode === 'proof-intercept' ? { kind: 'task', id: 'goal_0' } : { kind: 'lead' },
      ...(mode === 'proof-intercept' ? { taskRef: { id: 'goal_0', version: taskVersion(state.cooperation!.tasks[0].task) } } : {}),
      text: 'Revise the exact route and report your handling decision.',
      observationRef: { sequence: 1, stateDigest: 'a'.repeat(64) }, status: 'queued', createdAt: now, updatedAt: now,
    }] }));
    const controller = new AbortController();
    let cooperation!: CooperativeResearch, deliveredBeforePlan = false;
    vi.spyOn(CooperativeResearch.prototype, 'start').mockImplementation(function (this: CooperativeResearch) { cooperation = this; });
    const deliver = CooperativeResearch.prototype.deliver;
    vi.spyOn(CooperativeResearch.prototype, 'deliver').mockImplementation(function (this: CooperativeResearch, ...args) {
      deliveredBeforePlan = readHumanGuidance(stateFile, state.runId)[0]?.decision?.status === 'accepted';
      return deliver.apply(this, args);
    });
    let deliveredBeforeProofIntercept = false;
    if (mode === 'proof-intercept') vi.spyOn(WorkerProofLifecycle.prototype, 'settleTurn').mockImplementation(async action => {
      if (action?.kind !== 'task') throw new Error('fixture_unexpected_proof_intercept');
      deliveredBeforeProofIntercept = readHumanGuidance(stateFile, state.runId)[0]?.decision?.status === 'accepted';
      return true;
    });
    let response: MathAgentSession['lastCompletedResponse'];
    let receivedGuidance = false, originalVersion: string | undefined;
    const execute = directSolverModules.M1.execute;
    const modules: SolverModules = { ...directSolverModules,
      M1: { ...directSolverModules.M1,
        execute: async (...args) => {
          const candidate = await execute(...args);
          return mode === 'invalid-candidate' ? { ...candidate, worktree: path.join(directory, 'foreign') } : candidate;
        },
        open: async (): Promise<MathAgentSession> => ({ threadId: 'current-thread',
          get lastCompletedResponse() { return response; },
          interrupt: async () => {}, close: async () => {},
          notify: async message => { receivedGuidance = message.includes(guidanceId); },
          run: async (message, _id, worktree, onStarted) => {
            const action = JSON.parse(message) as CooperativeAction;
            if (mode === 'proof-intercept' ? action.kind !== 'task' : action.kind !== 'lead')
              throw new Error('fixture_unexpected_model_responsibility');
            originalVersion = action.kind === 'lead' ? action.planVersion : undefined;
            onStarted('current-turn');
            await cooperation.pulse(mode === 'proof-intercept' ? workers[1].id : workers[0].id);
            expect(receivedGuidance).toBe(true);
            if (mode === 'wrong-owner' || mode === 'wrong-scope') {
              const records = readHumanGuidance(stateFile, state.runId);
              if (mode === 'wrong-owner') records[0].deliveredTo = [workers[1].id];
              else records[0].deliveredScope = { planVersion: 'previous-plan-version' };
              fs.writeFileSync(guidanceFile, JSON.stringify({ schema: 'theorem-os.human-guidance.v1', runId: state.runId, records }));
            }
            const tasks = state.cooperation!.tasks.map(node => ({ ...node.task, objective: node.task.objective + ' Use the revised route.' }));
            fs.writeFileSync(path.join(worktree, 'RESEARCH.md'), JSON.stringify({ tasks }));
            if (mode === 'published-plan' && action.kind === 'lead') {
              fs.appendFileSync(path.join(workspace, leadPlanDeliveryFile(action)!), JSON.stringify({
                kind: 'plan', dispatchNonce: action.planNonce, baseVersion: action.planVersion, tasks,
              }) + '\n');
              await cooperation.pulse(workers[0].id);
              expect(state.cooperation!.planVersion).not.toBe(originalVersion);
            }
            // The final contains no accepted plan. Its decoy task and proof must never enter the archive.
            response = { turnId: mode === 'stale-turn' ? 'previous-turn' : 'current-turn', text: '```json\n' + JSON.stringify({
              status: 'plan_revised', tasks: [{ id: 'final-only-decoy' }], proof: 'not accepted',
              guidanceDecisions: [{ guidanceId, status: 'accepted', reason: 'The exact requested route is relevant.',
                evidenceRefs: mode === 'unknown-evidence' ? [{ kind: 'task', id: 'final-only-decoy', version: 'unknown' }] : [] }],
            }) + '\n```' };
            return mode === 'interrupted' ? 'interrupted' : 'completed';
          },
        }),
      },
      M4: { ...directSolverModules.M4, build: (_problem, _state, access) => ({
        instructions: 'Offline completed guidance fixture.', message: JSON.stringify(access.assignment),
        scope: 'original-problem-and-allowed-library', sources: { problemReceiptDigest: problem.receiptDigest },
      }) },
    };
    const events: { event: string; details?: Record<string, unknown> }[] = [];
    const completion = runResearchWorkers({ state, workers, modules, access: workerAccess(workers, directory),
      root: directory, buildFile: path.join(directory, 'build.json'), taskText: 'Prove the frozen original goals.',
      executable: 'offline-fixture', profile: 'offline-fixture', signal: controller.signal, deadline: Infinity,
      maxTurns: 1, maxTurnMs: Infinity, maxTotalTokens: 0, save: () => {}, emit: (event, details) => events.push({ event, details }) });
    void completion.catch(() => {});
    cleanups.push(async () => { controller.abort(); await Promise.allSettled([completion]); fs.rmSync(directory, { recursive: true, force: true }); });
    return { state, stateFile, completion, events, deliveredBeforePlan: () => deliveredBeforePlan,
      deliveredBeforeProofIntercept: () => deliveredBeforeProofIntercept, originalVersion: () => originalVersion };
  }

  it('records the exact completed final decision before accepting the saved file plan', async () => {
    const f = await fixture('accepted');
    expect(await f.completion).toBeUndefined();
    expect(f.deliveredBeforePlan()).toBe(true);
    expect(readHumanGuidance(f.stateFile, f.state.runId)[0].decision).toMatchObject({
      status: 'accepted', workerId: 'solver', sourcePlanVersion: f.originalVersion(), evidenceRefs: [],
    });
    expect(f.state.cooperation!.planVersion).not.toBe(f.originalVersion());
    expect(f.state.cooperation!.tasks.map(node => node.task.id)).toEqual(['goal_0', 'goal_1']);
    expect(f.state.cooperation!.tasks.every(node => node.task.objective.endsWith('Use the revised route.'))).toBe(true);
    expect(f.state.cooperation!.tasks.every(node => !node.proof && !node.integratedCheck)).toBe(true);
    expect(f.state.check).toBeUndefined();
    expect(runtime.verify).not.toHaveBeenCalled();
  });

  it('binds a final decision to its original dispatch after that turn published a revised plan', async () => {
    const f = await fixture('published-plan'); await f.completion;
    expect(readHumanGuidance(f.stateFile, f.state.runId)[0].decision).toMatchObject({
      status: 'accepted', sourcePlanVersion: f.originalVersion(),
    });
    expect(f.state.cooperation!.planVersion).not.toBe(f.originalVersion());
    expect(f.state.cooperation!.tasks.map(node => node.task.id)).toEqual(['goal_0', 'goal_1']);
  });

  it('records an Engineer final before the typed proof lifecycle takes over the source delivery', async () => {
    const f = await fixture('proof-intercept'); await f.completion;
    expect(f.deliveredBeforeProofIntercept()).toBe(true);
    expect(readHumanGuidance(f.stateFile, f.state.runId)[0].decision).toMatchObject({
      status: 'accepted', workerId: 'engineer', sourceTaskRef: { id: 'goal_0', version: taskVersion(f.state.cooperation!.tasks[0].task) },
    });
    expect(f.state.cooperation!.tasks.every(node => !node.proof && !node.integratedCheck)).toBe(true);
    expect(runtime.verify).not.toHaveBeenCalled();
  });

  it.each(['interrupted', 'stale-turn', 'wrong-owner', 'wrong-scope', 'unknown-evidence', 'invalid-candidate'] as const)
  ('keeps the guidance undecided for %s', async mode => {
    const f = await fixture(mode);
    if (mode === 'invalid-candidate') await expect(f.completion).rejects.toThrow('math_candidate_identity_changed');
    else await f.completion;
    expect(readHumanGuidance(f.stateFile, f.state.runId)[0].decision).toBeUndefined();
    expect(f.deliveredBeforePlan()).toBe(false);
    if (mode === 'wrong-owner' || mode === 'wrong-scope' || mode === 'unknown-evidence')
      expect(f.events.some(item => item.event === 'human_guidance_decision_rejected')).toBe(true);
    expect(f.state.check).toBeUndefined();
    expect(runtime.verify).not.toHaveBeenCalled();
  });
});
