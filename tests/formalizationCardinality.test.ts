import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertFormalizationReferenceResult, type FormalizationReferenceInput,
  type FormalizationReferenceResult } from '../src/math/formalizationReference';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { compareFormalizationReference } from '../src/solver/formalizationReference';

const prelude = `import Mathlib
universe u v
`;
const source = (headers: Record<string, string>) => prelude + Object.entries(headers)
  .map(([name, header]) => `theorem ${name} ${header} := by original_proof_must_not_run
`).join('');
const request = (candidate: Record<string, string>, reference: Record<string, string>): FormalizationReferenceInput => ({
  candidateSource: source(candidate), referenceSource: source(reference), environment: 'mathlib',
  pairs: Object.keys(candidate).map(name => ({ candidateTarget: name, referenceTarget: name })),
});
const binders = '{α : Type u} (Q : ℕ → ℕ → Prop)';
const finiteLaw = '∀ [Fintype α] (p q : ℕ), Prime p → Prime q → Fintype.card α = p * q → Q p q';
const naturalLaw = '∀ (p q : ℕ), Nat.Prime p → Nat.Prime q → Nat.card α = p * q → Q p q';
const positiveInput = request({
  general: `${binders} : ${finiteLaw}`,
  swapped: `${binders} : ${naturalLaw}`,
  independent_universes_and_binders:
    `{α : Type u} {β : Type v} (b : β) (Q : ℕ → ℕ → Prop) : ${finiteLaw}`,
  boolean_false: '(P : ℕ → Prop) : ∀ p : ℕ, P p → (false : Prop)',
  cardinality_and_false: '{α : Type u} (P : ℕ → ℕ → Prop) : ∀ [Fintype α] (p q : ℕ),'
    + ' Prime p → Prime q → Fintype.card α = p * q → (P p q → (false : Prop))',
}, {
  general: `${binders} : ${naturalLaw}`,
  swapped: `${binders} : ${finiteLaw}`,
  independent_universes_and_binders:
    `{α : Type u} {β : Type v} (Q : ℕ → ℕ → Prop) (b : β) : ${naturalLaw}`,
  boolean_false: '(P : ℕ → Prop) : ∀ p : ℕ, P p → False',
  cardinality_and_false: '{α : Type u} (P : ℕ → ℕ → Prop) : ∀ (p q : ℕ),'
    + ' Nat.Prime p → Nat.Prime q → Nat.card α = p * q → (P p q → False)',
});
const proofnet005Input: FormalizationReferenceInput = {
  ...request({
    no_simple_group_of_order_224:
      '(G : Type u) [Group G] (hG : Nat.card G = 224) : ¬ IsSimpleGroup G',
  }, {
    no_simple_group_of_order_224:
      '{G : Type u} [Group G] [Fintype G] (hG : Fintype.card G = 224) : IsSimpleGroup G → false',
  }),
  purpose: 'task-fidelity-v2',
};

const expectClosedDag = (text: string) => {
  const expression = JSON.parse(text);
  expect(expression).toMatchObject({ schema: 'theoremos.lean-expr-dag.v1', root: expect.any(Number), nodes: expect.any(Array) });
  expect(expression.root).toBeGreaterThanOrEqual(0);
  expect(expression.root).toBeLessThan(expression.nodes.length);
  for (const node of expression.nodes) expect(['fvar', 'mvar']).not.toContain(node[0]);
};

// These tests cross the production compare/assert Interface with arbitrary α/Q.
// The fixed rule may infer finiteness from a nonzero prime product; a caller
// supplies neither a tactic nor a bridge theorem. All native deadlines remain 0.
describe.skipIf(process.env.THEOREMOS_TEST_REFERENCE_LEAN !== '1')('native Lean cardinality representation correspondence', () => {
  let root: string, positive: FormalizationReferenceResult;
  const compare = async (name: string, input: FormalizationReferenceInput) => {
    const result = await compareFormalizationReference(path.join(root, name), input, { env: process.env, timeoutMs: 0 });
    expect(() => assertFormalizationReferenceResult(input, result)).not.toThrow();
    for (const artifact of result.evidence?.artifacts ?? []) {
      const capture = JSON.parse(artifact.text);
      expect(capture.stdout + capture.stderr).not.toMatch(/index out of bounds|lean_array_get_panic|PANIC/u);
    }
    return result;
  };
  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cardinality-native-')));
    positive = await compare('positive', positiveInput);
    expect(positive.status, positive.reason).toBe('established');
  }, 0);
  afterAll(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  it('establishes prime-product cardinality in both directions, independent universes, and fixed Boolean false', () => {
    expect(positive).toMatchObject({ schema: 'theoremos.formalization-reference.v4',
      method: 'cardinality-correspondence-v5', check: 'completed', status: 'established',
      modelInvoked: false, proofVerified: false, semanticEquivalenceClaimed: false, limits: { timeoutMs: 0 } });
    expect(positive.pairs).toHaveLength(5);
    for (const pair of positive.pairs) expect(pair).toMatchObject({
      candidateToReference: { status: 'established' }, referenceToCandidate: { status: 'established' },
    });
    expect(positive.evidence?.artifacts).toHaveLength(3);
    const report = JSON.parse(positive.evidence!.reportText);
    expect(report.schema).toBe('theoremos.reference-report.v4');
    expect(report.pairs).toHaveLength(5);
    const appliedRules = new Set<string>();
    for (const pair of report.pairs) {
      expect(pair.representationCorrespondence).toBe(true);
      expect(pair.transformations.length).toBeGreaterThan(0);
      for (const step of pair.transformations) {
        appliedRules.add(step.ruleId);
        expect(['cardinality-prime-product', 'boolean-false']).toContain(step.ruleId);
        expect(step.ruleVersion).toBe(1);
        expect(['candidate', 'reference']).toContain(step.side);
        expect(step.before.expression).not.toBe(step.after.expression);
        expect(step.before.context).toEqual(expect.any(Array));
        expect(step.after.context).toEqual(step.before.context);
        expect(step.before.universes).toEqual(expect.any(Array));
        expect(step.after.universes).toEqual(expect.any(Array));
        if (step.ruleId === 'cardinality-prime-product') {
          expect(step.position.kind).toBe('forall-suffix');
          expect(step.sideConditions).toHaveLength(1);
          expect(step.sideConditions[0].kind).toBe('prime-product-nonzero');
          expectClosedDag(step.sideConditions[0].type);
          expectClosedDag(step.sideConditions[0].term);
        } else {
          expect(step.position.kind).toBe('forall-conclusion');
          expect(step.sideConditions).toEqual([]);
        }
        expectClosedDag(step.proof.forward);
        expectClosedDag(step.proof.backward);
      }
    }
    expect([...appliedRules].sort()).toEqual(['boolean-false', 'cardinality-prime-product']);
    const combined = report.pairs[4];
    expect(combined.transformations.map((step: { ruleId: string }) => step.ruleId))
      .toEqual(expect.arrayContaining(['cardinality-prime-product', 'boolean-false']));
    const generated = Object.values(positive.files).map(file => file.text).join('');
    expect(generated).not.toContain('original_proof_must_not_run');
    expect(generated).not.toMatch(/\b(?:sorry|sorryAx|axiom|admit)\b/u);
  });

  it('establishes ProofNet 005 with a kernel-proved nonzero Fintype-to-Nat.card conversion', async () => {
    const result = await compare('proofnet-005', proofnet005Input);
    expect(result).toMatchObject({ schema: 'theoremos.formalization-reference.v5',
      method: 'cardinality-correspondence-v6', check: 'completed', status: 'established',
      modelInvoked: false, proofVerified: false, semanticEquivalenceClaimed: false });
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]).toMatchObject({
      candidateToReference: { status: 'established' }, referenceToCandidate: { status: 'established' },
    });
    const report = JSON.parse(result.evidence!.reportText);
    const steps = report.pairs[0].transformations;
    const cardinality = steps.find((step: { ruleId: string }) => step.ruleId === 'finite-cardinality-value');
    expect(cardinality).toMatchObject({ ruleVersion: 1, side: 'reference',
      position: { kind: 'forall-suffix', binderCount: 2 },
      sideConditions: [{ kind: 'cardinality-nonzero' }] });
    expectClosedDag(cardinality.sideConditions[0].type);
    expectClosedDag(cardinality.sideConditions[0].term);
    expect(steps.map((step: { ruleId: string }) => step.ruleId)).toContain('boolean-false');
    for (const mutation of ['rule-version', 'side-condition']) {
      const modified = JSON.parse(canonicalMathJson(result));
      const changed = JSON.parse(modified.evidence.reportText);
      const step = changed.pairs[0].transformations.find((value: { ruleId: string }) =>
        value.ruleId === 'finite-cardinality-value');
      if (mutation === 'rule-version') step.ruleVersion = 2;
      else step.sideConditions[0].kind = 'unchecked-cardinality';
      modified.evidence.reportText = JSON.stringify(changed);
      modified.evidence.reportSha256 = mathDigest(modified.evidence.reportText);
      expect(() => assertFormalizationReferenceResult(proofnet005Input, modified)).toThrow();
    }
  }, 0);

  it('keeps missing primes, changed hypotheses, zero or infinite cardinality, and instance-dependent conclusions unknown', async () => {
    const input: FormalizationReferenceInput = {
      ...request({
      missing_prime: `${binders} : ${finiteLaw}`,
      extra_premise: `${binders} : ${finiteLaw}`,
      missing_cardinality: `${binders} : ${finiteLaw}`,
      addition: `${binders} : ${finiteLaw.replace('p * q', 'p + q')}`,
      zero_cardinality: `${binders} : ${finiteLaw.replace('p * q', '0')}`,
      infinite_type: '(Q : ℕ → ℕ → Prop) : ∀ [Fintype ℕ] (p q : ℕ),'
        + ' Prime p → Prime q → Fintype.card ℕ = 0 → Q p q',
      instance_dependent: '{α : Type u} [Finite α] (R : Fintype α → ℕ → ℕ → Prop) :'
        + ' ∀ [inst : Fintype α] (p q : ℕ), Prime p → Prime q → Fintype.card α = p * q → R inst p q',
      zero_finite_cardinality: '{α : Type u} (Q : Prop) : ∀ [Fintype α], Fintype.card α = 0 → Q',
      instance_dependent_finite_cardinality:
        '{α : Type u} [Finite α] (R : Fintype α → Prop) : ∀ [inst : Fintype α],'
          + ' Fintype.card α = 224 → R inst',
      changed_conclusion: `${binders} : ${finiteLaw}`,
      arbitrary_boolean: '(b : Bool) (P : Prop) : P → (b : Prop)',
    }, {
      missing_prime: `${binders} : ∀ (p q : ℕ), Nat.Prime p → Nat.card α = p * q → Q p q`,
      extra_premise: `${binders} : ∀ (p q : ℕ), Nat.Prime p → Nat.Prime q →`
        + ' Nat.card α = p * q → p ≠ q → Q p q',
      missing_cardinality: `${binders} : ∀ (p q : ℕ), Nat.Prime p → Nat.Prime q → Q p q`,
      addition: `${binders} : ${naturalLaw.replace('p * q', 'p + q')}`,
      zero_cardinality: `${binders} : ${naturalLaw.replace('p * q', '0')}`,
      infinite_type: '(Q : ℕ → ℕ → Prop) : ∀ (p q : ℕ),'
        + ' Nat.Prime p → Nat.Prime q → Nat.card ℕ = 0 → Q p q',
      instance_dependent: '{α : Type u} [Finite α] (R : Fintype α → ℕ → ℕ → Prop) :'
        + ' ∀ (p q : ℕ), Nat.Prime p → Nat.Prime q → Nat.card α = p * q → R (Fintype.ofFinite α) p q',
      zero_finite_cardinality: '{α : Type u} (Q : Prop) : Nat.card α = 0 → Q',
      instance_dependent_finite_cardinality:
        '{α : Type u} [Finite α] (R : Fintype α → Prop) : Nat.card α = 224 → R (Fintype.ofFinite α)',
      changed_conclusion: `${binders} : ∀ (p q : ℕ), Nat.Prime p → Nat.Prime q →`
        + ' Nat.card α = p * q → ¬ Q p q',
      arbitrary_boolean: '(b : Bool) (P : Prop) : P → False',
    }),
      purpose: 'task-fidelity-v2',
    };
    const result = await compare('negative', input);
    const diagnosticsFile = path.join(root, 'negative', 'diagnostics.json');
    const diagnostics = fs.existsSync(diagnosticsFile) ? JSON.parse(fs.readFileSync(diagnosticsFile, 'utf8')) : undefined;
    const details = `${result.reason}: ${JSON.stringify(diagnostics?.messages ?? diagnostics?.stdout?.slice(-4000) ?? '')}`;
    expect(result, details).toMatchObject({ check: 'completed', status: 'not-established' });
    expect(result.evidence).toBeDefined();
    expect(result.pairs).toHaveLength(11);
    for (const pair of result.pairs) expect(pair).toMatchObject({
      candidateToReference: { status: 'not-established' }, referenceToCandidate: { status: 'not-established' },
    });
  }, 0);

  it('preserves local-conclusion and false-premise baseline rejection', async () => {
    const input = request({
      assumption: `${binders} : ∀ [Fintype α] (p q : ℕ), Prime p → Prime q →`
        + ' Fintype.card α = p * q → (given : Q p q) → Q p q',
      impossible: `${binders} (impossible : False) : ${finiteLaw}`,
    }, {
      assumption: `${binders} : ∀ (p q : ℕ), Nat.Prime p → Nat.Prime q →`
        + ' Nat.card α = p * q → (given : Q p q) → Q p q',
      impossible: `${binders} (impossible : False) : ${naturalLaw}`,
    });
    const result = await compare('baseline', input);
    expect(result).toMatchObject({ check: 'completed', status: 'not-established' });
    expect(result.evidence).toBeDefined();
    for (const pair of result.pairs) expect(pair).toMatchObject({
      candidateToReference: { status: 'not-established', reason: 'baseline-trivial' },
      referenceToCandidate: { status: 'not-established', reason: 'baseline-trivial' },
    });
  }, 0);

  it.each(['method', 'schema', 'report-schema', 'rule', 'rule-version', 'position',
    'side-condition-kind', 'missing-side-condition', 'condition-term', 'proof', 'boolean-condition', 'query', 'artifact'])(
    'rejects changed cardinality %s evidence', mutation => {
      const modified = JSON.parse(canonicalMathJson(positive));
      if (mutation === 'method') modified.method = 'finite-family-correspondence-v4';
      else if (mutation === 'schema') modified.schema = 'theoremos.formalization-reference.v3';
      else if (mutation === 'query') modified.files.find((file: { file: string }) => file.file === 'ReferenceComparison.lean').text += '\n-- changed\n';
      else if (mutation === 'artifact') modified.evidence.artifacts[0].text += ' ';
      else {
        const report = JSON.parse(modified.evidence.reportText);
        const steps = report.pairs.flatMap((pair: { transformations: unknown[] }) => pair.transformations);
        const step = steps.find((value: { ruleId: string }) => value.ruleId === 'cardinality-prime-product');
        if (mutation === 'report-schema') report.schema = 'theoremos.reference-report.v3';
        else if (mutation === 'rule') step.ruleId = 'unchecked-cardinality';
        else if (mutation === 'rule-version') step.ruleVersion = 2;
        else if (mutation === 'position') step.position.kind = 'forall-conclusion';
        else if (mutation === 'side-condition-kind') step.sideConditions[0].kind = 'finite-index-universe';
        else if (mutation === 'missing-side-condition') step.sideConditions = [];
        else if (mutation === 'condition-term') step.sideConditions[0].term += 'changed';
        else if (mutation === 'proof') step.proof.forward += 'changed';
        else {
          const boolean = steps.find((value: { ruleId: string }) => value.ruleId === 'boolean-false');
          boolean.sideConditions = [step.sideConditions[0]];
        }
        modified.evidence.reportText = JSON.stringify(report);
        modified.evidence.reportSha256 = mathDigest(modified.evidence.reportText);
      }
      expect(() => assertFormalizationReferenceResult(positiveInput, modified)).toThrow();
    });
});
