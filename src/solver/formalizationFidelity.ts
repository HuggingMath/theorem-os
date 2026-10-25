import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fidelityReferenceInput } from '../math/formalizationFidelity';
import { assertFormalizationReferenceResult, type FormalizationReferenceResult } from '../math/formalizationReference';
import { canonicalMathJson, readMathText, writeMathFrozen } from '../math/mathRuntimeIo';
import { assertMathCanonicalPath } from '../math/paths';
import type { StructuredReviewInput, StructuredSemanticReview } from '../math/formalizationSemanticReview';
import { compareFormalizationReference } from './formalizationReference';

/** The model's source reading remains advisory; this gate checks whole-target correspondence. */
export async function checkFormalizationFidelity(directory: string, input: StructuredReviewInput,
  review: StructuredSemanticReview, options: {
    env: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs: number; restoreOnly?: boolean;
    compareReference?: typeof compareFormalizationReference;
  }): Promise<FormalizationReferenceResult | undefined> {
  if (!input.fidelityPolicy || review.verdict !== 'approved') return undefined;
  if (!input.observation.snapshot || !review.fidelity) throw new Error('formalization_fidelity_evidence_missing');
  const request = fidelityReferenceInput(input.observation.snapshot, review.fidelity);
  const file = path.join(directory, 'comparison.json');
  assertMathCanonicalPath(file);
  if (fs.existsSync(file)) {
    if ((fs.lstatSync(file).mode & 0o222) !== 0) throw new Error('formalization_fidelity_evidence_not_frozen');
    const result: unknown = JSON.parse(readMathText(file, 16_000_000));
    assertFormalizationReferenceResult(request, result);
    return result;
  }
  if (options.restoreOnly) throw new Error('formalization_fidelity_evidence_missing');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const result = await (options.compareReference ?? compareFormalizationReference)(
    path.join(directory, 'attempt-' + randomUUID()), request, options);
  assertFormalizationReferenceResult(request, result);
  writeMathFrozen(file, canonicalMathJson(result));
  return result;
}
