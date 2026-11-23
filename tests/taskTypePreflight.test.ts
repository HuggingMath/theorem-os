import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskTypePreflightCache, typeDiagnosticExcerpt } from '../src/solver/taskTypePreflight';
import { leanTypeDiagnosticProjection } from '../src/math/leanTypeDiagnostics';
import { mathLocalModuleBuildOrder } from '../src/math/mathConstructionSources';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import type { SolverProblem } from '../src/solver/problem';
import type { CooperativeTask } from '../src/solver/tasks';

const { check, environment, tools } = vi.hoisted(() => ({ check: vi.fn(), environment: vi.fn(), tools: vi.fn() }));
vi.mock('../src/math/leanTypeDiagnostics', async original => ({
  ...await original<typeof import('../src/math/leanTypeDiagnostics')>(), checkLeanType: check,
}));
vi.mock('../src/solver/proofReuse', () => ({ proofReuseEnvironment: environment }));
vi.mock('../src/math/verifier', () => ({ formalVerificationToolIdentity: tools }));

describe('content-bound typed helper preflight', () => {
  let root: string, cache: TaskTypePreflightCache, artifacts: number;
  const source = 'namespace Geometry\ntheorem original : True := by sorry\nend Geometry\n';
  const task: CooperativeTask = { id: 'helper', kind: 'lemma', objective: 'Prove helper', revision: 0,
    theoremName: 'Geometry.helper', proofPath: 'Submission.lean', type: 'True', dependsOn: [] };
  const problem = { targets: [{ theoremName: 'Geometry.original', proofPath: 'Submission.lean' }] } as SolverProblem;
  const request = (extra: Record<string, unknown> = {}) => ({ projectRoot: root, problem, task, dependencies: [],
    environmentDigest: 'run-environment', env: {}, timeoutMs: Infinity, ...extra });
  const inputs = (project = root) => {
    const modules = mathLocalModuleBuildOrder(project, 'Submission.lean');
    const files = [...modules.map(module => module.file), ...['lean-toolchain', 'lakefile.toml', 'lakefile.lean',
      'lake-manifest.json', '.lake/package-overrides.json'].filter(file => fs.existsSync(path.join(project, file)))];
    return { modules, files: files.map(file => ({ file, source: fs.readFileSync(path.join(project, file), 'utf8') })) };
  };
  const snapshot = (project = root) => mathDigest(canonicalMathJson(inputs(project).files.map(({ file, source }) => ({ file, digest: mathDigest(source) }))));
  const projection = (project = root, type = task.type!, context = 'Geometry.original') => leanTypeDiagnosticProjection({
    ...inputs(project), file: task.proofPath!, type, context });
  const artifact = (project = root) => {
    const relative = `.lake/type-diagnostics/fixture-${++artifacts}/manifest.json`;
    const file = path.join(project, relative), contents = canonicalMathJson({ sourceDigest: snapshot(project) });
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, contents);
    return { path: relative, digest: mathDigest(contents) };
  };
  const elaborated = (input = { projectRoot: root, type: task.type!, context: 'Geometry.original' }) => ({ status: 'elaborated', type: 'True', exitCode: 0,
    sourceSnapshotDigest: snapshot(input.projectRoot), projectionDigest: projection(input.projectRoot, input.type, input.context).digest,
    artifact: artifact(input.projectRoot) });
  const failure = (extra: Record<string, unknown> = {}) => ({ status: 'failed', sourceSnapshotDigest: snapshot(), projectionDigest: projection().digest,
    exitCode: 1, timedOut: false, phases: [{ file: 'TypeDiagnostic.lean', exitCode: 1 }],
    firstBlocking: { severity: 'error', format: 'lean-json', file: 'TypeDiagnostic.lean', message: 'Type mismatch: expected Nat, found Int' },
    artifact: artifact(),
    diagnosticArtifacts: [{ captureComplete: true }], ...extra });
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'task-type-preflight-'))); artifacts = 0;
    fs.writeFileSync(path.join(root, 'Submission.lean'), source);
    environment.mockReset().mockImplementation((_project, env) => ({ env, digest: 'sealed-environment', reusable: true }));
    tools.mockReset().mockReturnValue('actual-tool-digest');
    check.mockReset().mockImplementation(async input => elaborated(input));
    cache = new TaskTypePreflightCache();
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('checks a new closed helper in a faithful original scope, reuses exact inputs, and preserves unlimited checks', async () => {
    const first = await cache.check(request()), repeat = await cache.check(request());
    expect(first.result).toMatchObject({ status: 'elaborated', context: 'Geometry.original', proofAcceptance: 'not-assessed' });
    expect(repeat.result).toEqual(first.result); expect(check).toHaveBeenCalledOnce();
    expect(check.mock.calls[0][0]).toMatchObject({ timeoutMs: Infinity, context: 'Geometry.original', type: 'True' });
    await cache.check(request({ timeoutMs: 5000 }));
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('checks and blocks a malformed new helper contract in an established helper-only namespace', async () => {
    const helperOnlyProblem = { targets: [{ theoremName: 'Main.original', proofPath: 'Main.lean' }] } as SolverProblem;
    check.mockImplementation(async () => failure({ firstBlocking: {
      severity: 'error', format: 'lean-json', file: 'TypeDiagnostic.lean',
      message: "<input>:1:361: expected ')', ',' or ':'" } }));
    const first = await cache.check(request({ problem: helperOnlyProblem }));
    expect(first.result).toMatchObject({ status: 'invalid', context: 'Geometry.original',
      reason: expect.stringContaining("expected ')', ',' or ':'"), proofAcceptance: 'not-assessed' });
    expect(check.mock.calls[0][0]).toMatchObject({ context: 'Geometry.original', type: task.type });
    await cache.check(request({ problem: helperOnlyProblem }));
    expect(check).toHaveBeenCalledOnce();
  });

  it('defers a new helper whose namespace has no established declaration', async () => {
    const result = await cache.check(request({ task: { ...task, theoremName: 'UnknownNamespace.helper' } }));
    expect(result.result).toMatchObject({ status: 'deferred', reason: 'declaration-context-unavailable' });
    expect(check).not.toHaveBeenCalled();
  });

  it('does not infer an unqualified helper context from declarations in another namespace', async () => {
    const result = await cache.check(request({ task: { ...task, theoremName: 'helper' }, problem: { targets: [] } }));
    expect(result.result).toMatchObject({ status: 'deferred', reason: 'declaration-context-unavailable' });
    expect(check).not.toHaveBeenCalled();
  });

  it('defers a helper-only namespace with conflicting established lookup scopes', async () => {
    fs.writeFileSync(path.join(root, 'Submission.lean'), source.replace('end Geometry',
      'section\nopen Nat\ntheorem other : True := by sorry\nend\nend Geometry'));
    const result = await cache.check(request({ problem: { targets: [] } }));
    expect(result.result).toMatchObject({ status: 'deferred', reason: 'declaration-context-unavailable' });
    expect(check).not.toHaveBeenCalled();
  });

  it('defers a helper-only namespace with an unsupported active scope', async () => {
    fs.writeFileSync(path.join(root, 'Submission.lean'), source.replace('theorem original',
      'variable (P : Prop)\ntheorem original'));
    const result = await cache.check(request({ problem: { targets: [] } }));
    expect(result.result).toMatchObject({ status: 'deferred', reason: 'declaration-scope-not-reproducible' });
    expect(check).not.toHaveBeenCalled();
  });

  it.each(['variable (P : Prop)', 'universe u'])('rejects a declaration type before deferring an active scope: %s', async scope => {
    fs.writeFileSync(path.join(root, 'Submission.lean'), source.replace('theorem original', scope + '\ntheorem original'));
    const malformed = { ...task, type: 'theorem Geometry.helper (n : Nat) : n = n' };
    const first = await cache.check(request({ task: malformed }));
    expect(first.result).toMatchObject({ status: 'invalid', proofAcceptance: 'not-assessed',
      reason: expect.stringContaining('Task helper: helper type starts with a Lean declaration command') });
    expect(first.result.reason).toContain('explicitly quantify every parameter and instance');
    expect(first.result.artifact).toBeUndefined(); expect(check).not.toHaveBeenCalled();
    expect(first.current()).toBe(true);
    malformed.type = '∀ (n : Nat), n = n';
    expect(first.current()).toBe(false);
    expect((await cache.check(request({ task: malformed }))).result.status).toBe('deferred');
  });

  it('rejects a declaration type before deferring an unavailable future dependency', async () => {
    const dependencies = [{ ...task, id: 'future', theoremName: 'Geometry.future' }];
    const result = await cache.check(request({ task: { ...task, type: 'theorem Geometry.helper : True' }, dependencies }));
    expect(result.result).toMatchObject({ status: 'invalid', reason: expect.stringContaining('Task helper') });
    expect(check).not.toHaveBeenCalled();
  });

  it('rejects a malformed dependency before it can become a conditional binder, then observes its explicit revision', async () => {
    const dependency = { ...task, id: 'future', theoremName: 'Geometry.future', type: 'theorem Geometry.future : True' };
    const input = request({ dependencies: [dependency] });
    const first = await cache.check(input);
    expect(first.result).toMatchObject({ status: 'invalid', reason: expect.stringContaining('Task future') });
    expect(first.current()).toBe(true); expect(check).not.toHaveBeenCalled();
    dependency.type = 'True'; dependency.revision++;
    expect(first.current()).toBe(false);
    expect((await cache.check(input)).result).toMatchObject({ status: 'deferred', reason: 'future-dependency-unavailable' });
  });

  it('continues to elaborate a legal explicit forall type without rewriting its contract', async () => {
    const closed = { ...task, type: '∀ (n : Nat), n = n' };
    const result = await cache.check(request({ task: closed }));
    expect(result.result.status).toBe('elaborated');
    expect(check.mock.calls[0][0].type).toBe(closed.type);
    expect(closed.type).toBe('∀ (n : Nat), n = n');
  });

  it('reuses a successful identical proof-erased query while preserving raw input and origin evidence', async () => {
    const first = await cache.check(request()), originSourceDigest = snapshot();
    fs.writeFileSync(path.join(root, 'Submission.lean'), source.replace('by sorry', 'by\n  -- proof-only revision\n  trivial'));
    const sourceDigest = snapshot(), next = await cache.check(request());
    expect(check).toHaveBeenCalledOnce(); expect(first.current()).toBe(false); expect(next.current()).toBe(true);
    expect(next.result.inputDigest).not.toBe(first.result.inputDigest);
    expect(next.result).toMatchObject({ status: 'elaborated', proofAcceptance: 'not-assessed', artifact: first.result.artifact,
      projectionReuse: { originInputDigest: first.result.inputDigest, originSourceDigest, sourceDigest,
        projectionDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) } });
    expect(JSON.parse(fs.readFileSync(path.join(root, next.result.artifact!.path), 'utf8')).sourceDigest).toBe(originSourceDigest);
  });

  it('keeps cached diagnostic artifacts within the same worker project', async () => {
    const first = await cache.check(request()), other = path.join(root, 'other-worker');
    fs.mkdirSync(other); fs.writeFileSync(path.join(other, 'Submission.lean'), source);
    const next = await cache.check(request({ projectRoot: other }));
    expect(check).toHaveBeenCalledTimes(2); expect(next.result.inputDigest).not.toBe(first.result.inputDigest);
    expect(fs.existsSync(path.join(other, next.result.artifact!.path))).toBe(true);
  });

  it('isolates cached values from mutations of returned advisory records', async () => {
    const first = await cache.check(request()), original = structuredClone(first.result);
    first.result.status = 'invalid'; first.result.reason = 'mutated outside the cache';
    first.result.artifact!.path = 'missing.json';
    const next = await cache.check(request());
    expect(check).toHaveBeenCalledOnce(); expect(next.result).toEqual(original);
    expect(next.result).not.toBe(first.result); expect(next.result.artifact).not.toBe(first.result.artifact);
  });

  it('retains the original checked query across repeated proof edits and returned provenance mutations', async () => {
    const first = await cache.check(request());
    fs.writeFileSync(path.join(root, 'Submission.lean'), source.replace('by sorry', 'by trivial'));
    const second = await cache.check(request());
    second.result.projectionReuse!.originInputDigest = 'mutated'; second.result.artifact!.path = 'missing.json';
    fs.writeFileSync(path.join(root, 'Submission.lean'), source.replace('by sorry', 'by\n  exact True.intro'));
    const third = await cache.check(request());
    expect(check).toHaveBeenCalledOnce(); expect(third.result.artifact).toEqual(first.result.artifact);
    expect(third.result.projectionReuse).toMatchObject({ originInputDigest: first.result.inputDigest, sourceDigest: snapshot() });
    expect(third.result.inputDigest).not.toBe(second.result.inputDigest);
  });

  it('bounds checked results and removes projection indexes when their origins are evicted', async () => {
    await cache.check(request());
    for (let revision = 1; revision <= 64; revision++) await cache.check(request({ task: { ...task, revision } }));
    expect((cache as any).results.size).toBe(64); expect((cache as any).projections.size).toBe(64);
    for (const origin of (cache as any).projections.values()) expect((cache as any).results.has(origin)).toBe(true);
    fs.writeFileSync(path.join(root, 'Submission.lean'), source.replace('by sorry', 'by trivial'));
    const next = await cache.check(request());
    expect(check).toHaveBeenCalledTimes(66); expect(next.result.projectionReuse).toBeUndefined();
    expect((cache as any).results.size).toBe(64); expect((cache as any).projections.size).toBe(64);
  });

  it('keeps invalid queries exact-only even when a later proof-erased projection is identical', async () => {
    check.mockImplementation(async () => failure());
    const first = await cache.check(request());
    fs.writeFileSync(path.join(root, 'Submission.lean'), source.replace('by sorry', 'by trivial'));
    const next = await cache.check(request()); await cache.check(request());
    expect(check).toHaveBeenCalledTimes(2); expect(first.result.status).toBe('invalid');
    expect(next.result.status).toBe('invalid'); expect(next.result.projectionReuse).toBeUndefined();
  });

  it.each(['sourceSnapshotDigest', 'projectionDigest'] as const)('refuses to cache a result with a mismatched %s receipt', async field => {
    check.mockImplementationOnce(async input => ({ ...elaborated(input), [field]: mathDigest('other-input') }));
    expect((await cache.check(request())).result.status).toBe('unavailable');
    const next = await cache.check(request());
    expect(next.result.status).toBe('elaborated'); expect(next.result.projectionReuse).toBeUndefined();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('does not seed projection reuse from a check whose raw proof changed while awaiting Lean', async () => {
    check.mockImplementationOnce(async input => {
      const value = elaborated(input);
      fs.writeFileSync(path.join(root, 'Submission.lean'), source.replace('by sorry', 'by trivial'));
      return value;
    });
    const stale = await cache.check(request()), next = await cache.check(request());
    expect(stale.result.status).toBe('unavailable'); expect(stale.current()).toBe(false);
    expect(next.result.status).toBe('elaborated'); expect(next.result.projectionReuse).toBeUndefined();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it.each(['exact-removed', 'exact-tampered', 'proof-edit-removed', 'proof-edit-tampered'])
  ('rechecks when the original artifact is no longer intact: %s', async scenario => {
    const first = await cache.check(request()), file = path.join(root, first.result.artifact!.path);
    if (scenario.endsWith('removed')) fs.rmSync(file); else fs.writeFileSync(file, '{}');
    if (scenario.startsWith('proof-edit')) fs.writeFileSync(path.join(root, 'Submission.lean'), source.replace('by sorry', 'by trivial'));
    const next = await cache.check(request());
    expect(check).toHaveBeenCalledTimes(2); expect(next.result.status).toBe('elaborated');
    expect(next.result.projectionReuse).toBeUndefined(); expect(next.result.artifact!.path).not.toBe(first.result.artifact!.path);
  });

  it.each(['exact', 'projection'] as const)('invalidates a %s hit when its origin artifact changes before the caller resumes', async mode => {
    const first = await cache.check(request());
    if (mode === 'projection') fs.writeFileSync(path.join(root, 'Submission.lean'), source.replace('by sorry', 'by trivial'));
    const pending = cache.check(request());
    fs.writeFileSync(path.join(root, first.result.artifact!.path), '{}');
    const reused = await pending;
    expect(check).toHaveBeenCalledOnce(); expect(reused.current()).toBe(false);
    if (mode === 'exact') expect(first.current()).toBe(true);
  });

  it.each(['exact', 'projection'] as const)('keeps a %s cache hit bound to the new caller cancellation signal', async mode => {
    await cache.check(request());
    if (mode === 'projection') fs.writeFileSync(path.join(root, 'Submission.lean'), source.replace('by sorry', 'by trivial'));
    const controller = new AbortController(), pending = cache.check(request({ signal: controller.signal }));
    controller.abort();
    const reused = await pending;
    expect(reused.current()).toBe(false); expect(check).toHaveBeenCalledOnce();
    expect((await cache.check(request())).current()).toBe(true);
  });

  it.each(['type', 'task-contract', 'dependency-contract', 'run-environment', 'proof-environment', 'tools', 'timeout'] as const)
  ('rechecks an identical proof-erased source when its %s binding changes', async change => {
    await cache.check(request());
    fs.writeFileSync(path.join(root, 'Submission.lean'), source.replace('by sorry', 'by trivial'));
    const extra: Record<string, unknown> = {};
    if (change === 'type') extra.task = { ...task, type: 'False' };
    if (change === 'task-contract') extra.task = { ...task, revision: 1 };
    if (change === 'dependency-contract') extra.dependencies = [{ ...task, id: 'advisory-input', kind: 'research', revision: 1 }];
    if (change === 'run-environment') extra.environmentDigest = 'new-run-environment';
    if (change === 'proof-environment') environment.mockImplementation((_project, env) => ({ env, digest: 'new-sealed-environment', reusable: true }));
    if (change === 'tools') tools.mockReturnValue('new-actual-tools');
    if (change === 'timeout') extra.timeoutMs = 5000;
    const next = await cache.check(request(extra));
    expect(next.result.status).toBe('elaborated'); expect(next.result.projectionReuse).toBeUndefined();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('keeps the chosen anchor in the reuse binding even when both anchors reopen the same scope', async () => {
    const twoAnchors = source.replace('end Geometry', 'theorem other : True := by sorry\nend Geometry');
    fs.writeFileSync(path.join(root, 'Submission.lean'), twoAnchors);
    await cache.check(request());
    fs.writeFileSync(path.join(root, 'Submission.lean'), twoAnchors.replace('by sorry', 'by trivial'));
    const next = await cache.check(request({ problem: { targets: [{ theoremName: 'Geometry.other', proofPath: 'Submission.lean' }] } }));
    expect(next.result.context).toBe('Geometry.other'); expect(next.result.projectionReuse).toBeUndefined();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('invalidates source, configuration, contracts, environments, dependencies and actual tools independently', async () => {
    const first = await cache.check(request());
    fs.appendFileSync(path.join(root, 'Submission.lean'), '\n-- new committed source\n');
    expect(first.current()).toBe(false); await cache.check(request());
    fs.writeFileSync(path.join(root, 'lakefile.toml'), 'name = "fixture"\n'); await cache.check(request());
    await cache.check(request({ task: { ...task, type: 'False' } }));
    await cache.check(request({ environmentDigest: 'another-environment' }));
    await cache.check(request({ dependencies: [{ ...task, id: 'research-input', kind: 'research', revision: 1 }] }));
    tools.mockReturnValue('replacement-tool'); await cache.check(request());
    expect(check).toHaveBeenCalledTimes(7);
  });

  it('treats only complete query-local elaboration errors as invalid and caches that exact input', async () => {
    check.mockImplementation(async () => failure());
    const first = await cache.check(request());
    expect(first.result).toMatchObject({ status: 'invalid', reason: expect.stringContaining('expected Nat') });
    await cache.check(request()); expect(check).toHaveBeenCalledOnce();
  });

  it.each(['Unknown identifier `unboundType`', 'unexpected token ")"; expected term',
    'Function expected at value', 'Requested type must be closed without free variables or metavariables',
    "<input>:1:361: expected ')', ',' or ':'", "expected ')', ',' or ':'",
    '<input>:2:10: unexpected token ")"; expected term',
    '<input>:1:329: expected end of input', '<input>:1:377: expected end of input', 'expected end of input'])
  ('blocks only an explicit type or parsing error: %s', async message => {
    check.mockImplementation(async () => failure({ firstBlocking: {
      severity: 'error', format: 'lean-json', file: 'TypeDiagnostic.lean', message } }));
    expect((await cache.check(request())).result.status).toBe('invalid');
    await cache.check(request()); expect(check).toHaveBeenCalledOnce();
  });

  it.each([
    ['Frozen.value', 'available', 'deferred'], ['_root_.Frozen.value', 'available', 'deferred'],
    ['Frozen.typo', 'available', 'invalid'], ['value', 'available', 'invalid'],
    ['Frozen.value', 'not-frozen', 'invalid'], ['Frozen.value', 'different-digest', 'invalid'],
    ['Frozen.value', 'transitively-imported', 'invalid'],
  ])('classifies an unknown name %s against the %s library as %s', async (name, context, status) => {
    const file = 'Submission/Library/Bounds.lean', module = 'Submission.Library.Bounds';
    const frozen = 'namespace Frozen\ndef value : Nat := 0\nend Frozen\n', digest = mathDigest(frozen);
    fs.mkdirSync(path.join(root, 'Submission/Library'), { recursive: true });
    fs.writeFileSync(path.join(root, file), frozen);
    if (context === 'transitively-imported') {
      fs.writeFileSync(path.join(root, 'Base.lean'), `import ${module}\n`);
      fs.writeFileSync(path.join(root, 'Submission.lean'), 'import Base\n' + source);
    }
    const type = `${name} = 0`, input = { task: { ...task, type }, problem: { ...problem,
      frozenFiles: context === 'not-frozen' ? {} : { [file]: digest } } };
    const library = { digest, base: { entries: [{ name: 'Frozen.value', file, contextDigest: 'ctx' }],
      contexts: { ctx: { [file]: context === 'different-digest' ? mathDigest('other') : digest } } } };
    check.mockImplementation(async () => failure({ projectionDigest: projection(root, type).digest, firstBlocking: {
      severity: 'error', format: 'lean-json', file: 'TypeDiagnostic.lean', message: `Unknown identifier \`${name}\`` } }));
    // A cached error before the installed snapshot arrived must not hide a newly identified legal import.
    expect((await cache.check(request(input))).result.status).toBe('invalid');
    const { result } = await cache.check(request({ ...input, installedLibrary: library }));
    expect(result).toMatchObject({ status, proofAcceptance: 'not-assessed' });
    if (status === 'deferred') expect(result.reason).toContain(`import ${module}`);
  });

  it.each(['(deterministic) timeout at `whnf`, maximum number of heartbeats (200000) has been reached',
    'maximum recursion depth has been reached; use set_option maxRecDepth to increase the limit',
    'internal exception: unreachable code', 'IO error: failed to read object file',
    'out of memory', 'kernel exception: invalid memory access', 'unsolved goals\n|- True',
    'Type mismatch while reporting an internal error', 'Unknown identifier after a deterministic timeout',
    "<input>:1:361: expected ')' after an internal exception",
    '<input>:1:329: expected end of input after a deterministic timeout'])
  ('defers query-local resource, infrastructure and unclassified errors without caching: %s', async message => {
    check.mockImplementation(async () => failure({ firstBlocking: {
      severity: 'error', format: 'lean-json', file: 'TypeDiagnostic.lean', message } }));
    expect((await cache.check(request())).result).toMatchObject({ status: 'deferred' });
    await cache.check(request()); expect(check).toHaveBeenCalledTimes(2);
  });

  it.each([
    { timedOut: true }, { aborted: true }, { exitCode: null }, { exitCode: 137 },
    { diagnosticArtifacts: [{ captureComplete: false }] }, { diagnosticArtifacts: [{ captureComplete: null }] },
    { firstBlocking: { format: 'raw', file: 'TypeDiagnostic.lean', severity: 'error', message: 'incomplete' } },
    { phases: [{ file: 'Submission.lean', exitCode: 1 }] },
  ])('does not label an incomplete, interrupted or upstream error invalid: %j', async extra => {
    check.mockImplementation(async () => failure(extra));
    expect((await cache.check(request())).result.status).not.toBe('invalid');
    await cache.check(request()); expect(check).toHaveBeenCalledTimes(2);
  });

  it.each(['variable (P : Prop)', 'local notation "NatHere" => Nat', 'local instance : Inhabited Nat := inferInstance',
    'attribute [local simp] Nat.add_zero', '@[local simp]', '@[local instance] def localDefault : Inhabited Nat := inferInstance',
    'set_option maxHeartbeats 0', 'set_option maxHeartbeats 100', 'set_option maxRecDepth 10000'])
  ('defers an active scope that the host cannot faithfully restore: %s', async scope => {
    fs.writeFileSync(path.join(root, 'Submission.lean'), source.replace('theorem original', scope + '\ntheorem original'));
    expect((await cache.check(request())).result).toMatchObject({ status: 'deferred', reason: 'declaration-scope-not-reproducible' });
    expect(check).not.toHaveBeenCalled();
  });

  it('does not apply scope limitations from an already closed section', async () => {
    fs.writeFileSync(path.join(root, 'Submission.lean'), 'section\nvariable (P : Prop)\nend\n' + source);
    expect((await cache.check(request())).result.status).toBe('elaborated');
  });

  it.each(['private def Hidden := Nat', 'section\nprivate abbrev Hidden := Nat\nend',
    '@[reducible] private def Hidden := Nat', 'namespace Types\nprivate def Hidden := Nat\nend Types\nopen Types',
    'namespace Types\nprivate def Hidden := Nat\ndef Public := Nat\nend Types\nopen Types hiding Public'])
  ('defers a query error for a visible same-file private name: %s', async declaration => {
    fs.writeFileSync(path.join(root, 'Submission.lean'), source.replace('theorem original', declaration + '\ntheorem original'));
    check.mockImplementation(async () => failure({ firstBlocking: {
      severity: 'error', format: 'lean-json', file: 'TypeDiagnostic.lean', message: 'Unknown identifier `Hidden`' } }));
    const first = await cache.check(request());
    expect(first.result).toMatchObject({ status: 'deferred', reason: expect.stringContaining('private-context-not-reproducible') });
    await cache.check(request());
    expect(check).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['private inductive Hidden where\n  | mk : Hidden', 'Hidden.mk'],
    ['private structure Hidden where\n  value : Nat', 'Hidden.mk'],
    ['private structure Hidden where\n  value : Nat', 'Hidden.value'],
  ])('defers member lookups under a private data declaration: %s', async (declaration, name) => {
    fs.writeFileSync(path.join(root, 'Submission.lean'), source.replace('theorem original', declaration + '\ntheorem original'));
    check.mockImplementation(async () => failure({ firstBlocking: {
      severity: 'error', format: 'lean-json', file: 'TypeDiagnostic.lean', message: `Unknown identifier \`${name}\`` } }));
    expect((await cache.check(request())).result).toMatchObject({
      status: 'deferred', reason: expect.stringContaining('private-context-not-reproducible') });
  });

  it.each([
    ['private def Unrelated := Nat\n', 'Unknown identifier `Missing`'],
    ['private def Hidden := Nat\n', 'Type mismatch: expected Nat, found Int'],
    ['private def Hidden := Nat\n', 'Unknown identifier `_root_.Hidden`'],
    ['private def Hidden := Nat\n', 'Unknown identifier `Hidden.mk`'],
    ['private structure Hidden where\n  value : Nat\n', 'Unknown identifier `_root_.Hidden.mk`'],
    ['namespace Other\nprivate def Hidden := Nat\nend Other\n', 'Unknown identifier `Hidden`'],
    ['namespace Types\ndef Other := Nat\nend Types\nnamespace Other\nprivate def Hidden := Nat\nend Other\nopen Types hiding Other\n',
      'Unknown identifier `Hidden`'],
    ['', 'Unknown identifier `Hidden`'],
    ['', 'Unknown identifier `HiddenLater`'],
  ])('keeps genuine type errors invalid despite unrelated private context: %s', async (declaration, message) => {
    fs.writeFileSync(path.join(root, 'Submission.lean'), source.replace('theorem original', declaration + 'theorem original')
      .replace('end Geometry', 'private def HiddenLater := Nat\nend Geometry'));
    check.mockImplementation(async () => failure({ firstBlocking: {
      severity: 'error', format: 'lean-json', file: 'TypeDiagnostic.lean', message } }));
    expect((await cache.check(request())).result.status).toBe('invalid');
    await cache.check(request());
    expect(check).toHaveBeenCalledOnce();
  });

  it.each(['noncomputable section\nend', 'mutual\ndef even : Nat → Bool\n  | 0 => true\n  | n + 1 => odd n\n' +
    'def odd : Nat → Bool\n  | 0 => false\n  | n + 1 => even n\nend'])
  ('keeps a namespace scope limitation after a closed block: %s', async block => {
    fs.writeFileSync(path.join(root, 'Submission.lean'), source.replace('theorem original', `variable (P : Prop)\n${block}\ntheorem original`));
    expect((await cache.check(request())).result).toMatchObject({ status: 'deferred', reason: 'declaration-scope-not-reproducible' });
  });

  it('defers multiple original anchors with different open scopes in the same namespace', async () => {
    fs.writeFileSync(path.join(root, 'Submission.lean'), source.replace('end Geometry',
      'section\nopen Nat\ntheorem other : True := by sorry\nend\nend Geometry'));
    const moreTargets = { targets: [...problem.targets, { theoremName: 'Geometry.other', proofPath: 'Submission.lean' }] } as SolverProblem;
    expect((await cache.check(request({ problem: moreTargets }))).result.status).toBe('deferred');
    expect(check).not.toHaveBeenCalled();
  });

  it('defers future helper dependencies instead of rejecting the type', async () => {
    expect((await cache.check(request({ dependencies: [{ ...task, id: 'future', theoremName: 'Geometry.future' }] }))).result)
      .toMatchObject({ status: 'deferred', reason: 'future-dependency-unavailable' });
    expect(check).not.toHaveBeenCalled();
  });

  it('rejects stale results after awaited source or actual tool replacement', async () => {
    check.mockImplementationOnce(async () => { const value = failure();
      fs.appendFileSync(path.join(root, 'Submission.lean'), '\n-- changed during Lean\n'); return value; });
    const result = await cache.check(request());
    expect(result.result.status).toBe('unavailable'); expect(result.current()).toBe(false);
    check.mockImplementationOnce(async () => { tools.mockReturnValue('new-tool'); return failure(); });
    expect((await cache.check(request())).result.status).toBe('unavailable');
  });

  it('detects a newly materialized local import even when the old root bytes stay identical', async () => {
    fs.writeFileSync(path.join(root, 'Submission.lean'), 'import NewlyLocal\n' + source);
    const result = await cache.check(request());
    fs.writeFileSync(path.join(root, 'NewlyLocal.lean'), 'def newLocal : Nat := 1\n');
    expect(result.current()).toBe(false);
  });

  it('does not cache environment or infrastructure unavailability', async () => {
    check.mockRejectedValue(new Error('Lease unavailable'));
    expect((await cache.check(request())).result.status).toBe('unavailable');
    await cache.check(request()); expect(check).toHaveBeenCalledTimes(2);
    environment.mockReturnValue({ env: {}, reusable: false });
    expect((await cache.check(request())).result).toMatchObject({ status: 'deferred', reason: 'proof-environment-not-frozen' });
  });
});

describe('type parser diagnostic excerpt', () => {
  // Lean's runParserCategory column is a 0-based codepoint offset into the type string (ℝ and → are one each).
  const reason = (column: number) => `TypeDiagnostic.lean:9:1: error: <input>:1:${column}: expected '(', '_' or identifier`;
  it('explains declaration-header binders without silently changing a helper contract', () => {
    const type = '{s d : ℕ} (a : Fin s → Space d) : True';
    const diagnostic = "TypeDiagnostic.lean:9:1: error: <input>:1:10: expected '→', '->'";
    const excerpt = typeDiagnosticExcerpt(type, diagnostic)!;
    expect(excerpt).toContain('⟦(⟧a : Fin s → Space d)');
    expect(excerpt).toContain('declaration-header binders');
    expect(excerpt).toContain('∀ {s d : ℕ} (a : T), P');
    expect(excerpt).toContain('submit a task revision');
    expect(excerpt).toContain('host has not changed this contract');
    expect(typeDiagnosticExcerpt('∀ {s d : ℕ} (a : Fin s → Space d), True', diagnostic))
      .not.toContain('declaration-header binders');
    expect(typeDiagnosticExcerpt(type, reason(10))).not.toContain('declaration-header binders');
  });
  it('quotes the reserved token a bound variable used and says to rename it', () => {
    const type = '∀ (ε : ℝ), 0 < ε → ∃ λ : ℝ, 0 < λ ∧ λ ≤ 48 * ε';
    const excerpt = typeDiagnosticExcerpt(type, reason(Array.from(type).indexOf('λ')))!;
    expect(excerpt).toContain('<input>:1:21, 0-based codepoint column): ∀ (ε : ℝ), 0 < ε → ∃ ⟦λ⟧ : ℝ, 0 < λ ∧ λ ≤ 48 * ε');
    expect(excerpt).toContain('`λ` is a reserved Lean token, not an identifier; rename that bound variable');
    // 𝕜 is outside the BMP: one codepoint, two UTF-16 units.
    const astral = '∀ (x : 𝕜), ∃ λ : 𝕜, λ = x';
    expect(typeDiagnosticExcerpt(astral, reason(Array.from(astral).indexOf('λ')))).toContain('∃ ⟦λ⟧ : 𝕜, λ = x');
    expect(typeDiagnosticExcerpt('∀ fun : ℕ, fun = fun', reason(2))).toContain('⟦fun⟧ : ℕ');
    expect(typeDiagnosticExcerpt('∀ fun : ℕ, fun = fun', reason(2))).toContain('`fun` is a reserved Lean token');
  });
  it('quotes other stops without a reserved-token claim and ignores positions it cannot place', () => {
    const type = `∀ ${'x'.repeat(80)} : ℕ, x = (x`;
    const excerpt = typeDiagnosticExcerpt(type, reason(83))!;
    expect(excerpt).toMatch(/^Type text where the parser stopped \(<input>:1:83, 0-based codepoint column\): …x+ ⟦:⟧ ℕ, x = \(x$/u);
    expect(excerpt).not.toContain('reserved');
    expect(typeDiagnosticExcerpt('∀ fun_x : ℕ, True', reason(2))).not.toContain('reserved');
    expect(typeDiagnosticExcerpt('True', reason(4))).toBeUndefined();
    expect(typeDiagnosticExcerpt('True', `TypeDiagnostic.lean:9:1: error: <input>:2:0: expected term`)).toBeUndefined();
    expect(typeDiagnosticExcerpt('True', 'unknown identifier Foo')).toBeUndefined();
  });
});
