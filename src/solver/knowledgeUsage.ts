import type { KnowledgeContextSnapshot, KnowledgeRetrieval } from './knowledgeContext';
import type { ProofCheck } from './modules/evidence';
import type { ProofReferences } from './proofReferences';
import type { CooperativeTask } from './tasks';
import { taskVersion } from './tasks';
import { knowledgeApplicationReportSchema, type KnowledgeUse } from './knowledgeUsageContract';
export { knowledgeApplicationReportSchema, knowledgeApplicationCheckSchema, knowledgeUseSchema } from './knowledgeUsageContract';
export type { KnowledgeApplicationCheck, KnowledgeUse } from './knowledgeUsageContract';

export type KnowledgeRetrievalObservation = KnowledgeRetrieval & {
  included: boolean; omissionReason?: string; workerId: string; workerTurn: number; runTurn: number;
  contextDigest: string; at: number;
};

export const knowledgeDeclarationMatches = (left: { name?: string; file?: string }, right: { name?: string; file?: string }) =>
  Boolean(left.name && left.file && right.name && left.file === right.file &&
    left.name.replace(/^_root_\./u, '') === right.name.replace(/^_root_\./u, ''));

/** Missing reference collection is unknown; a successful proof is not an empty reference report. */
export function knowledgeReferenceCoverage(task: CooperativeTask, proof?: ProofCheck & { references?: ProofReferences }): {
  coverage: 'available' | 'unknown'; references?: { name: string; file: string }[];
} {
  if (!proof?.passed) return { coverage: 'unknown' };
  const scoped = proof.references;
  if (scoped && scoped.scope !== 'statement' && scoped.sourceCommit === proof.commit &&
      scoped.root?.name === task.theoremName && scoped.root?.file === task.proofPath)
    return { coverage: 'available', references: scoped.proof };
  const results = proof.verification.results.filter(result => result.theoremName === task.theoremName &&
    result.proofPath === task.proofPath && result.targetCommit === proof.commit && result.status === 'kernel_verified');
  if (results.length !== 1 || results[0].declarationReferences === undefined) return { coverage: 'unknown' };
  return { coverage: 'available', references: results[0].declarationReferences.proof };
}

/** Optional usage claims cannot reject a proof or establish where a mathematical idea originated. */
export function inspectKnowledgeUses(value: unknown, knowledge: KnowledgeContextSnapshot | undefined,
  task: CooperativeTask, proof?: ProofCheck & { references?: ProofReferences }): {
    uses: KnowledgeUse[]; rejected: number; referenceCoverage: 'available' | 'unknown';
  } {
  const observation = knowledgeReferenceCoverage(task, proof);
  const entries = new Map(knowledge?.base.entries.map(entry => [entry.id, entry])), seen = new Set<string>();
  const uses: KnowledgeUse[] = [];
  let rejected = value !== undefined && !Array.isArray(value) ? 1 : 0;
  const reports = Array.isArray(value) ? value : [];
  for (const item of reports.slice(0, 16)) {
    if (!knowledge || !item || item.catalogDigest !== knowledge.digest || typeof item.id !== 'string' || !entries.has(item.id) ||
        !item.declaration || typeof item.declaration.name !== 'string' || !item.declaration.name.trim() ||
        typeof item.declaration.file !== 'string' || !item.declaration.file.trim()) { rejected++; continue; }
    // An application report is optional telemetry; malformed details cannot discard a valid reference claim.
    const report = item.application === undefined ? undefined : knowledgeApplicationReportSchema.safeParse(item.application);
    if (report && !report.success) rejected++;
    const key = JSON.stringify([item.id, item.declaration.name, item.declaration.file, report?.success ? report.data : null]);
    if (seen.has(key)) continue;
    seen.add(key);
    // Adapted references retain model-reported origin; the frozen catalog match is a separate observation.
    const catalogDeclarationMatch = knowledgeDeclarationMatches(entries.get(item.id)!, item.declaration);
    const referenced = observation.references?.some(reference => knowledgeDeclarationMatches(reference, item.declaration));
    uses.push({ id: item.id, catalogDigest: knowledge.digest, consumer: { taskId: task.id, taskDigest: taskVersion(task) },
      declaration: { name: item.declaration.name, file: item.declaration.file },
      status: referenced ? 'checked-reference' : 'reported-attempt', attribution: 'model-reported-origin',
      catalogDeclarationMatch,
      ...(report?.success ? { application: report.data } : {}),
      ...(referenced ? { checkedCommit: proof!.commit, checkedSourceDigest: proof!.sourceDigest } : {}) });
  }
  if (knowledge) for (const entry of knowledge.base.entries) {
    if (!observation.references?.some(reference => knowledgeDeclarationMatches(reference, entry))) continue;
    if (uses.some(use => use.id === entry.id && use.status === 'checked-reference')) continue;
    uses.push({ id: entry.id, catalogDigest: knowledge.digest,
      consumer: { taskId: task.id, taskDigest: taskVersion(task) }, declaration: { name: entry.name, file: entry.file },
      status: 'checked-reference', attribution: 'host-observed-reference',
      catalogDeclarationMatch: true,
      checkedCommit: proof!.commit, checkedSourceDigest: proof!.sourceDigest });
  }
  return { uses, rejected: rejected + Math.max(0, reports.length - 16), referenceCoverage: observation.coverage };
}
