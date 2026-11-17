import { describe, expect, it } from 'vitest';
import type { SolverRunState } from '../src/solver/archive';
import { agentTeamStateSchema, type AgentTeamWorker } from '../src/solver/agentTeamState';
import { agentTeamAssignmentRevision, agentTeamCoordinationReview, recordAgentTeamCoordination } from '../src/solver/agentTeamCoordination';
import { agentTeamOverview, agentTeamTaskHistory } from '../src/solver/agentTeamViews';

function fixture() {
  return { researchDelegation: { mode: 'team', maxAgents: 3 }, turns: 0,
    requestUsageAccounting: { startedRequests: 0, reportedRequests: 0, pendingRequests: 0, incomplete: false },
    agentTeam: { schema: 'theorem-os.agent-team.v1', workers: [], events: [], deliveries: [], adoptions: [], operations: [] },
  } as unknown as SolverRunState;
}

function addWorker(state: SolverRunState, status: 'running' | 'paused' = 'running') {
  state.agentTeam!.workers.push({ id: 'expert', role: 'researcher', worktree: '/fixture/expert', seedCommit: 'a'.repeat(40),
    phase: 'running', turns: 0, cursor: 0, status,
    tasks: [{ id: 'task', message: 'A complementary question.', status, turns: 0 }],
  } as AgentTeamWorker);
}

describe('Lead collaboration decisions and review observations', () => {
  it('allows opening orientation and preserves a concrete deferred choice across state serialization', () => {
    const state = fixture();
    expect(agentTeamCoordinationReview(state)).toMatchObject({ required: true, reason: 'opening' });
    recordAgentTeamCoordination(state, { decision: 'defer', reason: 'The notation is ambiguous.', nextStep: 'Inspect its definition.' });
    const restored = { ...state, agentTeam: agentTeamStateSchema.parse(JSON.parse(JSON.stringify(state.agentTeam))) };
    expect(agentTeamCoordinationReview(restored).required).toBe(false);
    restored.requestUsageAccounting!.startedRequests++;
    expect(agentTeamCoordinationReview(restored)).toMatchObject({ required: true, reason: 'deferred-step-complete' });
    expect(restored.agentTeam.coordination).toMatchObject({ reason: 'The notation is ambiguous.', nextStep: 'Inspect its definition.' });
    expect(restored.agentTeam.workers).toHaveLength(0);
  });

  it('keeps active complementary work running and revisits an idle or paused team', () => {
    const state = fixture(); addWorker(state);
    expect(agentTeamCoordinationReview(state).reason).toBe('assignments-unpublished');
    state.agentTeam!.researchState = { revision: 1, summary: 'Shared route and ownership.', publishedAt: 1,
      assignmentRevision: agentTeamAssignmentRevision(state.agentTeam) };
    recordAgentTeamCoordination(state, { decision: 'delegate', reason: 'Question assigned.', nextStep: 'Work on the consumer.' });
    state.requestUsageAccounting!.startedRequests = 20;
    expect(agentTeamCoordinationReview(state).required).toBe(false);
    state.agentTeam!.workers[0]!.tasks[0]!.status = 'paused';
    expect(agentTeamCoordinationReview(state)).toMatchObject({ required: true, reason: 'members-idle' });
  });

  it('does not require a nonexistent member slot or delay a pending Lead adoption handoff', () => {
    const state = fixture(); state.researchDelegation!.maxAgents = 1;
    expect(agentTeamCoordinationReview(state).required).toBe(false);
    state.researchDelegation!.maxAgents = 3;
    state.agentTeam!.adoptions.push({ id: 'adoption', deliveryId: 'b'.repeat(64), targetId: 'lead', status: 'queued' });
    expect(agentTeamCoordinationReview(state).required).toBe(false);
    state.agentTeam!.adoptions[0]!.status = 'failed';
    expect(agentTeamCoordinationReview(state)).toMatchObject({ required: true, reason: 'opening' });
  });

  it('requires publication when a paused assignment is amended before it resumes', () => {
    const state = fixture(); addWorker(state, 'paused');
    recordAgentTeamCoordination(state, { decision: 'delegate', reason: 'Saved assignment.', nextStep: 'Wait for its dependency.' });
    state.agentTeam!.researchState = { revision: 1, summary: 'Saved shared route.', publishedAt: 1,
      assignmentRevision: agentTeamAssignmentRevision(state.agentTeam) };
    expect(agentTeamCoordinationReview(state).required).toBe(false);
    state.agentTeam!.workers[0]!.tasks[0]!.objectiveRevision = 2;
    expect(agentTeamCoordinationReview(state).reason).toBe('assignments-unpublished');
    recordAgentTeamCoordination(state, { decision: 'continue', reason: 'Amended while paused.', nextStep: 'Wait.' });
    expect(agentTeamCoordinationReview(state).reason).toBe('assignments-unpublished');
  });

  it('tracks addressed updates without consuming messages or treating self-publications as new findings', () => {
    const state = fixture(); addWorker(state);
    state.agentTeam!.researchState = { revision: 1, summary: 'Shared route and ownership.', publishedAt: 1,
      assignmentRevision: agentTeamAssignmentRevision(state.agentTeam) };
    recordAgentTeamCoordination(state, { decision: 'delegate', reason: 'Question assigned.', nextStep: 'Check the interface.' });
    state.agentTeam!.events.push({ sequence: 1, from: 'lead', to: 'lead', kind: 'research-updated', at: 1, text: 'Current route.' });
    expect(agentTeamCoordinationReview(state).required).toBe(false);
    state.agentTeam!.events.push({ sequence: 2, from: 'expert', to: 'lead', kind: 'message', at: 2, text: 'An unresolved interface.' });
    expect(agentTeamCoordinationReview(state)).toMatchObject({ required: true, reason: 'team-update' });
    recordAgentTeamCoordination(state, { decision: 'continue', reason: 'The interface remains sufficient.', nextStep: 'Test the consumer.' });
    expect(agentTeamCoordinationReview(state).required).toBe(false);
    expect(state.agentTeam!.events.map(event => event.text)).toEqual(['Current route.', 'An unresolved interface.']);
    expect(state.agentTeam!.workers[0]!.cursor).toBe(0);
  });

  it('observes accepted native messages without treating queued messages or peer traffic as delivered to Lead', () => {
    const state = fixture();
    recordAgentTeamCoordination(state, { decision: 'continue', reason: 'Current work.', nextStep: 'Check the result.' });
    state.agentTeam!.nativeControl = { sessionId: 'session', rootThreadId: 'lead-thread', sequence: 3,
      mailbox: [
        { id: 'pending', threadId: 'lead-thread', author: '/root/expert', recipient: '/root', sequence: 1, status: 'queued' },
        { id: 'peer', threadId: 'peer-thread', author: '/root/expert', recipient: '/root/peer', sequence: 2, status: 'accepted' },
      ] };
    expect(agentTeamCoordinationReview(state).required).toBe(false);
    state.agentTeam!.nativeControl.mailbox[0]!.status = 'accepted';
    expect(agentTeamCoordinationReview(state)).toMatchObject({ required: true, reason: 'team-update', latestNativeMessageSequence: 1 });
    recordAgentTeamCoordination(state, { decision: 'continue', reason: 'Native finding assessed.', nextStep: 'Use the finding.' });
    const restored = { ...state, agentTeam: agentTeamStateSchema.parse(JSON.parse(JSON.stringify(state.agentTeam))) };
    expect(agentTeamCoordinationReview(restored).required).toBe(false);
    restored.agentTeam.nativeControl!.mailbox.push({ id: 'next', threadId: 'lead-thread', author: '/root/expert',
      recipient: '/root', sequence: 3, status: 'accepted' });
    expect(agentTeamCoordinationReview(restored)).toMatchObject({ required: true, reason: 'team-update', latestNativeMessageSequence: 3 });
    expect(restored.agentTeam.events).toHaveLength(0);
  });

  it('does not assess a host event again when its native notification arrives later', () => {
    const state = fixture();
    state.agentTeam!.events.push({ sequence: 1, from: 'expert', to: 'lead', kind: 'progress', at: 1, text: 'A local result.' });
    recordAgentTeamCoordination(state, { decision: 'continue', reason: 'Progress assessed.', nextStep: 'Use the result.' });
    state.agentTeam!.nativeControl = { sessionId: 'session', rootThreadId: 'lead-thread', sequence: 2,
      mailbox: [{ id: 'late-host-notification', threadId: 'lead-thread', author: '/root/expert', recipient: '/root',
        hostEventSequence: 1, sequence: 2, status: 'accepted' }] };
    expect(agentTeamCoordinationReview(state).required).toBe(false);
    state.agentTeam!.nativeControl.mailbox[0]!.status = 'uncertain';
    expect(agentTeamCoordinationReview(state)).toMatchObject({ required: false, nativeDeliveryUncertain: false });
  });

  it('bounds decision previews while history retains their complete arguments and next step', () => {
    const state = fixture();
    const reason = 'r'.repeat(16000), nextStep = 's'.repeat(16000);
    recordAgentTeamCoordination(state, { decision: 'defer', reason, nextStep });
    const overview = agentTeamOverview(state);
    expect(JSON.stringify(overview).length).toBeLessThan(6000);
    expect(overview.coordination!.decision).toMatchObject({ textTruncated: true });
    expect(agentTeamTaskHistory(state.agentTeam!).coordination).toMatchObject({ reason, nextStep });
    expect(agentTeamOverview(state, { focusAgentId: 'expert' }).coordination).toBeUndefined();
  });
});
