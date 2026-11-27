import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import type { ModelRequestGate } from '../src/runtime/modelRequest';
import { AgentResearchTeam } from '../src/solver/agentTeam';
import { agentTeamStateSchema } from '../src/solver/agentTeamState';
import { agentTeamOverview } from '../src/solver/agentTeamViews';
import { directSolverModules } from '../src/solver/modules';
import { git, readSolverProblem } from '../src/solver/problem';
import { beginRequestUsage, initializeRequestUsageAccounting } from '../src/solver/usageBudget';
import { temporaryDirectory } from './helpers/files';
import { solverState } from './helpers/solver';

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.team.close(); fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = temporaryDirectory('agent-team-handoffs-');
  const receipt = bootstrapLeanTask(path.join(directory, 'lead'), {
    task: 'Disposable proof handoff fixture.', source: 'theorem original : True := by sorry\n',
  });
  const problem = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath);
  const state = solverState(problem, receipt.workspaceRoot, { runId: 'proof-handoffs', phase: 'running',
    threadId: 'saved-lead-thread', researchMode: 'skill', researchDelegation: { mode: 'team', maxAgents: 3 },
    agentTeam: { schema: 'theorem-os.agent-team.v1', transport: 'native-agent-control', workers: [], events: [], deliveries: [], adoptions: [], operations: [],
      coordination: { revision: 1, at: 1, decision: 'defer', reason: 'Historical optional note.',
        nextStep: 'Inspect one definition.', startedRequests: 0, eventSequence: 0 },
      coordinationPresentation: { at: 2, reason: 'opening', decisionRevision: 1, eventSequence: 0 },
      coordinationObservation: { revision: 1, at: 3, key: 'old-probe', kind: 'tool-result', failed: true, description: 'Old tool diagnostic.' } },
  });
  state.agentTeam = agentTeamStateSchema.parse(JSON.parse(JSON.stringify(state.agentTeam)));
  initializeRequestUsageAccounting(state);
  const events: string[] = [], open = vi.fn(async () => { throw new Error('No model is used by the handoff fixture.'); });
  const team = new AgentResearchTeam({ state, root: process.cwd(), taskText: 'Disposable proof handoff fixture.',
    leadAccess: { environment: {}, retrievalRoot: receipt.workspaceRoot },
    modules: { ...directSolverModules, M1: { ...directSolverModules.M1, open } },
    executable: 'unused-offline-fixture', profile: 'unused-offline-fixture', signal: new AbortController().signal,
    maxAgents: 3, maxTurns: Infinity, maxTurnMs: Infinity, maxTotalTokens: 0, remainingMs: () => Infinity,
    save: () => {}, emit: event => { events.push(event); }, exclusiveCheck: operation => operation() });
  const f = { directory, state, team, events, open, sourceFile: path.join(receipt.projectRoot, 'Submission.lean') };
  fixtures.push(f); return f;
}

describe('native proof handoff adapter', () => {
  it('reads historical coordination fields without turning them or incoming messages into a research gate', () => {
    const f = fixture(), notes = structuredClone(f.state.agentTeam);
    const source = fs.readFileSync(f.sourceFile, 'utf8'), head = git(f.state.worktree, ['rev-parse', 'HEAD']);
    const base: ModelRequestGate = identity => ({ allowed: true, settle: beginRequestUsage(f.state, identity) });
    const gate = f.team.leadRequestGate(base); f.team.beginLeadTurn();
    for (let i = 1; i <= 3; i++) {
      f.team.archive.events.push({ sequence: i, from: 'expert', to: 'lead', kind: 'message', at: i, text: 'A native finding.' });
      const request = gate({ requestId: `ordinary-research-${i}`, threadId: f.state.threadId });
      if (!request.allowed) throw new Error(request.reason);
      expect(gate.checkpoint!()).toBe(false);
      request.settle({ complete: true, outcome: 'completed', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } });
      expect(gate.checkpoint!()).toBe(false);
    }
    expect(agentTeamOverview(f.state)).not.toHaveProperty('coordination');
    expect(f.team.archive.coordination).toEqual(notes!.coordination);
    expect(f.team.archive.coordinationPresentation).toEqual(notes!.coordinationPresentation);
    expect(f.team.archive.coordinationObservation).toEqual(notes!.coordinationObservation);
    expect(f.events).toEqual([]); expect(f.open).not.toHaveBeenCalled();
    expect(git(f.state.worktree, ['rev-parse', 'HEAD'])).toBe(head); expect(fs.readFileSync(f.sourceFile, 'utf8')).toBe(source);
  });

  it.each(['adopt', 'finish', 'base'] as const)('retains the %s checkpoint and waits for paid response settlement', async kind => {
    const f = fixture(); let baseCheckpoint = false;
    const beforeRequest = vi.fn(async () => {});
    const base: ModelRequestGate = identity => ({ allowed: true, settle: beginRequestUsage(f.state, identity) });
    base.checkpoint = () => baseCheckpoint; base.beforeRequest = beforeRequest;
    const gate = f.team.leadRequestGate(base); f.team.beginLeadTurn();
    await gate.beforeRequest!(new AbortController().signal); expect(beforeRequest).toHaveBeenCalledOnce();
    const request = gate({ requestId: 'last-paid-response', threadId: f.state.threadId });
    if (!request.allowed) throw new Error(request.reason);
    if (kind === 'adopt') f.team.archive.adoptions.push({ id: 'adoption', deliveryId: 'b'.repeat(64), targetId: 'lead', status: 'queued' });
    if (kind === 'finish') await f.team.tools().call('theoremos_team', { operation: 'finish', summary: 'Saved sources ready for independent checking.' }, {
      callId: 'finish', turnId: 'current', threadId: f.state.threadId!, signal: new AbortController().signal,
    });
    expect(gate.checkpoint!()).toBe(false);
    request.settle({ complete: true, outcome: 'completed', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } });
    if (kind === 'base') baseCheckpoint = true;
    expect(gate.checkpoint!()).toBe(true); expect(gate.checkpoint!()).toBe(true);
    expect(f.team.leadAdoptionCheckpoint).toBe(kind === 'adopt'); expect(f.team.leadCompletionCheckpoint).toBe(kind === 'finish');
    expect(f.events).toEqual(kind === 'base' ? [] : [kind === 'adopt' ? 'team_adoption_checkpoint' : 'team_completion_checkpoint']);
    expect(f.team.archive.deliveries).toHaveLength(0); expect(f.state.check).toBeUndefined(); expect(f.open).not.toHaveBeenCalled();
  });

  it('honors a recovered adoption before admitting another paid response', () => {
    const f = fixture(), base = vi.fn(() => ({ allowed: true as const, settle: () => {} }));
    f.team.archive.adoptions.push({ id: 'recovered', deliveryId: 'b'.repeat(64), targetId: 'lead', status: 'queued' });
    const gate = f.team.leadRequestGate(base); f.team.beginLeadTurn();
    expect(gate.checkpoint!()).toBe(true); expect(base).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled();
  });
});
