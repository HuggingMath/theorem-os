import { mathDigest } from '../../src/math/mathRuntimeIo';
import type { WebRun } from './shared';
import type { ResearchAssetRelease, ResearchLibraryUse } from './researchAssetTypes';

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Original-proof receipts also exist for independent runs, which have no cooperative task records. */
export function acceptedResearchLibraryUses(run: WebRun, release: ResearchAssetRelease): ResearchLibraryUse[] {
  const observed = run.observation, problem = observed?.inspection.problem, mathematics = release.mathematics;
  const report = run.result?.report, evaluator = object(report?.evaluator), check = object(evaluator?.verification);
  const batch = object(check?.verification), rows = batch?.results;
  const commit = check?.commit, sourceDigest = check?.sourceDigest, targets = problem?.targets;
  if (!mathematics || run.status !== 'completed' || run.result?.status !== 'evaluated_passed' ||
      report?.status !== 'evaluated_passed' || report.runId !== observed?.solverRunId || report.problemId !== problem?.id ||
      evaluator?.status !== 'passed' || evaluator.method !== 'host-lean-kernel-all-targets' || check?.passed !== true ||
      typeof commit !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(commit) || commit !== report.solution_commit ||
      typeof sourceDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(sourceDigest) ||
      batch?.schema !== 'deepscientist.mathematics.verification-batch/v1' || batch.status !== 'kernel_verified' ||
      batch.targetCommit !== commit || !Array.isArray(rows) || !targets?.length || rows.length !== targets.length ||
      rows.some((value, index) => {
        const row = object(value), target = targets[index]!;
        return !row || row.status !== 'kernel_verified' || row.targetCommit !== commit || row.claim !== 'statement' ||
          row.proofPath !== target.proofPath || row.theoremName !== target.theoremName || !target.declarationHash ||
          row.sourceDeclarationHash !== target.declarationHash || typeof row.receiptId !== 'string' || !row.receiptId;
      })) return [];
  const selected = run.researchConfiguration?.libraries.find(item => item.ref.assetId === release.assetId &&
    item.ref.version === release.version && item.ref.digest === release.digest);
  if (!selected) return [];
  const installed = new Map(run.researchConfiguration!.libraryPack?.modules.map(module => [module.file, mathDigest(module.source)]));
  const pinned = new Map(selected.mathematics.pack.modules.map(module => [module.file, mathDigest(module.source)]));
  if (mathematics.pack.modules.some(module => installed.get(module.file) !== mathDigest(module.source) ||
    pinned.get(module.file) !== mathDigest(module.source))) return [];
  return rows.flatMap((value, index) => {
    const row = object(value)!, proof = object(row.declarationReferences)?.proof;
    if (!Array.isArray(proof)) return [];
    const references = mathematics.declarations.filter(declaration => proof.some(value => {
      const reference = object(value);
      return reference?.name === declaration.name && reference.file === declaration.file;
    })).map(({ name, file }) => ({ name, file }));
    if (!references.length) return [];
    const target = targets[index]!;
    return [{ assetId: release.assetId, version: release.version, digest: release.digest, runId: run.id,
      scope: 'original-proof' as const, theorem: target.theoremName, proofPath: target.proofPath, commit, sourceDigest,
      status: 'checked-reference' as const, evidence: 'recorded-not-replayed' as const, proofStatus: 'checked',
      references, checkRefs: [row.receiptId as string] }];
  });
}

