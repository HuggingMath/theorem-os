import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fidelityReferenceInput } from '../math/formalizationFidelity';
import { assertFormalizationReferenceResult, formalizationReferenceInputSchema,
  type FormalizationReferenceResult } from '../math/formalizationReference';
import { canonicalMathJson, readMathText, writeMathFrozen } from '../math/mathRuntimeIo';
import { assertMathCanonicalPath } from '../math/paths';
import type { StructuredReviewInput, StructuredSemanticReview } from '../math/formalizationSemanticReview';
import { compareFormalizationReference } from './formalizationReference';
import type { LibraryPack } from '../math/libraryPacks';

const cancellationReasons = new Set([
  'formalization_reference_aborted', 'This operation was aborted', 'The operation was aborted',
  'Proof environment lease cancelled.', 'Proof environment preparation cancelled.',
]);
const interruptedComparison = (result: FormalizationReferenceResult) =>
  'check' in result && result.check === 'unavailable' && result.reason !== undefined && cancellationReasons.has(result.reason);

/** Share only identical host obligations within one round, under the same environment and run lease. */
export function shareFormalizationFidelityComparisons(
  options: Omit<Parameters<typeof compareFormalizationReference>[2], 'timeoutMs'>,
  compareReference = compareFormalizationReference,
): typeof compareFormalizationReference {
  const comparisons = new Map<string, Promise<FormalizationReferenceResult>>();
  return async (directory, input, limits) => {
    options.signal?.throwIfAborted();
    const request = formalizationReferenceInputSchema.parse(input), key = canonicalMathJson(request);
    let pending = comparisons.get(key);
    if (!pending) {
      pending = (async () => {
        const result = await compareReference(directory, request, { ...options, timeoutMs: limits.timeoutMs });
        options.signal?.throwIfAborted();
        assertFormalizationReferenceResult(request, result);
        if (result.status !== 'established' || !('check' in result) || result.check !== 'completed') comparisons.delete(key);
        return result;
      })();
      comparisons.set(key, pending);
    }
    try {
      const result = await pending;
      options.signal?.throwIfAborted();
      return structuredClone(result);
    } catch (cause) {
      if (comparisons.get(key) === pending) comparisons.delete(key);
      throw cause;
    }
  };
}

/** The model's source reading remains advisory; this gate checks whole-target correspondence. */
export async function checkFormalizationFidelity(directory: string, input: StructuredReviewInput,
  review: StructuredSemanticReview, options: {
    env: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs: number; restoreOnly?: boolean;
    libraryPack?: LibraryPack;
    compareReference?: typeof compareFormalizationReference;
  }): Promise<FormalizationReferenceResult | undefined> {
  if (!input.fidelityPolicy || review.verdict !== 'approved') return undefined;
  if (!input.observation.snapshot || !review.fidelity) throw new Error('formalization_fidelity_evidence_missing');
  const request = fidelityReferenceInput(input.observation.snapshot, review.fidelity, options.libraryPack);
  const file = path.join(directory, 'comparison.json');
  assertMathCanonicalPath(file);
  options.signal?.throwIfAborted();
  if (fs.existsSync(file)) {
    if ((fs.lstatSync(file).mode & 0o222) !== 0) throw new Error('formalization_fidelity_evidence_not_frozen');
    const result: unknown = JSON.parse(readMathText(file, 16_000_000));
    assertFormalizationReferenceResult(request, result);
    if (!interruptedComparison(result)) return result;
    if (options.restoreOnly) throw new Error('formalization_fidelity_evidence_missing');
    // Old versions froze cancellation as an unavailable mathematical outcome.
    // Preserve that failed attempt while allowing this exact request to retry.
    fs.renameSync(file, path.join(directory, 'comparison-interrupted-' + randomUUID() + '.json'));
  }
  if (options.restoreOnly) throw new Error('formalization_fidelity_evidence_missing');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const result = await (options.compareReference ?? compareFormalizationReference)(
    path.join(directory, 'attempt-' + randomUUID()), request, options);
  options.signal?.throwIfAborted();
  assertFormalizationReferenceResult(request, result);
  if (interruptedComparison(result)) throw new Error('formalization_fidelity_comparison_interrupted');
  writeMathFrozen(file, canonicalMathJson(result));
  return result;
}
