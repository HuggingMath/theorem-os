import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { readMathAgentSkill } from '../src/runtime/agentSkills';
import type { MathAgentOptions, MathAgentSession } from '../src/runtime/agentSession';
import type { HarnessProcessIdentity } from '../src/runtime/harnessProcess';
import { readSolverRunState, writeSolverRunState, type SolverRunState } from '../src/solver/archive';
import { AgentResearchTeam } from '../src/solver/agentTeam';
import { readAgentTeamProofDelivery } from '../src/solver/agentTeamProof';
import { DeclarationArtifactCheckError } from '../src/solver/declarationArtifacts';
import type { AgentTeamState } from '../src/solver/agentTeamState';
import { directSolverModules } from '../src/solver/modules';
import { runResearchWorkers } from '../src/solver/research';
import { git, readSolverProblem } from '../src/solver/problem';
import { prepareResearchSkill, researchSkillIdentity } from '../src/solver/researchSkill';
import { RESEARCH_TOOL_HELP_FILE } from '../src/solver/researchToolHelp';
import { deferred } from './helpers/async';
import { temporaryDirectory } from './helpers/files';
import { solverState } from './helpers/solver';
import { currentWorkerProject } from '../src/solver/workerProject';

// Scheduling fixtures do not execute a backend bundle; Git sources, writer handoff
// and independent Lean verification below remain real.
vi.mock('../src/math/mathBuildManifest', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/mathBuildManifest')>(), readMathBuildManifest: vi.fn(),
}));

const original = 'namespace Team\ntheorem original : True := by sorry\n' +
  'theorem other : True := by sorry\nend Team\n';
const helper = 'theorem reusable (n : Nat) : n = n := by rfl\n';
const declarations = [{ file: 'Submission.lean', name: 'Team.reusable', type: '∀ n : Nat, n = n' }];
const fixtures: ReturnType<typeof fixture>[] = [];
type InspectChangePage = { changeIndex: number; name: string; file: string; offset: number; source: string;
  totalCharacters: number; truncated: boolean; nextOffset?: number };
type ToolResult = { ok: boolean; error?: string; status?: string; delivery?: string; notification?: string; cursor: number;
  taskId?: string; replacementTaskId?: string;
  events: AgentTeamState['events']; adoption?: AgentTeamState['adoptions'][number];
  workers?: ({ id: string } & Record<string, unknown>)[]; budget?: Record<string, unknown>;
  researchState?: { revision: number; summary: string; publishedAt: number; advisory: true };
  researchArtifacts?: { id: string; agentId: string; taskId: string; commit: string }[];
  id?: string; commit?: string; advisory?: boolean; originalProblemAcceptance?: string;
  changes?: InspectChangePage[]; change?: InspectChangePage; sourceDigest?: string;
  notes?: { file: string; sha256: string; bytes: number; text: string; offset: number;
    nextOffset?: number; truncated: boolean; totalCharacters: number } | null };
type StopReceipt = Awaited<ReturnType<NonNullable<MathAgentSession['stopForFreeze']>>>;

/** A native session substitute with separately controlled turn settlement and writer shutdown.
 * Tool cancellation waits for host callbacks, matching the native tool dispatcher's close contract.
 * Git worktrees, source freezing, persistence, budgets and Lean checks remain real. */
function controlledSession(options: MathAgentOptions, index: number) {
  const id = options.environment!.DEEPSCIENTIST_MATH_WORKER_ID!;
  const threadId = options.threadId ?? `native-${id}`;
  const turnId = `${threadId}-turn-${index}`;
  const started = deferred(), stopping = deferred(), outcome = deferred<string>();
  const stopReceipt = deferred<StopReceipt>();
  const toolController = new AbortController(), pendingTools = new Set<Promise<unknown>>();
  const notifications: string[] = [];
  let message = '', messageId: string | undefined, runSettled = false, closed = false, calls = 0;
  const abort = () => {
    toolController.abort(new Error('fixture-tool-cancelled'));
    void Promise.allSettled([...pendingTools]).then(() => outcome.resolve('interrupted'));
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  const session: MathAgentSession = {
    threadId, usageSource: 'upstream-requests',
    get lastCompletedResponse() { return runSettled ? { turnId, text: `Saved research by ${id}.` } : undefined; },
    run: async (input, inputMessageId, _workspace, onStarted) => {
      message = input; messageId = inputMessageId; onStarted(turnId); started.resolve();
      try { return await outcome.promise; } finally { runSettled = true; }
    },
    notify: async input => { notifications.push(input); },
    interrupt: async () => { abort(); },
    stopForFreeze: async () => {
      stopping.resolve();
      const receipt = await stopReceipt.promise;
      return runSettled && pendingTools.size === 0 ? receipt : { status: 'unconfirmed', reason: 'turn-not-settled' };
    },
    close: async () => { closed = true; options.signal?.removeEventListener('abort', abort); },
  };
  return { id, options, session, threadId, turnId, started, stopping, outcome, stopReceipt, notifications,
    get message() { return message; }, get messageId() { return messageId; }, get closed() { return closed; },
    complete: () => { stopReceipt.resolve({ status: 'stopped' }); outcome.resolve('completed'); },
    call: (operation: Record<string, unknown>) => {
      const result = options.tools!.call('theoremos_team', operation, {
        callId: `child-call-${++calls}`, turnId, threadId, signal: toolController.signal,
      }).finally(() => { pendingTools.delete(result); });
      pendingTools.add(result); return result as Promise<ToolResult>;
    },
  };
}

function fixture({ maxTotalTokens = 0, maxAgents = 3, maxTurns = 16, maxTurnMs = 30_000, beforeOpen, beforeCheck }: {
  maxTotalTokens?: number; maxAgents?: number; maxTurns?: number; maxTurnMs?: number;
  beforeOpen?: (options: MathAgentOptions, attempt: number) => Promise<void>;
  beforeCheck?: (signal: AbortSignal) => Promise<void>;
} = {}) {
  const directory = temporaryDirectory('agent-research-team-');
  const receipt = bootstrapLeanTask(path.join(directory, 'primary'), { source: original, task: 'Prove both frozen statements.' });
  const problem = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath);
  const root = path.resolve('.');
  const identity = researchSkillIdentity(readMathAgentSkill(path.join(root, 'skills/theoremos-research/SKILL.md')));
  const state = solverState(problem, receipt.workspaceRoot, { runId: 'agent-team-integration', phase: 'running',
    environmentDigest: mathDigest('real lean standard environment'), researchMode: 'skill', researchSkillWorkflow: 'full',
    researchSkill: identity, researchDelegation: { mode: 'team', maxAgents }, workerCount: 1, coordination: 'independent',
    // Global turns include children; this record accounts only for the Lead's requests.
    usageAccounting: { startedTurns: 0, reportedTurns: 0, pending: false, incomplete: false },
    requestUsageAccounting: { startedRequests: 0, reportedRequests: 0, pendingRequests: 0, incomplete: false },
  });
  const skill = prepareResearchSkill(root, state.worktree, identity, problem);
  const toolchain = path.join(os.homedir(), '.elan/toolchains/leanprover--lean4---v4.33.0');
  if (!fs.existsSync(path.join(toolchain, 'bin/lean'))) throw new Error('Real Lean 4.33.0 is required.');
  const environment = { PATH: `${toolchain}/bin:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    ELAN_HOME: path.join(os.homedir(), '.elan'), LEAN_PATH: '', LEAN_SYSROOT: '',
    DEEPSCIENTIST_MATH_SANDBOX_BACKEND: 'bwrap', DEEPSCIENTIST_MATH_ENV_FILE: path.join(directory, 'missing.env') };
  const controller = new AbortController(), sessions: ReturnType<typeof controlledSession>[] = [], teams: AgentResearchTeam[] = [];
  const opened: MathAgentOptions[] = [];
  const events: { event: string; details?: Record<string, unknown> }[] = [];
  const snapshots: SolverRunState[] = [];
  const stateFile = path.join(directory, 'run-state.json');
  const modules = { ...directSolverModules, M1: { ...directSolverModules.M1,
    open: async (options: MathAgentOptions) => {
      const attempt = opened.push(options); await beforeOpen?.(options, attempt);
      const current = controlledSession(options, sessions.length + 1); sessions.push(current); return current.session;
    } } };
  const makeTeam = (currentState: SolverRunState) => {
    const team = new AgentResearchTeam({ state: currentState, root, taskText: 'Prove both frozen statements.',
      leadAccess: { environment, retrievalRoot: path.join(currentState.worktree, problem.projectRelative), researchSkill: skill },
      modules, executable: 'offline-no-model', profile: 'offline-no-credentials', signal: controller.signal,
      maxAgents, maxTurns, maxTurnMs, maxTotalTokens, remainingMs: () => Infinity,
      save: () => { writeSolverRunState(stateFile, currentState); snapshots.push(structuredClone(currentState)); },
      emit: (event, details) => { events.push({ event, details }); }, exclusiveCheck: async operation => {
        await beforeCheck?.(controller.signal); return operation();
      },
    });
    teams.push(team); return team;
  };
  const team = makeTeam(state);
  let calls = 0;
  const call = async (operation: Record<string, unknown>, actor = 'lead', callId = `lead-call-${++calls}`, target = team) =>
    await target.tools(actor).call('theoremos_team', operation, {
      callId, turnId: 'lead-turn', threadId: 'lead-thread', signal: controller.signal,
    }) as ToolResult;
  const current = { directory, root, environment, problem, state, stateFile, team, teams, sessions, opened, makeTeam, call, controller, events, snapshots,
    source: (worktree: string) => path.join(worktree, problem.projectRelative, 'Submission.lean'),
    session: async (id: string, occurrence = 0) => {
      // A follow-up session may wait for an actual Lean check before dispatch.
      await expect.poll(() => sessions.filter(item => item.id === id).length, { timeout: 10_000 }).toBeGreaterThan(occurrence);
      const session = sessions.filter(item => item.id === id)[occurrence]!; await session.started.promise; return session;
    },
  };
  fixtures.push(current); return current;
}

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.controller.abort();
    for (const session of f.sessions) {
      session.stopReceipt.resolve({ status: 'stopped' }); session.outcome.resolve('interrupted');
    }
    await Promise.allSettled(f.teams.map(team => team.close()));
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

async function idle(team: AgentResearchTeam) {
  await expect.poll(() => team.hasActiveWorkers, { timeout: 60_000 }).toBe(false);
}

/** Inspect the assignment actually sent to the native turn, independently of the context builder. */
function dispatchedAssignment(message: string) {
  const line = message.split('\n').find(line => line.startsWith('{"agentId":'));
  expect(line, 'the native turn must receive its current structured assignment').toBeDefined();
  return JSON.parse(line!);
}

describe('Agent-led sustained collaboration with real Git and Lean', () => {
  it('automatically hands off a pending Lead adoption before more model work and resumes only after confirmed shutdown and integration', async () => {
    const f = fixture({ maxTurns: Infinity, maxTurnMs: Infinity });
    await f.call({ operation: 'spawn', agentId: 'producer', message: 'Prove the reusable equality helper.' });
    const producer = await f.session('producer'), worker = f.team.archive.workers[0]!;
    const producerRequest = producer.options.requestGate!({ requestId: 'producer-proof', threadId: producer.threadId });
    if (!producerRequest.allowed) throw new Error(producerRequest.reason);
    producerRequest.settle({ complete: true, outcome: 'completed', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } });
    fs.writeFileSync(f.source(worker.worktree), original.replace('end Team', helper + 'end Team'));
    await producer.call({ operation: 'submit', summary: 'The reusable helper is proved.', declarations });
    producer.complete(); await idle(f.team);
    const deliveryId = f.team.archive.deliveries[0]!.id;
    await f.team.close();

    const draft = original.replace('end Team', 'theorem leadDraft : True := by trivial\nend Team');
    const notes = 'The consumer draft is saved before requesting the checked helper.';
    const stopping = deferred(), stopReceipt = deferred<StopReceipt>();
    const opened: MathAgentOptions[] = [];
    const modules = { ...directSolverModules, M1: { ...directSolverModules.M1,
      open: async (options: MathAgentOptions): Promise<MathAgentSession> => {
        const turn = opened.push(options), threadId = options.threadId ?? 'adoption-persistent-lead';
        return { threadId, usageSource: 'upstream-requests', close: async () => {}, interrupt: async () => {},
          stopForFreeze: async () => {
            if (turn !== 1) return { status: 'stopped' };
            stopping.resolve(); return stopReceipt.promise;
          },
          run: async (_message, id, _workspace, started) => {
            started(id);
            expect(options.requestGate!.checkpoint!()).toBe(false);
            const request = options.requestGate!({ requestId: `adoption-request-${turn}`, threadId });
            if (!request.allowed) throw new Error(request.reason);
            if (turn === 1) {
              fs.writeFileSync(f.source(f.state.worktree), draft);
              fs.writeFileSync(path.join(f.state.worktree, 'RESEARCH.md'), notes);
              const args = { operation: 'adopt', deliveryId };
              const context = { callId: 'adopt-helper', threadId, turnId: id, signal: f.controller.signal };
              const adoption = await options.tools!.call('theoremos_team', args, context);
              expect(adoption).toMatchObject({ ok: true, adoption: { status: 'queued' } });
              expect(await options.tools!.call('theoremos_team', args, context)).toEqual(adoption);
              // A pending response is never cancelled to obtain the writer.
              expect(options.requestGate!.checkpoint!()).toBe(false);
              request.settle({ complete: true, outcome: 'completed', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } });
              // The model tries to continue after adopt; the next admission must yield.
              expect(options.requestGate!.checkpoint!()).toBe(true);
              expect(options.requestGate!.checkpoint!()).toBe(true);
              expect(f.state.agentTeam!.adoptions).toHaveLength(1);
              expect(fs.readFileSync(f.source(f.state.worktree), 'utf8')).toBe(draft);
              return 'checkpoint';
            }
            expect(turn).toBe(2);
            expect(threadId).toBe('adoption-persistent-lead');
            expect(f.state.agentTeam!.adoptions[0]).toMatchObject({ status: 'completed', commit: expect.any(String) });
            const integrated = fs.readFileSync(f.source(f.state.worktree), 'utf8');
            expect(integrated).toContain(helper);
            expect(integrated).toContain('theorem leadDraft : True := by trivial');
            expect(fs.readFileSync(path.join(f.state.worktree, 'RESEARCH.md'), 'utf8')).toBe(notes);
            request.settle({ complete: true, outcome: 'completed', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } });
            fs.writeFileSync(f.source(f.state.worktree), integrated.replaceAll('by sorry', 'by trivial'));
            return 'completed';
          } };
      } } };
    const running = runResearchWorkers({ state: f.state, root: f.root, taskText: 'Prove both frozen statements.',
      workers: [{ id: 'solver', role: 'lead', worktree: f.state.worktree, ownedFiles: f.problem.ownedFiles }],
      access: new Map([['solver', { environment: f.environment,
        researchSkill: prepareResearchSkill(f.root, f.state.worktree, f.state.researchSkill!, f.problem), retrievalRoot: f.state.worktree }]]),
      modules, buildFile: path.join(f.directory, 'unused-build.json'), executable: 'offline-no-model', profile: 'offline-no-credentials',
      signal: f.controller.signal, deadline: Infinity, maxTurns: Infinity, maxTotalTokens: 0, maxTurnMs: Infinity,
      save: () => writeSolverRunState(f.stateFile, f.state), emit: (event, details) => { f.events.push({ event, details }); } });
    void running.catch(() => {});
    await Promise.race([stopping.promise, running.then(() => { throw new Error('adoption-skipped-writer-shutdown'); })]);
    try {
      expect(opened).toHaveLength(1);
      expect(f.state.agentTeam!.adoptions[0]!.status).toBe('queued');
      expect(fs.readFileSync(f.source(f.state.worktree), 'utf8')).toBe(draft);
    } finally { stopReceipt.resolve({ status: 'stopped' }); }
    const result = await running;
    expect(result?.check.verification.status).toBe('kernel_verified');
    expect(opened.map(options => options.threadId)).toEqual([undefined, 'adoption-persistent-lead']);
    expect(opened.every(options => options.turnCheckpointMs === undefined && options.turnTimeoutMs === undefined)).toBe(true);
    expect(f.state.tokenBudget).toMatchObject({ status: 'unlimited', usageComplete: true, reportedTotalTokens: 9 });
    expect(f.state.requestUsageAccounting).toMatchObject({ startedRequests: 2, reportedRequests: 2, pendingRequests: 0 });
    expect(f.events.filter(event => event.event === 'team_adoption_checkpoint')).toHaveLength(1);
    expect(f.events.filter(event => event.event === 'turn_checkpoint').map(event => event.details?.reason))
      .toEqual(['math_team_adoption_checkpoint']);
    expect(f.state.agentTeam!.adoptions.map(adoption => adoption.status)).toEqual(['completed']);
  }, 90_000);

  it('delivers a stopped fast writer while another researches, then freshly checks the Lead-selected adoption', async () => {
    const f = fixture();
    expect(await f.call({ operation: 'spawn', agentId: 'fast', message: 'Prove a reusable equality helper.' })).toMatchObject({ ok: true });
    expect(await f.call({ operation: 'spawn', agentId: 'slow', message: 'Continue an independent investigation.' })).toMatchObject({ ok: true });
    const fast = await f.session('fast'), slow = await f.session('slow');
    const fastWorker = f.team.archive.workers.find(item => item.id === 'fast')!;
    expect(fast.options).toMatchObject({ isolateProcess: true, threadId: undefined });
    expect(fast.options.hiddenRoots).toContain(f.state.worktree);
    expect(fast.options.tools!.definitions.map(item => item.name)).toContain('theoremos_team');
    expect(fast.options.tools!.definitions.find(item => item.name === 'theoremos_team')!.inputSchema)
      .toMatchObject({ properties: { operation: { enum: [
        'progress', 'yield', 'history', 'message', 'poll', 'wait', 'inspect', 'inspect-research', 'submit',
        'route_summary'] } } });
    expect(fast.options.skills![0]!.digest).toBe(f.state.researchSkill!.digest);
    const help = fs.readFileSync(path.join(fastWorker.worktree, RESEARCH_TOOL_HELP_FILE), 'utf8');
    expect(fast.options.instructions).toContain(path.join(fastWorker.worktree, RESEARCH_TOOL_HELP_FILE));
    expect(help).toMatch(/theoremos_team, operation submit/u);
    expect(help).not.toContain('declaration-submission.json');
    expect(help).not.toMatch(/successful check-lean[^\n]*hands writing back automatically/u);
    const deliveryWait = f.call({ operation: 'wait', after: 0, timeoutMs: 30_000 });
    fs.writeFileSync(f.source(fastWorker.worktree), original.replace('end Team', helper + 'end Team'));
    expect(await fast.call({ operation: 'submit', summary: 'Equality helper proved.', declarations }))
      .toMatchObject({ ok: true, status: 'pending-writer-stop' });
    fast.outcome.resolve('completed'); await fast.stopping.promise;
    expect(f.team.archive.deliveries).toHaveLength(0);
    expect(git(fastWorker.worktree, ['rev-parse', 'HEAD'])).toBe(fastWorker.seedCommit);
    fast.stopReceipt.resolve({ status: 'stopped' });
    await expect.poll(() => f.team.archive.deliveries.length, { timeout: 60_000 }).toBe(1);
    expect(fast.closed).toBe(true); expect(slow.closed).toBe(false);
    expect(f.team.archive.workers.find(item => item.id === 'slow')!.status).toBe('running');
    const delivery = f.team.archive.deliveries[0]!;
    const proof = readAgentTeamProofDelivery(delivery.path, f.state);
    expect(proof.artifacts[0]!.proof.verification.results[0]).toMatchObject({ status: 'kernel_verified', sorryCount: 0 });
    expect((await deliveryWait).events).toContainEqual(expect.objectContaining({ kind: 'delivery', from: 'fast' }));
    expect(await f.call({ operation: 'inspect', deliveryId: delivery.id })).toMatchObject({ ok: true,
      id: delivery.id, declarations, changes: [expect.objectContaining({ name: 'reusable', source: expect.stringContaining('by rfl') })],
      originalProblemAcceptance: 'not-assessed' });
    expect(await f.call({ operation: 'adopt', deliveryId: delivery.id, targetId: 'slow' }))
      .toMatchObject({ ok: false, error: 'math_team_target_writing' });
    expect(await f.call({ operation: 'adopt', deliveryId: delivery.id })).toMatchObject({ ok: true, adoption: { status: 'queued' } });
    expect(fs.readFileSync(f.source(f.state.worktree), 'utf8')).toBe(original);
    await f.team.flushAdoptions();
    const adopted = f.team.archive.adoptions[0]!;
    expect(adopted).toMatchObject({ targetId: 'lead', status: 'completed', commit: expect.any(String) });
    const merged = fs.readFileSync(f.source(f.state.worktree), 'utf8');
    expect(merged).toContain(helper); expect(merged.match(/by sorry/gu)).toHaveLength(2);
    expect(fs.readFileSync(f.source(f.team.archive.workers.find(item => item.id === 'slow')!.worktree), 'utf8')).toBe(original);
    expect(f.state.phase).toBe('running'); expect(f.state.check).toBeUndefined();
    slow.complete(); await idle(f.team);
    // An idle child can adopt a checked declaration and keep its independent source history.
    expect(await f.call({ operation: 'adopt', deliveryId: delivery.id, targetId: 'slow' }))
      .toMatchObject({ ok: true });
    await idle(f.team);
    expect(f.team.archive.adoptions.at(-1)!.status).toBe('completed');
    expect(fs.readFileSync(f.source(f.team.archive.workers.find(item => item.id === 'slow')!.worktree), 'utf8')).toContain(helper);
    await f.team.close();
    const saved = readSolverRunState(f.stateFile), restored = f.makeTeam(saved);
    await restored.restore();
    expect(restored.archive.deliveries).toEqual(f.team.archive.deliveries);
    expect(restored.archive.adoptions.map(adoption => adoption.status)).toEqual(['completed', 'completed']);
    expect(f.sessions).toHaveLength(2); expect(restored.hasActiveWorkers).toBe(false);
    expect(saved.check).toBeUndefined();
  }, 90_000);

  it('persists messages, resumes one native child thread, and does not replay completed tasks on restore', async () => {
    const f = fixture();
    const spawn = { operation: 'spawn', agentId: 'researcher', message: 'Profiles: D006, researcher\nInvestigate the interface.' };
    const firstHandle = await f.call(spawn, 'lead', 'spawn-once');
    expect(await f.call(spawn, 'lead', 'spawn-once')).toEqual(firstHandle);
    const first = await f.session('researcher');
    const profileRecord = (message: string) => JSON.parse(message.split('\n')
      .find(line => line.startsWith('{"schema":"theorem-os.agent-team-profile-evidence.v1"'))!);
    expect(profileRecord(first.message)).toMatchObject({ loaded: ['D006', 'researcher'], unresolved: [] });
    const firstWorker = f.team.archive.workers[0]!;
    expect(currentWorkerProject(firstWorker.worktree)).toBe(path.join(firstWorker.worktree, f.state.problem.projectRelative));
    expect(fs.existsSync(path.join(firstWorker.worktree, 'COOPERATION.json'))).toBe(false);
    expect(await f.call({ operation: 'message', agentId: 'researcher', message: 'Please keep the useful notes.' }))
      .toMatchObject({ ok: true, delivery: 'saved-inbox', notification: 'queued' });
    expect(first.notifications[0]).toContain('Please keep the useful notes.');
    const leadMessages: string[] = [];
    f.team.setLeadSession({ run: async () => 'completed', interrupt: async () => {}, close: async () => {},
      notify: async message => { leadMessages.push(message); } });
    expect(await first.call({ operation: 'message', agentId: 'lead', message: 'The interface needs a closed hypothesis.' }))
      .toMatchObject({ ok: true, delivery: 'saved-inbox', notification: 'queued' });
    expect(leadMessages).toEqual([expect.stringContaining('The interface needs a closed hypothesis.')]);
    f.team.setLeadSession({ run: async () => 'completed', interrupt: async () => {}, close: async () => {},
      notify: async () => { throw new Error('lead-turn-already-closed'); } });
    expect(await first.call({ operation: 'message', agentId: 'lead', message: 'Keep this message between turns.' }))
      .toMatchObject({ ok: true, delivery: 'saved-inbox' });
    expect((await f.call({ operation: 'poll' })).events).toContainEqual(expect.objectContaining({ text: 'Keep this message between turns.' }));
    expect((await first.call({ operation: 'poll' })).events).toContainEqual(expect.objectContaining({ text: 'Please keep the useful notes.' }));
    const worktree = f.team.archive.workers[0]!.worktree;
    fs.writeFileSync(path.join(worktree, 'RESEARCH.md'), 'A durable research note.');
    first.complete(); await idle(f.team); await f.team.close();
    const saved = readSolverRunState(f.stateFile);
    expect(saved.agentTeam!.workers[0]).toMatchObject({ threadId: first.threadId, tasks: [{ status: 'completed' }] });
    const resumed = f.makeTeam(saved); await resumed.restore();
    expect(f.sessions).toHaveLength(1); expect(resumed.hasActiveWorkers).toBe(false);
    expect(await f.call({ operation: 'message', agentId: 'researcher', message: 'New explicit assignment follows.' }, 'lead', undefined, resumed))
      .toMatchObject({ ok: true, delivery: 'saved-inbox' });
    expect(await f.call({ operation: 'assign', agentId: 'researcher', message: 'Profiles: D064, engineer\nUse your saved notes to continue.' }, 'lead', undefined, resumed))
      .toMatchObject({ ok: true });
    const second = await f.session('researcher', 1);
    expect(second.options.threadId).toBe(first.threadId); expect(second.threadId).toBe(first.threadId);
    expect(second.message).toContain('New explicit assignment follows.');
    expect(second.message).toContain('Use your saved notes to continue.');
    expect(profileRecord(second.message)).toMatchObject({ loaded: ['D064', 'engineer'], unresolved: [] });
    expect(second.message).not.toContain('Profile D006 (');
    expect(fs.readFileSync(path.join(worktree, 'RESEARCH.md'), 'utf8')).toBe('A durable research note.');
    second.complete(); await idle(resumed);
    expect(resumed.archive.workers[0]!.tasks.map(task => task.status)).toEqual(['completed', 'completed']);
    expect(resumed.archive.operations.filter(operation => operation.key.includes('spawn-once'))).toHaveLength(1);
  });

  it('publishes current research to new and resumed members and notifies a member already researching', async () => {
    const f = fixture();
    const firstSummary = 'Route A: the consumer needs a closed equality helper; boundary assumptions remain open.';
    const firstPublication = await f.call({ operation: 'publish', summary: firstSummary });
    expect(firstPublication).toMatchObject({ ok: true,
      researchState: { revision: 1, summary: firstSummary, publishedAt: expect.any(Number), advisory: true } });
    await f.call({ operation: 'spawn', agentId: 'child', message: 'Investigate the current shared route.' });
    const first = await f.session('child');
    expect(dispatchedAssignment(first.message).researchState).toMatchObject({ revision: 1, summary: firstSummary, advisory: true });

    const revisedSummary = 'Route A is blocked at its boundary case. Route B reuses the same equality interface.';
    expect(await f.call({ operation: 'publish', summary: revisedSummary })).toMatchObject({ ok: true,
      researchState: { revision: 2, summary: revisedSummary, advisory: true } });
    expect(first.notifications.some(message => message.includes('research-updated') && message.includes(revisedSummary))).toBe(true);
    const inbox = await first.call({ operation: 'poll' });
    expect(inbox.researchState).toMatchObject({ revision: 2, summary: revisedSummary, advisory: true });
    expect(inbox.events).toContainEqual(expect.objectContaining({ from: 'lead', to: 'child', kind: 'research-updated' }));
    first.complete(); await idle(f.team); await f.team.close();

    const saved = readSolverRunState(f.stateFile), resumed = f.makeTeam(saved);
    await resumed.restore();
    expect(f.sessions).toHaveLength(1);
    await f.call({ operation: 'assign', agentId: 'child', message: 'Continue from the revised route.' }, 'lead', undefined, resumed);
    const second = await f.session('child', 1);
    expect(second.threadId).toBe(first.threadId);
    expect(dispatchedAssignment(second.message).researchState).toMatchObject({ revision: 2, summary: revisedSummary, advisory: true });
    expect((await f.call({ operation: 'poll' }, 'lead', undefined, resumed)).researchState)
      .toMatchObject({ revision: 2, summary: revisedSummary });
    second.complete(); await idle(resumed);
    expect(saved.check).toBeUndefined();
  });

  it('shares paged non-Lean research at its stopped source commit while later edits remain private', async () => {
    const f = fixture();
    await f.call({ operation: 'spawn', agentId: 'researcher', message: 'Save an advisory obstruction without a formal declaration.' });
    const first = await f.session('researcher'), worker = f.team.archive.workers[0]!;
    const notes = '# Boundary calculation\n' + '同一假设下的计算仍需证明。\n'.repeat(25) + 'The missing premise is not established.\n';
    fs.writeFileSync(path.join(worker.worktree, 'RESEARCH.md'), notes);
    first.outcome.resolve('completed'); await first.stopping.promise;
    expect(worker.tasks[0]!.researchArtifactId).toBeUndefined();
    first.stopReceipt.resolve({ status: 'stopped' }); await idle(f.team);
    const completed = worker.tasks[0]!;
    expect(completed).toMatchObject({ status: 'completed', sourceCommit: expect.stringMatching(/^[a-f0-9]{40,64}$/u),
      researchArtifactId: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    const artifactId = completed.researchArtifactId!;
    expect(git(worker.worktree, ['show', `${completed.sourceCommit}:RESEARCH.md`])).toBe(notes.trim());
    expect(f.team.archive.deliveries).toHaveLength(0);
    const snapshot = await f.call({ operation: 'poll' });
    expect(snapshot.researchArtifacts).toContainEqual(expect.objectContaining({ id: artifactId,
      agentId: 'researcher', taskId: completed.id, commit: completed.sourceCommit }));
    expect(snapshot.researchArtifacts!.some(reference => Object.hasOwn(reference, 'path'))).toBe(false);

    const firstPage = await f.call({ operation: 'inspect-research', artifactId, offset: 0, limit: 31 });
    expect(firstPage).toMatchObject({ ok: true, id: artifactId, commit: completed.sourceCommit,
      advisory: true, originalProblemAcceptance: 'not-assessed',
      notes: { file: 'RESEARCH.md', text: notes.slice(0, 31), offset: 0, nextOffset: 31, truncated: true,
        bytes: Buffer.byteLength(notes), totalCharacters: notes.length, sha256: mathDigest(notes) } });
    expect(JSON.stringify(firstPage)).not.toContain(f.directory);
    await f.call({ operation: 'assign', agentId: 'researcher', message: 'Explore a revised assumption using the old note.' });
    const second = await f.session('researcher', 1);
    fs.writeFileSync(path.join(worker.worktree, 'RESEARCH.md'), 'A private revision with a different conclusion.');
    await f.call({ operation: 'spawn', agentId: 'consumer', message: 'Read the other member\'s fixed research evidence.' });
    const consumer = await f.session('consumer');
    expect(dispatchedAssignment(consumer.message).researchArtifacts)
      .toContainEqual(expect.objectContaining({ id: artifactId, commit: completed.sourceCommit }));
    let recovered = firstPage.notes!.text, offset = firstPage.notes!.nextOffset;
    while (offset !== undefined) {
      const page = await consumer.call({ operation: 'inspect-research', artifactId, offset, limit: 31 });
      expect(page).toMatchObject({ ok: true, commit: completed.sourceCommit, advisory: true });
      recovered += page.notes!.text; offset = page.notes!.nextOffset;
    }
    expect(recovered).toBe(notes);
    expect(await f.call({ operation: 'adopt', deliveryId: artifactId })).toMatchObject({ ok: false });
    expect(f.team.archive.adoptions).toHaveLength(0); expect(f.state.check).toBeUndefined();
    second.complete(); consumer.complete(); await idle(f.team); await f.team.close();
    const resumed = f.makeTeam(readSolverRunState(f.stateFile)); await resumed.restore();
    expect((await f.call({ operation: 'inspect-research', artifactId }, 'lead', undefined, resumed)).notes!.text).toBe(notes);
    expect(f.sessions).toHaveLength(3);
  });

  it('yields a draft, adopts a checked peer into it and resumes the same task before freshly checking the combined delivery', async () => {
    const f = fixture();
    await f.call({ operation: 'spawn', agentId: 'producer', message: 'Prove the reusable equality helper.' });
    await f.call({ operation: 'spawn', agentId: 'consumer', message: 'Prove Team.consumer using the forthcoming reusable helper.' });
    const producer = await f.session('producer'), consumer = await f.session('consumer');
    const producerWorker = f.team.archive.workers.find(worker => worker.id === 'producer')!;
    const consumerWorker = f.team.archive.workers.find(worker => worker.id === 'consumer')!;
    const task = consumerWorker.tasks[0]!, deliveryBase = task.seedCommit;
    const draft = 'theorem consumer (n : Nat) : n = n := by sorry\n';
    fs.writeFileSync(f.source(consumerWorker.worktree), original.replace('end Team', draft + 'end Team'));
    fs.writeFileSync(path.join(consumerWorker.worktree, 'RESEARCH.md'), 'Paused draft: waiting for the reusable helper.');
    expect(await consumer.call({ operation: 'yield', reason: 'Adopt the peer helper before continuing this draft.' }))
      .toMatchObject({ ok: true, taskId: task.id, status: 'pending-writer-stop' });
    consumer.outcome.resolve('completed'); await consumer.stopping.promise;
    expect(task.status).toBe('running'); expect(task.researchArtifactId).toBeUndefined();
    consumer.stopReceipt.resolve({ status: 'stopped' });
    fs.writeFileSync(f.source(producerWorker.worktree), original.replace('end Team', helper + 'end Team'));
    await producer.call({ operation: 'submit', summary: 'Reusable helper proved.', declarations });
    producer.complete(); await idle(f.team);
    expect(task).toMatchObject({ status: 'paused', turns: 1, pauseRequested: { kind: 'handoff' },
      sourceCommit: expect.any(String), researchArtifactId: expect.any(String) });
    const pausedArtifactId = task.researchArtifactId!, pausedCommit = task.sourceCommit!;
    expect((await f.call({ operation: 'poll' })).workers!.find(worker => worker.id === 'consumer'))
      .toMatchObject({ status: 'paused', activity: 'paused' });
    const peerDelivery = f.team.archive.deliveries[0]!;
    expect(await f.call({ operation: 'adopt', deliveryId: peerDelivery.id, targetId: 'consumer' })).toMatchObject({ ok: true });
    await idle(f.team);
    expect(consumerWorker.pendingSourceBase).toBe(deliveryBase);
    expect(consumerWorker.pendingPeerDeliveries).toEqual([peerDelivery.id]);
    expect(fs.readFileSync(f.source(consumerWorker.worktree), 'utf8')).toContain(draft);
    expect(fs.readFileSync(f.source(consumerWorker.worktree), 'utf8')).toContain(helper);

    expect(await f.call({ operation: 'resume', agentId: 'consumer', taskId: task.id })).toMatchObject({ ok: true, taskId: task.id });
    const resumed = await f.session('consumer', 1);
    expect(resumed.threadId).toBe(consumer.threadId); expect(resumed.messageId).toBe(task.id);
    expect(consumerWorker.tasks).toHaveLength(1); expect(task.turns).toBe(2);
    expect(dispatchedAssignment(resumed.message)).toMatchObject({ taskId: task.id,
      deliveryBaseCommit: deliveryBase, sourceCommit: git(consumerWorker.worktree, ['rev-parse', 'HEAD']) });
    // The proof author puts the adopted dependency before its consumer in Lean source order.
    const connected = fs.readFileSync(f.source(consumerWorker.worktree), 'utf8').replace(helper, '').replace(draft,
      helper + 'theorem consumer (n : Nat) : n = n := by exact reusable n\n');
    fs.writeFileSync(f.source(consumerWorker.worktree), connected);
    fs.writeFileSync(path.join(consumerWorker.worktree, 'RESEARCH.md'), 'Resumed draft: consumer now applies the adopted reusable helper.');
    const ownDeclarations = [{ file: 'Submission.lean', name: 'Team.consumer', type: '∀ n : Nat, n = n' }];
    await resumed.call({ operation: 'submit', summary: 'Consumer connected to the peer helper.', declarations: ownDeclarations });
    resumed.complete(); await idle(f.team);

    expect(task.declarations).toEqual(ownDeclarations);
    expect(task, JSON.stringify({ error: task.error, source: fs.readFileSync(f.source(consumerWorker.worktree), 'utf8') }))
      .toMatchObject({ status: 'completed', turns: 2, deliveryId: expect.any(String) });
    const combined = f.team.archive.deliveries.find(delivery => delivery.agentId === 'consumer')!;
    const checked = readAgentTeamProofDelivery(combined.path, f.state);
    expect(checked.seedCommit).toBe(deliveryBase);
    expect(checked.declarations).toEqual([...declarations, ...ownDeclarations]);
    expect(checked.artifacts.map(artifact => artifact.declaration.name).toSorted()).toEqual(['Team.consumer', 'Team.reusable']);
    expect(checked.artifacts.every(artifact => artifact.proof.passed && artifact.proof.verification.status === 'kernel_verified')).toBe(true);
    expect(consumerWorker.pendingPeerDeliveries).toBeUndefined(); expect(consumerWorker.pendingSourceBase).toBeUndefined();
    expect(task.researchArtifactId).not.toBe(pausedArtifactId); expect(task.sourceCommit).not.toBe(pausedCommit);
    expect(await f.call({ operation: 'inspect-research', artifactId: pausedArtifactId }))
      .toMatchObject({ commit: pausedCommit, notes: { text: 'Paused draft: waiting for the reusable helper.' } });
    expect(await f.call({ operation: 'inspect-research', artifactId: task.researchArtifactId }))
      .toMatchObject({ commit: task.sourceCommit, notes: { text: 'Resumed draft: consumer now applies the adopted reusable helper.' } });
    expect(f.team.archive.researchArtifacts!.filter(artifact => artifact.taskId === task.id)).toHaveLength(2);
    expect(f.state.check).toBeUndefined();
  }, 90_000);

  it('pauses a settled turn checkpoint and resumes the same saved task and thread with cumulative usage', async () => {
    const f = fixture({ maxTotalTokens: 100, maxTurns: 5 });
    await f.call({ operation: 'spawn', agentId: 'child', message: 'Develop a draft and retain useful partial work.',
      budget: { tokens: 50, turns: 2 } });
    const first = await f.session('child'), worker = f.team.archive.workers[0]!, task = worker.tasks[0]!;
    const deliveryBase = task.seedCommit;
    const settle = (session: typeof first, requestId: string, totalTokens: number) => {
      const admission = session.options.requestGate!({ requestId, threadId: session.threadId });
      expect(admission).toMatchObject({ allowed: true });
      if (!admission.allowed) throw new Error(admission.reason);
      admission.settle({ complete: true, outcome: 'completed', usage: { inputTokens: totalTokens - 2, outputTokens: 2, totalTokens } });
    };
    settle(first, 'checkpoint-request', 20);
    const draft = original.replace('end Team', 'theorem draft (n : Nat) : n = n := by sorry\nend Team');
    const notes = 'Saved partial work at the turn boundary; the same investigation remains open.';
    fs.writeFileSync(f.source(worker.worktree), draft);
    fs.writeFileSync(path.join(worker.worktree, 'RESEARCH.md'), notes);
    first.outcome.resolve('checkpoint'); await first.stopping.promise;
    expect(task).toMatchObject({ status: 'running', pauseRequested: { kind: 'budget', reason: 'math_team_turn_checkpoint' } });
    expect(task.researchArtifactId).toBeUndefined();
    expect(await f.call({ operation: 'resume', agentId: 'child', taskId: task.id }))
      .toMatchObject({ ok: false, error: 'math_team_task_not_paused' });

    first.stopReceipt.resolve({ status: 'stopped' }); await idle(f.team);
    expect(task).toMatchObject({ status: 'paused', turns: 1, budget: { tokens: 50, turns: 2 },
      sourceCommit: expect.any(String), researchArtifactId: expect.any(String) });
    expect(worker).toMatchObject({ status: 'paused', activity: 'paused', pendingSourceBase: deliveryBase });
    expect(worker.writerStopUnconfirmed).toBeUndefined(); expect(first.closed).toBe(true);
    expect(git(worker.worktree, ['show', `${task.sourceCommit}:${f.problem.projectRelative}/Submission.lean`])).toBe(draft.trim());
    expect((await f.call({ operation: 'inspect-research', artifactId: task.researchArtifactId })).notes!.text).toBe(notes);
    expect(readSolverRunState(f.stateFile).agentTeam!.workers[0]!.tasks[0])
      .toMatchObject({ id: task.id, status: 'paused', turns: 1, sourceCommit: task.sourceCommit });
    expect(f.state.taskUsage![task.id]!.totalTokens).toBe(20); expect(f.sessions).toHaveLength(1);

    expect(await f.call({ operation: 'resume', agentId: 'child', taskId: task.id })).toMatchObject({ ok: true, taskId: task.id });
    const second = await f.session('child', 1);
    expect(second.threadId).toBe(first.threadId); expect(second.messageId).toBe(task.id);
    expect(dispatchedAssignment(second.message)).toMatchObject({ taskId: task.id, deliveryBaseCommit: deliveryBase,
      sourceCommit: task.sourceCommit });
    expect(fs.readFileSync(f.source(worker.worktree), 'utf8')).toBe(draft);
    expect(fs.readFileSync(path.join(worker.worktree, 'RESEARCH.md'), 'utf8')).toBe(notes);
    expect(task).toMatchObject({ status: 'running', turns: 2, budget: { tokens: 50, turns: 2 } });
    expect(task.pauseRequested).toBeUndefined(); expect(f.state.taskUsage![task.id]!.totalTokens).toBe(20);
    settle(second, 'resumed-request', 5);
    second.complete(); await idle(f.team);
    expect(worker.tasks).toHaveLength(1); expect(task).toMatchObject({ status: 'completed', turns: 2 });
    expect(f.state.taskUsage![task.id]!.totalTokens).toBe(25);
    expect(f.state.tokenBudget).toMatchObject({ status: 'available', reportedTotalTokens: 25, usageComplete: true });
  });

  it('keeps an unlimited team free of invented task budgets while accounting for large input requests', async () => {
    const f = fixture({ maxTurns: Infinity, maxTurnMs: Infinity });
    const schema = f.team.tools().definitions[0]!.inputSchema;
    const properties = schema.properties as Record<string, { enum?: string[] }>;
    expect(properties.operation!.enum).not.toContain('budget');
    expect(properties).not.toHaveProperty('budget'); expect(properties).not.toHaveProperty('leadReserve');
    const invalid = { ok: false, error: 'math_team_budget_not_configured' };
    expect(await f.call({ operation: 'spawn', agentId: 'child', message: 'Work without a quota.', budget: { tokens: 25000 } }))
      .toMatchObject(invalid);
    expect(f.team.archive.workers).toHaveLength(0);
    expect(await f.call({ operation: 'budget', leadReserve: { tokens: 1000 } })).toMatchObject(invalid);
    expect(f.team.archive.leadReserve).toBeUndefined();

    expect(await f.call({ operation: 'spawn', agentId: 'child', message: 'Work without a quota.' })).toMatchObject({ ok: true });
    const first = await f.session('child'), worker = f.team.archive.workers[0]!, task = worker.tasks[0]!;
    expect(first.options.turnTimeoutMs).toBeUndefined(); expect(first.options.turnCheckpointMs).toBeUndefined();
    expect(await f.call({ operation: 'assign', agentId: 'child', message: 'Do not queue a capped task.', budget: { turns: 1 } }))
      .toMatchObject(invalid);
    expect(worker.tasks).toHaveLength(1); expect(task.budget).toBeUndefined();
    expect(await f.call({ operation: 'budget', agentId: 'child', taskId: task.id, budget: { tokens: 25000 } }))
      .toMatchObject(invalid);
    for (let request = 0; request < 3; request++) {
      const admission = first.options.requestGate!({ requestId: `large-input-${request}`, threadId: first.threadId });
      expect(admission.allowed).toBe(true);
      if (!admission.allowed) throw new Error(admission.reason);
      admission.settle({ complete: true, outcome: 'completed', usage: { inputTokens: 49500, outputTokens: 500, totalTokens: 50000 } });
    }
    expect(task).toMatchObject({ status: 'running', turns: 1 }); expect(task.pauseRequested).toBeUndefined();
    expect(f.state.tokenBudget).toMatchObject({ status: 'unlimited', maxTotalTokens: 0,
      reportedTotalTokens: 150000, usageComplete: true });
    expect(worker.requestUsageAccounting).toMatchObject({ startedRequests: 3, reportedRequests: 3, pendingRequests: 0, incomplete: false });
    first.complete(); await idle(f.team);
    expect(task.status).toBe('completed'); expect(task.budget).toBeUndefined();
  });

  it('retains older saved task caps as history without enforcing them in an unlimited run', async () => {
    const f = fixture({ maxTurns: Infinity });
    await f.call({ operation: 'spawn', agentId: 'child', message: 'Continue saved work.' });
    const first = await f.session('child'), worker = f.team.archive.workers[0]!, task = worker.tasks[0]!;
    // Stand in for the optional local cap retained in a historical run archive.
    task.budget = { tokens: 1, turns: 1 }; f.team.archive.leadReserve = { tokens: 100, turns: 1 };
    const admission = first.options.requestGate!({ requestId: 'saved-allowance' });
    if (!admission.allowed) throw new Error(admission.reason);
    admission.settle({ complete: true, outcome: 'completed', usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } });
    expect(await first.call({ operation: 'yield', reason: 'Wait for a peer dependency.' })).toMatchObject({ ok: true });
    first.complete(); await idle(f.team);
    expect(task.status).toBe('paused');
    const restoredState = readSolverRunState(f.stateFile);
    const restored = f.makeTeam(restoredState);
    expect(await f.call({ operation: 'resume', agentId: 'child', taskId: task.id }, 'lead', 'resume-unlimited', restored))
      .toMatchObject({ ok: true });
    const resumed = await f.session('child', 1), restoredTask = restored.archive.workers[0]!.tasks[0]!;
    expect(resumed.threadId).toBe(first.threadId);
    const next = resumed.options.requestGate!({ requestId: 'released-cap' });
    expect(next.allowed).toBe(true);
    if (!next.allowed) throw new Error(next.reason);
    next.settle({ complete: true, outcome: 'completed', usage: { inputTokens: 30000, outputTokens: 100, totalTokens: 30100 } });
    expect(restoredTask.pauseRequested).toBeUndefined();
    expect(restoredTask.budget).toEqual({ tokens: 1, turns: 1 });
    expect(restored.archive.leadReserve).toEqual({ tokens: 100, turns: 1 });
    const overview = await f.call({ operation: 'poll' }, 'lead', 'poll-unlimited', restored);
    expect(overview.budget).toMatchObject({ maxTurns: null, leadReserve: { tokens: 0, turns: 0 },
      remaining: { tokens: null, turns: null } });
    resumed.complete(); await idle(restored);
    expect(restoredTask.status).toBe('completed');
  });

  it('pauses at a cumulative task budget, resumes after Lead adjustment and retains the Lead turn reserve', async () => {
    const f = fixture({ maxTotalTokens: 100, maxTurns: 5 });
    expect(await f.call({ operation: 'budget', leadReserve: { tokens: 40, turns: 2 } })).toMatchObject({ ok: true });
    await f.call({ operation: 'spawn', agentId: 'child', message: 'Investigate within the allocated allowance.', budget: { tokens: 20, turns: 1 } });
    const first = await f.session('child'), worker = f.team.archive.workers[0]!, task = worker.tasks[0]!;
    const settle = (session: typeof first, requestId: string, totalTokens: number) => {
      const admission = session.options.requestGate!({ requestId, threadId: session.threadId });
      expect(admission).toMatchObject({ allowed: true });
      if (!admission.allowed) throw new Error(admission.reason);
      admission.settle({ complete: true, outcome: 'completed', usage: { inputTokens: totalTokens - 2, outputTokens: 2, totalTokens } });
    };
    settle(first, 'first-paid-request', 20);
    expect(first.options.requestGate!({ requestId: 'over-task-limit' })).toEqual({ allowed: false, reason: 'math_model_request_stopped' });
    expect(task.pauseRequested).toMatchObject({ kind: 'budget', reason: 'math_team_task_token_limit' });
    first.stopReceipt.resolve({ status: 'stopped' }); first.outcome.resolve('interrupted'); await idle(f.team);
    expect(task).toMatchObject({ status: 'paused', turns: 1, budget: { tokens: 20, turns: 1 } });
    expect(worker.requestUsageAccounting!.receipts).toHaveLength(1);
    expect(worker.requestUsageAccounting!.reportedRequests).toBe(1);
    expect(f.state.taskUsage![task.id]!.totalTokens).toBe(20);
    expect(await f.call({ operation: 'resume', agentId: 'child', taskId: task.id }))
      .toMatchObject({ ok: false, error: 'math_team_task_token_limit' });

    await f.call({ operation: 'budget', agentId: 'child', taskId: task.id, budget: { tokens: 30, turns: 2 } });
    await f.call({ operation: 'resume', agentId: 'child', taskId: task.id });
    const second = await f.session('child', 1);
    expect(second.threadId).toBe(first.threadId); expect(second.messageId).toBe(task.id); expect(task.turns).toBe(2);
    // The current turn may issue requests even though reserving it reached its own turn cap.
    settle(second, 'second-paid-request', 5);
    await second.call({ operation: 'yield', reason: 'Save the current evidence for Lead review.' });
    second.complete(); await idle(f.team);
    expect(await f.call({ operation: 'resume', agentId: 'child', taskId: task.id }))
      .toMatchObject({ ok: false, error: 'math_team_task_turn_limit' });
    await f.call({ operation: 'budget', agentId: 'child', taskId: task.id, budget: { tokens: 40, turns: 3 } });
    await f.call({ operation: 'resume', agentId: 'child', taskId: task.id });
    const third = await f.session('child', 2);
    expect(third.messageId).toBe(task.id); expect(task.turns).toBe(3);
    third.complete(); await idle(f.team);
    expect(worker.tasks).toHaveLength(1); expect(f.state.taskUsage![task.id]!.totalTokens).toBe(25);
    const queued = await f.call({ operation: 'assign', agentId: 'child', message: 'This next task must preserve Lead integration turns.',
      budget: { tokens: 10, turns: 1 } });
    await idle(f.team);
    const followup = worker.tasks.find(task => task.id === queued.taskId)!;
    expect(followup).toMatchObject({ status: 'paused', turns: 0, budget: { tokens: 10, turns: 1 },
      pauseRequested: { kind: 'budget', reason: 'math_team_lead_turn_reserve' } });
    expect(f.sessions).toHaveLength(3); expect(f.state.turns).toBe(3);
    expect(f.state.tokenBudget).toMatchObject({ status: 'available', reportedTotalTokens: 25 });
    expect((await f.call({ operation: 'poll' })).budget).toMatchObject({
      leadReserve: { tokens: 40, turns: 2 }, remaining: { tokens: 75, turns: 2 }, childRemaining: { tokens: 35, turns: 0 } });
  });

  it('pauses another child request at the Lead token reserve while preserving truthful provider receipts', async () => {
    const f = fixture({ maxTotalTokens: 50 });
    await f.call({ operation: 'budget', leadReserve: { tokens: 20, turns: 1 } });
    await f.call({ operation: 'spawn', agentId: 'child', message: 'Use the child allowance without spending the integration reserve.' });
    const first = await f.session('child'), worker = f.team.archive.workers[0]!, task = worker.tasks[0]!;
    const request = first.options.requestGate!({ requestId: 'observed-thirty' });
    expect(request.allowed).toBe(true);
    if (!request.allowed) throw new Error(request.reason);
    request.settle({ complete: true, outcome: 'completed', usage: { inputTokens: 25, outputTokens: 5, totalTokens: 30 } });
    expect(first.options.requestGate!({ requestId: 'must-remain-unstarted' })).toEqual({ allowed: false, reason: 'math_model_request_stopped' });
    first.stopReceipt.resolve({ status: 'stopped' }); first.outcome.resolve('interrupted'); await idle(f.team);
    expect(task).toMatchObject({ status: 'paused', turns: 1,
      pauseRequested: { kind: 'budget', reason: 'math_team_lead_token_reserve' } });
    expect(f.state.tokenBudget).toMatchObject({ status: 'available', usageComplete: true, reportedTotalTokens: 30 });
    expect(worker.requestUsageAccounting!.receipts!.map(receipt => receipt.requestId)).toEqual(['observed-thirty']);
    await f.call({ operation: 'budget', leadReserve: { tokens: 0, turns: 1 } });
    expect(await f.call({ operation: 'resume', agentId: 'child', taskId: task.id })).toMatchObject({ ok: true });
    const second = await f.session('child', 1);
    expect(second.threadId).toBe(first.threadId); expect(task.turns).toBe(2);
    second.complete(); await idle(f.team);
  });

  it('saves completed nominations with their pending delivery and recovers the earlier completion-before-pending format', async () => {
    const checking = deferred(), release = deferred(); let checks = 0;
    const f = fixture({ beforeCheck: async signal => {
      if (++checks === 1) {
        signal.addEventListener('abort', () => release.resolve(), { once: true });
        checking.resolve(); await release.promise;
      }
    } });
    await f.call({ operation: 'spawn', agentId: 'child', message: 'Prove the reusable helper and nominate it for checking.' });
    const child = await f.session('child'), worker = f.team.archive.workers[0]!, task = worker.tasks[0]!;
    fs.writeFileSync(f.source(worker.worktree), original.replace('end Team', helper + 'end Team'));
    fs.writeFileSync(path.join(worker.worktree, 'RESEARCH.md'), 'The nominated helper must be checked after recovery.');
    await child.call({ operation: 'submit', summary: 'Helper saved for independent checking.', declarations });
    child.complete(); await checking.promise;
    const nominations = f.snapshots.filter(snapshot => {
      const savedTask = snapshot.agentTeam?.workers[0]?.tasks[0];
      return savedTask?.status === 'completed' && savedTask.declarations?.length && !savedTask.deliveryId;
    });
    expect(nominations.length).toBeGreaterThan(0);
    for (const snapshot of nominations) {
      const savedWorker = snapshot.agentTeam!.workers[0]!, savedTask = savedWorker.tasks[0]!;
      expect(savedTask).toMatchObject({ sourceCommit: expect.any(String), researchArtifactId: expect.any(String) });
      expect(savedWorker.pendingDelivery).toMatchObject({ taskId: savedTask.id, seedCommit: savedTask.seedCommit, declarations });
      expect(snapshot.agentTeam!.researchArtifacts).toContainEqual(expect.objectContaining({ id: savedTask.researchArtifactId,
        commit: savedTask.sourceCommit, taskId: savedTask.id }));
    }
    const legacy = readSolverRunState(f.stateFile), legacyWorker = legacy.agentTeam!.workers[0]!;
    legacyWorker.pendingDelivery = undefined;
    expect(legacyWorker.tasks[0]).toMatchObject({ status: 'completed', declarations, researchArtifactId: expect.any(String) });
    release.resolve(); await idle(f.team); await f.team.close();
    expect(task.deliveryId).toBeDefined();

    const resumed = f.makeTeam(legacy); await resumed.restore();
    expect(f.sessions).toHaveLength(1); expect(resumed.hasActiveWorkers).toBe(false);
    expect(legacyWorker.pendingDelivery).toBeUndefined(); expect(legacyWorker.tasks[0]!.deliveryId).toBeDefined();
    expect(resumed.archive.deliveries).toHaveLength(1);
    const checked = readAgentTeamProofDelivery(resumed.archive.deliveries[0]!.path, legacy);
    expect(checked.declarations).toEqual(declarations);
    expect(checked.artifacts[0]!.proof.verification.status).toBe('kernel_verified');
  }, 90_000);

  it('reports checking, integrating and paused activity with request usage and recent execution evidence', async () => {
    const started = [deferred(), deferred()], release = [deferred(), deferred()]; let checks = 0;
    const f = fixture({ beforeCheck: async signal => {
      const index = checks++;
      if (index < 2) {
        signal.addEventListener('abort', () => release[index]!.resolve(), { once: true });
        started[index]!.resolve(); await release[index]!.promise;
      }
    } });
    try {
      await f.call({ operation: 'spawn', agentId: 'producer', message: 'Prove a helper whose checking will wait.' });
      await f.call({ operation: 'spawn', agentId: 'consumer', message: 'Pause until the peer helper is checked.' });
      const producer = await f.session('producer'), consumer = await f.session('consumer');
      const producerWorker = f.team.archive.workers.find(worker => worker.id === 'producer')!;
      const consumerWorker = f.team.archive.workers.find(worker => worker.id === 'consumer')!;
      producer.options.onActivity!({ event: 'command_output', itemType: 'commandExecution' });
      const paid = producer.options.requestGate!({ requestId: 'producer-check-cost' });
      if (!paid.allowed) throw new Error(paid.reason);
      paid.settle({ complete: true, outcome: 'completed', usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } });
      fs.writeFileSync(f.source(producerWorker.worktree), original.replace('end Team', helper + 'end Team'));
      await producer.call({ operation: 'submit', summary: 'A helper awaiting its real Lean check.', declarations });
      producer.complete();
      await consumer.call({ operation: 'yield', reason: 'Use the checked peer result before further writing.' });
      consumer.complete(); await started[0]!.promise;
      const waiting = (await f.call({ operation: 'poll' })).workers!;
      expect(waiting.find(worker => worker.id === 'producer')).toMatchObject({ activity: 'checking',
        pendingDelivery: { taskId: producerWorker.tasks[0]!.id, declarationCount: 1 },
        usage: { reportedTotalTokens: 10, usageComplete: true, reportedRequests: 1 },
        lastActivity: { event: 'command_output', itemType: 'commandExecution', at: expect.any(Number) } });
      await expect.poll(() => consumerWorker.status).toBe('paused');
      expect((await f.call({ operation: 'poll' })).workers!.find(worker => worker.id === 'consumer'))
        .toMatchObject({ status: 'paused', activity: 'paused' });
      release[0]!.resolve(); await idle(f.team);
      await f.call({ operation: 'adopt', deliveryId: f.team.archive.deliveries[0]!.id, targetId: 'consumer' });
      await started[1]!.promise;
      expect((await f.call({ operation: 'poll' })).workers!.find(worker => worker.id === 'consumer'))
        .toMatchObject({ status: 'paused', activity: 'integrating' });
      release[1]!.resolve(); await idle(f.team);
      expect((await f.call({ operation: 'poll' })).workers!.find(worker => worker.id === 'consumer'))
        .toMatchObject({ status: 'paused', activity: 'paused' });
    } finally { for (const gate of release) gate.resolve(); }
  }, 90_000);

  it('checks a recovered running nomination without replaying a model turn or inventing task completion', async () => {
    const f = fixture();
    await f.call({ operation: 'spawn', agentId: 'child', message: 'Save and submit a helper before the interrupted turn returns.' });
    const child = await f.session('child'), worker = f.team.archive.workers[0]!;
    fs.writeFileSync(f.source(worker.worktree), original.replace('end Team', helper + 'end Team'));
    fs.writeFileSync(path.join(worker.worktree, 'RESEARCH.md'), 'A submit acknowledgment precedes turn completion.');
    await child.call({ operation: 'submit', summary: 'Nominated source before the interrupted response finishes.', declarations });
    const checkpoint = readSolverRunState(f.stateFile), recoveredWorker = checkpoint.agentTeam!.workers[0]!;
    expect(recoveredWorker.tasks[0]).toMatchObject({ status: 'running', declarations, seedCommit: expect.any(String) });
    expect(recoveredWorker.pendingDelivery).toBeUndefined();
    const closing = f.team.close(); child.stopReceipt.resolve({ status: 'stopped' }); await closing;
    const saveIndex = f.snapshots.length;
    const resumed = f.makeTeam(checkpoint); await resumed.restore();

    expect(f.sessions).toHaveLength(1); expect(resumed.hasActiveWorkers).toBe(false);
    const task = recoveredWorker.tasks[0]!;
    expect(task).toMatchObject({ status: 'interrupted', deliveryId: expect.any(String),
      sourceCommit: expect.any(String), researchArtifactId: expect.any(String) });
    const firstInterrupted = f.snapshots.slice(saveIndex).find(snapshot => snapshot.agentTeam!.workers[0]!.tasks[0]!.status === 'interrupted')!;
    expect(firstInterrupted).toBeDefined();
    expect(firstInterrupted.agentTeam!.workers[0]!.pendingDelivery).toMatchObject({ taskId: task.id,
      seedCommit: task.seedCommit, declarations });
    expect(firstInterrupted.agentTeam!.workers[0]!.tasks[0]!.researchArtifactId).toBeDefined();
    expect(resumed.archive.deliveries).toHaveLength(1);
    const proof = readAgentTeamProofDelivery(resumed.archive.deliveries[0]!.path, checkpoint);
    expect(proof.declarations).toEqual(declarations);
    expect(proof.artifacts[0]!.proof.verification.status).toBe('kernel_verified');
    expect(checkpoint.check).toBeUndefined();
  }, 90_000);

  it('cancels only the selected queued task and does not replay it after restoring the member', async () => {
    const f = fixture();
    await f.call({ operation: 'spawn', agentId: 'child', message: 'Keep the current useful investigation.' });
    const first = await f.session('child'), worker = f.team.archive.workers[0]!;
    const obsolete = await f.call({ operation: 'assign', agentId: 'child', message: 'An obsolete follow-up.' });
    const useful = await f.call({ operation: 'assign', agentId: 'child', message: 'A complementary follow-up that remains useful.' });
    expect(await f.call({ operation: 'cancel', agentId: 'child', taskId: obsolete.taskId, reason: 'The interface changed.' }))
      .toMatchObject({ ok: true });
    expect(worker.tasks.map(task => task.status)).toEqual(['running', 'cancelled', 'queued']);
    expect(worker.tasks[1]!.cancelRequested).toMatchObject({ reason: 'The interface changed.' });
    expect(first.closed).toBe(false); expect(worker.status).toBe('running');
    first.complete();
    const second = await f.session('child', 1);
    expect(second.threadId).toBe(first.threadId); expect(second.messageId).toBe(useful.taskId);
    expect(second.messageId).not.toBe(obsolete.taskId);
    second.complete(); await idle(f.team); await f.team.close();
    const resumed = f.makeTeam(readSolverRunState(f.stateFile)); await resumed.restore();
    expect(f.sessions).toHaveLength(2); expect(resumed.hasActiveWorkers).toBe(false);
    expect(resumed.archive.workers[0]!.tasks.map(task => task.status)).toEqual(['completed', 'cancelled', 'completed']);
  });

  it('stops a cancelled task before replacing it in the same thread and retains its source draft and notes', async () => {
    const f = fixture();
    await f.call({ operation: 'spawn', agentId: 'child', message: 'Develop a draft for the old route.' });
    const first = await f.session('child'), worker = f.team.archive.workers[0]!, oldTask = worker.tasks[0]!;
    const draft = original.replace('end Team', helper + 'end Team');
    fs.writeFileSync(f.source(worker.worktree), draft);
    fs.writeFileSync(path.join(worker.worktree, 'RESEARCH.md'), 'Old route: equality helper saved; the wider claim remains open.');
    expect(await f.call({ operation: 'cancel', agentId: 'child', taskId: oldTask.id,
      reason: 'The consumer needs another route.', replacement: 'Continue the saved helper under the revised route.' }))
      .toMatchObject({ ok: true });
    await first.stopping.promise;
    expect(oldTask.cancelRequested).toMatchObject({ reason: 'The consumer needs another route.', replacementTaskId: expect.any(String) });
    const replacement = worker.tasks.find(task => task.id === oldTask.cancelRequested!.replacementTaskId)!;
    expect(replacement).toMatchObject({ status: 'queued', message: 'Continue the saved helper under the revised route.' });
    expect(f.sessions).toHaveLength(1); expect(first.closed).toBe(false);
    expect(oldTask.researchArtifactId).toBeUndefined();
    first.stopReceipt.resolve({ status: 'stopped' });
    const second = await f.session('child', 1);
    expect(first.closed).toBe(true); expect(oldTask.status).toBe('cancelled');
    expect(second.threadId).toBe(first.threadId); expect(second.messageId).toBe(replacement.id);
    expect(oldTask).toMatchObject({ sourceCommit: expect.any(String), researchArtifactId: expect.any(String) });
    expect(dispatchedAssignment(second.message).previousTask).toMatchObject({ id: oldTask.id, status: 'cancelled' });
    expect(fs.readFileSync(f.source(worker.worktree), 'utf8')).toBe(draft);
    expect(fs.readFileSync(path.join(worker.worktree, 'RESEARCH.md'), 'utf8')).toContain('Old route: equality helper saved');
    expect(worker.status).toBe('running');
    second.complete(); await idle(f.team); await f.team.close();
    const resumed = f.makeTeam(readSolverRunState(f.stateFile)); await resumed.restore();
    expect(f.sessions).toHaveLength(2); expect(resumed.archive.workers[0]!.status).not.toBe('stopped');
    expect(resumed.archive.workers[0]!.tasks.map(task => task.status)).toEqual(['cancelled', 'completed']);
  });

  it('cancels a completed model response still awaiting writer shutdown without publishing its submitted proof', async () => {
    const f = fixture();
    await f.call({ operation: 'spawn', agentId: 'child', message: 'Develop the helper on the old route.' });
    const first = await f.session('child'), worker = f.team.archive.workers[0]!, oldTask = worker.tasks[0]!;
    fs.writeFileSync(f.source(worker.worktree), original.replace('end Team', helper + 'end Team'));
    await first.call({ operation: 'submit', summary: 'Candidate from the superseded route.', declarations });
    first.outcome.resolve('completed'); await first.stopping.promise;
    const cancelled = await f.call({ operation: 'cancel', agentId: 'child', taskId: oldTask.id,
      replacement: 'Continue with the revised route.' });
    expect(cancelled).toMatchObject({ ok: true, status: 'stopping', replacementTaskId: expect.any(String) });
    expect(await f.call({ operation: 'cancel', agentId: 'child', taskId: oldTask.id,
      replacement: 'A retry must not create another task.' }))
      .toMatchObject({ ok: true, replacementTaskId: cancelled.replacementTaskId });
    expect(worker.tasks).toHaveLength(2); expect(worker.tasks[1]!.status).toBe('queued');
    expect(f.sessions).toHaveLength(1); expect(f.team.archive.deliveries).toHaveLength(0);
    first.stopReceipt.resolve({ status: 'stopped' });
    const second = await f.session('child', 1);
    expect(oldTask.status).toBe('cancelled'); expect(second.messageId).toBe(cancelled.replacementTaskId);
    expect(second.threadId).toBe(first.threadId);
    expect(f.team.archive.deliveries).toHaveLength(0); expect(worker.pendingDelivery).toBeUndefined();
    expect((await f.call({ operation: 'inspect-research', artifactId: oldTask.researchArtifactId })).advisory).toBe(true);
    second.complete(); await idle(f.team);
  });

  it('restores an in-flight cancellation without replaying the old task or duplicating its queued replacement', async () => {
    const f = fixture();
    await f.call({ operation: 'spawn', agentId: 'child', message: 'Investigate the obsolete route.' });
    const first = await f.session('child'), worker = f.team.archive.workers[0]!;
    const draft = original.replace('end Team', helper + 'end Team');
    fs.writeFileSync(f.source(worker.worktree), draft);
    fs.writeFileSync(path.join(worker.worktree, 'RESEARCH.md'), 'A saved draft survives the cancellation checkpoint.');
    await f.call({ operation: 'cancel', agentId: 'child', taskId: worker.tasks[0]!.id,
      reason: 'Superseded route.', replacement: 'Use the saved draft on the replacement route.' });
    await first.stopping.promise;
    // Capture the durable crash checkpoint while the writer still has to confirm shutdown.
    const checkpoint = readSolverRunState(f.stateFile), checkpointWorker = checkpoint.agentTeam!.workers[0]!;
    expect(checkpointWorker.tasks[0]).toMatchObject({ status: 'running', cancelRequested: {
      replacementTaskId: checkpointWorker.tasks[1]!.id } });
    expect(checkpointWorker.tasks[1]!.status).toBe('queued');
    const closing = f.team.close(); first.stopReceipt.resolve({ status: 'stopped' }); await closing;

    const resumed = f.makeTeam(checkpoint); await resumed.restore();
    const replacement = await f.session('child', 1);
    expect(replacement.threadId).toBe(first.threadId);
    expect(replacement.messageId).toBe(checkpointWorker.tasks[1]!.id);
    expect(checkpointWorker.tasks).toHaveLength(2);
    expect(checkpointWorker.tasks[0]).toMatchObject({ status: 'cancelled', sourceCommit: expect.any(String),
      researchArtifactId: expect.any(String) });
    expect(f.sessions.filter(session => session.messageId === checkpointWorker.tasks[0]!.id)).toHaveLength(1);
    expect(fs.readFileSync(f.source(checkpointWorker.worktree), 'utf8')).toBe(draft);
    expect((await f.call({ operation: 'inspect-research', artifactId: checkpointWorker.tasks[0]!.researchArtifactId },
      'lead', undefined, resumed)).notes!.text).toBe('A saved draft survives the cancellation checkpoint.');
    replacement.complete(); await idle(resumed);
  });

  it('quarantines a cancelled writer with unconfirmed shutdown before publishing research or starting its replacement', async () => {
    const f = fixture();
    await f.call({ operation: 'spawn', agentId: 'child', message: 'Develop a candidate helper.' });
    const child = await f.session('child'), worker = f.team.archive.workers[0]!;
    fs.writeFileSync(f.source(worker.worktree), original.replace('end Team', helper + 'end Team'));
    fs.writeFileSync(path.join(worker.worktree, 'RESEARCH.md'), 'This draft still has a writer whose shutdown is unconfirmed.');
    await child.call({ operation: 'submit', summary: 'Candidate pending host checking.', declarations });
    await f.call({ operation: 'cancel', agentId: 'child', taskId: worker.tasks[0]!.id,
      replacement: 'Continue only after the previous writer is proven stopped.' });
    await child.stopping.promise;
    child.stopReceipt.resolve({ status: 'unconfirmed', reason: 'cancelled-writer-not-stopped' });
    await idle(f.team);
    expect(worker.writerStopUnconfirmed).toMatchObject({ reason: 'cancelled-writer-not-stopped' });
    expect(worker.tasks[0]!.researchArtifactId).toBeUndefined();
    expect(worker.tasks[1]!.status).toBe('queued');
    expect(f.team.archive.deliveries).toHaveLength(0); expect(f.sessions).toHaveLength(1);
    expect(git(worker.worktree, ['rev-parse', 'HEAD'])).toBe(worker.seedCommit);
    await expect(f.team.close()).rejects.toThrow('math_writer_stop_unconfirmed:child');
    const resumed = f.makeTeam(readSolverRunState(f.stateFile));
    await expect(resumed.restore()).rejects.toThrow('math_writer_stop_unconfirmed:child');
    expect(f.sessions).toHaveLength(1);
  });

  it('keeps messages and stop responsive while an idle child adoption waits for Lean', async () => {
    const checkStarted = deferred(), releaseCheck = deferred(); let checks = 0;
    const f = fixture({ beforeCheck: async signal => {
      if (++checks === 2) {
        signal.addEventListener('abort', () => releaseCheck.resolve(), { once: true });
        checkStarted.resolve(); await releaseCheck.promise;
      }
    } });
    await f.call({ operation: 'spawn', agentId: 'producer', message: 'Prove the reusable helper.' });
    await f.call({ operation: 'spawn', agentId: 'consumer', message: 'Investigate before receiving the helper.' });
    const producer = await f.session('producer'), consumer = await f.session('consumer');
    fs.writeFileSync(f.source(f.team.archive.workers.find(worker => worker.id === 'producer')!.worktree),
      original.replace('end Team', helper + 'end Team'));
    await producer.call({ operation: 'submit', summary: 'Reusable helper ready.', declarations });
    producer.complete(); consumer.complete(); await idle(f.team);
    const deliveryId = f.team.archive.deliveries[0]!.id;
    const adopting = f.call({ operation: 'adopt', deliveryId, targetId: 'consumer' });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await checkStarted.promise;
      const interactions = Promise.all([adopting,
        f.call({ operation: 'message', agentId: 'consumer', message: 'This update must not wait for Lean.' }),
        f.call({ operation: 'stop', agentId: 'consumer' })]);
      const results = await Promise.race([interactions, new Promise<undefined>(resolve => { timer = setTimeout(resolve, 1000); })]);
      expect(results, 'slow Lean integration must release the team mutation queue').toBeDefined();
      expect(results?.map(result => result.ok)).toEqual([true, true, true]);
      expect(f.team.archive.events).toContainEqual(expect.objectContaining({ to: 'consumer', text: 'This update must not wait for Lean.' }));
    } finally { clearTimeout(timer); releaseCheck.resolve(); await adopting; }
    await idle(f.team);
    expect(f.team.archive.workers.find(worker => worker.id === 'consumer')!.status).toBe('stopped');
    expect(f.sessions.filter(session => session.id === 'consumer')).toHaveLength(1);
  }, 90_000);

  it('rejects child scheduling and adoption, altered call replay, and delivery by the Lead', async () => {
    const f = fixture();
    expect(f.team.tools('lead').definitions.find(item => item.name === 'theoremos_team')!.inputSchema)
      .toMatchObject({ properties: { operation: { enum: [
        'spawn', 'assign', 'amend', 'finish', 'budget', 'resume', 'history', 'publish', 'cancel',
        'message', 'poll', 'wait', 'inspect', 'inspect-research', 'adopt', 'stop', 'retire_route', 'route_summary'] } } });
    const spawn = { operation: 'spawn', agentId: 'child', message: 'Study independently.' };
    await f.call(spawn, 'lead', 'one-handle');
    const child = await f.session('child');
    await expect(f.call({ ...spawn, message: 'Different replay.' }, 'lead', 'one-handle')).rejects.toThrow('math_team_call_changed');
    expect(await child.call({ operation: 'spawn', agentId: 'intruder', message: 'Unauthorized assignment.' }))
      .toMatchObject({ ok: false, error: 'math_team_lead_operation_required' });
    expect(await child.call({ operation: 'adopt', deliveryId: 'a'.repeat(64) }))
      .toMatchObject({ ok: false, error: 'math_team_lead_operation_required' });
    expect(await child.call({ operation: 'publish', summary: 'A child cannot replace the shared route.' }))
      .toMatchObject({ ok: false, error: 'math_team_lead_operation_required' });
    expect(await child.call({ operation: 'cancel', agentId: 'child', taskId: f.team.archive.workers[0]!.tasks[0]!.id }))
      .toMatchObject({ ok: false, error: 'math_team_lead_operation_required' });
    expect(await f.call({ operation: 'submit', summary: 'Lead is not a child.', declarations }))
      .toMatchObject({ ok: false, error: 'math_team_child_submission_required' });
    expect(f.team.archive.workers.map(worker => worker.id)).toEqual(['child']);
    expect(fs.readFileSync(f.source(f.state.worktree), 'utf8')).toBe(original);
    child.complete(); await idle(f.team);
  });

  it('restores an explicitly queued follow-up without replaying the completed turn ahead of it', async () => {
    const f = fixture();
    await f.call({ operation: 'spawn', agentId: 'child', message: 'First assignment.' });
    const first = await f.session('child');
    first.outcome.resolve('completed'); await first.stopping.promise;
    await f.call({ operation: 'assign', agentId: 'child', message: 'The already authorized follow-up.' });
    const closing = f.team.close();
    first.stopReceipt.resolve({ status: 'stopped' }); await closing;
    const saved = readSolverRunState(f.stateFile);
    expect(saved.agentTeam!.workers[0]!.tasks.map(task => task.status)).toEqual(['completed', 'queued']);
    const resumed = f.makeTeam(saved); await resumed.restore();
    const second = await f.session('child', 1);
    expect(second.options.threadId).toBe(first.threadId);
    expect(second.message).toContain('The already authorized follow-up.');
    expect(saved.agentTeam!.workers[0]!.tasks.map(task => task.status)).toEqual(['completed', 'running']);
    second.complete(); await idle(resumed);
    expect(f.sessions).toHaveLength(2);
    expect(saved.agentTeam!.workers[0]!.tasks.map(task => task.status)).toEqual(['completed', 'completed']);
  });

  it.each(['invalid-proof', 'undeclared-helper', 'missing-name', 'outside-ownership'] as const)('reports %s as correctable feedback without publishing a delivery', async kind => {
    const f = fixture();
    await f.call({ operation: 'spawn', agentId: 'child', message: 'Prove a reusable helper.' });
    const child = await f.session('child'), worktree = f.team.archive.workers[0]!.worktree;
    const addition = kind === 'invalid-proof' ? helper.replace('by rfl', 'by exact False.elim (by trivial)')
      : kind === 'undeclared-helper' ? helper + 'theorem unlisted : True := by trivial\n' : helper;
    fs.writeFileSync(f.source(worktree), original.replace('end Team', addition + 'end Team'));
    const submission = await child.call({ operation: 'submit', summary: 'Candidate helper.', declarations: kind === 'missing-name'
      ? [{ ...declarations[0], name: 'Team.missing' }] : kind === 'outside-ownership'
        ? [{ ...declarations[0], file: 'NotOwned.lean' }] : declarations });
    if (kind === 'outside-ownership') {
      expect(submission).toMatchObject({ ok: false, error: 'math_agent_team_proof_declaration_outside_ownership' });
      expect(f.team.archive.workers[0]!.tasks[0]!.declarations).toBeUndefined();
    }
    child.complete(); await idle(f.team);
    expect(f.team.archive.deliveries).toHaveLength(0);
    expect(f.team.archive.workers[0]!.pendingDelivery).toBeUndefined();
    if (kind !== 'outside-ownership') expect(f.team.archive.events).toContainEqual(expect.objectContaining({ from: 'child', to: 'lead', kind: 'failed',
      text: expect.stringContaining({ 'invalid-proof': 'math_declaration_artifact_check_failed',
        'undeclared-helper': 'undeclared_source_change', 'missing-name': 'declaration_missing',
        'outside-ownership': 'declaration_outside_ownership' }[kind]) }));
    expect(fs.readFileSync(f.source(f.state.worktree), 'utf8')).toBe(original);
    expect(f.state.check).toBeUndefined();
  }, 90_000);

  it.each(['rejected', 'deferred'] as const)('transfers saved sources after a %s delivery is corrected in the same child thread', async kind => {
    const f = fixture();
    await f.call({ operation: 'spawn', agentId: 'child', message: 'Develop the reusable helper.' });
    const first = await f.session('child'), worker = f.team.archive.workers[0]!;
    const initial = kind === 'rejected' ? helper.replace('by rfl', 'by exact False.elim (by trivial)') : helper;
    fs.writeFileSync(f.source(worker.worktree), original.replace('end Team', initial + 'end Team'));
    if (kind === 'rejected') await first.call({ operation: 'submit', summary: 'Candidate helper.', declarations });
    first.complete(); await idle(f.team);
    expect(f.team.archive.deliveries).toHaveLength(0);
    expect(worker.pendingSourceBase).toBe(worker.tasks[0]!.seedCommit);
    const previousTask = worker.tasks[0]!, leadDiagnostic = 'lead-only-failure-unrelated-to-this-child';
    if (kind === 'rejected') {
      expect(previousTask.error).toContain('math_declaration_artifact_check_failed');
      const commit = git(f.state.worktree, ['rev-parse', 'HEAD']), checkedAt = Date.now();
      f.state.check = { commit, sourceDigest: mathDigest(original), passed: false, verification: {
        schema: 'deepscientist.mathematics.verification-batch/v1', sessionId: 'lead-check', status: 'failed', targetCommit: commit,
        results: [{ status: 'failed', targetCommit: commit, statementHash: mathDigest(f.problem.contract.formalStatement),
          claim: 'statement', proofHash: mathDigest(original), proofPath: 'Submission.lean', theoremName: f.problem.targets[0]!.theoremName,
          statementBinding: 'caller-bound-to-committed-declaration', toolchain: { lean: path.join(f.environment.PATH.split(':')[0]!, 'lean') },
          verifier: 'lean-kernel', goalsRemaining: 1, sorryCount: 1, admitCount: 0, axioms: [], checkedAt,
          checkId: 'lead-check-1', receiptId: 'lead-failure-receipt', sessionId: 'lead-check', error: 'lean_compilation_failed',
          stdoutPreview: `Submission.lean:2:1: error: ${leadDiagnostic}\n` }],
        events: [], startedAt: checkedAt, checkedAt, durationMs: 0,
      } };
    }
    const objective = 'Finish the saved helper and submit its exact declaration.';
    await f.call({ operation: 'assign', agentId: 'child', message: objective });
    const second = await f.session('child', 1);
    expect(second.options.threadId).toBe(first.threadId);
    expect(worker.tasks[1]!.seedCommit).toBe(worker.tasks[0]!.seedCommit);
    const assignment = dispatchedAssignment(second.message);
    expect(assignment).toMatchObject({ agentId: 'child', coordinator: 'lead', taskId: worker.tasks[1]!.id, objective,
      sourceCommit: git(worker.worktree, ['rev-parse', 'HEAD']), deliveryBaseCommit: worker.pendingSourceBase,
      previousTask: { id: previousTask.id, status: kind === 'rejected' ? 'failed' : 'completed', summary: previousTask.summary } });
    expect(second.messageId).toBe(assignment.taskId);
    expect(assignment.previousTask.error).toBe(previousTask.error);
    expect(second.message).not.toContain(leadDiagnostic);
    expect(fs.readFileSync(f.source(worker.worktree), 'utf8')).toContain(initial);
    if (kind === 'rejected') expect(readSolverRunState(f.stateFile).check).toEqual(f.state.check);
    fs.writeFileSync(f.source(worker.worktree), original.replace('end Team', helper + 'end Team'));
    await second.call({ operation: 'submit', summary: 'The equality helper is ready.', declarations });
    second.complete(); await idle(f.team);
    expect(worker.pendingSourceBase).toBeUndefined(); expect(worker.pendingDelivery).toBeUndefined();
    expect(f.team.archive.deliveries).toHaveLength(1);
    await f.call({ operation: 'adopt', deliveryId: f.team.archive.deliveries[0]!.id });
    await f.team.flushAdoptions();
    expect(f.team.archive.adoptions[0]).toMatchObject({ status: 'completed' });
    expect(fs.readFileSync(f.source(f.state.worktree), 'utf8')).toContain(helper);
    expect(f.state.check).toBeUndefined();
  }, 90_000);

  it('charges children to one request budget and refuses later dispatch once their receipts exhaust it', async () => {
    const f = fixture({ maxTotalTokens: 50 });
    await f.call({ operation: 'spawn', agentId: 'first', message: 'First independent investigation.' });
    await f.call({ operation: 'spawn', agentId: 'second', message: 'Second independent investigation.' });
    const first = await f.session('first'), second = await f.session('second');
    for (const [index, session] of [first, second].entries()) {
      const admission = session.options.requestGate!({ requestId: `request-${index}`, threadId: session.threadId });
      expect(admission).toMatchObject({ allowed: true });
      if (!admission.allowed) throw new Error(admission.reason);
      const totalTokens = index === 0 ? 20 : 30;
      const receipt = { usage: { inputTokens: totalTokens - 2, outputTokens: 2, totalTokens }, complete: true, outcome: 'completed' as const };
      admission.settle(receipt); admission.settle(receipt);
    }
    expect(f.state.teamUsage).toMatchObject({ totalTokens: 50, inputTokens: 46, outputTokens: 4 });
    expect(f.state.tokenBudget).toMatchObject({ status: 'exhausted', reportedTotalTokens: 50, reason: 'math_total_token_limit' });
    expect(first.options.requestGate!({ requestId: 'too-late' })).toEqual({ allowed: false, reason: 'math_total_token_limit' });
    first.complete(); second.complete(); await idle(f.team);
    expect(f.team.archive.workers.map(worker => worker.requestUsageAccounting!.reportedRequests)).toEqual([1, 1]);
    expect(f.state.tokenBudget!.usageComplete).toBe(true);
    await f.call({ operation: 'assign', agentId: 'first', message: 'This assignment must await another authorized budget.' });
    await idle(f.team); expect(f.sessions).toHaveLength(2);
    expect(f.team.archive.workers[0]!.tasks.at(-1)!.status).toBe('queued');
  });

  it('retries an infrastructure-interrupted adoption with its original expected commit', async () => {
    let checks = 0;
    const f = fixture({ beforeCheck: async () => {
      if (++checks === 2) throw new DeclarationArtifactCheckError(declarations[0], {
        status: 'unavailable', results: [{ status: 'unavailable', error: 'offline-lean-infrastructure-unavailable' }],
      } as never);
    } });
    await f.call({ operation: 'spawn', agentId: 'child', message: 'Prove the equality helper.' });
    const child = await f.session('child'), worker = f.team.archive.workers[0]!;
    fs.writeFileSync(f.source(worker.worktree), original.replace('end Team', helper + 'end Team'));
    await child.call({ operation: 'submit', summary: 'Reusable equality proof.', declarations });
    child.complete(); await idle(f.team);
    await f.call({ operation: 'adopt', deliveryId: f.team.archive.deliveries[0]!.id });
    await expect(f.team.flushAdoptions()).rejects.toThrow('offline-lean-infrastructure-unavailable');
    const adoption = f.team.archive.adoptions[0]!;
    const expectedCommit = adoption.expectedCommit;
    expect(adoption.status).toBe('integrating');
    expect(fs.readFileSync(f.source(f.state.worktree), 'utf8')).toBe(original);
    await f.team.flushAdoptions();
    expect(adoption).toMatchObject({ status: 'completed', expectedCommit, error: undefined });
    expect(fs.readFileSync(f.source(f.state.worktree), 'utf8')).toContain(helper);
    expect(f.state.check).toBeUndefined();
  }, 90_000);

  it.each(['assign', 'adopt'] as const)('finishes a pending child adoption before %s may continue research', async operation => {
    const checkStarted = deferred(), releaseCheck = deferred(); let checks = 0;
    const f = fixture({ beforeCheck: async signal => {
      if (++checks === 2) throw new Error('offline-integration-infrastructure-unavailable');
      if (checks === 3) {
        signal.addEventListener('abort', () => releaseCheck.resolve(), { once: true });
        checkStarted.resolve(); await releaseCheck.promise;
      }
    } });
    await f.call({ operation: 'spawn', agentId: 'producer', message: 'Prove a reusable helper.' });
    await f.call({ operation: 'spawn', agentId: 'consumer', message: 'Investigate before receiving the helper.' });
    const producer = await f.session('producer'), consumer = await f.session('consumer');
    const producerWorker = f.team.archive.workers.find(item => item.id === 'producer')!;
    const consumerWorker = f.team.archive.workers.find(item => item.id === 'consumer')!;
    fs.writeFileSync(f.source(producerWorker.worktree), original.replace('end Team', helper + 'end Team'));
    await producer.call({ operation: 'submit', summary: 'Helper ready for another researcher.', declarations });
    producer.complete(); consumer.complete(); await idle(f.team);
    const deliveryId = f.team.archive.deliveries[0]!.id;
    expect(await f.call({ operation: 'adopt', deliveryId, targetId: 'consumer' }))
      .toMatchObject({ ok: true });
    await idle(f.team);
    const adoption = f.team.archive.adoptions[0]!;
    const expectedCommit = adoption.expectedCommit;
    expect(adoption.status).toBe('integrating');
    const assignment = { operation: 'assign', agentId: 'consumer', message: 'Continue using the checked helper.' };
    const continuation = f.call(operation === 'assign' ? assignment : { operation: 'adopt', deliveryId, targetId: 'consumer' });
    await checkStarted.promise;
    expect(f.sessions).toHaveLength(2);
    expect(adoption).toMatchObject({ status: 'integrating', expectedCommit });
    expect(fs.readFileSync(f.source(consumerWorker.worktree), 'utf8')).toBe(original);
    if (operation === 'assign') expect(consumerWorker.tasks.at(-1)!.status).toBe('queued');
    releaseCheck.resolve();
    expect(await continuation).toMatchObject({ ok: true });
    if (operation === 'adopt') await f.call(assignment);
    const resumed = await f.session('consumer', 1);
    expect(adoption).toMatchObject({ status: 'completed', expectedCommit, error: undefined });
    expect(resumed.threadId).toBe(consumer.threadId);
    expect(fs.readFileSync(f.source(consumerWorker.worktree), 'utf8')).toContain(helper);
    expect(f.team.archive.adoptions).toHaveLength(1);
    resumed.complete(); await idle(f.team);
  }, 90_000);

  it('accepts a restored completed adoption before admitting another model turn', async () => {
    const f = fixture();
    await f.call({ operation: 'spawn', agentId: 'child', message: 'Prove both original declarations.' });
    const child = await f.session('child'), worker = f.team.archive.workers[0]!;
    fs.writeFileSync(f.source(worker.worktree), original.replaceAll('by sorry', 'by trivial'));
    await child.call({ operation: 'submit', summary: 'Both original declarations proved.', declarations: [
      { file: 'Submission.lean', name: 'Team.original', type: 'True' },
      { file: 'Submission.lean', name: 'Team.other', type: 'True' },
    ] });
    child.complete(); await idle(f.team);
    await f.call({ operation: 'adopt', deliveryId: f.team.archive.deliveries[0]!.id });
    await f.team.flushAdoptions(); await f.team.close();
    const state = readSolverRunState(f.stateFile);
    expect(state.check).toBeUndefined();
    expect(state.pendingResearchFreeze).toMatchObject({ commit: state.agentTeam!.adoptions[0]!.commit });
    let modelCalls = 0;
    const resumedSkill = prepareResearchSkill(f.root, state.worktree, state.researchSkill!, f.problem);
    const result = await runResearchWorkers({ state, root: f.root, taskText: 'Prove both frozen statements.',
      workers: [{ id: 'solver', role: 'lead', worktree: state.worktree, ownedFiles: f.problem.ownedFiles }],
      access: new Map([['solver', { environment: f.environment, researchSkill: resumedSkill, retrievalRoot: state.worktree }]]),
      modules: { ...directSolverModules, M1: { ...directSolverModules.M1, open: async () => {
        modelCalls++; throw new Error('unexpected-model-after-frozen-adoption');
      } } },
      buildFile: path.join(f.directory, 'unneeded-build.json'), executable: 'offline-no-model', profile: 'offline-no-credentials',
      signal: f.controller.signal, deadline: Infinity, maxTurns: state.turns, maxTotalTokens: 0, maxTurnMs: Infinity,
      save: () => writeSolverRunState(f.stateFile, state), emit: () => {},
    });
    expect(modelCalls).toBe(0);
    expect(result?.check.verification.status).toBe('kernel_verified');
    expect(result?.check.verification.results).toHaveLength(2);
    expect(state.pendingResearchFreeze).toBeUndefined(); expect(state.pendingProofCheck).toBeUndefined();
    expect(state.turns).toBe(1);
  }, 90_000);

  it('releases a shared turn reservation after opening a child session fails', async () => {
    const f = fixture({ maxTotalTokens: 50, beforeOpen: async (_options, attempt) => {
      if (attempt === 1) throw new Error('offline-native-session-open-failed');
    } });
    await f.call({ operation: 'spawn', agentId: 'child', message: 'First opening fails before any model turn.' });
    await idle(f.team);
    expect(f.opened).toHaveLength(1); expect(f.sessions).toHaveLength(0);
    expect(f.state.turns).toBe(0); expect(f.team.archive.workers[0]!.turns).toBe(0);
    expect(f.team.archive.workers[0]!.tasks[0]).toMatchObject({ status: 'failed', error: 'offline-native-session-open-failed' });
    expect(f.state.tokenBudget).toMatchObject({ status: 'available', usageComplete: true, reportedTotalTokens: 0 });
    await f.call({ operation: 'assign', agentId: 'child', message: 'Explicitly retry after the opening failure.' });
    const child = await f.session('child');
    expect(f.state.turns).toBe(1); expect(f.team.archive.workers[0]!.turns).toBe(1);
    child.complete(); await idle(f.team);
    expect(f.opened).toHaveLength(2);
    expect(f.team.archive.workers[0]!.tasks.map(task => task.status)).toEqual(['failed', 'completed']);
  });

  it('keeps an undelivered inbox cursor across failed session openings until a turn actually starts', async () => {
    const opening = [deferred(), deferred(), deferred()], release = [deferred(), deferred(), deferred()];
    const f = fixture({ beforeOpen: async (_options, attempt) => {
      opening[attempt - 1]!.resolve(); await release[attempt - 1]!.promise;
      if (attempt < 3) throw new Error(`offline-open-failure-${attempt}`);
    } });
    try {
      await f.call({ operation: 'spawn', agentId: 'child', message: 'Initial assignment waits while opening.' });
      await opening[0]!.promise;
      const worker = f.team.archive.workers[0]!;
      const message = 'Retain this finding until a native turn actually receives it.';
      expect(await f.call({ operation: 'message', agentId: 'child', message }))
        .toMatchObject({ ok: true, delivery: 'saved-inbox' });
      const event = f.team.archive.events.find(event => event.to === 'child' && event.text === message)!;
      release[0]!.resolve(); await idle(f.team);
      expect(worker.cursor).toBe(0);

      await f.call({ operation: 'assign', agentId: 'child', message: 'Retry with the saved inbox included.' });
      await opening[1]!.promise;
      expect(worker.cursor).toBe(0);
      release[1]!.resolve(); await idle(f.team);
      expect(f.sessions).toHaveLength(0);
      expect(readSolverRunState(f.stateFile).agentTeam!.workers[0]!.cursor).toBe(0);

      await f.call({ operation: 'assign', agentId: 'child', message: 'Start the assignment after recovery.' });
      await opening[2]!.promise;
      expect(worker.cursor).toBe(0);
      release[2]!.resolve();
      const child = await f.session('child'), assignment = dispatchedAssignment(child.message);
      expect(assignment).toMatchObject({ taskId: worker.tasks[2]!.id,
        previousTask: { id: worker.tasks[1]!.id, status: 'failed', error: 'offline-open-failure-2' },
        inbox: { after: 0, through: event.sequence, events: [expect.objectContaining({ sequence: event.sequence,
          from: 'lead', to: 'child', kind: 'message', text: message })] } });
      expect(child.messageId).toBe(assignment.taskId);
      expect(child.message).toContain(message);
      expect(worker.cursor).toBe(event.sequence);
      expect(readSolverRunState(f.stateFile).agentTeam!.workers[0]!.cursor).toBe(event.sequence);
      child.complete(); await idle(f.team);
      expect(worker.tasks.map(task => task.status)).toEqual(['failed', 'failed', 'completed']);
    } finally {
      for (const gate of release) gate.resolve();
    }
  });

  it('retains capacity until an asynchronously stopped writer has actually confirmed shutdown', async () => {
    const f = fixture({ maxAgents: 2 });
    await f.call({ operation: 'spawn', agentId: 'old', message: 'Keep the only child writer slot.' });
    const old = await f.session('old');
    expect(await f.call({ operation: 'stop', agentId: 'old' })).toMatchObject({ ok: true, status: 'stopping' });
    await old.stopping.promise;
    expect(await f.call({ operation: 'spawn', agentId: 'replacement', message: 'Must wait for the old writer to stop.' }))
      .toMatchObject({ ok: false, error: 'math_team_capacity_exceeded' });
    expect(f.opened).toHaveLength(1);
    old.stopReceipt.resolve({ status: 'stopped' }); await idle(f.team);
    expect(await f.call({ operation: 'spawn', agentId: 'replacement', message: 'The writer slot is available now.' })).toMatchObject({ ok: true });
    const replacement = await f.session('replacement'); replacement.complete(); await idle(f.team);
    expect(f.team.archive.workers.map(worker => worker.status)).toEqual(['stopped', 'idle']);
  });

  it('finishes a pending infrastructure-interrupted delivery before a queued follow-up may write', async () => {
    const checkStarted = deferred(), releaseCheck = deferred(); let checks = 0;
    const f = fixture({ beforeCheck: async signal => {
      if (++checks === 1) throw new DeclarationArtifactCheckError(declarations[0], {
        status: 'unavailable', results: [{ status: 'unavailable', error: 'offline-lean-infrastructure-unavailable' }],
      } as never);
      if (checks === 2) {
        signal.addEventListener('abort', () => releaseCheck.resolve(), { once: true });
        checkStarted.resolve(); await releaseCheck.promise;
      }
    } });
    await f.call({ operation: 'spawn', agentId: 'child', message: 'Prove a helper before continuing research.' });
    const first = await f.session('child'), worker = f.team.archive.workers[0]!;
    const candidate = original.replace('end Team', helper + 'end Team');
    fs.writeFileSync(f.source(worker.worktree), candidate);
    await first.call({ operation: 'submit', summary: 'Frozen helper awaiting its check.', declarations });
    first.complete(); await idle(f.team);
    expect(worker.pendingDelivery).toMatchObject({ taskId: worker.tasks[0]!.id, commit: expect.any(String) });
    expect(f.team.archive.deliveries).toHaveLength(0);
    await f.call({ operation: 'assign', agentId: 'child', message: 'Continue only after the previous delivery is checked.' });
    await checkStarted.promise;
    expect(f.sessions).toHaveLength(1);
    expect(fs.readFileSync(f.source(worker.worktree), 'utf8')).toBe(candidate);
    expect(worker.tasks[1]!.status).toBe('queued');
    releaseCheck.resolve();
    const second = await f.session('child', 1);
    expect(worker.pendingDelivery).toBeUndefined(); expect(f.team.archive.deliveries).toHaveLength(1);
    expect(worker.tasks[0]!.deliveryId).toBe(f.team.archive.deliveries[0]!.id);
    second.complete(); await idle(f.team);
    expect(worker.tasks.map(task => task.status)).toEqual(['completed', 'completed']);
  }, 90_000);

  it('quarantines unconfirmed writer shutdown and refuses recovery against a still-active persisted process', async () => {
    const f = fixture();
    await f.call({ operation: 'spawn', agentId: 'child', message: 'Prove a helper.' });
    const child = await f.session('child'), worker = f.team.archive.workers[0]!;
    fs.writeFileSync(f.source(worker.worktree), original.replace('end Team', helper + 'end Team'));
    await child.call({ operation: 'submit', summary: 'A candidate requiring writer shutdown.', declarations });
    child.outcome.resolve('completed'); child.stopReceipt.resolve({ status: 'unconfirmed', reason: 'turn-not-settled' });
    await idle(f.team);
    expect(worker.writerStopUnconfirmed).toMatchObject({ reason: 'turn-not-settled' });
    expect(f.team.archive.deliveries).toHaveLength(0);
    expect(git(worker.worktree, ['rev-parse', 'HEAD'])).toBe(worker.seedCommit);
    await expect(f.team.close()).rejects.toThrow('math_writer_stop_unconfirmed:child');
    const saved = readSolverRunState(f.stateFile), resumed = f.makeTeam(saved);
    await expect(resumed.restore()).rejects.toThrow('math_writer_stop_unconfirmed:child');
    expect(f.sessions).toHaveLength(1);
    // A crash can leave a live writer identity even without an earlier shutdown failure.
    saved.agentTeam!.workers[0]!.writerStopUnconfirmed = undefined;
    const stat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
    const processIdentity: HarnessProcessIdentity = { schema: 'theorem-os.harness-process-identity.v1', pid: process.pid,
      startTime: stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u)[19]!,
      bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
      pidNamespace: fs.readlinkSync(`/proc/${process.pid}/ns/pid`) };
    saved.agentTeam!.workers[0]!.writerProcess = processIdentity;
    const crashResume = f.makeTeam(saved);
    await expect(crashResume.restore()).rejects.toThrow('math_writer_stop_unconfirmed:child:previous-process-active');
    expect(f.sessions).toHaveLength(1); expect(f.team.archive.deliveries).toHaveLength(0);
  });

  it('returns every inbox event across bounded pages without advancing past unread messages', async () => {
    const f = fixture();
    await f.call({ operation: 'spawn', agentId: 'child', message: 'Read the full asynchronous inbox.' });
    const child = await f.session('child');
    const messages = [...Array.from({ length: 70 }, (_, index) => `Message ${index}`),
      ...Array.from({ length: 6 }, (_, index) => `${index}:` + '界'.repeat(15_998))];
    for (const message of messages) await f.call({ operation: 'message', agentId: 'child', message });
    const received: AgentTeamState['events'] = [];
    let cursor = 0, pages = 0, byteLimited = false;
    while (received.length < messages.length) {
      const page = await child.call({ operation: 'poll', after: cursor });
      expect(page.events.length).toBeGreaterThan(0); expect(page.events.length).toBeLessThanOrEqual(8);
      expect(page.cursor).toBeGreaterThan(cursor);
      const bytes = page.events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0);
      expect(bytes <= 128 * 1024 || page.events.length === 1).toBe(true);
      if (pages === 0) expect(page.events).toHaveLength(8);
      byteLimited ||= page.events.length < 8 && received.length + page.events.length < messages.length;
      received.push(...page.events); cursor = page.cursor; pages++;
    }
    expect(byteLimited, 'large message bodies must stop a page before the item limit').toBe(true);
    expect(received.map(event => event.text)).toEqual(messages);
    expect(new Set(received.map(event => event.sequence)).size).toBe(messages.length);
    child.complete(); await idle(f.team);
  });

  it('can stop a child while its cancellable host tool callback is queued without deadlocking dispatch', async () => {
    const f = fixture();
    await f.call({ operation: 'spawn', agentId: 'child', message: 'A writer with a pending host callback.' });
    const child = await f.session('child');
    child.stopReceipt.resolve({ status: 'stopped' });
    // Both calls enqueue in one tick: stop takes the mutation queue before submit;
    // native run settles only once the cancelled tool callback has settled.
    const stopping = f.call({ operation: 'stop', agentId: 'child' });
    const submitting = child.call({ operation: 'submit', summary: 'Racing shutdown.', declarations });
    const settledSubmit = submitting.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([stopping, new Promise<undefined>(resolve => { timer = setTimeout(resolve, 1000); })]);
    clearTimeout(timer);
    // Release the disposable stand-in even on regression so cleanup never hangs.
    child.outcome.resolve('interrupted'); await Promise.allSettled([stopping, settledSubmit]);
    expect(result).toMatchObject({ ok: true, agentId: 'child', status: 'stopping' });
    await idle(f.team);
    expect(f.team.archive.workers[0]!.status).toBe('stopped');
    expect(f.team.archive.deliveries).toHaveLength(0);
  });
});

describe('Agent-owned unpaid handoff checkpoints', () => {
  it('settles every paid request before a submit checkpoint and checks the nomination only after confirmed writer shutdown', async () => {
    const f = fixture({ maxTurns: Infinity, maxTurnMs: Infinity });
    await f.call({ operation: 'spawn', agentId: 'producer', message: 'Prove a reusable equality helper.' });
    await expect.poll(() => f.team.archive.workers[0]?.error ?? f.sessions.length).toBe(1);
    const child = await f.session('producer'), worker = f.team.archive.workers[0]!, task = worker.tasks[0]!;
    const gate = child.options.requestGate!;
    expect(gate.checkpoint!()).toBe(false);
    const first = gate({ requestId: 'nomination-paid-response', threadId: child.threadId });
    const second = gate({ requestId: 'nomination-parallel-response', threadId: child.threadId });
    if (!first.allowed || !second.allowed) throw new Error('fixture-request-refused');
    fs.writeFileSync(f.source(worker.worktree), original.replace('end Team', helper + 'end Team'));
    expect(await child.call({ operation: 'submit', summary: 'The reusable helper is ready for independent checking.', declarations }))
      .toMatchObject({ ok: true, status: 'pending-writer-stop' });
    expect(gate.checkpoint!()).toBe(false);
    first.settle({ complete: true, outcome: 'completed', usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } });
    expect(gate.checkpoint!()).toBe(false);
    // Other tools from the already paid response may still finish their output.
    fs.writeFileSync(path.join(worker.worktree, 'RESEARCH.md'), 'All tools finished before the unpaid handoff.');
    second.settle({ complete: true, outcome: 'completed', usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } });
    expect(gate.checkpoint!()).toBe(true);
    expect(gate.checkpoint!()).toBe(true);
    expect(child.closed).toBe(false); expect(child.options.signal?.aborted).toBe(false);
    expect(worker.requestUsageAccounting).toMatchObject({ startedRequests: 2, reportedRequests: 2, pendingRequests: 0, incomplete: false });
    expect(f.team.archive.deliveries).toHaveLength(0);

    child.outcome.resolve('checkpoint'); await child.stopping.promise;
    expect(task).toMatchObject({ status: 'running', declarations });
    expect(task.pauseRequested).toBeUndefined(); expect(task.researchArtifactId).toBeUndefined();
    expect(f.team.archive.deliveries).toHaveLength(0);
    child.stopReceipt.resolve({ status: 'stopped' }); await idle(f.team);
    expect(task).toMatchObject({ status: 'completed', turns: 1, deliveryId: expect.any(String), researchArtifactId: expect.any(String) });
    expect(task.pauseRequested).toBeUndefined();
    expect(f.sessions).toHaveLength(1); expect(child.closed).toBe(true);
    expect(f.state.tokenBudget).toMatchObject({ status: 'unlimited' });
    expect(worker.usageAccounting).toMatchObject({ startedTurns: 1, reportedTurns: 1, pending: false, incomplete: false });
    const delivery = readAgentTeamProofDelivery(f.team.archive.deliveries[0]!.path, f.state);
    expect(delivery.artifacts.every(artifact => artifact.proof.verification.status === 'kernel_verified')).toBe(true);
    expect((await f.call({ operation: 'inspect-research', artifactId: task.researchArtifactId })).notes!.text)
      .toBe('All tools finished before the unpaid handoff.');
    expect(fs.readFileSync(f.source(f.state.worktree), 'utf8')).toBe(original);
    expect(f.state.check).toBeUndefined();
  }, 90_000);

  it('yields at the unpaid boundary and resumes the same task, thread and saved draft without a budget pause', async () => {
    const f = fixture({ maxTurns: Infinity, maxTurnMs: Infinity });
    await f.call({ operation: 'spawn', agentId: 'consumer', message: 'Keep the current draft until a peer result is available.' });
    await expect.poll(() => f.team.archive.workers[0]?.error ?? f.sessions.length).toBe(1);
    const first = await f.session('consumer'), worker = f.team.archive.workers[0]!, task = worker.tasks[0]!;
    const draft = original.replace('end Team', 'theorem draft (n : Nat) : n = n := by sorry\nend Team');
    const gate = first.options.requestGate!;
    const paid = gate({ requestId: 'yield-paid-response', threadId: first.threadId });
    if (!paid.allowed) throw new Error(paid.reason);
    fs.writeFileSync(f.source(worker.worktree), draft);
    fs.writeFileSync(path.join(worker.worktree, 'RESEARCH.md'), 'Waiting for a checked peer interface.');
    expect(await first.call({ operation: 'yield', reason: 'Release the workspace so Lead can adopt the peer interface.' }))
      .toMatchObject({ ok: true, taskId: task.id, status: 'pending-writer-stop' });
    expect(gate.checkpoint!()).toBe(false);
    paid.settle({ complete: true, outcome: 'completed', usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 } });
    expect(gate.checkpoint!()).toBe(true);
    expect(first.options.signal?.aborted).toBe(false);
    first.outcome.resolve('checkpoint'); await first.stopping.promise;
    expect(task.status).toBe('running'); expect(task.sourceCommit).toBeUndefined();
    first.stopReceipt.resolve({ status: 'stopped' }); await idle(f.team);
    expect(task).toMatchObject({ status: 'paused', turns: 1, pauseRequested: { kind: 'handoff' },
      sourceCommit: expect.any(String), researchArtifactId: expect.any(String) });
    expect(f.team.archive.deliveries).toHaveLength(0);
    expect(worker.requestUsageAccounting).toMatchObject({ startedRequests: 1, reportedRequests: 1, pendingRequests: 0, incomplete: false });
    expect(worker.usageAccounting).toMatchObject({ reportedTurns: 1, incomplete: false });
    const pausedArtifactId = task.researchArtifactId;

    expect(await f.call({ operation: 'resume', agentId: worker.id, taskId: task.id })).toMatchObject({ ok: true, taskId: task.id });
    const second = await f.session('consumer', 1);
    expect(second.threadId).toBe(first.threadId); expect(second.messageId).toBe(task.id);
    expect(worker.tasks).toHaveLength(1); expect(task.turns).toBe(2);
    expect(task.pauseRequested).toBeUndefined(); expect(second.options.requestGate!.checkpoint!()).toBe(false);
    expect(fs.readFileSync(f.source(worker.worktree), 'utf8')).toBe(draft);
    expect(fs.readFileSync(path.join(worker.worktree, 'RESEARCH.md'), 'utf8')).toBe('Waiting for a checked peer interface.');
    const resumed = second.options.requestGate!({ requestId: 'resumed-paid-response', threadId: second.threadId });
    if (!resumed.allowed) throw new Error(resumed.reason);
    resumed.settle({ complete: true, outcome: 'completed', usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } });
    second.complete(); await idle(f.team);
    expect(task).toMatchObject({ status: 'completed', turns: 2 });
    expect(task.researchArtifactId).not.toBe(pausedArtifactId);
    expect(f.state.tokenBudget).toMatchObject({ status: 'unlimited' });
    expect(worker.requestUsageAccounting).toMatchObject({ startedRequests: 2, reportedRequests: 2, pendingRequests: 0, incomplete: false });
  }, 90_000);

  it('persists Lead finish intent, waits for paid settlement and restores its checkpoint without another request', async () => {
    const f = fixture({ maxTurns: Infinity, maxTurnMs: Infinity });
    let paidRequests = 0;
    const gate = f.team.leadRequestGate(() => {
      paidRequests++; f.state.requestUsageAccounting!.startedRequests++; f.state.requestUsageAccounting!.pendingRequests++;
      return { allowed: true, settle: () => {
        f.state.requestUsageAccounting!.reportedRequests++; f.state.requestUsageAccounting!.pendingRequests--;
      } };
    });
    f.team.beginLeadTurn();
    const paid = gate({ requestId: 'finish-paid-response' });
    if (!paid.allowed) throw new Error(paid.reason);
    const summary = 'The current source is ready for frozen independent acceptance.';
    expect(await f.call({ operation: 'finish', summary }, 'lead', 'finish-current-source')).toMatchObject({ ok: true });
    const persisted = readSolverRunState(f.stateFile);
    expect(persisted.agentTeam!.completionRequested).toMatchObject({ summary, at: expect.any(Number) });
    expect(gate.checkpoint!()).toBe(false); expect(f.team.leadCompletionCheckpoint).toBe(false);
    paid.settle({ complete: true, outcome: 'completed' });
    expect(gate.checkpoint!()).toBe(true); expect(gate.checkpoint!()).toBe(true);
    expect(f.team.leadCompletionCheckpoint).toBe(true);
    expect(f.events.filter(item => item.event === 'team_completion_checkpoint')).toHaveLength(1);
    expect(f.events.filter(item => item.event === 'team_coordination_checkpoint')).toHaveLength(0);
    expect(paidRequests).toBe(1);
    // A crash after settlement preserves the intent and needs no paid rediscovery.
    writeSolverRunState(f.stateFile, f.state);
    const restored = f.makeTeam(readSolverRunState(f.stateFile));
    restored.beginLeadTurn();
    const recoveredGate = restored.leadRequestGate(() => { throw new Error('finish-must-stay-unpaid'); });
    expect(recoveredGate.checkpoint!()).toBe(true); expect(restored.leadCompletionCheckpoint).toBe(true);
    expect(f.state.check).toBeUndefined(); expect(f.team.archive.deliveries).toHaveLength(0);
  });
});

describe('Task objectives, professional knowledge and source provenance', () => {
  it('rejects unresolved new roles before a historical host-tool dispatch can change a running assignment', async () => {
    const f = fixture(), agentId = 'specialist', message = 'Profiles: prover, uncatalogued\nCheck the interface.';
    const feedback = { ok: false, error: expect.stringContaining('math_team_profile_unresolved: ["uncatalogued"]') };
    expect(await f.call({ operation: 'spawn', agentId, message })).toMatchObject(feedback);
    expect(f.team.archive.workers).toHaveLength(0);
    await f.call({ operation: 'spawn', agentId, message: 'Profiles: graph-theory\nUse your custom expertise in the local encoding.' });
    const child = await f.session(agentId), worker = f.team.archive.workers[0]!, task = worker.tasks[0]!;
    const original = structuredClone(task), reason = 'Check the revised interface.';
    expect(task.profileEvidence?.loaded).toEqual(['D064']);
    expect(await f.call({ operation: 'assign', agentId, message })).toMatchObject(feedback);
    expect(await f.call({ operation: 'amend', agentId, taskId: task.id, message, reason })).toMatchObject(feedback);
    expect(await f.call({ operation: 'cancel', agentId, taskId: task.id, replacement: message, reason })).toMatchObject(feedback);
    expect(worker.tasks).toEqual([original]);
    expect(child.notifications).toHaveLength(0);
  });

  it('amends a running objective without losing its draft, profile history or revision-bound progress', async () => {
    const f = fixture({ maxTurns: Infinity, maxTurnMs: Infinity });
    await f.call({ operation: 'spawn', agentId: 'specialist', message: 'Profiles: D041, researcher\nInvestigate the stated assumptions.', workKind: 'independent-reconstruction' });
    const child = await f.session('specialist'), worker = f.team.archive.workers[0]!, task = worker.tasks[0]!;
    fs.writeFileSync(path.join(worker.worktree, 'RESEARCH.md'), 'Retained draft.');
    const oldSource = task.profileEvidence!.sources[0]!;
    const first = await child.call({ operation: 'progress', objectiveRevision: 1, kind: 'finding', summary: 'The assumption needs a precise boundary.',
      nextStep: 'Check the boundary.', knowledgeUses: [{ anchor: oldSource.file + '#' + oldSource.anchor, application: 'Used the stated domain assumptions to identify the boundary.' }] });
    expect(first).toMatchObject({ ok: true, objectiveRevision: 1, advisory: true });
    const amendment = { operation: 'amend', agentId: worker.id, taskId: task.id,
      message: 'Profiles: D006, engineer\nAssemble the specified checked interfaces.', reason: 'The useful output is now integration.', workKind: 'assembly' };
    expect(await f.call(amendment, 'lead', 'amendment-once')).toMatchObject({ ok: true, objectiveRevision: 2 });
    expect(await f.call(amendment, 'lead', 'amendment-once')).toMatchObject({ ok: true, objectiveRevision: 2 });
    expect(task.objectiveHistory).toHaveLength(1);
    expect(task.objectiveHistory![0]).toMatchObject({ revision: 1, workKind: 'independent-reconstruction',
      profileEvidence: { selected: ['D041', 'researcher'] } });
    expect(task.profileEvidence).toMatchObject({ selected: ['D006', 'engineer'], loaded: ['D006', 'engineer'] });
    expect(child.notifications.some(text => text.includes('"objectiveRevision":2') && text.includes('Assemble the specified checked interfaces.'))).toBe(true);
    expect(fs.readFileSync(path.join(worker.worktree, 'RESEARCH.md'), 'utf8')).toBe('Retained draft.');
    expect(await child.call({ operation: 'progress', objectiveRevision: 1, kind: 'finding', summary: 'A finding from the earlier objective.' }))
      .toMatchObject({ ok: false, error: 'math_team_objective_revision_changed' });
    expect(await child.call({ operation: 'submit', summary: 'A result without an amended objective version.', declarations }))
      .toMatchObject({ ok: false, error: 'math_team_objective_revision_required' });
    expect(await child.call({ operation: 'progress', objectiveRevision: 2, kind: 'probe', summary: 'Use an obsolete source.',
      knowledgeUses: [{ anchor: oldSource.file + '#' + oldSource.anchor, application: 'Obsolete knowledge is not the current assignment.' }] }))
      .toMatchObject({ ok: false, error: expect.stringContaining('math_team_knowledge_anchor_not_loaded') });
    const nextSource = task.profileEvidence!.sources[0]!;
    expect(await child.call({ operation: 'progress', objectiveRevision: 2, kind: 'blocker', summary: 'The supplied interface remains incomplete.',
      evidenceRefs: ['RESEARCH.md'], knowledgeUses: [{ anchor: nextSource.file + '#' + nextSource.anchor, application: 'Checked the current interface assumptions.' }] }))
      .toMatchObject({ ok: true, objectiveRevision: 2 });
    expect(task.progress!.map(item => item.objectiveRevision)).toEqual([1, 2]);
    expect(task.progress![0]!.knowledgeUses![0]!.digest).toBe(oldSource.digest);
    const full = await f.call({ operation: 'history', agentId: worker.id, limit: 1 }) as any;
    expect(full.tasks[0]).toMatchObject({ objectiveRevision: 2, workKind: 'assembly', progressCount: 2 });
    expect(full.tasks[0].profileEvidence.sources[0]).toEqual(nextSource);
    child.complete(); await idle(f.team);
    expect(readSolverRunState(f.stateFile).agentTeam!.workers[0]!.tasks[0]!.objectiveHistory).toHaveLength(1);
    expect(await f.call(amendment, 'lead', 'after-finish')).toMatchObject({ ok: false, error: 'math_team_task_not_amendable' });
  });

  it('pages the exact stopped-writer sources of distinct checked declarations without adopting them', async () => {
    const f = fixture();
    await f.call({ operation: 'spawn', agentId: 'producer', message: 'Prove two helpers.' });
    const producer = await f.session('producer'), worker = f.team.archive.workers[0]!;
    const prefix = 'theorem reusable (n : Nat) : n = n := by\n  /- ';
    const source = prefix + 'x'.repeat(15999 - prefix.length) + '𝔸β𝔹𝔸 / boundary / 𝔻 -/\n  rfl\n';
    const other = 'theorem distinctEnd : True := by\n  /- second 𝒳 -/\n  trivial\n';
    fs.writeFileSync(f.source(worker.worktree), original.replace('end Team', source + other + 'end Team'));
    expect(await producer.call({ operation: 'submit', summary: 'Two helpers.', declarations: [...declarations,
      { file: 'Submission.lean', name: 'Team.distinctEnd', type: 'True' }] })).toMatchObject({ ok: true });
    producer.complete(); await idle(f.team);
    const ref = f.team.archive.deliveries[0]!, proof = readAgentTeamProofDelivery(ref.path, f.state);
    await f.call({ operation: 'spawn', agentId: 'reader', message: 'Inspect the exact source of the submitted helpers.' });
    const reader = await f.session('reader'), readerWorktree = f.team.archive.workers[1]!.worktree;
    const inspect = (options: Record<string, unknown> = {}) => reader.call({ operation: 'inspect', deliveryId: ref.id, ...options });
    const overview = await inspect();
    expect(overview).toMatchObject({ ok: true, id: ref.id, commit: proof.commit, sourceDigest: proof.sourceDigest,
      originalProblemAcceptance: 'not-assessed' });
    expect(overview.changes).toHaveLength(2);
    for (const [index, change] of proof.changes.entries()) {
      const expected = [...change.after], first = overview.changes![index]!;
      expect(first).toMatchObject({ changeIndex: index, file: change.file, name: change.name,
        totalCharacters: expected.length, offset: 0 });
      if (change.name === 'reusable') expect(first.truncated).toBe(true);
      let page = first, joined = first.source;
      for (;;) {
        expect(page.source).toBe(expected.slice(page.offset, page.offset + [...page.source].length).join(''));
        if (!page.truncated) { expect(page.nextOffset).toBeUndefined(); break; }
        expect(page.nextOffset).toBeGreaterThan(page.offset);
        expect(page.nextOffset).toBe([...joined].length);
        const next = await inspect({ changeIndex: index, offset: page.nextOffset, limit: 4096 });
        expect(next).toMatchObject({ ok: true, id: ref.id, commit: proof.commit, sourceDigest: proof.sourceDigest,
          originalProblemAcceptance: 'not-assessed', change: { changeIndex: index, file: change.file, name: change.name,
            offset: page.nextOffset, totalCharacters: expected.length } });
        page = next.change!; joined += page.source;
      }
      expect(joined).toBe(change.name === 'reusable' ? source : other);
      if (change.name === 'reusable') {
        const request = { operation: 'inspect', deliveryId: ref.id, changeIndex: index, offset: 16000, limit: 24 };
        const firstRead = await f.call(request, 'reader', 'replay-frozen-page');
        expect(firstRead.change?.source).toContain('boundary');
        const recorded = readSolverRunState(f.stateFile).agentTeam!.operations;
        expect(JSON.stringify(recorded)).not.toContain(firstRead.change!.source);
        expect(await f.call(request, 'reader', 'replay-frozen-page')).toEqual(firstRead);
        expect(readSolverRunState(f.stateFile).agentTeam!.operations).toEqual(recorded);
        await expect(f.call({ ...request, offset: 16001 }, 'reader', 'replay-frozen-page')).rejects.toThrow('math_team_call_changed');
        const atSymbol = await inspect({ changeIndex: index, offset: 15999, limit: 1 });
        expect(atSymbol.change).toMatchObject({ source: '𝔸', nextOffset: 16000 });
        expect((await inspect({ changeIndex: index, offset: 16000, limit: 2 })).change)
          .toMatchObject({ source: 'β𝔹', nextOffset: 16002 });
      } else {
        expect((await inspect({ changeIndex: index, limit: 7 })).change)
          .toMatchObject({ source: expected.slice(0, 7).join(''), offset: 0, nextOffset: 7 });
      }
    }
    for (const invalid of [{ changeIndex: 2 }, { changeIndex: -1 }, { changeIndex: 0.5 },
      { changeIndex: 0, offset: -1 }, { changeIndex: 0, limit: 0 }, { changeIndex: 0, limit: 16001 },
      { offset: 1 }, { limit: 10 }]) expect(await inspect(invalid)).toMatchObject({ ok: false });
    expect(f.team.archive.adoptions).toEqual([]);
    expect(fs.readFileSync(f.source(readerWorktree), 'utf8')).toBe(original);
    expect(fs.readFileSync(f.source(f.state.worktree), 'utf8')).toBe(original);
    reader.complete(); await idle(f.team);
  }, 90_000);

  it('retains inspection and adoption exposure in a later checked assembled delivery', async () => {
    const f = fixture({ maxTurns: Infinity, maxTurnMs: Infinity });
    await f.call({ operation: 'spawn', agentId: 'producer', message: 'Prove the reusable helper.', workKind: 'proof' });
    const producer = await f.session('producer');
    fs.writeFileSync(f.source(f.team.archive.workers[0]!.worktree), original.replace('end Team', helper + 'end Team'));
    await producer.call({ operation: 'submit', summary: 'Reusable helper.', declarations }); producer.complete(); await idle(f.team);
    const reference = f.team.archive.deliveries[0]!;
    expect(reference).toBeDefined();
    await f.call({ operation: 'spawn', agentId: 'consumer', message: 'Reconstruct the interface independently.', workKind: 'independent-reconstruction' });
    const consumer = await f.session('consumer'), worker = f.team.archive.workers[1]!, task = worker.tasks[0]!;
    expect(await consumer.call({ operation: 'inspect', deliveryId: reference.id })).toMatchObject({ ok: true, agentId: 'producer' });
    await consumer.call({ operation: 'yield', reason: 'Need the checked dependency.' }); consumer.complete(); await idle(f.team);
    await f.call({ operation: 'adopt', deliveryId: reference.id, targetId: 'consumer' }); await idle(f.team);
    expect(worker.exposures?.map(item => item.kind)).toEqual(['inspected', 'adopted']);
    await f.call({ operation: 'amend', agentId: 'consumer', taskId: task.id, message: 'Assemble using the checked peer helper.', reason: 'The source has now been inspected and imported.', workKind: 'assembly' });
    await f.call({ operation: 'resume', agentId: 'consumer', taskId: task.id });
    const resumed = await f.session('consumer', 1);
    expect(resumed.threadId).toBe(consumer.threadId);
    fs.writeFileSync(f.source(worker.worktree), fs.readFileSync(f.source(worker.worktree), 'utf8')
      .replace('end Team', 'theorem consumerReuse (n : Nat) : n = n := by exact reusable n\nend Team'));
    await resumed.call({ operation: 'submit', objectiveRevision: 2, summary: 'Consumer assembled with the peer dependency.',
      declarations: [{ file: 'Submission.lean', name: 'Team.consumerReuse', type: '∀ n : Nat, n = n' }] });
    resumed.complete(); await idle(f.team);
    const own = f.team.archive.deliveries.find(item => item.agentId === 'consumer')!;
    const delivery = readAgentTeamProofDelivery(own.path, f.state);
    expect(delivery.provenance).toMatchObject({ objectiveRevision: 2, taskId: task.id, workKind: 'assembly', exposures: [
      { deliveryId: reference.id, agentId: 'producer', taskId: reference.taskId, kind: 'inspected' },
      { deliveryId: reference.id, agentId: 'producer', taskId: reference.taskId, kind: 'adopted' },
    ] });
    expect(delivery.declarations.map(item => item.name)).toContain('Team.consumerReuse');
    expect(readSolverRunState(f.stateFile).agentTeam!.workers[1]!.exposures).toHaveLength(2);
    expect(f.state.check).toBeUndefined();
  }, 90_000);

  it.each(['holes', 'source-contract'] as const)('finishes only after every frozen original proof is ready and independently checked (%s)', async firstFailure => {
    const f = fixture({ maxTurns: Infinity, maxTurnMs: Infinity });
    let opens = 0;
    const modules = { ...directSolverModules, M1: { ...directSolverModules.M1,
      open: async (options: MathAgentOptions): Promise<MathAgentSession> => {
        const turn = ++opens, threadId = options.threadId ?? 'finish-lead';
        return { threadId, usageSource: 'upstream-requests', close: async () => {}, interrupt: async () => {},
          stopForFreeze: async () => ({ status: 'stopped' }), run: async (_message, id, _workspace, started) => {
            started(id);
            const request = options.requestGate!({ requestId: 'finish-' + turn, threadId });
            if (request.allowed) request.settle({ complete: true, outcome: 'completed', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
            if (turn === 1) {
              expect(f.state.check?.passed).not.toBe(true);
              if (firstFailure === 'source-contract') fs.writeFileSync(f.source(f.state.worktree), original.replace('theorem original : True', 'theorem original : False'));
            }
            else {
              expect(turn).toBe(2);
              expect(f.state.agentTeam!.completionRequested).toBeUndefined();
              fs.writeFileSync(f.source(f.state.worktree), original.replaceAll('by sorry', 'by trivial'));
            }
            expect(await options.tools!.call('theoremos_team', { operation: 'finish', summary: 'Saved candidate; request independent checking.' },
              { callId: 'finish-call-' + turn, threadId, turnId: id, signal: f.controller.signal }))
              .toMatchObject({ ok: true, originalProblemAcceptance: 'not-assessed' });
            expect(options.requestGate!.checkpoint!()).toBe(true);
            return 'checkpoint';
          } };
      } } };
    const result = await runResearchWorkers({ state: f.state, root: f.root, taskText: 'Prove both frozen statements.',
      workers: [{ id: 'solver', role: 'lead', worktree: f.state.worktree, ownedFiles: f.problem.ownedFiles }],
      access: new Map([['solver', { environment: f.environment,
        researchSkill: prepareResearchSkill(f.root, f.state.worktree, f.state.researchSkill!, f.problem), retrievalRoot: f.state.worktree }]]),
      modules, buildFile: path.join(f.directory, 'unused-build.json'), executable: 'offline-no-model', profile: 'offline-no-credentials',
      signal: f.controller.signal, deadline: Infinity, maxTurns: Infinity, maxTotalTokens: 0, maxTurnMs: Infinity,
      save: () => writeSolverRunState(f.stateFile, f.state), emit: (event, details) => { f.events.push({ event, details }); } });
    expect(opens).toBe(2);
    expect(result?.check.verification.status).toBe('kernel_verified');
    expect(f.events.filter(item => item.event === 'team_completion_frozen').map(item => item.details?.wholeProofReady))
      .toEqual(firstFailure === 'holes' ? [false, true] : [true]);
    expect(f.events.some(item => item.event === 'team_completion_rejected')).toBe(firstFailure === 'source-contract');
    expect(f.state.agentTeam!.completionRequested).toBeUndefined();
  }, 90_000);
});
