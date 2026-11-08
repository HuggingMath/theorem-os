import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertFormalizationReferenceResult, type FormalizationReferenceInput,
  type FormalizationReferenceResult } from '../src/math/formalizationReference';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { compareFormalizationReference } from '../src/solver/formalizationReference';

const source = (headers: Record<string, string>) => 'import Mathlib\n' + Object.entries(headers)
  .map(([name, header]) => `theorem ${name} ${header} := by original_proof_must_not_run\n`).join('');
const centerEquality = '{G H : Type*} [Group G] [Group H] :'
  + ' Subgroup.center (G × H) = (Subgroup.center G).prod (Subgroup.center H)';
const centerEquivalence = '{G H : Type*} [Group G] [Group H] :'
  + ' Nonempty (Subgroup.center (G × H) ≃* (Subgroup.center G) × (Subgroup.center H))';
const input: FormalizationReferenceInput = {
  candidateSource: source({
    center_prod_eq_prod_centers: centerEquality,
    wrong_center_is_top: '{G H : Type*} [Group G] [Group H] : Subgroup.center (G × H) = ⊤',
  }),
  referenceSource: source({
    exercise_2_8_6: centerEquivalence,
    wrong_center_is_top: centerEquivalence,
  }),
  environment: 'mathlib', purpose: 'task-fidelity-v2',
  pairs: [
    { candidateTarget: 'center_prod_eq_prod_centers', referenceTarget: 'exercise_2_8_6' },
    { candidateTarget: 'wrong_center_is_top', referenceTarget: 'wrong_center_is_top' },
  ],
};

const expectClosedDag = (text: string) => {
  const expression = JSON.parse(text);
  expect(expression).toMatchObject({ schema: 'theoremos.lean-expr-dag.v1', root: expect.any(Number), nodes: expect.any(Array) });
  for (const node of expression.nodes) expect(['fvar', 'mvar']).not.toContain(node[0]);
};

describe.skipIf(process.env.THEOREMOS_TEST_REFERENCE_LEAN !== '1')('native Lean group-center product correspondence', () => {
  let root: string, result: FormalizationReferenceResult;

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'group-center-native-')));
    result = await compareFormalizationReference(path.join(root, 'comparison'), input, {
      env: process.env, timeoutMs: 0, proofEnvironmentCacheRoot: path.join(root, 'proof-environment-cache'),
    });
    expect(() => assertFormalizationReferenceResult(input, result)).not.toThrow();
  }, 0);
  afterAll(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  it('establishes ProofNet 001 through a fixed center-product bridge and rejects a nearby false target', () => {
    expect(result).toMatchObject({ schema: 'theoremos.formalization-reference.v6',
      method: 'cardinality-correspondence-v7', check: 'completed', status: 'not-established',
      modelInvoked: false, proofVerified: false, semanticEquivalenceClaimed: false });
    expect(result.pairs[0]).toMatchObject({
      candidateToReference: { status: 'established' }, referenceToCandidate: { status: 'established' },
    });
    expect(result.pairs[1]).toMatchObject({
      candidateToReference: { status: 'not-established' }, referenceToCandidate: { status: 'not-established' },
    });
    const report = JSON.parse(result.evidence!.reportText);
    const steps = report.pairs[0].transformations;
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ ruleId: 'group-center-product', ruleVersion: 1, side: 'candidate',
      position: { kind: 'forall-conclusion', binderCount: 4 }, sideConditions: [] });
    expectClosedDag(steps[0].proof.forward);
    expectClosedDag(steps[0].proof.backward);

    const modified = JSON.parse(canonicalMathJson(result));
    const changed = JSON.parse(modified.evidence.reportText);
    changed.pairs[0].transformations[0].sideConditions = [{ kind: 'group-instance', type: 'False', term: 'False' }];
    modified.evidence.reportText = JSON.stringify(changed);
    modified.evidence.reportSha256 = mathDigest(modified.evidence.reportText);
    expect(() => assertFormalizationReferenceResult(input, modified)).toThrow();
  }, 0);
});
