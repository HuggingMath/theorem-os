import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MathAgentOptions, MathAgentSession } from '../src/runtime/codexSession';
import { readSolverRunState, writeSolverRunState } from '../src/solver/archive';
import { CooperativeResearch } from '../src/solver/cooperation';
import { leadResearchInputs } from '../src/solver/contextCompiler';
import { observeGoalProgress } from '../src/solver/goalProgress';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { directSolverModules, type SolverModules } from '../src/solver/modules';
import { captureObligationSnapshot } from '../src/solver/obligationProgress';
import { committedSource, commitSolverSources, git } from '../src/solver/problem';
import { runResearchWorkers } from '../src/solver/research';
import { assignmentDeliveryFile, leadPlanDeliveryFile, parseCooperationPlan, taskVersion, type CooperativeAction } from '../src/solver/tasks';
import { deferred } from './helpers/async';
import { cooperativeResearch, workerAccess } from './helpers/cooperation';
import { leadWorker, localExample, peerWorker, solverState } from './helpers/solver';
import { DEFAULT_TACTIC_BATTERY_FAILURE_CACHE_ROOT } from '../src/solver/tacticBatteryFailureCache';

vi.mock('../src/math/mathBuildManifest', () => ({ readMathBuildManifest: vi.fn() }));

// A Lead revision turn has one fixed decision slice; any slice that ends mid-request waits for it.
const LEAD_REVISION_MS = 10 * 60_000;

describe('cooperative advisory scheduling checkpoints', () => {
  let directory: string;
  let controllers: AbortController[], running: Promise<unknown>[];

  beforeEach(() => {
    vi.useFakeTimers();
    controllers = []; running = [];
    // Exercise the ordinary explicit pulse/delivery path without advancing the unrelated poller 600 times.
    vi.spyOn(CooperativeResearch.prototype, 'start').mockImplementation(() => {});
  });
  afterEach(async () => {
    controllers.forEach(controller => controller.abort()); await Promise.allSettled(running);
    vi.useRealTimers(); vi.restoreAllMocks();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  });

  function fixture(initial = false, projectRelative?: string, continuation?: 'lead' | 'lead-capacity' | 'custom-full' | 'peer', review = false) {
    let cooperation: CooperativeResearch | undefined;
    const activate = CooperativeResearch.prototype.activate;
    vi.spyOn(CooperativeResearch.prototype, 'activate').mockImplementation(function (this: CooperativeResearch, ...args) {
      cooperation = this;
      return activate.apply(this, args);
    });
    const example = localExample('solver-advisory-checkpoint-', 'lead');
    directory = example.directory;
    if (projectRelative) {
      git(example.workspace, ['mv', '--', example.problem.projectRelative, projectRelative]);
      git(example.workspace, ['-c', 'user.name=Offline fixture', '-c', 'user.email=fixture@localhost',
        'commit', '--no-gpg-sign', '--quiet', '-m', 'Relocate disposable scheduling fixture']);
      example.problem = { ...example.problem, projectRelative, baseCommit: git(example.workspace, ['rev-parse', 'HEAD']) };
    }
    const { workspace, problem } = example;
    const workers = [leadWorker(problem, workspace), peerWorker(example, initial ? 'engineer' : 'researcher',
      { role: initial ? 'engineer' : continuation === 'lead-capacity' ? 'prover' : 'researcher' })];
    const plan = parseCooperationPlan(problem, { tasks: [
      ...problem.targets.map((target, index) => ({ id: `goal_${index + 1}`, kind: 'goal',
        objective: `Prove ${target.theoremName}`, ...target, status: 'paused' })),
      { id: 'investigate', kind: 'research', ownerId: 'researcher', objective: 'Resolve the precise missing construction.',
        ...(review ? { reviewScope: 'feasibility' } : {}) },
    ] });
    const state = solverState(problem, workspace, { runId: 'advisory-checkpoint-fixture', phase: 'prepared',
      workers: workers.map(worker => ({ ...worker, phase: 'prepared', turns: 0 })),
      ...initial ? {} : { cooperation: { tasks: plan.tasks.map(task => ({ task, status: 'pending', attempts: 0 })),
        groups: plan.groups.map(group => ({ group, turns: 0 })) } } });
    if (continuation && continuation !== 'peer') {
      state.cooperation!.error = 'offline_lead_replanning_required';
      state.cooperation!.tasks.find(node => node.task.id === 'investigate')!.task.status = 'paused';
      if (continuation === 'lead-capacity') {
        state.cooperation!.tasks.find(node => node.task.id === 'investigate')!.task.status = 'active';
        for (const node of state.cooperation!.tasks.filter(node => node.task.kind === 'goal')) {
          node.task.status = 'active'; node.task.dependsOn = ['investigate'];
        }
      }
    }
    const check = vi.fn(async () => { throw new Error('fixture_unexpected_proof_acceptance'); });
    const events: { event: string; details?: Record<string, unknown> }[] = [];
    const controller = new AbortController();
    controllers.push(controller);
    const contextSettings = { instructionsSuffix: '' };
    const modules = (open: (options: MathAgentOptions) => Promise<MathAgentSession>): SolverModules => ({
      ...directSolverModules, M1: { ...directSolverModules.M1, open },
      M2: { ...directSolverModules.M2, check, checkTask: check },
      M4: { ...directSolverModules.M4, build: (_problem, _state, access) => {
        const assignment = access.assignment!;
        const current = { assignment, receipt: leadPlanDeliveryFile(assignment),
          feedback: assignment.kind === 'task' ? _state.cooperation?.tasks.find(node => node.task.id === assignment.task.id)?.feedback : undefined,
          inbox: _state.cooperation?.deliveries?.map(delivery => delivery.summary) ?? [] };
        return {
          instructions: 'Offline scheduling fixture.' + contextSettings.instructionsSuffix +
            (continuation && assignment.kind === 'lead' ? assignment.planNonce : ''),
          message: continuation ? JSON.stringify({ ...current, mode: 'full',
            exactTasks: state.cooperation!.tasks.map(node => node.task), sentinel: 'full-context-exact-types-'.repeat(300) })
            : JSON.stringify(assignment),
          ...(continuation && continuation !== 'custom-full' ? { continuationMessage: JSON.stringify({ ...current, mode: 'short' }) } : {}),
          scope: 'original-problem-and-allowed-library', sources: { problemReceiptDigest: problem.receiptDigest },
        };
      } },
    });
    const run = (open: (options: MathAgentOptions) => Promise<MathAgentSession>, maxTurns = 2,
      onEvent?: (event: string, details?: Record<string, unknown>) => void,
      softSlice?: Parameters<typeof runResearchWorkers>[0]['softSlice']) => {
      const completion = runResearchWorkers({
        state, workers, modules: modules(open), access: workerAccess(workers, directory),
        root: directory, buildFile: path.join(directory, 'build.json'), taskText: 'Prove the original targets.',
        executable: 'offline-fixture', profile: 'offline-fixture', signal: controller.signal,
        deadline: Infinity, maxTurnMs: Infinity, maxTurns, maxTotalTokens: 0,
        // Checkpoint timing is under test; a goal-progress Lead review would need a Lead model turn.
        goalProgressReviewMs: 24 * 3_600_000,
        softSlice,
        save: () => {}, emit: (event, details) => { events.push({ event, details }); onEvent?.(event, details); },
      });
      running.push(completion); return completion;
    };
    return { state, workers, problem, check, events, controller, run, contextSettings,
      pulse: (workerId: string) => cooperation!.pulse(workerId),
      wake: () => cooperation!.modelBudgetChanged() };
  }

  function heldAdvisoryTurns(count: number, taskIds = ['investigate'], lastInputTokens?: number) {
    const started = Array.from({ length: count }, () => deferred());
    const done = Array.from({ length: count }, () => deferred<string>());
    const actions: Extract<CooperativeAction, { kind: 'task' }>[] = [];
    let index = 0, active: ReturnType<typeof deferred<string>> | undefined;
    const interrupt = vi.fn(async () => { active?.resolve('interrupted'); });
    const notify = vi.fn(async (_message: string) => {});
    const open = vi.fn(async (options: MathAgentOptions): Promise<MathAgentSession> => ({
      threadId: options.threadId ?? 'persistent-backoff-thread', interrupt, notify, lastInputTokens,
      close: async () => { active?.resolve('interrupted'); },
      run: async (message, _messageId, _workspace, onStarted) => {
        const turn = index++;
        if (turn >= count) throw new Error('fixture_unexpected_extra_turn');
        const action = JSON.parse(message) as CooperativeAction;
        if (action.kind !== 'task' || !taskIds.includes(action.task.id)) throw new Error('fixture_unexpected_responsibility:' + action.kind);
        actions.push(action); active = done[turn];
        onStarted(`backoff-turn-${turn}`); started[turn].resolve();
        // The advisory clock starts at the model's first produced item, not at turn admission.
        options.onActivity?.({ event: 'reasoning' });
        return done[turn].promise;
      },
    }));
    const wait = (turn: number, completion: Promise<unknown>) => Promise.race([started[turn].promise,
      completion.then(() => { throw new Error('fixture_finished_before_expected_turn:' + turn); })]);
    return { started, done, actions, interrupt, notify, open, wait };
  }

  async function reachBackoffCap(held: ReturnType<typeof heldAdvisoryTurns>, completion: Promise<unknown>) {
    await held.wait(0, completion);
    for (const [turn, interval] of [120_000, 240_000, 480_000].entries()) {
      await vi.advanceTimersByTimeAsync(interval);
      await held.wait(turn + 1, completion);
    }
  }

  it.each([true, false])('routes ordinary peer updates through native advisory only when the session supports it (%s)', async nativeAdvisory => {
    const { workers, controller, run } = fixture();
    const held = heldAdvisoryTurns(1), notify = vi.fn(async (_message: string, _options?: { waitForRequest?: boolean; mode?: 'advisory' }) => {});
    const open = async (options: MathAgentOptions): Promise<MathAgentSession> => ({ ...await held.open(options), notify,
      ...(nativeAdvisory ? { advisoryNotifications: 'native-history' as const } : {}) });
    const completion = run(open, 1); void completion.catch(() => {}); await held.wait(0, completion);
    const active = vi.mocked(CooperativeResearch.prototype.activate).mock.calls.find(([worker]) => worker.id === workers[1].id)!;
    await active[3]('A peer published a finding.', { mode: 'advisory' });
    expect(notify).toHaveBeenLastCalledWith('A peer published a finding.', nativeAdvisory ? { mode: 'advisory' } : { waitForRequest: true });
    await active[3]('A queued human instruction.', { requireTurn: true });
    expect(notify).toHaveBeenLastCalledWith('A queued human instruction.', { waitForRequest: false });
    expect(held.interrupt).not.toHaveBeenCalled();
    controller.abort(new Error('fixture_complete')); await expect(completion).rejects.toThrow('fixture_complete');
  });

  it.each([false, true])('publishes the research reminder example through the current assignment protocol (needs decision: %s)', async needsDecision => {
    const { state, workers, check, controller, run, pulse } = fixture();
    const held = heldAdvisoryTurns(1), completion = run(held.open, 1); void completion.catch(() => {});
    await held.wait(0, completion);
    await vi.advanceTimersByTimeAsync(90_000);
    const message = held.notify.mock.calls[0]![0] as string;
    const example = message.match(/Append one complete JSON line to ("(?:\\.|[^"])*"): (\{"kind":"research".*?\}\})\./u);
    expect(example).not.toBeNull();
    const log = JSON.parse(example![1]) as string;
    expect(log).toBe(path.join(workers[1].worktree, assignmentDeliveryFile(held.actions[0].assignment)));
    const value = JSON.parse(example![2]);
    expect(value.finding).not.toHaveProperty('needsDecision');
    value.finding.summary = needsDecision
      ? 'The saved search resolves the available identities but leaves the uniform norm estimate open; Lead must choose a different estimate.'
      : 'The saved algebraic reduction supplies the exact identity needed by the consumer.';
    value.finding.conclusion = needsDecision ? 'inconclusive' : 'supporting';
    value.finding.remainingObligations = needsDecision ? ['Construct the uniform norm estimate.'] : [];
    if (needsDecision) value.finding.needsDecision = true;
    fs.writeFileSync(path.join(workers[1].worktree, 'RESEARCH.md'), value.finding.summary + '\n');
    fs.appendFileSync(log, JSON.stringify(value) + '\n');
    const wakes = state.cooperation!.leadWakes!.requested;
    await pulse(workers[1].id);
    const delivery = state.cooperation!.deliveries!.find(item => item.taskId === held.actions[0].task.id && item.kind === 'research');
    expect(delivery).toMatchObject({ taskDigest: held.actions[0].assignment.taskDigest,
      summary: value.finding.summary, status: needsDecision ? 'conditional' : 'advisory' });
    expect(JSON.parse(delivery!.finding!)).toMatchObject(value.finding);
    expect(state.cooperation!.leadWakes!.requested).toBe(wakes + (needsDecision ? 1 : 0));
    if (needsDecision) expect(state.cooperation!.leadWakes!.recent!.at(-1)!.reason).toBe('research-finding');
    expect(check).not.toHaveBeenCalled(); expect(state.check).toBeUndefined();
    expect(held.interrupt).not.toHaveBeenCalled();
    controller.abort(new Error('fixture_complete')); await expect(completion).rejects.toThrow('fixture_complete');
  });

  function heldContinuationTurns(options: { saveNotes?: boolean; highContext?: boolean; deferFirstActivity?: boolean; count?: number;
    nativeCompact?: 'success' | 'failure' } = {}) {
    const count = options.count ?? 2;
    const started = Array.from({ length: count }, () => deferred()), done = Array.from({ length: count }, () => deferred<string>());
    const messages: { assignment: CooperativeAction; receipt?: string; mode: string; exactTasks?: unknown[]; sentinel?: string;
      feedback?: string; inbox?: string[] }[] = [];
    const threads: string[] = [];
    let turns = 0, newThreads = 0, active: ReturnType<typeof deferred<string>> | undefined;
    const interrupt = vi.fn(async () => { active?.resolve('interrupted'); });
    const close = vi.fn(async () => { active?.resolve('interrupted'); });
    const notify = vi.fn(async (_message: string) => {});
    const compact = vi.fn();
    const open = vi.fn(async (access: MathAgentOptions): Promise<MathAgentSession> => {
      const threadId = access.threadId ?? `continuation-thread-${++newThreads}`;
      let inputTokens = options.highContext ? 100_000 : 0, running = false;
      return { threadId, close, interrupt, notify,
        get lastInputTokens() { return inputTokens; },
        ...(options.nativeCompact ? { compact: async () => {
          compact(); expect(running).toBe(false);
          if (options.nativeCompact === 'failure') throw new Error('fixture_compaction_failed');
          inputTokens = 12;
          access.onUsage({ inputTokens: 12, outputTokens: 2, totalTokens: 14 }, { turnId: 'native-compact-turn' });
        } } : {}),
        run: async (message, _messageId, _workspace, onStarted) => {
          running = true;
          const turn = turns++;
          if (turn >= count) throw new Error('fixture_unexpected_extra_continuation_turn');
          messages.push(JSON.parse(message)); threads.push(threadId); active = done[turn];
          onStarted(`continuation-turn-${turn}`);
          if (turn === 0 && options.saveNotes)
            fs.writeFileSync(path.join(access.workspace, 'RESEARCH.md'), 'The current mathematical argument and exact unresolved inference are saved.\n');
          started[turn].resolve();
          // The advisory clock starts at the model's first produced item, not at turn admission.
          if (!options.deferFirstActivity) access.onActivity?.({ event: 'reasoning' });
          try { return await done[turn].promise; } finally { running = false; }
        } };
    });
    const wait = (turn: number, completion: Promise<unknown>) => Promise.race([started[turn].promise,
      completion.then(() => { throw new Error('fixture_finished_before_continuation:' + turn); })]);
    return { open, close, interrupt, notify, compact, messages, threads, wait };
  }

  it('publishes a saved partial finding only after its scheduling checkpoint has stopped the writer', async () => {
    const { state, workers, problem, check, run } = fixture();
    const held = heldAdvisoryTurns(1), stopping = deferred(), stopped = deferred();
    held.interrupt.mockImplementation(async () => {
      stopping.resolve(); await stopped.promise; held.done[0].resolve('interrupted');
    });
    const completion = run(held.open, 1); void completion.catch(() => {});
    try {
      await held.wait(0, completion);
      const notes = 'The complete local derivation remains here.\n\n```math-result\n' + JSON.stringify({
        summary: 'The boundary case is established; uniform control remains unknown.', conclusion: 'inconclusive',
        remainingObligations: ['Prove the uniform estimate using the exact original quantifiers.'],
      }) + '\n```\n';
      fs.writeFileSync(path.join(workers[1].worktree, 'RESEARCH.md'), notes);
      await vi.advanceTimersByTimeAsync(90_000);
      expect(held.notify.mock.calls[0][0]).toContain('Append one complete JSON line to');
      expect(held.notify.mock.calls[0][0]).toContain(assignmentDeliveryFile(held.actions[0].assignment));
      expect(held.notify.mock.calls[0][0]).toContain('"kind":"research","finding":');
      await vi.advanceTimersByTimeAsync(30_000); await stopping.promise;
      expect(state.cooperation!.deliveries ?? []).toEqual([]);
      expect(state.cooperation!.researchDrafts?.investigate).toBeUndefined();
      expect(state.cooperation!.tasks.find(node => node.task.id === 'investigate')!.status).toBe('running');
      stopped.resolve(); await completion;
      const [delivery] = state.cooperation!.deliveries!.filter(record => record.kind === 'research');
      expect(delivery).toMatchObject({ taskId: 'investigate', researchRecord: { complete: false } });
      expect(leadResearchInputs([delivery], new Map(state.cooperation!.tasks.map(node => [node.task.id, node])))).toEqual([delivery]);
      expect(committedSource(workers[0].worktree, delivery.commit!, 'RESEARCH.md')).toBe(notes);
      expect(state.cooperation!.tasks.find(node => node.task.id === 'investigate')!.status).toBe('pending');
      expect(state.problem.receiptDigest).toBe(problem.receiptDigest);
      expect(check).not.toHaveBeenCalled(); expect(state.check).toBeUndefined();
    } finally { stopped.resolve(); }
  });

  it.each([{ event: 'reasoning' as const }, { event: 'item_started' as const, itemType: 'commandExecution' }])(
    'starts the work slice only at real model or tool activity (%j)', async firstActivity => {
      const { state, events, controller, run } = fixture(false, undefined, 'lead');
      const held = heldContinuationTurns({ deferFirstActivity: true }), completion = run(held.open, Infinity);
      void completion.catch(() => {}); await held.wait(0, completion);
      delete state.cooperation!.error;
      const activity = held.open.mock.calls[0][0].onActivity!;
      activity({ event: 'item_started', itemType: 'userMessage' });
      activity({ event: 'item_completed', itemType: 'userMessage' });
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(events.filter(item => item.event === 'cooperative_checkpoint_clock_started')).toEqual([]);
      expect(held.notify).not.toHaveBeenCalled();
      expect(held.interrupt).not.toHaveBeenCalled();

      activity(firstActivity);
      expect(events.filter(item => item.event === 'cooperative_checkpoint_clock_started')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(4 * 60_000 - 1);
      expect(held.notify).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(held.notify).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(LEAD_REVISION_MS - 4 * 60_000 - 1);
      expect(held.interrupt).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      if (firstActivity.itemType === 'commandExecution') {
        expect(held.interrupt).not.toHaveBeenCalled();
        activity({ event: 'item_completed', itemType: 'commandExecution' });
      }
      await held.wait(1, completion);
      expect(held.interrupt).toHaveBeenCalledOnce();
      controller.abort(new Error('fixture_complete')); await expect(completion).rejects.toThrow('fixture_complete');
      expect(vi.getTimerCount()).toBe(0);
    });

  it('keeps the independent silent-turn fallback despite input messages', async () => {
    const { events, controller, run } = fixture(false, undefined, 'lead');
    const held = heldContinuationTurns({ deferFirstActivity: true }), completion = run(held.open, Infinity);
    void completion.catch(() => {}); await held.wait(0, completion);
    const activity = held.open.mock.calls[0][0].onActivity!;
    activity({ event: 'item_started', itemType: 'userMessage' });
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    activity({ event: 'item_completed', itemType: 'userMessage' });
    await vi.advanceTimersByTimeAsync(60_000 - 1);
    expect(events.filter(item => item.event === 'cooperative_checkpoint_clock_started')).toEqual([]);
    expect(held.notify).not.toHaveBeenCalled();
    expect(held.interrupt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(events).toContainEqual({ event: 'cooperative_checkpoint_clock_started',
      details: expect.objectContaining({ itemType: 'none', silentMs: 15 * 60_000 }) });
    await vi.advanceTimersByTimeAsync(LEAD_REVISION_MS - 1);
    expect(held.interrupt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await held.wait(1, completion);
    expect(held.interrupt).toHaveBeenCalledOnce();
    controller.abort(new Error('fixture_complete')); await expect(completion).rejects.toThrow('fixture_complete');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pauses the Lead scheduling clock during compaction and resumes its remaining work slice', async () => {
    const { events, controller, run } = fixture(false, undefined, 'lead');
    const held = heldContinuationTurns({ saveNotes: true }), completion = run(held.open, Infinity); void completion.catch(() => {});
    await held.wait(0, completion);
    await vi.advanceTimersByTimeAsync(30_000);
    const activity = held.open.mock.calls[0][0].onActivity!;
    activity({ event: 'item_started', itemType: 'contextCompaction' });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(held.interrupt).not.toHaveBeenCalled();
    expect(held.open).toHaveBeenCalledOnce();
    activity({ event: 'item_completed', itemType: 'contextCompaction' });
    await vi.advanceTimersByTimeAsync(LEAD_REVISION_MS - 30_001);
    expect(held.interrupt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await held.wait(1, completion);
    expect(held.interrupt).toHaveBeenCalledOnce();
    expect(held.threads).toEqual(['continuation-thread-1', 'continuation-thread-1']);
    expect(held.messages.map(message => message.mode)).toEqual(['full', 'full']);
    expect(events.some(item => item.event === 'context_compaction_completed')).toBe(true);
    controller.abort(new Error('fixture_complete')); await expect(completion).rejects.toThrow('fixture_complete');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives each Lead revision one fixed decision slice with an early decide-now reminder', async () => {
    const { events, controller, run } = fixture(false, undefined, 'lead');
    const held = heldContinuationTurns(), completion = run(held.open, Infinity); void completion.catch(() => {});
    await held.wait(0, completion);
    await vi.advanceTimersByTimeAsync(4 * 60_000 - 1);
    expect(held.notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(held.notify).toHaveBeenCalledOnce();
    expect(held.notify.mock.calls[0]![0]).toMatch(/^Decide now, before further searches/u);
    await vi.advanceTimersByTimeAsync(LEAD_REVISION_MS - 4 * 60_000 - 1);
    expect(held.interrupt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await held.wait(1, completion);
    expect(held.interrupt).toHaveBeenCalledOnce();
    // An unchanged cut does not stretch the next decision slice.
    const slices = events.filter(item => item.event === 'cooperative_checkpoint_scheduled').map(item => item.details);
    expect(slices).toEqual([expect.objectContaining({ checkpointAfterMs: LEAD_REVISION_MS, noticeAfterMs: 4 * 60_000 }),
      expect.objectContaining({ checkpointAfterMs: LEAD_REVISION_MS, noticeAfterMs: 4 * 60_000, noProgressStreak: 1, backoffCapped: false })]);
    expect(events.some(item => item.event === 'cooperative_checkpoint_deferred')).toBe(false);
    controller.abort(new Error('fixture_complete')); await expect(completion).rejects.toThrow('fixture_complete');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['current', 'settled', 'replaced'] as const)(
    'rechecks the presented progress review when the queued Lead reminder is delivered (%s)', async status => {
      const { state, events, controller, run } = fixture(false, undefined, 'lead');
      const tasks = state.cooperation!.tasks.map(node => ({ ...node, task: { ...node.task, status: 'active' as const } }));
      const intervalMs = 24 * 3_600_000, now = Date.now();
      const input = { problemReceiptDigest: state.problem.receiptDigest, targets: state.problem.targets, tasks,
        snapshot: captureObligationSnapshot(tasks), intervalMs,
        activeTaskIds: new Set(tasks.filter(node => node.task.kind === 'goal').map(node => node.task.id)) };
      const observed = observeGoalProgress(undefined, { ...input, now: now - intervalMs });
      const progress = observeGoalProgress(observed.state, { ...input, now }).state;
      const presented = structuredClone(progress.pending!);
      expect(presented.goalIds.length).toBeGreaterThan(0);
      state.cooperation!.goalProgress = progress;
      const held = heldContinuationTurns(), completion = run(held.open, Infinity); void completion.catch(() => {});
      await held.wait(0, completion);
      delete state.cooperation!.error;
      // emit runs after the timer fires and before the queued notify microtask. A peer may settle
      // this review in that gap, so the reminder must not keep the timer's earlier obligation snapshot.
      vi.spyOn(events, 'push').mockImplementation((...items) => {
        if (items.some(item => item.event === 'cooperative_checkpoint_requested')) {
          if (status === 'settled') delete state.cooperation!.goalProgress!.pending;
          if (status === 'replaced') state.cooperation!.goalProgress!.pending = { ...presented, id: 'replacement-review' };
        }
        return Array.prototype.push.apply(events, items);
      });
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      expect(held.notify).toHaveBeenCalledOnce();
      const reminder = held.notify.mock.calls[0]![0];
      if (status === 'current') {
        expect(reminder).toContain('Include progressReview with id ' + JSON.stringify(presented.id));
        expect(reminder).toContain('nextChecks covering every reviewed goal: ' + JSON.stringify(presented.goalIds));
        expect(reminder).not.toContain('return without a revision');
      } else {
        expect(reminder).toContain('return without a revision');
        expect(reminder).not.toContain(presented.id);
        expect(reminder).not.toContain('replacement-review');
      }
      expect(held.interrupt).not.toHaveBeenCalled();
      controller.abort(new Error('fixture_complete')); await expect(completion).rejects.toThrow('fixture_complete');
      expect(vi.getTimerCount()).toBe(0);
    });

  it.each(['request-returned', 'wait-limit'] as const)(
    'lets a Lead revision slice that ends mid-request wait for that request (%s)', async boundary => {
      const { state, events, controller, run } = fixture(false, undefined, 'lead');
      const held = heldContinuationTurns(), completion = run(held.open, Infinity); void completion.catch(() => {});
      await held.wait(0, completion);
      // This case has no required decision; required handoffs have their own regression fixtures.
      delete state.cooperation!.error;
      const activity = held.open.mock.calls[0][0].onActivity!;
      // The model is still streaming one long request when the slice ends.
      await vi.advanceTimersByTimeAsync(LEAD_REVISION_MS - 30_000);
      activity({ event: 'reasoning' });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(held.interrupt).not.toHaveBeenCalled();
      expect(events).toContainEqual({ event: 'cooperative_checkpoint_awaiting_request',
        details: expect.objectContaining({ workerId: 'solver', maxWaitMs: 10 * 60_000, outputAgeMs: 30_000 }) });
      if (boundary === 'request-returned') {
        await vi.advanceTimersByTimeAsync(3 * 60_000);
        // A tool the request called is part of it: the cut waits until its result is recorded.
        activity({ event: 'item_started', itemType: 'commandExecution' });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(held.interrupt).not.toHaveBeenCalled();
        activity({ event: 'item_completed', itemType: 'commandExecution' });
      } else {
        await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
        expect(held.interrupt).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
      }
      await held.wait(1, completion);
      expect(held.interrupt).toHaveBeenCalledOnce();
      expect(events).toContainEqual({ event: 'cooperative_checkpoint_request_settled', details: expect.objectContaining({
        workerId: 'solver', boundary, waitedMs: boundary === 'request-returned' ? 4 * 60_000 : 10 * 60_000 }) });
      controller.abort(new Error('fixture_complete')); await expect(completion).rejects.toThrow('fixture_complete');
      expect(vi.getTimerCount()).toBe(0);
    });

  it.each(['ready', 'compacting', 'claimed-elsewhere', 'target-lost-at-boundary', 'dispatch-mismatch'] as const)(
    'only checkpoints at the request boundary with a saved draft and the same proof (%s)', async outcome => {
      const { state, workers, check, events, controller, run, wake } = fixture(false, undefined, undefined, true);
      const held = heldAdvisoryTurns(2, ['investigate', 'goal_1']);
      const open = async (options: MathAgentOptions): Promise<MathAgentSession> => ({
        ...await held.open(options), usageSource: 'upstream-requests', advisoryNotifications: 'native-history',
      });
      const goal = state.cooperation!.tasks.find(node => node.task.id === 'goal_1')!;
      const reassignGoal = () => {
        goal.task = { ...goal.task, ownerId: 'a-different-worker' };
        wake();
      };
      const completion = run(open, Infinity, event => {
        if (outcome === 'dispatch-mismatch' && event === 'advisory_yielded_for_typed_work') {
          // A peer becomes responsible for the goal after the final handoff check and before dispatch.
          reassignGoal();
        }
      });
      void completion.catch(() => {});
      await held.wait(0, completion);
      const options = held.open.mock.calls[0][0];
      const activity = options.onActivity!;
      const boundary = () => options.requestGate!.checkpoint!();
      goal.task = { ...goal.task, status: 'active', ownerId: 'researcher' };
      wake();
      // A ready proof cannot displace this advisory turn before the default protection window.
      await vi.advanceTimersByTimeAsync(175_000);
      expect(held.notify).not.toHaveBeenCalled();
      expect(boundary()).toBe(false);
      if (outcome === 'compacting') {
        activity({ event: 'item_started', itemType: 'contextCompaction' });
        await vi.advanceTimersByTimeAsync(5_000);
        expect(held.notify).not.toHaveBeenCalled();
        activity({ event: 'item_completed', itemType: 'contextCompaction' });
      }
      await vi.advanceTimersByTimeAsync(5_000);
      expect(held.notify).toHaveBeenCalledWith(expect.stringContaining('A typed proof task is now ready'), { mode: 'advisory' });
      expect(boundary()).toBe(false);
      const notes = 'Inspected the exact pinned input. The independent review is unfinished.\n';
      activity({ event: 'item_started', itemType: 'commandExecution' });
      fs.writeFileSync(path.join(workers[1].worktree, 'RESEARCH.md'), notes);
      expect(boundary()).toBe(false);
      activity({ event: 'item_completed', itemType: 'commandExecution' });
      expect(held.interrupt).not.toHaveBeenCalled();

      if (outcome === 'claimed-elsewhere') {
        // The existing handoff is stale by the time the model asks for another request.
        reassignGoal();
        expect(boundary()).toBe(false);
        expect(events.some(item => item.event === 'turn_checkpoint')).toBe(false);
        // Even if the model already saw the notice and returns, its incomplete draft is preserved.
        held.done[0].resolve('completed');
        await held.wait(1, completion);
        expect(held.actions[1].task.id).toBe('investigate');
        expect(events).toContainEqual({ event: 'proof_handoff_target_changed',
          details: expect.objectContaining({ workerId: 'researcher', successorTaskId: 'goal_1' }) });
      } else {
        expect(boundary()).toBe(true);
        if (outcome === 'target-lost-at-boundary') reassignGoal();
        held.done[0].resolve('checkpoint');
        await held.wait(1, completion);
        const mismatch = outcome === 'dispatch-mismatch' || outcome === 'target-lost-at-boundary';
        expect(held.actions[1].task.id).toBe(mismatch ? 'investigate' : 'goal_1');
        expect(events).toContainEqual({ event: outcome === 'target-lost-at-boundary' ?
          'proof_handoff_target_changed' : 'advisory_yielded_for_typed_work',
          details: expect.objectContaining({ workerId: 'researcher', successorTaskId: 'goal_1' }) });
        if (mismatch) {
          expect(events).toContainEqual({ event: 'cooperative_preemption_mismatch',
            details: expect.objectContaining({ workerId: 'researcher', taskId: 'investigate',
              targetTaskId: 'goal_1', assignedKind: 'research', assignedTaskId: 'investigate',
              cooldownUntil: Date.now() + 10 * 60_000 }) });
        } else expect(events.some(item => item.event === 'cooperative_preemption_mismatch')).toBe(false);
      }
      const audit = state.cooperation!.tasks.find(node => node.task.id === 'investigate')!;
      const draft = state.cooperation!.researchDrafts!.investigate;
      expect(audit.researchCompletion).toBeUndefined();
      expect(draft.feasibilityInputDigest).toBe(held.actions[0].assignment.feasibilityInputDigest);
      expect(committedSource(workers[1].worktree, draft.commit, 'RESEARCH.md')).toBe(notes);
      expect(held.interrupt).not.toHaveBeenCalled(); expect(check).not.toHaveBeenCalled();
      controller.abort(new Error('fixture_complete')); await expect(completion).rejects.toThrow('fixture_complete');
      expect(vi.getTimerCount()).toBe(0);
    });

  it('lets an advisory research slice that ends mid-request save its handoff before its checkpoint', async () => {
    const { state, workers, events, controller, run } = fixture();
    const held = heldAdvisoryTurns(2), completion = run(held.open, Infinity); void completion.catch(() => {});
    await held.wait(0, completion);
    const activity = held.open.mock.calls[0][0].onActivity!;
    // A two-minute research slice usually ends inside one request; cutting there saves nothing.
    await vi.advanceTimersByTimeAsync(120_000 - 30_000);
    activity({ event: 'reasoning' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(held.interrupt).not.toHaveBeenCalled();
    expect(events).toContainEqual({ event: 'cooperative_checkpoint_awaiting_request', details: expect.objectContaining({
      workerId: 'researcher', checkpointAfterMs: 120_000, maxWaitMs: 10 * 60_000, outputAgeMs: 30_000 }) });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    activity({ event: 'item_started', itemType: 'commandExecution' });
    activity({ event: 'item_completed', itemType: 'commandExecution' });
    await vi.advanceTimersByTimeAsync(0);
    expect(held.interrupt).not.toHaveBeenCalled();
    expect(events).toContainEqual({ event: 'research_handoff_requested', details: expect.objectContaining({
      workerId: 'researcher', taskId: 'investigate', remainingMs: 5 * 60_000 }) });
    await vi.advanceTimersByTimeAsync(30_000);
    activity({ event: 'item_started', itemType: 'commandExecution' });
    const notes = 'The search leaves a precisely identified missing estimate; the attempted reduction is saved here.\n';
    fs.writeFileSync(path.join(workers[1].worktree, 'RESEARCH.md'), notes);
    activity({ event: 'item_completed', itemType: 'commandExecution' });
    await held.wait(1, completion);
    expect(held.interrupt).toHaveBeenCalledOnce();
    expect(events).toContainEqual({ event: 'cooperative_checkpoint_request_settled', details: expect.objectContaining({
      workerId: 'researcher', boundary: 'request-returned', waitedMs: 5 * 60_000 + 30_000 }) });
    expect(state.cooperation!.researchCheckpoints?.investigate).toMatchObject({ count: 1, paused: false });
    expect(committedSource(workers[1].worktree, state.cooperation!.researchDrafts!.investigate.commit, 'RESEARCH.md')).toBe(notes);
    controller.abort(new Error('fixture_complete')); await expect(completion).rejects.toThrow('fixture_complete');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets a queued save notice reach the model and its saved handoff finish before interrupting', async () => {
    const { state, workers, events, run } = fixture();
    const held = heldAdvisoryTurns(1), notice = deferred();
    held.notify.mockImplementation(() => notice.promise);
    const completion = run(held.open, 1); void completion.catch(() => {});
    await held.wait(0, completion);
    const activity = held.open.mock.calls[0][0].onActivity!;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(events).toContainEqual({ event: 'cooperative_checkpoint_awaiting_request', details: expect.objectContaining({
      workerId: 'researcher', noticePending: true, maxWaitMs: 10 * 60_000 }) });
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    activity({ event: 'item_started', itemType: 'commandExecution' });
    activity({ event: 'item_completed', itemType: 'commandExecution' });
    // This is the first request boundary where the queued turn/steer can arrive. Cutting
    // here used to cancel the notice before the model could write its argument down.
    expect(held.interrupt).not.toHaveBeenCalled();
    notice.resolve(); await vi.advanceTimersByTimeAsync(0);
    activity({ event: 'reasoning' });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(held.interrupt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(held.interrupt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    activity({ event: 'item_started', itemType: 'commandExecution' });
    const notes = 'The saved mathematical reduction and its exact remaining inference.\n';
    fs.writeFileSync(path.join(workers[1].worktree, 'RESEARCH.md'), notes);
    activity({ event: 'item_completed', itemType: 'commandExecution' });
    await expect(completion).resolves.toBeUndefined();
    expect(held.notify).toHaveBeenCalledOnce(); expect(held.interrupt).toHaveBeenCalledOnce();
    expect(committedSource(workers[1].worktree, state.cooperation!.researchDrafts!.investigate.commit, 'RESEARCH.md')).toBe(notes);
    expect(state.workers![1].advisoryCheckpoint?.noProgressStreak).toBe(0);
    expect(state.cooperation!.tasks.find(node => node.task.id === 'investigate')!.proof).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['deadline', 'late-delivery', 'cancel'] as const)('bounds a pending save notice and cleans up after %s', async outcome => {
    const { events, controller, run } = fixture();
    const held = heldAdvisoryTurns(1), notice = deferred();
    held.notify.mockImplementation(() => notice.promise);
    const completion = run(held.open, 1); void completion.catch(() => {});
    await held.wait(0, completion); await vi.advanceTimersByTimeAsync(120_000);
    if (outcome !== 'cancel') {
      await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
      expect(held.interrupt).not.toHaveBeenCalled();
      if (outcome === 'late-delivery') { notice.resolve(); await vi.advanceTimersByTimeAsync(0); }
      await vi.advanceTimersByTimeAsync(1);
      await expect(completion).resolves.toBeUndefined();
      expect(held.interrupt).toHaveBeenCalledOnce();
      expect(events).toContainEqual({ event: 'cooperative_checkpoint_request_settled', details: expect.objectContaining({
        boundary: 'wait-limit', waitedMs: 10 * 60_000 }) });
    } else {
      controller.abort(new Error('fixture_notice_cancelled'));
      await expect(completion).rejects.toThrow('fixture_notice_cancelled');
      expect(held.interrupt).not.toHaveBeenCalled();
    }
    const count = events.length;
    notice.resolve(); await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(events).toHaveLength(count); expect(held.notify).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])('keeps a failed save notice from extending the advisory turn (queued=%s)', async queued => {
    const { events, run } = fixture();
    const held = heldAdvisoryTurns(1), notice = deferred();
    held.notify.mockImplementation(() => notice.promise);
    const completion = run(held.open, 1); void completion.catch(() => {});
    await held.wait(0, completion);
    await vi.advanceTimersByTimeAsync(queued ? 120_000 : 90_000);
    notice.reject(new Error('fixture_notice_rejected')); await vi.advanceTimersByTimeAsync(0);
    if (!queued) {
      expect(held.interrupt).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30_000);
    }
    await expect(completion).resolves.toBeUndefined();
    expect(held.notify).toHaveBeenCalledOnce(); expect(held.interrupt).toHaveBeenCalledOnce();
    expect(events.filter(item => item.event === 'cooperative_checkpoint_notice_failed')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['checkpoint', 'ready', 'stop'] as const)('does not report a settled save-notice cancellation during %s as a failure', async stopping => {
    const { events, run } = fixture();
    const held = heldAdvisoryTurns(1), notice = deferred();
    held.notify.mockImplementation(() => notice.promise);
    held.interrupt.mockImplementation(async () => {
      notice.reject(new Error('math_codex_notification_turn_settled'));
      held.done[0].resolve('interrupted');
    });
    const completion = run(held.open, 1); void completion.catch(() => {});
    await held.wait(0, completion); await vi.advanceTimersByTimeAsync(120_000);
    if (stopping === 'checkpoint') await vi.advanceTimersByTimeAsync(10 * 60_000);
    else {
      const activation = vi.mocked(CooperativeResearch.prototype.activate).mock.calls.find(([worker]) => worker.id === 'researcher')!;
      await activation[stopping === 'ready' ? 4 : 2]!();
    }
    await expect(completion).resolves.toBeUndefined();
    expect(held.interrupt).toHaveBeenCalledOnce();
    expect(events.filter(item => item.event === 'cooperative_checkpoint_notice_failed')).toEqual([]);
    if (stopping === 'checkpoint') expect(events).toContainEqual({ event: 'cooperative_checkpoint_request_settled',
      details: expect.objectContaining({ boundary: 'wait-limit', waitedMs: 10 * 60_000 }) });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a genuine queued-notice error during checkpoint interruption with a bounded diagnostic', async () => {
    const { events, run } = fixture();
    const held = heldAdvisoryTurns(1), notice = deferred();
    const reason = 'math_codex_rpc_timeout:turn/steer:' + 'diagnostic '.repeat(200);
    held.notify.mockImplementation(() => notice.promise);
    held.interrupt.mockImplementation(async () => {
      notice.reject(new Error(reason));
      held.done[0].resolve('interrupted');
    });
    const completion = run(held.open, 1); void completion.catch(() => {});
    await held.wait(0, completion); await vi.advanceTimersByTimeAsync(120_000 + 10 * 60_000);
    await expect(completion).resolves.toBeUndefined();
    const failures = events.filter(item => item.event === 'cooperative_checkpoint_notice_failed');
    expect(failures).toHaveLength(1);
    expect(failures[0].details).toMatchObject({ reason: reason.slice(0, 1000) });
    expect(held.interrupt).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it('reports an unexpected settled-notice error before the turn starts stopping', async () => {
    const { events, run } = fixture();
    const held = heldAdvisoryTurns(1), notice = deferred();
    held.notify.mockImplementation(() => notice.promise);
    const completion = run(held.open, 1); void completion.catch(() => {});
    await held.wait(0, completion); await vi.advanceTimersByTimeAsync(120_000);
    notice.reject(new Error('math_codex_notification_turn_settled'));
    await vi.advanceTimersByTimeAsync(0);
    await expect(completion).resolves.toBeUndefined();
    expect(events.filter(item => item.event === 'cooperative_checkpoint_notice_failed')).toEqual([
      { event: 'cooperative_checkpoint_notice_failed', details: expect.objectContaining({ reason: 'math_codex_notification_turn_settled' }) },
    ]);
    expect(events).toContainEqual({ event: 'cooperative_checkpoint_request_settled',
      details: expect.objectContaining({ boundary: 'notice-failed' }) });
    expect(held.interrupt).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { failure: false, reason: 'math_codex_notification_turn_settled' },
    { failure: true, reason: 'math_codex_rpc_timeout:turn/steer:' + 'diagnostic '.repeat(200) },
  ])('distinguishes context-notice cancellation from genuine errors when the host stops (failure=$failure)', async ({ failure, reason }) => {
      const { events, run } = fixture();
      const held = heldAdvisoryTurns(1, ['investigate'], 90_000), notice = deferred();
      held.notify.mockImplementation(() => notice.promise);
      held.interrupt.mockImplementation(async () => {
        notice.reject(new Error(reason));
        held.done[0].resolve('interrupted');
      });
      const completion = run(held.open, 1); void completion.catch(() => {});
      await held.wait(0, completion);
      expect(held.notify).toHaveBeenCalledOnce();
      expect(events.some(item => item.event === 'context_checkpoint_requested')).toBe(true);
      const activation = vi.mocked(CooperativeResearch.prototype.activate).mock.calls.find(([worker]) => worker.id === 'researcher')!;
      await activation[2]();
      await expect(completion).resolves.toBeUndefined();
      const failures = events.filter(item => item.event === 'context_checkpoint_notice_failed');
      expect(failures).toEqual(!failure ? [] : [
        { event: 'context_checkpoint_notice_failed', details: expect.objectContaining({ reason: reason.slice(0, 1000) }) },
      ]);
      expect(held.interrupt).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    });

  it('ignores a late context-notice rejection after its turn has finished', async () => {
    const { events, run } = fixture();
    const held = heldAdvisoryTurns(1, ['investigate'], 90_000), notice = deferred();
    held.notify.mockImplementation(() => notice.promise);
    const completion = run(held.open, 1); void completion.catch(() => {});
    await held.wait(0, completion); expect(held.notify).toHaveBeenCalledOnce();
    held.done[0].resolve('interrupted');
    await expect(completion).resolves.toBeUndefined();
    const count = events.length;
    notice.reject(new Error('math_codex_rpc_timeout:turn/steer'));
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toHaveLength(count); expect(vi.getTimerCount()).toBe(0);
  });

  it('lets an initial-plan slice that ends mid-request wait for that request before the fallback plan', async () => {
    const { state, events, controller, run } = fixture(true);
    const leadStarted = deferred(), leadDone = deferred<string>(), engineerStarted = deferred();
    const leadInterrupt = vi.fn(async () => { leadDone.resolve('interrupted'); });
    let leadActivity: MathAgentOptions['onActivity'];
    const open = vi.fn(async (options: MathAgentOptions): Promise<MathAgentSession> => {
      const lead = options.environment!.DEEPSCIENTIST_MATH_WORKER_ID === 'solver';
      const done = lead ? leadDone : deferred<string>();
      return { threadId: lead ? 'thread-solver' : 'thread-engineer', notify: vi.fn(async () => {}),
        interrupt: lead ? leadInterrupt : vi.fn(async () => { done.resolve('interrupted'); }),
        close: async () => { done.resolve('interrupted'); },
        run: async (_message, _messageId, _workspace, onStarted) => {
          onStarted(lead ? 'turn-solver' : 'turn-engineer');
          options.onActivity?.({ event: 'reasoning' });
          if (lead) { leadActivity = options.onActivity; leadStarted.resolve(); } else engineerStarted.resolve();
          return done.promise;
        } };
    });
    const completion = run(open); void completion.catch(() => {});
    await leadStarted.promise;
    // One long first-plan request is still streaming when the 20-minute slice ends.
    await vi.advanceTimersByTimeAsync(20 * 60_000 - 30_000);
    leadActivity!({ event: 'reasoning' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(leadInterrupt).not.toHaveBeenCalled();
    expect(state.cooperation?.initialPlanFallback).toBeUndefined();
    expect(events).toContainEqual({ event: 'cooperative_checkpoint_awaiting_request', details: expect.objectContaining({
      workerId: 'solver', checkpointAfterMs: 20 * 60_000, outputAgeMs: 30_000 }) });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await engineerStarted.promise;
    expect(leadInterrupt).toHaveBeenCalledOnce();
    expect(events).toContainEqual({ event: 'cooperative_checkpoint_request_settled', details: expect.objectContaining({
      workerId: 'solver', boundary: 'wait-limit', waitedMs: 10 * 60_000 }) });
    expect(state.cooperation!.initialPlanFallback).toBeDefined();
    controller.abort(new Error('fixture_complete')); await expect(completion).rejects.toThrow('fixture_complete');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('recovers a stalled compaction into a fresh thread while preserving the same assignment and draft', async () => {
    const { state, workers, events, controller, run } = fixture(false, undefined, 'lead');
    const held = heldContinuationTurns({ saveNotes: true }), completion = run(held.open, Infinity); void completion.catch(() => {});
    await held.wait(0, completion);
    const saved = fs.readFileSync(path.join(workers[0].worktree, 'RESEARCH.md'), 'utf8');
    held.open.mock.calls[0][0].onActivity!({ event: 'item_started', itemType: 'contextCompaction' });
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
    expect(held.interrupt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await held.wait(1, completion);
    expect(held.interrupt).toHaveBeenCalledOnce();
    expect(held.threads).toEqual(['continuation-thread-1', 'continuation-thread-2']);
    expect(held.messages.map(message => message.mode)).toEqual(['full', 'full']);
    expect(fs.readFileSync(path.join(workers[0].worktree, 'RESEARCH.md'), 'utf8')).toBe(saved);
    expect(state.tokenBudget).toMatchObject({ maxTotalTokens: 0, status: 'unlimited' });
    expect(events.some(item => item.event === 'context_compaction_recovery_requested')).toBe(true);
    controller.abort(new Error('fixture_complete')); await expect(completion).rejects.toThrow('fixture_complete');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['lead', 'custom-full'] as const)(
    'keeps first Lead dispatch full and resumes %s with the current nonce and receipt', async mode => {
      const { state, check, events, controller, run } = fixture(false, undefined, mode);
      const held = heldContinuationTurns({ saveNotes: true }), completion = run(held.open, Infinity); void completion.catch(() => {});
      await held.wait(0, completion);
      expect(held.messages[0].assignment.kind).toBe('lead');
      expect(held.messages[0].mode).toBe('full');
      expect(held.messages[0].sentinel).toContain('full-context-exact-types');
      await vi.advanceTimersByTimeAsync(LEAD_REVISION_MS); await held.wait(1, completion);
      const [first, latest] = held.messages;
      expect(latest.assignment.kind).toBe('lead');
      if (first.assignment.kind !== 'lead' || latest.assignment.kind !== 'lead') throw new Error('fixture_not_lead');
      expect(latest.assignment.planVersion).toBe(first.assignment.planVersion);
      expect(latest.assignment.planNonce).not.toBe(first.assignment.planNonce);
      expect(latest.receipt).toBe(leadPlanDeliveryFile(latest.assignment));
      expect(latest.receipt).not.toBe(first.receipt);
      expect(JSON.stringify(latest)).not.toContain(first.assignment.planNonce);
      expect(latest.mode).toBe(mode === 'lead' ? 'short' : 'full');
      expect(held.threads).toEqual(['continuation-thread-1', 'continuation-thread-1']);
      expect(held.open).toHaveBeenCalledTimes(2);
      expect(held.open.mock.calls[1][0].threadId).toBe('continuation-thread-1');
      expect(events.filter(item => item.event === 'context_dispatched').map(item => item.details?.mode))
        .toEqual(['full', mode === 'lead' ? 'continuation' : 'full']);
      expect(events.some(item => item.event === 'capacity_refill_assessed' || item.event === 'stagnation_recovery_assessed')).toBe(false);
      expect(state.cooperation!.planPublication).toBeUndefined();
      expect(state.cooperation!.lastLeadInputDigest).toBeUndefined();
      expect(state.tokenBudget).toMatchObject({ maxTotalTokens: 0, status: 'unlimited' });
      expect(held.open.mock.calls.every(([access]) => access.turnTimeoutMs === undefined)).toBe(true);
      expect(check).not.toHaveBeenCalled(); expect(state.check).toBeUndefined();
      controller.abort(new Error('fixture_complete'));
      await expect(completion).rejects.toThrow('fixture_complete');
      expect(check).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    });

  it('sends full context again after a saved Lead checkpoint rotates to a fresh thread', async () => {
    const { state, workers, check, events, controller, run, pulse } = fixture(false, undefined, 'lead');
    const held = heldContinuationTurns({ saveNotes: true, highContext: true });
    const completion = run(held.open, Infinity); void completion.catch(() => {});
    await held.wait(0, completion);
    held.open.mock.calls[0][0].onActivity!({ event: 'reasoning' });
    const request = state.workers![0].contextCheckpoint!;
    // The Lead's checkpoint request names only its own protocol and defines the digest it must append.
    const instruction = held.notify.mock.calls.map(([message]) => message).find(message => message.includes(request.requestId!))!;
    expect(instruction).toContain('a Lead publishes no findings');
    expect(instruction).toContain('as printed by sha256sum RESEARCH.md');
    expect(instruction).not.toContain('needsDecision');
    const log = held.messages[0].receipt!;
    fs.appendFileSync(path.join(workers[0].worktree, log), JSON.stringify({ kind: 'checkpoint', requestId: request.requestId,
      notesDigest: mathDigest(fs.readFileSync(path.join(workers[0].worktree, 'RESEARCH.md'))) }) + '\n');
    await pulse(workers[0].id);
    await vi.advanceTimersByTimeAsync(5_000); await held.wait(1, completion);
    expect(held.threads).toEqual(['continuation-thread-1', 'continuation-thread-2']);
    expect(held.messages.map(message => message.mode)).toEqual(['full', 'full']);
    expect(held.messages[1].sentinel).toContain('full-context-exact-types');
    expect(held.messages[1].exactTasks).toEqual(state.cooperation!.tasks.map(node => node.task));
    expect(events.filter(item => item.event === 'context_dispatched').map(item => item.details?.mode)).toEqual(['full', 'full']);
    expect(events).toContainEqual({ event: 'context_restarted', details: expect.objectContaining({ workerId: 'solver',
      previousThreadId: 'continuation-thread-1', reason: 'context' }) });
    expect(check).not.toHaveBeenCalled(); expect(state.check).toBeUndefined();
    controller.abort(new Error('fixture_complete')); await expect(completion).rejects.toThrow('fixture_complete');
  });

  it.each(['success', 'failure'] as const)('uses native compact between settled turns and restores full task context (%s)', async nativeCompact => {
    const { state, workers, check, events, controller, run, pulse } = fixture(false, undefined, 'lead');
    const held = heldContinuationTurns({ saveNotes: true, highContext: true, nativeCompact });
    const completion = run(held.open, Infinity); void completion.catch(() => {});
    await held.wait(0, completion);
    held.open.mock.calls[0][0].onActivity!({ event: 'reasoning' });
    expect(held.compact).not.toHaveBeenCalled();
    const request = state.workers![0].contextCheckpoint!;
    fs.appendFileSync(path.join(workers[0].worktree, held.messages[0].receipt!), JSON.stringify({
      kind: 'checkpoint', requestId: request.requestId,
      notesDigest: mathDigest(fs.readFileSync(path.join(workers[0].worktree, 'RESEARCH.md'))),
    }) + '\n');
    await pulse(workers[0].id); await vi.advanceTimersByTimeAsync(5_000); await held.wait(1, completion);
    expect(held.compact).toHaveBeenCalledOnce();
    expect(held.threads).toEqual(['continuation-thread-1', nativeCompact === 'success' ? 'continuation-thread-1' : 'continuation-thread-2']);
    expect(held.messages[1].mode).toBe('full'); expect(held.messages[1].exactTasks).toEqual(state.cooperation!.tasks.map(node => node.task));
    expect(events.some(item => item.event === 'context_restarted')).toBe(nativeCompact === 'failure');
    expect(events.some(item => item.event === (nativeCompact === 'success' ? 'context_compaction_completed' : 'context_compaction_failed'))).toBe(true);
    expect(state.workers![0].usageAccounting?.startedTurns).toBe(2);
    if (nativeCompact === 'success') expect(state.workers![0].usage?.totalTokens).toBe(14);
    expect(check).not.toHaveBeenCalled();
    controller.abort(new Error('fixture_complete')); await expect(completion).rejects.toThrow('fixture_complete');
  });

  it('sends the complete revised mathematical graph when the Lead plan version changes in the same thread', async () => {
    const { state, check, events, controller, run } = fixture(false, undefined, 'lead');
    const exactType = '∀ (n : Nat), ' + 'True ∧ '.repeat(250) + 'True';
    const next = CooperativeResearch.prototype.next;
    let leadDispatches = 0;
    vi.spyOn(CooperativeResearch.prototype, 'next').mockImplementation(async function (this: CooperativeResearch, worker, budget) {
      const action = await next.call(this, worker, budget);
      if (action?.kind === 'lead' && ++leadDispatches === 2) {
        // A scheduler graph replacement occurs between accepted dispatches, without rotating the model thread.
        state.cooperation!.planVersion = 'revised-plan-version';
        state.cooperation!.tasks.find(node => node.task.kind === 'goal')!.task.type = exactType;
        action.planVersion = state.cooperation!.planVersion;
      }
      return action;
    });
    const held = heldContinuationTurns({ saveNotes: true }), completion = run(held.open, Infinity); void completion.catch(() => {});
    await held.wait(0, completion);
    await vi.advanceTimersByTimeAsync(LEAD_REVISION_MS); await held.wait(1, completion);
    const [first, revised] = held.messages;
    expect(first.assignment.kind).toBe('lead'); expect(revised.assignment.kind).toBe('lead');
    if (first.assignment.kind !== 'lead' || revised.assignment.kind !== 'lead') throw new Error('fixture_not_lead');
    expect(revised.assignment.planVersion).not.toBe(first.assignment.planVersion);
    expect(held.threads).toEqual(['continuation-thread-1', 'continuation-thread-1']);
    expect(revised.mode).toBe('full');
    expect(JSON.stringify(revised.exactTasks)).toContain(exactType);
    expect(events.filter(item => item.event === 'context_dispatched').map(item => item.details?.mode)).toEqual(['full', 'full']);
    expect(events.some(item => item.event === 'context_restarted')).toBe(false);
    expect(check).not.toHaveBeenCalled(); expect(state.check).toBeUndefined();
    controller.abort(new Error('fixture_complete')); await expect(completion).rejects.toThrow('fixture_complete');
  });

  it('resumes a same-thread advisory assignment with its current short message', async () => {
    const { state, check, events, controller, run } = fixture(false, undefined, 'peer');
    const held = heldContinuationTurns(), completion = run(held.open, Infinity); void completion.catch(() => {});
    await held.wait(0, completion);
    await vi.advanceTimersByTimeAsync(120_000); await held.wait(1, completion);
    expect(held.messages.every(message => message.assignment.kind === 'task')).toBe(true);
    expect(held.messages.map(message => message.mode)).toEqual(['full', 'short']);
    expect(held.threads).toEqual(['continuation-thread-1', 'continuation-thread-1']);
    expect(held.open.mock.calls[0][0].hiddenRoots).toContain(DEFAULT_TACTIC_BATTERY_FAILURE_CACHE_ROOT);
    expect(events.filter(item => item.event === 'context_dispatched').map(item => item.details?.mode)).toEqual(['full', 'continuation']);
    expect(state.tokenBudget).toMatchObject({ maxTotalTokens: 0, status: 'unlimited' });
    expect(check).not.toHaveBeenCalled(); expect(state.check).toBeUndefined();
    controller.abort(new Error('fixture_complete')); await expect(completion).rejects.toThrow('fixture_complete');
  });

  it.each(['unchanged', 'compaction', 'environment', 'instructions', 'dependency', 'route', 'route-id', 'threshold'] as const)(
    'revisits A after B using its sent contract only while current (%s)', async change => {
      const { state, events, controller, run, contextSettings } = fixture(false, undefined, 'peer');
      const first = state.cooperation!.tasks.find(node => node.task.id === 'investigate')!;
      const input = { task: { ...first.task, id: 'research-input', ownerId: 'solver', status: 'paused' as const },
        status: 'pending' as const, attempts: 0, finding: 'Original exact dependency finding.' };
      first.task.dependsOn = [input.task.id];
      const other = { task: { ...first.task, id: 'other-question', dependsOn: [] }, status: 'pending' as const, attempts: 0 };
      state.cooperation!.tasks.push(other, input);
      if (change === 'route') {
        other.task.groupId = 'another-route';
        state.cooperation!.groups!.push({ group: { id: other.task.groupId, objective: 'Try the alternative construction',
          revision: 0, status: 'active' }, turns: 0 });
      }
      if (change === 'threshold') {
        const next = CooperativeResearch.prototype.next;
        vi.spyOn(CooperativeResearch.prototype, 'next').mockImplementation(async function (this: CooperativeResearch, worker, budget) {
          const action = await next.call(this, worker, budget);
          if (action?.kind === 'task' && action.task.id === other.task.id) state.workers![1].lastInputTokens = 94_000;
          return action;
        });
      }
      if (change === 'route-id') {
        const next = CooperativeResearch.prototype.next;
        vi.spyOn(CooperativeResearch.prototype, 'next').mockImplementation(async function (this: CooperativeResearch, worker, budget) {
          const action = await next.call(this, worker, budget);
          if (action?.kind === 'task' && action.task.id === other.task.id)
            action.assignment.routeId = 'alternative-proof-route';
          return action;
        });
      }
      const held = heldContinuationTurns({ count: 3 }), completion = run(held.open, Infinity);
      void completion.catch(() => {}); await held.wait(0, completion);
      await vi.advanceTimersByTimeAsync(120_000); await held.wait(1, completion);
      if (change === 'compaction') {
        // A completion can arrive even when this process did not observe the corresponding start.
        held.open.mock.calls[0][0].onActivity!({ event: 'item_completed', itemType: 'contextCompaction' });
      }
      if (change === 'environment') state.environmentDigest = mathDigest('new exact environment');
      if (change === 'instructions') contextSettings.instructionsSuffix = ' New exact instructions.';
      if (change === 'dependency') input.finding = 'New exact dependency finding under the same task contract.';
      first.feedback = 'Use the latest coercion lemma when returning to this question.';
      await vi.advanceTimersByTimeAsync(120_000); await held.wait(2, completion);
      expect(held.messages.map(message => message.assignment.kind === 'task' && message.assignment.task.id))
        .toEqual(['investigate', 'other-question', 'investigate']);
      const routeChanged = change === 'route' || change === 'route-id';
      const firstSwitchRotates = routeChanged || change === 'threshold';
      const secondSwitchRotates = routeChanged || change === 'environment' || change === 'instructions';
      expect(held.threads).toEqual(['continuation-thread-1', `continuation-thread-${firstSwitchRotates ? 2 : 1}`,
        `continuation-thread-${1 + Number(firstSwitchRotates) + Number(secondSwitchRotates)}`]);
      const secondMode = change === 'unchanged' ? 'continuation' : change === 'threshold' ? 'task-switch' : 'full';
      expect(held.messages.map(message => message.mode))
        .toEqual(['full', firstSwitchRotates ? 'full' : 'short', secondMode === 'full' ? 'full' : 'short']);
      expect(held.messages[2].feedback).toContain('latest coercion lemma');
      expect(events.filter(event => event.event === 'context_dispatched').map(event => event.details?.mode))
        .toEqual(['full', firstSwitchRotates ? 'full' : 'task-switch', secondMode]);
      const dispatches = events.filter(event => event.event === 'context_dispatched');
      if (!firstSwitchRotates) expect(dispatches[1].details?.messageBytes).toBeLessThan(Number(dispatches[0].details?.messageBytes) / 2);
      controller.abort(new Error('fixture_complete')); await expect(completion).rejects.toThrow('fixture_complete');
      expect(vi.getTimerCount()).toBe(0);
    });

  it('sends new feedback and inbox findings in a same-thread short advisory continuation', async () => {
    const { state, check, events, controller, run } = fixture(false, undefined, 'peer');
    const next = CooperativeResearch.prototype.next;
    let peerDispatches = 0;
    vi.spyOn(CooperativeResearch.prototype, 'next').mockImplementation(async function (this: CooperativeResearch, worker, budget) {
      const action = await next.call(this, worker, budget);
      if (action?.kind === 'task' && action.task.id === 'investigate' && ++peerDispatches === 2) {
        const node = state.cooperation!.tasks.find(node => node.task.id === action.task.id)!;
        node.feedback = 'Use the newly saved exact coercion lemma before another library search.';
        (state.cooperation!.deliveries ??= []).push({ id: 'fresh-peer-input', producer: 'solver',
          taskId: node.task.id, taskDigest: action.assignment.taskDigest, kind: 'research', status: 'advisory',
          summary: 'A saved finding identifies the exact missing library interface.', statement: '', premises: [],
          dependencies: [], remainingObligations: [], evidenceRefs: [], createdAt: Date.now() });
      }
      return action;
    });
    const held = heldContinuationTurns(), completion = run(held.open, Infinity); void completion.catch(() => {});
    await held.wait(0, completion);
    await vi.advanceTimersByTimeAsync(120_000); await held.wait(1, completion);
    expect(held.messages.map(message => message.mode)).toEqual(['full', 'short']);
    expect(held.messages[1].feedback).toContain('newly saved exact coercion lemma');
    expect(held.messages[1].inbox).toContain('A saved finding identifies the exact missing library interface.');
    expect(held.threads).toEqual(['continuation-thread-1', 'continuation-thread-1']);
    expect(events.filter(item => item.event === 'context_dispatched').map(item => item.details?.mode)).toEqual(['full', 'continuation']);
    expect(check).not.toHaveBeenCalled();
    controller.abort(new Error('fixture_complete')); await expect(completion).rejects.toThrow('fixture_complete');
  });

  it.each(['task', 'environment', 'seed', 'instructions'] as const)(
    'sends full advisory context when its %s responsibility changes', async change => {
      const { state, workers, check, events, controller, run, contextSettings } = fixture(false, undefined, 'peer');
      const next = CooperativeResearch.prototype.next;
      let peerDispatches = 0;
      vi.spyOn(CooperativeResearch.prototype, 'next').mockImplementation(async function (this: CooperativeResearch, worker, budget) {
        const action = await next.call(this, worker, budget);
        if (action?.kind === 'task' && action.task.id === 'investigate' && ++peerDispatches === 2) {
          const node = state.cooperation!.tasks.find(node => node.task.id === action.task.id)!;
          if (change === 'task') {
            node.task = { ...node.task, objective: 'Resolve the distinct finite-dimensional construction.', revision: node.task.revision + 1 };
            action.task = node.task; action.assignment.taskDigest = taskVersion(node.task);
          }
          if (change === 'environment') state.environmentDigest = 'revised-offline-environment';
          if (change === 'seed') {
            git(workers[1].worktree, ['-c', 'user.name=Offline fixture', '-c', 'user.email=fixture@localhost',
              'commit', '--allow-empty', '--no-gpg-sign', '--quiet', '-m', 'Revise disposable continuation seed']);
            action.assignment.seedCommit = git(workers[1].worktree, ['rev-parse', 'HEAD']);
          }
          if (change === 'instructions') contextSettings.instructionsSuffix = ' Revised offline role instructions.';
        }
        return action;
      });
      const held = heldContinuationTurns(), completion = run(held.open, Infinity); void completion.catch(() => {});
      await held.wait(0, completion);
      await vi.advanceTimersByTimeAsync(120_000); await held.wait(1, completion);
      expect(held.messages.map(message => message.mode)).toEqual(['full', 'full']);
      expect(held.messages[1].sentinel).toContain('full-context-exact-types');
      expect(held.threads).toEqual(['continuation-thread-1', change === 'seed' ? 'continuation-thread-1' : 'continuation-thread-2']);
      expect(events.filter(item => item.event === 'context_dispatched').map(item => item.details?.mode)).toEqual(['full', 'full']);
      if (change === 'task') {
        const revised = held.messages[1].assignment;
        expect(revised.kind === 'task' && revised.task.objective).toContain('distinct finite-dimensional construction');
      }
      if (change === 'seed') {
        const first = held.messages[0].assignment, revised = held.messages[1].assignment;
        expect(first.kind === 'task' && revised.kind === 'task' && revised.assignment.seedCommit).not.toBe(
          first.kind === 'task' && first.assignment.seedCommit);
      }
      expect(check).not.toHaveBeenCalled(); expect(state.check).toBeUndefined();
      controller.abort(new Error('fixture_complete')); await expect(completion).rejects.toThrow('fixture_complete');
    });

  it.each(['acknowledged', 'stalled'] as const)(
    'checkpoints a %s advisory turn, resumes its exact draft and clears old timers before continuing', async interruptKind => {
      const { state, workers, problem, check, events, run } = fixture();
      const firstStarted = deferred(), resumed = deferred(), interrupted = deferred<string>(), finish = deferred<string>();
      const teardown = deferred();
      const actions: Extract<CooperativeAction, { kind: 'task' }>[] = [];
      let turns = 0, active: ReturnType<typeof deferred<string>> | undefined, lastError: string | undefined;
      const close = vi.fn(async () => {
        lastError = 'math_codex_transport_closed'; active?.reject(new Error(lastError));
        if (interruptKind === 'stalled' && turns === 1) await teardown.promise;
      });
      const interrupt = vi.fn(async () => { if (interruptKind === 'acknowledged') interrupted.resolve('interrupted'); });
      const notify = vi.fn(async () => {});
      const open = vi.fn(async (options: MathAgentOptions): Promise<MathAgentSession> => ({
        threadId: options.threadId ?? 'saved-advisory-thread', close, interrupt, notify,
        get lastError() { return lastError; },
        run: async (message, _messageId, _workspace, onStarted) => {
          lastError = undefined;
          const action = JSON.parse(message) as Extract<CooperativeAction, { kind: 'task' }>;
          actions.push(action); onStarted(`advisory-turn-${++turns}`);
          options.onActivity?.({ event: 'reasoning' });
          const notes = path.join(options.workspace, 'RESEARCH.md');
          if (turns === 1) {
            fs.writeFileSync(notes, 'A partial construction and its exact remaining quantitative gap.\n');
            active = interrupted; firstStarted.resolve();
            return interrupted.promise;
          }
          expect(fs.readFileSync(notes, 'utf8')).toContain('exact remaining quantitative gap');
          const draft = state.cooperation!.researchDrafts!.investigate;
          expect(draft).toMatchObject({ workerId: 'researcher', assignmentId: actions[0].assignment.assignmentId });
          expect(committedSource(workers[1].worktree, draft.commit, 'RESEARCH.md')).toContain('partial construction');
          const node = state.cooperation!.tasks.find(node => node.task.id === 'investigate')!;
          expect(node.status).toBe('running'); expect(node.proof).toBeUndefined(); expect(node.integratedCheck).toBeUndefined();
          expect(state.check).toBeUndefined(); expect(check).not.toHaveBeenCalled();
          fs.writeFileSync(notes, 'A completed advisory construction with its precise assumptions and unresolved quantitative gap.\n');
          active = finish; resumed.resolve();
          return finish.promise;
        },
      }));
      const completion = run(open); void completion.catch(() => {});
      const stopped = completion.then(() => { throw new Error('fixture_stopped_before_next_checkpoint:' + JSON.stringify(events)); });
      void stopped.catch(() => {});
      await Promise.race([firstStarted.promise, stopped]);
      expect(open.mock.calls[0][0].turnTimeoutMs).toBeUndefined();
      await vi.advanceTimersByTimeAsync(90_000);
      expect(notify).toHaveBeenCalledOnce(); expect(interrupt).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(interrupt).toHaveBeenCalledOnce();
      if (interruptKind === 'stalled') {
        expect(close).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(close).toHaveBeenCalledOnce(); expect(open).toHaveBeenCalledOnce();
        expect(state.cooperation!.researchDrafts?.investigate).toBeUndefined();
        expect(state.workers![1].candidate).toBeUndefined();
        teardown.resolve();
      }
      await Promise.race([resumed.promise, stopped]);
      expect(actions[1].assignment).toEqual(actions[0].assignment);
      expect(open).toHaveBeenCalledTimes(interruptKind === 'stalled' ? 2 : 1);
      if (interruptKind === 'stalled') expect(open.mock.calls[1][0].threadId).toBe('saved-advisory-thread');
      await vi.advanceTimersByTimeAsync(15_000);
      expect(interrupt).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledTimes(interruptKind === 'stalled' ? 1 : 0);
      finish.resolve('completed'); await expect(completion).resolves.toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
      expect(check).not.toHaveBeenCalled(); expect(state.check).toBeUndefined();
      expect(state.tokenBudget).toMatchObject({ maxTotalTokens: 0, status: 'unlimited' });
      expect(state.workers![1]).toMatchObject({ threadId: 'saved-advisory-thread', sessionTaskId: 'investigate' });
      expect(state.cooperation!.tasks.find(node => node.task.id === 'investigate')?.status).toBe('completed');
      expect(state.cooperation!.deliveries?.some(delivery => delivery.kind === 'proof' || delivery.kind === 'failure')).toBeFalsy();
      expect(events).toContainEqual({ event: 'turn_checkpoint', details: {
        workerId: 'researcher', turn: 1, reason: 'math_cooperative_scheduling_checkpoint',
      } });
      expect(events.some(item => item.event === 'worker_failed' || item.event === 'turn_failed')).toBe(false);
      for (const target of problem.targets) expect(committedSource(workers[0].worktree,
        state.cooperation!.canonicalCommit!, path.join(problem.projectRelative, target.proofPath))).toContain('sorry');
    });

  it('preserves project scratch through a scheduling checkpoint without committing it or changing the assignment', async () => {
    const { state, workers, problem, check, events, run } = fixture(false, 'generated/project');
    const held = heldAdvisoryTurns(2), completion = run(held.open); void completion.catch(() => {});
    await held.wait(0, completion);
    const worktree = workers[1].worktree;
    const relative = path.join(problem.projectRelative, '.scratch', 'tmp', 'LibProbe.lean');
    const scratch = path.join(worktree, relative), notes = path.join(worktree, 'RESEARCH.md');
    const probe = '-- Advisory library probe, never accepted proof content.\n#check Nat.add_zero\n';
    fs.mkdirSync(path.dirname(scratch), { recursive: true }); fs.writeFileSync(scratch, probe);
    fs.writeFileSync(notes, 'A saved construction with its exact remaining quantitative gap.\n');
    await vi.advanceTimersByTimeAsync(120_000); await held.wait(1, completion);

    expect(held.interrupt).toHaveBeenCalledOnce(); expect(held.open).toHaveBeenCalledOnce();
    expect(held.actions[1].task.id).toBe(held.actions[0].task.id);
    expect(held.actions[1].assignment).toEqual(held.actions[0].assignment);
    expect(state.workers![1]).toMatchObject({ threadId: 'persistent-backoff-thread', sessionTaskId: 'investigate' });
    expect(fs.readFileSync(notes, 'utf8')).toContain('exact remaining quantitative gap');
    expect(fs.lstatSync(scratch).isFile()).toBe(true); expect(fs.readFileSync(scratch, 'utf8')).toBe(probe);
    expect(git(worktree, ['ls-files', '--', relative])).toBe('');
    expect(git(worktree, ['ls-files', '--others', '--exclude-standard', '--', relative])).toBe(relative);
    const draft = state.cooperation!.researchDrafts!.investigate;
    expect(draft).toMatchObject({ workerId: 'researcher', assignmentId: held.actions[0].assignment.assignmentId });
    expect(committedSource(worktree, draft.commit, 'RESEARCH.md')).toContain('exact remaining quantitative gap');
    expect(git(worktree, ['ls-tree', '-r', '--name-only', draft.commit, '--', relative])).toBe('');
    const node = state.cooperation!.tasks.find(node => node.task.id === 'investigate')!;
    expect(node.status).toBe('running'); expect(node.proof).toBeUndefined(); expect(node.integratedCheck).toBeUndefined();

    fs.writeFileSync(notes, 'A completed advisory investigation with the quantitative gap still explicit.\n');
    held.done[1].resolve('completed'); await expect(completion).resolves.toBeUndefined();
    expect(fs.readFileSync(scratch, 'utf8')).toBe(probe);
    expect(git(worktree, ['ls-files', '--', relative])).toBe('');
    expect(git(worktree, ['ls-tree', '-r', '--name-only', 'HEAD', '--', relative])).toBe('');
    expect(git(workers[0].worktree, ['ls-tree', '-r', '--name-only', state.cooperation!.canonicalCommit!, '--', relative])).toBe('');
    expect(events).toContainEqual({ event: 'turn_checkpoint', details: {
      workerId: 'researcher', turn: 1, reason: 'math_cooperative_scheduling_checkpoint',
    } });
    expect(events.some(item => item.event === 'worker_failed' || item.event === 'turn_failed')).toBe(false);
    expect(state.cooperation!.deliveries?.some(delivery => delivery.kind === 'proof' || delivery.kind === 'failure')).toBeFalsy();
    expect(check).not.toHaveBeenCalled(); expect(state.check).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
    for (const target of problem.targets) expect(committedSource(workers[0].worktree,
      state.cooperation!.canonicalCommit!, path.join(problem.projectRelative, target.proofPath))).toContain('sorry');
  });

  it('keeps a genuine tool failure as a failure when it coincides with a scheduling interrupt', async () => {
    const { check, events, run } = fixture();
    const started = deferred(), done = deferred<string>();
    let lastError: string | undefined;
    const open = async (options: MathAgentOptions): Promise<MathAgentSession> => ({ threadId: 'failed-advisory-thread',
      get lastError() { return lastError; }, close: async () => {},
      interrupt: async () => { lastError = 'math_model_tool_failed'; done.resolve('failed'); },
      run: async (_message, _messageId, _workspace, onStarted) => {
        onStarted('failed-turn'); started.resolve();
        options.onActivity?.({ event: 'reasoning' });
        return done.promise;
      } });
    const completion = run(open, 1); void completion.catch(() => {});
    await started.promise;
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(completion).rejects.toThrow('math_model_tool_failed');
    expect(events.some(item => item.event === 'turn_checkpoint')).toBe(false);
    expect(events).toContainEqual({ event: 'turn_failed', details: {
      workerId: 'researcher', reason: 'math_model_tool_failed',
    } });
    expect(check).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('pauses unchanged advisory research after three scheduling checkpoints', async () => {
    const { state, check, events, run } = fixture();
    const held = heldAdvisoryTurns(3), completion = run(held.open, 3); void completion.catch(() => {});
    await held.wait(0, completion);
    for (const [turn, interval] of [120_000, 240_000, 480_000].entries()) {
      await vi.advanceTimersByTimeAsync(interval);
      if (turn < 2) await held.wait(turn + 1, completion);
    }
    await expect(completion).resolves.toBeUndefined();

    expect(held.interrupt).toHaveBeenCalledTimes(3);
    expect(state.workers![1].advisoryCheckpoint).toMatchObject({ noProgressStreak: 3 });
    expect(state.cooperation!.researchCheckpoints?.investigate).toMatchObject({ count: 3, paused: true });
    expect(state.cooperation!.tasks.find(node => node.task.id === 'investigate'))
      .toMatchObject({ status: 'blocked', feedback: expect.stringContaining('math_research_checkpoint_unchanged') });
    // The pause parks the input for the Lead instead of leaving it silently blocked; parking is advisory.
    const parking = state.cooperation!.blockers!.find(record => record.mechanism === 'unchanged-research-checkpoint')!;
    expect(parking.status).toBe('parked');
    expect(state.cooperation!.tasks.find(node => node.task.id === 'investigate')!.routeParking).toEqual([parking.id]);
    expect(events.filter(item => item.event === 'route_parked')).toHaveLength(1);
    expect(events.filter(item => item.event === 'cooperative_checkpoint_scheduled')
      .map(item => item.details!.checkpointAfterMs)).toEqual([120_000, 240_000, 480_000]);
    expect(events.some(item => item.event === 'worker_failed' || item.event === 'turn_failed')).toBe(false);
    expect(held.open).toHaveBeenCalledOnce();
    expect(state.workers![1].threadId).toBe('persistent-backoff-thread');
    expect(held.actions).toHaveLength(3);
    expect(held.actions.every(action => action.assignment.taskDigest === held.actions[0].assignment.taskDigest)).toBe(true);
    expect(check).not.toHaveBeenCalled(); expect(state.check).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['empty', 'missing'] as const)('keeps a disk-restored pause when worker notes are %s', async notes => {
    const { state, workers, check, events, run } = fixture();
    const notesFile = path.join(workers[1].worktree, 'RESEARCH.md');
    fs.writeFileSync(notesFile, 'A saved mathematical reduction and its exact unresolved inference.\n');
    const held = heldAdvisoryTurns(3), completion = run(held.open, 3); void completion.catch(() => {});
    await held.wait(0, completion);
    for (const [turn, interval] of [120_000, 240_000, 480_000].entries()) {
      await vi.advanceTimersByTimeAsync(interval);
      if (turn < 2) await held.wait(turn + 1, completion);
    }
    await expect(completion).resolves.toBeUndefined();
    const paused = structuredClone(state.cooperation!.researchCheckpoints!.investigate);
    expect(paused).toMatchObject({ count: 3, paused: true });
    const checkpointFile = path.join(directory, 'paused-research-state.json');
    writeSolverRunState(checkpointFile, state);
    if (notes === 'empty') fs.writeFileSync(notesFile, '');
    else fs.rmSync(notesFile);
    commitSolverSources(state.problem, workers[1].worktree);
    Object.assign(state, readSolverRunState(checkpointFile));
    const resumed = cooperativeResearch({ state, workers, retrievalRoot: directory,
      emit: (event, details) => events.push({ event, details }) });
    try { (resumed as any).refreshResearchCheckpoints(); }
    finally { await resumed.stop(); }
    expect(state.cooperation!.tasks.find(node => node.task.id === 'investigate')!.status).toBe('blocked');
    expect(state.cooperation!.researchCheckpoints!.investigate).toEqual(paused);
    expect(events.some(item => item.event === 'research_checkpoint_reopened')).toBe(false);
    expect(held.actions).toHaveLength(3); expect(check).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])('restores checkpoint backoff from disk and resets it when the task scope changes (%s)', async changeScope => {
    const { state, workers, run } = fixture();
    const held = heldAdvisoryTurns(2), first = run(held.open, 1); void first.catch(() => {});
    await held.wait(0, first); await vi.advanceTimersByTimeAsync(120_000);
    await expect(first).resolves.toBeUndefined();
    expect(state.workers![1].advisoryCheckpoint?.noProgressStreak).toBe(1);
    const checkpointFile = path.join(directory, 'backoff-state.json');
    writeSolverRunState(checkpointFile, state);
    Object.assign(state, readSolverRunState(checkpointFile));
    expect(state.workers![1].advisoryCheckpoint?.noProgressStreak).toBe(1);
    if (changeScope) {
      const task = state.cooperation!.tasks.find(node => node.task.id === 'investigate')!.task;
      task.revision++; task.objective = 'Investigate the revised exact construction.';
    }
    const second = run(held.open, 2); void second.catch(() => {});
    await held.wait(1, second);
    expect(held.open.mock.calls[1][0].threadId).toBe(changeScope ? undefined : 'persistent-backoff-thread');
    if (!changeScope) {
      await vi.advanceTimersByTimeAsync(120_000);
      expect(held.interrupt).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(held.notify).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(60_000);
    } else await vi.advanceTimersByTimeAsync(120_000);
    await expect(second).resolves.toBeUndefined();
    expect(state.workers![1].advisoryCheckpoint?.noProgressStreak).toBe(changeScope ? 1 : 2);
    expect(state.workers![1].threadId).toBe('persistent-backoff-thread');
    expect(held.interrupt).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
    expect(workers[1].role).toBe('researcher');
  });

  it('keeps each investigation\'s backoff when one worker alternates between research tasks', async () => {
    const { state, problem, events, run } = fixture();
    const second = parseCooperationPlan(problem, { tasks: [
      ...state.cooperation!.tasks.map(node => node.task),
      { id: 'investigate_b', kind: 'research', ownerId: 'researcher', objective: 'Resolve the independent second construction.' },
    ] }).tasks.find(task => task.id === 'investigate_b')!;
    state.cooperation!.tasks.push({ task: second, status: 'pending', attempts: 0 });
    const held = heldAdvisoryTurns(4, ['investigate', 'investigate_b']);
    const completion = run(held.open, 4); void completion.catch(() => {});
    await held.wait(0, completion);
    for (const [turn, interval] of [120_000, 120_000, 240_000, 240_000].entries()) {
      await vi.advanceTimersByTimeAsync(interval);
      if (turn < 3) await held.wait(turn + 1, completion);
    }
    await expect(completion).resolves.toBeUndefined();
    expect(held.actions.map(action => action.task.id)).toEqual(['investigate', 'investigate_b', 'investigate', 'investigate_b']);
    expect(events.filter(item => item.event === 'cooperative_checkpoint_scheduled')
      .map(item => item.details!.checkpointAfterMs)).toEqual([120_000, 120_000, 240_000, 240_000]);
    expect(state.cooperation!.researchCheckpoints?.investigate.advisoryCheckpoint?.noProgressStreak).toBe(2);
    expect(state.cooperation!.researchCheckpoints?.investigate_b.advisoryCheckpoint?.noProgressStreak).toBe(2);
    expect(held.interrupt).toHaveBeenCalledTimes(4); expect(vi.getTimerCount()).toBe(0);
  });

  it('restores task backoff for another worker from the persisted research checkpoint', async () => {
    const { state, workers, events, run } = fixture();
    const held = heldAdvisoryTurns(2), first = run(held.open, 1); void first.catch(() => {});
    await held.wait(0, first); await vi.advanceTimersByTimeAsync(120_000);
    await expect(first).resolves.toBeUndefined();
    const checkpointFile = path.join(directory, 'reassigned-backoff-state.json');
    writeSolverRunState(checkpointFile, state);
    Object.assign(state, readSolverRunState(checkpointFile));
    const original = workers[1];
    const replacement = { ...original, id: 'researcher-b', worktree: path.join(directory, 'researcher-b') };
    git(workers[0].worktree, ['worktree', 'add', '--quiet', '--detach', replacement.worktree, state.problem.baseCommit]);
    workers[1] = replacement;
    state.workers![1] = { ...replacement, phase: 'prepared', turns: 0 };
    const node = state.cooperation!.tasks.find(node => node.task.id === 'investigate')!;
    node.task.ownerId = replacement.id; node.assignment = undefined;
    const second = run(held.open, 2); void second.catch(() => {});
    await held.wait(1, second);
    expect(held.actions[1].assignment.workerId).toBe(replacement.id);
    expect(events.filter(item => item.event === 'cooperative_checkpoint_scheduled').at(-1)?.details)
      .toMatchObject({ workerId: replacement.id, checkpointAfterMs: 240_000, noProgressStreak: 1 });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(held.interrupt).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(second).resolves.toBeUndefined();
    expect(state.workers![1].advisoryCheckpoint?.noProgressStreak).toBe(2);
    expect(held.interrupt).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])('keeps unchanged A → B → A backoff across archived restarts (legacy=%s)', async legacy => {
    const { state, problem, events, run, check } = fixture();
    const held = heldAdvisoryTurns(3, ['investigate', 'other']);
    const first = run(held.open, 1); void first.catch(() => {});
    await held.wait(0, first); await vi.advanceTimersByTimeAsync(120_000); await first;
    const firstOutput = state.cooperation!.researchDrafts!.investigate.outputDigest;
    const aScope = state.workers![1].advisoryCheckpoint!.scope;
    expect(state.workers![1].advisoryCheckpoint?.noProgressStreak).toBe(1);
    if (legacy) delete state.workers![1].advisoryCheckpoints;
    const other = parseCooperationPlan(problem, { tasks: [
      ...state.cooperation!.tasks.map(node => node.task),
      { id: 'other', kind: 'research', ownerId: 'researcher', objective: 'Investigate an independent quantitative question.' },
    ] }).tasks.find(task => task.id === 'other')!;
    state.cooperation!.tasks.push({ task: other, status: 'pending', attempts: 0 });
    const file = path.join(directory, 'alternating-backoff-state.json');
    writeSolverRunState(file, state); Object.assign(state, readSolverRunState(file));

    const second = run(held.open, 2); void second.catch(() => {});
    await held.wait(1, second);
    expect(held.actions[1].task.id).toBe('other');
    expect(state.workers![1].advisoryCheckpoints?.[aScope].noProgressStreak).toBe(1);
    await vi.advanceTimersByTimeAsync(120_000); await second;
    const bScope = state.workers![1].advisoryCheckpoint!.scope;
    writeSolverRunState(file, state); Object.assign(state, readSolverRunState(file));
    expect(state.workers![1].advisoryCheckpoints?.[aScope].noProgressStreak).toBe(1);
    expect(state.workers![1].advisoryCheckpoints?.[bScope].noProgressStreak).toBe(1);

    const third = run(held.open, 3); void third.catch(() => {});
    await held.wait(2, third);
    expect(held.actions.map(action => action.task.id)).toEqual(['investigate', 'other', 'investigate']);
    expect(state.cooperation!.researchDrafts!.investigate.outputDigest).toBe(firstOutput);
    expect(events.filter(event => event.event === 'cooperative_checkpoint_scheduled').at(-1)?.details)
      .toMatchObject({ checkpointAfterMs: 240_000, noProgressStreak: 1 });
    await vi.advanceTimersByTimeAsync(120_000); expect(held.interrupt).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(120_000); await third;
    expect(state.workers![1].advisoryCheckpoint).toMatchObject({ scope: aScope, noProgressStreak: 2 });
    expect(state.workers![1].advisoryCheckpoints?.[bScope].noProgressStreak).toBe(1);
    expect(check).not.toHaveBeenCalled(); expect(state.check).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
  });

  it('resets archived scoped backoff when the research environment changes', async () => {
    const { state, events, run } = fixture();
    const held = heldAdvisoryTurns(2), first = run(held.open, 1); void first.catch(() => {});
    await held.wait(0, first); await vi.advanceTimersByTimeAsync(120_000); await first;
    const scope = state.workers![1].advisoryCheckpoint!.scope;
    expect(state.workers![1].advisoryCheckpoints?.[scope].noProgressStreak).toBe(1);
    state.environmentDigest = mathDigest('a different fixed mathematical environment');
    const file = path.join(directory, 'changed-input-backoff-state.json');
    writeSolverRunState(file, state); Object.assign(state, readSolverRunState(file));
    const second = run(held.open, 2); void second.catch(() => {});
    await held.wait(1, second);
    expect(events.filter(event => event.event === 'cooperative_checkpoint_scheduled').at(-1)?.details)
      .toMatchObject({ checkpointAfterMs: 120_000, noProgressStreak: 0 });
    await vi.advanceTimersByTimeAsync(120_000); await second;
    expect(state.workers![1].advisoryCheckpoint).toMatchObject({ scope, noProgressStreak: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains other research backoff while a non-advisory helper owns the worker', async () => {
    const { state, problem, controller, run } = fixture();
    const held = heldAdvisoryTurns(2, ['investigate', 'helper']);
    const first = run(held.open, 1); void first.catch(() => {});
    await held.wait(0, first); await vi.advanceTimersByTimeAsync(120_000); await first;
    const scope = state.workers![1].advisoryCheckpoint!.scope;
    const helper = parseCooperationPlan(problem, { tasks: [
      ...state.cooperation!.tasks.map(node => node.task),
      { id: 'helper', kind: 'lemma', ownerId: 'researcher', objective: 'Prove a closed helper for the construction.',
        proofPath: problem.targets[0].proofPath, theoremName: 'checkpoint_helper', type: 'True' },
    ] }).tasks.find(task => task.id === 'helper')!;
    state.cooperation!.tasks.push({ task: helper, status: 'pending', attempts: 0 });
    state.cooperation!.tasks.find(node => node.task.id === 'investigate')!.task.status = 'paused';
    const second = run(held.open, 2); void second.catch(() => {});
    await held.wait(1, second);
    expect(held.actions[1].task.id).toBe('helper');
    expect(state.workers![1].advisoryCheckpoint).toBeUndefined();
    expect(state.workers![1].advisoryCheckpoints?.[scope].noProgressStreak).toBe(1);
    const file = path.join(directory, 'non-advisory-backoff-state.json');
    writeSolverRunState(file, state);
    expect(readSolverRunState(file).workers![1].advisoryCheckpoints?.[scope].noProgressStreak).toBe(1);
    controller.abort(new Error('fixture_complete')); await expect(second).rejects.toThrow('fixture_complete');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resets bounded advisory backoff when new owned source is saved', async () => {
    const { state, workers, problem, check, events, run } = fixture();
    const held = heldAdvisoryTurns(4), completion = run(held.open, 4); void completion.catch(() => {});
    await held.wait(0, completion);
    await vi.advanceTimersByTimeAsync(120_000); await held.wait(1, completion);
    const relative = path.join(problem.projectRelative, 'Submission.lean');
    const source = path.join(workers[1].worktree, relative);
    fs.writeFileSync(source, fs.readFileSync(source, 'utf8').replace('theorem add_zero',
      'lemma partial_construction : True := by trivial\ntheorem add_zero'));
    await vi.advanceTimersByTimeAsync(240_000); await held.wait(2, completion);
    expect(state.workers![1].advisoryCheckpoint?.noProgressStreak).toBe(0);
    const draft = state.cooperation!.researchDrafts!.investigate;
    expect(committedSource(workers[1].worktree, draft.commit, relative)).toContain('lemma partial_construction : True := by trivial');
    expect(events.filter(item => item.event === 'cooperative_checkpoint_scheduled').at(-1)?.details)
      .toMatchObject({ checkpointAfterMs: 120_000, noProgressStreak: 0, protected: false });
    await vi.advanceTimersByTimeAsync(120_000); await held.wait(3, completion);
    await vi.advanceTimersByTimeAsync(240_000); await expect(completion).resolves.toBeUndefined();
    expect(held.interrupt).toHaveBeenCalledTimes(4);
    expect(state.cooperation!.researchCheckpoints?.investigate).toMatchObject({ count: 3, paused: true });
    expect(check).not.toHaveBeenCalled(); expect(state.check).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { initial: true, published: true, approval: false },
    { initial: true, published: true, approval: true },
    { initial: true, published: false, approval: false },
    { initial: false, published: true, approval: false },
  ])('reminds only unpublished Lead decisions (initial=$initial, published=$published, approval=$approval)', async ({ initial, published, approval }) => {
    const { state, workers, check, events, controller, run, pulse } = fixture(initial, undefined, initial ? undefined : 'lead');
    if (approval) state.planApproval = true;
    const leadStarted = deferred(), peerStarted = deferred();
    const sessions = new Map<string, { interrupt: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> }>();
    let leadAction: Extract<CooperativeAction, { kind: 'lead' }>;
    const open = vi.fn(async (options: MathAgentOptions): Promise<MathAgentSession> => {
      const id = options.environment!.DEEPSCIENTIST_MATH_WORKER_ID!;
      const done = deferred<string>();
      const interrupt = vi.fn(async () => { done.resolve('interrupted'); }), notify = vi.fn(async () => {});
      sessions.set(id, { interrupt, notify });
      return { threadId: `published-plan-${id}`, interrupt, notify, close: async () => { done.resolve('interrupted'); },
        run: async (message, _messageId, _workspace, onStarted) => {
          const payload = JSON.parse(message);
          const action: CooperativeAction = payload.assignment ?? payload;
          onStarted(`published-plan-turn-${id}`);
          options.onActivity?.({ event: 'reasoning' });
          if (id === 'solver') {
            if (action.kind !== 'lead') throw new Error('fixture_expected_lead');
            leadAction = action; leadStarted.resolve();
          } else peerStarted.resolve();
          return done.promise;
        } };
    });
    const completion = run(open); void completion.catch(() => {});
    await leadStarted.promise;
    const tasks = initial ? state.problem.targets.map((target, index) => ({
      id: `goal_${index + 1}`, kind: 'goal', objective: `Prove ${target.theoremName}`, ...target,
    })) : state.cooperation!.tasks.map(node => ({ ...node.task,
      ...(node.task.id === 'investigate' ? { status: 'active' } : {}) }));
    fs.appendFileSync(path.join(workers[0].worktree, leadPlanDeliveryFile(leadAction!)!), JSON.stringify({
      kind: 'plan', baseVersion: leadAction!.planVersion,
      dispatchNonce: leadAction!.initialPlanNonce ?? leadAction!.planNonce,
      summary: 'The original target and its assigned investigation are ready.', tasks: published ? tasks : [],
    }) + '\n');
    await pulse(workers[0].id);
    expect(Boolean(state.cooperation!.planPublication)).toBe(published);
    if (published && !approval) await peerStarted.promise;
    if (approval) {
      expect(state.cooperation!.planApproval?.approvedAt).toBeUndefined();
      expect(sessions.has(workers[1].id)).toBe(false);
    }
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const lead = sessions.get('solver')!;
    expect(lead.notify.mock.calls.some(([message]) => /^If the first plan is still unpublished, publish it now/u.test(message))).toBe(!published);
    expect(events.filter(item => item.event === 'cooperative_checkpoint_requested' && item.details?.workerId === 'solver'))
      .toHaveLength(published ? 0 : 1);
    expect(lead.interrupt).not.toHaveBeenCalled();
    // Publication suppresses a stale reminder; it neither ends the live Lead nor accepts a proof.
    expect(events.some(item => item.event === 'cooperative_checkpoint_interrupted' && item.details?.workerId === 'solver')).toBe(false);
    expect(state.check).toBeUndefined(); expect(check).not.toHaveBeenCalled();
    controller.abort(new Error('fixture_complete'));
    await expect(completion).rejects.toThrow('fixture_complete');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('yields an unfinished Lead plan to original-goal work without a planning interrupt on the proof writer', async () => {
    const { state, workers, check, events, controller, run } = fixture(true);
    const leadStarted = deferred(), proofStarted = deferred();
    const leadDone = deferred<string>(), proofDone = deferred<string>();
    const sessions = new Map<string, { interrupt: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> }>();
    const open = vi.fn(async (options: MathAgentOptions): Promise<MathAgentSession> => {
      const id = options.environment!.DEEPSCIENTIST_MATH_WORKER_ID!;
      const done = id === 'solver' ? leadDone : proofDone;
      const interrupt = vi.fn(async () => { done.resolve('interrupted'); }), notify = vi.fn(async () => {});
      sessions.set(id, { interrupt, notify });
      return { threadId: `thread-${id}`, interrupt, notify, close: async () => { done.resolve('interrupted'); },
        run: async (_message, _messageId, _workspace, onStarted) => {
          onStarted(`turn-${id}`);
          options.onActivity?.({ event: 'reasoning' });
          if (id === 'solver') {
            fs.writeFileSync(path.join(options.workspace, 'RESEARCH.md'), 'The first construction is incomplete; a quantifier bridge remains open.\n');
            leadStarted.resolve();
          } else proofStarted.resolve();
          return done.promise;
        } };
    });
    const completion = run(open, 2, undefined, { softSliceMs: 0 }); void completion.catch(() => {});
    await leadStarted.promise;
    // Ask for executable work early while preserving the long writing slice.
    await vi.advanceTimersByTimeAsync(90_000 - 1);
    expect(sessions.get('solver')!.interrupt).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ event: 'cooperative_checkpoint_scheduled',
      details: expect.objectContaining({ workerId: 'solver', checkpointAfterMs: 20 * 60_000, noticeAfterMs: 90_000 }) }));
    expect(sessions.get('solver')!.notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sessions.get('solver')!.notify).toHaveBeenCalledOnce();
    expect(sessions.get('solver')!.notify.mock.calls[0]![0]).toMatch(/^If the first plan is still unpublished, publish it now/u);
    expect(sessions.get('solver')!.notify.mock.calls[0]![0]).toContain('If the host accepted it while this notice was waiting');
    expect(sessions.get('solver')!.interrupt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20 * 60_000 - 90_000);
    await proofStarted.promise;
    expect(sessions.get('solver')!.notify).toHaveBeenCalledOnce();
    expect(sessions.get('solver')!.interrupt).toHaveBeenCalledOnce();
    expect(state.cooperation!.initialPlanFallback).toBeDefined();
    expect(fs.readFileSync(path.join(workers[0].worktree, 'RESEARCH.md'), 'utf8')).toContain('a quantifier bridge remains open');
    expect(state.cooperation!.tasks.filter(node => node.task.kind === 'goal')).toHaveLength(state.problem.targets.length);
    expect(state.check).toBeUndefined(); expect(check).not.toHaveBeenCalled();
    expect(workers[1].role).toBe('engineer');
    await vi.advanceTimersByTimeAsync(2 * 3_600_000);
    // The goal writer is the only worker that can close the problem: it is reminded to keep a
    // durable handoff, but its turn is never taken away and it never receives a yield notice.
    expect(sessions.get('engineer')!.interrupt).not.toHaveBeenCalled();
    expect(sessions.get('engineer')!.notify).toHaveBeenCalledOnce();
    expect(sessions.get('engineer')!.notify.mock.calls[0]![0]).toMatch(/RESEARCH\.md/u);
    expect(sessions.get('engineer')!.notify.mock.calls[0]![0]).toMatch(/no checkpoint will interrupt or end it/u);
    expect(events).toContainEqual(expect.objectContaining({ event: 'cooperative_checkpoint_scheduled',
      details: expect.objectContaining({ workerId: 'engineer', noticeOnly: true, checkpointAfterMs: 15 * 60_000 }) }));
    expect(events.some(item => item.event === 'cooperative_checkpoint_interrupted' && item.details?.workerId === 'engineer')).toBe(false);
    expect(open.mock.calls.every(([options]) => options.turnTimeoutMs === undefined)).toBe(true);
    expect(events.some(item => item.event === 'turn_checkpoint' &&
      item.details?.reason === 'math_cooperative_scheduling_checkpoint')).toBe(true);
    controller.abort(new Error('fixture_complete'));
    await expect(completion).rejects.toThrow('fixture_complete');
    expect(check).not.toHaveBeenCalled(); expect(state.check).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])('yields a conditional goal without submitting unfinished code (ready at boundary: %s)', async ready => {
    const { state, workers, problem, check, events, run } = fixture();
    state.cooperation!.tasks.find(node => node.task.id === 'investigate')!.task.status = 'paused';
    const goal = state.cooperation!.tasks.find(node => node.task.kind === 'goal')!;
    goal.task = { ...goal.task, status: 'active', conditional: true, dependsOn: ['connection_input'] };
    const helper = parseCooperationPlan(problem, { tasks: [
      ...state.cooperation!.tasks.map(node => node.task),
      { id: 'connection_input', kind: 'lemma', objective: 'Prove the missing input.', ownerId: 'solver',
        theoremName: 'connection_input', type: 'True', proofPath: problem.targets[0].proofPath },
    ] }).tasks.find(task => task.id === 'connection_input')!;
    state.cooperation!.tasks.push({ task: helper, status: 'pending', attempts: 0 });
    const held = heldAdvisoryTurns(1, [goal.task.id]);
    if (ready) {
      const interrupt = held.interrupt.getMockImplementation()!;
      held.interrupt.mockImplementation(async () => {
        fs.appendFileSync(path.join(workers[1].worktree, assignmentDeliveryFile(held.actions[0].assignment)),
          JSON.stringify({ kind: 'ready', id: 'conditional-ready-at-boundary' }) + '\n');
        await interrupt();
      });
    }
    const completion = run(held.open, 1); void completion.catch(() => {});
    await held.wait(0, completion);
    expect(held.actions[0].assignment.connectionCheck).toBeDefined();
    const notes = 'The exact conditional application gap is saved; the input is still unproved.\n';
    fs.writeFileSync(path.join(workers[1].worktree, 'RESEARCH.md'), notes);
    await vi.advanceTimersByTimeAsync(120_000);
    if (ready) {
      await expect(completion).rejects.toThrow('math_writer_stop_unconfirmed');
      expect(state.workers![1].writerStopUnconfirmed).toBeDefined();
      expect(events.some(event => event.event === 'connection_checkpoint_saved')).toBe(false);
    } else {
      await completion;
      const draft = state.cooperation!.researchDrafts![goal.task.id];
      expect(committedSource(workers[1].worktree, draft.commit, 'RESEARCH.md')).toBe(notes);
      expect(goal.status).toBe('pending');
      expect(goal.proof).toBeUndefined(); expect(goal.integratedCheck).toBeUndefined();
      expect(events.some(event => event.event === 'connection_checkpoint_saved')).toBe(true);
      expect(state.cooperation!.failedTaskInputs ?? []).toEqual([]);
    }
    expect(held.interrupt).toHaveBeenCalledOnce();
    expect(check).not.toHaveBeenCalled(); expect(state.check).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  function connectionChain() {
    const run = fixture(), { state, problem } = run;
    state.cooperation!.tasks.find(node => node.task.id === 'investigate')!.task.status = 'paused';
    const goal = state.cooperation!.tasks.find(node => node.task.kind === 'goal')!;
    goal.task = { ...goal.task, status: 'active', conditional: false, dependsOn: ['connection_consumer'] };
    const plan = parseCooperationPlan(problem, { tasks: [
      ...state.cooperation!.tasks.map(node => node.task),
      { id: 'connection_consumer', kind: 'lemma', conditional: true, ownerId: 'researcher',
        objective: 'Construct the conditional application.', dependsOn: ['connection_bridge'],
        theoremName: 'connection_consumer', type: 'True', proofPath: problem.targets[0].proofPath },
      { id: 'connection_bridge', kind: 'lemma', ownerId: 'solver', objective: 'Connect the leaf to the consumer.',
        dependsOn: ['connection_leaf'], theoremName: 'connection_bridge', type: 'True', proofPath: problem.targets[0].proofPath },
      { id: 'connection_leaf', kind: 'lemma', ownerId: 'researcher', objective: 'Prove the runnable upstream input.',
        theoremName: 'connection_leaf', type: 'True', proofPath: problem.targets[0].proofPath },
    ] });
    state.cooperation!.tasks.push(...plan.tasks.filter(task => task.id.startsWith('connection_'))
      .map(task => ({ task, status: 'pending' as const, attempts: 0 })));
    return run;
  }

  it('lets an unchanged connection checkpoint dispatch its owned transitive leaf with the consumer draft retained', async () => {
    const { state, workers, problem, check, controller, events, run } = connectionChain();
    const held = heldAdvisoryTurns(3, ['connection_consumer', 'connection_leaf']);
    const completion = run(held.open, 3); void completion.catch(() => {});
    await held.wait(0, completion);
    expect(held.actions[0].task.id).toBe('connection_consumer');
    const notes = 'Saved the conditional application; the upstream finite argument is still missing.\n';
    fs.writeFileSync(path.join(workers[1].worktree, 'RESEARCH.md'), notes);
    fs.appendFileSync(path.join(workers[1].worktree, problem.projectRelative, problem.targets[0].proofPath),
      '\n-- Partial consumer derivation retained across the upstream task.\n');
    await vi.advanceTimersByTimeAsync(120_000);
    await held.wait(1, completion);
    expect(held.actions[1].task.id).toBe('connection_consumer');
    const consumer = state.cooperation!.tasks.find(node => node.task.id === 'connection_consumer')!;
    expect(consumer.connectionCheckpoint).toBeUndefined(); // Fresh durable output earns another turn.
    const assignment = consumer.assignment;
    await vi.advanceTimersByTimeAsync(120_000);
    await held.wait(2, completion);
    expect(held.actions[2].task.id).toBe('connection_leaf');
    const draft = state.cooperation!.researchDrafts!.connection_consumer;
    expect(draft.suspended).toBe(true);
    expect(committedSource(workers[1].worktree, draft.commit, 'RESEARCH.md')).toBe(notes);
    expect(committedSource(workers[1].worktree, draft.commit, `${problem.projectRelative}/${problem.targets[0].proofPath}`))
      .toContain('Partial consumer derivation retained');
    expect(consumer.assignment).toBe(assignment);
    expect(consumer.connectionCheckpoint?.outputDigest).toBe(draft.outputDigest);
    expect(events.filter(event => event.event === 'connection_checkpoint_saved')).toHaveLength(2);
    const saved = path.join(directory, 'connection-yield.json');
    writeSolverRunState(saved, state);
    expect(readSolverRunState(saved).cooperation!.tasks.find(node => node.task.id === consumer.task.id)?.connectionCheckpoint)
      .toEqual(consumer.connectionCheckpoint);
    controller.abort(new Error('fixture_complete')); await expect(completion).rejects.toThrow('fixture_complete');
    expect(check).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['unchanged', 'new-input', 'new-output'] as const)(
    'restores a saved connection checkpoint and dispatches after %s', async change => {
      const { state, workers, check, controller, run } = connectionChain();
      const held = heldAdvisoryTurns(2, ['connection_consumer', 'connection_leaf']);
      const first = run(held.open, 1); void first.catch(() => {});
      await held.wait(0, first);
      await vi.advanceTimersByTimeAsync(120_000); await first;
      const consumer = state.cooperation!.tasks.find(node => node.task.id === 'connection_consumer')!;
      expect(consumer.connectionCheckpoint).toBeDefined();
      if (change === 'new-input') {
        // Relevant evidence can change without changing a task's statement or connection identity.
        state.cooperation!.tasks.find(node => node.task.id === 'connection_leaf')!.finding = 'A new finite recurrence is available.';
        // Persist it as a source-bound canonical input, like newly integrated supporting code.
        const file = path.join(workers[0].worktree, state.problem.projectRelative, state.problem.targets[0].proofPath);
        fs.appendFileSync(file, '\n-- New canonical finite-recurrence source.\n');
        state.cooperation!.canonicalCommit = commitSolverSources(state.problem, workers[0].worktree);
      }
      if (change === 'new-output') {
        fs.writeFileSync(path.join(workers[1].worktree, 'RESEARCH.md'), 'A newly saved conditional derivation.\n');
        commitSolverSources(state.problem, workers[1].worktree);
      }
      const saved = path.join(directory, 'restored-connection-yield.json');
      writeSolverRunState(saved, state); Object.assign(state, readSolverRunState(saved));
      const second = run(held.open, 2); void second.catch(() => {});
      await held.wait(1, second);
      expect(held.actions[1].task.id).toBe(change === 'unchanged' ? 'connection_leaf' : 'connection_consumer');
      if (change !== 'unchanged') expect(state.cooperation!.tasks.find(node => node.task.id === consumer.task.id)?.connectionCheckpoint)
        .toBeUndefined();
      controller.abort(new Error('fixture_complete')); await expect(second).rejects.toThrow('fixture_complete');
      expect(check).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    });

  it('suppresses a stale reminder after the Lead publishes its first graph without interrupting peers', async () => {
    const { state, check, controller, run, pulse } = fixture(true);
    const leadStarted = deferred(), engineerStarted = deferred();
    const notifications = new Map<string, ReturnType<typeof vi.fn>>();
    const interrupts = new Map<string, ReturnType<typeof vi.fn>>();
    const open = vi.fn(async (options: MathAgentOptions): Promise<MathAgentSession> => {
      const id = options.environment!.DEEPSCIENTIST_MATH_WORKER_ID!, done = deferred<string>();
      const notify = vi.fn(async () => {}), interrupt = vi.fn(async () => { done.resolve('interrupted'); });
      notifications.set(id, notify); interrupts.set(id, interrupt);
      return { threadId: `thread-${id}`, notify, interrupt, close: async () => { done.resolve('interrupted'); },
        run: async (message, _messageId, _workspace, onStarted) => {
          onStarted(`turn-${id}`); options.onActivity?.({ event: 'reasoning' });
          if (id === 'solver') {
            const action = JSON.parse(message) as Extract<CooperativeAction, { kind: 'lead' }>;
            fs.appendFileSync(path.join(options.workspace, leadPlanDeliveryFile(action)!), JSON.stringify({
              kind: 'plan', baseVersion: action.planVersion,
              tasks: state.problem.targets.map((target, index) => ({ id: `goal_${index}`, kind: 'goal',
                objective: `Prove ${target.theoremName}`, ...target })),
            }) + '\n');
            leadStarted.resolve();
          } else engineerStarted.resolve();
          return done.promise;
        } };
    });
    const completion = run(open); void completion.catch(() => {});
    await leadStarted.promise; await pulse('solver'); await engineerStarted.promise;
    expect(state.cooperation!.initialPlanPublication).toBeDefined();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(notifications.get('solver')).not.toHaveBeenCalled();
    expect(interrupts.get('solver')).not.toHaveBeenCalled();
    expect(interrupts.get('engineer')).not.toHaveBeenCalled();
    expect(state.cooperation!.initialPlanFallback).toBeUndefined();
    expect(check).not.toHaveBeenCalled();
    controller.abort(new Error('fixture_complete')); await expect(completion).rejects.toThrow('fixture_complete');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { readyAfterInterrupt: false, completesAfterPublish: false },
    { readyAfterInterrupt: false, completesAfterPublish: true },
    { readyAfterInterrupt: true, completesAfterPublish: false },
  ])('preserves the proof freeze barrier with readiness=$readyAfterInterrupt and completed=$completesAfterPublish', async ({ readyAfterInterrupt, completesAfterPublish }) => {
    const { state, workers, problem, check, events, controller, run, pulse } = fixture();
    workers[1].role = state.workers![1].role = 'engineer';
    state.cooperation!.tasks.find(node => node.task.id === 'investigate')!.task.status = 'paused';
    for (const node of state.cooperation!.tasks.filter(node => node.task.kind === 'goal')) {
      node.task.status = 'active'; node.task.ownerId = workers[1].id;
    }
    const started = [deferred(), deferred()], done = [deferred<string>(), deferred<string>()];
    const messages: Extract<CooperativeAction, { kind: 'task' }>[] = [], threads: string[] = [];
    let inputTokens = 0, turns = 0, readyWritten = false, active: ReturnType<typeof deferred<string>> | undefined;
    const interrupt = vi.fn(async () => {
      if (readyAfterInterrupt && !readyWritten) {
        readyWritten = true;
        fs.appendFileSync(path.join(workers[1].worktree, assignmentDeliveryFile(messages[0].assignment)),
          JSON.stringify({ kind: 'ready', id: 'ready-after-context-interrupt' }) + '\n');
      }
      active?.resolve('interrupted');
    });
    const close = vi.fn(async () => { active?.resolve('interrupted'); });
    const stopForFreeze = vi.fn(async () => ({ status: 'unconfirmed' as const, reason: 'process-group-active' as const }));
    const notify = vi.fn(async () => {});
    const open = vi.fn(async (options: MathAgentOptions): Promise<MathAgentSession> => {
      const threadId = `proof-context-thread-${open.mock.calls.length}`;
      return { threadId, interrupt, close, notify, ...(readyAfterInterrupt ? { stopForFreeze } : {}),
        get lastInputTokens() { return inputTokens; },
        run: async (message, _messageId, _workspace, onStarted) => {
          const turn = turns++;
          if (turn > 1) throw new Error('fixture_unexpected_third_proof_turn');
          const action = JSON.parse(message) as CooperativeAction;
          if (action.kind !== 'task' || action.task.kind !== 'goal') throw new Error('fixture_expected_proof_task');
          messages.push(action); threads.push(threadId); active = done[turn];
          onStarted(`proof-context-turn-${turn}`); started[turn].resolve(); return done[turn].promise;
        } };
    });
    const completion = run(open, Infinity, undefined, { softSliceMs: 0 }); void completion.catch(() => {});
    const wait = (turn: number) => Promise.race([started[turn].promise,
      completion.then(() => { throw new Error('fixture_proof_stopped_before_context_checkpoint:' + turn); })]);
    await wait(0);
    const notes = path.join(workers[1].worktree, 'RESEARCH.md');
    const source = path.join(workers[1].worktree, problem.projectRelative, 'Submission.lean');
    const originalSource = fs.readFileSync(source, 'utf8');
    inputTokens = 100_000;
    open.mock.calls[0][0].onActivity!({ event: 'reasoning' });
    expect(state.workers![1].contextCheckpoint?.threadId).toBe(threads[0]);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining(state.workers![1].contextCheckpoint!.requestId!));
    await vi.advanceTimersByTimeAsync(2 * 3_600_000);
    expect(interrupt).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledOnce(); expect(check).not.toHaveBeenCalled();
    expect(state.workers![1].previousThreadIds).toBeUndefined();
    // Provider compaction can lower the visible token count before the saved handoff reaches the host.
    inputTokens = 24_000;
    open.mock.calls[0][0].onActivity!({ event: 'item_completed', itemType: 'contextCompaction' });
    fs.writeFileSync(notes, 'The exact current proof argument, attempted methods, and unresolved inference are saved.\n');
    const partialSource = originalSource.replace('by sorry', 'by\n  -- Interrupted proof draft must survive context maintenance.\n  sorry') +
      '\nlemma checkpoint_support : True := by trivial\n';
    fs.writeFileSync(source, partialSource);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(interrupt).not.toHaveBeenCalled();
    // Saving notes is only the first tool action. The following report must reach the host before yielding.
    const log = path.join(workers[1].worktree, assignmentDeliveryFile(messages[0].assignment));
    fs.appendFileSync(log, JSON.stringify({ kind: 'progress', summary: 'The exact unresolved inference remains in this saved draft.' }) + '\n');
    const request = state.workers![1].contextCheckpoint!;
    fs.appendFileSync(log, JSON.stringify({ kind: 'checkpoint', requestId: request.requestId,
      notesDigest: mathDigest(fs.readFileSync(notes)) }) + '\n');
    await pulse(workers[1].id);
    expect(state.cooperation!.deliveries).toContainEqual(expect.objectContaining({ kind: 'progress',
      summary: 'The exact unresolved inference remains in this saved draft.' }));
    if (completesAfterPublish) done[0].resolve('completed');
    else await vi.advanceTimersByTimeAsync(5_000);
    if (readyAfterInterrupt) {
      await expect(completion).rejects.toThrow('math_writer_stop_unconfirmed');
      expect(stopForFreeze).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
      expect(open).toHaveBeenCalledOnce();
      expect(state.cooperation!.proofReadyRecords).toMatchObject([{ status: 'failed',
        reason: 'Freeze unconfirmed: process-group-active' }]);
      expect(state.cooperation!.proofReadyRecords![0].snapshotCommit).toBeUndefined();
      expect(state.workers![1].writerStopUnconfirmed).toMatchObject({ reason: 'process-group-active' });
      expect(events.some(item => item.event === 'context_checkpoint_interrupted')).toBe(true);
      expect(events.some(item => item.event === 'context_checkpoint_saved')).toBe(false);
      expect(check).not.toHaveBeenCalled(); expect(state.check).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
      return;
    }
    await wait(1);
    expect(interrupt).toHaveBeenCalledTimes(completesAfterPublish ? 0 : 1); expect(close).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledTimes(2); expect(open.mock.calls[1][0].threadId).toBeUndefined();
    expect(threads).toEqual(['proof-context-thread-1', 'proof-context-thread-2']);
    expect(messages[1].assignment).toEqual(messages[0].assignment);
    expect(state.workers![1].previousThreadIds).toEqual(['proof-context-thread-1']);
    expect(state.workers![1].contextCheckpoint).toBeUndefined();
    expect(fs.readFileSync(notes, 'utf8')).toContain('exact current proof argument');
    expect(fs.readFileSync(source, 'utf8')).toBe(partialSource);
    const snapshot = events.find(item => item.event === 'context_checkpoint_saved')!.details!;
    expect(committedSource(workers[1].worktree, snapshot.commit as string, 'RESEARCH.md')).toContain('exact current proof argument');
    expect(state.cooperation!.deliveries).toContainEqual(expect.objectContaining({ kind: 'progress', status: 'advisory',
      commit: snapshot.commit, artifacts: expect.objectContaining({ scope: 'advisory-unverified',
        artifacts: expect.arrayContaining([expect.objectContaining({ declarations: expect.arrayContaining([
          expect.objectContaining({ name: 'checkpoint_support', draft: false }),
        ]) })]) }) }));
    expect(state.cooperation!.tasks.find(node => node.task.id === messages[0].task.id)).toMatchObject({ status: 'running' });
    expect(state.cooperation!.failedTaskInputs ?? []).toEqual([]);
    expect(events.some(item => ['task_checked', 'task_failed_input_recorded', 'worker_failed', 'turn_failed'].includes(item.event))).toBe(false);
    expect(check).not.toHaveBeenCalled(); expect(state.check).toBeUndefined();
    expect(state.tokenBudget).toMatchObject({ maxTotalTokens: 0, status: 'unlimited' });
    expect(open.mock.calls.every(([options]) => options.turnTimeoutMs === undefined)).toBe(true);
    controller.abort(new Error('fixture_complete')); await expect(completion).rejects.toThrow('fixture_complete');
    expect(vi.getTimerCount()).toBe(0);
  });
});
