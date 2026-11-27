import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_EXAMPLE_PROOF } from '../src/math/localExample';
import { readMathAgentSkill } from '../src/runtime/codexSkills';
import type { MathAgentOptions, MathAgentSession } from '../src/runtime/agentSession';
import { readSolverRunState, writeSolverRunState } from '../src/solver/archive';
import { buildRunInspection, exportRunPlan } from '../src/solver/inspection';
import { queuePlanApproval } from '../src/solver/humanEdit';
import { directSolverModules } from '../src/solver/modules';
import { publishNativeApprovalPlan } from '../src/solver/planApproval';
import { runResearchLead } from '../src/solver/research';
import { prepareResearchSkill, researchSkillIdentity } from '../src/solver/researchSkill';
import { localExample, solverState } from './helpers/solver';

vi.mock(import('../src/math/mathBuildManifest'), async original =>
  ({ ...await original(), readMathBuildManifest: vi.fn() }));

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture(open: (options: MathAgentOptions, signal: AbortController) => Promise<MathAgentSession>,
  previous?: { turns: number; threadId: string }, maxTurns = (previous?.turns ?? 0) + 1,
  settings?: { review?: true; setWaiting?: (waiting: boolean) => void;
    remainingMs?: () => number; maxTotalTokens?: number }) {
  const { problem, workspace, directory } = localExample('agent-team-transport-');
  roots.push(directory);
  const root = path.resolve('.');
  const identity = researchSkillIdentity(readMathAgentSkill(path.join(root, 'skills/theoremos-research/SKILL.md')));
  const state = solverState(problem, workspace, { runId: 'agent-team-transport', phase: 'prepared',
    researchMode: 'skill', researchSkillWorkflow: 'full', researchSkill: identity,
    coordination: 'independent', workerCount: 1, researchDelegation: { mode: 'team', maxAgents: 3 },
    agentTeam: { schema: 'theorem-os.agent-team.v1', transport: 'native-agent-control',
      workers: [], events: [], deliveries: [], adoptions: [], operations: [] },
    ...(settings?.review ? { planApproval: true } : {}), ...previous,
  });
  const researchSkill = prepareResearchSkill(root, workspace, identity, problem);
  const controller = new AbortController();
  const stateFile = path.join(directory, 'state.json');
  const emit = vi.fn();
  const start = vi.fn((options: MathAgentOptions) => open(options, controller));
  const check = vi.fn(async () => ({
    commit: problem.baseCommit, sourceDigest: 'incomplete', passed: false,
    verification: { schema: 'deepscientist.mathematics.verification-batch/v1' as const, status: 'failed' as const,
      sessionId: 'fixture', targetCommit: problem.baseCommit, results: [], events: [], startedAt: 0, checkedAt: 1, durationMs: 1 },
  }));
  const run = () => runResearchLead({ state,
    access: { environment: {}, researchSkill, retrievalRoot: directory },
    modules: { ...directSolverModules, M1: { ...directSolverModules.M1, open: start },
      M2: { ...directSolverModules.M2, check }, M3: { ...directSolverModules.M3, retry: (...args) => {
        const retry = directSolverModules.M3.retry(...args);
        return retry && { ...retry, delayMs: 0 };
      } } }, root, buildFile: path.join(directory, 'build.json'),
    taskText: 'Prove the frozen targets.', executable: 'offline', profile: 'offline', signal: controller.signal,
    deadline: Infinity, maxTurns, maxTurnMs: Infinity, maxTotalTokens: settings?.maxTotalTokens ?? 0,
    ...(settings?.setWaiting ? { executionBudget: {
      remainingMs: settings.remainingMs ?? (() => Infinity), setWaiting: settings.setWaiting,
    } } : {}),
    save: () => writeSolverRunState(stateFile, state), emit });
  return { run, state, stateFile, start, emit, controller, check };
}

const startupError = 'math_codex_rpc_failed:-32603:thread/start';

describe('AgentResearchTeam startup transport', () => {
  it('surfaces a native startup failure without creating a host-tools team', async () => {
    const f = fixture(async options => {
      expect(options.nativeAgentControl).toBeDefined();
      throw new Error(startupError);
    });
    await expect(f.run()).rejects.toThrow(startupError);
    expect(f.start).toHaveBeenCalledOnce();
    expect(readSolverRunState(f.stateFile)).toMatchObject({ turns: 0, agentTeam: { transport: 'native-agent-control' } });
    expect(f.emit.mock.calls.map(([event]) => event)).not.toContain('team_transport_fallback');
  });

  it('leaves saved host-tools teams readable without starting their writers', async () => {
    const f = fixture(async () => { throw new Error('Historical teams must use their pinned revision.'); });
    f.state.agentTeam!.transport = 'host-tools';
    writeSolverRunState(f.stateFile, f.state);
    await expect(f.run()).rejects.toThrow('math_legacy_collaboration_retired');
    expect(f.start).not.toHaveBeenCalled();
    expect(readSolverRunState(f.stateFile)).toMatchObject({ turns: 0, agentTeam: { transport: 'host-tools' } });
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

describe('native Lead recovery', () => {
  it.each(['transport exit', 'context overflow'] as const)('reopens the same team root after %s', async failure => {
    const threadId = 'native-lead';
    const sequence: string[] = [];
    const compact = vi.fn(async () => { sequence.push('compact'); });
    const f = fixture(async options => {
      const reopening = f.start.mock.calls.length > 1;
      expect(options.nativeAgentControl).toBeDefined();
      expect(options.threadId).toBe(reopening ? threadId : undefined);
      if (!reopening) f.state.agentTeam!.nativeControl = { sessionId: threadId, rootThreadId: threadId, sequence: 0, mailbox: [] };
      let lastError: string | undefined;
      return { threadId, compact, get lastError() { return lastError; },
        close: async () => { sequence.push('close'); }, interrupt: async () => {},
        stopForFreeze: async () => ({ status: 'stopped' }),
        run: async (_message, _id, _workspace, started) => {
          sequence.push(reopening ? 'retry' : 'first');
          started(reopening ? 'native-turn-2' : 'native-turn-1');
          if (reopening) return 'completed';
          lastError = failure === 'transport exit'
            ? 'math_codex_transport_closed:process_exit:code=9:signal=none' : 'math_model_context_window_exceeded';
          throw new Error(lastError);
        } };
    }, undefined, 2);
    await f.run();
    expect(sequence).toEqual(failure === 'transport exit'
      ? ['first', 'close', 'retry', 'close'] : ['first', 'close', 'compact', 'retry', 'close']);
    expect(readSolverRunState(f.stateFile)).toMatchObject({ threadId, turns: 2,
      agentTeam: { nativeControl: { sessionId: threadId, rootThreadId: threadId } } });
  });
});

describe('native Lead plan approval', () => {
  it('stops the planning writer, waits for the exact version, then resumes the same thread', async () => {
    const setWaiting = vi.fn();
    const retiredRoute = { routeId: 'structural-symmetry', retiredAt: 1, source: 'lead' as const,
      reason: 'Counterexample in the member report.' };
    const close = vi.fn(async () => {});
    const stopForFreeze = vi.fn(async () => ({ status: 'stopped' as const }));
    const f = fixture(async options => {
      const planning = f.start.mock.calls.length === 1;
      expect(options.threadId).toBe(planning ? undefined : 'native-plan-lead');
      expect(Boolean(options.readOnlyWorkspace)).toBe(planning);
      expect(JSON.stringify(options.tools!.definitions)).toContain('publish_plan');
      return { threadId: 'native-plan-lead', close, interrupt: async () => {},
        stopForFreeze,
        run: async (message, _id, workspace, started) => {
          const turnId = planning ? 'plan-turn' : 'proof-turn';
          started(turnId);
          if (!planning) {
            expect(message).toContain('The human approved plan version');
            expect(message).toContain('Verify the available identity lemma.');
            expect(message).toContain('Check the identity.');
            const control = options.nativeAgentControl!;
            const threadId = 'native-plan-lead';
            const connection = { request: vi.fn(), update: vi.fn(), input: vi.fn() };
            const callNative = (operation: string, payload: Record<string, unknown>) =>
              control.request({ version: 1, sessionId: threadId, threadId, operation, operationId: operation, payload },
                connection, { signal: f.controller.signal });
            await callNative('attach', { threadId, sessionId: threadId });
            await expect(callNative('spawn', {
              caller: threadId,
              source: { subagent: { thread_spawn: { parent_thread_id: threadId, agent_path: '/root/prover' } } },
              bootstrap: { config: { model: f.state.model, reasoningEffort: f.state.effort } },
              input: { kind: 'message', mode: 'triggerTurn',
                message: { kind: 'plaintext', text: 'Route: structural-symmetry\nCheck the remaining lemma.' } },
            })).rejects.toThrow('math_team_route_retired:structural-symmetry');
            expect(readSolverRunState(f.stateFile).agentTeam).toMatchObject({ retiredRoutes: [retiredRoute], workers: [] });
            fs.writeFileSync(path.join(workspace, f.state.problem.projectRelative, f.state.problem.ownedFiles[0]!), LOCAL_EXAMPLE_PROOF);
            return 'completed';
          }
          expect(message).toContain('This turn is for planning only');
          const context = { threadId: 'native-plan-lead', turnId, signal: f.controller.signal };
          const call = (callId: string, args: unknown) => options.tools!.call('theoremos_team', args, { ...context, callId });
          const goal = { theoremName: f.state.problem.targets[0]!.theoremName, objective: 'Use the left identity.' };
          expect(await call('incomplete', { operation: 'publish_plan', goals: [goal] })).toMatchObject({
            ok: false, error: expect.stringContaining('math_team_plan_targets_mismatch'),
          });
          const goals = f.state.problem.targets.map(target => ({ theoremName: target.theoremName, objective: 'Check the identity.' }));
          expect(await call('publish', { operation: 'publish_plan', goals, investigations: ['Verify the available identity lemma.'] }))
            .toMatchObject({ ok: true, status: 'pending', planVersion: expect.any(String) });
          expect(options.requestGate?.checkpoint?.()).toBe(true);
          expect(await call('finish-blocked', { operation: 'finish', summary: 'done' })).toMatchObject({
            ok: false, error: expect.stringContaining('math_team_plan_approval_required'),
          });
          return 'checkpoint';
        } };
    }, undefined, 2, { review: true, setWaiting });
    f.state.agentTeam!.retiredRoutes = [retiredRoute];
    const running = f.run();
    await vi.waitFor(() => expect(setWaiting).toHaveBeenCalledWith(true));
    expect(stopForFreeze).toHaveBeenCalledOnce();
    expect(stopForFreeze.mock.invocationCallOrder[0]).toBeLessThan(setWaiting.mock.invocationCallOrder[0]!);
    expect(close).toHaveBeenCalledOnce();
    expect(f.start).toHaveBeenCalledOnce();
    expect(f.check).not.toHaveBeenCalled();
    const pending = readSolverRunState(f.stateFile);
    const plan = exportRunPlan(pending);
    expect(plan.tasks.map(task => task.kind)).toEqual(['goal', 'goal', 'research']);
    expect(buildRunInspection(pending).planApproval).toMatchObject({ status: 'pending', planVersion: plan.baseVersion });
    await expect(queuePlanApproval(f.stateFile, { id: 'stale', planVersion: 'other-version' }))
      .rejects.toThrow('math_plan_approval_version_conflict');
    expect(f.start).toHaveBeenCalledOnce();
    await queuePlanApproval(f.stateFile, { id: 'approval', planVersion: plan.baseVersion });
    await running;
    expect(setWaiting.mock.calls).toEqual([[true], [false]]);
    expect(f.start).toHaveBeenCalledTimes(2);
    expect(stopForFreeze).toHaveBeenCalledTimes(2);
    expect(f.check).toHaveBeenCalledOnce();
    expect(stopForFreeze.mock.invocationCallOrder[1]).toBeLessThan(f.check.mock.invocationCallOrder[0]!);
    expect(buildRunInspection(readSolverRunState(f.stateFile)).planApproval).toMatchObject({
      status: 'approved', approvedId: 'approval', approvedVersion: plan.baseVersion,
    });
  });

  function saveStoppedPlan(f: ReturnType<typeof fixture>) {
    f.state.phase = 'finished';
    const goals = f.state.problem.targets.map(target => ({ theoremName: target.theoremName, objective: 'Check the identity.' }));
    const { planVersion } = publishNativeApprovalPlan(f.state, { operation: 'publish_plan', goals },
      () => writeSolverRunState(f.stateFile, f.state), f.emit);
    return planVersion;
  }

  it('reopens a stopped approval wait without starting a second planning turn', async () => {
    const stoppedThread = 'saved-planning-thread';
    const setWaiting = vi.fn();
    const f = fixture(async options => {
      expect(options.threadId).toBe(stoppedThread);
      expect(options.readOnlyWorkspace).toBeUndefined();
      return { threadId: stoppedThread, close: async () => {}, interrupt: async () => {},
        stopForFreeze: async () => ({ status: 'stopped' }),
        run: async (message, _id, _workspace, started) => {
          expect(message).toContain('The human approved plan version');
          started('proof-turn'); return 'completed';
        } };
    }, { turns: 1, threadId: stoppedThread }, 2, { review: true, setWaiting });
    const planVersion = saveStoppedPlan(f);
    await expect(queuePlanApproval(f.stateFile, { id: 'before-resume', planVersion }))
      .rejects.toThrow('math_plan_approval_run_inactive');
    const running = f.run();
    let approvalQueued = false;
    try {
      await vi.waitFor(() => expect(setWaiting).toHaveBeenCalledWith(true));
      expect(f.start).not.toHaveBeenCalled();
      const receipt = await queuePlanApproval(f.stateFile, { id: 'after-resume', planVersion });
      approvalQueued = true;
      expect(receipt).toMatchObject({ status: 'queued' });
    } finally {
      if (!approvalQueued) {
        f.controller.abort();
        await running.catch(() => {});
      }
    }
    await running;
    expect(f.start).toHaveBeenCalledOnce();
    expect(buildRunInspection(readSolverRunState(f.stateFile)).planApproval)
      .toMatchObject({ status: 'approved', approvedVersion: planVersion });
  });

  it.each(['turns', 'tokens', 'time'])('settles a pending plan with no %s allowance', async limit => {
    const setWaiting = vi.fn(() => f.controller.abort(new Error('unexpected wait behind exhausted budget')));
    const f = fixture(async () => { throw new Error('unexpected model dispatch'); },
      { turns: 1, threadId: 'saved-planning-thread' }, limit === 'turns' ? 1 : 2, {
        review: true, setWaiting, maxTotalTokens: limit === 'tokens' ? 100 : undefined,
        remainingMs: () => limit === 'time' ? 0 : Infinity,
      });
    if (limit === 'tokens') {
      f.state.usage = { totalTokens: 100 };
      f.state.usageAccounting = { startedTurns: 1, reportedTurns: 1, pending: false, incomplete: false };
    }
    const planVersion = saveStoppedPlan(f);
    await expect(f.run()).resolves.toBeUndefined();
    expect(f.emit).toHaveBeenCalledWith('plan_approval_unanswered', expect.objectContaining({ planVersion }));
    expect(setWaiting).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  });
});
