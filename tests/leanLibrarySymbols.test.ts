import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertLeanLibrarySymbols, lookupLeanLibrarySymbols, type LeanLibrarySymbols } from '../src/math/leanLibrarySymbols';
import { leanLibrarySymbolCommands } from '../src/math/leanLibrarySymbolsProgram';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { LAKE_CONFIGURATION_FILES } from '../src/math/mathConstructionSources';
import { MATH_PROOF_ENVIRONMENT_ENV } from '../src/math/mathProofEnvironment';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';

const { diagnostics, packages, prepare, dispose, readiness, identity } = vi.hoisted(() => ({
  diagnostics: vi.fn(), packages: vi.fn(), prepare: vi.fn(), dispose: vi.fn(), readiness: vi.fn(), identity: vi.fn(),
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
vi.mock('../src/math/leanResidualGoals', () => ({ leanDiagnosticEnvironmentIdentity: identity }));
vi.mock('../src/math/mathRuntimeEnvironment', () => ({ resolveMathematicsRuntimeEnvironment: (env: NodeJS.ProcessEnv) => env }));

const names = ['ConnectedSpace', 'Function.Injective', 'SetLike.coe', 'NotInstalled', 'connectedSpace'];
const fixtureSymbols: LeanLibrarySymbols['symbols'] = [
  { name: names[0], exists: true, module: 'Mathlib.Topology.Connected.Basic', kind: 'inductive', class: true, structure: true,
    type: '(X : Type u) → [TopologicalSpace X] → Prop', fields: [
      { name: 'ConnectedSpace.toPreconnectedSpace', type: '{X : Type u} → [TopologicalSpace X] → [self : ConnectedSpace X] → PreconnectedSpace X' },
      { name: 'ConnectedSpace.toNonempty', type: '{X : Type u} → [TopologicalSpace X] → [self : ConnectedSpace X] → Nonempty X' },
    ] },
  { name: names[1], exists: true, module: 'Init.Prelude', kind: 'definition', class: false, structure: false,
    type: '{α : Sort u} → {β : Sort v} → (α → β) → Prop', fields: [] },
  { name: names[2], exists: true, module: 'Mathlib.Data.SetLike.Basic', kind: 'definition', class: false, structure: false,
    type: '{A : Type u} → {B : Type v} → [self : SetLike A B] → A → Set B', fields: [] },
  { name: names[3], exists: false }, { name: names[4], exists: false },
];
const environmentDigest = 'b'.repeat(64), toolIdentity = 'c'.repeat(64);
const envelope = (): LeanLibrarySymbols => {
  const config = getLeanTaskEnvironment('mathlib'), symbols = structuredClone(fixtureSymbols);
  return { schema: 'theorem-os.lean-library-symbols.v1', authority: 'advisory-lean-process',
    environment: 'mathlib', environmentDigest: config.dependencyDigest, toolchain: config.toolchain,
    mathlibRevision: config.mathlibRevision!, querySha256: mathDigest(leanLibrarySymbolCommands(names, 'mathlib')),
    symbolsSha256: mathDigest(canonicalMathJson(symbols)),
    observation: { sourceDigest: 'a'.repeat(64), environmentDigest, toolIdentity }, symbols };
};

describe('exact-name Lean library metadata binding', () => {
  it('preserves classes, direct parent projections, generated names, core names, and explicit missing names', () => {
    const result = assertLeanLibrarySymbols('mathlib', names, envelope());
    expect(result.symbols).toEqual(fixtureSymbols);
    expect(result.authority).toBe('advisory-lean-process');
  });

  it.each(['environmentDigest', 'toolchain', 'mathlibRevision'] as const)('rejects changed pinned %s', key => {
    const value = envelope();
    value[key] = key === 'mathlibRevision' ? 'e'.repeat(40) : key === 'environmentDigest' ? 'e'.repeat(64) : 'other-toolchain';
    expect(() => assertLeanLibrarySymbols('mathlib', names, value)).toThrow('lean_library_symbols_environment_changed');
  });

  it('binds the exact ordered query including case', () => {
    expect(() => assertLeanLibrarySymbols('mathlib', names.toReversed(), envelope())).toThrow('lean_library_symbols_query_changed');
    const value = envelope(); value.symbols[0].name = 'connectedSpace';
    value.symbolsSha256 = mathDigest(canonicalMathJson(value.symbols));
    expect(() => assertLeanLibrarySymbols('mathlib', names, value)).toThrow('lean_library_symbols_names_changed');
    const duplicate = envelope(); duplicate.symbols.push(duplicate.symbols[0]);
    duplicate.symbolsSha256 = mathDigest(canonicalMathJson(duplicate.symbols));
    expect(() => assertLeanLibrarySymbols('mathlib', names, duplicate)).toThrow('lean_library_symbols_names_changed');
  });

  it('rejects changed results and missing or abbreviated types', () => {
    const value = envelope();
    if (value.symbols[0].exists) value.symbols[0].type = 'False';
    expect(() => assertLeanLibrarySymbols('mathlib', names, value)).toThrow('lean_library_symbols_results_changed');
    for (const type of ['', '   ', '∀ x, ⋯']) {
      const incomplete = envelope();
      if (incomplete.symbols[0].exists) incomplete.symbols[0].type = type;
      incomplete.symbolsSha256 = mathDigest(canonicalMathJson(incomplete.symbols));
      expect(() => assertLeanLibrarySymbols('mathlib', names, incomplete)).toThrow('lean_library_symbols_invalid');
    }
  });

  it('rejects field fabrication for nonstructures and duplicate direct projections', () => {
    const nonstructure = envelope();
    if (nonstructure.symbols[1].exists) nonstructure.symbols[1].fields = [{ name: 'madeUp', type: 'Prop' }];
    nonstructure.symbolsSha256 = mathDigest(canonicalMathJson(nonstructure.symbols));
    expect(() => assertLeanLibrarySymbols('mathlib', names, nonstructure)).toThrow('lean_library_symbols_fields_invalid');
    const duplicates = envelope();
    if (duplicates.symbols[0].exists) duplicates.symbols[0].fields.push(duplicates.symbols[0].fields[0]);
    duplicates.symbolsSha256 = mathDigest(canonicalMathJson(duplicates.symbols));
    expect(() => assertLeanLibrarySymbols('mathlib', names, duplicates)).toThrow('lean_library_symbols_fields_invalid');
  });

  it('never turns requested strings into executable Lean source', () => {
    const hostile = '"]\nrun_cmd IO.println "injected"\u0000\\\t中文😊';
    const source = leanLibrarySymbolCommands([hostile], 'standard');
    const requestedLine = source.split('\n').find(line => line.includes('let requested : List String'))!;
    expect(source).not.toContain(hostile);
    expect(requestedLine).not.toContain('run_cmd');
    expect(String.fromCodePoint(...[...requestedLine.matchAll(/Char\.ofNat (\d+)/gu)].map(match => Number(match[1])))).toBe(hostile);
    expect(source).not.toContain('import Mathlib');
    expect(source).toContain('set_option pp.universes true');
    expect(source).toContain('set_option pp.deepTerms true');
    expect(source).not.toContain('set_option pp.maxSteps 0');
    expect(source).not.toContain('info.value');
    expect(source).not.toContain('value?');
    const legacy = leanLibrarySymbolCommands(['ConnectedSpace'], 'mathlib-4.8');
    expect(legacy).toContain('(String.mk [Char.ofNat');
    expect(legacy).not.toContain('set_option pp.maxSteps');
    expect(legacy).toContain('set_option maxRecDepth 18446744073709551615');
    expect(source).toContain('set_option maxRecDepth 0');
  });

  it('rejects malformed Unicode rather than silently substituting requested name characters', () => {
    expect(() => leanLibrarySymbolCommands(['\ud800'], 'mathlib')).toThrow('lean_library_symbols_names_invalid');
    expect(() => leanLibrarySymbolCommands([''], 'mathlib')).toThrow('lean_library_symbols_names_invalid');
  });
});

describe('pinned library symbol lookup process', () => {
  let directory: string;
  beforeEach(() => {
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lean-library-symbols-')));
    const cache = path.join(directory, 'packages'); fs.mkdirSync(cache);
    packages.mockReset().mockReturnValue(cache);
    dispose.mockReset().mockResolvedValue(undefined);
    prepare.mockReset().mockResolvedValue({ environmentValue: 'sealed-fixture', dispose, stats: {} });
    readiness.mockReset().mockReturnValue({ status: 'ready', diagnostics: '', fingerprint: 'fixture' });
    identity.mockReset().mockReturnValue({ environmentDigest, toolIdentity });
    diagnostics.mockReset().mockImplementation(async input => {
      const project = input.projectRoot;
      fs.mkdirSync(path.join(project, '.lake/diagnostic-artifacts'), { recursive: true });
      fs.writeFileSync(path.join(project, '.lake/library-symbols.json'), JSON.stringify(fixtureSymbols));
      const configuration = LAKE_CONFIGURATION_FILES.map(file => ({ file,
        digest: fs.existsSync(path.join(project, file)) ? mathDigest(fs.readFileSync(path.join(project, file))) : null }));
      const sourceFiles = [{ file: 'LibrarySymbols.lean', digest: mathDigest(fs.readFileSync(path.join(project, 'LibrarySymbols.lean'))) }];
      const sourceDigest = mathDigest(JSON.stringify([configuration.map(item => item.digest ?? ''), sourceFiles.map(item => [item.file, item.digest])]));
      const stdout = '', stderr = '';
      const artifactText = canonicalMathJson({ schema: 'theoremos.lean-diagnostics.v1', authority: 'advisory-lean-process',
        sourceDigest, environmentDigest, toolIdentity, sourceCurrent: true, file: 'LibrarySymbols.lean', sourceFiles,
        exitCode: 0, timedOut: false, aborted: false, captureComplete: true,
        stdout, stderr, stdoutSha256: mathDigest(stdout), stderrSha256: mathDigest(stderr) });
      const digest = mathDigest(artifactText), relative = `.lake/diagnostic-artifacts/${digest}.json`;
      fs.writeFileSync(path.join(project, relative), artifactText);
      const reference = { path: relative, digest, sourceDigest, environmentDigest, captureComplete: true };
      fs.writeFileSync(path.join(project, '.lake/lean-diagnostics-latest.json'), JSON.stringify({
        schema: 'theoremos.lean-diagnostics-latest.v1', authority: 'advisory-lean-process', sourceDigest,
        environmentDigest, toolIdentity, requestedFiles: ['LibrarySymbols.lean'], configuration, sourceFiles,
        exitCode: 0, timedOut: false, aborted: false, diagnosticArtifacts: [reference],
      }));
      return { exitCode: 0, timedOut: false, aborted: false, stdout, stderr,
        sourceDigest, environmentDigest, diagnosticArtifacts: [reference] };
    });
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lookup = (options: Partial<Parameters<typeof lookupLeanLibrarySymbols>[3]> = {}) =>
    lookupLeanLibrarySymbols(path.join(directory, 'lookup'), names, 'mathlib', { env: {}, timeoutMs: 0, ...options });

  it('runs the entire batch once, validates process receipts, and freezes inspectable outputs', async () => {
    const result = await lookup({ proofEnvironmentCacheRoot: path.join(directory, 'cache') });
    expect(result.symbols).toEqual(fixtureSymbols);
    expect(result.observation).toMatchObject({ environmentDigest, toolIdentity });
    expect(diagnostics).toHaveBeenCalledOnce();
    expect(diagnostics.mock.calls[0][0]).toMatchObject({ files: ['LibrarySymbols.lean'], timeoutMs: Infinity,
      env: { [MATH_PROOF_ENVIRONMENT_ENV]: 'sealed-fixture' } });
    expect(prepare.mock.calls[0][2].deadlineAt).toBeUndefined();
    expect(prepare.mock.calls[0][2].cacheRoot).toBe(path.join(directory, 'cache'));
    expect(dispose).toHaveBeenCalledOnce();
    for (const file of ['query.json', 'diagnostics.json', 'diagnostics-latest.json', 'library-symbols.json', 'project/LibrarySymbols.lean'])
      expect(fs.statSync(path.join(directory, 'lookup', file)).mode & 0o777).toBe(0o400);
    const latest = JSON.parse(fs.readFileSync(path.join(directory, 'lookup/diagnostics-latest.json'), 'utf8'));
    const digest = latest.diagnosticArtifacts[0].digest;
    expect(mathDigest(fs.readFileSync(path.join(directory, 'lookup/diagnostic-artifacts', `${digest}.json`)))).toBe(digest);
    expect(JSON.parse(fs.readFileSync(path.join(directory, 'lookup/library-symbols.json'), 'utf8'))).toEqual(result);
  });

  it('does not downgrade a missing pinned cache into empty metadata', async () => {
    packages.mockReturnValue(undefined);
    await expect(lookup()).rejects.toThrow('lean_library_symbols_lake_packages_unavailable');
    expect(diagnostics).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(path.join(directory, 'lookup/failure.json'), 'utf8')).error)
      .toBe('lean_library_symbols_lake_packages_unavailable');
    expect(fs.existsSync(path.join(directory, 'lookup/library-symbols.json'))).toBe(false);
  });

  it('surfaces Lean failure and always disposes sealed dependencies', async () => {
    diagnostics.mockResolvedValue({ exitCode: 1, timedOut: false, stdout: '', stderr: 'Compiler failure fixture' });
    await expect(lookup()).rejects.toThrow('lean_library_symbols_diagnostics_failed: Compiler failure fixture');
    expect(dispose).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(directory, 'lookup/library-symbols.json'))).toBe(false);
  });

  it('reports the blocking Lean error when stderr contains only a Lake warning', async () => {
    diagnostics.mockResolvedValue({ exitCode: 1, timedOut: false,
      stdout: 'LibrarySymbols.lean:10:1: error: maximum recursion depth has been reached',
      stderr: 'warning: manifest out of date',
      firstBlocking: { format: 'lean-json', severity: 'error', file: 'LibrarySymbols.lean', line: 10, column: 0,
        message: 'maximum recursion depth has been reached' },
    });
    await expect(lookup()).rejects.toThrow('LibrarySymbols.lean:10:1: error: maximum recursion depth has been reached');
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('retains both output streams when failed diagnostics have no parsed blocking message', async () => {
    diagnostics.mockResolvedValue({ exitCode: 1, timedOut: false,
      stdout: 'error: compiler fixture', stderr: 'warning: manifest fixture' });
    await expect(lookup()).rejects.toThrow('error: compiler fixture\nwarning: manifest fixture');
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('rejects missing tool identity before executing a query', async () => {
    identity.mockReturnValue({ environmentDigest });
    await expect(lookup()).rejects.toThrow('lean_library_symbols_tool_identity_unavailable');
    expect(diagnostics).not.toHaveBeenCalled(); expect(dispose).toHaveBeenCalledOnce();
  });

  it.each(['sourceDigest', 'environmentDigest', 'toolIdentity'] as const)('rejects a changed diagnostic %s', async key => {
    const complete = diagnostics.getMockImplementation()!;
    diagnostics.mockImplementation(async input => {
      const result = await complete(input), file = path.join(input.projectRoot, '.lake/lean-diagnostics-latest.json');
      const latest = JSON.parse(fs.readFileSync(file, 'utf8')); latest[key] = 'f'.repeat(64);
      fs.writeFileSync(file, JSON.stringify(latest)); return result;
    });
    await expect(lookup()).rejects.toThrow('lean_library_symbols_diagnostic_receipt_changed');
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('rejects incomplete diagnostic capture', async () => {
    const complete = diagnostics.getMockImplementation()!;
    diagnostics.mockImplementation(async input => {
      const result = await complete(input), file = path.join(input.projectRoot, '.lake/lean-diagnostics-latest.json');
      const latest = JSON.parse(fs.readFileSync(file, 'utf8'));
      latest.diagnosticArtifacts[0].captureComplete = false;
      fs.writeFileSync(file, JSON.stringify(latest)); return result;
    });
    await expect(lookup()).rejects.toThrow('lean_library_symbols_diagnostic_receipt_invalid');
    expect(fs.existsSync(path.join(directory, 'lookup/library-symbols.json'))).toBe(false);
  });

  it('rejects changed diagnostic artifacts', async () => {
    const complete = diagnostics.getMockImplementation()!;
    diagnostics.mockImplementation(async input => {
      const result = await complete(input);
      fs.appendFileSync(path.join(input.projectRoot, result.diagnosticArtifacts[0].path), '\nchanged');
      return result;
    });
    await expect(lookup()).rejects.toThrow('lean_library_symbols_diagnostic_artifact_changed');
  });

  it('rejects a query changed while Lean runs even if diagnostics succeeded', async () => {
    const complete = diagnostics.getMockImplementation()!;
    diagnostics.mockImplementation(async input => {
      const result = await complete(input), file = path.join(input.projectRoot, 'LibrarySymbols.lean');
      fs.chmodSync(file, 0o600); fs.appendFileSync(file, '\n-- mutated during process');
      return result;
    });
    await expect(lookup()).rejects.toThrow('lean_library_symbols_execution_changed');
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('rejects reordered exported names instead of returning a partial or empty batch', async () => {
    const complete = diagnostics.getMockImplementation()!;
    diagnostics.mockImplementation(async input => {
      const result = await complete(input);
      fs.writeFileSync(path.join(input.projectRoot, '.lake/library-symbols.json'), JSON.stringify(fixtureSymbols.toReversed()));
      return result;
    });
    await expect(lookup()).rejects.toThrow('lean_library_symbols_names_changed');
    expect(fs.existsSync(path.join(directory, 'lookup/library-symbols.json'))).toBe(false);
  });

  it('honors cancellation and invalid timeouts before creating a lookup directory', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(lookup({ signal: controller.signal })).rejects.toThrow();
    await expect(lookup({ timeoutMs: -1 })).rejects.toThrow('lean_library_symbols_timeout_invalid');
    expect(fs.existsSync(path.join(directory, 'lookup'))).toBe(false);
    expect(diagnostics).not.toHaveBeenCalled();
  });

  it('propagates cancellation during diagnostics and disposes the environment', async () => {
    const controller = new AbortController(), complete = diagnostics.getMockImplementation()!;
    diagnostics.mockImplementation(async input => { const result = await complete(input); controller.abort(); return result; });
    await expect(lookup({ signal: controller.signal })).rejects.toThrow();
    expect(dispose).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(directory, 'lookup/library-symbols.json'))).toBe(false);
  });

  it('never reuses a directory from a completed or failed process', async () => {
    await lookup();
    await expect(lookup()).rejects.toThrow('needs a fresh directory');
    expect(diagnostics).toHaveBeenCalledOnce();
  });
});
