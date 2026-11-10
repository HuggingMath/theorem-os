import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MathAgentOptions, MathAgentSession } from '../src/runtime/codexSession';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { CooperativeResearch } from '../src/solver/cooperation';
import { acceptContextCheckpoint } from '../src/solver/contextCheckpoint';
import { directSolverModules, type SolverModules } from '../src/solver/modules';
import { committedSource } from '../src/solver/problem';
import { runResearchWorkers } from '../src/solver/research';
import { parseCooperationPlan, type CooperativeAction } from '../src/solver/tasks';
import { deferred } from './helpers/async';
import { workerAccess } from './helpers/cooperation';
import { leadWorker, localExample, peerWorker, solverState } from './helpers/solver';

vi.mock('../src/math/mathBuildManifest', () => ({ readMathBuildManifest: vi.fn() }));

describe('durable advisory research checkpoints', () => {
  const roots: string[] = [], controllers: AbortController[] = [], running: Promise<unknown>[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(CooperativeResearch.prototype, 'restore').mockImplementation(async () => {});
    vi.spyOn(CooperativeResearch.prototype, 'start').mockImplementation(() => {});
  });
  afterEach(async () => {
    controllers.forEach(controller => controller.abort());
    await Promise.allSettled(running);
    vi.useRealTimers(); vi.restoreAllMocks();
    roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
    controllers.splice(0); running.splice(0);
  });

  function fixture(options: { notes?: string; turns?: number; kind?: 'research' | 'sketch'; feasibility?: boolean } = {}) {
    const example = localExample('research-durable-checkpoint-'); roots.push(example.directory);
    const { directory, workspace, problem } = example;
    const workers = [leadWorker(problem, workspace), peerWorker(example, 'researcher')];
    const notesFile = path.join(workers[1].worktree, 'RESEARCH.md');
    if (options.notes !== undefined) fs.writeFileSync(notesFile, options.notes);
    const plan = parseCooperationPlan(problem, { tasks: [
      ...problem.targets.map((target, index) => ({ id: `goal_${index + 1}`, kind: 'goal',
        objective: `Prove ${target.theoremName}`, ...target, status: 'paused' })),
      { id: 'investigate', kind: options.kind ?? 'research', ownerId: 'researcher', objective: 'Resolve the precise missing construction.',
        ...(options.feasibility ? { reviewScope: 'feasibility' } : {}) },
    ] });
    const state = solverState(problem, workspace, { runId: 'durable-research-fixture', phase: 'prepared',
      workers: workers.map(worker => ({ ...worker, phase: 'prepared', turns: 0 })),
      cooperation: { tasks: plan.tasks.map(task => ({ task, status: 'pending', attempts: 0 })),
        groups: plan.groups.map(group => ({ group, turns: 0 })) } });
    const check = vi.fn(async () => { throw new Error('fixture_unexpected_proof_acceptance'); });
    const events: { event: string; details?: Record<string, unknown> }[] = [];
    const controller = new AbortController(); controllers.push(controller);
    const count = options.turns ?? 1;
    const started = Array.from({ length: count }, () => deferred());
    const done = Array.from({ length: count }, () => deferred<string>());
    const actions: Extract<CooperativeAction, { kind: 'task' }>[] = [];
    let active: ReturnType<typeof deferred<string>> | undefined, turn = 0;
    let sessionOptions: MathAgentOptions;
    const interrupt = vi.fn(async () => { active?.resolve('interrupted'); });
    const notify = vi.fn(async (_message: string) => {});
    const open = vi.fn(async (settings: MathAgentOptions): Promise<MathAgentSession> => {
      sessionOptions = settings;
      return { threadId: 'durable-research-thread', interrupt, notify,
        close: async () => { active?.resolve('interrupted'); },
        run: async (message, _messageId, _workspace, onStarted) => {
          const index = turn++, action = JSON.parse(message) as CooperativeAction;
          if (index >= count || action.kind !== 'task' || action.task.id !== 'investigate')
            throw new Error('fixture_unexpected_turn');
          actions.push(action); active = done[index]; onStarted(`research-turn-${index}`);
          settings.onActivity?.({ event: 'reasoning' }); started[index].resolve();
          return done[index].promise;
        } };
    });
    const modules: SolverModules = { ...directSolverModules, M1: { ...directSolverModules.M1, open },
      M2: { ...directSolverModules.M2, check, checkTask: check },
      M4: { ...directSolverModules.M4, build: (_problem, _state, access) => ({
        instructions: 'Offline durable checkpoint fixture.', message: JSON.stringify(access.assignment),
        scope: 'original-problem-and-allowed-library', sources: { problemReceiptDigest: problem.receiptDigest },
      }) } };
    const run = () => {
      const completion = runResearchWorkers({ state, workers, modules, access: workerAccess(workers, directory),
        root: directory, buildFile: path.join(directory, 'build.json'), taskText: 'Prove the original targets.',
        executable: 'offline-fixture', profile: 'offline-fixture', signal: controller.signal,
        deadline: Infinity, maxTurnMs: Infinity, maxTurns: count, maxTotalTokens: 0,
        goalProgressReviewMs: 24 * 3_600_000, save: () => {}, emit: (event, details) => events.push({ event, details }) });
      running.push(completion); void completion.catch(() => {}); return completion;
    };
    const activity = (event: Parameters<NonNullable<MathAgentOptions['onActivity']>>[0]) => sessionOptions.onActivity?.(event);
    const tool = (save?: string) => {
      activity({ event: 'item_started', itemType: 'commandExecution' });
      if (save !== undefined) fs.writeFileSync(notesFile, save);
      activity({ event: 'item_completed', itemType: 'commandExecution' });
    };
    const reachSlice = async (completion: Promise<unknown>, index = 0) => {
      await Promise.race([started[index].promise, completion.then(() => { throw new Error('fixture_turn_did_not_start'); })]);
      const sliceMs = events.filter(item => item.event === 'cooperative_checkpoint_scheduled').at(-1)!.details!.checkpointAfterMs as number;
      await vi.advanceTimersByTimeAsync(sliceMs - 30_000); activity({ event: 'reasoning' });
      await vi.advanceTimersByTimeAsync(30_000);
    };
    return { state, workers, notesFile, events, check, controller, notify, interrupt, open, run, tool, activity, reachSlice,
      wait: (index: number) => started[index].promise, settle: (index: number, status: string) => done[index].resolve(status), actions };
  }

  it('reminds an independent reviewer to save reproducible work without yielding, then preserves its context handoff', async () => {
    const f = fixture({ feasibility: true }), completion = f.run(); await f.wait(0);
    const schedule = f.events.find(event => event.event === 'cooperative_checkpoint_scheduled')!;
    expect(schedule.details).toMatchObject({ noticeOnly: true, noProgressStreak: 0 });
    await vi.advanceTimersByTimeAsync(35 * 60_000);
    expect(f.notify).toHaveBeenCalledOnce();
    expect(f.notify.mock.calls[0][0]).toContain('A scratch path alone is not a recoverable probe');
    expect(f.notify.mock.calls[0][0]).toContain('exact failed search scope');
    expect(f.interrupt).not.toHaveBeenCalled();
    const notes = 'Checked only finite independent families; no uniform construction found in the searched declarations.\r\n' +
      'Probe .scratch/tmp/Probe1.lean, rerun with: lake env lean .scratch/tmp/Probe1.lean\r\n' +
      '```lean\r\nimport Mathlib\r\n#check Finset.sum_eq_single\r\n```\r\n' +
      'Observed result: the local probe succeeds; the infinite-family inference remains unproved.\r\n' +
      '```math-result\n{"summary":"Provisional only","conclusion":"supporting"}\n```\n';
    f.tool(notes);
    const research = f.state.workers![1];
    research.contextCheckpoint = { threadId: research.threadId!, requestedAt: Date.now(), requestId: 'review-handoff' };
    acceptContextCheckpoint(research, f.workers[1].worktree,
      { kind: 'checkpoint', requestId: 'review-handoff', notesDigest: mathDigest(notes) });
    await vi.advanceTimersByTimeAsync(5_000); await expect(completion).resolves.toBeUndefined();
    const draft = f.state.cooperation!.researchDrafts!.investigate;
    expect(committedSource(f.workers[1].worktree, draft.commit, 'RESEARCH.md')).toBe(notes);
    expect(draft).toMatchObject({ handoffNotesDigest: mathDigest(notes),
      feasibilityInputDigest: f.actions[0].assignment.feasibilityInputDigest });
    const node = f.state.cooperation!.tasks.find(node => node.task.id === 'investigate')!;
    expect(node.status).toBe('pending'); expect(node.researchCompletion).toBeUndefined();
    expect(f.state.cooperation!.researchCheckpoints?.investigate).toBeUndefined();
    expect(f.state.cooperation!.deliveries?.filter(record => record.kind === 'research') ?? []).toEqual([]);
    expect(f.check).not.toHaveBeenCalled(); expect(f.interrupt).toHaveBeenCalledOnce();
  });

  it('opens a fresh independent reviewer thread when inspection inputs change between interrupted turns', async () => {
    const f = fixture({ feasibility: true, turns: 2 }), completion = f.run(); await f.wait(0);
    f.tool('Old-library review notes; still no verdict.\n');
    f.state.knowledgeDigest = mathDigest('new inspected library knowledge');
    f.settle(0, 'interrupted'); await f.wait(1);
    expect(f.actions[1].assignment.assignmentId).not.toBe(f.actions[0].assignment.assignmentId);
    expect(f.actions[1].assignment.feasibilityInputDigest).not.toBe(f.actions[0].assignment.feasibilityInputDigest);
    expect(f.open).toHaveBeenCalledTimes(2);
    expect(f.open.mock.calls[1][0].threadId).toBeUndefined();
    expect(f.events).toContainEqual(expect.objectContaining({ event: 'context_restarted',
      details: expect.objectContaining({ reason: 'responsibility' }) }));
    expect(fs.readFileSync(f.notesFile, 'utf8')).toBe('');
    f.settle(1, 'interrupted'); await expect(completion).resolves.toBeUndefined();
    expect(f.check).not.toHaveBeenCalled();
  });

  it.each([undefined, ' \n\t', 'Inherited notes from a different responsibility.\n'])(
    'keeps a search result open until the current assignment saves notes (seed: %j)', async notes => {
      const f = fixture({ notes }), completion = f.run();
      await f.reachSlice(completion); await vi.advanceTimersByTimeAsync(10_000);
      if (notes !== undefined)
        expect(committedSource(f.workers[1].worktree, f.actions[0].assignment.seedCommit, 'RESEARCH.md')).toBe(notes);
      f.tool(); await vi.advanceTimersByTimeAsync(0);
      expect(f.interrupt).not.toHaveBeenCalled();
      expect(f.events.filter(event => event.event === 'research_handoff_requested')).toHaveLength(1);
      expect(f.notify.mock.calls.at(-1)![0]).toContain('do not invent a finding or proof');
      // The first search's completion is not the requested handoff. A later write gets its own result.
      await vi.advanceTimersByTimeAsync(30_000);
      const handoff = 'The checked reduction uses the finite basis identity; the uniform estimate remains unresolved.\n';
      f.tool(handoff); await expect(completion).resolves.toBeUndefined();
      expect(f.interrupt).toHaveBeenCalledOnce();
      const draft = f.state.cooperation!.researchDrafts!.investigate;
      expect(committedSource(f.workers[1].worktree, draft.commit, 'RESEARCH.md')).toBe(handoff);
      expect(f.state.cooperation!.tasks.find(node => node.task.id === 'investigate')!.proof).toBeUndefined();
      expect(f.check).not.toHaveBeenCalled();
      expect(f.events.some(event => event.event === 'research_checkpoint_missing_notes')).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });

  it('waits for a running search tool at the slice end before accepting a later notes write', async () => {
    const f = fixture(), completion = f.run();
    await f.wait(0); await vi.advanceTimersByTimeAsync(90_000);
    f.activity({ event: 'item_started', itemType: 'commandExecution' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.interrupt).not.toHaveBeenCalled();
    f.activity({ event: 'item_completed', itemType: 'commandExecution' });
    await vi.advanceTimersByTimeAsync(0); expect(f.interrupt).not.toHaveBeenCalled();
    f.tool('Search result: the relevant module lacks this exact premise; the next step is to prove the estimate.\n');
    await expect(completion).resolves.toBeUndefined(); expect(f.interrupt).toHaveBeenCalledOnce();
  });

  it('finishes a notes write spanning the slice end before freezing the saved handoff', async () => {
    const f = fixture(), completion = f.run();
    await f.wait(0); await vi.advanceTimersByTimeAsync(90_000);
    f.activity({ event: 'item_started', itemType: 'commandExecution' });
    fs.writeFileSync(f.notesFile, 'The reduction is saved, but this writing command still owns the worktree.\n');
    await vi.advanceTimersByTimeAsync(30_000); expect(f.interrupt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    const notes = 'The completed reduction leaves exactly the stated norm estimate unresolved.\n';
    fs.writeFileSync(f.notesFile, notes);
    f.activity({ event: 'item_completed', itemType: 'commandExecution' });
    await expect(completion).resolves.toBeUndefined(); expect(f.interrupt).toHaveBeenCalledOnce();
    expect(committedSource(f.workers[1].worktree, f.state.cooperation!.researchDrafts!.investigate.commit, 'RESEARCH.md')).toBe(notes);
    expect(f.events.some(event => event.event === 'research_handoff_requested')).toBe(false);
    expect(f.check).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the original deadline through repeated search results and an empty handoff', async () => {
    const f = fixture(), completion = f.run(); await f.reachSlice(completion);
    await vi.advanceTimersByTimeAsync(10_000); f.tool(); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5 * 60_000); f.tool(' \n\t');
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 10_001);
    expect(f.interrupt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await expect(completion).resolves.toBeUndefined();
    expect(f.interrupt).toHaveBeenCalledOnce(); expect(f.notify).toHaveBeenCalledTimes(2);
    expect(f.events.filter(event => event.event === 'research_handoff_requested')).toHaveLength(1);
    expect(f.events).toContainEqual({ event: 'cooperative_checkpoint_request_settled', details: expect.objectContaining({
      boundary: 'wait-limit', waitedMs: 10 * 60_000 }) });
    expect(f.events.filter(event => event.event === 'research_checkpoint_missing_notes')).toHaveLength(1);
    expect(f.check).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('ends the bounded handoff when its extra save notice fails', async () => {
    const f = fixture(), notice = deferred();
    f.notify.mockImplementationOnce(async () => {}).mockImplementationOnce(() => notice.promise);
    const completion = f.run(); await f.reachSlice(completion); f.tool(); await vi.advanceTimersByTimeAsync(0);
    expect(f.interrupt).not.toHaveBeenCalled();
    notice.reject(new Error('offline_handoff_notice_failed')); await expect(completion).resolves.toBeUndefined();
    expect(f.events).toContainEqual({ event: 'cooperative_checkpoint_request_settled', details: expect.objectContaining({
      boundary: 'notice-failed' }) });
    expect(f.events).toContainEqual({ event: 'cooperative_checkpoint_notice_failed', details: expect.objectContaining({
      reason: 'offline_handoff_notice_failed' }) });
    expect(f.interrupt).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans the fixed deadline on cancellation while a handoff notice is pending', async () => {
    const f = fixture(), notice = deferred();
    f.notify.mockImplementationOnce(async () => {}).mockImplementationOnce(() => notice.promise);
    const completion = f.run(); await f.reachSlice(completion); f.tool(); await vi.advanceTimersByTimeAsync(0);
    f.controller.abort(new Error('fixture_handoff_cancelled'));
    await expect(completion).rejects.toThrow('fixture_handoff_cancelled');
    const events = f.events.length; notice.resolve(); await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(f.events).toHaveLength(events); expect(vi.getTimerCount()).toBe(0);
  });

  it('allows accurate retained notes for the same assignment on its next slice', async () => {
    const f = fixture({ turns: 2 }), completion = f.run(); await f.reachSlice(completion);
    const notes = 'The saved derivation reduces the problem to the precise missing norm estimate.\n';
    f.tool(notes); await f.wait(1);
    await f.reachSlice(completion, 1); f.tool();
    await expect(completion).resolves.toBeUndefined(); expect(f.interrupt).toHaveBeenCalledTimes(2);
    expect(f.events.some(event => event.event === 'research_handoff_requested')).toBe(false);
    expect(f.actions[1].assignment.assignmentId).toBe(f.actions[0].assignment.assignmentId);
    expect(f.state.cooperation!.researchDrafts!.investigate.handoffNotesDigest).toBe(mathDigest(notes));
    expect(committedSource(f.workers[1].worktree, f.state.cooperation!.researchDrafts!.investigate.commit, 'RESEARCH.md')).toBe(notes);
    expect(f.check).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps acknowledged seed-equal notes attributed after rotating the context and resuming the task', async () => {
    const notes = 'This existing reduction is accurate for the current assignment; the norm estimate remains open.\n';
    const f = fixture({ notes, turns: 2 }), completion = f.run(); await f.wait(0);
    const research = f.state.workers![1];
    research.contextCheckpoint = { threadId: research.threadId!, requestedAt: Date.now(), requestId: 'confirm-current-notes' };
    acceptContextCheckpoint(research, f.workers[1].worktree, { kind: 'checkpoint',
      requestId: 'confirm-current-notes', notesDigest: mathDigest(notes) });
    await vi.advanceTimersByTimeAsync(5_000); await f.wait(1);
    expect(f.state.cooperation!.researchDrafts!.investigate.handoffNotesDigest).toBe(mathDigest(notes));
    expect(f.events.filter(item => item.event === 'context_restarted')).toHaveLength(1);
    expect(research.contextCheckpoint).toBeUndefined();
    await f.reachSlice(completion, 1); f.tool();
    await expect(completion).resolves.toBeUndefined();
    expect(f.interrupt).toHaveBeenCalledTimes(2);
    expect(f.events.some(item => item.event === 'research_handoff_requested' || item.event === 'research_checkpoint_missing_notes')).toBe(false);
    expect(committedSource(f.workers[1].worktree, f.actions[1].assignment.seedCommit, 'RESEARCH.md')).toBe(notes);
    expect(f.check).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['research', 'sketch'] as const)('does not attribute inherited %s notes merely because an earlier slice timed out', async kind => {
    const inherited = 'An earlier responsibility investigated a different boundary condition.\n';
    const f = fixture({ notes: inherited, turns: 2, kind }), completion = f.run();
    await f.reachSlice(completion); await vi.advanceTimersByTimeAsync(10 * 60_000); await f.wait(1);
    expect(f.interrupt).toHaveBeenCalledOnce();
    expect(f.state.cooperation!.researchCheckpoints!.investigate).toMatchObject({ count: 1, paused: false });
    expect(f.actions[1].assignment.assignmentId).toBe(f.actions[0].assignment.assignmentId);
    expect(f.actions[1].assignment.seedCommit).toBe(f.actions[0].assignment.seedCommit);
    expect(fs.readFileSync(f.notesFile, 'utf8')).toBe(inherited);
    expect(f.state.cooperation!.researchDrafts!.investigate.handoffNotesDigest).toBeUndefined();
    await f.reachSlice(completion, 1); f.tool(); await vi.advanceTimersByTimeAsync(0);
    expect(f.interrupt).toHaveBeenCalledOnce();
    expect(f.events.filter(item => item.event === 'research_handoff_requested')).toHaveLength(1);
    const current = 'For this assignment, the checked reduction leaves only the stated estimate unresolved.\n';
    f.tool(current); await expect(completion).resolves.toBeUndefined();
    expect(f.interrupt).toHaveBeenCalledTimes(2);
    expect(f.state.cooperation!.researchDrafts!.investigate.handoffNotesDigest).toBe(mathDigest(current));
    expect(committedSource(f.workers[1].worktree, f.state.cooperation!.researchDrafts!.investigate.commit, 'RESEARCH.md')).toBe(current);
    expect(f.events.filter(item => item.event === 'research_checkpoint_missing_notes')).toHaveLength(1);
    expect(f.check).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
});
