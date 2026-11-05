import { z } from 'zod';
import { canonicalMathJson, mathDigest, readMathText } from '../math/mathRuntimeIo';
import { deliveryFinding } from './deliveries';
import { mathematicalGaps, mathematicalGapSchema } from './mathematicalGaps';
import { committedSource } from './problem';
import { prepareResearchDelivery } from './researchAdmission';
import { validateLemmaRequests } from './taskProposals';
import { taskVersion, type CooperativeTask } from './tasks';
import type { SolverRunState } from './archive';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
/** Frozen demand is advisory provenance; the ordinary helper/consumer checks still establish every proof. */
export const autoLibraryDemandSchema = z.object({
  schema: z.literal('theorem-os.auto-library-demand.v1'), runId: z.string().min(1),
  challengeDigest: hash, problemReceiptDigest: z.string().min(1), environmentDigest: z.string().min(1),
  deliveryId: z.string().min(1), findingDigest: hash, commit: z.string().regex(/^[a-f0-9]{40,64}$/u),
  consumer: z.object({ taskId: z.string().min(1), taskDigest: hash, theoremName: z.string().min(1) }).strict(),
  source: z.object({ taskId: z.string().min(1), taskDigest: hash }).strict(),
  dependencies: z.array(z.object({ taskId: z.string().min(1), taskDigest: hash }).strict()),
  gap: mathematicalGapSchema, evidenceRefs: z.array(z.string()),
  lemmaRequests: z.array(z.custom<CooperativeTask>(value => Boolean(value && typeof value === 'object' &&
    (value as CooperativeTask).kind === 'lemma' && typeof (value as CooperativeTask).type === 'string' &&
    (value as CooperativeTask).type!.trim() && Array.isArray((value as CooperativeTask).dependsOn)))),
}).strict().superRefine((value, ctx) => {
  if (value.gap.consumer.taskId !== value.consumer.taskId || value.gap.consumer.taskDigest !== value.consumer.taskDigest)
    ctx.addIssue({ code: 'custom', path: ['consumer'], message: 'The gap must name this exact consumer.' });
});
export type AutoLibraryDemand = z.infer<typeof autoLibraryDemandSchema>;

export function captureAutoLibraryDemand(state: SolverRunState, deliveryId: string): AutoLibraryDemand {
  const archive = state.cooperation;
  if (!archive) throw new Error('auto_library_demand_no_cooperation');
  const identity = { problemReceiptDigest: state.problem.receiptDigest, environmentDigest: state.environmentDigest };
  const gap = mathematicalGaps(archive, identity).find(item => item.deliveryId === deliveryId && item.scopeStatus === 'current-contracts');
  const delivery = archive.deliveries?.find(item => item.id === deliveryId);
  if (!gap || !delivery?.commit || !deliveryFinding(delivery) || gap.scope.source.sharing === 'group' ||
      gap.scope.consumer.sharing === 'group') throw new Error('auto_library_demand_not_current_public_gap');
  const assignment = { taskId: gap.scope.source.id, taskDigest: taskVersion(gap.scope.source), workerId: delivery.producer,
    seedCommit: delivery.researchRecord?.seedCommit ?? delivery.commit };
  const scope = { source: gap.scope.source, assignment, identity, tasks: archive.tasks, deliveries: archive.deliveries };
  const notes = committedSource(state.worktree, delivery.commit, 'RESEARCH.md');
  const saved = prepareResearchDelivery({ kind: 'notes', text: notes }, scope);
  const report = prepareResearchDelivery({ kind: 'event', value: JSON.parse(delivery.finding!) }, scope);
  if (saved.status !== 'admitted' || report.status !== 'admitted' ||
      canonicalMathJson(saved.finding) !== canonicalMathJson(report.finding) ||
      canonicalMathJson(saved.finding.mathematicalGap) !== canonicalMathJson(delivery.mathematicalGap))
    throw new Error('auto_library_demand_source_mismatch');
  const lemmaRequests = validateLemmaRequests(state.problem, archive.tasks.map(node => node.task),
    archive.groups?.map(group => group.group) ?? [], gap.scope.source, report.finding.lemmaRequests,
    archive.deliveries?.flatMap(item => item.lemmaRequests ?? []));
  return autoLibraryDemandSchema.parse({ schema: 'theorem-os.auto-library-demand.v1', runId: state.runId,
    ...identity, challengeDigest: mathDigest(state.problem.contract.formalStatement), deliveryId,
    findingDigest: delivery.findingDigest, commit: delivery.commit,
    consumer: { taskId: gap.scope.consumer.id, taskDigest: taskVersion(gap.scope.consumer), theoremName: gap.scope.consumer.theoremName },
    source: { taskId: gap.scope.source.id, taskDigest: taskVersion(gap.scope.source) }, dependencies: gap.scope.dependencies,
    gap: delivery.mathematicalGap, evidenceRefs: delivery.evidenceRefs, lemmaRequests });
}

export const readAutoLibraryDemand = (file: string) => autoLibraryDemandSchema.parse(JSON.parse(readMathText(file, 4 * 1024 * 1024)));
