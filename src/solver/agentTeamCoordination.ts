import type { SolverRunState } from './archive';
import type { AgentTeamState } from './agentTeamState';

type Decision = NonNullable<AgentTeamState['coordination']>;

/** Tasks are retained; each objective revision advances the shared assignment state. */
export function agentTeamAssignmentRevision(team?: Readonly<AgentTeamState>) {
  return team?.workers.reduce((sum, worker) => sum + worker.tasks.reduce((total, task) =>
    total + (task.objectiveRevision ?? 1), 0), 0) ?? 0;
}

/** A coordination observation, never a proof result or an inbox acknowledgment. */
export function agentTeamCoordinationReview(state: Readonly<SolverRunState>) {
  const team = state.agentTeam, decision = team?.coordination;
  const latestIncoming = team?.events.findLast(event => event.to === 'lead' && event.from !== 'lead')?.sequence ?? 0;
  // Native messages remain in the native mailbox. Retain attempted delivery
  // across recovery: uncertain acceptance is not an acknowledgment or a reason
  // to forget an unassessed update.
  const latestNativeIncoming = team?.nativeControl?.mailbox.reduce((latest, item) =>
    item.threadId === team.nativeControl!.rootThreadId && item.author !== '/root' &&
      item.hostEventSequence === undefined && item.status !== 'queued'
      ? Math.max(latest, item.sequence ?? 0) : latest, 0) ?? 0;
  const nativeDeliveryUncertain = team?.nativeControl?.mailbox.some(item =>
    item.threadId === team.nativeControl!.rootThreadId && item.author !== '/root' && item.status === 'uncertain' &&
    item.hostEventSequence === undefined &&
    (item.sequence ?? 0) > (decision?.nativeMessageSequence ?? 0)) ?? false;
  const active = team?.workers.some(worker => worker.tasks.some(task =>
    ['queued', 'running'].includes(task.status) && !task.cancelRequested)) ?? false;
  const assigned = active || (team?.workers.some(worker => worker.tasks.some(task =>
    task.status === 'paused' && !task.cancelRequested)) ?? false);
  const assignmentRevision = agentTeamAssignmentRevision(team);
  let reason: 'opening' | 'deferred-step-complete' | 'team-update' | 'members-idle' | 'assignments-unpublished' | undefined;
  if (state.researchDelegation?.mode === 'team' && state.researchDelegation.maxAgents > 1 &&
      !team?.adoptions.some(item => item.targetId === 'lead' && ['queued', 'integrating'].includes(item.status))) {
    if (!decision && !active) reason = 'opening';
    else if (latestIncoming > (decision?.eventSequence ?? 0) ||
      latestNativeIncoming > (decision?.nativeMessageSequence ?? 0)) reason = 'team-update';
    else if (assigned && assignmentRevision !== team?.researchState?.assignmentRevision) reason = 'assignments-unpublished';
    else if (decision && !active && (state.requestUsageAccounting?.startedRequests ?? 0) > decision.startedRequests)
      reason = decision.decision === 'defer' ? 'deferred-step-complete' : 'members-idle';
  }
  const presented = team?.coordinationPresentation;
  const startedRequests = state.requestUsageAccounting?.startedRequests ?? 0;
  const checkpointRequired = reason !== undefined && (!presented || presented.reason !== reason ||
    presented.decisionRevision !== (decision?.revision ?? 0) || presented.eventSequence !== latestIncoming ||
    (presented.nativeMessageSequence ?? 0) !== latestNativeIncoming ||
    startedRequests > (presented.startedRequests ?? 0));
  return { required: reason !== undefined, checkpointRequired, reason, decision, activeAssignments: active,
    latestIncomingSequence: latestIncoming, latestNativeMessageSequence: latestNativeIncoming, nativeDeliveryUncertain,
    instruction: reason === 'assignments-unpublished'
      ? 'Publish the current shared route, each assignment\'s useful output and consumer, and your own work. ' +
        'If work deliberately overlaps, explain its purpose. Identify the first result worth sharing; request a status update ' +
        'through the native messaging tools when a member\'s progress is unknown.'
      : reason ? 'Make the collaboration decision now. Spawn or assign a useful complementary question, ' +
      'or call coordinate with decision, reason and nextStep. A defer needs a concrete reason and the bounded research step ' +
      'that will inform reconsideration; no completed proof route or exact helper type is required. ' +
      'For a team update, read the native messages or durable inbox and inspect relevant results before choosing how to continue. ' +
      (nativeDeliveryUncertain ? 'Native delivery is uncertain after recovery or disconnection: inspect the saved conversation or ask the member for its status before assessing this update. ' : '') +
      'You choose the questions, methods and number of members.' : undefined };
}

/** Record context presentation, by host handoff or accepted native history.
 * The review stays pending until Lead decides. */
export function recordAgentTeamCoordinationPresentation(state: SolverRunState) {
  const review = agentTeamCoordinationReview(state);
  if (!review.checkpointRequired || !review.reason) return;
  return state.agentTeam!.coordinationPresentation = { at: Date.now(), reason: review.reason,
    decisionRevision: review.decision?.revision ?? 0, eventSequence: review.latestIncomingSequence,
    nativeMessageSequence: review.latestNativeMessageSequence,
    startedRequests: state.requestUsageAccounting?.startedRequests ?? 0 };
}

export function recordAgentTeamCoordination(state: SolverRunState,
  input: Pick<Decision, 'decision' | 'reason' | 'nextStep'>): Decision {
  const team = state.agentTeam!;
  return team.coordination = { decision: input.decision, reason: input.reason, nextStep: input.nextStep,
    revision: (team.coordination?.revision ?? 0) + 1, at: Date.now(),
    startedRequests: state.requestUsageAccounting?.startedRequests ?? 0,
    eventSequence: team.events.at(-1)?.sequence ?? 0,
    nativeMessageSequence: agentTeamCoordinationReview(state).latestNativeMessageSequence };
}
