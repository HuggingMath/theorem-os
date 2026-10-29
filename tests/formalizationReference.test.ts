import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertFormalizationReferenceResult, formalizationReferenceFiles, formalizationReferenceInputSchema,
  type FormalizationReferenceInput, type FormalizationReferenceResult } from '../src/math/formalizationReference';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { compareFormalizationReference } from '../src/solver/formalizationReference';

const source = (name = 'answer', conclusion = 'a + b = b + a') =>
  `namespace Shared\ndef add (a b : Nat) : Nat := a + b\ntheorem ${name} (a b : Nat) : ${conclusion} := by this_proof_must_never_execute\nend Shared\n`;
const input = (candidate = source(), reference = source('reference', 'add a b = b + a')): FormalizationReferenceInput => ({
  candidateSource: candidate, referenceSource: reference, environment: 'standard',
  pairs: [{ candidateTarget: 'Shared.answer', referenceTarget: 'Shared.reference' }],
});

describe('bounded reference correspondence preparation', () => {
  let root: string;
  beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reference-preparation-'))); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('erases all original proofs, keeps definitions, and separates source namespaces', () => {
    const prepared = formalizationReferenceFiles(input());
    expect(prepared['ReferenceCandidate.lean']).toContain('namespace TheoremOSCandidate');
    expect(prepared['ReferenceGold.lean']).toContain('namespace TheoremOSReference');
    expect(prepared['ReferenceCandidate.lean']).toContain('def add (a b : Nat) : Nat := a + b');
    expect(prepared['ReferenceCandidate.lean']).toContain('def answer (a b : Nat) : Prop := a + b = b + a');
    const compiled = Object.values(prepared).join('\n');
    expect(compiled).not.toContain('this_proof_must_never_execute');
    expect(compiled).not.toMatch(/\b(?:sorry|sorryAx|axiom|admit)\b/u);
  });

  it('requires a complete bijection over multiple theorem targets', () => {
    const multiple = 'theorem one (n : Nat) : n + 1 = 1 + n := by sorry\n'
      + 'theorem two (n m : Nat) : n + m = m + n := by sorry\n';
    const request = { candidateSource: multiple, referenceSource: multiple, environment: 'standard' as const,
      pairs: [{ candidateTarget: 'one', referenceTarget: 'one' }, { candidateTarget: 'two', referenceTarget: 'two' }] };
    expect(formalizationReferenceFiles(request)['ReferenceComparison.lean']).toContain('candidateToReference1');
    expect(() => formalizationReferenceFiles({ ...request, pairs: request.pairs.slice(0, 1) })).toThrow('mapping_incomplete');
    expect(formalizationReferenceInputSchema.safeParse({ ...request, pairs: [request.pairs[0], request.pairs[0]] }).success).toBe(false);
  });

  it.each([
    'namespace _root_.Escape\ntheorem x : True := by trivial\nend _root_.Escape\n',
    'theorem _root_.x : True := by trivial\n',
    'end\ntheorem x : True := by trivial\n',
    'import ReferenceGold\ntheorem x : True := by trivial\n',
    'run_cmd IO.println "not executed"\ntheorem x : True := by trivial\n',
    'section\nvariable (p : Prop) (h : p)\ninclude h\ntheorem x : p := by sorry\nend\n',
  ])('returns unknown for unsupported or escaping input without compiling it', async candidateSource => {
    const request = { candidateSource, referenceSource: 'theorem x : True := by trivial\n', environment: 'standard' as const,
      pairs: [{ candidateTarget: candidateSource.startsWith('namespace _root_.Escape') ? '_root_.Escape.x' : 'x',
        referenceTarget: 'x' }] };
    const result = await compareFormalizationReference(path.join(root, 'comparison'), request, { env: {}, timeoutMs: 5000 });
    expect(result).toMatchObject({ status: 'not-established', check: 'unsupported' }); expect(result.files).toEqual([]); expect(result.evidence).toBeUndefined();
    expect(fs.existsSync(path.join(root, 'comparison/project'))).toBe(false);
    expect(() => assertFormalizationReferenceResult(request, result)).not.toThrow();
  });

  it('records cancellation as unknown and refuses reuse or symlink destinations', async () => {
    const request = input(), controller = new AbortController(); controller.abort();
    const directory = path.join(root, 'comparison');
    const result = await compareFormalizationReference(directory, request, { env: {}, timeoutMs: 5000, signal: controller.signal });
    expect(result).toMatchObject({ status: 'not-established', check: 'unavailable' }); expect(result.evidence).toBeUndefined();
    expect(() => assertFormalizationReferenceResult(request, result)).not.toThrow();
    await expect(compareFormalizationReference(directory, request, { env: {}, timeoutMs: 5000 })).rejects.toThrow('fresh directory');
    fs.symlinkSync(root, path.join(root, 'link'));
    await expect(compareFormalizationReference(path.join(root, 'link/comparison'), request, { env: {}, timeoutMs: 5000 })).rejects.toThrow('math_path_invalid');
  });

  it('rejects invalid budgets before writing an attempt', async () => {
    const directory = path.join(root, 'comparison');
    await expect(compareFormalizationReference(directory, input(), { env: {}, timeoutMs: -1 })).rejects.toThrow('timeout_invalid');
    expect(fs.existsSync(directory)).toBe(false);
  });

  it('rejects incomplete target mappings before creating an execution directory', async () => {
    const directory = path.join(root, 'bad-mapping');
    const request = input();
    await expect(compareFormalizationReference(directory, { ...request,
      pairs: [{ candidateTarget: 'missing', referenceTarget: 'Shared.reference' }] },
    { env: {}, timeoutMs: 0 })).rejects.toThrow('reference_target_mapping_incomplete');
    expect(fs.existsSync(directory)).toBe(false);
  });

  it('accepts an unlimited deadline and still records external cancellation as unknown', async () => {
    const controller = new AbortController(); controller.abort();
    const request = input();
    const result = await compareFormalizationReference(path.join(root, 'unlimited'), request,
      { env: {}, timeoutMs: 0, signal: controller.signal });
    expect(result.limits.timeoutMs).toBe(0); expect(result.status).toBe('not-established');
    expect(result.evidence).toBeUndefined();
    expect(() => assertFormalizationReferenceResult(request, result)).not.toThrow();
  });
});

// Explicit opt-in: these are native sandboxed Lean checks, not synthetic proof receipts.
describe.skipIf(process.env.THEOREMOS_TEST_REFERENCE_LEAN !== '1')('real sandbox Lean reference correspondence', () => {
  let root: string, positive: FormalizationReferenceResult;
  const request = input();
  const compare = (name: string, value: FormalizationReferenceInput, timeoutMs = 60000) =>
    compareFormalizationReference(path.join(root, name), value, { env: process.env, timeoutMs });
  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reference-native-')));
    positive = await compare('positive', request, 0);
    expect(positive.status, positive.reason).toBe('established');
  }, 65000);
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('establishes both directions with definitions and original invalid proofs erased', () => {
    expect(positive.pairs[0]).toMatchObject({ candidateToReference: { status: 'established' }, referenceToCandidate: { status: 'established' } });
    expect(positive).toMatchObject({ check: 'completed', proofVerified: false, semanticEquivalenceClaimed: false, modelInvoked: false });
    expect(positive.evidence?.artifacts).toHaveLength(3);
    expect(() => assertFormalizationReferenceResult(request, JSON.parse(canonicalMathJson(positive)))).not.toThrow();
  });

  it.each([
    ['hypothesis', 'theorem reference (a b : Nat) (extra : a > 0) : a + b = b + a := by sorry\n'],
    ['quantifier', 'theorem reference : ∃ a b : Nat, a + b = b + a := by sorry\n'],
    ['definition', 'def add (a b : Nat) : Nat := a + b + 1\ntheorem reference (a b : Nat) : add a b = b + a := by sorry\n'],
  ])('keeps changed %s unknown instead of declaring inequivalence', async (name, referenceSource) => {
    const result = await compare(name, { ...request, referenceSource, pairs: [{ candidateTarget: 'Shared.answer', referenceTarget: 'reference' }] });
    expect(result.status).toBe('not-established'); expect(result.evidence).toBeDefined();
    expect(result.pairs[0].candidateToReference.reason).toBe('not-definitionally-equal');
  }, 65000);

  it.each([
    ['assumption', '(p : Prop) (h : p) : p'],
    ['reflexivity', '(n : Nat) : n = n'],
    ['true', ': True'],
    ['vacuity', '(p : Prop) (impossible : False) : p'],
  ])('refuses baseline %s even for identical types', async (name, header) => {
    const same = `theorem target ${header} := by sorry\n`;
    const result = await compare(name, { candidateSource: same, referenceSource: same, environment: 'standard',
      pairs: [{ candidateTarget: 'target', referenceTarget: 'target' }] });
    expect(result.status).toBe('not-established'); expect(result.evidence).toBeDefined();
    expect(result.pairs[0].candidateToReference.reason).toBe('baseline-trivial');
  }, 65000);

  it('does not compare unrelated provable statements using general proof search', async () => {
    const result = await compare('unrelated', { candidateSource: 'theorem target (n m : Nat) : n + m = m + n := by sorry\n',
      referenceSource: 'theorem target (n m : Nat) : n * m = m * n := by sorry\n', environment: 'standard',
      pairs: [{ candidateTarget: 'target', referenceTarget: 'target' }] });
    expect(result.status).toBe('not-established');
    expect(result.pairs[0].candidateToReference.reason).toBe('not-definitionally-equal');
  }, 65000);

  it('checks every mapped target in a multi-target source independently', async () => {
    const candidate = 'def add (a b : Nat) : Nat := a + b\n'
      + 'theorem sum (a b : Nat) : add a b = b + a := by sorry\n'
      + 'theorem product (a b : Nat) : a * b = b * a := by sorry\n';
    const reference = candidate.replace('theorem sum', 'theorem sum_ref').replace('theorem product', 'theorem product_ref');
    const result = await compare('multiple', { candidateSource: candidate, referenceSource: reference, environment: 'standard',
      pairs: [{ candidateTarget: 'sum', referenceTarget: 'sum_ref' }, { candidateTarget: 'product', referenceTarget: 'product_ref' }] });
    expect(result.status, result.reason).toBe('established'); expect(result.pairs).toHaveLength(2);
    expect(result.pairs.every(pair => pair.candidateToReference.status === 'established' && pair.referenceToCandidate.status === 'established')).toBe(true);
  }, 65000);

  it.each([
    ['renamed', 'universe u\ntheorem target (α : Type u) (f g : α → α) : f ∘ g = g ∘ f := by sorry\n',
      'universe v\ntheorem target (β : Type v) (h k : β → β) : h ∘ k = k ∘ h := by sorry\n'],
    ['declaration-order', 'universe u v\ntheorem target (α : Type u) (β : Type v) (f g : α → β) : f = g := by sorry\n',
      'universe b a\ntheorem target (α : Type a) (β : Type b) (f g : α → β) : f = g := by sorry\n'],
  ])('checks polymorphic %s correspondence without specializing universes', async (name, candidateSource, referenceSource) => {
    const result = await compare('polymorphic-' + name, { candidateSource, referenceSource, environment: 'standard',
      pairs: [{ candidateTarget: 'target', referenceTarget: 'target' }] });
    expect(result.status, result.reason).toBe('established'); expect(result.evidence).toBeDefined();
    expect(() => assertFormalizationReferenceResult({ candidateSource, referenceSource, environment: 'standard',
      pairs: [{ candidateTarget: 'target', referenceTarget: 'target' }] }, result)).not.toThrow();
  }, 65000);

  it.each([
    ['collapsed', 'universe u\ntheorem target (α β : Type u) (f g : α → β) : f = g := by sorry\n'],
    ['specialized', 'theorem target (α β : Type) (f g : α → β) : f = g := by sorry\n'],
    ['changed-hypothesis', 'universe u v\ntheorem target (α : Type u) (β : Type v) (f g : α → β) (h : Nonempty α) : f = g := by sorry\n'],
  ])('keeps %s polymorphic targets unknown', async (name, referenceSource) => {
    const candidateSource = 'universe u v\ntheorem target (α : Type u) (β : Type v) (f g : α → β) : f = g := by sorry\n';
    const result = await compare('polymorphic-negative-' + name, { candidateSource, referenceSource, environment: 'standard',
      pairs: [{ candidateTarget: 'target', referenceTarget: 'target' }] });
    expect(result.status).toBe('not-established'); expect(result.evidence).toBeDefined();
    expect(result.pairs[0].candidateToReference.reason).toBe('not-definitionally-equal');
  }, 65000);

  it('permutes independent type and instance binders bijectively', async () => {
    const candidateSource = 'universe u v\ntheorem target (α : Type u) (β : Type v) [Inhabited α] [Inhabited β] (f g : α → β) : f = g := by sorry\n';
    const referenceSource = 'universe a b\ntheorem target {α : Type a} [Inhabited α] {β : Type b} [Inhabited β] (f g : α → β) : f = g := by sorry\n';
    const result = await compare('binder-permutation', { candidateSource, referenceSource, environment: 'standard',
      pairs: [{ candidateTarget: 'target', referenceTarget: 'target' }] });
    expect(result.status, result.reason).toBe('established');
    expect(result.pairs[0].candidateToReference.reason).toBe('bijective-binder-permutation-with-opposite-assumption');
    expect(JSON.parse(result.evidence!.reportText).pairs[0]).toMatchObject({ definitionallyEqual: false, binderPermutation: true });
  }, 65000);

  it.each([
    ['extra-unused-binder', 'theorem target (n m unused : Nat) : n + m = m + n := by sorry\n'],
    ['repeated-binder', 'theorem target (n m : Nat) : n + n = n + n := by sorry\n'],
    ['changed-conclusion', 'theorem target (m n : Nat) : n * m = m * n := by sorry\n'],
  ])('does not accept %s as a binder permutation', async (name, referenceSource) => {
    const candidateSource = 'theorem target (n m : Nat) : n + m = m + n := by sorry\n';
    const result = await compare('binder-negative-' + name, { candidateSource, referenceSource, environment: 'standard',
      pairs: [{ candidateTarget: 'target', referenceTarget: 'target' }] });
    expect(result.status).toBe('not-established'); expect(result.evidence).toBeDefined();
  }, 65000);

  it('records actual budget exhaustion without claiming wrong semantics', async () => {
    const result = await compare('timeout', request, 1);
    expect(result).toMatchObject({ status: 'not-established', check: 'unavailable' }); expect(result.evidence).toBeUndefined();
    expect(result.pairs[0].candidateToReference.reason).toContain('timeout');
  }, 65000);

  it.each(['input', 'source', 'configuration', 'digest', 'report', 'artifact', 'duplicate', 'check', 'method'])('rejects tampered %s evidence', mutation => {
    const modified = JSON.parse(canonicalMathJson(positive));
    if (mutation === 'check') modified.check = 'unavailable';
    else if (mutation === 'method') modified.method = 'bounded-binder-correspondence-v2';
    else if (mutation === 'input') modified.referenceSourceSha256 = 'a'.repeat(64);
    else if (mutation === 'source') modified.files[3].text += '\n-- changed\n';
    else if (mutation === 'configuration') modified.evidence.latest.configuration[0].digest = 'a'.repeat(64);
    else if (mutation === 'digest') modified.evidence.sourceDigest = modified.evidence.latest.sourceDigest = 'a'.repeat(64);
    else if (mutation === 'report') {
      const report = JSON.parse(modified.evidence.reportText); report.pairs[0].candidateType = 'False';
      modified.evidence.reportText = JSON.stringify(report); modified.evidence.reportSha256 = mathDigest(modified.evidence.reportText);
    } else if (mutation === 'artifact') modified.evidence.artifacts[0].text += '\n';
    else modified.evidence.artifacts[0] = modified.evidence.artifacts[1];
    expect(() => assertFormalizationReferenceResult(request, modified)).toThrow();
  });
});
