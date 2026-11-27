import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_EXAMPLE_PROOF } from '../src/math/localExample';
import type { MathAgentOptions, MathAgentSession } from '../src/runtime/codexSession';
import { directSolverModules, type SolverModules } from '../src/solver/modules';
import { committedSource, git } from '../src/solver/problem';
import { runResearchLead } from '../src/solver/research';
import { deferred } from './helpers/async';
import { workerAccess } from './helpers/solver';
import { captureLeanCompletion } from './helpers/leanCompletion';
import { leadWorker, localExample, solverState } from './helpers/solver';
import { failedBatch, receiptBatch } from './helpers/verifier';

const host = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock('../src/math/mathBuildManifest', () => ({ readMathBuildManifest: vi.fn() }));
vi.mock('../src/math/verifier', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/verifier')>(),
  checkManyFormalVerifications: host.verify, formalVerificationToolIdentity: () => undefined,
  resolveMathematicsLakePackagesCache: () => undefined,
}));

type StopReceipt = Awaited<ReturnType<NonNullable<MathAgentSession['stopForFreeze']>>>;

describe('single solver early proof submission', () => {
  const fixtures: ReturnType<typeof fixture>[] = [];
  const verified = (request: Parameters<typeof receiptBatch>[0]) => receiptBatch(request, {
    sessionId: 'single-handoff-host', receiptId: (_, name) => request.targetCommit + '-' + name,
  });
  beforeEach(() => { host.verify.mockReset().mockImplementation(async request => verified(request)); });
  afterEach(async () => {
    for (const current of fixtures.splice(0)) {
      current.controller.abort(); current.stopped.resolve({ status: 'stopped' });
      current.sessions.forEach(session => session.done.resolve('interrupted'));
      await Promise.allSettled([current.completion]);
      fs.rmSync(current.directory, { recursive: true, force: true });
    }
  });

  function fixture(stop: 'confirmed' | 'missing' | 'unconfirmed' | 'throw' = 'confirmed') {
    const { directory, workspace, problem } = localExample('solver-single-handoff-');
    const workers = [leadWorker(problem, workspace)];
    const state = solverState(problem, workspace, { runId: 'single-handoff', phase: 'prepared' });
    const controller = new AbortController(), stopped = deferred<StopReceipt>(), stopping = deferred();
    const sessions: { options: MathAgentOptions; done: ReturnType<typeof deferred<string>> }[] = [];
    const events: string[] = [], waiters = new Map<string, ReturnType<typeof deferred>>();
    const open = vi.fn(async (options: MathAgentOptions): Promise<MathAgentSession> => {
      const done = deferred<string>(), index = sessions.push({ options, done });
      return { threadId: options.threadId ?? 'single-handoff-thread',
        run: async (_message, _id, _workspace, onStarted) => {
          onStarted('single-turn-' + index); waiters.get('started-' + index)?.resolve();
          return done.promise;
        },
        interrupt: async () => { done.resolve('submitted'); },
        close: async () => { done.resolve('interrupted'); },
        ...(stop === 'missing' ? {} : { stopForFreeze: async () => {
          stopping.resolve();
          if (stop === 'throw') throw new Error('fixture_shutdown_failed');
          if (stop === 'unconfirmed') return { status: 'unconfirmed' as const, reason: 'process-group-active' as const };
          return stopped.promise;
        } }),
      };
    });
    const modules: SolverModules = { ...directSolverModules, M1: { ...directSolverModules.M1, open },
      M4: { ...directSolverModules.M4, build: () => ({ instructions: 'Offline single solver fixture.',
        message: 'Prove all original targets.', scope: 'original-problem-and-allowed-library',
        sources: { problemReceiptDigest: problem.receiptDigest } }) },
    };
    const completion = runResearchLead({ state, access: workerAccess(workers, directory).get('solver')!, modules,
      root: directory, buildFile: path.join(directory, 'unused-build.json'), taskText: 'Prove all original targets.',
      executable: 'offline-no-model', profile: 'offline-no-credentials', signal: controller.signal,
      deadline: Infinity, maxTurns: Infinity, maxTurnMs: Infinity, maxTotalTokens: 0,
      save: () => {}, emit: event => { events.push(event); waiters.get(event)?.resolve(); },
    });
    void completion.catch(() => {});
    const wait = (promise: Promise<unknown>) => Promise.race([promise, completion.then(() => {
      throw new Error('fixture_finished_before_expected_event');
    })]);
    const waitEvent = (event: string) => {
      if (events.includes(event)) return Promise.resolve();
      const pending = waiters.get(event) ?? deferred(); waiters.set(event, pending);
      return wait(pending.promise);
    };
    const started = async (index = 1) => {
      if (sessions.length < index) {
        const pending = deferred(); waiters.set('started-' + index, pending); await wait(pending.promise);
      }
    };
    const project = path.join(workspace, problem.projectRelative);
    const source = path.join(project, 'Submission.lean');
    const submit = (index = 0) => {
      const session = sessions[index];
      session.options.completedOutput!.validate(captureLeanCompletion(project));
      session.done.resolve('submitted');
    };
    const current = { directory, workspace, problem, state, controller, stopped, stopping, sessions, open, events,
      completion, wait, waitEvent, started, project, source, submit };
    fixtures.push(current); return current;
  }

  it('hands off before a natural final, confirms writer shutdown and independently checks every target', async () => {
    const current = fixture(); await current.started();
    const before = git(current.workspace, ['rev-parse', 'HEAD']);
    fs.writeFileSync(current.source, LOCAL_EXAMPLE_PROOF);
    current.submit(); await current.wait(current.stopping.promise);
    expect(host.verify).not.toHaveBeenCalled();
    expect(git(current.workspace, ['rev-parse', 'HEAD'])).toBe(before);
    expect(current.events).toContain('proof_ready_checkpoint_requested');
    // A tool already in flight may finish after readiness. Verify the bytes frozen after
    // writer shutdown, rather than trusting the earlier diagnostic or its source hash.
    const settledSource = LOCAL_EXAMPLE_PROOF + '\n-- final in-flight tool completed\n';
    fs.writeFileSync(current.source, settledSource);
    current.stopped.resolve({ status: 'stopped' });
    const result = await current.completion;
    expect(result?.check.passed).toBe(true);
    const request = host.verify.mock.calls[0][0];
    expect(request.items.map((item: { theoremName: string }) => item.theoremName))
      .toEqual(current.problem.targets.map(target => target.theoremName));
    expect(committedSource(current.workspace, result!.check.commit, current.problem.projectRelative + '/Submission.lean'))
      .toBe(settledSource);
    expect(current.open).toHaveBeenCalledOnce();
    expect(current.state.tokenBudget).toMatchObject({ status: 'unlimited', maxTotalTokens: 0 });
    expect(current.sessions[0].options.turnTimeoutMs).toBeUndefined();
  });

  it.each(['missing', 'unconfirmed', 'throw'] as const)('never freezes or verifies when writer stop is %s', async stop => {
    const current = fixture(stop); await current.started();
    const before = git(current.workspace, ['rev-parse', 'HEAD']);
    fs.writeFileSync(current.source, LOCAL_EXAMPLE_PROOF); current.submit();
    await expect(current.completion).rejects.toThrow('math_writer_stop_unconfirmed');
    expect(host.verify).not.toHaveBeenCalled();
    expect(git(current.workspace, ['rev-parse', 'HEAD'])).toBe(before);
    expect(current.state.writerStopUnconfirmed).toMatchObject({ reason: expect.any(String) });
    expect(current.open).toHaveBeenCalledOnce();
  });

  it('repairs a host-rejected candidate instead of accepting local diagnostic metadata', async () => {
    host.verify.mockImplementationOnce(async request => failedBatch(verified(request), {
      stdoutPreview: () => 'error: deterministic offline proof failure',
    }));
    const current = fixture(); await current.started();
    fs.writeFileSync(current.source, LOCAL_EXAMPLE_PROOF); current.submit();
    current.stopped.resolve({ status: 'stopped' });
    await current.started(2);
    expect(current.state.check?.passed).toBe(false);
    expect(current.events).not.toContain('candidate_selected');
    expect(() => current.sessions[1].options.completedOutput!.validate(captureLeanCompletion(current.project)))
      .toThrow('math_single_solver_submission_already_checked');
    fs.appendFileSync(current.source, '\n-- repaired after independent host feedback\n'); current.submit(1);
    expect((await current.completion)?.check.passed).toBe(true);
    expect(host.verify).toHaveBeenCalledTimes(2);
    expect(current.open).toHaveBeenCalledTimes(2);
  });
});
