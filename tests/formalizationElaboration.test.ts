import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { elaborateFormalization } from '../src/solver/formalizationElaboration';
import { DEFAULT_MATH_PROOF_ENVIRONMENT_CACHE_ROOT } from '../src/math/mathProofEnvironmentCache';
import { semanticContextFixture, structureContextFixture } from './helpers/formalizationFixture';

const { diagnostics, packages, prepare, dispose, readiness } = vi.hoisted(() => ({
  diagnostics: vi.fn(), packages: vi.fn(), prepare: vi.fn(), dispose: vi.fn(), readiness: vi.fn(),
}));
vi.mock('../src/math/leanDiagnostics', async original => ({
  ...await original<typeof import('../src/math/leanDiagnostics')>(), runLeanDiagnostics: diagnostics,
}));
vi.mock('../src/math/verifier', async original => ({
  ...await original<typeof import('../src/math/verifier')>(), resolveMathematicsLakePackagesCache: packages,
}));
vi.mock('../src/math/mathProofEnvironment', async original => ({
  ...await original<typeof import('../src/math/mathProofEnvironment')>(), prepareMathProofEnvironment: prepare,
}));
vi.mock('../src/math/leanToolchainReadiness', () => ({ checkResolvedLeanToolchainReadiness: readiness }));

describe('formalization declaration elaboration', () => {
  let directory: string;
  const source = '-- GENERATOR_REASONING_SECRET\nnamespace Candidate\ndef base : Nat := 0\n'
    + 'theorem identity (n : Nat) : n + base = n := by rfl\nend Candidate\n';
  const sourceDigest = 'a'.repeat(64), environmentDigest = 'b'.repeat(64), toolIdentity = 'c'.repeat(64);
  beforeEach(() => {
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'formalization-elaboration-')));
    packages.mockReset().mockReturnValue(undefined);
    dispose.mockReset().mockResolvedValue(undefined);
    prepare.mockReset().mockResolvedValue({ environmentValue: 'sealed-fixture', dispose, stats: {} });
    readiness.mockReset().mockReturnValue({ status: 'ready', diagnostics: '', fingerprint: 'ready-fixture' });
    diagnostics.mockReset().mockImplementation(async input => {
      const project = input.projectRoot;
      const context = { type: '∀ (n : Nat), Eq (HAdd.hAdd n Candidate.base) n', constants: [
        { name: 'HAdd.hAdd', module: 'Init.Prelude', type: 'α → β → γ' },
      ], omitted: [] };
      fs.mkdirSync(path.join(project, '.lake/diagnostic-artifacts'), { recursive: true });
      fs.writeFileSync(path.join(project, '.lake/formalization-context.json'), JSON.stringify([
        { id: 'Candidate.identity', context },
      ]));
      const stdout = 'warning: declaration uses sorry\n', stderr = '';
      const sourceFiles = ['Formalization.lean', 'FormalizationContext.lean'].map(file => ({
        file, digest: mathDigest(fs.readFileSync(path.join(project, file))),
      }));
      const artifactText = canonicalMathJson({ schema: 'theoremos.lean-diagnostics.v1', authority: 'advisory-lean-process',
        sourceDigest, environmentDigest, toolIdentity, sourceFiles, sourceCurrent: true, file: 'Formalization.lean',
        exitCode: 0, timedOut: false, aborted: false, captureComplete: true,
        stdout, stderr, stdoutSha256: mathDigest(stdout), stderrSha256: mathDigest(stderr) });
      const digest = mathDigest(artifactText), relative = `.lake/diagnostic-artifacts/${digest}.json`;
      fs.writeFileSync(path.join(project, relative), artifactText);
      const reference = { path: relative, digest, sourceDigest, environmentDigest, captureComplete: true };
      fs.writeFileSync(path.join(project, '.lake/lean-diagnostics-latest.json'), JSON.stringify({
        schema: 'theoremos.lean-diagnostics-latest.v1', authority: 'advisory-lean-process', sourceDigest,
        environmentDigest, toolIdentity, sourceFiles, exitCode: 0, timedOut: false, aborted: false, diagnosticArtifacts: [reference],
      }));
      return { exitCode: 0, timedOut: false, aborted: false, stdout, stderr,
        sourceDigest, environmentDigest, diagnosticArtifacts: [reference] };
    });
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
  const compile = (candidate = source, environment: 'standard' | 'mathlib' = 'standard') =>
    elaborateFormalization(path.join(directory, 'attempt'), candidate, environment, { env: {}, timeoutMs: 30_000 });

  it('compiles the host-erased source and retains imported context plus complete diagnostics', async () => {
    const result = await compile();
    expect(result.source).toContain('def base : Nat := 0');
    expect(result.source).toContain(':= by sorry');
    expect(result.source).not.toContain('by rfl');
    expect(result.source).not.toContain('GENERATOR_REASONING_SECRET');
    expect(result.sourceSha256).toBe(mathDigest(result.source));
    expect(result.environmentDigest).toBe(getLeanTaskEnvironment('standard').dependencyDigest);
    expect(result.compilation).toMatchObject({ exitCode: 0, timedOut: false,
      sourceSha256: result.sourceSha256, environmentDigest });
    expect(result.snapshot).toMatchObject({ source: result.source, sourceSha256: result.sourceSha256,
      targets: [{ name: 'Candidate.identity', context: { constants: [{ module: 'Init.Prelude' }] } }] });
    expect(result.snapshotDigest).toBe(mathDigest(canonicalMathJson(result.snapshot)));
    const evidence = result.compilation.diagnostics as { diagnosticArtifacts: { path: string; digest: string }[];
      artifactRecords: { digest: string; text: string }[] };
    const artifact = evidence.diagnosticArtifacts[0]!;
    expect(mathDigest(fs.readFileSync(path.join(directory, 'attempt', artifact.path)))).toBe(artifact.digest);
    expect(mathDigest(evidence.artifactRecords[0]!.text)).toBe(evidence.artifactRecords[0]!.digest);
    expect(JSON.parse(fs.readFileSync(path.join(directory, 'attempt/elaboration.json'), 'utf8')).snapshotDigest).toBe(result.snapshotDigest);
    expect(diagnostics).toHaveBeenCalledOnce();
    expect(prepare).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(directory, 'attempt/project/FormalizationContext.lean'), 'utf8')).not.toContain('set_option pp.explicit true');
  });

  it('requests and retains detailed actual binder scope only when explicitly enabled', async () => {
    const complete = diagnostics.getMockImplementation()!;
    const bindings = { binders: [{ id: 'b0', name: 'n', type: 'Nat', kind: 'explicit', dependencies: [] }],
      conclusion: 'Eq Nat (HAdd.hAdd n Candidate.base) n', conclusionDependencies: ['b0'] };
    diagnostics.mockImplementation(async input => {
      const result = await complete(input);
      const file = path.join(input.projectRoot, '.lake/formalization-context.json');
      const contexts = JSON.parse(fs.readFileSync(file, 'utf8'));
      contexts[0].context.bindings = bindings;
      fs.writeFileSync(file, JSON.stringify(contexts));
      return result;
    });
    const result = await elaborateFormalization(path.join(directory, 'detailed'), source, 'standard',
      { env: {}, timeoutMs: 30_000, detailedContext: true });
    const query = fs.readFileSync(path.join(directory, 'detailed/project/FormalizationContext.lean'), 'utf8');
    expect(query).toContain('set_option pp.explicit true');
    expect(query).toContain('Lean.Meta.forallTelescope type');
    expect(result.snapshot).toMatchObject({ targets: [{ name: 'Candidate.identity', context: { bindings } }] });
    expect(result.source).not.toContain('by rfl');
    expect(result.snapshotDigest).toBe(mathDigest(canonicalMathJson(result.snapshot)));
  });

  it('does not silently downgrade a requested detailed export to a legacy context', async () => {
    await expect(elaborateFormalization(path.join(directory, 'missing-detailed'), source, 'standard',
      { env: {}, timeoutMs: 30_000, detailedContext: true })).rejects.toThrow('formalization_detailed_context_missing');
    expect(fs.existsSync(path.join(directory, 'missing-detailed/elaboration.json'))).toBe(false);
  });

  it('retains a requested semantic export and binds it to the snapshot digest', async () => {
    const semantic = semanticContextFixture(), complete = diagnostics.getMockImplementation()!;
    diagnostics.mockImplementation(async input => {
      const result = await complete(input), file = path.join(input.projectRoot, '.lake/formalization-context.json');
      const contexts = JSON.parse(fs.readFileSync(file, 'utf8'));
      contexts[0].context.bindings = { binders: [], conclusion: 'True', conclusionDependencies: [] };
      contexts[0].context.semantic = semantic;
      fs.writeFileSync(file, JSON.stringify(contexts));
      return result;
    });
    const result = await elaborateFormalization(path.join(directory, 'semantic'), source, 'standard',
      { env: {}, timeoutMs: 30_000, semanticContext: true });
    const query = fs.readFileSync(path.join(directory, 'semantic/project/FormalizationContext.lean'), 'utf8');
    expect(query).toContain('collectStatementSemantic');
    expect(query).toContain('Lean.Meta.forallTelescope type');
    expect(result.snapshot).toMatchObject({ targets: [{ context: { semantic } }] });
    expect(result.snapshotDigest).toBe(mathDigest(canonicalMathJson(result.snapshot)));
  });

  it('rejects missing semantic context instead of silently accepting a legacy export', async () => {
    await expect(elaborateFormalization(path.join(directory, 'missing-semantic'), source, 'standard',
      { env: {}, timeoutMs: 30_000, semanticContext: true })).rejects.toThrow('formalization_semantic_context_missing');
    expect(fs.existsSync(path.join(directory, 'missing-semantic/elaboration.json'))).toBe(false);
  });

  it('structure export alone enables semantic and detailed context and retains direct class fields', async () => {
    const semantic = semanticContextFixture(), structures = structureContextFixture(), complete = diagnostics.getMockImplementation()!;
    diagnostics.mockImplementation(async input => {
      const result = await complete(input), file = path.join(input.projectRoot, '.lake/formalization-context.json');
      const contexts = JSON.parse(fs.readFileSync(file, 'utf8'));
      contexts[0].context.bindings = { binders: [], conclusion: 'True', conclusionDependencies: [] };
      contexts[0].context.semantic = semantic; contexts[0].context.structures = structures;
      contexts[0].context.constants.push({ name: 'OfNat', module: 'Init.Prelude', type: '(α : Type u) → Nat → Type u' });
      fs.writeFileSync(file, JSON.stringify(contexts));
      return result;
    });
    const result = await elaborateFormalization(path.join(directory, 'structures'), source, 'standard',
      { env: {}, timeoutMs: 30_000, structureContext: true });
    const query = fs.readFileSync(path.join(directory, 'structures/project/FormalizationContext.lean'), 'utf8');
    expect(query).toContain('collectStatementSemantic');
    expect(query).toContain('Lean.Meta.forallTelescope type');
    expect(query).toContain('theorem-os.lean-statement-structures.v1');
    expect(result.snapshot).toMatchObject({ targets: [{ context: { semantic, structures } }] });
    expect(result.snapshotDigest).toBe(mathDigest(canonicalMathJson(result.snapshot)));
    const saved = JSON.parse(fs.readFileSync(path.join(directory, 'structures/elaboration.json'), 'utf8'));
    expect(saved.snapshot.targets[0].context.structures).toEqual(structures);
  });

  it.each(['bindings', 'semantic', 'structures'] as const)(
    'does not accept structure-context exports missing required %s', async missing => {
      const complete = diagnostics.getMockImplementation()!;
      diagnostics.mockImplementation(async input => {
        const result = await complete(input), file = path.join(input.projectRoot, '.lake/formalization-context.json');
        const contexts = JSON.parse(fs.readFileSync(file, 'utf8'));
        contexts[0].context.bindings = { binders: [], conclusion: 'True', conclusionDependencies: [] };
        contexts[0].context.semantic = semanticContextFixture(); contexts[0].context.structures = structureContextFixture();
        contexts[0].context.constants.push({ name: 'OfNat', module: 'Init.Prelude', type: '(α : Type u) → Nat → Type u' });
        delete contexts[0].context[missing]; fs.writeFileSync(file, JSON.stringify(contexts)); return result;
      });
      await expect(elaborateFormalization(path.join(directory, 'missing-' + missing), source, 'standard',
        { env: {}, timeoutMs: 30_000, structureContext: true })).rejects.toThrow(missing === 'bindings'
          ? 'formalization_detailed_context_missing' : missing === 'semantic'
            ? 'formalization_semantic_context_missing' : 'formalization_structure_context_missing');
      expect(fs.existsSync(path.join(directory, 'missing-' + missing, 'elaboration.json'))).toBe(false);
    });

  it('refuses unavailable pinned mathlib dependencies before compiling', async () => {
    await expect(compile(source, 'mathlib')).rejects.toThrow('formalization_lake_packages_unavailable');
    expect(diagnostics).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(path.join(directory, 'attempt/failure.json'), 'utf8')).error)
      .toBe('formalization_lake_packages_unavailable');
  });

  it('passes unlimited compilation through without a finite deadline or overflowing package timer', async () => {
    const cache = path.join(directory, 'packages'); fs.mkdirSync(cache); packages.mockReturnValue(cache);
    await elaborateFormalization(path.join(directory, 'unlimited'), source, 'mathlib', { env: {}, timeoutMs: 0 });
    expect(prepare.mock.calls[0][2].deadlineAt).toBeUndefined();
    expect(prepare.mock.calls[0][2].cacheRoot).toBe(DEFAULT_MATH_PROOF_ENVIRONMENT_CACHE_ROOT);
    expect(diagnostics.mock.calls[0][0].timeoutMs).toBe(Infinity);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('honors a caller-selected private dependency cache', async () => {
    const packagesRoot = path.join(directory, 'packages'); fs.mkdirSync(packagesRoot); packages.mockReturnValue(packagesRoot);
    const proofEnvironmentCacheRoot = path.join(directory, 'private-cache');
    await elaborateFormalization(path.join(directory, 'custom-cache'), source, 'mathlib',
      { env: {}, timeoutMs: 30_000, proofEnvironmentCacheRoot });
    expect(prepare.mock.calls[0][2].cacheRoot).toBe(proofEnvironmentCacheRoot);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('rejects a negative deadline before creating an attempt', async () => {
    await expect(elaborateFormalization(path.join(directory, 'invalid'), source, 'standard', { env: {}, timeoutMs: -1 }))
      .rejects.toThrow('formalization_elaboration_timeout_invalid');
    expect(fs.existsSync(path.join(directory, 'invalid'))).toBe(false);
    expect(diagnostics).not.toHaveBeenCalled();
  });

  it('disposes the sealed dependency environment when Lean rejects the declarations', async () => {
    const cache = path.join(directory, 'packages'); fs.mkdirSync(cache);
    packages.mockReturnValue(cache);
    diagnostics.mockResolvedValue({ exitCode: 1, timedOut: false, stdout: '', stderr: 'Lean rejected definition.' });
    await expect(compile(source, 'mathlib')).rejects.toThrow('Lean rejected definition.');
    expect(prepare).toHaveBeenCalledOnce(); expect(dispose).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(directory, 'attempt/elaboration.json'))).toBe(false);
  });

  it('does not issue successful compilation evidence for incomplete diagnostic capture', async () => {
    const complete = diagnostics.getMockImplementation()!;
    diagnostics.mockImplementation(async input => {
      const result = await complete(input);
      result.diagnosticArtifacts[0].captureComplete = false;
      return result;
    });
    await expect(compile()).rejects.toThrow('formalization_compilation_evidence_incomplete');
    expect(fs.existsSync(path.join(directory, 'attempt/elaboration.json'))).toBe(false);
  });

  it('rejects a source changed while Lean runs even if its diagnostic process succeeded', async () => {
    const complete = diagnostics.getMockImplementation()!;
    diagnostics.mockImplementation(async input => {
      const result = await complete(input);
      fs.chmodSync(path.join(input.projectRoot, 'Formalization.lean'), 0o600);
      fs.appendFileSync(path.join(input.projectRoot, 'Formalization.lean'), '\n-- changed\n');
      return result;
    });
    await expect(compile()).rejects.toThrow('formalization_compilation_source_changed');
  });

  it('never executes unsupported generated commands and never reuses an existing directory', async () => {
    await expect(compile('run_cmd IO.println "unexpected"\n' + source)).rejects.toThrow();
    expect(diagnostics).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(directory, 'attempt'))).toBe(false);
    fs.mkdirSync(path.join(directory, 'attempt'));
    await expect(compile()).rejects.toThrow('fresh directory');
    expect(diagnostics).not.toHaveBeenCalled();
  });
});
