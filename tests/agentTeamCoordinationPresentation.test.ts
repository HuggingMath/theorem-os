import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import type { MathAgentSession } from '../src/runtime/agentSession';
import type { ModelRequestGate } from '../src/runtime/modelRequest';
import type { SolverRunState } from '../src/solver/archive';
import { AgentResearchTeam } from '../src/solver/agentTeam';
import { agentTeamCoordinationReview, recordAgentTeamCoordination } from '../src/solver/agentTeamCoordination';
import { agentTeamStateSchema } from '../src/solver/agentTeamState';
import { agentTeamOverview } from '../src/solver/agentTeamViews';
import { directSolverModules } from '../src/solver/modules';
import { git, readSolverProblem } from '../src/solver/problem';
import { beginRequestUsage } from '../src/solver/usageBudget';
import { temporaryDirectory } from './helpers/files';
import { solverState } from './helpers/solver';
import { deferred } from './helpers/async';

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await Promise.all(f.teams.map(team => team.close()));
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = temporaryDirectory('agent-team-coordination-presentation-');
  const receipt = bootstrapLeanTask(path.join(directory, 'lead'), {
    task: 'Disposable coordination fixture.', source: 'theorem original : True := by sorry\n',
  });
  const problem = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath);
  const state = solverState(problem, receipt.workspaceRoot, { runId: 'coordination-presentation', phase: 'running',
    threadId: 'saved-lead-thread', researchMode: 'skill', researchDelegation: { mode: 'team', maxAgents: 3 },
    requestUsageAccounting: { startedRequests: 0, reportedRequests: 0, pendingRequests: 0, incomplete: false },
    agentTeam: { schema: 'theorem-os.agent-team.v1', workers: [], events: [], deliveries: [], adoptions: [], operations: [] },
  });
  const stateFile = path.join(directory, 'state.json'), teams: AgentResearchTeam[] = [];
  const events: { event: string; details?: Record<string, unknown> }[] = [];
  const open = vi.fn(async () => { throw new Error('The coordination fixture never starts a model or writer.'); });
  const makeTeam = (currentState = state) => {
    const team = new AgentResearchTeam({ state: currentState, root: process.cwd(), taskText: 'Disposable coordination fixture.',
      leadAccess: { environment: {}, retrievalRoot: receipt.workspaceRoot },
      modules: { ...directSolverModules, M1: { ...directSolverModules.M1, open } },
      executable: 'unused-offline-fixture', profile: 'unused-offline-fixture', signal: new AbortController().signal,
      maxAgents: 3, maxTurns: Infinity, maxTurnMs: Infinity, maxTotalTokens: 0, remainingMs: () => Infinity,
      save: () => fs.writeFileSync(stateFile, JSON.stringify(currentState)),
      emit: (event, details) => events.push({ event, details }), exclusiveCheck: operation => operation() });
    teams.push(team); return team;
  };
  const team = makeTeam();
  const requestGate = (target = team, currentState = state) => {
    const base: ModelRequestGate = identity => ({ allowed: true, settle: beginRequestUsage(currentState, identity) });
    return target.leadRequestGate(base);
  };
  const settle = (gate: ModelRequestGate, requestId: string, currentState = state) => {
    const admitted = gate({ requestId, threadId: currentState.threadId });
    if (!admitted.allowed) throw new Error(admitted.reason);
    expect(gate.checkpoint!(), 'an admitted response must finish before handoff').toBe(false);
    admitted.settle({ complete: true, outcome: 'completed', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } });
  };
  const incoming = (currentState = state, kind: 'completed' | 'message' = 'completed') => {
    const sequence = (currentState.agentTeam!.events.at(-1)?.sequence ?? 0) + 1;
    currentState.agentTeam!.events.push({ sequence, from: 'expert', to: 'lead', kind, at: Date.now(), text: 'Saved member evidence.' });
    return sequence;
  };
  const f = { directory, stateFile, state, team, teams, events, open, makeTeam, requestGate, settle, incoming,
    sourceFile: path.join(receipt.projectRoot, 'Submission.lean') };
  fixtures.push(f); return f;
}

describe('one coordination handoff per outstanding event or decision', () => {
  it.each([false, true])('uses acknowledged native history to present an update, retaining handoff on failure (failed=%s)', async failed => {
    const f = fixture();
    f.team.archive.workers.push({ id: 'expert', role: 'researcher', worktree: path.join(f.directory, 'expert'),
      phase: 'prepared', status: 'idle', turns: 0, seedCommit: f.state.problem.baseCommit, tasks: [], cursor: 0 });
    recordAgentTeamCoordination(f.state, { decision: 'delegate', reason: 'A question was assigned.', nextStep: 'Assess incoming findings.' });
    const notify = vi.fn(async () => { if (failed) throw new Error('native history unavailable'); });
    const session: MathAgentSession = { threadId: f.state.threadId!, advisoryNotifications: 'native-history', notify,
      run: async () => 'completed', interrupt: async () => {}, close: async () => {} };
    f.team.setLeadSession(session);
    const gate = f.requestGate(); f.team.beginLeadTurn(); f.settle(gate, 'current-work');
    const decision = structuredClone(f.team.archive.coordination);
    await f.team.tools('expert').call('theoremos_team', { operation: 'message', agentId: 'lead', message: 'A useful partial result.' }, {
      callId: 'native-message', turnId: 'expert-turn', threadId: 'expert-thread', signal: new AbortController().signal,
    });
    expect(notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('A useful partial result.'), { mode: 'advisory' });
    expect(gate.checkpoint!()).toBe(failed);
    expect(f.team.leadCoordinationCheckpoint).toBe(failed);
    expect(agentTeamCoordinationReview(f.state)).toMatchObject({ required: true, reason: 'team-update', checkpointRequired: false });
    expect(f.team.archive.coordination).toEqual(decision);
    const inbox = await f.team.tools().call('theoremos_team', { operation: 'poll', after: 0 }, {
      callId: 'read-native-update', turnId: 'lead-turn', threadId: f.state.threadId!, signal: new AbortController().signal,
    });
    expect(inbox).toMatchObject({ events: [{ sequence: 1, text: 'A useful partial result.' }] });
    expect(f.events.filter(event => event.event === 'team_coordination_checkpoint')).toHaveLength(failed ? 1 : 0);
    expect(f.events.filter(event => event.event === 'team_coordination_presented')).toHaveLength(failed ? 0 : 1);
    expect(f.open).not.toHaveBeenCalled();
  });

  it('does not let an older native acknowledgment hide a newer undelivered update', async () => {
    const f = fixture(), firstDelivery = deferred();
    f.team.archive.workers.push({ id: 'expert', role: 'researcher', worktree: path.join(f.directory, 'expert'),
      phase: 'prepared', status: 'idle', turns: 0, seedCommit: f.state.problem.baseCommit, tasks: [], cursor: 0 });
    recordAgentTeamCoordination(f.state, { decision: 'delegate', reason: 'A question was assigned.', nextStep: 'Assess incoming findings.' });
    const notify = vi.fn().mockImplementationOnce(() => firstDelivery.promise)
      .mockRejectedValueOnce(new Error('later native delivery failed'));
    f.team.setLeadSession({ threadId: f.state.threadId!, advisoryNotifications: 'native-history', notify,
      run: async () => 'completed', interrupt: async () => {}, close: async () => {} });
    const gate = f.requestGate(); f.team.beginLeadTurn(); f.settle(gate, 'current-work');
    for (const message of ['Earlier finding.', 'Newer finding.']) await f.team.tools('expert').call('theoremos_team', {
      operation: 'message', agentId: 'lead', message,
    }, { callId: message, turnId: 'expert-turn', threadId: 'expert-thread', signal: new AbortController().signal });
    firstDelivery.resolve(); await Promise.resolve();
    expect(f.team.archive.coordinationPresentation).toBeUndefined();
    expect(gate.checkpoint!()).toBe(true);
    expect(f.team.archive.coordinationPresentation).toMatchObject({ reason: 'team-update', eventSequence: 2 });
    expect(f.events.filter(event => event.event === 'team_coordination_presented')).toEqual([]);
  });

  it('keeps an unassessed completed event visible through repeated settled responses without resetting Lead again', () => {
    const f = fixture();
    recordAgentTeamCoordination(f.state, { decision: 'delegate', reason: 'A question was assigned.', nextStep: 'Assess the returned result.' });
    f.incoming();
    const decision = structuredClone(f.team.archive.coordination), inbox = structuredClone(f.team.archive.events);
    const source = fs.readFileSync(f.sourceFile, 'utf8'), head = git(f.state.worktree, ['rev-parse', 'HEAD']);
    const gate = f.requestGate();
    f.team.beginLeadTurn(); f.settle(gate, 'first-result-observation');
    expect(gate.checkpoint!()).toBe(true); expect(gate.checkpoint!()).toBe(true);
    expect(f.team.archive.coordinationPresentation).toMatchObject({ reason: 'team-update', decisionRevision: 1, eventSequence: 1 });
    for (let turn = 0; turn < 16; turn++) {
      f.team.beginLeadTurn(); f.settle(gate, `continued-research-${turn}`);
      expect(gate.checkpoint!()).toBe(false);
      expect(agentTeamOverview(f.state).coordination).toMatchObject({ required: true, checkpointRequired: false, reason: 'team-update' });
      expect(agentTeamCoordinationReview(f.state).instruction).toContain('Make the collaboration decision now.');
    }
    expect(f.events.filter(event => event.event === 'team_coordination_checkpoint')).toHaveLength(1);
    expect(f.team.archive.coordination).toEqual(decision); expect(f.team.archive.events).toEqual(inbox);
    expect(f.state.threadId).toBe('saved-lead-thread'); expect(f.state.turns).toBe(0);
    expect(git(f.state.worktree, ['rev-parse', 'HEAD'])).toBe(head); expect(fs.readFileSync(f.sourceFile, 'utf8')).toBe(source);
    expect(f.state.requestUsageAccounting).toMatchObject({ startedRequests: 17, reportedRequests: 17, pendingRequests: 0, incomplete: false });
    expect(f.state.tokenBudget?.status).toBe('unlimited'); expect(f.team.archive.hostLimits).toEqual({ maxTurns: null, maxTotalTokens: 0 });
    expect(f.open).not.toHaveBeenCalled();
  });

  it('reopens for a new member event while publications and polling do not assess the outstanding result', async () => {
    const f = fixture();
    recordAgentTeamCoordination(f.state, { decision: 'continue', reason: 'Continue the current investigation.', nextStep: 'Check its interface.' });
    f.incoming();
    const gate = f.requestGate();
    f.team.beginLeadTurn(); f.settle(gate, 'result-one'); expect(gate.checkpoint!()).toBe(true);
    f.team.beginLeadTurn();
    f.team.archive.events.push({ sequence: 2, from: 'lead', to: 'lead', kind: 'research-updated', at: Date.now(), text: 'Current route.' });
    await f.team.tools().call('theoremos_team', { operation: 'poll', after: 0 }, {
      callId: 'poll-unassessed', turnId: 'lead-turn', threadId: f.state.threadId!, signal: new AbortController().signal,
    });
    f.settle(gate, 'same-result'); expect(gate.checkpoint!()).toBe(false);
    expect(f.team.archive.coordination!.eventSequence).toBe(0);
    f.incoming(f.state, 'message');
    const paid = gate({ requestId: 'new-finding', threadId: f.state.threadId });
    if (!paid.allowed) throw new Error(paid.reason);
    expect(gate.checkpoint!()).toBe(false);
    paid.settle({ complete: true, outcome: 'completed', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } });
    expect(gate.checkpoint!()).toBe(true);
    expect(f.team.archive.coordinationPresentation).toMatchObject({ reason: 'team-update', decisionRevision: 1, eventSequence: 3 });
    expect(f.events.filter(event => event.event === 'team_coordination_checkpoint')).toHaveLength(2);
    expect(agentTeamCoordinationReview(f.state).required).toBe(true);
    recordAgentTeamCoordination(f.state, { decision: 'continue', reason: 'The findings are assessed.', nextStep: 'Continue the chosen research.' });
    expect(agentTeamCoordinationReview(f.state).required).toBe(false); expect(gate.checkpoint!()).toBe(false);
    expect(f.team.archive.events).toHaveLength(3);
  });

  it('presents each deferred research step once and lets a new explicit decision reopen reconsideration', () => {
    const f = fixture(), gate = f.requestGate();
    const defer = () => recordAgentTeamCoordination(f.state, {
      decision: 'defer', reason: 'One definition needs clarification.', nextStep: 'Inspect that definition.' });
    defer();
    f.team.beginLeadTurn(); f.settle(gate, 'first-bounded-step'); expect(gate.checkpoint!()).toBe(true);
    f.team.beginLeadTurn(); f.settle(gate, 'continued-first-step'); expect(gate.checkpoint!()).toBe(false);
    expect(agentTeamCoordinationReview(f.state)).toMatchObject({ required: true, reason: 'deferred-step-complete', checkpointRequired: false });
    defer();
    expect(agentTeamCoordinationReview(f.state).required).toBe(false);
    f.team.beginLeadTurn(); f.settle(gate, 'new-bounded-step'); expect(gate.checkpoint!()).toBe(true);
    expect(f.team.archive.coordinationPresentation).toMatchObject({ reason: 'deferred-step-complete', decisionRevision: 2, eventSequence: 0 });
    expect(f.events.filter(event => event.event === 'team_coordination_checkpoint')).toHaveLength(2);
    expect(f.team.archive.workers).toHaveLength(0);
  });

  it('saves presentation before returning control and preserves it across a crash without claiming a Lead decision', () => {
    const f = fixture(), gate = f.requestGate();
    f.team.beginLeadTurn(); f.settle(gate, 'opening-orientation'); expect(gate.checkpoint!()).toBe(true);
    const saved = JSON.parse(fs.readFileSync(f.stateFile, 'utf8')) as SolverRunState;
    saved.agentTeam = agentTeamStateSchema.parse(saved.agentTeam);
    expect(saved.agentTeam.coordinationPresentation).toMatchObject({ reason: 'opening', decisionRevision: 0, eventSequence: 0 });
    expect(saved.agentTeam.coordination).toBeUndefined();
    const restored = f.makeTeam(saved), recoveredGate = f.requestGate(restored, saved);
    restored.beginLeadTurn();
    expect(recoveredGate.checkpoint!()).toBe(false);
    f.settle(recoveredGate, 'recovered-continuation', saved);
    expect(recoveredGate.checkpoint!()).toBe(false);
    expect(agentTeamOverview(saved).coordination).toMatchObject({ required: true, reason: 'opening', checkpointRequired: false });
    f.incoming(saved, 'message');
    expect(recoveredGate.checkpoint!()).toBe(true);
    expect(restored.archive.coordination).toBeUndefined(); expect(saved.threadId).toBe('saved-lead-thread');
    expect(f.open).not.toHaveBeenCalled();
  });
});
