import { buildProofContinuation, createRecordedTaskSettlement, recordedTaskProofStatus } from './progress';
import { taskConsumerInterfaces } from './taskConsumers';
import { allRoutesParked, groupOpen, isAdvisoryTask, isFinalCandidateReview, taskGroup, taskVersion, type CooperativeTask, type TaskRecord } from './tasks';
import type { CooperationState } from './cooperationShared';
import type { ProofRoute } from './proofRoutes';
import { reviewGoalPaths } from './goalPathReview';
import type { GoalPathReview } from './goalPathReview';
import { originalGoalTaskFocus } from './modules/search';

const summaryLimit = 8, referenceLimit = 4;
const reference = (task: CooperativeTask) => ({ taskId: task.id, taskDigest: taskVersion(task) });
const typedInterface = (task: CooperativeTask) => ({ ...reference(task), kind: task.kind,
  theoremName: task.theoremName, proofPath: task.proofPath, type: task.type });

/** Planning relationships only: a proposed interface and its consumers are never proof evidence. */
export function createTaskApplicationEvidence(tasks: readonly TaskRecord[], options: {
  proofRoutes?: readonly ProofRoute[]; proposals?: readonly CooperativeTask[]; environmentDigest?: string;
} = {}) {
  const current = new Map(tasks.map(node => [node.task.id, node]));
  const proposals = new Map(options.proposals?.map(proposal => [proposal.id, proposal]));
  const visible = [...tasks, ...(options.proposals ?? []).filter(proposal => !current.has(proposal.id))
    .map(proposal => ({ task: proposal, status: 'pending' as const, attempts: 0 }))];
  const recorded = createRecordedTaskSettlement(visible, options);
  return (task: CooperativeTask) => {
    const inputs = task.dependsOn.map(id => {
      const node = current.get(id), input = node?.task ?? proposals.get(id);
      const checked = Boolean(node && recorded.settled(node));
      return { ...(input ? typedInterface(input) : { taskId: id, taskDigest: null }),
        availability: !input ? 'missing' as const : isAdvisoryTask(input) ? 'advisory-only' as const :
          checked ? 'recorded-checked' as const : 'unproved' as const };
    });
    const consumers = taskConsumerInterfaces(task, visible, options.proofRoutes).map(consumer => ({
      ...typedInterface(consumer.task), uses: consumer.uses,
      remainingInputTaskIds: consumer.task.dependsOn.filter(id => id !== task.id),
    }));
    return { evidence: 'planning-only' as const, inputs, consumers,
      missingInputTaskIds: inputs.filter(input => input.availability === 'missing').map(input => input.taskId),
      unprovedInputTaskIds: inputs.filter(input => input.availability !== 'recorded-checked').map(input => input.taskId),
      consumerConnection: consumers.length ? 'recorded' as const : 'not-recorded' as const };
  };
}

/** Make local proof packages and the original frontier visible even when optional history is omitted. */
export function leadPlanningEvidence(state: Pick<CooperationState, 'tasks' | 'groups' | 'proofRoutes' | 'failedTaskInputs' | 'goalPathStall' | 'goalProgress'>,
  environmentDigest?: string, options: { goalPathReview?: GoalPathReview } = {}) {
  const continuation = buildProofContinuation(state.tasks, { groups: state.groups, proofRoutes: state.proofRoutes, environmentDigest });
  const byId = new Map(state.tasks.map(node => [node.task.id, node]));
  const recorded = createRecordedTaskSettlement(state.tasks, { proofRoutes: state.proofRoutes, environmentDigest });
  const application = createTaskApplicationEvidence(state.tasks, { proofRoutes: state.proofRoutes, environmentDigest });
  const ref = (id: string) => byId.has(id) ? reference(byId.get(id)!.task) : { taskId: id, taskDigest: null };
  const focus = originalGoalTaskFocus(state.proofRoutes ? state.tasks.map(node => ({ ...node,
    alternativeRoutes: state.proofRoutes!.filter(route => route.targetTaskId === node.task.id) })) : state.tasks,
  state.groups, environmentDigest);
  // Show missing planning links before the helper is proved. Independent work remains valid;
  // this asks the Lead to identify its use, not to invent a proof dependency or reject the plan.
  const unexplained = state.tasks.filter(node => !node.capacityExploration && !node.nextCheckId && !isFinalCandidateReview(node.task) &&
    (node.task.status ?? 'active') === 'active' && !node.routeParking?.length && !allRoutesParked(node) &&
    (!state.groups || groupOpen(state.groups.find(group => group.group.id === taskGroup(node.task)))) &&
    !recorded.settled(node) && !['completed', 'integrated'].includes(node.status) && !focus.support.has(node.task.id));
  const unconnectedProof = unexplained.filter(node => node.task.kind === 'lemma');
  const unattributedResearch = unexplained.filter(node => isAdvisoryTask(node.task));
  const connectionSummary = (node: TaskRecord) => ({ ...reference(node.task), status: node.status,
    interfaceSource: { path: 'COOPERATION.json', field: 'tasks[].task', match: 'taskId-and-taskDigest' } });
  const connectionGaps = {
    unconnectedProofTasks: unconnectedProof.slice(0, summaryLimit).map(connectionSummary),
    omittedUnconnectedProofTasks: Math.max(0, unconnectedProof.length - summaryLimit),
    unattributedResearchTasks: unattributedResearch.slice(0, summaryLimit).map(connectionSummary),
    omittedUnattributedResearchTasks: Math.max(0, unattributedResearch.length - summaryLimit),
  };
  const disconnected = new Set(continuation.unconnectedTasks);
  const packages = state.tasks.filter(node => disconnected.has(node.task.id) && !isAdvisoryTask(node.task) &&
    !node.capacityExploration && (recorded.settled(node) ||
      node.task.dependsOn.some(id => {
        const input = byId.get(id);
        return Boolean(input && !isAdvisoryTask(input.task) && recorded.settled(input));
      })));
  const localPackages = packages.slice(-summaryLimit).map(node => {
    const use = application(node.task);
    // Large closed types belong to the selected handoff, not every Lead summary of the same package.
    return { ...reference(node.task), status: node.status, recordedProof: recordedTaskProofStatus(node, environmentDigest),
      evidence: use.evidence, consumerConnection: use.consumerConnection,
      inputs: use.inputs.slice(0, referenceLimit).map(({ taskId, taskDigest, availability }) => ({ taskId, taskDigest, availability })),
      omittedInputs: Math.max(0, use.inputs.length - referenceLimit),
      consumers: use.consumers.slice(0, referenceLimit).map(({ taskId, taskDigest }) => ({ taskId, taskDigest })),
      omittedConsumers: Math.max(0, use.consumers.length - referenceLimit),
      missingInputTaskIds: use.missingInputTaskIds.slice(0, referenceLimit),
      omittedMissingInputs: Math.max(0, use.missingInputTaskIds.length - referenceLimit),
      unprovedInputTaskIds: use.unprovedInputTaskIds.slice(0, referenceLimit),
      omittedUnprovedInputs: Math.max(0, use.unprovedInputTaskIds.length - referenceLimit),
      interfaceSource: { path: 'COOPERATION.json', field: 'tasks[].task', match: 'taskId-and-taskDigest' },
      remainingConnection: 'No planned dependency or proof route connects this package to an original goal.' };
  });
  // A turn count includes provider recovery and scheduling. Only saved failure evidence requests a changed retry.
  const failuresFor = (node: TaskRecord) => (state.failedTaskInputs ?? []).filter(record => record.taskId === node.task.id &&
    record.taskDigest === taskVersion(node.task));
  const repeated = state.tasks.filter(node => !isAdvisoryTask(node.task) &&
    !recorded.settled(node) && (node.feedback?.startsWith('math_task_repeated_failed_input') ||
      failuresFor(node).some(record => record.relatedFailureIds?.length)));
  const repeatedInputs = repeated.slice(0, summaryLimit).map(node => {
    const failures = failuresFor(node);
    return { ...reference(node.task),
      basis: node.feedback?.startsWith('math_task_repeated_failed_input') ? 'current-host-feedback' : 'recorded-related-failures',
      ...(node.feedback?.startsWith('math_task_repeated_failed_input') ? { feedbackPreview: node.feedback.slice(0, 256),
        feedbackTruncated: node.feedback.length > 256,
        feedbackSource: { path: 'COOPERATION.json', field: 'peers[].feedback', match: 'id-and-taskDigest' } } : {}),
      failures: failures.slice(-2).map(record => ({ id: record.id, inputDigest: record.inputDigest,
        attemptFingerprint: record.attemptFingerprint, relatedFailureIds: record.relatedFailureIds?.slice(0, referenceLimit),
        omittedRelatedFailures: Math.max(0, (record.relatedFailureIds?.length ?? 0) - referenceLimit) })),
      omittedFailures: Math.max(0, failures.length - 2),
      requiredChange: 'For a retry of these recorded inputs, identify a changed proof step or method and its discriminating check, or the exact new premise/evidence; otherwise retain the gap and reopening condition.' };
  });
  const { evidence: _evidence, acceptance: _acceptance, stallDigest, stalledTaskIds: _tasks, stalledPathTaskIds: _path, ...review } =
    options.goalPathReview ?? reviewGoalPaths(state.tasks, { groups: state.groups, proofRoutes: state.proofRoutes, environmentDigest });
  // The Lead's earlier answers to this same stall: decline reasons, and turns that left it unanswered.
  const stall = stallDigest && state.goalPathStall?.active && state.goalPathStall.digest === stallDigest ? state.goalPathStall : undefined;
  const goalPath = { ...review,
    ...(stall?.declined?.length ? { declined: stall.declined.map(({ taskId, reason }) => ({ taskId, reason })) } : {}),
    ...(stall?.unanswered ? { unansweredTurns: stall.unanswered } : {}),
    ...(stall?.ignoredAt ? { ignored: true } : {}) };
  return { evidence: 'recorded-not-replayed' as const, acceptance: 'not-assessed' as const,
    // Whether each goal's frontier can run now, and host-proposed decisions for a goal that cannot.
    goalPath, connectionGaps,
    ...(state.goalProgress?.pending ? { progressReview: { ...state.goalProgress.pending,
      evidence: 'started-worker-execution-without-new-checked-inputs-or-frontier-closure' as const,
      goals: state.goalProgress.goals.filter(goal => state.goalProgress!.pending!.goalKeys.includes(goal.key))
        .map(({ taskId, proofPath, theoremName, activeMs, lastProgressAt, coreActiveMs, lastCoreProgressAt, lastReviewedCoreMs, coreFrontier }) =>
          ({ taskId, proofPath, theoremName, activeMs, lastProgressAt, coreActiveMs, lastCoreProgressAt, lastReviewedCoreMs,
            coreFrontier: coreFrontier?.slice(0, referenceLimit), omittedCoreFrontier: Math.max(0, (coreFrontier?.length ?? 0) - referenceLimit) })) } } : {}),
    goals: continuation.goals.slice(0, referenceLimit).map(goal => ({ ...ref(goal.taskId), recordedProof: goal.recordedProof,
      frontier: goal.frontier.slice(0, referenceLimit).map(ref), omittedFrontier: Math.max(0, goal.frontier.length - referenceLimit),
      missingDependencies: goal.missingDependencies.slice(0, referenceLimit),
      omittedMissingDependencies: Math.max(0, goal.missingDependencies.length - referenceLimit),
      ...(goal.alternatives ? { alternatives: goal.alternatives.slice(0, 2).map(route => ({ routeId: route.routeId,
        frontier: route.frontier.slice(0, referenceLimit).map(ref), omittedFrontier: Math.max(0, route.frontier.length - referenceLimit),
        missingDependencies: route.missingDependencies.slice(0, referenceLimit),
        omittedMissingDependencies: Math.max(0, route.missingDependencies.length - referenceLimit),
        parkedBy: route.parkedBy.slice(0, referenceLimit), omittedParkedBy: Math.max(0, route.parkedBy.length - referenceLimit) })),
        omittedAlternatives: Math.max(0, goal.alternatives.length - 2) } : {}) })),
    omittedGoals: Math.max(0, continuation.goals.length - referenceLimit),
    localPackages, omittedLocalPackages: Math.max(0, packages.length - localPackages.length),
    repeatedInputs, omittedRepeatedInputs: Math.max(0, repeated.length - repeatedInputs.length),
    archive: { path: 'COOPERATION.json', fields: ['tasks', 'proofRoutes', 'failedTaskInputs'] } };
}

/** The Lead's copy of the planning evidence; a stalled original goal adds the decision it is owed. */
export function leadPlanningEvidenceText(evidence: ReturnType<typeof leadPlanningEvidence>) {
  const goalPath = evidence.goalPath;
  return 'Current route applications and remaining obligations (recorded, not proof acceptance):\n' + JSON.stringify(evidence) +
    (evidence.connectionGaps.unconnectedProofTasks.length || evidence.connectionGaps.unattributedResearchTasks.length
      ? '\nPlanning connection gaps name active work with no recorded connection to an unfinished original goal. ' +
        'For an intended proof input, record the actual consumer dependency or proof route; for advisory effort, ' +
        'set consumerGoalIds to its original goals and use dependsOn only for the questions or inputs it investigates. ' +
        'A use described only in objective prose is not an executable connection. Independent exploration may remain ' +
        'unconnected when intentional; explain that choice instead of adding a speculative dependency. These are planning ' +
        'facts, not proof failure, and do not require pausing active work.' : '') +
    (evidence.progressReview ? '\nTeam progress review ' + evidence.progressReview.id + ': these original goals have accumulated worker execution ' +
      'without new recorded checked inputs or unconditional closure of a previously observed frontier obligation. ' +
      'coreActiveMs tracks effort without that closure; conditional connections can be useful while this clock continues. ' +
      'Review the remaining mathematical gap, dependencies, role allocation and route. ' +
      'Publish an ordinary validated plan revision and include "progressReview":{"id":"' + evidence.progressReview.id +
      '","reason":"evidence for the chosen route or change","nextChecks":[{"action":"construction-check",' +
      '"objective":"the next discriminating check","expectedEvidence":"the observation that will decide it",' +
      '"targetTaskId":"ACTIVE_TASK_ID"}]} beside baseVersion. Use the existing nextCheck actions ' +
      '(feasibility, apply-lemma, construction-check); each target must be an active task serving a reviewed goal. ' +
      'The host delivers these directions to that task; existing host next checks keep their checkOutcome protocol. ' +
      'You may retain a useful long proof with a specific reason and next check. Elapsed execution alone does not establish failure, ' +
      'and it does not require interrupting a worker. A checkpoint, an unaccepted plan or a description edit does not answer this review.' : '') +
    (goalPath.stalledGoalIds.length ? '\nStalled original goals (goalPath.goals[].stalled): no frontier input of these goals can run, ' +
      'so other workers\' progress does not advance them. Answer every stalled frontier input in this revision with ' +
      '"goalPath":{"adopt":["CANDIDATE_ID"],"decline":[{"taskId":"INPUT_ID","reason":"..."}]} beside baseVersion. ' +
      'The host applies a candidate with mechanical:true from its id alone, so {"baseVersion":"...","goalPath":{"adopt":["resume:INPUT_ID"]}} is a complete revision; ' +
      'any other adopted candidate needs its change in the same revision (upsert or remove the input or a consumer, or supply groups). ' +
      'Decline only with the mathematical reason no candidate applies and what would change that. Candidates are planning ' +
      'suggestions: a connect match is syntactic and still needs its Lean check, and an assumed premise closes the goal only conditionally.' +
      (goalPath.unansweredTurns && !goalPath.ignored ? ` ${goalPath.unansweredTurns} earlier turn(s) shown this stall answered none of it; ` +
        'an unanswered stall is recorded as ignored after this turn.' : '') : '');
}
