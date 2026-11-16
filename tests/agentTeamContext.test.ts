import { describe, expect, it } from 'vitest';
import type { SolverRunState } from '../src/solver/archive';
import { agentTeamWorkerSection } from '../src/solver/agentTeamContext';
import { agentTeamStateSchema, type AgentTeamState } from '../src/solver/agentTeamState';
import type { ContextSection } from '../src/solver/contextCompiler';
import { agentTeamContextSection } from '../src/solver/skillResearchContext';

const sourceCommit = 'a'.repeat(40), savedCommit = 'b'.repeat(40);
const artifactId = 'c'.repeat(64), hostPath = '/host-private/agent-team/research/artifact.json';
const assignment = { taskId: 'current', message: 'Check the remaining hypothesis.', sourceCommit };

function fixture(overrides: Partial<AgentTeamState> = {}): SolverRunState {
  const agentTeam = agentTeamStateSchema.parse({ schema: 'theorem-os.agent-team.v1',
    workers: [{ id: 'child', role: 'researcher', worktree: '/isolated/child', seedCommit: sourceCommit,
      status: 'running', phase: 'running', turns: 2, cursor: 0,
      tasks: [{ id: 'prior', message: 'Inspect the exceptional case.', status: 'completed', summary: 'A conditional reduction.' },
        { id: assignment.taskId, message: assignment.message, status: 'running', seedCommit: sourceCommit }] }],
    events: [], deliveries: [], adoptions: [], operations: [], ...overrides });
  return { agentTeam } as SolverRunState;
}

function data(section: ContextSection) {
  return JSON.parse(section.text.slice(section.text.indexOf('\n') + 1));
}

function childData(state: SolverRunState) {
  return data(agentTeamWorkerSection(state, { id: 'child', role: 'worker' }, assignment).section);
}

describe('current team research context', () => {
  it('gives Lead and members the same advisory revision and discoverable fixed-commit artifacts without host paths', () => {
    const researchState = { revision: 3, summary: 'Use the reduction only under its compactness hypothesis.', publishedAt: 1234 };
    const state = fixture({ researchState,
      researchArtifacts: [{ id: artifactId, agentId: 'peer', taskId: 'survey', commit: savedCommit, path: hostPath }],
      events: [{ sequence: 1, from: 'lead', to: 'child', kind: 'research-updated', at: 1234,
        text: researchState.summary, researchRevision: 3 }] });
    const archived = structuredClone(state.agentTeam);
    const lead = data(agentTeamContextSection(state)), child = childData(state);
    const visibleArtifact = { id: artifactId, agentId: 'peer', taskId: 'survey', commit: savedCommit };

    for (const context of [lead, child]) {
      expect(context.researchState).toEqual({ ...researchState, advisory: true });
      expect(context.researchArtifacts).toEqual([visibleArtifact]);
      expect(Object.hasOwn(context.researchArtifacts[0], 'path')).toBe(false);
      expect(JSON.stringify(context).includes(hostPath)).toBe(false);
    }
    expect(child.inbox.events).toEqual(state.agentTeam!.events);
    expect(child.inbox.through).toBe(1);
    expect(state.agentTeam).toEqual(archived);
    expect(Object.hasOwn(state.agentTeam!.researchState!, 'advisory')).toBe(false);
  });

  it('carries the most recent cancelled task and its saved research into the replacement assignment', () => {
    const state = fixture(), worker = state.agentTeam!.workers[0]!;
    const cancelRequested = { at: 2000, reason: 'The previous interface needs a different hypothesis.', replacementTaskId: 'current' };
    worker.tasks.splice(1, 0, { id: 'cancelled-task', message: 'Prove the old interface.', status: 'cancelled',
      summary: 'The boundary case remains unresolved.', sourceCommit: savedCommit,
      researchArtifactId: artifactId, cancelRequested });
    const child = childData(state), lead = data(agentTeamContextSection(state));

    expect(child.previousTask).toMatchObject({ id: 'cancelled-task', status: 'cancelled',
      summary: 'The boundary case remains unresolved.', sourceCommit: savedCommit,
      researchArtifactId: artifactId, cancelRequested });
    expect(child.taskId).toBe('current');
    expect(child.sourceCommit).toBe(sourceCommit);
    expect(child.deliveryBaseCommit).toBe(sourceCommit);
    expect(lead.workers[0].tasks[1]).toMatchObject({ id: 'cancelled-task', status: 'cancelled',
      sourceCommit: savedCommit, researchArtifactId: artifactId, cancelRequested });
  });

  it('makes an in-flight cancellation visible without treating the current task as stopped', () => {
    const state = fixture(), current = state.agentTeam!.workers[0]!.tasks.at(-1)!;
    current.cancelRequested = { at: 2500, reason: 'A decisive counterexample changed the route.' };
    const child = childData(state), lead = data(agentTeamContextSection(state));

    expect(child.cancelRequested).toEqual(current.cancelRequested);
    expect(child.taskId).toBe(current.id);
    expect(lead.workers[0].tasks.at(-1)).toMatchObject({ id: current.id, status: 'running',
      cancelRequested: current.cancelRequested });
    expect(current.status).toBe('running');
  });

  it('reads historical team records without inventing a shared revision, artifact or completed-source reference', () => {
    const original = fixture();
    const state = { agentTeam: agentTeamStateSchema.parse(JSON.parse(JSON.stringify(original.agentTeam))) } as SolverRunState;
    const lead = data(agentTeamContextSection(state)), child = childData(state);

    for (const context of [lead, child]) {
      expect(Object.hasOwn(context, 'researchState')).toBe(false);
      expect(context.researchArtifacts).toEqual([]);
    }
    expect(child.previousTask).toMatchObject({ id: 'prior', status: 'completed', summary: 'A conditional reduction.' });
    expect(Object.hasOwn(child.previousTask, 'sourceCommit')).toBe(false);
    expect(Object.hasOwn(child.previousTask, 'researchArtifactId')).toBe(false);
    expect(child.inbox).toMatchObject({ after: 0, through: 0, events: [] });
  });
});
