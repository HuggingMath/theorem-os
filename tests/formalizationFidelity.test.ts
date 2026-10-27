import { describe, expect, it } from 'vitest';
import { assertFormalizationFidelity, fidelityReferenceInput, fidelityPolicySchema,
  formalizationFidelitySchema, FIDELITY_REVIEW_INSTRUCTIONS,
  type FormalizationFidelity, type FormalizationFidelitySnapshot } from '../src/math/formalizationFidelity';
import { eraseFormalizationProofs } from '../src/math/formalizationSource';

// Handwritten linkage fixtures, not evidence of natural-language fidelity.
const original = 'For every natural number n, if n = 0, prove n + 0 = 0.';
function fixture() {
  const snapshot: FormalizationFidelitySnapshot = {
    environment: 'standard',
    source: 'theorem answer (n : Nat) (h : n = 0) : n + 0 = 0 := by sorry\n',
    targets: [{ name: 'answer', context: { bindings: {
      binders: [
        { id: 'b0', name: 'n', type: 'Nat', kind: 'explicit', dependencies: [] },
        { id: 'b1', name: 'h', type: 'n = 0', kind: 'explicit', dependencies: ['b0'] },
      ], conclusion: 'n + 0 = 0', conclusionDependencies: ['b0'],
    } } }],
  };
  const fidelity: FormalizationFidelity = {
    policy: 'task-preserving-v1',
    targets: [{ targetName: 'answer', originalFragment: original,
      sourceClaim: 'For every n : Nat, n = 0 implies n + 0 = 0.',
      candidateClaim: 'For every n : Nat, n = 0 implies n + 0 = 0.',
      hypothesisScope: 'The equality hypothesis concerns the current n.',
      quantifierOrder: 'Universally choose n before its equality hypothesis.',
      binderIds: ['b0', 'b1'], conclusionDependencies: ['b0'] }],
    sourceContract: {
      source: 'theorem source_answer (n : Nat) (h : n = 0) : n + 0 = 0 := by sorry\n',
      pairs: [{ candidateTarget: 'answer', referenceTarget: 'source_answer' }],
    },
  };
  return { input: { original, observation: { snapshot } }, snapshot, fidelity };
}

describe('task-preserving fidelity linkage', () => {
  it('binds each target to the original and the complete observed telescope', () => {
    const { input, fidelity, snapshot } = fixture();
    expect(assertFormalizationFidelity(input, 'approved', fidelity)).toEqual(fidelity);
    expect(fidelityReferenceInput(snapshot, fidelity)).toEqual({
      candidateSource: snapshot.source, referenceSource: fidelity.sourceContract!.source,
      environment: 'standard', pairs: fidelity.sourceContract!.pairs, purpose: 'task-fidelity-v1',
    });
    expect(fidelityPolicySchema.safeParse('task-preserving-v2').success).toBe(false);
    expect(formalizationFidelitySchema.safeParse({ ...fidelity, machineVerified: true }).success).toBe(false);
  });

  it.each(['missing', 'duplicate', 'invented'] as const)('rejects %s target coverage', change => {
    const { input, fidelity } = fixture();
    if (change === 'missing') fidelity.targets = [];
    else if (change === 'duplicate') fidelity.targets.push(structuredClone(fidelity.targets[0]!));
    else fidelity.targets[0]!.targetName = 'different';
    expect(() => assertFormalizationFidelity(input, 'approved', fidelity)).toThrow('target_coverage_invalid');
  });

  it.each([[], ['b0'], ['b0', 'b0'], ['b1', 'b0'], ['b0', 'b1', 'b2']].map(binderIds => ({ binderIds })))(
    'rejects incomplete, duplicate, reordered or forged binders $binderIds', ({ binderIds }) => {
      const { input, fidelity } = fixture();
      fidelity.targets[0]!.binderIds = binderIds;
      expect(() => assertFormalizationFidelity(input, 'approved', fidelity)).toThrow('binding_evidence_invalid');
    });

  it.each([[], ['b1'], ['b0', 'b0'], ['b0', 'b1']].map(dependencies => ({ dependencies })))(
    'rejects forged conclusion dependencies $dependencies', ({ dependencies }) => {
    const { input, fidelity } = fixture();
    fidelity.targets[0]!.conclusionDependencies = dependencies;
    expect(() => assertFormalizationFidelity(input, 'approved', fidelity)).toThrow('binding_evidence_invalid');
    });

  it('requires observed bindings and a snapshot whose targets match its source', () => {
    const missing = fixture();
    delete missing.snapshot.targets[0]!.context.bindings;
    expect(() => assertFormalizationFidelity(missing.input, 'unknown', missing.fidelity)).toThrow('binding_evidence_invalid');
    const forged = fixture();
    forged.snapshot.source = forged.snapshot.source.replace('answer', 'unobserved');
    expect(() => assertFormalizationFidelity(forged.input, 'approved', forged.fidelity)).toThrow('target_coverage_invalid');
  });

  it('rejects invented or normalized source quotations', () => {
    const { input, fidelity } = fixture();
    fidelity.targets[0]!.originalFragment = 'For every n, if n = 0, prove n + 0 = 0.';
    expect(() => assertFormalizationFidelity(input, 'approved', fidelity)).toThrow('original_fragment_not_found:answer');
    fidelity.targets[0]!.originalFragment = original.replace(' n,', '  n,');
    expect(() => assertFormalizationFidelity(input, 'approved', fidelity)).toThrow('original_fragment_not_found:answer');
  });

  it('requires a source contract for approval while preserving unresolved reviews', () => {
    const { input, fidelity } = fixture();
    fidelity.sourceContract = null;
    expect(() => assertFormalizationFidelity(input, 'approved', fidelity)).toThrow('source_contract_required');
    expect(assertFormalizationFidelity(input, 'unknown', fidelity)).toEqual(fidelity);
    expect(assertFormalizationFidelity(input, 'changes_requested', fidelity)).toEqual(fidelity);
  });

  it('retains unavailable observations as unresolved without inventing target evidence', () => {
    const input = { original, observation: { snapshot: null } };
    const fidelity: FormalizationFidelity = { policy: 'task-preserving-v1', targets: [], sourceContract: null };
    expect(assertFormalizationFidelity(input, 'unknown', fidelity)).toEqual(fidelity);
    expect(() => assertFormalizationFidelity(input, 'approved', fidelity)).toThrow();
    expect(() => assertFormalizationFidelity(input, 'unknown', fixture().fidelity)).toThrow('snapshot_unavailable');
  });

  it.each(['missing', 'duplicate', 'invented', 'extra-target'] as const)('rejects a %s contract mapping', change => {
    const { input, fidelity } = fixture(), contract = fidelity.sourceContract!;
    if (change === 'missing') contract.pairs = [];
    else if (change === 'duplicate') contract.pairs.push({ ...contract.pairs[0]! });
    else if (change === 'invented') contract.pairs[0]!.referenceTarget = 'absent';
    else contract.source += 'theorem extra (n : Nat) : n = 0 := by sorry\n';
    expect(() => assertFormalizationFidelity(input, 'approved', fidelity)).toThrow('source_contract_mapping_invalid');
  });

  it('rejects theorem proofs and unsupported admissions in the source contract', () => {
    const proof = fixture();
    proof.fidelity.sourceContract!.source = proof.fidelity.sourceContract!.source.replace('by sorry', 'by simpa [h]');
    expect(() => assertFormalizationFidelity(proof.input, 'approved', proof.fidelity)).toThrow('source_contract_not_erased');
    const axiom = fixture();
    axiom.fidelity.sourceContract!.source = 'axiom hidden : False\n' + axiom.fidelity.sourceContract!.source;
    expect(() => assertFormalizationFidelity(axiom.input, 'approved', axiom.fidelity)).toThrow('unsupported_declaration');
  });

  it('erases candidate proofs in the comparison request and retains each pinned environment', () => {
    const { snapshot, fidelity } = fixture();
    snapshot.source = snapshot.source.replace('by sorry', 'by simpa [h]');
    expect(fidelityReferenceInput(snapshot, fidelity).candidateSource).toBe(eraseFormalizationProofs(snapshot.source));
    expect(fidelityReferenceInput(snapshot, fidelity).candidateSource).not.toContain('simpa');
    snapshot.environment = 'mathlib';
    expect(fidelityReferenceInput(snapshot, fidelity).environment).toBe('mathlib');
    snapshot.environment = 'mathlib-4.8';
    expect(fidelityReferenceInput(snapshot, fidelity)).toMatchObject({ environment: 'mathlib-4.8', purpose: 'task-fidelity-v1' });
  });

  it('does not turn a reviewer-authored strengthening claim into machine evidence', () => {
    const { input, fidelity } = fixture();
    fidelity.targets[0]!.hypothesisScope = 'I claim this globally quantified hypothesis is equivalent to the current pair.';
    // Linkage accepts prose as prose. Only the subsequent guarded comparison may
    // establish supported Lean correspondence, and neither check certifies NL meaning.
    expect(assertFormalizationFidelity(input, 'approved', fidelity)).toEqual(fidelity);
    expect(assertFormalizationFidelity(input, 'approved', fidelity)).not.toHaveProperty('machineVerified');
    expect(FIDELITY_REVIEW_INSTRUCTIONS).toContain('A stronger local theorem');
    expect(FIDELITY_REVIEW_INSTRUCTIONS).toContain('additional necessary condition');
    expect(FIDELITY_REVIEW_INSTRUCTIONS).toContain('reviewer-authored');
    // An environment-decidable class-strength question must be reported, not
    // left as unknown round after round: the source's own operations force the class.
    expect(FIDELITY_REVIEW_INSTRUCTIONS).toContain('the environment forces the additional structure');
    expect(FIDELITY_REVIEW_INSTRUCTIONS).toContain('reserve unknown for questions that inspection of the pinned environment cannot decide');
    expect(FIDELITY_REVIEW_INSTRUCTIONS).toContain('do not adopt a strength because it makes the source claim true');
  });
});
