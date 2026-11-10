import type { WebCheckReceipt, WebCommandResult, WebInspectedTask, WebObservation } from './collaboration';
import type { ResearchProjectDetail } from './researchProjectTypes';
import type { ResearchBriefDecision, ResearchBriefTask, ResearchDecisionSnapshot } from './researchWorkspaceTypes';

/** A receipt belongs to a frozen task, source and environment together. */
export function researchBriefTask(task: WebInspectedTask, observation: WebObservation, checks: WebCheckReceipt[], href: (task: { id: string; version: string; commit?: string }) => string): ResearchBriefTask {
  const agents: NonNullable<ResearchBriefTask['agents']> = [];
  if (task.owner) agents.push({ id: task.owner, role: observation.inspection.workers.find(worker => worker.id === task.owner)?.role, basis: 'owner' });
  for (const worker of observation.inspection.workers) if (worker.task === task.id && !agents.some(agent => agent.id === worker.id))
    agents.push({ id: worker.id, role: worker.role, basis: 'assignment' });
  return { id: task.id, version: task.version, title: task.theorem ?? task.objective, kind: task.kind, objective: task.objective,
    statement: task.informalStatement ?? task.type, derivation: task.informalProof, dependsOn: [...task.plannedDependencies],
    premises: [...task.premises], status: task.status, proofStatus: task.proof.status, finding: task.finding, feedback: task.feedback,
    commit: task.proof.commit, sourceDigest: task.proof.sourceDigest, environmentDigest: observation.inspection.configuration.environmentDigest,
    checks: checks.filter(check => check.taskId === task.id && check.taskVersion === task.version && check.commit === task.proof.commit
      && Boolean(task.proof.commit && task.proof.sourceDigest && observation.inspection.configuration.environmentDigest)
      && check.sourceDigest === task.proof.sourceDigest && check.environmentDigest === observation.inspection.configuration.environmentDigest)
      .map(check => ({ id: check.id, passed: check.record.passed === true })), href: href({ id: task.id, version: task.version, commit: task.proof.commit }), agents };
}

/** Only explicit task, plan, edit and receipt references associate a human decision with a route. */
export function researchBriefDecisions(input: { observation?: WebObservation; recorded: WebObservation[]; commands: WebCommandResult[];
  project?: ResearchProjectDetail; runId: string; href(task: { id: string; version: string; commit?: string }): string }): ResearchBriefDecision[] {
  const { observation, project, runId, commands, href } = input;
  const observations = [...new Map([...input.recorded, ...commands.flatMap(command => command.observation ? [command.observation] : []),
    ...(observation ? [observation] : [])].filter(item => item.webRunId === runId).map(item => [`${item.sequence}:${item.snapshot.stateDigest}`, item])).values()]
    .sort((a, b) => a.sequence - b.sequence);
  const snapshot = (saved: WebObservation | undefined, ids: Set<string>): ResearchDecisionSnapshot | undefined => saved && ({
    sequence: saved.sequence, stateDigest: saved.snapshot.stateDigest, planVersion: saved.inspection.planVersion,
    tasks: saved.inspection.tasks.filter(task => ids.has(task.id)).map(task => researchBriefTask(task, saved, saved.checks, href)),
  });
  const decisions = new Map<string, ResearchBriefDecision>();
  const refs = (decision: ResearchBriefDecision) => decision.taskRefs ??= [];
  const addRef = (decision: ResearchBriefDecision, ref: { id: string; version: string } | undefined, relation: NonNullable<ResearchBriefDecision['taskRefs']>[number]['relation']) => {
    if (ref && !refs(decision).some(item => item.id === ref.id && item.version === ref.version && item.relation === relation)) refs(decision).push({ id: ref.id, version: ref.version, relation });
  };
  const guidance = [...new Map(observations.flatMap(saved => saved.guidance).map(item => [item.id, item])).values()];
  for (const item of guidance) {
    const decision: ResearchBriefDecision = { id: item.id, text: item.text, delivery: item.status, decision: item.decision?.status ?? 'not-recorded',
      reason: item.decision?.reason, evidenceRefs: item.decision?.evidenceRefs.map(ref => ref.kind === 'plan' ? `plan:${ref.version}`
        : ref.kind === 'task' ? `task:${ref.id}@${ref.version}` : `edit:${ref.id}`) ?? [] };
    addRef(decision, item.taskRef, 'target'); addRef(decision, item.decision?.sourceTaskRef, 'reference');
    for (const ref of item.decision?.evidenceRefs ?? []) if (ref.kind === 'task') addRef(decision, ref, 'reference');
    const base = observations.find(saved => saved.sequence === item.observationRef.sequence && saved.snapshot.stateDigest === item.observationRef.stateDigest);
    decision.before = snapshot(base, new Set(refs(decision).map(ref => ref.id)));
    decisions.set(decision.id, decision);
  }
  for (const feedback of project?.feedback ?? []) if (feedback.target?.runId === runId) {
    const existing = decisions.get(feedback.id) ?? decisions.get(feedback.requestId);
    const decision: ResearchBriefDecision = { ...existing, id: existing?.id ?? feedback.id, text: feedback.text,
      kind: feedback.kind === 'plan-edit' || feedback.kind === 'plan-approval' ? feedback.kind : undefined,
      delivery: feedback.delivery.status, decision: feedback.decision.status, reason: feedback.decision.reason,
      evidenceRefs: [...new Set([...(existing?.evidenceRefs ?? []), ...feedback.decision.evidenceRefs])],
      execution: feedback.execution.status, planVersion: feedback.execution.planVersion, resultRefs: feedback.execution.resultRefs };
    addRef(decision, feedback.target.taskRef, 'target'); addRef(decision, feedback.decision.sourceTaskRef, 'reference');
    for (const ref of feedback.execution.taskRefs) addRef(decision, ref, 'execution');
    for (const value of feedback.decision.evidenceRefs) { const match = /^task:(.+)@([^@]+)$/u.exec(value); if (match) addRef(decision, { id: match[1]!, version: match[2]! }, 'reference'); }
    const ids = new Set(refs(decision).map(ref => ref.id));
    const base = observations.find(saved => saved.sequence === feedback.target!.observationRef.sequence && saved.snapshot.stateDigest === feedback.target!.observationRef.stateDigest);
    decision.before = snapshot(base, ids) ?? decision.before;
    const resultChecks = feedback.execution.resultRefs.filter(ref => ref.startsWith('check:')).map(ref => ref.slice(6));
    const after = observations.find(saved => (feedback.execution.planVersion ? saved.inspection.planVersion === feedback.execution.planVersion : resultChecks.length > 0)
      && feedback.execution.taskRefs.every(ref => saved.inspection.tasks.some(task => task.id === ref.id && task.version === ref.version))
      && resultChecks.every(id => saved.checks.some(check => check.id === id)));
    decision.after = snapshot(after, ids);
    decisions.set(decision.id, decision);
  }
  const approvals = [...new Map(observations.flatMap(saved => saved.inspection.planApproval?.approvedId ? [saved.inspection.planApproval] : [])
    .map(approval => [approval.approvedId!, approval])).values()];
  for (const approval of approvals) if (approval.approvedId) {
    const decision: ResearchBriefDecision = decisions.get(approval.approvedId) ?? { id: approval.approvedId, text: 'Plan approval', kind: 'plan-approval', delivery: 'recorded', decision: approval.status, evidenceRefs: [] };
    decision.planVersion = approval.approvedVersion;
    const approved = approval.approvedVersion ? observations.find(saved => saved.inspection.planVersion === approval.approvedVersion && saved.inspection.planApproval?.approvedId === approval.approvedId) : undefined;
    for (const task of approved?.inspection.tasks ?? []) addRef(decision, task, 'plan');
    decision.after = snapshot(approved, new Set(refs(decision).map(ref => ref.id))); decisions.set(decision.id, decision);
  }
  const edits = [...new Map(observations.flatMap(saved => saved.inspection.edits).map(edit => [edit.id, edit])).values()];
  for (const edit of edits) {
    const direct: ResearchBriefDecision = decisions.get(edit.id) ?? { id: edit.id, text: 'Plan edit', kind: 'plan-edit', delivery: 'recorded', decision: edit.status,
      reason: edit.reason, evidenceRefs: edit.planVersion ? [`plan:${edit.planVersion}`] : [] };
    decisions.set(direct.id, direct);
    for (const decision of decisions.values()) if (decision.id === edit.id || decision.evidenceRefs.includes(`edit:${edit.id}`)
      || Boolean(edit.planVersion && decision.evidenceRefs.includes(`plan:${edit.planVersion}`))) {
      const command = commands.find(command => command.id === edit.id);
      const affectedIds = new Set([...(edit.affectedTasks ?? []), ...(command?.affectedTaskIds ?? []), ...(command?.changes?.map(change => change.taskId) ?? []),
        ...(edit.recheck?.tasks.map(task => task.taskId) ?? [])]);
      const ids = new Set([...affectedIds, ...refs(decision).map(ref => ref.id)]);
      const before = edit.baseVersion ? observations.filter(saved => saved.inspection.planVersion === edit.baseVersion).at(-1) : undefined;
      const after = edit.status === 'applied' && edit.planVersion ? command?.observation?.webRunId === runId && command.observation.inspection.planVersion === edit.planVersion ? command.observation
        : observations.find(saved => saved.inspection.planVersion === edit.planVersion && saved.inspection.edits.some(item => item.id === edit.id && item.status === 'applied')) : undefined;
      decision.beforePlanVersion = edit.baseVersion; decision.planVersion = edit.planVersion;
      decision.before = snapshot(before, ids) ?? decision.before; decision.after = snapshot(after, ids) ?? decision.after;
      const relation = decision.id === edit.id || decision.decision === 'accepted' ? 'execution' : 'reference';
      for (const task of edit.recheck?.tasks ?? []) addRef(decision, { id: task.taskId, version: task.taskDigest }, relation);
      for (const task of after?.inspection.tasks.filter(task => affectedIds.has(task.id)) ?? []) addRef(decision, task, relation);
    }
  }
  return [...decisions.values()];
}
