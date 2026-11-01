import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalMathProblemStatementPayloads, type MathProblemContract } from '../src/math/contracts';
import { LEAN_EVAL_BENCHMARK_COMMIT } from '../src/math/leanEvalCatalogAdapter';
import { hashMathFormalSourceDeclaration } from '../src/math/leanSource';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { extractRunLibraryModules, installLibraryPack, LIBRARY_PACK_SCHEMA, libraryPackDigest, parseLibraryPack,
  summarizeLibraryPack, upstreamLibraryModules, type LibraryPack } from '../src/math/libraryPacks';
import { taskChanges } from '../src/solver/cooperativeProof';
import type { SolverRunState } from '../src/solver/archive';
import { buildResearchContext } from '../src/solver/modules/context';
import { assertSolverSources, commitSolverSources, git, readSolverProblem, solverProofImports, type SolverProblem } from '../src/solver/problem';
import { parseCooperationPlan, taskVersion, type CooperativeTask } from '../src/solver/tasks';
import { temporaryDirectory } from './helpers/files';
import { newestLeanBinary } from './helpers/lean';

const lean = newestLeanBinary();
const oid = 'a'.repeat(40);
const lines = (source: string) => source.split('\n').filter(line => line.trim());
const pack = (modules: Record<string, string>, requires?: LibraryPack['requires']): unknown => ({ schema: LIBRARY_PACK_SCHEMA,
  modules: Object.entries(modules).map(([file, source]) => ({ file, source, origin: { kind: 'run', runId: 'r', commit: oid, file: 'Submission.lean' } })),
  ...(requires ? { requires } : {}) });
const commit = (repository: string, message: string) => {
  git(repository, ['add', '-A']);
  git(repository, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '--no-gpg-sign', '--quiet', '-m', message]);
  return git(repository, ['rev-parse', 'HEAD']);
};
/** Compile each file in order into build/, as a lake build of the project would, and return the probe output. */
function compileLean(project: string, files: readonly string[], probe: string) {
  const build = path.join(project, 'build');
  const run = (file: string, output?: string) => spawnSync(lean!, [...(output ? ['-R', project, '-o', output] : []), file],
    { cwd: project, env: { ...process.env, LEAN_PATH: build }, encoding: 'utf8', timeout: 120_000 });
  for (const file of files) {
    const output = path.join(build, file.replace(/\.lean$/u, '.olean'));
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const result = run(path.join(project, file), output);
    expect(`${file}: ${result.stdout}${result.stderr}`).toBe(`${file}: `);
    expect(result.status).toBe(0);
  }
  fs.writeFileSync(path.join(project, 'Probe.lean'), probe);
  return run(path.join(project, 'Probe.lean'));
}

describe('library pack validation', () => {
  const lib = 'Submission/Library/Fixture/Lemmas.lean';

  it('accepts comments and strings that mention trust escapes and rejects real ones', () => {
    const source = '/-- Avoids `sorry` and native_decide; see "axiom" docs. -/\ntheorem sorry_free : True := trivial\n-- no admit here\n';
    expect(parseLibraryPack(pack({ [lib]: source })).modules[0]!.file).toBe(lib);
    for (const [body, token] of [['theorem t : True := by sorry', 'sorry'], ['axiom ax : False', 'axiom'],
      ['theorem t : 2 = 2 := by native_decide', 'native_decide'], ['unsafe def u : Nat := 0', 'unsafe'],
      ['@[implemented_by id] def f (n : Nat) : Nat := n', 'implemented_by'], ['#eval 1', '#eval'], ['run_cmd pure ()', 'run_cmd']])
      expect(() => parseLibraryPack(pack({ [lib]: `theorem ok : True := trivial\n\n${body}\n` })), body)
        .toThrow(`math_library_pack_forbidden_token: ${lib}:3 ${token}`);
  });

  it('rejects unsafe paths, duplicates, invalid text, imports of owned modules, cycles and owned requirements', () => {
    for (const file of ['Submission/Library.lean', 'Submission/Library/lower/X.lean', 'Submission/Theory/T01.lean',
      'Submission/Library/A/Solution.lean', 'Library/A/X.lean', 'Submission/Library/A/X.txt'])
      expect(() => parseLibraryPack(pack({ [file]: 'theorem t : True := trivial\n' })), file).toThrow(/math_library_pack_(path_invalid|invalid)/u);
    const duplicated = pack({ [lib]: 'theorem t : True := trivial\n' }) as { modules: unknown[] };
    expect(() => parseLibraryPack({ ...duplicated, modules: [...duplicated.modules, ...duplicated.modules] }))
      .toThrow('math_library_pack_duplicate_module');
    expect(() => parseLibraryPack(pack({ [lib]: 'theorem t : True := trivial\0\n' }))).toThrow('math_library_pack_source_invalid');
    expect(() => parseLibraryPack(pack({ [lib]: 'theorem t : True := trivial -- \ud800\n' }))).toThrow('math_library_pack_source_invalid');
    expect(() => parseLibraryPack(pack({ [lib]: 'import Submission.Helpers\ntheorem t : True := trivial\n' })))
      .toThrow('math_library_pack_import_outside_pack: Submission/Library/Fixture/Lemmas.lean imports Submission.Helpers');
    expect(() => parseLibraryPack(pack({ 'Submission/Library/A/X.lean': 'import Submission.Library.A.Y\n',
      'Submission/Library/A/Y.lean': 'import Submission.Library.A.X\n' }))).toThrow('math_library_pack_import_cycle');
    // The problem statement module (Challenge.lean) is never a library input, nor are owned or escaping paths.
    for (const file of ['Submission.lean', 'Submission/Helpers.lean', '../Deps.lean', 'Challenge.lean'])
      expect(() => parseLibraryPack(pack({ [lib]: 'import Deps\n' }, [{ file, digest: 'b'.repeat(64) }])), file)
        .toThrow(/math_library_pack_(requirement_invalid|invalid)/u);
    expect(() => parseLibraryPack({ ...duplicated as object, extra: true })).toThrow('math_library_pack_invalid');
  });

  it('installs new files once, checks requirement bytes and rejects unrequired local imports', () => {
    const directory = temporaryDirectory('library-pack-install-');
    try {
      fs.writeFileSync(path.join(directory, 'Deps.lean'), 'def c : Nat := 1\n');
      const ownership = { trustedFiles: ['Deps.lean'], solverOwnedFiles: ['Submission.lean'] };
      const source = 'import Deps\ntheorem c_eq : c = 1 := rfl\n';
      const required = parseLibraryPack(pack({ [lib]: source }, [{ file: 'Deps.lean', digest: mathDigest('def c : Nat := 1\n') }]));
      expect(() => installLibraryPack(directory, parseLibraryPack(pack({ [lib]: source },
        [{ file: 'Deps.lean', digest: 'b'.repeat(64) }])), ownership)).toThrow('math_library_pack_requirement_changed: Deps.lean');
      expect(() => installLibraryPack(directory, required, { ...ownership, trustedFiles: [] })).toThrow('math_library_pack_requirement_changed');
      expect(() => installLibraryPack(directory, required, { ...ownership, solverOwnedFiles: [lib] })).toThrow(`math_library_pack_collides: ${lib}`);
      expect(installLibraryPack(directory, required, ownership)).toEqual({ [lib]: mathDigest(source) });
      expect(fs.readFileSync(path.join(directory, lib), 'utf8')).toBe(source);
      expect(fs.statSync(path.join(directory, lib)).mode & 0o777).toBe(0o600);
      expect(() => installLibraryPack(directory, required, ownership)).toThrow('EEXIST');
      fs.rmSync(path.join(directory, 'Submission'), { recursive: true });
      expect(() => installLibraryPack(directory, parseLibraryPack(pack({ [lib]: source })), ownership))
        .toThrow('math_library_pack_requirement_missing: Deps.lean');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
describe('library packs from saved runs and upstream checkouts', () => {
  let directory: string, repository: string, project: string;
  const projectRelative = 'generated/p';
  const core = 'namespace Deps\ndef base : Nat := 1\nend Deps\n';
  const deps = 'import Deps.Core\nnamespace ChallengeDeps\ndef deps : Nat := Deps.base + Deps.base\ntheorem deps_eq : deps = 2 := rfl\nend ChallengeDeps\n';
  const original = 'import ChallengeDeps\nnamespace Submission\ntheorem target : ChallengeDeps.deps + ChallengeDeps.deps = 4 := by sorry\nend Submission\n';
  const seedHelpers = 'import ChallengeDeps\nnamespace Submission.Helpers\ndef seedValue : Nat := 0\nend Submission.Helpers\n';
  const helpers = ['import ChallengeDeps', 'namespace Submission.Helpers', 'def seedValue : Nat := 0',
    'theorem twice : ChallengeDeps.deps + ChallengeDeps.deps = 4 := by\n  rw [ChallengeDeps.deps_eq]', '/-- A gap the run left open. -/\n@[simp]\ntheorem bad : 1 = 2 := by sorry',
    'theorem uses_bad : 1 = 2 := bad', 'theorem uses_seed : seedValue = 0 := rfl', 'theorem fine : 3 = 3 := rfl',
    'end Submission.Helpers', ''].join('\n');
  const submission = ['import ChallengeDeps', 'import Submission.Helpers', 'namespace Submission',
    'theorem target : ChallengeDeps.deps + ChallengeDeps.deps = 4 := Helpers.twice',
    'theorem kept : ChallengeDeps.deps + ChallengeDeps.deps = 4 := Submission.Helpers.twice',
    'theorem from_bad : 1 = 2 := Submission.Helpers.bad', 'end Submission', ''].join('\n');
  let base: string, canonical: string, stateFile: string;
  const write = (file: string, source: string) => {
    fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
    fs.writeFileSync(path.join(project, file), source);
  };
  const state = (overrides: Record<string, unknown> = {}, problem: Record<string, unknown> = {}) => {
    const file = path.join(directory, `state-${fs.readdirSync(directory).length}.json`);
    fs.writeFileSync(file, JSON.stringify({ runId: 'fixture-run-1', worktree: repository, environmentDigest: 'e'.repeat(64),
      cooperation: { canonicalCommit: canonical }, ...overrides, problem: { projectRelative,
        ownedFiles: ['Submission.lean', 'Submission/Helpers.lean'], receiptDigest: 'f'.repeat(64),
        trustedFiles: { 'ChallengeDeps.lean': mathDigest(deps), 'Deps/Core.lean': mathDigest(core), 'lean-toolchain': mathDigest('x\n') },
        declarations: { 'Submission.lean': [{ name: 'target', header: 'theorem target' }],
          'Submission/Helpers.lean': [{ name: 'seedValue', header: 'def seedValue', body: 'b'.repeat(64) }] }, ...problem } }));
    return file;
  };

  beforeEach(() => {
    directory = temporaryDirectory('library-pack-runs-');
    repository = path.join(directory, 'run'); project = path.join(repository, projectRelative);
    for (const [file, source] of [['Deps/Core.lean', core], ['ChallengeDeps.lean', deps], ['lean-toolchain', 'x\n'],
      ['Submission.lean', original], ['Submission/Helpers.lean', seedHelpers]]) write(file!, source!);
    git(repository, ['init', '--quiet']);
    base = commit(repository, 'baseline');
    write('Submission/Helpers.lean', helpers); write('Submission.lean', submission);
    canonical = commit(repository, 'canonical');
    stateFile = state();
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it('extracts checked run modules without original or unproved declarations and their dependents', () => {
    const files = ['Submission/Helpers.lean', 'Submission.lean'];
    expect(() => extractRunLibraryModules({ stateFile, files })).toThrow(/math_library_extract_unproved: Submission\/Helpers\.lean bad/u);
    const extracted = extractRunLibraryModules({ stateFile, files, dropUnproved: true });
    const [main, helper] = extracted.modules;
    expect(extracted.modules.map(module => module.file)).toEqual(['Submission/Library/Runfixturerun1/Submission.lean',
      'Submission/Library/Runfixturerun1/Helpers.lean']);
    expect(lines(main!.source)).toEqual(['import ChallengeDeps', 'import Submission.Library.Runfixturerun1.Helpers', 'namespace Submission',
      'theorem kept : ChallengeDeps.deps + ChallengeDeps.deps = 4 := Submission.Helpers.twice', 'end Submission']);
    expect(lines(helper!.source)).toEqual(['import ChallengeDeps', 'namespace Submission.Helpers',
      'theorem twice : ChallengeDeps.deps + ChallengeDeps.deps = 4 := by', '  rw [ChallengeDeps.deps_eq]', 'theorem fine : 3 = 3 := rfl',
      'end Submission.Helpers']);
    expect(main!.origin).toEqual({ kind: 'run', runId: 'fixture-run-1', commit: canonical, file: 'Submission.lean',
      receiptDigest: 'f'.repeat(64), environmentDigest: 'e'.repeat(64),
      dropped: [{ name: 'target', reason: 'original' }, { name: 'from_bad', reason: 'dependent' }] });
    expect(helper!.origin).toMatchObject({ file: 'Submission/Helpers.lean', dropped: [{ name: 'seedValue', reason: 'original' },
      { name: 'bad', reason: 'unproved' }, { name: 'uses_bad', reason: 'dependent' }, { name: 'uses_seed', reason: 'dependent' }] });
    // The trusted import closure becomes digest requirements that the destination must match byte for byte.
    expect(extracted.requires).toEqual([{ file: 'ChallengeDeps.lean', digest: mathDigest(deps) }, { file: 'Deps/Core.lean', digest: mathDigest(core) }]);
    expect(summarizeLibraryPack(extracted)).toMatchObject({ digest: libraryPackDigest(extracted),
      modules: [{ declarations: 1, externalImports: ['ChallengeDeps'], origin: { dropped: 2 } },
        { declarations: 2, externalImports: ['ChallengeDeps'], origin: { dropped: 4 } }] });

    const only = extractRunLibraryModules({ stateFile, files: ['Submission/Helpers.lean'], dropUnproved: true, into: 'Squares/Basic' });
    expect(only.modules.map(module => module.file)).toEqual(['Submission/Library/Squares/Basic/Helpers.lean']);
    expect(extractRunLibraryModules({ stateFile, files: ['Submission/Helpers.lean'], commit: base }).modules[0]!.source)
      .toBe('import ChallengeDeps\nnamespace Submission.Helpers\nend Submission.Helpers\n');
  });

  it('keeps a spec run\'s own proved theorems under the module paths it is published at', () => {
    const modulePaths = { 'Submission.lean': 'Submission/Library/Auto/Spec.lean', 'Submission/Helpers.lean': 'Submission/Library/Auto/SpecHelpers.lean' };
    const extracted = extractRunLibraryModules({ stateFile, files: ['Submission.lean', 'Submission/Helpers.lean'], dropUnproved: true,
      keepOriginals: true, modulePaths });
    const [main, helper] = extracted.modules;
    expect(extracted.modules.map(module => module.file)).toEqual(Object.values(modulePaths));
    expect(lines(main!.source)).toEqual(['import ChallengeDeps', 'import Submission.Library.Auto.SpecHelpers', 'namespace Submission',
      'theorem target : ChallengeDeps.deps + ChallengeDeps.deps = 4 := Helpers.twice',
      'theorem kept : ChallengeDeps.deps + ChallengeDeps.deps = 4 := Submission.Helpers.twice', 'end Submission']);
    expect(main!.origin).toMatchObject({ dropped: [{ name: 'from_bad', reason: 'dependent' }] });
    expect(helper!.source).toContain('def seedValue : Nat := 0\n');
    expect(helper!.origin).toMatchObject({ dropped: [{ name: 'bad', reason: 'unproved' }, { name: 'uses_bad', reason: 'dependent' }] });
    for (const paths of [{ 'Submission/Other.lean': 'Submission/Library/Auto/Other.lean' }, { 'Submission.lean': 'Submission/Theory/T01.lean' }])
      expect(() => extractRunLibraryModules({ stateFile, files: ['Submission.lean', 'Submission/Helpers.lean'], modulePaths: paths }))
        .toThrow(`math_library_extract_module_path_invalid: ${Object.keys(paths)[0]}`);
  });

  it('rejects unselected owned imports, foreign files, missing commits and invalid destinations', () => {
    expect(() => extractRunLibraryModules({ stateFile, files: ['Submission.lean'], dropUnproved: true }))
      .toThrow('math_library_extract_import_not_selected: Submission.lean imports Submission.Helpers');
    for (const file of ['ChallengeDeps.lean', 'Submission/Other.lean', 'lean-toolchain'])
      expect(() => extractRunLibraryModules({ stateFile, files: [file] }), file).toThrow(`math_library_extract_not_owned: ${file}`);
    expect(() => extractRunLibraryModules({ stateFile, files: [] })).toThrow('math_library_extract_files_required');
    expect(() => extractRunLibraryModules({ stateFile: state({ cooperation: {} }), files: ['Submission/Helpers.lean'] }))
      .toThrow('math_library_extract_commit_required');
    expect(() => extractRunLibraryModules({ stateFile, files: ['Submission/Helpers.lean'], into: 'lower' })).toThrow('math_library_extract_into_invalid');
    expect(() => extractRunLibraryModules({ stateFile, files: ['Submission/Helpers.lean'], commit: 'f'.repeat(40) }))
      .toThrow('math_library_extract_source_unavailable');
    expect(() => extractRunLibraryModules({ stateFile: state({ worktree: undefined }), files: ['Submission/Helpers.lean'] }))
      .toThrow('math_library_extract_state_invalid');
  });

  it('chains a later run on an earlier pack whose frozen modules it imports', () => {
    const first = extractRunLibraryModules({ stateFile, files: ['Submission/Helpers.lean'], dropUnproved: true, into: 'First' });
    const library = first.modules[0]!.file;
    write(library, first.modules[0]!.source);
    write('Submission/Helpers.lean', 'import Submission.Library.First.Helpers\nnamespace Submission.Helpers\n' +
      'theorem twice_again : ChallengeDeps.deps + ChallengeDeps.deps = 4 := twice\nend Submission.Helpers\n');
    const later = commit(repository, 'second run');
    const second = state({ runId: 'fixture-run-2', cooperation: { canonicalCommit: later } }, {
      ownedFiles: ['Submission.lean', 'Submission/Helpers.lean', library], frozenFiles: { [library]: mathDigest(first.modules[0]!.source) },
      declarations: { 'Submission.lean': [{ name: 'target', header: 'theorem target' }], 'Submission/Helpers.lean': [],
        [library]: [{ name: 'twice', header: 'theorem twice' }, { name: 'fine', header: 'theorem fine' }] } });
    expect(() => extractRunLibraryModules({ stateFile: second, files: [library] })).toThrow('math_library_extract_frozen');
    expect(() => extractRunLibraryModules({ stateFile: second, files: ['Submission/Helpers.lean'] }))
      .toThrow('math_library_extract_base_required: Submission/Helpers.lean imports Submission.Library.First.Helpers');
    const chained = extractRunLibraryModules({ stateFile: second, files: ['Submission/Helpers.lean'], base: first, into: 'Second' });
    expect(chained.modules.map(module => module.file)).toEqual([library, 'Submission/Library/Second/Helpers.lean']);
    // Library declarations are not original goals: a helper that uses `twice` survives.
    expect(chained.modules[1]!.source).toContain('import Submission.Library.First.Helpers\n');
    expect(chained.modules[1]!.source).toContain('theorem twice_again');
    expect(chained.requires).toEqual(first.requires);
    expect(() => extractRunLibraryModules({ stateFile, files: ['Submission/Helpers.lean'], dropUnproved: true, into: 'First', base: first }))
      .toThrow('math_library_pack_duplicate_module');
  });

  it('backports upstream files verbatim with their license header and renames imports among them', () => {
    const upstream = path.join(directory, 'upstream');
    const header = '/-\nCopyright (c) Fixture Authors. All rights reserved.\nReleased under the fixture license.\n-/\n';
    const defs = `${header}module\n\n@[expose] public section\n\nnamespace Squares\ndef sq (n : Nat) : Nat := n * n\nend Squares\n\nend\n`;
    const basic = `${header}module\n\npublic import Fixture.Squares.Defs\n\n/-! # Values -/\n\n@[expose] public section\n\nnamespace Squares\n` +
      'theorem sq_two : sq 2 = 4 := rfl\nend Squares\n\nend\n';
    for (const [file, source] of [['Fixture/Squares/Defs.lean', defs], ['Fixture/Squares/Basic.lean', basic]]) {
      fs.mkdirSync(path.dirname(path.join(upstream, file)), { recursive: true });
      fs.writeFileSync(path.join(upstream, file), source);
    }
    git(upstream, ['init', '--quiet']);
    git(upstream, ['remote', 'add', 'origin', 'https://user:token@example.invalid/fixture.git']);
    const revision = commit(upstream, 'upstream');
    const files = ['Fixture/Squares/Basic.lean', 'Fixture/Squares/Defs.lean'];
    const backport = upstreamLibraryModules({ repository: upstream, commit: 'HEAD', files });
    expect(backport.modules.map(module => module.file)).toEqual(['Submission/Library/Upstream/Fixture/Squares/Basic.lean',
      'Submission/Library/Upstream/Fixture/Squares/Defs.lean']);
    expect(backport.modules[0]!.source).toBe(basic.replace('public import Fixture.Squares.Defs', 'public import Submission.Library.Upstream.Fixture.Squares.Defs'));
    expect(backport.modules[1]!.source).toBe(defs);
    expect(backport.modules[0]!.origin).toEqual({ kind: 'upstream', repository: 'https://example.invalid/fixture.git', commit: revision,
      file: 'Fixture/Squares/Basic.lean' });
    const single = upstreamLibraryModules({ repository: upstream, commit: revision, files: ['Fixture/Squares/Basic.lean'], into: 'Newer' });
    expect(summarizeLibraryPack(single).modules[0]!.externalImports).toEqual(['Fixture.Squares.Defs']);
    for (const value of ['--output=/dev/null', 'HEAD;true', ''])
      expect(() => upstreamLibraryModules({ repository: upstream, commit: value, files }), value).toThrow('math_library_upstream_commit_invalid');
    expect(() => upstreamLibraryModules({ repository: upstream, commit: 'f'.repeat(40), files })).toThrow('math_library_upstream_commit_unavailable');
    expect(() => upstreamLibraryModules({ repository: upstream, commit: 'HEAD', files: ['../x.lean'] })).toThrow('math_library_upstream_file_invalid');
    fs.writeFileSync(path.join(upstream, 'Fixture/Squares/Defs.lean'), defs.replace('def sq', 'unsafe def sq'));
    commit(upstream, 'unsafe');
    expect(() => upstreamLibraryModules({ repository: upstream, commit: 'HEAD', files })).toThrow('math_library_pack_forbidden_token');
  });

  it('writes a new pack file from the CLI, refuses to overwrite it and inspects it', () => {
    const output = path.join(directory, 'pack.json');
    const run = (...args: string[]) => spawnSync('bun', ['bin/math.ts', 'library-pack', ...args], { encoding: 'utf8', timeout: 60_000 });
    const help = run('--help');
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('Usage: theorem-os library-pack extract');
    const args = ['extract', '--state', stateFile, '--file', 'Submission/Helpers.lean', '--drop-unproved', '--output', output];
    const created = run(...args);
    expect(created.status, created.stderr).toBe(0);
    const written = parseLibraryPack(JSON.parse(fs.readFileSync(output, 'utf8')));
    expect(JSON.parse(created.stdout)).toMatchObject({ digest: libraryPackDigest(written), output });
    expect(fs.statSync(output).mode & 0o777).toBe(0o600);
    const again = run(...args);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain('EEXIST');
    const inspected = run('inspect', output);
    expect(JSON.parse(inspected.stdout)).toMatchObject({ digest: libraryPackDigest(written), modules: [{ declarations: 2 }] });
    const unproved = run('extract', '--state', stateFile, '--file', 'Submission/Helpers.lean');
    expect(unproved.status).toBe(1);
    expect(unproved.stderr).toContain('math_library_extract_unproved');
  }, 120_000);

  it.skipIf(!lean)('compiles extracted and backported modules in a destination project without axioms', () => {
    const extracted = extractRunLibraryModules({ stateFile, files: ['Submission/Helpers.lean', 'Submission.lean'], dropUnproved: true });
    const destination = path.join(directory, 'destination');
    fs.mkdirSync(path.join(destination, 'Deps'), { recursive: true });
    fs.writeFileSync(path.join(destination, 'Deps/Core.lean'), core);
    fs.writeFileSync(path.join(destination, 'ChallengeDeps.lean'), deps);
    const installed = installLibraryPack(destination, extracted, { trustedFiles: ['ChallengeDeps.lean', 'Deps/Core.lean'], solverOwnedFiles: ['Submission.lean'] });
    const probe = compileLean(destination, ['Deps/Core.lean', 'ChallengeDeps.lean', ...Object.keys(installed).toReversed()],
      'import Submission.Library.Runfixturerun1.Submission\n#print axioms Submission.kept\n');
    expect(probe.status).toBe(0);
    expect(probe.stdout).toMatch(/^'Submission\.kept' (does not depend on any axioms|depends on axioms: \[propext\])\n$/u);

    const upstream = path.join(directory, 'upstream-lean');
    fs.mkdirSync(path.join(upstream, 'Fixture'), { recursive: true });
    fs.writeFileSync(path.join(upstream, 'Fixture/Defs.lean'), 'module\n\n@[expose] public section\n\nnamespace Up\ndef sq (n : Nat) : Nat := n * n\nend Up\n\nend\n');
    fs.writeFileSync(path.join(upstream, 'Fixture/Basic.lean'), 'module\n\npublic import Fixture.Defs\n\n@[expose] public section\n\nnamespace Up\ntheorem sq_two : sq 2 = 4 := rfl\nend Up\n\nend\n');
    git(upstream, ['init', '--quiet']); commit(upstream, 'upstream');
    const backport = upstreamLibraryModules({ repository: upstream, commit: 'HEAD', files: ['Fixture/Basic.lean', 'Fixture/Defs.lean'] });
    installLibraryPack(destination, backport, { trustedFiles: [], solverOwnedFiles: ['Submission.lean', ...Object.keys(installed)] });
    // An ordinary (non-module) consumer file imports the module-system backport, as Submission.lean would.
    const consumer = compileLean(destination, ['Submission/Library/Upstream/Fixture/Defs.lean', 'Submission/Library/Upstream/Fixture/Basic.lean'],
      'import Submission.Library.Upstream.Fixture.Basic\ntheorem use : Up.sq 2 = 4 := Up.sq_two\n#print axioms use\n');
    expect(consumer.status).toBe(0);
    expect(consumer.stdout).toBe("'use' does not depend on any axioms\n");
  }, 300_000);
});
describe('frozen library modules in solver problems', () => {
  const lib = 'Submission/Library/Fixture/Lemmas.lean';
  const original = 'namespace Submission\ntheorem bound : 2 * 2 = 4 := by sorry\nend Submission\n';
  const library = '-- Proved by an earlier run.\nnamespace Submission\ntheorem two_mul_two : 2 * 2 = 4 := rfl\nend Submission\n';
  const proved = `import ${lib.slice(0, -5).replaceAll('/', '.')}\n${original.replace('by sorry', 'two_mul_two')}`;
  const goal: CooperativeTask = { id: 'goal', kind: 'goal', objective: 'Close the bound', theoremName: 'Submission.bound',
    proofPath: 'Submission.lean', dependsOn: [], revision: 0 };
  let directory: string, workspace: string, project: string, receiptFile: string, problem: SolverProblem;
  const write = (file: string, source: string) => fs.writeFileSync(path.join(project, file), source);
  const receipt = (libraryPack: unknown, owned = ['Submission.lean', lib]) => {
    const payload = canonicalMathProblemStatementPayloads({ informalStatement: 'Bound', formalStatement: original, assumptions: [] });
    const contract: MathProblemContract = { problemId: 'p', informalStatement: 'Bound', formalStatement: original,
      assumptions: [], knownTraps: [], acceptanceCriteria: ['The bound'], officialVerificationCommand: 'lake test',
      statementHash: mathDigest(payload.informal), leanStatementHash: mathDigest(payload.lean) };
    fs.writeFileSync(receiptFile, JSON.stringify({ schema: 'deepscientist.mathematics.lean-eval-bootstrap-receipt.v1', receiptId: 'fixture',
      problemId: 'p', benchmarkCommit: LEAN_EVAL_BENCHMARK_COMMIT, catalogHash: 'a'.repeat(64), leaderboardSource: 'disabled',
      contract, workspaceRoot: workspace, projectRoot: project, activeProblemPath: receiptFile, createdAt: 1,
      trustedFiles: ['Challenge.lean', 'lakefile.toml', 'lean-toolchain'], solverOwnedFiles: owned, libraryPack,
      publicObligations: [{ name: 'Submission.bound', declarationHash: hashMathFormalSourceDeclaration(original, 'Submission.bound') }] }));
  };

  beforeEach(() => {
    directory = temporaryDirectory('library-pack-freeze-');
    workspace = path.join(directory, 'public'); project = path.join(workspace, 'generated', 'p');
    receiptFile = path.join(workspace, 'active-problem.json');
    fs.mkdirSync(path.join(project, path.dirname(lib)), { recursive: true });
    for (const [file, source] of [['Submission.lean', original], ['Challenge.lean', original], [lib, library],
      ['lean-toolchain', 'leanprover/lean4:v4.35.0-rc3\n'], ['lakefile.toml', 'name = "p"\n']]) write(file!, source!);
    receipt({ digest: 'c'.repeat(64), files: { [lib]: mathDigest(library) } });
    git(workspace, ['init', '--quiet']);
    fs.mkdirSync(path.join(workspace, '.git', 'info'), { recursive: true });
    fs.appendFileSync(path.join(workspace, '.git', 'info', 'exclude'), '\n/active-problem.json\n**/.lake/\n');
    commit(workspace, 'baseline');
    problem = readSolverProblem(workspace, receiptFile);
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it('freezes library bytes, allows importing them and rejects edits and redeclarations', () => {
    expect(problem.frozenFiles).toEqual({ [lib]: mathDigest(library) });
    expect(problem.targets).toEqual([expect.objectContaining({ proofPath: 'Submission.lean', theoremName: 'Submission.bound' })]);
    expect(problem.declarations[lib]!.map(item => item.name)).toEqual(['two_mul_two']);
    expect(solverProofImports(problem, 'import Submission.Library.Fixture.Lemmas\nimport Submission.Library.Fixture.Other\n'))
      .toEqual(['Submission.Library.Fixture.Lemmas']);
    write('Submission.lean', proved);
    expect(() => assertSolverSources(problem, workspace)).not.toThrow();
    const solved = commitSolverSources(problem, workspace);
    expect(taskChanges(problem, workspace, solved, goal, { seedCommit: problem.baseCommit }).map(change => [change.file, change.name]))
      .toEqual([['Submission.lean', 'bound']]);

    // A same-named helper in an owned file shadows the library declaration and is rejected with a recovery hint.
    write('Submission.lean', proved.replace('theorem bound', 'theorem two_mul_two : 2 * 2 = 4 := by decide\ntheorem bound'));
    let error: unknown;
    try { assertSolverSources(problem, workspace); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ message: 'math_library_declaration_redeclared', proofPath: 'Submission.lean', declarationName: 'Submission.two_mul_two' });
    expect((error as { recovery: string }).recovery).toContain('already declared by a frozen Submission/Library module');

    write('Submission.lean', proved); write(lib, library.replace(':= rfl', ':= by decide'));
    expect(() => assertSolverSources(problem, workspace)).toThrow('math_library_module_changed');
    const edited = commit(workspace, 'edit the frozen library');
    expect(() => taskChanges(problem, workspace, edited, goal, { seedCommit: problem.baseCommit }))
      .toThrow(/^math_library_module_changed\nFile: generated\/p\/Submission\/Library\/Fixture\/Lemmas\.lean\n/u);
    fs.rmSync(path.join(project, lib));
    expect(() => assertSolverSources(problem, workspace)).toThrow('math_library_module_changed');
  });

  it('rejects tampered or unowned library files when reading the receipt', () => {
    write(lib, library.replace('rfl', 'by decide'));
    expect(() => readSolverProblem(workspace, receiptFile)).toThrow('math_library_pack_changed');
    write(lib, library);
    for (const [files, owned] of [[{ [lib]: mathDigest(library) }, ['Submission.lean']], [{ 'Submission.lean': mathDigest(original) }, ['Submission.lean', lib]],
      [{}, ['Submission.lean', lib]]] as const) {
      receipt({ digest: 'c'.repeat(64), files }, [...owned]);
      expect(() => readSolverProblem(workspace, receiptFile), JSON.stringify(files)).toThrow('does not own its library modules');
    }
  });

  it('keeps plans out of library files and points name collisions at the library', () => {
    const helper = { id: 'helper', kind: 'lemma', objective: 'Square', theoremName: 'Submission.helper', type: '2 * 2 = 4' };
    const target = { id: 'goal', kind: 'goal', objective: 'Close', theoremName: 'Submission.bound', dependsOn: ['helper'] };
    expect(parseCooperationPlan(problem, { tasks: [helper, target] }).tasks[0]!.proofPath).toBe('Submission.lean');
    expect(() => parseCooperationPlan(problem, { tasks: [{ ...helper, proofPath: lib }, target] }))
      .toThrow(/^math_plan_frozen_proof_path: .*Submission\/Library modules are frozen host libraries/u);
    expect(() => parseCooperationPlan(problem, { tasks: [{ ...helper, theoremName: 'Submission.two_mul_two' }, target] }))
      .toThrow(`"libraryFile":"${lib}"}. This name is already proved in a frozen Submission/Library module`);
    expect(() => parseCooperationPlan(problem, { tasks: [{ ...helper, theoremName: 'Submission.bound' }, target] }))
      .toThrow('A helper must not reuse the final name component of a frozen declaration.');
  });
});

describe('library module guidance in research prompts', () => {
  const lib = 'Submission/Library/Fixture/Lemmas.lean';
  const problem = { projectRelative: '.', ownedFiles: ['Submission.lean', lib], receiptDigest: 'problem', baseCommit: 'fixed-commit',
    targets: [{ proofPath: 'Submission.lean', theoremName: 'Submission.main' }], frozenFiles: { [lib]: 'd'.repeat(64) },
    declarations: { 'Submission.lean': [{ name: 'main', header: 'theorem main' }], [lib]: [{ name: 'two_mul_two', header: 'theorem two_mul_two' }] },
    contract: { formalStatement: 'theorem main : True := by sorry', assumptions: [] } } as unknown as SolverProblem;
  const lemma: CooperativeTask = { id: 'api', kind: 'lemma', objective: 'Basic API', theoremName: 'Submission.helper',
    type: 'True', proofPath: 'Submission.lean', dependsOn: [], revision: 0 };
  const build = (task?: CooperativeTask) => buildResearchContext(problem,
    { cooperation: { tasks: [{ task: lemma, status: 'pending', attempts: 0 }] } } as unknown as SolverRunState,
    { root: '/runtime', worktree: '/proof', environment: {}, taskText: 'Prove it', retrievalRoot: '/library', maxOptionalContextBytes: 0,
      frozenContexts: { 'Submission.lean': '' },
      assignment: task ? { kind: 'task', task, assignment: { taskId: task.id, taskDigest: taskVersion(task), workerId: 'worker',
        seedCommit: 'fixed-commit' } } : { kind: 'lead', seedCommit: 'fixed-commit' } });

  it('omits frozen libraries from editable files, proof paths and source bindings and references them once', () => {
    const lead = build();
    expect(lead.instructions).toContain('Edit only /proof/Submission.lean, /proof/RESEARCH.md.');
    expect(lead.instructions).toContain(`${lib} is a frozen host library that Lean rechecked before this run: import the module that holds a declaration`);
    expect(lead.instructions).toContain('lines whose file starts with Submission/Library/ are library declarations');
    expect(lead.instructions).toContain('Choose proofPath from ["Submission.lean"]; goals infer');
    const prover = build(lemma);
    expect(prover.instructions).toContain('Its keys must be exactly ["Submission.lean"]');
    expect(prover.message).toContain(JSON.stringify({ commit: 'fixed-commit', path: lib, digest: 'd'.repeat(64), frozenLibrary: true, declarationCount: 1 }));
    expect(prover.message).not.toContain('frozen-context:');
    expect(prover.message).not.toContain('two_mul_two');
    expect(lead.instructions).not.toContain(`/proof/${lib}`);
  });
});
