import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkLeanType, leanTypeDiagnosticCommands, leanTypeDiagnosticProjection } from '../src/math/leanTypeDiagnostics';
import { mathLocalModuleBuildOrder } from '../src/math/mathConstructionSources';
import { runLeanProcess } from '../src/math/mathProcess';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { TaskTypePreflightCache } from '../src/solver/taskTypePreflight';
import type { SolverProblem } from '../src/solver/problem';
import type { CooperativeTask } from '../src/solver/tasks';
import { newestLeanBinary } from './helpers/lean';

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../src/math/verifier', () => ({ runMathematicsSandboxedCommand: run,
  formalVerificationToolIdentity: () => 'a'.repeat(64) }));
const lean = newestLeanBinary();

describe('type query payloads', () => {
  it('passes the requested type only as a string to Lean term parsing', () => {
    const payload = 'Nat\nrun_cmd IO.FS.writeFile "marker" "bad"';
    const commands = leanTypeDiagnosticCommands(payload, '.lake/result.json');
    expect(commands).toContain(`(Lean.Name.mkSimple "term") ${JSON.stringify(payload)}`);
    expect(commands.split('\n').some(line => line.startsWith('run_cmd IO.FS'))).toBe(false);
  });
});

describe('type query projection identity', () => {
  const source = 'namespace Geometry\nopen Nat\ndef value : Nat := 0\ntheorem original : True := by sorry\nend Geometry\n';
  const input = () => ({ files: [{ file: 'Dependency.lean', source: 'theorem dependency : True := by sorry\n' },
    { file: 'Submission.lean', source }, { file: 'lakefile.lean', source: 'theorem configuration : True := by sorry\n' }],
    modules: [{ file: 'Dependency.lean', sourceRoot: '.', module: 'Dependency' },
      { file: 'Submission.lean', sourceRoot: '.', module: 'Submission' }],
    file: 'Submission.lean', context: 'Geometry.original', type: 'True' });

  it('uses identical bytes and queries after erasing different local proof bodies', () => {
    const original = input(), changed = structuredClone(original);
    for (const file of changed.files) if (file.file !== 'lakefile.lean')
      file.source = file.source.replace('by sorry', 'by\n  -- proof-only comment\n  trivial');
    const first = leanTypeDiagnosticProjection(original), next = leanTypeDiagnosticProjection(changed);
    expect(next.digest).toBe(first.digest); expect(next.files).toEqual(first.files); expect(next.commands).toBe(first.commands);
    expect(original.files[0].source).toContain('by sorry'); expect(changed.files[0].source).toContain('trivial');
  });

  it.each(['definition', 'theorem-type', 'external-comment', 'configuration', 'scope', 'query-type', 'module-order', 'module-mapping'] as const)
  ('keeps %s differences in the exact projection identity', change => {
    const original = input(), changed = structuredClone(original);
    if (change === 'definition') changed.files[1].source = source.replace('value : Nat := 0', 'value : Nat := 1');
    if (change === 'theorem-type') changed.files[1].source = source.replace('original : True', 'original : False');
    if (change === 'external-comment') changed.files[1].source = '-- line-sensitive input\n' + source;
    if (change === 'configuration') changed.files[2].source = changed.files[2].source.replace('by sorry', 'by trivial');
    if (change === 'scope') changed.files[1].source = source.replace('open Nat', 'open Int');
    if (change === 'query-type') changed.type = 'False';
    if (change === 'module-order') changed.modules.reverse();
    if (change === 'module-mapping') changed.modules[1].sourceRoot = 'src';
    expect(leanTypeDiagnosticProjection(changed).digest).not.toBe(leanTypeDiagnosticProjection(original).digest);
  });
});

describe.skipIf(!lean)('local Lean closed-type preflight', () => {
  let root: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lean-type-preflight-')));
    fs.writeFileSync(path.join(root, 'Dependency.lean'), 'namespace Terms\nstructure Box where\n  value : Nat\nend Terms\n');
    fs.writeFileSync(path.join(root, 'Submission.lean'), 'import Dependency\nnamespace Geometry\nopen Terms\n' +
      'theorem original : True := by\n  exact nonexistent_proof\nend Geometry\n');
    run.mockReset().mockImplementation(input => {
      const code = input.args.at(-1);
      return runLeanProcess('/bin/sh', ['-ceu', code], { cwd: input.checkoutRoot, timeoutMs: input.timeoutMs,
        signal: input.signal, outputLimit: input.outputLimit, outputCapture: input.outputCapture,
        env: { ...process.env, PATH: `${path.dirname(lean!)}:${process.env.PATH}`,
          LEAN_PATH: path.join(input.checkoutRoot, '.lake', 'build', 'lib', 'lean') } });
    });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const check = (type: string) => checkLeanType({ projectRoot: root, file: 'Submission.lean', context: 'Geometry.original', type, timeoutMs: 30_000 });

  it('prepares missing local dependencies, restores open scopes, and preserves active source and proof artifacts', async () => {
    const before = fs.readFileSync(path.join(root, 'Submission.lean'));
    const modules = mathLocalModuleBuildOrder(root, 'Submission.lean');
    const expected = leanTypeDiagnosticProjection({ modules,
      files: modules.map(module => ({ file: module.file, source: fs.readFileSync(path.join(root, module.file), 'utf8') })),
      file: 'Submission.lean', context: 'Geometry.original', type: 'Box \u2192 Nat' });
    const result = await check('Box \u2192 Nat');
    expect(result.status, result.stdout + result.stderr).toBe('elaborated');
    expect(result).toMatchObject({ status: 'elaborated', exitCode: 0, type: 'Terms.Box \u2192 Nat', proofAcceptance: 'not-assessed' });
    expect(fs.readFileSync(path.join(root, 'Submission.lean'))).toEqual(before);
    expect(fs.existsSync(path.join(root, '.lake', 'build', 'lib', 'lean', 'Submission.olean'))).toBe(false);
    const text = fs.readFileSync(path.join(root, result.artifact.path), 'utf8');
    expect(mathDigest(text)).toBe(result.artifact.digest);
    const artifact = JSON.parse(text);
    expect(artifact).toMatchObject({ authority: 'advisory-type-elaboration', proofAcceptance: 'not-assessed',
      sourceDigest: result.sourceSnapshotDigest, projectionDigest: expected.digest, queryDigest: mathDigest(expected.commands) });
    expect(result.projectionDigest).toBe(expected.digest);
    const clone = path.join(root, path.dirname(result.artifact.path), 'project');
    for (const file of expected.files) expect(fs.readFileSync(path.join(clone, file.file), 'utf8')).toBe(file.source);
    expect(fs.readFileSync(path.join(clone, expected.query), 'utf8')).toBe(expected.commands);
    expect(artifact.files.find(file => file.file === 'Submission.lean').digest).toBe(mathDigest(before));
    expect(result.diagnosticArtifacts.length).toBeGreaterThan(0);
    expect(result.diagnosticArtifacts.every(reference => fs.existsSync(path.join(root, reference.path)))).toBe(true);
  });

  it('reuses a real successful query after proof-only edits without starting another sandbox command', async () => {
    const task: CooperativeTask = { id: 'helper', kind: 'lemma', objective: 'Prove helper', dependsOn: [], revision: 0,
      theoremName: 'Geometry.helper', proofPath: 'Submission.lean', type: 'Box -> Nat' };
    const problem = { targets: [{ theoremName: 'Geometry.original', proofPath: 'Submission.lean' }] } as SolverProblem;
    const cache = new TaskTypePreflightCache(), input = { task, problem, dependencies: [], projectRoot: root,
      // This standalone Lean fixture has no packages; do not import a host's mutable cache settings.
      environmentDigest: 'test-environment', env: { DEEPSCIENTIST_MATH_ENV_FILE: path.join(root, 'fixture.env') }, timeoutMs: Infinity };
    const first = await cache.check(input), commands = run.mock.calls.length;
    expect(first.result.status, first.result.reason).toBe('elaborated'); expect(commands).toBeGreaterThan(0);
    const file = path.join(root, 'Submission.lean');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('exact nonexistent_proof', '-- proof-only edit\n  exact True.intro'));
    const next = await cache.check(input);
    expect(run).toHaveBeenCalledTimes(commands); expect(first.current()).toBe(false); expect(next.current()).toBe(true);
    expect(next.result).toMatchObject({ status: 'elaborated', type: 'Terms.Box \u2192 Nat', artifact: first.result.artifact,
      proofAcceptance: 'not-assessed', projectionReuse: { originInputDigest: first.result.inputDigest } });
    expect(next.result.inputDigest).not.toBe(first.result.inputDigest);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, first.result.artifact!.path), 'utf8'));
    expect(next.result.projectionReuse).toMatchObject({ originSourceDigest: manifest.sourceDigest, projectionDigest: manifest.projectionDigest });
    expect(next.result.projectionReuse!.sourceDigest).not.toBe(manifest.sourceDigest);
  });

  it('defers a valid same-file private type instead of rejecting it from an imported query', async () => {
    fs.writeFileSync(path.join(root, 'Submission.lean'), 'namespace Geometry\nsection\n' +
      'private def Hidden := Nat\nend\n' +
      'theorem original : ∀ n : Hidden, n = n := fun n => Eq.refl n\nend Geometry\n');
    const actual = await runLeanProcess(lean!, ['--json', 'Submission.lean'], {
      cwd: root, env: process.env, timeoutMs: 30_000,
    });
    expect(actual.exitCode, actual.stdout + actual.stderr).toBe(0);
    const task: CooperativeTask = { id: 'helper', kind: 'lemma', objective: 'Prove helper', dependsOn: [], revision: 0,
      theoremName: 'Geometry.helper', proofPath: 'Submission.lean', type: '∀ n : Hidden, n = n' };
    const result = await new TaskTypePreflightCache().check({ task,
      problem: { targets: [{ theoremName: 'Geometry.original', proofPath: 'Submission.lean' }] } as SolverProblem,
      projectRoot: root, dependencies: [], environmentDigest: 'test-environment',
      env: { DEEPSCIENTIST_MATH_ENV_FILE: path.join(root, 'fixture.env') }, timeoutMs: 30_000 });
    expect(result.result).toMatchObject({ status: 'deferred', reason: expect.stringContaining('private-context-not-reproducible') });
    expect(run).toHaveBeenCalled();
  });

  it.each([
    ['namespace Types\nprivate def Hidden := Nat\ndef Public := Nat\nend Types\nopen Types hiding Public',
      '∀ n : Hidden, n = n', 'fun n => Eq.refl n'],
    ['private inductive Hidden where\n  | mk : Hidden', 'Hidden.mk = Hidden.mk', 'rfl'],
    ['private structure Hidden where\n  value : Nat', 'Hidden.mk 0 = Hidden.mk 0', 'rfl'],
    ['private structure Hidden where\n  value : Nat', 'Hidden.value (Hidden.mk 0) = 0', 'rfl'],
  ])('defers valid private lookup context for %s', async (declaration, type, proof) => {
    fs.writeFileSync(path.join(root, 'Submission.lean'), `namespace Geometry\n${declaration}\n` +
      `theorem original : ${type} := ${proof}\nend Geometry\n`);
    const actual = await runLeanProcess(lean!, ['--json', 'Submission.lean'], {
      cwd: root, env: process.env, timeoutMs: 30_000,
    });
    expect(actual.exitCode, actual.stdout + actual.stderr).toBe(0);
    const task: CooperativeTask = { id: 'helper', kind: 'lemma', objective: 'Prove helper', dependsOn: [], revision: 0,
      theoremName: 'Geometry.helper', proofPath: 'Submission.lean', type };
    const result = await new TaskTypePreflightCache().check({ task,
      problem: { targets: [{ theoremName: 'Geometry.original', proofPath: 'Submission.lean' }] } as SolverProblem,
      projectRoot: root, dependencies: [], environmentDigest: 'test-environment',
      env: { DEEPSCIENTIST_MATH_ENV_FILE: path.join(root, 'fixture.env') }, timeoutMs: 30_000 });
    expect(result.result).toMatchObject({ status: 'deferred', reason: expect.stringContaining('private-context-not-reproducible') });
  });

  it('keeps a missing type invalid when an open hides a public member matching an unrelated namespace', async () => {
    fs.writeFileSync(path.join(root, 'Submission.lean'), 'namespace Geometry\nnamespace Types\n' +
      'def Other := Nat\nend Types\nnamespace Other\nprivate def Hidden := Nat\nend Other\n' +
      'open Types hiding Other\ntheorem original : True := True.intro\nend Geometry\n');
    const actual = await runLeanProcess(lean!, ['--json', 'Submission.lean'], {
      cwd: root, env: process.env, timeoutMs: 30_000,
    });
    expect(actual.exitCode, actual.stdout + actual.stderr).toBe(0);
    const task: CooperativeTask = { id: 'helper', kind: 'lemma', objective: 'Prove helper', dependsOn: [], revision: 0,
      theoremName: 'Geometry.helper', proofPath: 'Submission.lean', type: '∀ n : Hidden, n = n' };
    const result = await new TaskTypePreflightCache().check({ task,
      problem: { targets: [{ theoremName: 'Geometry.original', proofPath: 'Submission.lean' }] } as SolverProblem,
      projectRoot: root, dependencies: [], environmentDigest: 'test-environment',
      env: { DEEPSCIENTIST_MATH_ENV_FILE: path.join(root, 'fixture.env') }, timeoutMs: 30_000 });
    expect(result.result).toMatchObject({ status: 'invalid', reason: expect.stringContaining('Unknown identifier `Hidden`') });
  });

  it.each(['invocation', 'signal'] as const)('does not export a completed type after %s cancellation', async mode => {
    const previous = run.getMockImplementation()!, controller = new AbortController();
    run.mockImplementation(async input => {
      const result = await previous(input);
      if (input.args.at(-1).includes('TypeDiagnostic.lean') && result.exitCode === 0) {
        if (mode === 'signal') controller.abort();
        return { ...result, aborted: mode === 'invocation' };
      }
      return result;
    });
    const result = await checkLeanType({ projectRoot: root, file: 'Submission.lean', context: 'Geometry.original',
      type: 'True', expression: 'True.intro', signal: controller.signal, timeoutMs: 30_000 });
    expect(result).toMatchObject({ status: 'failed', exitCode: 0, aborted: true, proofAcceptance: 'not-assessed' });
    expect(result.type).toBeUndefined();
    expect(result.constants).toBeUndefined();
    const manifest = JSON.parse(fs.readFileSync(path.join(root, result.artifact.path), 'utf8'));
    expect(manifest.elaboratedType).toBeUndefined();
    expect(manifest.diagnostics.aborted).toBe(true);
  });

  it('does not seed exact or projection caching from a cancelled Lean success export', async () => {
    const previous = run.getMockImplementation()!;
    let cancelled = false;
    run.mockImplementation(async input => {
      const result = await previous(input);
      if (!cancelled && input.args.at(-1).includes('TypeDiagnostic.lean') && result.exitCode === 0) {
        cancelled = true;
        return { ...result, aborted: true };
      }
      return result;
    });
    const task: CooperativeTask = { id: 'helper', kind: 'lemma', objective: 'Prove helper', dependsOn: [], revision: 0,
      theoremName: 'Geometry.helper', proofPath: 'Submission.lean', type: 'True' };
    const cache = new TaskTypePreflightCache(), input = { task,
      problem: { targets: [{ theoremName: 'Geometry.original', proofPath: 'Submission.lean' }] } as SolverProblem,
      projectRoot: root, dependencies: [], environmentDigest: 'test-environment',
      env: { DEEPSCIENTIST_MATH_ENV_FILE: path.join(root, 'fixture.env') }, timeoutMs: 30_000 };
    const first = await cache.check(input), commands = run.mock.calls.length;
    expect(first.result.status).toBe('unavailable');
    const retry = await cache.check(input);
    expect(retry.result.status).toBe('elaborated');
    expect(retry.result.projectionReuse).toBeUndefined();
    expect(run.mock.calls.length).toBeGreaterThan(commands);
    expect(retry.result.artifact).not.toEqual(first.result.artifact);
    const successfulCommands = run.mock.calls.length;
    fs.writeFileSync(path.join(root, 'Submission.lean'), fs.readFileSync(path.join(root, 'Submission.lean'), 'utf8')
      .replace('exact nonexistent_proof', 'exact True.intro'));
    const projected = await cache.check(input);
    expect(run).toHaveBeenCalledTimes(successfulCommands);
    expect(projected.result.artifact).toEqual(retry.result.artifact);
    expect(projected.result.projectionReuse?.originInputDigest).toBe(retry.result.inputDigest);
  });

  it('accepts explicit Nat binders before proof work', async () => {
    const explicit = await check('\u2200 (a : Nat \u2192 Nat) (n : Nat), a (n + 1) = a (n + 1)');
    expect(explicit.status, explicit.stdout + explicit.stderr).toBe('elaborated');
  });

  it.each(['(U : Nat) : U = U', '(U : Nat) (h : U = U) : U = U'])
  ('rejects a declaration-header fragment when the term parser expects end of input: %s', async type => {
    const task: CooperativeTask = { id: 'helper', kind: 'lemma', objective: 'Prove helper', dependsOn: [], revision: 0,
      theoremName: 'Geometry.helper', proofPath: 'Submission.lean', type };
    const input = { task, problem: { targets: [{ theoremName: 'Geometry.original', proofPath: 'Submission.lean' }] } as SolverProblem,
      projectRoot: root, dependencies: [], environmentDigest: 'test-environment',
      env: { DEEPSCIENTIST_MATH_ENV_FILE: path.join(root, 'fixture.env') }, timeoutMs: 30_000 };
    const cache = new TaskTypePreflightCache(), first = await cache.check(input);
    expect(first.result).toMatchObject({ status: 'invalid', reason: expect.stringContaining('expected end of input'),
      proofAcceptance: 'not-assessed' });
    expect(task.type).toBe(type);
    const commands = run.mock.calls.length;
    expect((await cache.check(input)).result).toEqual(first.result);
    expect(run).toHaveBeenCalledTimes(commands);
  });

  it('reports a mismatched index type before proof work', async () => {
    const mismatch = await check('\u2200 (a : Nat \u2192 Nat) (n : Int), a (n + 1) = a n');
    expect(mismatch).toMatchObject({ status: 'failed', exitCode: 1, proofAcceptance: 'not-assessed',
      firstBlocking: { severity: 'error', format: 'lean-json' } });
    expect(mismatch.stdout).toContain('Type mismatch');
  });

  it.each(['\u2200 n, n = n', 'undeclaredType'])('rejects an ambiguous or unknown type before proof work: %s', async type => {
    expect((await check(type)).status).toBe('failed');
  });

  it('requires a quantified term instead of a declaration header for implicit and explicit helper binders', async () => {
    const header = '{s d : Nat} (a : Fin s → Fin d) : ∀ i : Fin s, a i = a i';
    const invalid = await check(header);
    expect(invalid).toMatchObject({ status: 'failed', exitCode: 1, proofAcceptance: 'not-assessed' });
    expect(invalid.firstBlocking?.message).toMatch(/expected ['"](?:→|->)/u);
    const corrected = await check('∀ {s d : Nat} (a : Fin s → Fin d), ∀ i : Fin s, a i = a i');
    expect(corrected.status, corrected.stdout + corrected.stderr).toBe('elaborated');
    expect(corrected).toMatchObject({ exitCode: 0, proofAcceptance: 'not-assessed' });
    expect(fs.readFileSync(path.join(root, 'Submission.lean'), 'utf8')).toContain('exact nonexistent_proof');
  });

  it('requires a quantified term instead of a declaration header for implicit and explicit helper binders', async () => {
    const header = '{s d : Nat} (a : Fin s → Fin d) : ∀ i : Fin s, a i = a i';
    const invalid = await check(header);
    expect(invalid).toMatchObject({ status: 'failed', exitCode: 1, proofAcceptance: 'not-assessed' });
    expect(invalid.firstBlocking?.message).toMatch(/expected ['"](?:→|->)/u);
    const corrected = await check('∀ {s d : Nat} (a : Fin s → Fin d), ∀ i : Fin s, a i = a i');
    expect(corrected.status, corrected.stdout + corrected.stderr).toBe('elaborated');
    expect(corrected).toMatchObject({ exitCode: 0, proofAcceptance: 'not-assessed' });
    expect(fs.readFileSync(path.join(root, 'Submission.lean'), 'utf8')).toContain('exact nonexistent_proof');
  });

  it('rejects command injection as a term and leaves the original file untouched', async () => {
    const result = await check('Nat\nrun_cmd IO.FS.writeFile "marker" "bad"');
    expect(result.status).toBe('failed');
    expect(fs.existsSync(path.join(root, 'marker'))).toBe(false);
    const clone = path.join(root, path.dirname(result.artifact.path), 'project');
    expect(fs.existsSync(path.join(clone, 'marker'))).toBe(false);
  });

  it('reports an unavailable or invalid dependency instead of treating the type as elaborated', async () => {
    fs.writeFileSync(path.join(root, 'Dependency.lean'), 'def invalidDependency : Nat := "wrong type"\n');
    const result = await check('Nat');
    expect(result).toMatchObject({ status: 'failed', proofAcceptance: 'not-assessed', firstBlocking: { file: 'Dependency.lean' } });
    expect(result.phases).toHaveLength(1);
    expect(fs.existsSync(path.join(root, '.lake', 'build'))).toBe(false);
  });

  it('checks only the selected closed expression and exports its actual references', async () => {
    const result = await checkLeanType({ projectRoot: root, file: 'Submission.lean', context: 'Geometry.original',
      type: '∀ n : Nat, n = n', expression: 'fun n => Eq.refl n', timeoutMs: 30_000 });
    expect(result.status, result.stdout + result.stderr).toBe('elaborated');
    expect(result.constants).toContain('Eq.refl');
    expect(result.evidence).toBe('advisory-application-elaboration');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, result.artifact.path), 'utf8'));
    expect(manifest).toMatchObject({ requestedExpression: 'fun n => Eq.refl n', proofAcceptance: 'not-assessed',
      environment: result.environment });
    expect(leanTypeDiagnosticProjection({ files: [{ file: 'Submission.lean', source: fs.readFileSync(path.join(root, 'Submission.lean'), 'utf8') }],
      modules: [{ file: 'Submission.lean', sourceRoot: '.', module: 'Submission' }], file: 'Submission.lean', context: 'Geometry.original',
      type: 'True', expression: 'True.intro' }).digest).not.toBe(leanTypeDiagnosticProjection({
        files: [{ file: 'Submission.lean', source: fs.readFileSync(path.join(root, 'Submission.lean'), 'utf8') }],
        modules: [{ file: 'Submission.lean', sourceRoot: '.', module: 'Submission' }], file: 'Submission.lean',
        context: 'Geometry.original', type: 'True' }).digest);
  });

  it.each([
    ['True', '(0 : Nat)'], ['True', 'by sorry'], ['True', 'by exact ?_'],
    ['True', 'missing_hypothesis'], ['∀ n : Nat, n = n', 'Eq.refl 0'],
  ])('retains scoped failure for expected type %s and expression %s', async (type, expression) => {
    const result = await checkLeanType({ projectRoot: root, file: 'Submission.lean', context: 'Geometry.original',
      type, expression, timeoutMs: 30_000 });
    expect(result.status, result.stdout + result.stderr).toBe('failed');
    expect(result.proofAcceptance).toBe('not-assessed');
    expect(result.firstBlocking).toBeDefined();
  });

  it('detects original-source changes during the disposable application check', async () => {
    const previous = run.getMockImplementation()!;
    run.mockImplementation(async input => {
      const result = await previous(input);
      if (input.args.at(-1).includes('TypeDiagnostic.lean'))
        fs.appendFileSync(path.join(root, 'Submission.lean'), '\n-- concurrently changed input\n');
      return result;
    });
    await expect(checkLeanType({ projectRoot: root, file: 'Submission.lean', context: 'Geometry.original',
      type: 'True', expression: 'True.intro', timeoutMs: 30_000 })).rejects.toThrow('math_type_diagnostics_source_changed');
  });
});
