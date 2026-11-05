import { canonicalMathJson } from '../math/mathRuntimeIo';
import type { DeliveryRecord } from './deliveries';
import type { CooperativeTask } from './tasks';

/** A Lead answer is bound to one immutable publication, not merely its producer task. */
export type ResearchDecision = { deliveryId: string; taskDigest?: string; findingDigest?: string;
  outcome: 'adopt' | 'source' | 'decline'; reason: string; taskIds?: string[]; sourcePaths?: string[];
  at: number; planVersion: string };

export function researchDecisionMatches(record: DeliveryRecord, decision: ResearchDecision): boolean {
  return decision.deliveryId === record.id && decision.taskDigest === record.taskDigest &&
    decision.findingDigest === record.findingDigest;
}

type Answer = { deliveryId: string; outcome: ResearchDecision['outcome']; reason: string;
  taskIds?: string[]; sourcePaths?: string[] };
const planFields = (task: CooperativeTask | undefined) => task && {
  kind: task.kind, theoremName: task.theoremName, type: task.type, proofPath: task.proofPath,
  dependsOn: task.dependsOn, premises: task.premises, conditional: task.conditional,
  declaration: task.declaration, groupId: task.groupId, status: task.status,
};

/** Require an explicit, actionable answer for every finding shown in this Lead turn. */
export function answerResearchInputs(value: unknown, shown: readonly DeliveryRecord[],
  previous: readonly CooperativeTask[], proposed: readonly CooperativeTask[],
  alreadyAnswered: readonly ResearchDecision[], planVersion: string, now = Date.now()): ResearchDecision[] {
  const unanswered = shown.filter(record => !alreadyAnswered.some(decision => researchDecisionMatches(record, decision)));
  if (!unanswered.length) return [];
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as { researchDecisions?: unknown }).researchDecisions : undefined;
  if (!Array.isArray(raw)) throw new Error('math_plan_research_decisions_missing: answer each shown deliveryId in researchDecisions.');
  const answers = new Map<string, Answer>();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('math_plan_research_decision_invalid');
    const answer = item as Answer;
    if (typeof answer.deliveryId !== 'string' || answers.has(answer.deliveryId) ||
        !['adopt', 'source', 'decline'].includes(answer.outcome) || typeof answer.reason !== 'string' ||
        !answer.reason.trim() || answer.reason.length > 2000 ||
        answer.taskIds !== undefined && (!Array.isArray(answer.taskIds) || !answer.taskIds.length ||
          answer.taskIds.some(id => typeof id !== 'string')) ||
        answer.sourcePaths !== undefined && (!Array.isArray(answer.sourcePaths) || !answer.sourcePaths.length ||
          answer.sourcePaths.some(path => typeof path !== 'string')))
      throw new Error('math_plan_research_decision_invalid');
    answers.set(answer.deliveryId, answer);
  }
  const before = new Map(previous.map(task => [task.id, task]));
  const after = new Map(proposed.map(task => [task.id, task]));
  const decided: ResearchDecision[] = [];
  for (const record of unanswered) {
    const answer = answers.get(record.id);
    if (!answer) throw new Error('math_plan_research_decisions_missing: ' + record.id);
    if (answer.outcome === 'adopt' && (!answer.taskIds?.length || !answer.taskIds.some(id =>
      after.has(id) && (!before.has(id) ||
        canonicalMathJson(planFields(before.get(id))) !== canonicalMathJson(planFields(after.get(id)))))))
      throw new Error('math_plan_research_adoption_unapplied: ' + record.id +
        '; change a named task contract or route, or decline with a mathematical reason.');
    if (answer.outcome === 'source' && !answer.sourcePaths?.length)
      throw new Error('math_plan_research_source_missing: ' + record.id);
    decided.push({ deliveryId: record.id, taskDigest: record.taskDigest, findingDigest: record.findingDigest,
      outcome: answer.outcome, reason: answer.reason.trim(),
      ...(answer.taskIds?.length ? { taskIds: [...new Set(answer.taskIds)] } : {}),
      ...(answer.sourcePaths?.length ? { sourcePaths: [...new Set(answer.sourcePaths)] } : {}), at: now, planVersion });
  }
  return decided;
}
