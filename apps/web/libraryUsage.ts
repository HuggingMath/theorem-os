import type { MathematicsVerifierBatchResult } from '../../src/math/verifier';
import { readLibraryCatalog } from '../../src/solver/libraryCatalog';
import type { LibraryAccess } from '../../src/solver/libraryAccess';
import { proofReceiptsMatch } from '../../src/solver/modules/evidence';
import type { SolverProblem } from '../../src/solver/problem';

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const maxReferences = 64;

/** Summarize only references from S3's independently accepted, exact original-proof receipts. */
export function summarizeWebLibraryUsage(problem: SolverProblem, access: LibraryAccess,
  result: Record<string, unknown>, installationRounds: number) {
  const catalog = readLibraryCatalog(access.file, access.digest);
  const evaluator = object(result.evaluator), check = object(evaluator?.verification), batch = object(check?.verification);
  const targets = problem.targets, references = new Map<string, { name: string; file: string; sourceDigest: string }>();
  let coveredTargets = 0;
  const accepted = result.status === 'evaluated_passed' && evaluator?.status === 'passed' &&
    evaluator.method === 'host-lean-kernel-all-targets' && check?.passed === true &&
    typeof check.commit === 'string' && check.commit === result.solution_commit &&
    typeof check.sourceDigest === 'string' && /^[a-f0-9]{64}$/u.test(check.sourceDigest) &&
    batch?.schema === 'deepscientist.mathematics.verification-batch/v1' && Array.isArray(batch.results) &&
    batch.results.every(row => object(row)) && targets.length > 0 &&
    proofReceiptsMatch(batch as MathematicsVerifierBatchResult, check.commit, targets.map(target => ({
      proofPath: target.proofPath, theoremName: target.theoremName, expectedSourceDeclarationHash: target.declarationHash,
      statementHash: problem.contract.statementHash, leanStatementHash: problem.contract.leanStatementHash, claim: 'statement',
    })));
  if (accepted) for (const row of (batch!.results as MathematicsVerifierBatchResult['results'])) {
    const proof: unknown = object(row.declarationReferences)?.proof;
    if (!Array.isArray(proof) || !proof.every(value => {
      const item = object(value); return item && typeof item.name === 'string' && typeof item.file === 'string';
    })) continue;
    coveredTargets++;
    for (const value of proof) {
      const item = value as { name: string; file: string };
      if (!problem.frozenFiles?.[item.file]) continue;
      // Private declarations and other installed sources are outside this pinned release's public interface.
      let declaration: ReturnType<typeof catalog.declaration>;
      try { declaration = catalog.declaration(item.name); } catch { continue; }
      if (declaration.file !== item.file || declaration.sourceDigest !== problem.frozenFiles[item.file]) continue;
      references.set(declaration.name, { name: declaration.name, file: declaration.file, sourceDigest: declaration.sourceDigest });
    }
  }
  const items = [...references.values()].sort((left, right) => left.name.localeCompare(right.name));
  return { schema: 'theorem-os.web-library-usage.v1' as const, library: catalog.identity,
    installedModules: Object.keys(problem.frozenFiles ?? {}).length, installationRounds,
    proof: { scope: 'independently-accepted-original-proofs' as const,
      coverage: !coveredTargets ? 'unknown' as const : coveredTargets === targets.length ? 'available' as const : 'partial' as const,
      targetCount: targets.length, coveredTargets,
      referenceCount: coveredTargets && coveredTargets === targets.length ? items.length : null,
      references: items.slice(0, maxReferences), omittedReferences: Math.max(0, items.length - maxReferences),
      ...(accepted ? { commit: check!.commit as string, sourceDigest: check!.sourceDigest as string } : {}) } };
}
