import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MathAgentActivity, MathAgentOptions, MathAgentSession } from '../src/runtime/codexSession';
import { CooperativeResearch } from '../src/solver/cooperation';
import { directSolverModules, type SolverModules } from '../src/solver/modules';
import { runResearchWorkers } from '../src/solver/research';
import { leadPlanDeliveryFile, parseCooperationPlan, taskVersion, type CooperativeAction, type CooperativeTask } from '../src/solver/tasks';
import { deferred } from './helpers/async';
import { workerAccess } from './helpers/cooperation';
import { leadWorker, localExample, peerWorker, solverState } from './helpers/solver';

vi.mock('../src/math/mathBuildManifest', () => ({ readMathBuildManifest: vi.fn() }));

const SLICE_MS = 10 * 60_000;
const WAIT_MS = 10 * 60_000;

describe('Lead checkpoint waits for its required decision handoff', () => {
  let directory: string;
  let controller: AbortController;
  let completion: Promise<unknown> | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    // Use explicit intake, avoiding an unrelated 200 ms cooperative poll in fake time.
    vi.spyOn(CooperativeResearch.prototype, 'start').mockImplementation(() => {});
  });
  afterEach(async () => {
    controller?.abort(new Error('fixture_complete'));
    if (completion) await Promise.allSettled([completion]);
    completion = undefined;
    vi.useRealTimers(); vi.restoreAllMocks();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  });

  async function fixture(options: { pendingNotice?: boolean; noNotify?: boolean } = {}) {
    let cooperation: CooperativeResearch | undefined;
    const activate = CooperativeResearch.prototype.activate;
    vi.spyOn(CooperativeResearch.prototype, 'activate').mockImplementation(function (this: CooperativeResearch, ...args) {
      cooperation = this;
      return activate.apply(this, args);
    });
    const example = localExample('lead-checkpoint-handoff-', 'lead');
    directory = example.directory;
    const { problem, workspace } = example;
    const workers = [leadWorker(problem, workspace), peerWorker(example, 'researcher')];
    const question: CooperativeTask = { id: 'question', kind: 'research', objective: 'Find the missing bridge.',
      status: 'paused', dependsOn: [], revision: 0 };
    const bridge: CooperativeTask = { id: 'bridge', kind: 'lemma', objective: 'Prove the smaller bridge.',
      proofPath: 'Submission.lean', theoremName: 'Tutorial.bridge', type: 'True', dependsOn: [], revision: 0 };
    const plan = parseCooperationPlan(problem, { tasks: [question, ...problem.targets.map((target, index) => ({
      id: `goal_${index + 1}`, kind: 'goal', objective: `Prove ${target.theoremName}.`, ...target, status: 'paused',
    }))] });
    const state = solverState(problem, workspace, { runId: 'lead-checkpoint-handoff', phase: 'prepared',
      workers: workers.map(worker => ({ ...worker, phase: 'prepared', turns: 0 })),
      cooperation: { canonicalCommit: problem.baseCommit,
        tasks: plan.tasks.map(task => ({ task, status: task.id === question.id ? 'completed' : 'pending', attempts: 0 })),
        groups: plan.groups.map(group => ({ group, turns: 0 })),
        deliveries: [{ id: 'bridge-delivery', producer: workers[1].id, taskId: question.id,
          taskDigest: taskVersion(question), kind: 'research', status: 'advisory',
          summary: 'This typed bridge needs a Lead decision.', statement: '', premises: [], dependencies: [],
          remainingObligations: [], evidenceRefs: [], createdAt: 1, lemmaRequests: [bridge] }] } });
    const started = deferred(), stopped = deferred<string>();
    let activity: ((activity: MathAgentActivity) => void) | undefined;
    let action: Extract<CooperativeAction, { kind: 'lead' }> | undefined;
    const interrupt = vi.fn(async () => { stopped.resolve('interrupted'); });
    const notice = deferred();
    const notify = vi.fn(async (_message: string) => { if (options.pendingNotice) await notice.promise; });
    const omitNotify = options.noNotify;
    const open = vi.fn(async (options: MathAgentOptions): Promise<MathAgentSession> => ({
      threadId: 'offline-lead-handoff-thread', interrupt, ...(!omitNotify ? { notify } : {}),
      close: async () => { stopped.resolve('closed'); },
      run: async (message, _messageId, _workspace, onStarted) => {
        const assigned = JSON.parse(message) as CooperativeAction;
        if (assigned.kind !== 'lead' || !assigned.planNonce || action) throw new Error('fixture_unexpected_assignment');
        action = assigned; activity = options.onActivity;
        onStarted('offline-lead-handoff-turn');
        activity?.({ event: 'reasoning' }); started.resolve();
        return stopped.promise;
      },
    }));
    const check = vi.fn(async () => { throw new Error('fixture_unexpected_proof_acceptance'); });
    const modules: SolverModules = { ...directSolverModules, M1: { ...directSolverModules.M1, open },
      M2: { ...directSolverModules.M2, check, checkTask: check },
      M4: { ...directSolverModules.M4, build: (_problem, _state, access) => ({
        instructions: 'Offline required-decision fixture.', message: JSON.stringify(access.assignment),
        scope: 'original-problem-and-allowed-library', sources: { problemReceiptDigest: problem.receiptDigest },
      }) } };
    const events: { event: string; details?: Record<string, unknown> }[] = [];
    controller = new AbortController();
    completion = runResearchWorkers({ state, workers, modules, access: workerAccess(workers, directory),
      root: directory, buildFile: path.join(directory, 'build.json'), taskText: 'Prove the frozen original targets.',
      executable: 'offline-fixture', profile: 'offline-fixture', signal: controller.signal,
      deadline: Infinity, maxTurnMs: Infinity, maxTurns: 1, maxTotalTokens: 0, goalProgressReviewMs: 24 * 3_600_000,
      save: () => {}, emit: (event, details) => events.push({ event, details }) });
    void completion.catch(() => {});
    await Promise.race([started.promise, completion.then(() => { throw new Error('fixture_finished_before_lead'); })]);
    expect(action).toBeDefined();
    const startCommand = () => activity!({ event: 'item_started', itemType: 'commandExecution' });
    const finishCommand = () => activity!({ event: 'item_completed', itemType: 'commandExecution' });
    const command = (save?: () => void) => { startCommand(); save?.(); finishCommand(); };
    const write = (response: unknown) => fs.writeFileSync(path.join(workspace, 'RESEARCH.md'),
      '```math-plan\n' + JSON.stringify(response) + '\n```\n');
    const revision = (decide = true) => ({ baseVersion: action!.planVersion, upsert: [], ...(decide ? {
      researchDecisions: [{ deliveryId: 'bridge-delivery', outcome: 'decline',
        reason: 'The current exact consumer uses a different argument.' }],
    } : {}) });
    const awaitSlice = async () => {
      await vi.advanceTimersByTimeAsync(SLICE_MS - 30_000);
      activity!({ event: 'reasoning' });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(notify.mock.calls.some(([message]) => message.includes('bridge-delivery'))).toBe(true);
      expect(events).toContainEqual({ event: 'cooperative_checkpoint_awaiting_request',
        details: expect.objectContaining({ workerId: 'solver', maxWaitMs: WAIT_MS }) });
      expect(interrupt).not.toHaveBeenCalled();
    };
    return { state, events, interrupt, check, command, startCommand, finishCommand, write, revision, awaitSlice,
      pulse: () => cooperation!.pulse(workers[0].id), action: action!, workspace, notice, notify };
  }

  it('keeps the turn open when the first successful command only reads the inherited plan', async () => {
    const f = await fixture(); await f.awaitSlice();
    await vi.advanceTimersByTimeAsync(113_000);
    f.command();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.interrupt).not.toHaveBeenCalled();
    expect(f.events.some(event => event.event === 'cooperative_checkpoint_request_settled')).toBe(false);
    expect(f.state.cooperation!.researchDecisions).toBeUndefined();
    expect(f.check).not.toHaveBeenCalled();
  });

  it('waits through an incomplete saved draft and stops after a complete decision is saved', async () => {
    const f = await fixture(); await f.awaitSlice();
    await vi.advanceTimersByTimeAsync(60_000);
    f.command(() => f.write(f.revision(false)));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.interrupt).not.toHaveBeenCalled();
    expect(f.state.cooperation!.researchDecisions).toBeUndefined();
    await vi.advanceTimersByTimeAsync(30_000);
    f.command(() => f.write(f.revision()));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.interrupt).toHaveBeenCalledOnce();
    expect(f.events).toContainEqual({ event: 'cooperative_checkpoint_request_settled',
      details: expect.objectContaining({ workerId: 'solver', boundary: 'request-returned', waitedMs: 90_000 }) });
    expect(f.check).not.toHaveBeenCalled();
  });

  it('continues only until the original wait deadline when no valid decision is saved', async () => {
    const f = await fixture(); await f.awaitSlice();
    await vi.advanceTimersByTimeAsync(WAIT_MS / 2);
    f.command();
    await vi.advanceTimersByTimeAsync(WAIT_MS / 2 - 1);
    expect(f.interrupt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.interrupt).toHaveBeenCalledOnce();
    expect(f.events).toContainEqual({ event: 'cooperative_checkpoint_request_settled',
      details: expect.objectContaining({ workerId: 'solver', boundary: 'wait-limit', waitedMs: WAIT_MS }) });
    expect(f.check).not.toHaveBeenCalled();
  });

  it('waits for the writing tool to finish even when its valid draft is already visible', async () => {
    const f = await fixture(); await f.awaitSlice();
    f.command();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.interrupt).not.toHaveBeenCalled();
    f.startCommand(); f.write(f.revision());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.interrupt).not.toHaveBeenCalled();
    f.finishCommand();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.interrupt).toHaveBeenCalledOnce();
    expect(f.events).toContainEqual({ event: 'cooperative_checkpoint_request_settled',
      details: expect.objectContaining({ workerId: 'solver', boundary: 'request-returned', waitedMs: 30_000 }) });
    expect(f.check).not.toHaveBeenCalled();
  });

  it('waits when a tool has saved a complete decision before the slice but has not returned', async () => {
    const f = await fixture();
    await vi.advanceTimersByTimeAsync(SLICE_MS - 30_000);
    f.startCommand(); f.write(f.revision());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.interrupt).not.toHaveBeenCalled();
    expect(f.state.cooperation!.researchDecisions).toBeUndefined();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.interrupt).not.toHaveBeenCalled();
    f.finishCommand();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.interrupt).toHaveBeenCalledOnce();
    expect(f.events).toContainEqual({ event: 'cooperative_checkpoint_request_settled',
      details: expect.objectContaining({ workerId: 'solver', boundary: 'request-returned', waitedMs: 30_000 }) });
    expect(f.check).not.toHaveBeenCalled();
  });

  it('keeps the original wait window after a queued notice arrives before the next model output', async () => {
    const f = await fixture({ pendingNotice: true }); await f.awaitSlice();
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    f.command(); // This request boundary can deliver the queued notice, but no decision exists.
    f.notice.resolve(); await vi.advanceTimersByTimeAsync(30_000);
    // An acknowledged steer is not a model response; provider latency must not consume the handoff.
    expect(f.interrupt).not.toHaveBeenCalled();
    expect(f.events.some(event => event.event === 'cooperative_checkpoint_request_settled')).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    f.command(() => f.write(f.revision()));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.interrupt).toHaveBeenCalledOnce();
    expect(f.events).toContainEqual({ event: 'cooperative_checkpoint_request_settled',
      details: expect.objectContaining({ workerId: 'solver', boundary: 'request-returned', waitedMs: 4 * 60_000 }) });
    expect(f.check).not.toHaveBeenCalled();
  });

  it('keeps the ordinary scheduling checkpoint when notifications are unavailable', async () => {
    const f = await fixture({ noNotify: true });
    await vi.advanceTimersByTimeAsync(SLICE_MS - 30_000);
    f.startCommand(); f.finishCommand();
    await vi.advanceTimersByTimeAsync(30_000);
    f.command();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.notify).not.toHaveBeenCalled();
    expect(f.interrupt).toHaveBeenCalledOnce();
    expect(f.events.some(event => event.event === 'lead_handoff_requested')).toBe(false);
    expect(f.check).not.toHaveBeenCalled();
  });

  it('ends the bounded wait when a queued notification fails', async () => {
    const f = await fixture({ pendingNotice: true }); await f.awaitSlice();
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    f.notice.reject(new Error('fixture_notice_rejected'));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.interrupt).toHaveBeenCalledOnce();
    expect(f.events).toContainEqual({ event: 'cooperative_checkpoint_request_settled',
      details: expect.objectContaining({ workerId: 'solver', boundary: 'notice-failed', waitedMs: 3 * 60_000 }) });
    expect(f.events.some(event => event.event === 'lead_handoff_requested')).toBe(false);
    expect(f.check).not.toHaveBeenCalled();
  });

  it('does not keep waiting after this dispatch has published a valid decision', async () => {
    const f = await fixture(); await f.awaitSlice();
    fs.appendFileSync(path.join(f.workspace, leadPlanDeliveryFile(f.action)!), JSON.stringify({
      kind: 'plan', dispatchNonce: f.action.planNonce, ...f.revision(),
    }) + '\n');
    await f.pulse();
    expect(f.state.cooperation!.planPublication).toMatchObject({ nonce: f.action.planNonce });
    expect(f.state.cooperation!.researchDecisions).toContainEqual(expect.objectContaining({
      deliveryId: 'bridge-delivery', outcome: 'decline' }));
    f.command();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.interrupt).toHaveBeenCalledOnce();
    expect(f.check).not.toHaveBeenCalled();
  });
});
