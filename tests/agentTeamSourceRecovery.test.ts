import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { LIBRARY_PACK_SCHEMA } from '../src/math/libraryPacks';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { readMathAgentSkill } from '../src/runtime/agentSkills';
import type { MathAgentOptions, MathAgentSession } from '../src/runtime/agentSession';
import type { NativeAgentControlConnection } from '../src/runtime/nativeAgentControl';
import { readSolverRunState, writeSolverRunState, type SolverRunState } from '../src/solver/archive';
import { AgentResearchTeam } from '../src/solver/agentTeam';
import { readAgentTeamProofDelivery } from '../src/solver/agentTeamProof';
import { directSolverModules } from '../src/solver/modules';
import { agentLibrary, LIBRARY_ACCESS_FILE, LIBRARY_REQUEST_FILE, type LibraryAccess, writeLibraryAccess } from '../src/solver/libraryAccess';
import { writeLibraryCatalog } from '../src/solver/libraryCatalog';
import { git, readSolverProblem } from '../src/solver/problem';
import { RESEARCH_TOOL_HELP_FILE } from '../src/solver/researchToolHelp';
import { prepareResearchSkill, researchSkillIdentity } from '../src/solver/researchSkill';
import type { SoftSliceSettings } from '../src/solver/softSlice';
import { deferred } from './helpers/async';
import { temporaryDirectory } from './helpers/files';
import { solverState } from './helpers/solver';

vi.mock('../src/math/mathBuildManifest', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/mathBuildManifest')>(), readMathBuildManifest: vi.fn(),
}));

const original = 'namespace Recovery\ntheorem goal : True := by sorry\nend Recovery\n';
const helper = 'theorem helper : True := by trivial\n';
const declarations = [{ file: 'Submission.lean', name: 'Recovery.helper', type: 'True' }];
const fixtures: ReturnType<typeof fixture>[] = [];
const rootThreadId = '00000000-0000-4000-8000-000000000001';

function nativeConnection(threadId: string, agentPath: string, cwd: string, notices: string[] = []): NativeAgentControlConnection {
  return { info: { sessionId: rootThreadId,
    agent: { threadId, metadata: { agentPath, agentId: threadId }, status: 'running' }, configSnapshot: { cwd } },
    request: vi.fn(async () => ({})),
    input: vi.fn(async () => ({ accepted: true, threadId, submissionId: crypto.randomUUID() })),
    update: vi.fn(async value => {
      notices.push(...((value as { mailbox?: { message?: { text?: string } }[] }).mailbox ?? []).flatMap(item => item.message?.text ?? []));
      return { acceptedSequence: value.sequence };
    }),
  };
}

function fixture({ maxAgents = 2, softSlice, stallInterrupt = false, librarySource, maxTotalTokens = 0 }: {
  maxAgents?: number; softSlice?: SoftSliceSettings; stallInterrupt?: boolean; librarySource?: string; maxTotalTokens?: number;
} = {}) {
  const directory = temporaryDirectory('agent-team-source-recovery-');
  const receipt = bootstrapLeanTask(path.join(directory, 'primary'), { source: original, task: 'Prove True.' });
  const problem = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath), root = path.resolve('.');
  const identity = researchSkillIdentity(readMathAgentSkill(path.join(root, 'skills/theoremos-research/SKILL.md')));
  const state = solverState(problem, receipt.workspaceRoot, { runId: 'agent-team-source-recovery', phase: 'running',
    environmentDigest: mathDigest('real Lean True recovery fixture'), researchMode: 'skill', researchSkillWorkflow: 'full',
    researchSkill: identity, researchDelegation: { mode: 'team', maxAgents }, workerCount: 1, coordination: 'independent',
    requestUsageAccounting: { startedRequests: 0, reportedRequests: 0, pendingRequests: 0, incomplete: false },
    agentTeam: { schema: 'theorem-os.agent-team.v1', transport: 'native-agent-control',
      workers: [], events: [], deliveries: [], adoptions: [], operations: [] } });
  const skill = prepareResearchSkill(root, state.worktree, identity, problem);
  let libraryCatalog: LibraryAccess | undefined;
  if (librarySource) {
    const file = 'Submission/Library/TeamFixture.lean';
    const release = writeLibraryCatalog(path.join(directory, 'release'), { id: 'fixture/native-team-library', revision: 'v1',
      environment: 'standard', packs: [{ schema: LIBRARY_PACK_SCHEMA, modules: [{ file, source: librarySource,
        origin: { kind: 'upstream', repository: 'offline-native-fixture', commit: 'a'.repeat(40), file } }] }] });
    libraryCatalog = { file: release.file, digest: release.digest };
    writeLibraryAccess(problem, state.worktree, libraryCatalog);
  }
  const toolchain = path.join(os.homedir(), '.elan/toolchains/leanprover--lean4---v4.33.0');
  if (!fs.existsSync(path.join(toolchain, 'bin/lean'))) throw new Error('Real Lean 4.33.0 is required.');
  const environment = { PATH: `${toolchain}/bin:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    ELAN_HOME: path.join(os.homedir(), '.elan'), LEAN_PATH: '', LEAN_SYSROOT: '',
    DEEPSCIENTIST_MATH_SANDBOX_BACKEND: 'bwrap', DEEPSCIENTIST_MATH_ENV_FILE: path.join(directory, 'missing.env') };
  const controller = new AbortController(), teams: AgentResearchTeam[] = [];
  const sessions: { options: MathAgentOptions; message: string; notices: string[]; complete: () => void }[] = [];
  const events: { event: string; details?: Record<string, unknown> }[] = [];
  const stateFile = path.join(directory, 'run-state.json');
  const makeTeam = (current: SolverRunState) => {
    const team = new AgentResearchTeam({ state: current, root, taskText: 'Prove True.',
      leadAccess: { environment, retrievalRoot: path.join(current.worktree, problem.projectRelative), researchSkill: skill, libraryCatalog },
      modules: { ...directSolverModules, M1: { ...directSolverModules.M1, open: async options => {
        const outcome = deferred<string>(), record = { options, message: '', notices: [] as string[], complete: () => outcome.resolve('completed') };
        sessions.push(record);
        const config = options.nativeAgentControl!;
        const threadId = options.threadId ?? String(config.bootstrap!.threadId);
        const connection = nativeConnection(threadId, '/root/' + options.environment!.DEEPSCIENTIST_MATH_WORKER_ID, options.workspace, record.notices);
        await config.request({ version: 1, sessionId: rootThreadId, threadId, operation: 'attach', operationId: crypto.randomUUID(),
          payload: { threadId, sessionId: rootThreadId } }, connection, { signal: controller.signal });
        await config.bound?.(connection);
        const session: MathAgentSession = { threadId, nativeAgentControl: connection,
          usageSource: 'upstream-requests',
          run: async (message, _id, _workspace, started) => {
            record.message = message; started('source-recovery-turn-' + sessions.length); return outcome.promise;
          },
          notify: async message => { record.notices.push(message); },
          interrupt: async () => { if (!stallInterrupt) outcome.resolve('interrupted'); },
          stopForFreeze: async () => ({ status: 'stopped' }),
          close: async () => {
            if (stallInterrupt) outcome.resolve('interrupted');
            await config.disconnected?.(connection);
          },
        };
        return session;
      } } },
      executable: 'offline-no-model', profile: 'offline-no-credentials', signal: controller.signal,
      maxAgents, maxTurns: Infinity, maxTurnMs: Infinity, maxTotalTokens, remainingMs: () => Infinity,
      softSlice,
      save: () => writeSolverRunState(stateFile, current), emit: (event, details) => { events.push({ event, details }); },
      exclusiveCheck: operation => operation(),
    });
    teams.push(team); return team;
  };
  const team = makeTeam(state); let calls = 0;
  const call = (operation: Record<string, unknown>, actor = 'lead', target = team) => target.tools(actor).call('theoremos_team', operation,
    { callId: 'source-recovery-call-' + ++calls, turnId: 'source-recovery-turn', threadId: 'source-recovery-thread', signal: controller.signal }) as Promise<any>;
  const native = async (operation: string, payload: Record<string, unknown>, target = team) => {
    const options = target.nativeAgentControlOptions();
    const connection = nativeConnection(rootThreadId, '/root', state.worktree);
    const request = (method: string, args: Record<string, unknown>) => options.request({
      version: 1, threadId: rootThreadId, sessionId: rootThreadId, operation: method, operationId: crypto.randomUUID(), payload: args,
    }, connection, { signal: controller.signal });
    await request('attach', { threadId: rootThreadId, sessionId: rootThreadId });
    await options.bound?.(connection);
    return request(operation, { caller: rootThreadId, ...payload });
  };
  const input = (text: string) => ({ kind: 'message', mode: 'triggerTurn', message: { kind: 'plaintext', text } });
  const spawn = (name: string, message: string) => {
    const source = { subagent: { thread_spawn: { parent_thread_id: rootThreadId, agent_path: '/root/' + name, depth: 1 } } };
    return native('spawn', { source, bootstrap: { source, config: { cwd: state.worktree, model: state.model, reasoningEffort: state.effort } },
      input: input(message), startOptions: { parentTurnId: 'root-turn' } });
  };
  const followup = (agentId: string, message: string, target = team) => native('send', {
    target: { kind: 'path', reference: '/root/' + agentId }, input: input(message),
  }, target);
  const current = { directory, state, stateFile, controller, sessions, teams, team, makeTeam, call, spawn, followup, events, problem,
    source: (worktree: string) => path.join(worktree, problem.projectRelative, 'Submission.lean'),
    session: async (index: number) => {
      await expect.poll(() => sessions[index]?.message, { timeout: 10_000 }).toBeTruthy(); return sessions[index]!;
    },
  };
  fixtures.push(current); return current;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    f.controller.abort(); for (const session of f.sessions) session.complete();
    await Promise.allSettled(f.teams.map(team => team.close()));
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});
async function idle(team: AgentResearchTeam) {
  await expect.poll(() => team.hasActiveWorkers, { timeout: 30_000 }).toBe(false);
}

describe('native team source handling', () => {
  it('exposes the pinned math library to a member and reserves installation requests for Lead', async () => {
    const source = 'namespace TeamFixture\ntheorem library_helper : True := by trivial\nend TeamFixture\n';
    const f = fixture({ librarySource: source });
    await f.spawn('member', 'Find the exact declaration in the published library.');
    const child = await f.session(0), worktree = child.options.workspace;
    const name = 'TeamFixture.library_helper', library = agentLibrary(worktree);
    expect(library.search(name).hits[0]).toMatchObject({ name, installation: 'not-installed' });
    expect(library.get(name).source).toMatchObject({ complete: true, text: source });
    expect(fs.readFileSync(path.join(worktree, RESEARCH_TOOL_HELP_FILE), 'utf8')).toContain('Lead requests installation for the team');
    expect(() => library.request([name], 'Apply the checked helper.')).toThrow('math_library_request_lead_required');
    expect(fs.existsSync(path.join(worktree, LIBRARY_REQUEST_FILE))).toBe(false);
    expect(agentLibrary(f.state.worktree).request([name], 'Apply the checked helper.')).toMatchObject({ status: 'queued' });
    expect(fs.existsSync(path.join(f.state.worktree, LIBRARY_REQUEST_FILE))).toBe(true);
  });

  it('prepares the math library on demand when an idle member resumes its saved thread', async () => {
    const name = 'TeamFixture.library_helper';
    const f = fixture({ librarySource: `theorem ${name} : True := by trivial\n` });
    await f.spawn('member', 'Check the local identity.');
    const first = await f.session(0), worktree = first.options.workspace;
    const threadId = f.team.archive.workers[0]!.native!.threadId;
    first.complete(); await idle(f.team); await f.team.close();
    const catalog = path.join(worktree, LIBRARY_ACCESS_FILE);
    fs.unlinkSync(catalog);

    const restored = f.makeTeam(readSolverRunState(f.stateFile));
    await restored.restore();
    expect(fs.existsSync(catalog)).toBe(false);
    expect(f.sessions).toHaveLength(1);

    await f.followup('member', 'Look up the exact lemma for the next step.', restored);
    const next = await f.session(1);
    expect(next.options.threadId).toBe(threadId);
    expect(next.options.workspace).toBe(worktree);
    expect(agentLibrary(worktree).get(name).source.complete).toBe(true);
    next.complete(); await idle(restored);
  });

  it('charges member receipts to the same run budget and blocks a subsequent request when exhausted', async () => {
    const f = fixture({ maxAgents: 3, maxTotalTokens: 50 });
    await f.spawn('first', 'Check the local identity.');
    await f.spawn('second', 'Read the hypotheses.');
    const first = await f.session(0), second = await f.session(1);
    for (const [index, session] of [first, second].entries()) {
      const admission = session.options.requestGate!({ requestId: 'budget-' + index });
      if (admission.allowed === false) throw new Error(admission.reason);
      const totalTokens = index === 0 ? 20 : 30;
      const receipt = { usage: { inputTokens: totalTokens - 2, outputTokens: 2, totalTokens }, complete: true,
        outcome: 'completed' as const };
      admission.settle(receipt);
      admission.settle(receipt);
    }
    expect(f.state.teamUsage).toMatchObject({ totalTokens: 50, inputTokens: 46, outputTokens: 4 });
    expect(f.state.tokenBudget).toMatchObject({ status: 'exhausted', usageComplete: true });
    expect(first.options.requestGate!({ requestId: 'blocked' })).toEqual({ allowed: false, reason: 'math_total_token_limit' });
    first.complete(); second.complete(); await idle(f.team);
    expect(f.team.archive.workers.map(worker => worker.requestUsageAccounting!.reportedRequests)).toEqual([1, 1]);
  });

  it('restores lost member receipts before admitting more work under a finite shared budget', async () => {
    const f = fixture({ maxTotalTokens: 50 });
    await f.spawn('member', 'Check the local identity.');
    const child = await f.session(0);
    const reported = child.options.requestGate!({ requestId: 'reported' });
    if (!reported.allowed) throw new Error(reported.reason);
    reported.settle({ complete: true, usage: { inputTokens: 18, outputTokens: 2, totalTokens: 20 } });
    expect(child.options.requestGate!({ requestId: 'lost' }).allowed).toBe(true);
    const saved = readSolverRunState(f.stateFile);
    expect(saved.tokenBudget).toMatchObject({ status: 'available', reportedTotalTokens: 20, usageComplete: false });
    child.complete(); await idle(f.team); await f.team.close();

    const restored = f.makeTeam(saved); await restored.restore();
    const recovered = readSolverRunState(f.stateFile);
    expect(recovered.tokenBudget).toMatchObject({ status: 'usage-unavailable', reportedTotalTokens: 20, usageComplete: false });
    expect(recovered.teamUsage).toMatchObject({ totalTokens: 20 });
    expect(recovered.agentTeam!.workers[0]!.requestUsageAccounting).toMatchObject({
      pendingRequests: 0, incomplete: true, receipts: [expect.objectContaining({ status: 'reported' }),
        expect.objectContaining({ requestId: 'lost', status: 'missing', missingReason: 'resumed-without-receipt' })],
    });
    await expect(f.followup('member', 'Continue the investigation.', restored)).rejects.toThrow();
    expect(f.sessions).toHaveLength(1);
  });

  it('preserves an unfinished child assignment that returns after a two-compaction milestone notice', async () => {
    const f = fixture({ softSlice: { softSliceMs: 0, maxCompactionsPerSlice: 2 } });
    await f.spawn('member', 'Investigate a partial proof.');
    const session = await f.session(0), worker = f.team.archive.workers[0]!;
    const activity = session.options.onActivity!;
    activity({ event: 'item_started', itemType: 'contextCompaction' });
    activity({ event: 'item_completed', itemType: 'contextCompaction' });
    expect(session.notices).toEqual([]);
    activity({ event: 'item_completed', itemType: 'contextCompaction' });
    expect(session.notices).toEqual([expect.stringContaining('submit with helpersOnly:true')]);
    expect(f.events).toContainEqual({ event: 'compaction_circuit_breaker_triggered', details: expect.objectContaining({
      workerId: worker.id, taskId: worker.tasks[0]!.id, completedCompactions: 2,
    }) });
    const notes = path.join(worker.worktree, 'RESEARCH.md');
    fs.writeFileSync(notes, 'The remaining step is the original goal.\n');
    session.complete(); await idle(f.team);
    expect(worker.tasks[0]).toMatchObject({ status: 'paused', researchArtifactId: expect.any(String),
      pauseRequested: { kind: 'handoff', reason: 'math_soft_slice_milestone' } });
    expect(fs.readFileSync(notes, 'utf8')).toContain('remaining step');
  });

  it('closes an unsettled writer after the milestone checkpoint and preserves its draft', async () => {
    const f = fixture({ softSlice: { softSliceMs: 0, maxCompactionsPerSlice: 1, softSliceGraceMs: 1 }, stallInterrupt: true });
    await f.spawn('member', 'Investigate a partial proof.');
    const session = await f.session(0), worker = f.team.archive.workers[0]!;
    fs.writeFileSync(path.join(worker.worktree, 'RESEARCH.md'), 'This draft belongs to the same task.\n');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      session.options.onActivity!({ event: 'item_completed', itemType: 'contextCompaction' });
      await vi.advanceTimersByTimeAsync(30_001);
      expect(f.events).toContainEqual({ event: 'soft_slice_checkpoint_requested',
        details: expect.objectContaining({ workerId: worker.id, boundary: 'wait-limit' }) });
      expect(worker.tasks[0]!.status).toBe('running');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(f.events).toContainEqual({ event: 'soft_slice_session_closed',
        details: expect.objectContaining({ workerId: worker.id, reason: 'interrupt-not-settled' }) });
    } finally { vi.useRealTimers(); }
    await idle(f.team);
    expect(worker.tasks[0]).toMatchObject({ status: 'paused', researchArtifactId: expect.any(String),
      pauseRequested: { kind: 'handoff', reason: 'math_soft_slice_checkpoint' } });
    expect(worker.writerStopUnconfirmed).toBeUndefined();
  });

  it('lands standalone helpers with the producer task open and installs them in a peer with unpublished work', async () => {
    const f = fixture({ maxAgents: 3 });
    await f.spawn('member', 'Prove the goal and its helper lemmas.');
    const a = await f.session(0), producer = f.team.archive.workers[0]!;
    await f.spawn('peer', 'Draft another proof step.');
    const b = await f.session(1), consumer = f.team.archive.workers[1]!;
    const helperProofs = helper + 'theorem second : True := helper\n';
    const draft = 'theorem draft : True := by sorry\n';
    fs.writeFileSync(f.source(producer.worktree), original.replace('theorem goal', helperProofs + 'theorem goal'));
    fs.writeFileSync(f.source(consumer.worktree), original.replace('end Recovery', draft + 'end Recovery'));
    const names = [...declarations, { ...declarations[0]!, name: 'Recovery.second' }];
    expect(await f.call({ operation: 'submit', helpersOnly: true, summary: 'Verified standalone facts.', declarations: names }, 'member'))
      .toMatchObject({ ok: true, status: 'pending-writer-stop' });
    expect(f.team.archive.canonicalCommit).toBeUndefined();
    expect(a.options.requestGate!.checkpoint!()).toBe(true);
    a.complete();
    await expect.poll(() => f.team.archive.canonicalCommit, { timeout: 20_000 }).toBeTruthy();
    const commit = f.team.archive.canonicalCommit!;
    expect(readSolverRunState(f.stateFile).agentTeam!.landedHelpers?.map(item => item.qualifiedName))
      .toEqual(['Recovery.helper', 'Recovery.second']);
    expect(git(f.state.worktree, ['show', commit + ':' + f.problem.projectRelative + '/Submission.lean']))
      .toBe(original.replace('theorem goal', helperProofs + 'theorem goal').trimEnd());
    expect(producer.tasks[0]).toMatchObject({ status: 'paused' });
    expect(producer.tasks[0]!.deliveryId).toBeUndefined();
    expect(f.state.check).toBeUndefined();
    expect(b.notices.some(message => message.includes('Recovery.second') && !message.includes(':= '))).toBe(true);
    expect(consumer.tasks[0]!.status).toBe('running');
    expect(fs.readFileSync(f.source(consumer.worktree), 'utf8')).not.toContain('theorem second');
    b.complete(); await idle(f.team);

    await f.team.close();
    const saved = readSolverRunState(f.stateFile), restored = f.makeTeam(saved);
    await restored.restore();
    expect(fs.readFileSync(f.source(f.state.worktree), 'utf8')).toContain('theorem goal : True := by sorry');
    const seeded = fs.readFileSync(f.source(consumer.worktree), 'utf8');
    expect(seeded).toContain(helperProofs);
    expect(seeded).toContain(draft);
    await f.followup('peer', 'Use the landed helpers to finish both proofs.', restored);
    const next = await f.session(2);
    expect(next.message).toContain('landedHelpers');
    expect(next.message).toContain('Recovery.second');
    fs.writeFileSync(f.source(consumer.worktree), seeded.replaceAll('by sorry', 'by exact second'));
    await f.call({ operation: 'submit', summary: 'Reused the verified helpers.', declarations: [
      { ...declarations[0]!, name: 'Recovery.goal' }, { ...declarations[0]!, name: 'Recovery.draft' },
    ] }, 'peer', restored);
    next.complete(); await idle(restored);
    const delivery = restored.archive.deliveries.find(item => item.agentId === 'peer')!;
    expect(readAgentTeamProofDelivery(delivery.path, saved).artifacts.map(item => item.declaration.name))
      .toEqual(['Recovery.helper', 'Recovery.second', 'Recovery.goal', 'Recovery.draft']);
    expect(saved.check).toBeUndefined();
  }, 60_000);

  it('replays a recorded submit_helpers call from an older member thread', async () => {
    const f = fixture();
    const originalCall = { operation: 'submit_helpers', summary: 'Verified standalone facts.', declarations };
    const context = { threadId: 'old-member-thread', turnId: 'old-turn', callId: 'old-submit', signal: f.controller.signal };
    const result = { ok: true, status: 'pending-writer-stop', taskId: 'old-task' };
    const saved = structuredClone(f.state);
    const key = canonicalMathJson(['member', context.threadId, context.turnId, context.callId]);
    const changedCall = { ...originalCall, summary: 'Changed replay.' };
    saved.agentTeam!.operations.push(
      { key, digest: mathDigest(canonicalMathJson(originalCall)), result },
      { key, digest: mathDigest(canonicalMathJson(changedCall)), result: { ok: false } },
    );
    writeSolverRunState(f.stateFile, saved);
    const restored = f.makeTeam(readSolverRunState(f.stateFile));
    const tools = restored.tools('member');
    await expect(tools.call('theoremos_team', originalCall, context)).resolves.toEqual(result);
    await expect(tools.call('theoremos_team', changedCall, context)).rejects.toThrow('math_team_call_changed');
    expect(restored.archive.operations).toEqual(saved.agentTeam!.operations);
  });

  it('preserves the rejected Lean interface and check receipt for the producer, a repair peer and restored history', async () => {
    const f = fixture({ maxAgents: 3 }); await f.spawn('member', 'Prove the helper.');
    const first = await f.session(0), worker = f.team.archive.workers[0]!;
    fs.writeFileSync(f.source(worker.worktree), original.replace('end Recovery', helper + 'end Recovery'));
    const wrong = [{ ...declarations[0]!, type: 'False' }];
    await f.call({ operation: 'submit', summary: 'Check this interface.', declarations: wrong }, 'member');
    first.complete(); await idle(f.team);
    const task = worker.tasks[0]!, locator = { operation: 'history', agentId: worker.id, offset: 0, limit: 1 };
    const failure = task.failedCheck!;
    expect(task.status).toBe('failed');
    expect(failure).toMatchObject({ declaration: wrong[0], commit: git(worker.worktree, ['rev-parse', 'HEAD']),
      seedCommit: f.problem.baseCommit, objectiveRevision: 1, environmentDigest: f.state.environmentDigest,
      problemReceiptDigest: f.problem.receiptDigest, sourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      projectionCommit: expect.stringMatching(/^[a-f0-9]{40,64}$/),
      results: [expect.objectContaining({ receiptId: expect.any(String), checkId: expect.any(String) })] });
    expect(f.team.archive.events.find(event => event.kind === 'failed')?.text).toContain(JSON.stringify(locator));
    expect(f.team.archive.deliveries).toHaveLength(0);
    expect(readSolverRunState(f.stateFile).agentTeam!.workers[0]!.tasks[0]!.failedCheck).toEqual(failure);
    await f.followup('member', 'Repair the rejected declaration.');
    const next = await f.session(1);
    expect(next.message).toContain('failedCheck');
    expect((await f.call(locator, 'member')).tasks[0]?.failedCheck).toEqual(failure);
    await f.spawn('repair', 'Read the earlier failed interface: ' + JSON.stringify(locator));
    await f.session(2);
    expect((await f.call(locator, 'repair')).tasks[0]?.failedCheck).toEqual(failure);
    expect(f.state.check).toBeUndefined();
  }, 60_000);

  it('rejects a non-owned declaration file before nomination, and accepts a corrected submission on the same turn', async () => {
    const f = fixture(); await f.spawn('member', 'Prove the helper.');
    const session = await f.session(0), worker = f.team.archive.workers[0]!;
    expect(await f.call({ operation: 'submit', summary: 'Helper ready.', declarations: [
      { ...declarations[0], file: `${f.problem.projectRelative}/Submission.lean` }] }, 'member')).toMatchObject({
      ok: false, error: 'math_agent_team_proof_declaration_outside_ownership',
      rejectedFiles: [`${f.problem.projectRelative}/Submission.lean`], ownedFiles: ['Submission.lean'],
      hint: expect.stringContaining('relative to the Lean project'),
    });
    expect(worker.tasks[0]!.declarations).toBeUndefined(); expect(worker.pendingDelivery).toBeUndefined();
    expect(session.options.requestGate!.checkpoint!()).toBe(false);
    fs.writeFileSync(f.source(worker.worktree), original.replace('end Recovery', helper + 'end Recovery'));
    expect(await f.call({ operation: 'submit', summary: 'Corrected relative path.', declarations }, 'member'))
      .toMatchObject({ ok: true, status: 'pending-writer-stop' });
    session.complete(); await idle(f.team);
    expect(f.team.archive.deliveries).toHaveLength(1); expect(worker.pendingDelivery).toBeUndefined();
    expect(f.state.check).toBeUndefined();
  }, 60_000);

  it.each(['outside-ownership', 'original-declaration'] as const)(
    'preserves a %s draft and notes, then permits an explicit same-member correction', async kind => {
      const f = fixture(); await f.spawn('member', 'Prove the helper.');
      const first = await f.session(0), worker = f.team.archive.workers[0]!, file = f.source(worker.worktree);
      const valid = original.replace('end Recovery', helper + 'end Recovery');
      const invalid = kind === 'original-declaration' ? valid.replace('goal : True', 'goal : False') : valid;
      fs.writeFileSync(file, invalid); fs.writeFileSync(path.join(worker.worktree, 'RESEARCH.md'), 'Keep this unfinished investigation.\n');
      if (kind === 'outside-ownership') {
        fs.writeFileSync(path.join(worker.worktree, 'Sketch.lean'), 'theorem exploratory : True := by trivial\n');
        git(worker.worktree, ['add', 'Sketch.lean']);
      }
      expect(await f.call({ operation: 'submit', summary: 'Nominate helper.', declarations }, 'member')).toMatchObject({ ok: true });
      first.complete(); await idle(f.team);
      const rejected = worker.tasks[0]!;
      expect(worker).toMatchObject({ status: 'idle', activity: 'idle', phase: 'prepared' });
      expect(worker.pendingDelivery).toBeUndefined(); expect(rejected.status).toBe('failed');
      expect(rejected.error).toContain(kind === 'outside-ownership' ? 'Sketch.lean' : 'math_original_declaration_changed');
      expect(rejected.sourceCommit).toBeUndefined(); expect(rejected.researchArtifactId).toBeUndefined();
      expect(f.team.archive.researchArtifacts ?? []).toHaveLength(0); expect(f.team.archive.deliveries).toHaveLength(0);
      expect(fs.readFileSync(file, 'utf8')).toBe(invalid);
      expect(fs.readFileSync(path.join(worker.worktree, 'RESEARCH.md'), 'utf8')).toBe('Keep this unfinished investigation.\n');
      expect(git(worker.worktree, ['rev-parse', 'HEAD'])).toBe(f.problem.baseCommit);
      if (kind === 'outside-ownership') expect(git(worker.worktree, ['diff', '--cached', '--name-only'])).toBe('Sketch.lean');
      expect(f.team.archive.events.some(event => event.kind === 'failed' && event.text.includes('Lead can assign a correction'))).toBe(true);
      await f.followup('member', 'Correct the rejected source and resubmit the helper.');
      const correction = await f.session(1);
      expect(correction.options.threadId).toBe(worker.native!.threadId);
      expect(correction.message).toContain('Host rejected the edited source');
      expect(correction.message).toContain(kind === 'outside-ownership' ? 'Sketch.lean' : 'math_original_declaration_changed');
      expect(fs.readFileSync(file, 'utf8')).toBe(invalid);
      if (kind === 'outside-ownership') {
        git(worker.worktree, ['reset', 'HEAD', '--', 'Sketch.lean']);
        fs.renameSync(path.join(worker.worktree, 'Sketch.lean'), path.join(worker.worktree, '.scratch', 'Sketch.lean'));
      }
      fs.writeFileSync(file, valid);
      expect(await f.call({ operation: 'submit', summary: 'Source corrected; helper ready.', declarations }, 'member')).toMatchObject({ ok: true });
      correction.complete(); await idle(f.team);
      expect(f.team.archive.deliveries).toHaveLength(1); expect(worker.tasks[1]!.deliveryId).toBeDefined();
      expect(worker.tasks[1]!.researchArtifactId).toBeDefined(); expect(worker.pendingDelivery).toBeUndefined();
      expect(rejected.status).toBe('failed'); expect(f.state.check).toBeUndefined();
    }, 60_000);

  it('clears a restored stopped-writer nomination without rewriting its invalid source or fabricating an artifact', async () => {
    const f = fixture(); await f.spawn('member', 'Prove the helper.');
    const first = await f.session(0), worker = f.team.archive.workers[0]!;
    first.complete(); await idle(f.team); await f.team.close();
    fs.writeFileSync(f.source(worker.worktree), original.replace('goal : True', 'goal : False'));
    fs.writeFileSync(path.join(worker.worktree, 'RESEARCH.md'), 'Notes saved before the previous process stopped.\n');
    const saved = readSolverRunState(f.stateFile), recoveredWorker = saved.agentTeam!.workers[0]!, task = recoveredWorker.tasks[0]!;
    recoveredWorker.status = 'failed'; recoveredWorker.activity = 'checking'; recoveredWorker.phase = 'checking';
    recoveredWorker.pendingSourceBase = f.problem.baseCommit;
    recoveredWorker.pendingDelivery = { taskId: task.id, seedCommit: f.problem.baseCommit, declarations };
    task.declarations = declarations; const artifactCount = saved.agentTeam!.researchArtifacts?.length ?? 0;
    const restored = f.makeTeam(saved); await restored.restore();
    expect(recoveredWorker).toMatchObject({ status: 'idle', activity: 'idle', phase: 'prepared' });
    expect(recoveredWorker.pendingDelivery).toBeUndefined(); expect(task.status).toBe('failed');
    expect(saved.agentTeam!.researchArtifacts ?? []).toHaveLength(artifactCount); expect(saved.agentTeam!.deliveries).toHaveLength(0);
    expect(fs.readFileSync(f.source(recoveredWorker.worktree), 'utf8')).toContain('goal : False');
    expect(fs.readFileSync(path.join(recoveredWorker.worktree, 'RESEARCH.md'), 'utf8')).toContain('previous process stopped');
    await f.followup('member', 'Repair the statement and prove the helper.', restored);
    const correction = await f.session(1); expect(correction.message).toContain('math_original_declaration_changed');
    fs.writeFileSync(f.source(recoveredWorker.worktree), original.replace('end Recovery', helper + 'end Recovery'));
    expect(await f.call({ operation: 'submit', summary: 'Recovered and repaired.', declarations }, 'member', restored)).toMatchObject({ ok: true });
    correction.complete(); await idle(restored);
    expect(saved.agentTeam!.deliveries).toHaveLength(1); expect(saved.check).toBeUndefined();
  }, 60_000);

  it('retains a nomination on an unrelated infrastructure failure', async () => {
    const f = fixture(); await f.spawn('member', 'Prove the helper.');
    const first = await f.session(0), worker = f.team.archive.workers[0]!;
    fs.writeFileSync(f.source(worker.worktree), original.replace('end Recovery', helper + 'end Recovery'));
    expect(await f.call({ operation: 'submit', summary: 'Helper ready.', declarations }, 'member')).toMatchObject({ ok: true });
    const read = fs.readFileSync.bind(fs);
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] === f.source(worker.worktree)) throw Object.assign(new Error('fixture-source-EIO'), { code: 'EIO' });
      return read(...args);
    });
    first.complete(); await idle(f.team); spy.mockRestore();
    expect(worker.status).toBe('failed'); expect(worker.error).toBe('fixture-source-EIO');
    expect(worker.pendingDelivery).toBeDefined(); expect(f.team.archive.deliveries).toHaveLength(0);
  });

  it('resumes the exact acknowledged nomination after writer loss but honors an explicit cancellation', async () => {
    const f = fixture(); await f.spawn('member', 'Route: test-route\nInvestigate.');
    await f.session(0);
    const worker = f.team.archive.workers[0]!, task = worker.tasks[0]!;
    const message = 'Prove the helper.';
    await f.followup(worker.id, message);
    fs.writeFileSync(f.source(worker.worktree), original.replace('end Recovery', helper + 'end Recovery'));
    const reply = await f.call({ operation: 'submit', summary: 'Ready to check.', objectiveRevision: 2, declarations }, 'member');
    expect(reply).toMatchObject({ status: 'pending-writer-stop' });
    const beforeCancel = readSolverRunState(f.stateFile);
    expect(await f.call({ operation: 'retire_route', routeId: 'test-route', reason: 'This route is ruled out.',
      evidenceRefs: ['RESEARCH.md'] })).toMatchObject({ ok: true, cancelledTaskIds: [task.id] });
    await idle(f.team);
    expect(f.team.archive.deliveries).toHaveLength(0);
    const cancelled = f.makeTeam(readSolverRunState(f.stateFile));
    await cancelled.restore();
    expect(cancelled.archive.deliveries).toHaveLength(0);
    // Legacy shutdown saved source and status but did not register the acknowledged submission.
    const legacy = readSolverRunState(f.stateFile);
    const old = legacy.agentTeam!.workers[0]!.tasks[0]!;
    old.status = 'interrupted'; delete old.cancelRequested; delete old.nomination;
    const sourceFile = f.source(worker.worktree), fixed = fs.readFileSync(sourceFile, 'utf8');
    fs.writeFileSync(sourceFile, fixed + '\n-- newer draft\n');
    const dirty = f.makeTeam(structuredClone(legacy)); await dirty.restore();
    expect(dirty.archive.deliveries).toHaveLength(0);
    fs.writeFileSync(sourceFile, fixed);
    const exact = f.makeTeam(legacy); await exact.restore();
    expect(exact.archive.deliveries).toHaveLength(1);
    // It has amended history, but no evidence of which revision nominated it.
    expect(readAgentTeamProofDelivery(exact.archive.deliveries[0]!.path, legacy).provenance).not.toHaveProperty('objectiveRevision');
    const recovered = f.makeTeam(beforeCancel);
    await recovered.restore();
    const recoveredTask = recovered.archive.workers[0]!.tasks[0]!;
    expect(recoveredTask.status, recoveredTask.error).toBe('interrupted');
    expect(recovered.archive.deliveries).toHaveLength(1);
    expect(readAgentTeamProofDelivery(recovered.archive.deliveries[0]!.path, beforeCancel).provenance)
      .toMatchObject({ taskId: task.id, objectiveRevision: 2, objectiveDigest: mathDigest(message) });
    expect(f.sessions).toHaveLength(1);
  }, 60_000);
});
