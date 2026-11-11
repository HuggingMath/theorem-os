import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertFormalizationCompiledCandidate, formalizationCompiledCandidate, formalizationDigest, formalizationInputDigest,
  prepareFormalization, readFormalizationRequest } from '../src/math/formalization';
import { assertFormalizationLibraryPack, prepareFormalizationLibrary, selectFormalizationLibraryPack } from '../src/math/formalizationLibrary';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { LIBRARY_PACK_SCHEMA } from '../src/math/libraryPacks';
import { writeLibraryCatalog } from '../src/solver/libraryCatalog';
import { syntheticElaboration } from './helpers/formalizationFixture';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'formalization-library-environment-'))); roots.push(root);
  const modules = [
    { file: 'Submission/Library/Fixture/Base.lean', source: 'namespace Fixture\ndef value : Nat := 1\nend Fixture\n' },
    { file: 'Submission/Library/Fixture/Laws.lean', source: 'import Submission.Library.Fixture.Base\n' +
      'namespace Fixture\ntheorem value_eq_one : value = 1 := rfl\nend Fixture\n' },
    { file: 'Submission/Library/Fixture/Other.lean', source: 'namespace Other\ndef value : Nat := 2\nend Other\n' },
  ].map(module => ({ ...module, origin: { kind: 'upstream' as const, repository: 'test-library', commit: 'a'.repeat(40), file: module.file } }));
  const catalog = writeLibraryCatalog(path.join(root, 'release'), { id: 'test/formalization', revision: 'v1', environment: 'mathlib',
    packs: [{ schema: LIBRARY_PACK_SCHEMA, modules }] });
  const access = { file: catalog.file, digest: catalog.digest }, library = prepareFormalizationLibrary(access, 'mathlib');
  return { root, access, library, modules };
}
const source = 'import Submission.Library.Fixture.Laws\ntheorem answer : Fixture.value = 1 := by sorry\n';

describe('formalization and proof share one frozen library release', () => {
  it('freezes the complete release alongside the unchanged Lean and Mathlib identity', () => {
    const f = fixture(), build = path.join(f.root, 'build.json'); fs.writeFileSync(build, '{}');
    const request = prepareFormalization(path.join(f.root, 'run'), { problemId: 'library_identity', statement: 'Prove the identity.',
      environment: 'mathlib', execution: 'replay', model: 'preset', effort: 'high', profile: '/no-model', executable: '/no-model',
      reviewMode: 'direct', buildManifestRef: build, libraryCatalog: f.access, maxRounds: 0, maxRunSeconds: 0,
      maxTurnSeconds: 0, maxCompileSeconds: 0, maxTotalTokens: 0 });
    expect(request.library).toEqual(f.library);
    expect(request.library.modules).toHaveLength(3);
    expect(request.environmentDigest).toBe(getLeanTaskEnvironment('mathlib').dependencyDigest);
    expect(readFormalizationRequest(path.join(f.root, 'run'))).toEqual(request);
    expect(() => prepareFormalizationLibrary(f.access, 'standard')).toThrow('formalization_library_environment_changed');
  });

  it('installs only explicit imports and their dependency closure, including reviewer-only imports', () => {
    const f = fixture(), pack = selectFormalizationLibraryPack(f.library, source)!;
    expect(pack.modules.map(module => module.file)).toEqual(f.modules.slice(0, 2).map(module => module.file));
    expect(selectFormalizationLibraryPack(f.library, 'theorem answer : True := by sorry\n')).toBeUndefined();
    const union = selectFormalizationLibraryPack(f.library, [source, 'import Submission.Library.Fixture.Other\ntheorem reference : True := by sorry\n'])!;
    expect(union.modules).toHaveLength(3);
    expect(() => selectFormalizationLibraryPack(f.library, 'import Submission.Library.Missing\ntheorem x : True := by sorry\n'))
      .toThrow('math_library_catalog_module_missing');
  });

  it('rejects changed and missing compiled sources against the frozen request', () => {
    const f = fixture(), pack = selectFormalizationLibraryPack(f.library, source)!;
    const changed = structuredClone(pack); changed.modules[0].source += '\n-- changed\n';
    expect(() => assertFormalizationLibraryPack(f.library, source, changed)).toThrow('formalization_library_source_changed');
    expect(() => assertFormalizationLibraryPack(f.library, source, undefined)).toThrow('formalization_library_pack_missing');
    expect(() => assertFormalizationLibraryPack(undefined, source, pack)).toThrow('formalization_library_not_configured');
    const wrong = structuredClone(f.library); wrong.modules[0].digest = 'b'.repeat(64);
    expect(() => selectFormalizationLibraryPack(wrong, source)).toThrow('formalization_library_changed');
  });

  it('validates saved compilation sources without consulting a newer or unavailable release', () => {
    const f = fixture(), pack = selectFormalizationLibraryPack(f.library, source)!;
    fs.renameSync(path.join(f.root, 'release'), path.join(f.root, 'old-release'));
    expect(assertFormalizationLibraryPack(f.library, source, pack)).toEqual(pack);
    expect(() => selectFormalizationLibraryPack(f.library, source)).toThrow();
  });

  it('binds compiled handoff evidence to every library source and rejects missing or extra compilation inputs', () => {
    const f = fixture(), build = path.join(f.root, 'build.json'); fs.writeFileSync(build, '{}');
    const request = prepareFormalization(path.join(f.root, 'run'), { problemId: 'compiled_library_identity', statement: 'Prove the identity.',
      environment: 'mathlib', execution: 'replay', model: 'preset', effort: 'high', profile: '/no-model', executable: '/no-model',
      reviewMode: 'direct', buildManifestRef: build, libraryCatalog: f.access, maxRounds: 0, maxRunSeconds: 0,
      maxTurnSeconds: 0, maxCompileSeconds: 0, maxTotalTokens: 0 });
    const candidate = { source, coverage: [{ originalText: request.statement, targetNames: ['answer'], explanation: 'Complete identity.' }],
      assumptions: [], assumptionsExplanation: 'No hypotheses.', definitionsExplanation: 'Frozen library value.' };
    const libraryPack = selectFormalizationLibraryPack(f.library, source)!;
    const elaborated = syntheticElaboration(source, 'mathlib', { libraryPack, detailedContext: true,
      semanticContext: true, structureContext: true, boundedLibraryContext: true });
    const compiled = formalizationCompiledCandidate({ request, requestDigest: formalizationDigest(request), candidate,
      inputDigest: formalizationInputDigest(request, candidate), ...elaborated, round: 1 });
    expect(() => assertFormalizationCompiledCandidate(compiled)).not.toThrow();
    const missing = structuredClone(compiled); delete missing.compilation.diagnostics.libraryPack;
    expect(() => assertFormalizationCompiledCandidate(missing)).toThrow('formalization_library_pack_missing');
    for (const extra of [true, false]) {
      const changed = structuredClone(compiled), latest = changed.compilation.diagnostics.latest as typeof elaborated.compilation.diagnostics.latest;
      if (extra) latest.sourceFiles.push({ file: 'Unfrozen.lean', digest: 'c'.repeat(64) });
      else latest.sourceFiles.pop();
      expect(() => assertFormalizationCompiledCandidate(changed)).toThrow('formalization_compilation_evidence_invalid');
    }
  });
});
