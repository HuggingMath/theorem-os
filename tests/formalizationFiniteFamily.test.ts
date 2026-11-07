import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertFormalizationReferenceResult, type FormalizationReferenceInput,
  type FormalizationReferenceResult } from '../src/math/formalizationReference';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { compareFormalizationReference } from '../src/solver/formalizationReference';

const prelude = `import Mathlib
universe u v w
`;
const source = (headers: Record<string, string>) => prelude + Object.entries(headers)
  .map(([name, header]) => `theorem ${name} ${header} := by original_proof_must_not_run
`).join('');
const request = (candidate: Record<string, string>, reference: Record<string, string>,
  purpose?: FormalizationReferenceInput['purpose']): FormalizationReferenceInput => ({
  candidateSource: source(candidate), referenceSource: source(reference), environment: 'mathlib',
  pairs: Object.keys(candidate).map(name => ({ candidateTarget: name, referenceTarget: name })),
  ...(purpose ? { purpose } : {}),
});
const binders = '{α : Type u} {β : Type w} (P : α → Prop) (U : α → Set β) (Q : Set β → Prop)';
const finiteLaw = '∀ s : Finset α, (∀ a ∈ s, P a) → Q (⋃ a ∈ s, U a)';
const indexedLaw = '∀ (ι : Type v) [Fintype ι] (f : ι → α), (∀ i, P (f i)) → Q (⋃ i, U (f i))';
const positiveInput = request({
  general: `${binders} : ${finiteLaw}`,
  swapped: `${binders} : ${indexedLaw}`,
  independent_universes_and_binders: `${binders} : ${finiteLaw}`,
  shared_index_universe: `${binders} : ${finiteLaw}`,
}, {
  general: `${binders} : ${indexedLaw}`,
  swapped: `${binders} : ${finiteLaw}`,
  independent_universes_and_binders:
    '{α : Type u} {β : Type w} (Q : Set β → Prop) (U : α → Set β) (P : α → Prop)'
      + ` : ${indexedLaw}`,
  shared_index_universe: `${binders} : ${indexedLaw.replace('Type v', 'Type u')}`,
});

// The production compare/assert Interface checks the fixed rule on arbitrary
// P, U and Q; it never receives a caller-provided bridge theorem or tactic.
// Native execution is explicitly opted in, uses disposable temporary directories,
// and preserves 0 = no deadline for both Lean and Vitest.
describe.skipIf(process.env.THEOREMOS_TEST_REFERENCE_LEAN !== '1')('native Lean finite-family representation correspondence', () => {
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
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'finite-family-native-')));
    positive = await compare('positive', positiveInput);
    expect(positive.status, positive.reason).toBe('established');
  }, 0);
  afterAll(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  it('establishes arbitrary finite families in either direction with independent universes and reordered binders', () => {
    expect(positive).toMatchObject({ schema: 'theoremos.formalization-reference.v4',
      method: 'cardinality-correspondence-v5', check: 'completed', status: 'established',
      modelInvoked: false, proofVerified: false, semanticEquivalenceClaimed: false, limits: { timeoutMs: 0 } });
    expect(positive.pairs).toHaveLength(4);
    for (const pair of positive.pairs) expect(pair).toMatchObject({
      candidateToReference: { status: 'established' }, referenceToCandidate: { status: 'established' },
    });
    expect(positive.evidence?.artifacts).toHaveLength(3);
    const report = JSON.parse(positive.evidence!.reportText);
    expect(report.schema).toBe('theoremos.reference-report.v4');
    expect(report.pairs).toHaveLength(4);
    for (const pair of report.pairs) {
      expect(pair.representationCorrespondence).toBe(true);
      expect(pair.transformations.length).toBeGreaterThan(0);
      for (const step of pair.transformations) {
        expect(step).toMatchObject({ ruleId: 'finite-family-reindex', ruleVersion: 1,
          position: { kind: 'forall-suffix' } });
        expect(['candidate', 'reference']).toContain(step.side);
        expect(step.before.expression).toEqual(expect.any(String));
        expect(step.after.expression).toEqual(expect.any(String));
        expect(step.before.expression).not.toBe(step.after.expression);
        expect(step.before.context).toEqual(expect.any(Array));
        expect(step.after.context).toEqual(step.before.context);
        expect(step.before.universes).toEqual(expect.any(Array));
        expect(step.after.universes).toEqual(expect.any(Array));
        expect(step.sideConditions.length).toBeGreaterThan(0);
        expect(step.proof).toMatchObject({ forward: expect.any(String), backward: expect.any(String) });
      }
    }
    // Neither a Nonempty index restriction nor an injective-family requirement
    // appears in these arbitrary-family statements. The fixed kernel lemma
    // must cover Fin 0 and repeated Fin 2 indices without changing the input.
    expect(positiveInput.referenceSource).not.toMatch(/Nonempty|Injective/);
    const generated = Object.values(positive.files).map(file => file.text).join('');
    expect(generated).not.toContain('original_proof_must_not_run');
    expect(generated).not.toMatch(/(?:sorry|sorryAx|axiom|admit)/u);
  });

  it('keeps changed premises, restricted indices, changed unions, and collapsed outer universes unknown', async () => {
    const candidates = Object.fromEntries(['extra_premise', 'removed_predicate', 'non_function_predicate', 'nonempty_index',
      'changed_property', 'changed_union', 'collapsed_outer_universes']
      .map(name => [name, `${binders} : ${finiteLaw}`]));
    const input = request(candidates, {
      extra_premise: `${binders} (extra : ∃ a, P a) : ${indexedLaw}`,
      removed_predicate: `${binders} : ∀ (ι : Type v) [Fintype ι] (f : ι → α), Q (⋃ i, U (f i))`,
      non_function_predicate: `${binders} : ∀ (ι : Type v) [Fintype ι] (f : ι → α), True → Q (⋃ i, U (f i))`,
      nonempty_index: `${binders} : ∀ (ι : Type v) [Fintype ι] [Nonempty ι] (f : ι → α),`
        + ' (∀ i, P (f i)) → Q (⋃ i, U (f i))',
      changed_property: `${binders} : ∀ (ι : Type v) [Fintype ι] (f : ι → α),`
        + ' (∀ i, P (f i)) → ¬ Q (⋃ i, U (f i))',
      changed_union: `${binders} : ∀ (ι : Type v) [Fintype ι] (f : ι → α),`
        + ' (∀ i, P (f i)) → Q (⋃ i, (U (f i))ᶜ)',
      collapsed_outer_universes: binders.replace('Type w', 'Type u') + ` : ${indexedLaw}`,
    });
    const result = await compare('negative', input);
    expect(result).toMatchObject({ check: 'completed', status: 'not-established' });
    expect(result.evidence).toBeDefined();
    expect(result.pairs).toHaveLength(7);
    for (const pair of result.pairs) expect(pair).toMatchObject({
      candidateToReference: { status: 'not-established' }, referenceToCandidate: { status: 'not-established' },
    });
  }, 0);

  it('does not bypass local-conclusion and false-premise baselines through reindexing', async () => {
    const input = request({
      assumption: `${binders} : ∀ s : Finset α, (given : Q (⋃ a ∈ s, U a)) →`
        + ' (∀ a ∈ s, P a) → Q (⋃ a ∈ s, U a)',
      impossible: `${binders} (impossible : False) : ${finiteLaw}`,
    }, {
      assumption: `${binders} : ∀ (ι : Type v) [Fintype ι] (f : ι → α),`
        + ' (given : Q (⋃ i, U (f i))) → (∀ i, P (f i)) → Q (⋃ i, U (f i))',
      impossible: `${binders} (impossible : False) : ${indexedLaw}`,
    });
    const result = await compare('baseline', input);
    expect(result).toMatchObject({ check: 'completed', status: 'not-established' });
    expect(result.evidence).toBeDefined();
    for (const pair of result.pairs) expect(pair).toMatchObject({
      candidateToReference: { status: 'not-established', reason: 'baseline-trivial' },
      referenceToCandidate: { status: 'not-established', reason: 'baseline-trivial' },
    });
  }, 0);

  it.each(['method', 'rule', 'rule-version', 'position', 'context', 'universes', 'side-condition', 'proof'])(
    'rejects changed finite-family %s evidence', mutation => {
      const modified = JSON.parse(canonicalMathJson(positive));
      if (mutation === 'method') modified.method = 'representation-correspondence-v3';
      else {
        const report = JSON.parse(modified.evidence.reportText);
        const step = report.pairs[0].transformations[0];
        if (mutation === 'rule') step.ruleId = 'unchecked-finite-family';
        else if (mutation === 'rule-version') step.ruleVersion = 2;
        else if (mutation === 'position') step.position.kind = 'forall-conclusion';
        else if (mutation === 'context') step.after.context[0].type = 'False';
        else if (mutation === 'universes') step.before.universes.push('unbound-universe');
        else if (mutation === 'side-condition') step.sideConditions = [];
        else step.proof.forward += 'changed';
        modified.evidence.reportText = JSON.stringify(report);
        modified.evidence.reportSha256 = mathDigest(modified.evidence.reportText);
      }
      expect(() => assertFormalizationReferenceResult(positiveInput, modified)).toThrow();
    });
});

describe.skipIf(process.env.THEOREMOS_TEST_REFERENCE_LEAN !== '1')('native Lean proper finite-family correspondence', () => {
  let root: string;
  const candidate = '{F V : Type*} [Field F] [Infinite F] [AddCommGroup V] [Module F V]\n'
    + '    (s : Finset (Subspace F V)) (hs : ∀ p ∈ s, p < ⊤) :\n'
    + '    (⋃ p ∈ s, (p : Set V)) ≠ Set.univ';
  const reference = '{K V : Type*} [Field K] [Infinite K] [AddCommGroup V]\n'
    + '  [Module K V] {ι : Type*} [Fintype ι] (γ : ι → Submodule K V)\n'
    + '  (h : ∀ i : ι, γ i ≠ ⊤) :\n'
    + '  (⋃ (i : ι), (γ i : Set V)) ≠ ⊤';
  const properInput: FormalizationReferenceInput = { candidateSource: source({ not_union_finset_proper_subspaces: candidate }),
    referenceSource: source({ exercise_3_7_2: reference }), environment: 'mathlib', purpose: 'task-fidelity-v2',
    pairs: [{ candidateTarget: 'not_union_finset_proper_subspaces', referenceTarget: 'exercise_3_7_2' }] };
  beforeAll(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'finite-proper-native-'))); });
  afterAll(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });
  const checkCompleted = (result: FormalizationReferenceResult, name: string) => {
    let detail = result.reason ?? 'unknown';
    try {
      const diagnostics = JSON.parse(fs.readFileSync(path.join(root, name, 'diagnostics.json'), 'utf8'));
      detail += '\n' + JSON.stringify(diagnostics.firstBlocking ?? diagnostics.stderr);
    } catch { /* The solver may fail before creating compiler diagnostics. */ }
    expect(result.check, detail).toBe('completed');
  };

  it('proves the strict proper-condition conversion and keeps its trace auditable', async () => {
    const result = await compareFormalizationReference(path.join(root, 'positive'), properInput, { env: process.env, timeoutMs: 0 });
    expect(() => assertFormalizationReferenceResult(properInput, result)).not.toThrow();
    checkCompleted(result, 'positive');
    expect(result).toMatchObject({ schema: 'theoremos.formalization-reference.v6', method: 'cardinality-correspondence-v7',
      check: 'completed', status: 'established', modelInvoked: false, proofVerified: false, semanticEquivalenceClaimed: false });
    const report = JSON.parse(result.evidence!.reportText);
    expect(report.schema).toBe('theoremos.reference-report.v6');
    const steps = report.pairs[0].transformations;
    expect(steps.map((step: { ruleId: string }) => step.ruleId)).toEqual(expect.arrayContaining([
      'finite-proper-condition', 'finite-family-reindex',
    ]));
    for (const step of steps) expect(step.ruleVersion).toBe(1);
    expect(Object.values(result.files).map(file => file.text).join('')).not.toMatch(/\b(?:sorry|sorryAx|axiom|admit)\b/u);
  }, 0);

  it('does not treat a non-equivalent non-strict condition as properness', async () => {
    const changed: FormalizationReferenceInput = { ...properInput,
      candidateSource: source({ not_union_finset_proper_subspaces: candidate.replace('p < ⊤', 'p ≤ ⊤') }) };
    const result = await compareFormalizationReference(path.join(root, 'negative'), changed, { env: process.env, timeoutMs: 0 });
    checkCompleted(result, 'negative');
    expect(result).toMatchObject({ check: 'completed', status: 'not-established' });
    expect(result.pairs[0]).toMatchObject({ candidateToReference: { status: 'not-established' }, referenceToCandidate: { status: 'not-established' } });
  }, 0);
});
