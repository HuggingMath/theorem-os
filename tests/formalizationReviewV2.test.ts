import { describe, expect, it } from 'vitest';
import {
  assertReviewBacktranslation, assertReviewStatementObservation, assertStructuredSemanticReview,
  resolveReviewEnvironment, resolveStructuredReviews, STRUCTURED_REVIEW_EVIDENCE_VERSION,
  structuredReviewAspects, structuredReviewConfigurationSchema,
  structuredReviewDigest, structuredReviewInput, structuredReviewOutputSchema,
  structuredReviewRecheckReasons, structuredReviewReplaySchema, structuredSemanticReviewSchema,
  formalizationReviewInstructions,
  type ReviewStatementObservation, type ReviewStatementSnapshot, type StructuredReviewInput,
  type StructuredSemanticReview,
} from '../src/math/formalizationReviewV2';
import { formalizationEvaluationInputDigest, formalizationEvaluationLeanSource,
  type FormalizationEvaluationReviewerInput } from '../src/math/formalizationEvaluation';
import type { FormalizationTranslation } from '../src/math/formalization';
import { eraseFormalizationProofs } from '../src/math/formalizationSource';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import type { LeanStatementContext } from '../src/math/leanStatementContext';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { semanticContextFixture } from './helpers/formalizationFixture';

// Handwritten contract fixtures only: no benchmark data, compiler, model or semantic-accuracy claim.
function fixture(context: Partial<LeanStatementContext> = {}) {
  const base: FormalizationEvaluationReviewerInput = {
    schema: 'theorem-os.formalization-review-input.v1', caseId: 'case_' + 'a'.repeat(64),
    original: 'For every natural number n, if n = 0 then n = 0. Equality has its usual meaning ' +
      'and uses the natural-number instance. Also, True holds.',
    header: 'import Mathlib\n',
    candidate: 'theorem reflexiveZero (n : Nat) (h : n = 0) : n = 0 := by exact h\n' +
      'theorem closed : True := by trivial\n',
  };
  const environment = resolveReviewEnvironment({ sourceToolchain: getLeanTaskEnvironment('mathlib').toolchain }, 'auto');
  const source = eraseFormalizationProofs(formalizationEvaluationLeanSource(base));
  const snapshot: ReviewStatementSnapshot = {
    schema: 'theorem-os.formalization-snapshot.v1', source, sourceSha256: mathDigest(source),
    environment: environment.environment, environmentDigest: environment.environmentDigest,
    targets: [
      { name: 'reflexiveZero', declarationHash: mathDigest('handwritten-reflexive-zero-declaration'), context: {
        type: '∀ (n : Nat), Eq n 0 → Eq n 0',
        constants: [
          { name: 'Eq', module: 'Init.Prelude', type: '{α : Sort u} → α → α → Prop' },
          { name: 'Nat.zero', module: 'Init.Prelude', type: 'Nat', definition: '0' },
        ], omitted: [],
        bindings: { binders: [
          { id: 'b0', name: 'n', type: 'Nat', kind: 'explicit', dependencies: [] },
          { id: 'b1', name: 'h', type: '@Eq Nat n Nat.zero', kind: 'explicit', dependencies: ['b0'] },
        ], conclusion: '@Eq Nat n Nat.zero', conclusionDependencies: ['b0'] },
        ...context,
      } },
      { name: 'closed', declarationHash: mathDigest('handwritten-closed-declaration'), context: {
        type: 'True', constants: [], omitted: [],
        bindings: { binders: [], conclusion: 'True', conclusionDependencies: [] },
      } },
    ],
  };
  const observation: ReviewStatementObservation = {
    schema: 'theorem-os.formalization-review-observation.v2', caseId: base.caseId,
    inputDigest: formalizationEvaluationInputDigest(base), sourceSha256: snapshot.sourceSha256,
    environment, status: 'elaborated', snapshot, snapshotDigest: structuredReviewDigest(snapshot), diagnostics: '',
  };
  return { base, environment, snapshot, observation, input: structuredReviewInput(base, observation) };
}

function review(input: StructuredReviewInput): StructuredSemanticReview {
  const fragments = {
    domains: ['natural number', 'Nat'],
    assumptions: ['if n = 0', '(h : n = 0)'],
    conclusions: ['then n = 0', ': n = 0'],
    definitions: ['Equality', '{α : Sort u} → α → α → Prop'],
    quantifierScope: ['For every natural number n', '∀ (n : Nat)'],
    instanceCoherence: ['natural-number instance', '@Eq Nat n Nat.zero'],
  };
  return {
    schema: 'theorem-os.formalization-semantic-review.v2', caseId: input.caseId,
    evidenceVersion: STRUCTURED_REVIEW_EVIDENCE_VERSION,
    inputDigest: structuredReviewDigest(input), verdict: 'approved', summary: 'Handwritten correspondence fixture.',
    checks: { domains: 'faithful', assumptions: 'faithful', conclusions: 'faithful', definitions: 'faithful',
      quantifierScope: 'faithful', instanceCoherence: 'faithful' },
    correspondences: structuredReviewAspects.map(aspect => ({
      aspect, originalFragment: fragments[aspect][0], candidateFragment: fragments[aspect][1], relation: 'direct',
      explanation: 'This local fixture links the quoted statement fragments.', forwardArgument: '', reverseArgument: '',
      sourceReadings: [], mismatchEvidence: null,
    })),
  };
}

const mismatchEvidence = {
  sourceClaim: 'The complete source implication under its hypotheses.',
  candidateClaim: 'The complete candidate implication under the corresponding hypotheses.',
  separationArgument: 'Handwritten separation-evidence fixture; this test does not certify its mathematical truth.',
};

function reseal(observation: ReviewStatementObservation) {
  observation.sourceSha256 = observation.snapshot!.sourceSha256 = mathDigest(observation.snapshot!.source);
  observation.snapshotDigest = structuredReviewDigest(observation.snapshot);
  return observation;
}

function translation(observation: ReviewStatementObservation): FormalizationTranslation {
  return { snapshotDigest: observation.snapshotDigest!, mathematics: 'The two displayed propositions hold.',
    assumptions: ['n is a natural number and n = 0 for the first proposition.'], definitions: ['Usual equality.'],
    targets: observation.snapshot!.targets.map(target => ({ name: target.name,
      mathematics: target.name === 'closed' ? 'True holds.' : 'For every natural number n, if n = 0 then n = 0.' })),
  };
}

describe('v2 review environment resolution', () => {
  it.each(['mathlib-4.8', 'mathlib'] as const)('selects the runtime pin for the known %s toolchain', selected => {
    const active = getLeanTaskEnvironment(selected);
    expect(resolveReviewEnvironment({ sourceToolchain: active.toolchain }, 'auto')).toEqual({
      sourceToolchain: active.toolchain, sourceMathlibRevision: null, environment: selected,
      toolchain: active.toolchain, mathlibRevision: active.mathlibRevision, environmentDigest: active.dependencyDigest,
      compatibility: 'matched', revisionBasis: 'runtime-pin-for-source-toolchain',
    });
  });

  it('preserves supplied revision provenance and rejects an explicit revision mismatch', () => {
    const active = getLeanTaskEnvironment('mathlib-4.8');
    const matching = resolveReviewEnvironment({ sourceToolchain: active.toolchain,
      sourceMathlibRevision: active.mathlibRevision }, 'auto');
    expect(matching).toMatchObject({ environment: 'mathlib-4.8', compatibility: 'matched', revisionBasis: 'supplied-provenance' });
    const mismatch = resolveReviewEnvironment({ sourceToolchain: active.toolchain, sourceMathlibRevision: '0'.repeat(40) }, 'auto');
    expect(mismatch).toMatchObject({ sourceMathlibRevision: '0'.repeat(40), compatibility: 'mismatch', revisionBasis: 'supplied-provenance' });
    expect(resolveReviewEnvironment({ sourceToolchain: active.toolchain }, 'mathlib').compatibility).toBe('mismatch');
  });

  it('keeps unknown toolchains unresolved and distinguishes a standard environment with no Mathlib', () => {
    expect(resolveReviewEnvironment({ sourceToolchain: 'leanprover/lean4:v0.0.0' }, 'auto'))
      .toMatchObject({ environment: 'mathlib', compatibility: 'unresolved' });
    expect(resolveReviewEnvironment({ sourceToolchain: getLeanTaskEnvironment('standard').toolchain }, 'standard'))
      .toMatchObject({ environment: 'standard', compatibility: 'matched', mathlibRevision: null, revisionBasis: 'no-mathlib' });
  });
});

describe('host statement observation binding', () => {
  it('requires semantic context on every target only for the opted-in protocol', () => {
    const f = fixture();
    expect(assertReviewStatementObservation(f.base, f.environment, f.observation)).toEqual(f.observation);
    expect(() => assertReviewStatementObservation(f.base, f.environment, f.observation, 'kernel-v1'))
      .toThrow('formalization_review_observation_missing_semantic_context');
    for (const target of f.snapshot.targets) target.context.semantic = semanticContextFixture();
    reseal(f.observation);
    expect(assertReviewStatementObservation(f.base, f.environment, f.observation, 'kernel-v1')).toEqual(f.observation);
    delete f.snapshot.targets[1].context.semantic;
    reseal(f.observation);
    expect(() => assertReviewStatementObservation(f.base, f.environment, f.observation, 'kernel-v1'))
      .toThrow('formalization_review_observation_missing_semantic_context');
  });

  it('requires semantic and structure context on every kernel-v2 target, accepting an explicit empty structure observation', () => {
    const f = fixture();
    expect(() => assertReviewStatementObservation(f.base, f.environment, f.observation, 'kernel-v2'))
      .toThrow('formalization_review_observation_missing_semantic_context');
    for (const target of f.snapshot.targets) target.context.semantic = semanticContextFixture();
    reseal(f.observation);
    expect(assertReviewStatementObservation(f.base, f.environment, f.observation, 'kernel-v1')).toEqual(f.observation);
    expect(() => assertReviewStatementObservation(f.base, f.environment, f.observation, 'kernel-v2'))
      .toThrow('formalization_review_observation_missing_structure_context');
    for (const target of f.snapshot.targets)
      target.context.structures = { schema: 'theorem-os.lean-statement-structures.v1', entries: [] };
    reseal(f.observation);
    expect(assertReviewStatementObservation(f.base, f.environment, f.observation, 'kernel-v2')).toEqual(f.observation);
    delete f.snapshot.targets[1].context.structures;
    reseal(f.observation);
    expect(() => assertReviewStatementObservation(f.base, f.environment, f.observation, 'kernel-v2'))
      .toThrow('formalization_review_observation_missing_structure_context');
  });

  it('accepts detailed contexts and binds their exact source, snapshot and environment', () => {
    const f = fixture();
    expect(assertReviewStatementObservation(f.base, f.environment, f.observation)).toEqual(f.observation);
    const mutations: ((observation: ReviewStatementObservation) => void)[] = [
      value => { value.caseId = 'case_' + 'b'.repeat(64); },
      value => { value.inputDigest = 'b'.repeat(64); },
      value => { value.environment = { ...value.environment, environmentDigest: 'b'.repeat(64) }; },
      value => { value.snapshotDigest = 'b'.repeat(64); },
      value => { value.snapshot!.environmentDigest = 'b'.repeat(64); reseal(value); },
      value => { value.snapshot!.source += '\ntheorem swapped : True := by sorry\n'; reseal(value); },
      value => { value.sourceSha256 = 'b'.repeat(64); },
      value => { value.snapshot!.targets.push(structuredClone(value.snapshot!.targets[0])); reseal(value); },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(f.observation); mutate(changed);
      expect(() => assertReviewStatementObservation(f.base, f.environment, changed)).toThrow(/formalization_review_observation_/u);
    }
  });

  it('cannot upgrade a legacy context without bindings to a v2 observation', () => {
    const f = fixture();
    delete f.snapshot.targets[0].context.bindings;
    reseal(f.observation);
    expect(() => assertReviewStatementObservation(f.base, f.environment, f.observation))
      .toThrow('formalization_review_observation_missing_bindings');
  });

  it('allows an explicit unavailable observation but rejects a mismatched environment claiming elaboration', () => {
    const f = fixture();
    const mismatch = { ...f.environment, compatibility: 'mismatch' as const };
    const elaborated = { ...f.observation, environment: mismatch };
    expect(() => assertReviewStatementObservation(f.base, mismatch, elaborated)).toThrow('formalization_review_observation_invalid');
    const unavailable: ReviewStatementObservation = { ...elaborated, status: 'unavailable', snapshot: null,
      snapshotDigest: null, diagnostics: 'The source revision differs from the selected runtime.' };
    expect(assertReviewStatementObservation(f.base, mismatch, unavailable)).toEqual(unavailable);
    for (const changed of [{ ...unavailable, diagnostics: ' ' }, { ...unavailable, snapshot: f.snapshot },
      { ...unavailable, snapshotDigest: f.observation.snapshotDigest }]) {
      expect(() => assertReviewStatementObservation(f.base, mismatch, changed)).toThrow('formalization_review_observation_invalid');
    }
  });
});

describe('structured fragment evidence', () => {
  it('binds structure observations to exported constants and admits only actual entry, projection and field-type fragments', () => {
    const entry = { name: 'Nontrivial', class: true,
      fields: [{ name: 'Nontrivial.exists_pair_ne', type: '{α : Sort u} → Nontrivial α → ∃ x y : α, x ≠ y' }] };
    const f = fixture({ structures: { schema: 'theorem-os.lean-statement-structures.v1', entries: [entry] } });
    f.snapshot.targets[0].context.constants.push({ name: entry.name, module: 'Mathlib.Logic.Nontrivial.Defs',
      type: '(α : Sort u) → Prop' });
    for (const target of f.snapshot.targets) {
      target.context.semantic = semanticContextFixture();
      target.context.structures ??= { schema: 'theorem-os.lean-statement-structures.v1', entries: [] };
    }
    reseal(f.observation);
    expect(assertReviewStatementObservation(f.base, f.environment, f.observation, 'kernel-v2')).toEqual(f.observation);
    const evidence = review(f.input);
    evidence.correspondences[0].candidateFragment = entry.name;
    evidence.correspondences[1].candidateFragment = entry.fields[0].name;
    evidence.correspondences[2].candidateFragment = entry.fields[0].type;
    expect(assertStructuredSemanticReview(f.input, evidence)).toEqual(evidence);
    const invented = structuredClone(evidence);
    invented.correspondences[2].candidateFragment = 'Nontrivial.invented_projection';
    expect(() => assertStructuredSemanticReview(f.input, invented)).toThrow('formalization_review_fragment_not_found');
    const detached = structuredClone(f.observation);
    detached.snapshot!.targets[0].context.structures!.entries[0].name = 'UnexportedStructure';
    reseal(detached);
    expect(() => assertReviewStatementObservation(f.base, f.environment, detached, 'kernel-v2'))
      .toThrow('math_statement_elaboration_invalid');
    entry.fields[0].type = 'Changed field type';
    reseal(f.observation);
    expect(() => assertStructuredSemanticReview(f.input, evidence)).toThrow('formalization_review_output_identity_mismatch');
  });

  it('accepts exact raw and kernel fragments and rejects fragments absent from semantic context', () => {
    const semantic = semanticContextFixture();
    semantic.rawType = '@Eq Nat (Nat.succ Nat.zero) (Nat.succ Nat.zero)';
    semantic.localMeaningClosure = [{ name: 'Candidate.hiddenMeaning', kind: 'definition', rawType: 'Nat → Nat',
      type: ['const', ['str', null, 'Nat'], []], rawValue: 'fun hiddenValue => hiddenValue',
      value: ['lam', 'explicit', ['const', ['str', null, 'Nat'], []], ['bvar', '0']] }];
    const f = fixture({ semantic });
    reseal(f.observation);
    const evidence = review(f.input);
    evidence.correspondences[0].candidateFragment = semantic.rawType;
    evidence.correspondences[1].candidateFragment = JSON.stringify(semantic.kernelType);
    evidence.correspondences[2].candidateFragment = semantic.localMeaningClosure[0].rawValue!;
    evidence.correspondences[3].candidateFragment = JSON.stringify(semantic.localMeaningClosure[0].value);
    expect(assertStructuredSemanticReview(f.input, evidence)).toEqual(evidence);
    const invented = structuredClone(evidence);
    invented.correspondences[2].candidateFragment = 'fun inventedValue => Nat.succ inventedValue';
    expect(() => assertStructuredSemanticReview(f.input, invented)).toThrow('formalization_review_fragment_not_found');
    delete f.snapshot.targets[0].context.semantic;
    reseal(f.observation);
    evidence.inputDigest = structuredReviewDigest(f.input);
    expect(() => assertStructuredSemanticReview(f.input, evidence)).toThrow('formalization_review_fragment_not_found');
  });

  it('accepts quotes from the actual candidate, elaborated type, constants, definitions and binder types', () => {
    const f = fixture();
    f.snapshot.targets[0].context.constants.push({ name: 'identityNat', module: 'Submission', type: 'Nat → Nat',
      definition: 'fun (m : Nat) => m' });
    reseal(f.observation);
    const evidence = review(f.input);
    const fragments = ['import Mathlib', '(h : n = 0)', '∀ (n : Nat)', '{α : Sort u} → α → α → Prop',
      'fun (m : Nat) => m', '@Eq Nat n Nat.zero'];
    evidence.correspondences.forEach((item, index) => { item.candidateFragment = fragments[index]; });
    expect(assertStructuredSemanticReview(f.input, evidence)).toEqual(evidence);
    for (const field of ['originalFragment', 'candidateFragment'] as const) {
      const changed = structuredClone(evidence); changed.correspondences[0][field] = 'A fragment absent from all task data';
      expect(() => assertStructuredSemanticReview(f.input, changed)).toThrow('formalization_review_fragment_not_found');
    }
  });

  it('binds a review and its output schema to the complete review input', () => {
    const f = fixture(), approved = review(f.input), schema = structuredReviewOutputSchema(f.input);
    expect(schema.properties.caseId).toEqual({ const: f.input.caseId });
    expect(schema.properties.inputDigest).toEqual({ const: structuredReviewDigest(f.input) });
    expect(assertStructuredSemanticReview(f.input, approved)).toEqual(approved);
    expect(() => assertStructuredSemanticReview(f.input, { ...approved, caseId: 'case_' + 'b'.repeat(64) }))
      .toThrow('formalization_review_output_identity_mismatch');
    const changedInput = structuredClone(f.input); changedInput.observation.diagnostics = 'Changed observation.';
    expect(() => assertStructuredSemanticReview(changedInput, approved)).toThrow('formalization_review_output_identity_mismatch');
    const independentTranslation = translation(f.observation), recheck = structuredReviewInput(f.base, f.observation, independentTranslation);
    expect(recheck.role).toBe('recheck'); expect(recheck.translation).toEqual(independentTranslation);
    expect(recheck.baseInputDigest).toBe(formalizationEvaluationInputDigest(f.base));
    expect(structuredReviewDigest(recheck)).not.toBe(structuredReviewDigest(f.input));
  });

  it.each(structuredReviewAspects)('requires consistent evidence and verdict for %s', aspect => {
    const f = fixture(), approved = review(f.input);
    const missing = structuredClone(approved);
    missing.correspondences = missing.correspondences.filter(item => item.aspect !== aspect);
    missing.correspondences.push(structuredClone(missing.correspondences[0]));
    expect(structuredSemanticReviewSchema.safeParse(missing).success).toBe(false);

    const mismatched = structuredClone(approved);
    mismatched.correspondences.find(item => item.aspect === aspect)!.relation = 'mismatch';
    mismatched.correspondences.find(item => item.aspect === aspect)!.mismatchEvidence = mismatchEvidence;
    expect(structuredSemanticReviewSchema.safeParse(mismatched).success).toBe(false);
    mismatched.checks[aspect] = 'mismatch';
    expect(structuredSemanticReviewSchema.safeParse(mismatched).success).toBe(false);
    mismatched.verdict = 'changes_requested';
    expect(assertStructuredSemanticReview(f.input, mismatched)).toEqual(mismatched);

    const unresolved = structuredClone(approved);
    unresolved.correspondences.find(item => item.aspect === aspect)!.relation = 'unresolved';
    unresolved.checks[aspect] = 'uncertain'; unresolved.verdict = 'unknown';
    expect(assertStructuredSemanticReview(f.input, unresolved)).toEqual(unresolved);
    unresolved.verdict = 'changes_requested';
    expect(structuredSemanticReviewSchema.safeParse(unresolved).success).toBe(false);
  });

  it('does not permit negative or unknown verdicts without the corresponding evidence', () => {
    const approved = review(fixture().input);
    expect(structuredSemanticReviewSchema.safeParse({ ...approved, verdict: 'changes_requested' }).success).toBe(false);
    expect(structuredSemanticReviewSchema.safeParse({ ...approved, verdict: 'unknown' }).success).toBe(false);
    const mixed = structuredClone(approved);
    mixed.correspondences.push({ ...mixed.correspondences[0], relation: 'unresolved' },
      { ...mixed.correspondences[0], relation: 'mismatch', mismatchEvidence });
    mixed.verdict = 'changes_requested'; mixed.checks.domains = 'mismatch';
    expect(structuredSemanticReviewSchema.safeParse(mixed).success).toBe(true);
    mixed.checks.domains = 'uncertain';
    expect(structuredSemanticReviewSchema.safeParse(mixed).success).toBe(false);
  });

  it('requires both directions of an equivalent representation and routes it to recheck', () => {
    const f = fixture(), equivalent = review(f.input), item = equivalent.correspondences[2];
    item.relation = 'equivalent';
    for (const [forwardArgument, reverseArgument] of [['', 'Reverse conversion.'], ['Forward conversion.', ' '], ['', '']]) {
      Object.assign(item, { forwardArgument, reverseArgument });
      expect(structuredSemanticReviewSchema.safeParse(equivalent).success).toBe(false);
    }
    item.forwardArgument = 'The implication concludes n = 0 directly from the hypothesis.';
    item.reverseArgument = 'The same equality hypothesis supplies the displayed conclusion.';
    expect(assertStructuredSemanticReview(f.input, equivalent)).toEqual(equivalent);
    expect(structuredReviewRecheckReasons(f.input, equivalent)).toEqual(['equivalence-conversion']);
  });
});

describe('version-selected statement context instructions', () => {
  it('keeps frozen legacy instruction hashes and selects additional guidance only when opted in', () => {
    expect(mathDigest(formalizationReviewInstructions('review', false)))
      .toBe('d95647989931ef7083aa0f9ce2477bcf19e4713727a36b8c9e4d52445e8e05f4');
    expect(mathDigest(formalizationReviewInstructions('backtranslate', false)))
      .toBe('0e37c09a8560bceaa63159ad1eb91f17c63114436917dde2a7e4562e1d6385d2');
    expect(mathDigest(formalizationReviewInstructions('review', true)))
      .toBe('192911b38ab460f2cfd6b8e20de3d2d909ed447da71a4c14dcbdbe697583103d');
    expect(mathDigest(formalizationReviewInstructions('backtranslate', true)))
      .toBe('347fe405332e12f49a0241f78111f41e64c7e802eb027e2cda7352c9dad56fa2');
    for (const role of ['review', 'backtranslate'] as const) {
      expect(formalizationReviewInstructions(role, true)).toContain('kernel-v1');
      expect(formalizationReviewInstructions(role, true)).not.toBe(formalizationReviewInstructions(role, false));
      expect(formalizationReviewInstructions(role, true, false)).toBe(formalizationReviewInstructions(role, true));
      expect(formalizationReviewInstructions(role, true, true)).toContain('kernel-v2');
      expect(formalizationReviewInstructions(role, true, true)).toContain('structures');
      expect(formalizationReviewInstructions(role, true, true)).not.toBe(formalizationReviewInstructions(role, true));
    }
  });

  it('keeps context protocol optional without inserting a default into saved configurations', () => {
    const legacy = { execution: 'replay', protocol: 'v2', replayFile: '/disposable/replay.json', environment: 'auto' };
    expect(structuredReviewConfigurationSchema.parse(legacy)).toEqual(legacy);
    expect(structuredReviewConfigurationSchema.parse({ ...legacy, contextProtocol: 'kernel-v1' }))
      .toMatchObject({ contextProtocol: 'kernel-v1' });
    expect(structuredReviewConfigurationSchema.parse({ ...legacy, contextProtocol: 'kernel-v2' }))
      .toMatchObject({ contextProtocol: 'kernel-v2' });
    expect(structuredReviewConfigurationSchema.safeParse({ ...legacy, contextProtocol: 'kernel-v3' }).success).toBe(false);
  });
});

describe('independent review routing', () => {
  it('requires independent recheck for an ordinary proposed rejection', () => {
    const f = fixture(), value = review(f.input), item = value.correspondences[0];
    item.relation = 'mismatch'; item.mismatchEvidence = mismatchEvidence;
    value.checks.domains = 'mismatch'; value.verdict = 'changes_requested';
    expect(assertStructuredSemanticReview(f.input, value)).toEqual(value);
    expect(structuredReviewRecheckReasons(f.input, value)).toEqual(['proposed-rejection']);
  });

  it('locates invalid quote fields without accepting explanations, ellipses or normalized whitespace as quotes', () => {
    const f = fixture({ type: '∀ (n : Nat),\n  Eq n 0 → Eq n 0' });
    const invalid = review(f.input);
    invalid.correspondences[0].candidateFragment = 'Nat (the natural-number domain)';
    invalid.correspondences[1].originalFragment = 'if n = 0 ... then n = 0';
    invalid.correspondences[4].candidateFragment = '∀ (n : Nat), Eq n 0 → Eq n 0';
    expect(() => assertStructuredSemanticReview(f.input, invalid)).toThrow(
      'correspondences[0].candidateFragment (domains)');
    expect(() => assertStructuredSemanticReview(f.input, invalid)).toThrow(
      'correspondences[1].originalFragment (assumptions)');
    expect(() => assertStructuredSemanticReview(f.input, invalid)).toThrow(
      'correspondences[4].candidateFragment (quantifierScope)');
    const valid = review(f.input);
    valid.correspondences[4].candidateFragment = f.snapshot.targets[0].context.type;
    expect(assertStructuredSemanticReview(f.input, valid)).toEqual(valid);
  });

  it('does not request recheck for a direct complete observation without scope or instance risks', () => {
    const f = fixture(); expect(structuredReviewRecheckReasons(f.input, review(f.input))).toEqual([]);
  });

  it.each(['quantifierScope', 'instanceCoherence'] as const)('rechecks unresolved or mismatched %s evidence', aspect => {
    const f = fixture(), value = review(f.input), item = value.correspondences.find(entry => entry.aspect === aspect)!;
    item.relation = 'unresolved'; value.checks[aspect] = 'uncertain'; value.verdict = 'unknown';
    const reason = aspect === 'quantifierScope' ? 'quantifier-scope' : 'instance-coherence';
    expect(structuredReviewRecheckReasons(f.input, value)).toEqual([reason, 'unresolved-review'].sort());
    item.relation = 'mismatch'; value.checks[aspect] = 'mismatch'; value.verdict = 'changes_requested';
    item.mismatchEvidence = mismatchEvidence;
    expect(structuredReviewRecheckReasons(f.input, value)).toEqual(['proposed-rejection', reason].sort());
  });

  it.each(['∀ (b : Nat), b = b', 'Exists (fun b : Nat => b = b)'])('detects nested hypothesis scope: %s', type => {
    const f = fixture({ bindings: { binders: [{ id: 'b0', name: 'h', type, kind: 'explicit', dependencies: [] }],
      conclusion: 'True', conclusionDependencies: [] } });
    expect(structuredReviewRecheckReasons(f.input, review(f.input))).toEqual(['nested-quantifiers']);
  });

  it('rechecks shared-carrier instances and incomplete definition exports', () => {
    const f = fixture({ bindings: { binders: [
      { id: 'b0', name: 'α', type: 'Type', kind: 'implicit', dependencies: [] },
      { id: 'b1', name: 'left', type: 'TopologicalSpace α', kind: 'instanceImplicit', dependencies: ['b0'] },
      { id: 'b2', name: 'right', type: 'TopologicalSpace α', kind: 'instanceImplicit', dependencies: ['b0'] },
    ], conclusion: 'True', conclusionDependencies: [] }, omitted: ['Topology export exceeded its depth.'] });
    expect(structuredReviewRecheckReasons(f.input, review(f.input)))
      .toEqual(['incomplete-definition-export', 'multiple-structures-on-carrier']);
    f.snapshot.targets[0].context.omitted = [];
    f.snapshot.targets[0].context.bindings!.binders[2].kind = 'explicit';
    expect(structuredReviewRecheckReasons(f.input, review(f.input))).toEqual([]);
  });

  it('keeps distinct carriers separate when deciding whether instance dependencies overlap', () => {
    const f = fixture({ bindings: { binders: [
      { id: 'b0', name: 'α', type: 'Type', kind: 'implicit', dependencies: [] },
      { id: 'b1', name: 'β', type: 'Type', kind: 'implicit', dependencies: [] },
      { id: 'b2', name: 'left', type: 'TopologicalSpace α', kind: 'instanceImplicit', dependencies: ['b0'] },
      { id: 'b3', name: 'right', type: 'TopologicalSpace β', kind: 'instanceImplicit', dependencies: ['b1'] },
    ], conclusion: 'True', conclusionDependencies: [] } });
    expect(structuredReviewRecheckReasons(f.input, review(f.input))).toEqual([]);
  });
});

describe('source-reading and separation evidence', () => {
  const readings = () => [
    { mathematics: 'The first text-supported reading with its surrounding assumptions.',
      relation: 'faithful' as const, argument: 'The supplied ordering supports this reading, which matches the candidate.' },
    { mathematics: 'The second text-supported reading with its surrounding assumptions.',
      relation: 'mismatch' as const, argument: 'The alternative attachment supports a different full claim.' },
  ];

  it('keeps mixed source readings unresolved instead of approving or rejecting one selected reading', () => {
    const f = fixture(), value = review(f.input), item = value.correspondences[2];
    item.sourceReadings = readings();
    expect(structuredSemanticReviewSchema.safeParse(value).success).toBe(false);
    item.relation = 'equivalent'; item.forwardArgument = 'Forward conversion.'; item.reverseArgument = 'Reverse conversion.';
    expect(structuredSemanticReviewSchema.safeParse(value).success).toBe(false);
    item.relation = 'mismatch'; item.mismatchEvidence = mismatchEvidence;
    value.checks.conclusions = 'mismatch'; value.verdict = 'changes_requested';
    expect(structuredSemanticReviewSchema.safeParse(value).success).toBe(false);
    item.relation = 'unresolved'; item.mismatchEvidence = null;
    value.checks.conclusions = 'uncertain'; value.verdict = 'unknown';
    expect(assertStructuredSemanticReview(f.input, value)).toEqual(value);
    expect(structuredReviewRecheckReasons(f.input, value)).toEqual(['source-ambiguity', 'unresolved-review']);
  });

  it('permits rejection only when every declared reading differs and a separation argument is present', () => {
    const f = fixture(), value = review(f.input), item = value.correspondences[2];
    item.sourceReadings = readings().map(reading => ({ ...reading, relation: 'mismatch' }));
    item.relation = 'mismatch'; value.checks.conclusions = 'mismatch'; value.verdict = 'changes_requested';
    expect(structuredSemanticReviewSchema.safeParse(value).success).toBe(false);
    item.mismatchEvidence = mismatchEvidence;
    expect(assertStructuredSemanticReview(f.input, value)).toEqual(value);
    item.sourceReadings[0].relation = 'uncertain';
    expect(structuredSemanticReviewSchema.safeParse(value).success).toBe(false);
  });

  it('permits faithfulness shared by all readings but rejects a single or duplicated alternative', () => {
    const f = fixture(), value = review(f.input), item = value.correspondences[2];
    item.sourceReadings = readings().map(reading => ({ ...reading, relation: 'faithful' }));
    expect(assertStructuredSemanticReview(f.input, value)).toEqual(value);
    item.sourceReadings.pop();
    expect(structuredSemanticReviewSchema.safeParse(value).success).toBe(false);
    item.sourceReadings.push(structuredClone(item.sourceReadings[0]));
    expect(structuredSemanticReviewSchema.safeParse(value).success).toBe(false);
  });

  it('does not invent new evidence for an old output and advertises the required fields', () => {
    const f = fixture(), value = review(f.input);
    const { evidenceVersion: _version, ...legacy } = value;
    expect(structuredSemanticReviewSchema.safeParse(legacy).success).toBe(false);
    const schema = structuredReviewOutputSchema(f.input);
    expect(schema.required).toContain('evidenceVersion');
    expect(schema.properties.correspondences.items!.required).toEqual(expect.arrayContaining(['sourceReadings', 'mismatchEvidence']));
    value.correspondences[0].mismatchEvidence = mismatchEvidence;
    expect(structuredSemanticReviewSchema.safeParse(value).success).toBe(false);
  });
});

describe('review reason agreement', () => {
  function reject(value: StructuredSemanticReview, aspect: typeof structuredReviewAspects[number]) {
    const item = value.correspondences.find(item => item.aspect === aspect)!;
    value.verdict = 'changes_requested'; value.checks[aspect] = 'mismatch';
    item.relation = 'mismatch'; item.mismatchEvidence = mismatchEvidence;
    return value;
  }

  it('keeps two rejections unknown when their mismatch aspects are disjoint', () => {
    const f = fixture(), primary = reject(review(f.input), 'domains'), recheck = reject(review(f.input), 'conclusions');
    expect(resolveStructuredReviews(primary, recheck)).toEqual({ verdict: 'unknown', resolution: 'review-disagreement',
      aspectDisagreements: ['domains', 'conclusions'], sharedMismatches: [] });
  });

  it('preserves a shared mismatch while exposing an additional disputed reason', () => {
    const f = fixture(), primary = reject(review(f.input), 'conclusions'), recheck = reject(review(f.input), 'conclusions');
    reject(recheck, 'domains');
    expect(resolveStructuredReviews(primary, recheck)).toEqual({ verdict: 'changes_requested', resolution: 'shared-mismatch-aspect',
      aspectDisagreements: ['domains'], sharedMismatches: ['conclusions'] });
  });
});

describe('independent backtranslation and replay contracts', () => {
  it('covers exactly all targets, regardless of their order, and binds the observed snapshot digest', () => {
    const f = fixture(), value = translation(f.observation);
    value.targets.reverse();
    expect(assertReviewBacktranslation(f.observation, value)).toEqual(value);
    for (const changed of [
      { ...value, snapshotDigest: 'b'.repeat(64) },
      { ...value, targets: value.targets.slice(0, 1) },
      { ...value, targets: [...value.targets, { name: 'extra', mathematics: 'An unobserved proposition.' }] },
      { ...value, targets: [value.targets[0], value.targets[0]] },
    ]) expect(() => assertReviewBacktranslation(f.observation, changed)).toThrow('formalization_review_translation_identity_mismatch');
  });

  it('keeps v2 execution configuration explicit and rejects unrelated role or configuration fields', () => {
    const configuration = { execution: 'replay', protocol: 'v2', replayFile: '/tmp/offline-fixture.json', environment: 'auto' };
    expect(structuredReviewConfigurationSchema.parse(configuration)).toEqual(configuration);
    expect(structuredReviewConfigurationSchema.safeParse({ ...configuration, model: 'must-not-invoke' }).success).toBe(false);
    expect(structuredReviewConfigurationSchema.safeParse({ ...configuration, protocol: 'v1' }).success).toBe(false);
    const bundle = { schema: 'theorem-os.formalization-review-replay.v2', bundleDigest: 'a'.repeat(64),
      observations: [], roles: [{ caseId: 'case_' + 'a'.repeat(64), role: 'backtranslate', output: {} }] };
    expect(structuredReviewReplaySchema.parse(bundle)).toEqual(bundle);
    expect(structuredReviewReplaySchema.safeParse({ ...bundle, roles: [{ ...bundle.roles[0], role: 'gold-answer' }] }).success).toBe(false);
    expect(structuredReviewReplaySchema.safeParse({ ...bundle, label: 'correct' }).success).toBe(false);
  });
});
