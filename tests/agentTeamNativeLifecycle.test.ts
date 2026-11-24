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
import { readAgentTeamProofDelivery } from '../src/solver/agentTeamProof';
import { agentTeamOverview } from '../src/solver/agentTeamViews';
import { readSolverRunState, writeSolverRunState } from '../src/solver/archive';
import { directSolverModules } from '../src/solver/modules';
import { readSolverProblem } from '../src/solver/problem';
import { personalExpertCardsDigest } from '../src/solver/personalExperts';
import { prepareResearchSkill, researchSkillIdentity } from '../src/solver/researchSkill';
import { deferred } from './helpers/async';
import { temporaryDirectory } from './helpers/files';
import { solverState } from './helpers/solver';
import { createWebWorkerBridge } from '../apps/web/workerBridge';

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
      nativeConfiguration: { source: 'thread-start-overrides', overrides: { includeSkillInstructions: false,
        deferMailboxPreemption: true, rootAgentUsageHintText: '', subagentUsageHintText: '' } },
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
    messageKind: 'plaintext' | 'encrypted' = 'plaintext', initialHistory?: unknown) => {
    await native('attach', { threadId: ROOT, sessionId: ROOT });
    const source = { subagent: { thread_spawn: { parent_thread_id: ROOT, agent_path: '/root/' + name, depth: 1 } } };
    return native('spawn', { caller: ROOT, source,
      bootstrap: { version: 1, sessionId: ROOT, threadId: null, source, config: { cwd: state.worktree },
        ...(initialHistory === undefined ? {} : { initialHistory }) },
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
  it('projects native activity, finding-based dispatch, and stable checked delivery and adoption evidence', async () => {
    const f = fixture(), output = path.join(f.directory, 'view.json');
    const stateFile = output + '.runtime/state.json';
    fs.mkdirSync(path.dirname(stateFile));
    const bridge = createWebWorkerBridge({ webRunId: 'web-native-team', output, directory: f.directory });
    const capture = async () => {
      writeSolverRunState(stateFile, f.state);
      return (await bridge.capture()).observation;
    };
    expect((await capture()).inspection.nativeTeam).toMatchObject({ memberCount: 0, tasks: [], findings: [] });
    await f.spawn('producer', 'Prove the helper.');
    const [producer] = f.state.agentTeam!.workers;
    const producerTask = producer!.tasks[0]!, session = f.sessions[0]!;
    expect((await capture()).inspection.nativeTeam?.tasks).toMatchObject([{ id: producerTask.id, status: 'running' }]);
    const sent = await session.native('send', { caller: producer!.native!.threadId, target: { kind: 'id', threadId: ROOT },
      input: { kind: 'message', mode: 'queueOnly', message: { kind: 'plaintext', text: 'Use the candidate hypothesis True.' } } });
    const ref = 'message:' + sent.result.submissionId;
    const received = (await capture()).inspection.nativeTeam!;
    expect(received.findings).toContainEqual(expect.objectContaining({ ref, from: 'producer', to: 'lead', status: 'accepted' }));
    expect(received.tasks[0]!.reassignment).toBeUndefined();
    await f.spawn('consumer', 'Profiles: engineer\nBased on: ' + ref + '\nTest the consumer with the proposed input.');
    const [ , consumer] = f.state.agentTeam!.workers;
    const consumerTask = consumer!.tasks[0]!, originalThread = consumer!.native!.threadId;
    expect((await capture()).inspection.nativeTeam?.tasks.find(task => task.id === consumerTask.id)?.reassignment)
      .toEqual({ ref, revision: 1 });
    const source = fs.readFileSync(f.source(producer!.worktree), 'utf8').replace('theorem original',
      'theorem helper : True := by trivial\ntheorem original');
    fs.writeFileSync(f.source(producer!.worktree), source);
    await f.tool({ operation: 'submit', summary: 'The helper is ready.', declarations: [
      { file: 'Submission.lean', name: 'NativeTeam.helper', type: 'True' }] }, 'producer');
    expect((await capture()).inspection.nativeTeam?.tasks.find(task => task.id === producerTask.id)?.status).toBe('stopping');
    await session.complete();
    await expect.poll(() => f.state.agentTeam!.deliveries.length, { timeout: 30_000 }).toBe(1);
    const first = await capture(), delivered = first.inspection.nativeTeam!.deliveries[0]!;
    expect(delivered).toMatchObject({ taskId: producerTask.id, proof: { sources: [{ file: 'Submission.lean', source }],
      declarations: [{ name: 'NativeTeam.helper', receipts: [{ status: 'kernel_verified' }] }] } });
    const draft = 'theorem downstream : True := by exact helper\n';
    fs.writeFileSync(f.source(consumer!.worktree), fs.readFileSync(f.source(consumer!.worktree), 'utf8')
      .replace('end NativeTeam', draft + 'end NativeTeam'));
    expect(await f.tool({ operation: 'yield', reason: 'Waiting for helper.' }, 'consumer')).toMatchObject({ ok: true });
    await f.sessions.find(item => item.id === 'consumer')!.complete();
    await expect.poll(() => f.team.hasActiveWorkers, { timeout: 30_000 }).toBe(false);
    expect(consumerTask.status).toBe('paused');
    expect(await f.tool({ operation: 'adopt', deliveryId: delivered.id, targetId: 'consumer' })).toMatchObject({ ok: true });
    const adoption = f.state.agentTeam!.adoptions.at(-1)!;
    await expect.poll(() => ['completed', 'failed'].includes(adoption.status), { timeout: 30_000 }).toBe(true);
    expect(adoption.status, adoption.error).toBe('completed');
    const latest = await capture();
    expect(latest.sequence).toBeGreaterThan(first.sequence);
    expect(latest.inspection.nativeTeam!.deliveries[0]).toEqual(delivered);
    expect(latest.inspection.nativeTeam!.adoptions[0]).toMatchObject({ targetId: 'consumer', deliveryId: delivered.id,
      status: 'completed', receiptId: expect.any(String), proof: { sources: [{ source: expect.stringContaining(draft) }] } });
    // The same delivery and commit do not prove adoption in another member's worktree.
    adoption.targetId = 'producer';
    const otherMember = (await capture()).inspection.nativeTeam!.adoptions[0]!;
    expect(otherMember.proof).toBeUndefined();
    expect(otherMember.receiptId).toBeUndefined();
    adoption.targetId = 'consumer';
    // Older completed records use the same finalized receipt, found via the persisted checked intent.
    f.state.agentTeam!.adoptions[0]!.receiptId = undefined;
    expect((await capture()).inspection.nativeTeam!.adoptions[0]).toEqual(latest.inspection.nativeTeam!.adoptions[0]);

    await f.native('send', { caller: ROOT, target: { kind: 'id', threadId: originalThread },
      input: { kind: 'message', mode: 'triggerTurn', message: { kind: 'plaintext', text: 'Continue with the checked helper.' } }, startOptions: {} });
    expect(consumer!.native!.threadId).toBe(originalThread);
    expect(consumer!.tasks.map(task => task.id)).toEqual([consumerTask.id]);
    const resumed = fs.readFileSync(f.source(consumer!.worktree), 'utf8');
    expect(resumed).toContain(draft);
    expect(resumed).toContain('theorem helper : True := by trivial');
  }, 90_000);

  it.each([
    ['fresh', 'New'], ['unknown', undefined], ['unknown', { Resumed: {} }],
  ])('does not infer parent inspection for %s child history (%j)', async (expected, initialHistory) => {
    const f = fixture(), parent = f.team.archive.leadExposures = [
      { deliveryId: 'a'.repeat(64), taskId: 'draft', agentId: 'author', commit: f.state.problem.baseCommit, kind: 'inspected', at: '2026-01-01' },
      { deliveryId: 'b'.repeat(64), taskId: 'merged', agentId: 'author', commit: f.state.problem.baseCommit, kind: 'adopted', at: '2026-01-02' },
    ];
    await f.spawn('reviewer', 'Review this claim.', undefined, 'plaintext', initialHistory);
    const worker = f.team.archive.workers[0]!;
    expect(worker.exposures).toEqual([parent[1]]); expect(worker.native!.spawnHistory).toBe(expected);
    const saved = readSolverRunState(path.join(f.directory, 'state.json'));
    // Old records have no frozen exposure snapshot; never reconstruct it from later Lead activity.
    delete saved.agentTeam!.workers[0]!.native!.spawnHistory;
    expect(agentTeamOverview(saved).workers[0]?.nativeIdentity?.spawnHistory).toBe('unknown');
  });
  it.each([
    ['Profiles: lead', /math_team_profile_reserved/],
    ['Profiles: , ', /math_team_profile_unresolved: empty Profiles: header/],
    ['Profiles: asset:unselected', /math_team_profile_unresolved: .*asset:unselected/],
    ['Profiles: prover (Lean prover, Mathlib).', /math_team_profile_unresolved: .*Lean prover.*Mathlib.*Profiles: prover.*body/],
  ])('rejects %s before reserving a place or steering a member', async (header, feedback) => {
    const f = fixture(), bad = header + '\nInvestigate the interface.';
    await expect(f.spawn('analyst', bad)).rejects.toThrow(feedback);
    expect(f.state.agentTeam!.workers).toHaveLength(0);
    expect(f.sessions).toHaveLength(0);
    await f.spawn('analyst', 'Profiles: prover\nUse your Mathlib expertise to check the interface.');
    const worker = f.state.agentTeam!.workers[0], task = worker.tasks[0];
    await expect(f.native('send', { caller: ROOT, target: { kind: 'id', threadId: worker.native!.threadId },
      input: { kind: 'message', mode: 'triggerTurn', message: { kind: 'plaintext', text: bad } }, startOptions: {} }))
      .rejects.toThrow(feedback);
    expect(task.objectiveRevision).toBe(1);
    expect(task.profileEvidence?.loaded).toEqual(['prover']);
    expect(f.sessions[0].inputs).toHaveLength(0);
  });

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
    expect(f.sessions[0].message).toContain('Investigate a complementary helper.');
    expect(workers[0].native!.runtimeConfiguration).toEqual(f.sessions[0].session.nativeConfiguration);
    expect(workers[0].tasks[0].profileEvidence?.loaded).toEqual(expect.arrayContaining(['D006', 'prover']));
    await f.native('send', { caller: ROOT, target: { kind: 'id', threadId: workers[0].native!.threadId },
      input: { kind: 'message', mode: 'triggerTurn', message: { kind: 'plaintext', text: 'Consider this advisory observation.' } }, startOptions: {} });
    expect(f.sessions).toHaveLength(2); expect(workers[0].tasks).toHaveLength(1);
    expect(workers[0].tasks[0].objectiveRevision).toBe(2);
    expect(workers[0].tasks[0].message).toContain('Consider this advisory observation.');
    expect(workers[0].tasks[0].profileEvidence?.loaded).toEqual(expect.arrayContaining(['D006', 'prover']));
    expect(workers[0].tasks[0].objectiveHistory?.[0]?.revision).toBe(1);
    expect(f.sessions[0].inputs).toMatchObject([{ author: '/root', threadId: workers[0].native!.threadId }]);
    expect(f.sessions[0].inputs[0]).not.toHaveProperty('contextItems');
    expect(await f.tool({ operation: 'spawn', agentId: 'shadow', message: 'Attempt an obsolete transport.' })).toMatchObject({ ok: false });
  });

  it('delivers the new specialty in the attributed busy input and records it only after acceptance', async () => {
    const f = fixture(); await f.spawn('analyst');
    const worker = f.state.agentTeam!.workers[0], task = worker.tasks[0], session = f.sessions[0];
    const cards = [{ assetId: 'ideal', name: 'User expert on ideals', version: '1', digest: 'b'.repeat(64),
      summary: 'Fractional ideals', knowledge: 'Observe the hypotheses of the chosen factorization law.' }];
    f.state.researchDelegation = { mode: 'team', maxAgents: 3, personalExperts: { cards, digest: personalExpertCardsDigest(cards) } };
    const text = 'Profiles: D012, engineer, asset:ideal\nCheck the ideal factorization interface.';
    const input = { kind: 'message', mode: 'triggerTurn', message: { kind: 'encrypted', text } };
    const startOptions = { initiatingAgentPath: '/root', parentTurnId: 'root-followup' };
    const send = () => f.native('send', { caller: ROOT, target: { kind: 'id', threadId: worker.native!.threadId }, input, startOptions });
    vi.mocked(session.session.nativeAgentControl!.input).mockResolvedValueOnce({ accepted: false });
    await expect(send()).rejects.toThrow('math_team_native_input_not_accepted');
    expect(task.objectiveRevision).toBe(1);
    expect(task.profileEvidence?.loaded).toEqual(['D006', 'prover']);
    await send();
    expect(f.sessions).toHaveLength(1);
    expect(session.inputs[0]).toMatchObject({ author: '/root', input, startOptions, expectedTurnId: session.turnId });
    const passage = session.inputs[0].contextItems[0].content[0].text;
    expect(passage).toContain('The ideal class group measures the obstruction to principality');
    expect(passage).toContain(path.join(path.dirname(session.options.skills![0].path), 'references/domain-materials/number-theory.md'));
    expect(passage).toContain('Profile engineer');
    expect(passage).toContain(cards[0].knowledge);
    expect(task.message).toBe(text);
    expect(task.profileEvidence?.loaded).toEqual(['D012', 'engineer', 'asset:ideal']);
    expect(task.profileEvidence?.sources.find(source => source.kind === 'collected-reading')?.loading).toBe('available-on-demand');
    await send();
    expect(session.inputs[1]).not.toHaveProperty('contextItems');
  });

  it('resumes a yielded draft in the same task with the latest native instruction', async () => {
    const f = fixture(); await f.spawn('analyst');
    const worker = f.state.agentTeam!.workers[0], task = worker.tasks[0], first = f.sessions[0];
    fs.writeFileSync(path.join(worker.worktree, 'RESEARCH.md'), 'A saved dependency question.\n');
    expect(await f.tool({ operation: 'yield', reason: 'Need a checked dependency.' }, worker.id)).toMatchObject({ status: 'pending-writer-stop' });
    await first.complete();
    await expect.poll(() => f.team.hasActiveWorkers).toBe(false);
    expect(task.status).toBe('paused');
    const oldInput = worker.native!.initialInput;
    await expect(f.native('send', { caller: ROOT, target: { kind: 'id', threadId: worker.native!.threadId },
      input: { kind: 'message', mode: 'triggerTurn', message: { kind: 'plaintext', text: 'Profiles: unknown-profile\nContinue the draft.' } },
      startOptions: {} })).rejects.toThrow('math_team_profile_unresolved');
    expect(worker.native!.initialInput).toEqual(oldInput);
    expect(task.status).toBe('paused'); expect(task.objectiveRevision).toBe(1);
    expect(f.sessions).toHaveLength(1);
    await f.native('send', { caller: ROOT, target: { kind: 'id', threadId: worker.native!.threadId },
      input: { kind: 'message', mode: 'triggerTurn', message: { kind: 'plaintext', text: 'The dependency is now available; continue.' } },
      startOptions: { parentTurnId: 'root-turn-2' } });
    expect(worker.tasks).toHaveLength(1); expect(worker.tasks[0]).toBe(task); expect(task.objectiveRevision).toBe(2);
    expect(task.message).toContain('The dependency is now available; continue.');
    expect(task.profileEvidence?.loaded).toEqual(expect.arrayContaining(['D006', 'prover']));
    expect(task.objectiveHistory?.[0]?.message).toContain('Investigate a complementary helper.');
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
    expect(worker.native!.status).toBe('shutdown');
    expect(worker.native!.agent!.status).toBe('shutdown');
    expect(worker.native!.writerStop).toMatchObject({ source: 'writer-stop', turnId: f.sessions[0].turnId });
    expect(worker.native!.lastOutcome).toBeUndefined();
    const saved = readSolverRunState(path.join(f.directory, 'state.json')).agentTeam!.workers[0].native!;
    expect(saved.status).toBe('shutdown'); expect(saved.lastOutcome).toBeUndefined();
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
    await f.native('send', { caller: ROOT, target: { kind: 'id', threadId: worker.native!.threadId },
      input: { kind: 'message', mode: 'triggerTurn', message: { kind: 'plaintext', text: 'Profiles: engineer, prover\nCheck this helper against the owned source interface.' } }, startOptions: {} });
    expect(worker.tasks).toHaveLength(2); expect(worker.tasks[1].objectiveRevision).toBe(2);
    expect(worker.tasks[1].profileEvidence?.loaded).toEqual(['engineer', 'prover']);
    const draft = fs.readFileSync(f.source(worker.worktree), 'utf8').replace('end NativeTeam',
      'theorem reusable (n : Nat) : n = n := by rfl\nend NativeTeam');
    fs.writeFileSync(f.source(worker.worktree), draft);
    expect(await f.tool({ operation: 'submit', summary: 'A useful helper.',
      declarations: [{ file: 'Submission.lean', name: 'NativeTeam.reusable', type: '∀ n : Nat, n = n' }] }, worker.id))
      .toMatchObject({ status: 'pending-writer-stop' });
    const second = f.sessions[1]; await second.complete(false);
    expect(f.state.agentTeam!.deliveries).toHaveLength(0);
    second.stopGate.resolve();
    await expect.poll(() => f.team.hasActiveWorkers, { timeout: 60_000 }).toBe(false);
    expect(worker.writerStopUnconfirmed).toBeUndefined();
    expect(f.state.agentTeam!.deliveries).toHaveLength(1);
    expect(worker.tasks[1].deliveryId).toBe(f.state.agentTeam!.deliveries[0].id);
    expect(f.state.agentTeam!.events.find(event => event.kind === 'delivery')).toMatchObject({
      deliveryId: worker.tasks[1].deliveryId,
      text: expect.stringContaining('Lean checked NativeTeam.reusable.'),
    });
    expect(f.state.phase).toBe('running');
  }, 70_000);

  it('pins a submitted declaration across an in-flight reassignment and an interruption before completion', async () => {
    const f = fixture(), inspected = { deliveryId: 'a'.repeat(64), taskId: 'draft', agentId: 'producer',
      commit: f.state.problem.baseCommit, kind: 'inspected' as const, at: '2026-01-01' };
    const alsoInspected = { ...inspected, deliveryId: 'b'.repeat(64) }, adopted = { ...alsoInspected, kind: 'adopted' as const };
    f.team.archive.leadExposures = [inspected, alsoInspected, adopted];
    await f.spawn('analyst', 'Prove helper A.', undefined, 'plaintext', { Forked: [] });
    f.team.archive.leadExposures.push({ ...inspected, deliveryId: 'c'.repeat(64) });
    const worker = f.state.agentTeam!.workers[0]!, task = worker.tasks[0]!, session = f.sessions[0]!;
    const address = { caller: ROOT, target: { kind: 'id', threadId: worker.native!.threadId } };
    const followup = () => f.native('send', { ...address, input: { kind: 'message', mode: 'triggerTurn',
      message: { kind: 'plaintext', text: 'Investigate a new question B.' } }, startOptions: {} });
    const steering = deferred(); const acknowledge = deferred();
    vi.mocked(session.session.nativeAgentControl!.input).mockImplementationOnce(async () => {
      steering.resolve(); await acknowledge.promise;
      return { accepted: true, threadId: worker.native!.threadId, submissionId: session.turnId };
    });
    const inFlight = followup(); await steering.promise;
    fs.writeFileSync(f.source(worker.worktree), fs.readFileSync(f.source(worker.worktree), 'utf8').replace('end NativeTeam',
      'theorem helperA : True := by trivial\nend NativeTeam'));
    const nomination = { operation: 'submit', summary: 'A is ready.',
      declarations: [{ file: 'Submission.lean', name: 'NativeTeam.helperA', type: 'True' }] };
    expect(await f.tool(nomination, worker.id)).toMatchObject({ status: 'pending-writer-stop' });
    acknowledge.resolve(); await inFlight;
    expect(task.objectiveRevision).toBe(2);
    expect(readSolverRunState(path.join(f.directory, 'state.json')).agentTeam!.workers[0]!.tasks[0]!.nomination)
      .toMatchObject({ objectiveRevision: 1, objectiveDigest: mathDigest('Prove helper A.') });
    await expect(followup()).rejects.toThrow('math_team_submission_pending');
    expect(await f.tool({ ...nomination, summary: 'Replace A.', declarations: [
      { file: 'Submission.lean', name: 'NativeTeam.other', type: 'False' }] }, worker.id)).toMatchObject({ ok: false });
    expect(f.team.archive.deliveries).toHaveLength(0);
    await f.native('interrupt', { ...address, version: 'v2' });
    await expect.poll(() => f.team.hasActiveWorkers, { timeout: 60_000 }).toBe(false);
    expect(task.status).toBe('interrupted');
    expect(f.team.archive.deliveries).toHaveLength(1);
    const delivery = readAgentTeamProofDelivery(f.team.archive.deliveries[0]!.path, f.state);
    expect(delivery.provenance).toMatchObject({ taskId: task.id, objectiveRevision: 1, objectiveDigest: mathDigest('Prove helper A.') });
    expect(delivery.provenance?.spawnHistory).toBe('parent-history');
    expect(delivery.provenance?.exposures).toEqual([{ ...inspected, kind: 'possible-via-parent' }, adopted]);
    const durable = readSolverRunState(path.join(f.directory, 'state.json'));
    expect(agentTeamOverview(durable).workers[0]?.deliveryExposures).toEqual(delivery.provenance!.exposures);
    expect(delivery.declarations).toEqual(nomination.declarations);
    await followup();
    expect(worker.tasks).toHaveLength(2);
    expect(task.deliveryId).toBe(delivery.id); expect(task.objectiveRevision).toBe(2);
  }, 70_000);
});
