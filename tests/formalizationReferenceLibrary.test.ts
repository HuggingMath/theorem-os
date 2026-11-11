import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertFormalizationReferenceResult, formalizationIdentityReferenceFiles, formalizationReferenceInputSchema,
  type FormalizationReferenceInput } from '../src/math/formalizationReference';
import { LIBRARY_PACK_SCHEMA, type LibraryPack } from '../src/math/libraryPacks';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { compareFormalizationReference } from '../src/solver/formalizationReference';

const base = 'Submission/Library/Fixture/Base.lean', use = 'Submission/Library/Fixture/Use.lean';
const pack: LibraryPack = { schema: LIBRARY_PACK_SCHEMA, modules: [
  { file: base, source: 'namespace TheoremOS.Fixture\ndef Carrier := Nat\ndef value (n : Carrier) : Nat := n\nend TheoremOS.Fixture\n',
    origin: { kind: 'upstream', repository: 'offline-reference-fixture', commit: 'a'.repeat(40), file: 'Base.lean' } },
  { file: use, source: 'import Submission.Library.Fixture.Base\nnamespace TheoremOS.Fixture\ndef IsZero (n : Carrier) : Prop := value n = 0\nend TheoremOS.Fixture\n',
    origin: { kind: 'upstream', repository: 'offline-reference-fixture', commit: 'a'.repeat(40), file: 'Use.lean' } },
  { file: 'Submission/Library/Fixture/Unused.lean', source: 'def TheoremOS.Fixture.unused : Nat := 42\n',
    origin: { kind: 'upstream', repository: 'offline-reference-fixture', commit: 'a'.repeat(40), file: 'Unused.lean' } },
] };
const source = 'import Submission.Library.Fixture.Use\ntheorem target (n : TheoremOS.Fixture.Carrier) :\n  TheoremOS.Fixture.IsZero n → TheoremOS.Fixture.value n = 0 := by sorry\n';
const request = (): FormalizationReferenceInput => ({ candidateSource: source.replace('Fixture.Use', 'Fixture.Base')
  .replace('TheoremOS.Fixture.IsZero n →', 'TheoremOS.Fixture.value n = 0 →'), referenceSource: source,
  environment: 'standard', purpose: 'task-fidelity-v2', pairs: [{ candidateTarget: 'target', referenceTarget: 'target' }],
  libraryPack: structuredClone(pack) });
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function directory() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'formalization-reference-library-')));
  roots.push(root); return root;
}

describe('frozen library imports in whole-statement correspondence', () => {
  it('preserves no-library requests and includes only the actual shared dependency closure', () => {
    const input = request(), files = formalizationIdentityReferenceFiles(input);
    expect(files[base]).toBe(pack.modules[0].source);
    expect(files[use]).toBe(pack.modules[1].source);
    expect(files).not.toHaveProperty(pack.modules[2].file);
    expect(files['ReferenceCandidate.lean']).toContain('import Submission.Library.Fixture.Base');
    expect(files['ReferenceGold.lean']).toContain('import Submission.Library.Fixture.Use');
    const noLibrary = { ...input }; delete noLibrary.libraryPack;
    expect(formalizationReferenceInputSchema.parse(noLibrary)).not.toHaveProperty('libraryPack');
    expect(Object.keys(formalizationIdentityReferenceFiles(noLibrary))).toHaveLength(6);
    expect(input.libraryPack).toEqual(pack);
  });

  it('rejects missing imports and trust escapes before compiling a source-contract comparison', async () => {
    const input = request();
    input.libraryPack.modules = [input.libraryPack.modules[0]];
    expect(() => formalizationIdentityReferenceFiles(input)).toThrow('reference_library_module_missing');
    const result = await compareFormalizationReference(path.join(directory(), 'comparison'), input, { env: {}, timeoutMs: 0 });
    expect(result).toMatchObject({ status: 'not-established', check: 'unsupported', files: [] });
    expect(result).toHaveProperty('libraryPack', input.libraryPack);
    expect(() => assertFormalizationReferenceResult(input, result)).not.toThrow();
    const invalid = request(); invalid.libraryPack.modules[0].source += 'axiom untrusted : False\n';
    expect(formalizationReferenceInputSchema.safeParse(invalid).success).toBe(false);
  });

  it.skipIf(process.env.THEOREMOS_TEST_REFERENCE_LEAN !== '1')('compiles the frozen library and rejects changed saved source evidence with native Lean', async () => {
    const input = request(), root = directory();
    const result = await compareFormalizationReference(path.join(root, 'comparison'), input, { env: process.env, timeoutMs: 0 });
    expect(result.check, result.reason).toBe('completed');
    expect(result).toMatchObject({ schema: 'theoremos.formalization-reference.v7', status: 'established',
      libraryPack: input.libraryPack, proofVerified: false, modelInvoked: false });
    expect(result.files.filter(file => file.file.startsWith('Submission/Library/')).map(file => file.file)).toEqual([base, use]);
    expect(() => assertFormalizationReferenceResult(input, JSON.parse(canonicalMathJson(result)))).not.toThrow();
    const changed = structuredClone(result);
    if (!('libraryPack' in changed)) throw new Error('Expected current reference evidence.');
    changed.libraryPack.modules[0].source += '\n-- changed frozen bytes\n';
    expect(() => assertFormalizationReferenceResult(input, changed)).toThrow('formalization_reference_evidence_invalid');
    const updatedRequest = { ...input, libraryPack: changed.libraryPack };
    changed.inputDigest = mathDigest(canonicalMathJson(updatedRequest));
    expect(() => assertFormalizationReferenceResult(updatedRequest, changed)).toThrow('formalization_reference_evidence_invalid');
  }, 120_000);
});
