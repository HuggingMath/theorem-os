import type { SolverRunState } from './archive';
import type { AgentTeamState } from './agentTeamState';

type Decision = NonNullable<AgentTeamState['coordination']>;

/** A coordination observation, never a proof result or an inbox acknowledgment. */
export function agentTeamCoordinationReview(state: Readonly<SolverRunState>) {
  const team = state.agentTeam, decision = team?.coordination;
  const latestIncoming = team?.events.findLast(event => event.to === 'lead' && event.from !== 'lead')?.sequence ?? 0;
  const active = team?.workers.some(worker => worker.tasks.some(task =>
    ['queued', 'running'].includes(task.status) && !task.cancelRequested)) ?? false;
  let reason: 'opening' | 'deferred-step-complete' | 'team-update' | 'members-idle' | undefined;
  if (state.researchDelegation?.mode === 'team' && state.researchDelegation.maxAgents > 1 &&
      !team?.adoptions.some(item => item.targetId === 'lead' && ['queued', 'integrating'].includes(item.status))) {
    if (!decision && !active) reason = 'opening';
    else if (latestIncoming > (decision?.eventSequence ?? 0)) reason = 'team-update';
    else if (decision && !active && (state.requestUsageAccounting?.startedRequests ?? 0) > decision.startedRequests)
      reason = decision.decision === 'defer' ? 'deferred-step-complete' : 'members-idle';
  }
  const presented = team?.coordinationPresentation;
  const checkpointRequired = reason !== undefined && (!presented || presented.reason !== reason ||
    presented.decisionRevision !== (decision?.revision ?? 0) || presented.eventSequence !== latestIncoming);
  return { required: reason !== undefined, checkpointRequired, reason, decision, activeAssignments: active,
    latestIncomingSequence: latestIncoming,
    instruction: reason ? 'Make the collaboration decision now. Spawn or assign a useful complementary question, ' +
      'or call coordinate with decision, reason and nextStep. A defer needs a concrete reason and the bounded research step ' +
      'that will inform reconsideration; no completed proof route or exact helper type is required. ' +
      'For a team update, poll the durable inbox and inspect relevant results before choosing how to continue. ' +
      'You choose the questions, methods and number of members.' : undefined };
}

/** Record context presentation, by host handoff or accepted native history.
 * The review stays pending until Lead decides. */
export function recordAgentTeamCoordinationPresentation(state: SolverRunState) {
  const review = agentTeamCoordinationReview(state);
  if (!review.checkpointRequired || !review.reason) return;
  return state.agentTeam!.coordinationPresentation = { at: Date.now(), reason: review.reason,
    decisionRevision: review.decision?.revision ?? 0, eventSequence: review.latestIncomingSequence };
}

export function recordAgentTeamCoordination(state: SolverRunState,
  input: Pick<Decision, 'decision' | 'reason' | 'nextStep'>): Decision {
  const team = state.agentTeam!;
  return team.coordination = { decision: input.decision, reason: input.reason, nextStep: input.nextStep,
    revision: (team.coordination?.revision ?? 0) + 1, at: Date.now(),
    startedRequests: state.requestUsageAccounting?.startedRequests ?? 0,
    eventSequence: team.events.at(-1)?.sequence ?? 0 };
}
