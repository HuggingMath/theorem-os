import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { readMathAgentSkill } from '../src/runtime/agentSkills';
import type { MathAgentOptions, MathAgentSession } from '../src/runtime/agentSession';
import type { NativeAgentControlConnection } from '../src/runtime/nativeAgentControl';
import { AgentResearchTeam } from '../src/solver/agentTeam';
import { writeSolverRunState } from '../src/solver/archive';
import { directSolverModules } from '../src/solver/modules';
import { readSolverProblem } from '../src/solver/problem';
import { prepareResearchSkill, researchSkillIdentity } from '../src/solver/researchSkill';
import { deferred } from './helpers/async';
import { temporaryDirectory } from './helpers/files';
import { solverState } from './helpers/solver';

vi.mock('../src/math/mathBuildManifest', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/mathBuildManifest')>(), readMathBuildManifest: vi.fn(),
}));

type Json = Record<string, any>;
const fixtures: ReturnType<typeof fixture>[] = [];
const ROOT = '00000000-0000-4000-8000-000000000001';

/** Only model execution is controlled; task state, worktree isolation, source freezing and Lean checks are real. */
function fixture({ earlyCompletion = false, beforeOpen }: { earlyCompletion?: boolean; beforeOpen?: () => Promise<void> } = {}) {
  const directory = temporaryDirectory('native-team-lifecycle-'), root = path.resolve('.');
  const receipt = bootstrapLeanTask(path.join(directory, 'primary'), {
    task: 'Prove the frozen statement.', source: 'namespace NativeTeam\ntheorem original : True := by sorry\nend NativeTeam\n',
  });
  const problem = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath);
  const identity = researchSkillIdentity(readMathAgentSkill(path.join(root, 'skills/theoremos-research/SKILL.md')));
  const state = solverState(problem, receipt.workspaceRoot, { runId: 'native-team-lifecycle', phase: 'running',
    environmentDigest: mathDigest('Lean standard environment'), model: 'unused', effort: 'high',
    researchMode: 'skill', researchSkillWorkflow: 'full', researchSkill: identity,
    researchDelegation: { mode: 'team', maxAgents: 3 }, workerCount: 1, coordination: 'independent',
    agentTeam: { schema: 'theorem-os.agent-team.v1', transport: 'native-agent-control',
      workers: [], events: [], deliveries: [], adoptions: [], operations: [] },
    requestUsageAccounting: { startedRequests: 0, reportedRequests: 0, pendingRequests: 0, incomplete: false },
  });
  const skill = prepareResearchSkill(root, state.worktree, identity, problem);
  const toolchain = path.join(os.homedir(), '.elan/toolchains/leanprover--lean4---v4.33.0');
  const environment = { PATH: `${toolchain}/bin:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    ELAN_HOME: path.join(os.homedir(), '.elan'), LEAN_PATH: '', LEAN_SYSROOT: '',
    DEEPSCIENTIST_MATH_SANDBOX_BACKEND: 'bwrap', DEEPSCIENTIST_MATH_ENV_FILE: path.join(directory, 'missing.env') };
  const controller = new AbortController();
  const sessions: { session: MathAgentSession; options: MathAgentOptions; started: ReturnType<typeof deferred>;
    outcome: ReturnType<typeof deferred<string>>; stopGate: ReturnType<typeof deferred>;
    native: (operation: string, payload: Json) => Promise<Json>; complete: (stop?: boolean) => Promise<void>;
    inputs: Json[]; turnId: string; message?: string; id: string }[] = [];
  const modules = { ...directSolverModules, M1: { ...directSolverModules.M1, open: async (options: MathAgentOptions) => {
    await beforeOpen?.();
    const config = options.nativeAgentControl!;
    const threadId = options.threadId ?? String(config.bootstrap!.threadId);
    const id = options.environment!.DEEPSCIENTIST_MATH_WORKER_ID!, turnId = crypto.randomUUID();
    const agentPath = '/root/' + id;
    const info = { sessionId: ROOT, agent: { threadId, metadata: { agentId: threadId, agentPath }, status: 'pending_init' },
      configSnapshot: { cwd: options.workspace } };
    const inputs: Json[] = [];
    const connection: NativeAgentControlConnection = { info, request: vi.fn(async () => ({})),
      update: vi.fn(async value => ({ acceptedSequence: value.sequence })), input: vi.fn(async value => {
        inputs.push(value); return { accepted: true, threadId, submissionId: turnId, turn: { id: turnId } };
      }) };
    const native = async (operation: string, payload: Json) => config.request({ version: 1, sessionId: ROOT,
      threadId, operationId: crypto.randomUUID(), operation, payload }, connection, { signal: new AbortController().signal });
    await native('attach', { threadId, sessionId: ROOT });
    await config.bound?.(connection);
    const started = deferred(), outcome = deferred<string>(), stopGate = deferred();
    let settled = false, didRun = false;
    const abort = () => { outcome.resolve('interrupted'); stopGate.resolve(); };
    options.signal?.addEventListener('abort', abort, { once: true });
    const session: MathAgentSession = { threadId, nativeAgentControl: connection, usageSource: 'upstream-requests',
      get lastCompletedResponse() { return settled ? { turnId, text: 'Saved an advisory research result.' } : undefined; },
      run: async (message, _messageId, _workspace, onStarted) => {
        didRun = true;
        current.message = message;
        await native('admitTurn', { threadId, turnId });
        if (earlyCompletion) {
          await native('turnFinished', { outcome: { threadId, turnId, status: { completed: 'Finished before input receipt.' } } });
          outcome.resolve('completed'); stopGate.resolve();
        }
        onStarted(turnId); started.resolve();
        try { return await outcome.promise; } finally { settled = true; }
      },
      interrupt: async () => { abort(); },
      stopForFreeze: async () => {
        if (!didRun) return { status: 'stopped' };
        await stopGate.promise; return settled ? { status: 'stopped' } : { status: 'unconfirmed', reason: 'turn-not-settled' };
      },
      close: async () => { options.signal?.removeEventListener('abort', abort); await config.disconnected?.(connection); },
    };
    const current = { session, options, started, outcome, stopGate, inputs, turnId, native, id, message: undefined as string | undefined,
      complete: async (stop = true) => {
        await native('turnFinished', { outcome: { threadId, turnId, status: { completed: 'Advisory result.' } } });
        outcome.resolve('completed'); if (stop) stopGate.resolve();
      } };
    sessions.push(current); return session;
  } } };
  const team = new AgentResearchTeam({ state, root, taskText: 'Prove the frozen statement.',
    leadAccess: { environment, retrievalRoot: path.join(state.worktree, problem.projectRelative), researchSkill: skill },
    modules, executable: 'offline-fixture', profile: 'offline-fixture', signal: controller.signal,
    maxAgents: 3, maxTurns: Infinity, maxTurnMs: Infinity, maxTotalTokens: 0, remainingMs: () => Infinity,
    save: () => writeSolverRunState(path.join(directory, 'state.json'), state), emit: () => {}, exclusiveCheck: operation => operation(),
  });
  const rootOptions = team.nativeAgentControlOptions()!;
  const rootConnection: NativeAgentControlConnection = { info: { sessionId: ROOT,
    agent: { threadId: ROOT, metadata: { agentId: ROOT, agentPath: '/root' }, status: 'running' }, configSnapshot: { cwd: state.worktree } },
    request: vi.fn(async () => ({})), update: vi.fn(async value => ({ acceptedSequence: value.sequence })), input: vi.fn(async () => ({})) };
  const native = (operation: string, payload: Json, operationId = crypto.randomUUID(), signal = new AbortController().signal) => rootOptions.request({ version: 1,
    sessionId: ROOT, threadId: ROOT, operation, operationId, payload }, rootConnection, { signal });
  let toolCalls = 0;
  const tool = (operation: Json, actor = 'lead', channel = team) => channel.tools(actor).call('theoremos_team', operation, {
    threadId: actor === 'lead' ? ROOT : state.agentTeam!.workers.find(worker => worker.id === actor)!.native!.threadId,
    turnId: actor === 'lead' ? 'root-turn' : sessions.findLast(item => item.id === actor)!.turnId,
    callId: 'tool-' + ++toolCalls, signal: controller.signal,
  }) as Promise<Json>;
  const spawn = async (name: string, message = 'Profiles: D006, prover\nInvestigate a complementary helper.', signal?: AbortSignal,
    messageKind: 'plaintext' | 'encrypted' = 'plaintext') => {
    await native('attach', { threadId: ROOT, sessionId: ROOT });
    const source = { subagent: { thread_spawn: { parent_thread_id: ROOT, agent_path: '/root/' + name, depth: 1 } } };
    return native('spawn', { caller: ROOT, source,
      bootstrap: { version: 1, sessionId: ROOT, threadId: null, source, config: { cwd: state.worktree } },
      input: { kind: 'message', mode: 'triggerTurn', message: { kind: messageKind, text: message } }, startOptions: { parentTurnId: 'root-turn' } }, crypto.randomUUID(), signal);
  };
  const f = { directory, state, team, sessions, controller, native, tool, spawn,
    source: (worktree: string) => path.join(worktree, problem.projectRelative, 'Submission.lean') };
  fixtures.push(f); return f;
}

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.controller.abort();
    for (const session of f.sessions) { session.outcome.resolve('interrupted'); session.stopGate.resolve(); }
    await f.team.close(); fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

describe('native AgentControl preserves the mathematical team lifecycle', () => {
  it('accepts the upstream Direct encrypted message shape for spawn and new-task followup without changing codec or attribution', async () => {
    const f = fixture(), message = 'Profiles: D006, prover\nNATIVE_WORKER_TEST Read the fixed skill and inspect the fixture.';
    await f.spawn('analyst', message, undefined, 'encrypted');
    const worker = f.state.agentTeam!.workers[0];
    expect(worker.tasks[0].message).toBe(message);
    expect(worker.tasks[0].profileEvidence?.loaded).toEqual(expect.arrayContaining(['D006', 'prover']));
    expect(f.sessions[0].options.nativeAgentControl!.initialInput).toMatchObject({ author: '/root',
      input: { kind: 'message', mode: 'triggerTurn', message: { kind: 'encrypted', text: message } },
      startOptions: { parentTurnId: 'root-turn' } });
    await f.sessions[0].complete();
    await expect.poll(() => f.team.hasActiveWorkers).toBe(false);
    const followup = 'Profiles: engineer\nNATIVE_FOLLOWUP_TEST Inspect the next interface.';
    const input = { kind: 'message', mode: 'triggerTurn', message: { kind: 'encrypted', text: followup } };
    await f.native('send', { caller: ROOT, target: { kind: 'id', threadId: worker.native!.threadId }, input,
      startOptions: { parentTurnId: 'root-followup-turn', initiatingAgentPath: '/root' } });
    expect(worker.tasks).toHaveLength(2); expect(worker.tasks[1].message).toBe(followup);
    expect(f.sessions[1].options.nativeAgentControl!.initialInput).toEqual({ author: '/root', input,
      startOptions: { parentTurnId: 'root-followup-turn', initiatingAgentPath: '/root' } });
  });

  it('reaps an unaccepted spawn and does not relaunch it from a queued task after cancellation', async () => {
    const opening = deferred(), f = fixture({ beforeOpen: () => opening.promise }), caller = new AbortController();
    const spawn = f.spawn('analyst', undefined, caller.signal);
    void spawn.catch(() => {});
    await expect.poll(() => f.state.agentTeam!.workers.length).toBe(1);
    caller.abort(new Error('parent-cancelled-before-acceptance')); opening.resolve();
    await expect(spawn).rejects.toThrow();
    await expect.poll(() => f.team.hasActiveWorkers).toBe(false);
    const worker = f.state.agentTeam!.workers[0];
    expect(worker.status).toBe('stopped'); expect(worker.native!.submissionId).toBeUndefined();
    expect(worker.tasks[0].status).toBe('cancelled'); expect(worker.writerStopUnconfirmed).toBeUndefined();
  });

  it('keeps a child accepted by the host when its initiating request is subsequently cancelled', async () => {
    const f = fixture(), caller = new AbortController();
    await f.spawn('analyst', undefined, caller.signal);
    caller.abort(new Error('parent-cancelled-after-acceptance'));
    const worker = f.state.agentTeam!.workers[0];
    expect(worker.status).toBe('running'); expect(worker.tasks[0].cancelRequested).toBeUndefined();
    expect(worker.native!.submissionId).toBe(f.sessions[0].turnId);
    expect(f.team.hasActiveWorkers).toBe(true);
  });

  it('preserves an exact terminal result arriving before the spawn/input acceptance callback', async () => {
    const f = fixture({ earlyCompletion: true });
    const receipt = await f.spawn('analyst');
    expect((receipt.result as Json).agent.status).toEqual({ completed: 'Finished before input receipt.' });
    const native = f.state.agentTeam!.workers[0].native!;
    expect(native.lastOutcome).toEqual({ turnId: f.sessions[0].turnId, status: { completed: 'Finished before input receipt.' } });
    expect(native.status).toEqual({ completed: 'Finished before input receipt.' });
    await expect.poll(() => f.team.hasActiveWorkers).toBe(false);
    expect(f.state.agentTeam!.deliveries).toEqual([]);
  });

  it('starts distinct isolated native writers, loads expertise and steers a busy member without a new task', async () => {
    const f = fixture();
    const first = await f.spawn('analyst'), second = await f.spawn('engineer', 'Profiles: engineer\nCheck the local source interface.');
    const workers = f.state.agentTeam!.workers;
    expect((first.result as Json).agent.threadId).not.toBe((second.result as Json).agent.threadId);
    expect(workers[0].worktree).not.toBe(workers[1].worktree);
    expect(f.sessions[0].options).toMatchObject({ isolateProcess: true, workspace: workers[0].worktree,
      nativeAgentControl: { bootstrap: { threadId: workers[0].native!.threadId,
        hostOverrides: { cwd: workers[0].worktree, workspaceRelocation: { from: f.state.worktree, to: workers[0].worktree } } } } });
    expect(f.sessions[0].message).toContain('Current team assignment');
    expect(workers[0].tasks[0].profileEvidence?.loaded).toEqual(expect.arrayContaining(['D006', 'prover']));
    await f.native('send', { caller: ROOT, target: { kind: 'id', threadId: workers[0].native!.threadId },
      input: { kind: 'message', mode: 'triggerTurn', message: { kind: 'plaintext', text: 'Consider this advisory observation.' } }, startOptions: {} });
    expect(f.sessions).toHaveLength(2); expect(workers[0].tasks).toHaveLength(1);
    expect(workers[0].tasks[0].objectiveRevision).toBe(1);
    expect(f.sessions[0].inputs).toMatchObject([{ author: '/root', threadId: workers[0].native!.threadId }]);
    expect(await f.tool({ operation: 'spawn', agentId: 'shadow', message: 'Attempt an obsolete transport.' })).toMatchObject({ ok: false });
  });

  it('resumes a yielded draft in the same task and revision through attributed native followup', async () => {
    const f = fixture(); await f.spawn('analyst');
    const worker = f.state.agentTeam!.workers[0], task = worker.tasks[0], first = f.sessions[0];
    fs.writeFileSync(path.join(worker.worktree, 'RESEARCH.md'), 'A saved dependency question.\n');
    expect(await f.tool({ operation: 'yield', reason: 'Need a checked dependency.' }, worker.id)).toMatchObject({ status: 'pending-writer-stop' });
    await first.complete();
    await expect.poll(() => f.team.hasActiveWorkers).toBe(false);
    expect(task.status).toBe('paused');
    await f.native('send', { caller: ROOT, target: { kind: 'id', threadId: worker.native!.threadId },
      input: { kind: 'message', mode: 'triggerTurn', message: { kind: 'plaintext', text: 'The dependency is now available; continue.' } },
      startOptions: { parentTurnId: 'root-turn-2' } });
    expect(worker.tasks).toHaveLength(1); expect(worker.tasks[0]).toBe(task); expect(task.objectiveRevision).toBe(1);
    expect(f.sessions).toHaveLength(2); expect(f.sessions[1].session.threadId).toBe(first.session.threadId);
    expect(f.sessions[1].options.nativeAgentControl!.initialInput).toMatchObject({ author: '/root',
      input: { message: { text: 'The dependency is now available; continue.' } } });
    expect(fs.readFileSync(path.join(worker.worktree, 'RESEARCH.md'), 'utf8')).toContain('saved dependency');
  });

  it('returns the pre-interruption observation and retains the member, task and draft for continuation', async () => {
    const f = fixture(); await f.spawn('analyst');
    const worker = f.state.agentTeam!.workers[0], task = worker.tasks[0];
    fs.writeFileSync(path.join(worker.worktree, 'RESEARCH.md'), 'Retain this partial argument.\n');
    const snapshot = await f.native('interrupt', { caller: ROOT, target: { kind: 'id', threadId: worker.native!.threadId }, version: 'v2' });
    expect(snapshot.result).toMatchObject({ kind: 'loaded', agent: { status: 'running' } });
    await expect.poll(() => f.team.hasActiveWorkers).toBe(false);
    expect(worker.status).toBe('interrupted'); expect(task.status).toBe('interrupted');
    await f.native('send', { caller: ROOT, target: { kind: 'id', threadId: worker.native!.threadId },
      input: { kind: 'message', mode: 'triggerTurn', message: { kind: 'plaintext', text: 'Continue the saved task.' } }, startOptions: {} });
    expect(worker.tasks).toHaveLength(1); expect(worker.tasks[0]).toBe(task);
    expect(f.sessions[1].session.threadId).toBe(f.sessions[0].session.threadId);
    expect(fs.readFileSync(path.join(worker.worktree, 'RESEARCH.md'), 'utf8')).toContain('partial argument');
    // Native admission cannot create a second model turn beside the dispatched writer.
    await expect(f.sessions[1].native('admitTurn', { threadId: worker.native!.threadId, turnId: 'unexpected-second-turn' }))
      .rejects.toThrow('native_turn_not_dispatched');
  });

  it('does not publish completed native research as proof and waits for writer shutdown before checking a nomination', async () => {
    const f = fixture(); await f.spawn('analyst');
    const worker = f.state.agentTeam!.workers[0];
    await f.sessions[0].complete();
    await expect.poll(() => f.team.hasActiveWorkers).toBe(false);
    expect(f.state.agentTeam!.deliveries).toHaveLength(0); expect(worker.tasks[0].researchArtifactId).toBeTruthy();
    await f.native('send', { caller: ROOT, target: { kind: 'id', threadId: worker.native!.threadId },
      input: { kind: 'message', mode: 'triggerTurn', message: { kind: 'plaintext', text: 'Profiles: prover\nSave and submit the helper.' } }, startOptions: {} });
    expect(worker.tasks).toHaveLength(2);
    const draft = fs.readFileSync(f.source(worker.worktree), 'utf8').replace('end NativeTeam',
      'theorem reusable (n : Nat) : n = n := by rfl\nend NativeTeam');
    fs.writeFileSync(f.source(worker.worktree), draft);
    expect(await f.tool({ operation: 'submit', objectiveRevision: 1, summary: 'A useful helper.',
      declarations: [{ file: 'Submission.lean', name: 'NativeTeam.reusable', type: '∀ n : Nat, n = n' }] }, worker.id))
      .toMatchObject({ status: 'pending-writer-stop' });
    const second = f.sessions[1]; await second.complete(false);
    expect(f.state.agentTeam!.deliveries).toHaveLength(0);
    second.stopGate.resolve();
    await expect.poll(() => f.team.hasActiveWorkers, { timeout: 60_000 }).toBe(false);
    expect(worker.writerStopUnconfirmed).toBeUndefined();
    expect(f.state.agentTeam!.deliveries).toHaveLength(1);
    expect(worker.tasks[1].deliveryId).toBe(f.state.agentTeam!.deliveries[0].id);
    expect(f.state.phase).toBe('running');
  }, 70_000);
});
