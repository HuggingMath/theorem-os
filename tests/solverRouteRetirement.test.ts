import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { readMathAgentSkill } from '../src/runtime/agentSkills';
import type { MathAgentOptions, MathAgentSession } from '../src/runtime/agentSession';
import type { NativeAgentControlConnection } from '../src/runtime/nativeAgentControl';
import { AgentResearchTeam } from '../src/solver/agentTeam';
import { readSolverRunState, writeSolverRunState, type SolverRunState } from '../src/solver/archive';
import { directSolverModules } from '../src/solver/modules';
import { readSolverProblem } from '../src/solver/problem';
import { prepareResearchSkill, researchSkillIdentity } from '../src/solver/researchSkill';
import { deferred } from './helpers/async';
import { temporaryDirectory } from './helpers/files';
import { solverState } from './helpers/solver';

const goal = 'Show True.';
const rootThreadId = '00000000-0000-4000-8000-000000000001';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

function nativeConnection(threadId: string, agentPath: string, cwd: string): NativeAgentControlConnection {
  return {
    info: { sessionId: rootThreadId, agent: { threadId, metadata: { threadId, agentPath }, status: 'running' },
      configSnapshot: { cwd } },
    request: vi.fn(async () => ({})),
    input: vi.fn(async () => ({ accepted: true, threadId, submissionId: 'followup' })),
    update: vi.fn(async request => ({ acceptedSequence: request.sequence })),
  };
}

function fixture() {
  const directory = temporaryDirectory('team-route-retirement-');
  const task = bootstrapLeanTask(path.join(directory, 'lead'), { source: 'theorem target : True := by sorry\n', task: goal });
  const problem = readSolverProblem(task.workspaceRoot, task.activeProblemPath);
  const root = process.cwd();
  const identity = researchSkillIdentity(readMathAgentSkill(path.join(root, 'skills/theoremos-research/SKILL.md')));
  const state = solverState(problem, task.workspaceRoot, { runId: 'team-route-retirement', phase: 'running',
    environmentDigest: mathDigest('offline route retirement fixture'),
    researchMode: 'skill', researchSkillWorkflow: 'full', researchSkill: identity, workerCount: 1,
    researchDelegation: { mode: 'team', maxAgents: 2 },
    agentTeam: { schema: 'theorem-os.agent-team.v1', transport: 'native-agent-control', workers: [], events: [], deliveries: [], adoptions: [], operations: [] } });
  const skill = prepareResearchSkill(root, state.worktree, identity, problem);
  const controller = new AbortController(), stateFile = path.join(directory, 'state.json');
  const current = new Map<string, { started: ReturnType<typeof deferred>; stopped: ReturnType<typeof deferred>;
    interrupt: () => Promise<void>; finish: () => void; context?: string }>();
  const teams: AgentResearchTeam[] = [];
  const open = async (options: MathAgentOptions): Promise<MathAgentSession> => {
    const id = options.environment!.DEEPSCIENTIST_MATH_WORKER_ID!;
    const config = options.nativeAgentControl!;
    const threadId = options.threadId ?? String(config.bootstrap!.threadId);
    const connection = nativeConnection(threadId, '/root/' + id, options.workspace);
    await config.request({ version: 1, threadId, sessionId: rootThreadId, operation: 'attach', operationId: 'attach-' + id,
      payload: { threadId, sessionId: rootThreadId } }, connection, { signal: controller.signal });
    await config.bound?.(connection);
    const started = deferred(), stopped = deferred(), outcome = deferred<string>();
    const record = { started, stopped, interrupt: vi.fn(async () => { outcome.resolve('interrupted'); }),
      finish: () => { stopped.resolve(); outcome.resolve('completed'); }, context: undefined as string | undefined };
    current.set(id, record);
    return { threadId, usageSource: 'upstream-requests', nativeAgentControl: connection,
      run: async (message, _id, _workspace, onStarted) => {
        record.context = message; onStarted('turn-' + id); started.resolve(); return outcome.promise;
      },
      interrupt: record.interrupt, stopForFreeze: async () => { await stopped.promise; return { status: 'stopped' }; },
      close: async () => { await config.disconnected?.(connection); } };
  };
  const create = (saved: SolverRunState) => {
    const team = new AgentResearchTeam({ state: saved, root, taskText: goal,
      leadAccess: { researchSkill: skill, environment: {}, retrievalRoot: saved.worktree },
      executable: 'offline', profile: 'offline', signal: controller.signal,
      modules: { ...directSolverModules, M1: { ...directSolverModules.M1, open } },
      maxAgents: 2, maxTurns: Infinity, maxTotalTokens: 0, maxTurnMs: Infinity, remainingMs: () => Infinity,
      save: () => writeSolverRunState(stateFile, saved), emit: () => {}, exclusiveCheck: operation => operation() });
    teams.push(team); return team;
  };
  const team = create(state);
  let sequence = 0;
  const call = (args: Record<string, unknown>, actor = 'lead', instance = team) => instance.tools(actor).call('theoremos_team', args, {
    threadId: 'fixture', turnId: 'fixture', callId: 'tool-' + ++sequence, signal: controller.signal,
  });
  const session = async (id: string) => {
    await expect.poll(() => current.get(id)).toBeDefined();
    const worker = current.get(id)!;
    await worker.started.promise; return worker;
  };
  cleanup.push(async () => {
    for (const session of current.values()) session.finish();
    controller.abort();
    await Promise.all(teams.map(team => team.close()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { team, state, stateFile, create, call, session, signal: controller.signal };
}

const retirement = { operation: 'retire_route', routeId: 'counterexample',
  reason: 'The symmetric reduction fails at the boundary.', evidenceRefs: ['RESEARCH.md#boundary-witness'] };

describe('atomic AgentResearchTeam route retirement', () => {
  it('tags native spawn work, exposes the Lead operation, and blocks retired native requests', async () => {
    const f = fixture();
    const options = f.team.nativeAgentControlOptions('lead')!;
    const connection = nativeConnection(rootThreadId, '/root', f.state.worktree);
    let sequence = 0;
    const native = (operation: string, payload: Record<string, unknown>) => options.request({
      version: 1, operation, operationId: 'native-' + ++sequence, threadId: rootThreadId, sessionId: rootThreadId, payload,
    }, connection, { signal: f.signal });
    await native('attach', { threadId: rootThreadId, sessionId: rootThreadId });
    await options.bound?.(connection);
    const spawn = (id: string, route: string) => native('spawn', { caller: rootThreadId,
      source: { subagent: { thread_spawn: { agent_path: '/root/' + id, parent_thread_id: rootThreadId, depth: 1 } } },
      bootstrap: { config: { cwd: f.state.worktree, model: f.state.model, reasoningEffort: f.state.effort } },
      input: { kind: 'message', mode: 'triggerTurn',
        message: { kind: 'plaintext', text: 'Route: ' + route + '\nExplore a local reduction.' } },
    });
    await spawn('old', 'counterexample');
    const old = await f.session('old');
    expect(f.team.archive.workers[0]!.tasks[0]).toMatchObject({ routeId: 'counterexample', message: 'Explore a local reduction.' });
    expect(await f.call(retirement, 'old')).toMatchObject({ ok: false, error: 'math_team_native_operation_required' });
    const task = f.team.archive.workers[0]!.tasks[0]!;
    expect(await f.call(retirement)).toMatchObject({ ok: true, releasedAgentIds: ['old'], cancelledTaskIds: [task.id] });
    expect(old.interrupt).toHaveBeenCalled();
    expect(await f.call(retirement)).toMatchObject({ ok: true, cancelledTaskIds: [], releasedAgentIds: [] });
    expect(readSolverRunState(f.stateFile).agentTeam?.retiredRoutes).toMatchObject([
      { routeId: 'counterexample', source: 'lead', evidenceRefs: retirement.evidenceRefs },
    ]);
    await expect(spawn('new', 'counterexample')).rejects.toThrow('math_team_route_retired:counterexample');
    await spawn('new', 'replacement');
    const replacement = await f.session('new');
    expect(replacement.context).toContain('"routeId":"replacement"');
    await expect(native('send', { caller: rootThreadId, target: { kind: 'path', reference: '/root/new' },
      input: { kind: 'message', mode: 'triggerTurn', message: { kind: 'plaintext', text: 'Route: counterexample\nRepeat the route.' } },
    })).rejects.toThrow('math_team_route_retired:counterexample');
    old.finish(); replacement.finish();
    await expect.poll(() => f.team.hasActiveWorkers).toBe(false);
    expect(task.status).toBe('cancelled');
    await f.team.close();
    const saved = readSolverRunState(f.stateFile), restored = f.create(saved);
    await restored.restore();
    const restoredOptions = restored.nativeAgentControlOptions();
    await restoredOptions.request({ version: 1, operation: 'attach', operationId: 'restored-attach',
      threadId: rootThreadId, sessionId: rootThreadId, payload: { threadId: rootThreadId, sessionId: rootThreadId } },
    connection, { signal: f.signal });
    await restoredOptions.bound?.(connection);
    await expect(restoredOptions.request({ version: 1, operation: 'send', operationId: 'restored-followup',
      threadId: rootThreadId, sessionId: rootThreadId, payload: { caller: rootThreadId,
        target: { kind: 'path', reference: '/root/new' },
        input: { kind: 'message', mode: 'triggerTurn', message: { kind: 'plaintext', text: 'Route: counterexample\nReopen it.' } },
      } }, connection, { signal: f.signal })).rejects.toThrow('math_team_route_retired:counterexample');
  });
});
