import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readMathAgentSkill } from '../src/runtime/codexSkills';
import type { MathAgentOptions, MathAgentSession } from '../src/runtime/agentSession';
import { readSolverRunState, writeSolverRunState } from '../src/solver/archive';
import { directSolverModules } from '../src/solver/modules';
import { runResearchWorkers } from '../src/solver/research';
import { prepareResearchSkill, researchSkillIdentity } from '../src/solver/researchSkill';
import { leadWorker, localExample, solverState } from './helpers/solver';

vi.mock(import('../src/math/mathBuildManifest'), async original =>
  ({ ...await original(), readMathBuildManifest: vi.fn() }));

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture(open: (options: MathAgentOptions, signal: AbortController) => Promise<MathAgentSession>,
  previous?: { turns: number; threadId: string }) {
  const { problem, workspace, directory } = localExample('agent-team-transport-');
  roots.push(directory);
  const root = path.resolve('.');
  const identity = researchSkillIdentity(readMathAgentSkill(path.join(root, 'skills/theoremos-research/SKILL.md')));
  const state = solverState(problem, workspace, { runId: 'agent-team-transport', phase: 'prepared',
    researchMode: 'skill', researchSkillWorkflow: 'full', researchSkill: identity,
    coordination: 'independent', workerCount: 1, researchDelegation: { mode: 'team', maxAgents: 3 },
    agentTeam: { schema: 'theorem-os.agent-team.v1', transport: 'native-agent-control',
      workers: [], events: [], deliveries: [], adoptions: [], operations: [] },
    ...previous,
  });
  const researchSkill = prepareResearchSkill(root, workspace, identity, problem);
  const worker = leadWorker(problem, workspace), controller = new AbortController();
  const stateFile = path.join(directory, 'state.json');
  const emit = vi.fn();
  const start = vi.fn((options: MathAgentOptions) => open(options, controller));
  const check = vi.fn(async () => ({
    commit: problem.baseCommit, sourceDigest: 'incomplete', passed: false,
    verification: { schema: 'deepscientist.mathematics.verification-batch/v1' as const, status: 'failed' as const,
      sessionId: 'fixture', targetCommit: problem.baseCommit, results: [], events: [], startedAt: 0, checkedAt: 1, durationMs: 1 },
  }));
  const run = () => runResearchWorkers({ state, workers: [worker],
    access: new Map([[worker.id, { environment: {}, researchSkill, retrievalRoot: directory }]]),
    modules: { ...directSolverModules, M1: { ...directSolverModules.M1, open: start },
      M2: { ...directSolverModules.M2, check } }, root, buildFile: path.join(directory, 'build.json'),
    taskText: 'Prove the frozen targets.', executable: 'offline', profile: 'offline', signal: controller.signal,
    deadline: Infinity, maxTurns: (previous?.turns ?? 0) + 1, maxTurnMs: Infinity, maxTotalTokens: 0,
    save: () => writeSolverRunState(stateFile, state), emit });
  return { run, state, stateFile, start, emit, controller };
}

const startupError = 'math_codex_rpc_failed:-32603:thread/start';

describe('AgentResearchTeam startup transport fallback', () => {
  it('keeps one turn, rebuilds Lead context, and persists the successful host-tools retry', async () => {
    const close = vi.fn(async () => {});
    const repaired = vi.fn(async (_message, _id, _workspace, started) => { started('host-turn'); return 'completed'; });
    const f = fixture(async options => {
      if (options.nativeAgentControl) {
        // A launch can fail after binding a partial native control record.
        f.state.agentTeam!.nativeControl = { sessionId: 'failed', rootThreadId: 'partial', sequence: 0, mailbox: [] };
        throw new Error(startupError);
      }
      expect(readSolverRunState(f.stateFile).agentTeam).toMatchObject({ transport: 'host-tools' });
      return { threadId: 'host-lead', run: repaired, close, interrupt: async () => {},
        stopForFreeze: async () => ({ status: 'stopped' }) };
    });
    f.emit.mockImplementation((event) => {
      if (event === 'team_transport_fallback') expect(readSolverRunState(f.stateFile)).toMatchObject({
        turns: 0, agentTeam: { transport: 'host-tools' },
      });
    });
    await f.run();
    expect(f.start).toHaveBeenCalledTimes(2);
    const [native, host] = f.start.mock.calls.map(([options]) => options);
    expect(native.nativeAgentControl).toBeDefined();
    expect(native.instructions).toContain('native AgentControl');
    expect(host.nativeAgentControl).toBeUndefined();
    expect(host.instructions).toContain('Built-in spawn/fork is disabled');
    expect(JSON.stringify(host.tools!.definitions)).toContain('"spawn"');
    expect(repaired).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalled();
    const saved = readSolverRunState(f.stateFile);
    expect(saved).toMatchObject({ turns: 1, threadId: 'host-lead', agentTeam: { transport: 'host-tools' } });
    expect(saved.agentTeam?.nativeControl).toBeUndefined();
    expect(f.emit.mock.calls.filter(([event]) => event === 'team_transport_fallback')).toEqual([
      ['team_transport_fallback', { from: 'native-agent-control', to: 'host-tools',
        reason: 'math_codex_rpc_failed', error: startupError }],
    ]);
  });

  it.each(['abort', 'auth', 'auth-wrapped', 'prior-turn', 'shutdown-unconfirmed'] as const)('preserves transport on %s', async mode => {
    const error = mode === 'auth' ? new Error('math_codex_authentication_failed') :
      mode === 'auth-wrapped' ? new Error('math_native_agent_control_backend_required',
        { cause: new Error('math_codex_authentication_failed') }) :
      mode === 'shutdown-unconfirmed' ? new Error('math_codex_startup_shutdown_unconfirmed') : new Error(startupError);
    const f = fixture(async (_options, controller) => {
      if (mode === 'abort') controller.abort(new Error('user cancelled'));
      throw error;
    }, mode === 'prior-turn' ? { turns: 1, threadId: 'previous-lead' } : undefined);
    await expect(f.run()).rejects.toThrow(mode === 'abort' ? 'user cancelled' : error.message);
    expect(f.start).toHaveBeenCalledOnce();
    expect(readSolverRunState(f.stateFile).agentTeam?.transport).toBe('native-agent-control');
    expect(f.emit.mock.calls.map(([event]) => event)).not.toContain('team_transport_fallback');
  });
});
