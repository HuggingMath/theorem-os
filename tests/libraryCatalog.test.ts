import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { LIBRARY_PACK_SCHEMA, MAX_LIBRARY_PACK_MODULES, type LibraryPack } from '../src/math/libraryPacks';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { readLibraryCatalog, writeLibraryCatalog } from '../src/solver/libraryCatalog';
import { webLibraryCatalog } from '../apps/web/frozenLibrary';

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });
const environment = getLeanTaskEnvironment('standard'), mathlib = getLeanTaskEnvironment('mathlib');
const base = 'Submission/Library/Demo/Base.lean', arithmetic = 'Submission/Library/Demo/Arithmetic.lean', other = 'Submission/Library/Demo/Other.lean';
const sources = {
  [base]: 'namespace Demo\ndef seed : Nat := 0\nend Demo\n',
  [arithmetic]: 'import Submission.Library.Demo.Base\nnamespace Demo\nprivate theorem secret : True := trivial\n' +
    'theorem commute (a b : Nat) : a + b = b + a := by\n  -- SOURCE_BODY_ONLY\n  exact Nat.add_comm a b\nend Demo\n',
  [other]: 'namespace Demo\ntheorem unrelated (s : String) : s.reverse.reverse = s := String.reverse_reverse s\nend Demo\n',
};
const pack: LibraryPack = { schema: LIBRARY_PACK_SCHEMA, modules: Object.entries(sources).map(([file, source]) => ({ file, source,
  origin: { kind: 'upstream', repository: 'offline-library', commit: 'a'.repeat(40), file: file.split('/').at(-1)! } })) };
const challenge = 'theorem target (x y : Nat) : x + y = y + x := by sorry\n';
function fixture(packs = [pack], env: 'standard' | 'mathlib' = 'standard') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'library-catalog-'))); roots.push(root);
  const built = writeLibraryCatalog(path.join(root, 'release'), { id: 'example/arithmetic', revision: 'v1', environment: env, packs });
  return { root, built, catalog: readLibraryCatalog(built.file, built.digest) };
}
function sourcePack(files: Record<string, string>): LibraryPack {
  return { schema: LIBRARY_PACK_SCHEMA, modules: Object.entries(files).map(([file, source]) => ({ file, source,
    origin: { kind: 'upstream', repository: 'offline-library', commit: 'a'.repeat(40), file: file.split('/').at(-1)! } })) };
}

describe('versioned library catalog consumption', () => {
  it('indexes public interfaces without reading proof objects for opening or searching', () => {
    const f = fixture(), manifest = fs.readFileSync(f.built.file, 'utf8');
    expect(manifest).not.toContain('SOURCE_BODY_ONLY');
    expect(manifest).not.toContain('Nat.add_comm a b');
    expect(f.catalog.declarationCount).toBe(3);
    fs.rmSync(path.join(path.dirname(f.built.file), 'objects'), { recursive: true });
    const reopened = readLibraryCatalog(f.built.file, f.built.digest);
    const metadata = reopened.moduleMetadata(arithmetic);
    expect(metadata.entries.some(entry => entry.name === 'Demo.commute')).toBe(true);
    expect('source' in metadata).toBe(false);
    metadata.entries.length = 0;
    expect(reopened.moduleMetadata(arithmetic).entries).not.toHaveLength(0);
    expect(reopened.search([{ query: 'Demo.commute' }])[0].hits[0]?.name).toBe('Demo.commute');
    expect(reopened.search([{ query: 'Demo.secret' }])[0].hits.some(hit => hit.name === 'Demo.secret')).toBe(false);
    expect(reopened.identity).toMatchObject({ id: 'example/arithmetic', revision: 'v1', catalogDigest: f.built.digest });
  });

  it('materializes only selected source objects and the complete dependency closure', () => {
    const f = fixture();
    fs.unlinkSync(path.join(path.dirname(f.built.file), 'objects', mathDigest(sources[other]) + '.lean'));
    const selection = f.catalog.select({ source: 'import Submission.Library.Demo.Arithmetic\n', task: '', environmentDigest: environment.dependencyDigest });
    expect(selection.modules.map(module => module.file)).toEqual([arithmetic, base]);
    const selected = f.catalog.materialize(selection)!;
    expect(selected.modules.map(module => module.source)).toEqual([sources[arithmetic], sources[base]]);
    expect(selected.modules[0].origin).toEqual(pack.modules.find(module => module.file === arithmetic)!.origin);
    expect(f.catalog.select({ source: challenge, task: 'zxqv', environmentDigest: environment.dependencyDigest }).modules.map(module => module.file))
      .toContain(arithmetic);
  });

  it('pins environment, release digest, selected version and fetched source bytes', () => {
    const f = fixture(), selection = f.catalog.select({ source: challenge, task: '', environmentDigest: environment.dependencyDigest });
    expect(() => readLibraryCatalog(f.built.file, 'b'.repeat(64))).toThrow('math_library_catalog_changed');
    expect(() => f.catalog.select({ source: challenge, task: '', environmentDigest: mathlib.dependencyDigest }))
      .toThrow('math_library_catalog_environment_changed');
    expect(() => f.catalog.materialize({ ...selection, revision: 'v2' })).toThrow('math_library_catalog_selection_changed');
    const object = path.join(path.dirname(f.built.file), 'objects', mathDigest(sources[arithmetic]) + '.lean');
    fs.chmodSync(object, 0o600); fs.writeFileSync(object, sources[arithmetic].replace('Nat.add_comm a b', 'by sorry'));
    expect(() => f.catalog.materialize(selection)).toThrow('math_library_catalog_source_changed');
  });

  it('allows only host-retained imports outside the catalog and still rejects unknown imports', () => {
    const f = fixture(), shared = 'Submission/Library/Shared/Result.lean';
    const source = 'module\npublic import Submission.Library.Shared.Result\n' + challenge;
    const input = { source, task: '', automatic: false, environmentDigest: environment.dependencyDigest, requiredFiles: [arithmetic] };
    expect(() => f.catalog.select(input)).toThrow('math_library_catalog_module_missing');
    const retainedSources = { [shared]: 'namespace Shared\nlemma result : True := by trivial\nend Shared\n' };
    expect(f.catalog.select({ ...input, retainedSources }).modules.map(module => module.file)).toEqual([arithmetic, base]);
    expect(() => f.catalog.select({ ...input, retainedSources,
      source: source.replace('Submission.Library.Shared.Result', 'Submission.Library.Shared.Unknown') }))
      .toThrow('math_library_catalog_module_missing');
  });

  it('excludes declaration conflicts and their consumers before selecting modules', () => {
    const f = fixture();
    const selection = f.catalog.select({ source: 'namespace Demo\ndef seed : Nat := 4\nend Demo\n' + challenge,
      task: 'commute', environmentDigest: environment.dependencyDigest });
    expect(selection.modules.some(module => [base, arithmetic].includes(module.file))).toBe(false);
    expect(() => f.catalog.select({ source: 'import Submission.Library.Demo.Arithmetic\nnamespace Demo\ndef seed : Nat := 4\nend Demo\n',
      task: '', environmentDigest: environment.dependencyDigest })).toThrow('math_library_catalog_declaration_conflict');
    expect(() => f.catalog.select({ source: 'import Submission.Library.Missing.Module\n', task: '', environmentDigest: environment.dependencyDigest }))
      .toThrow('math_library_catalog_module_missing');
  });

  it.each([
    'structure Shared where\n  value : Nat',
    'inductive Shared where\n  | only',
    'class Shared where\n  value : Nat',
  ])('excludes explicit type-name conflicts and their import consumers: %s', declaration => {
    const data = 'Submission/Library/Types/Data.lean', consumer = 'Submission/Library/Types/Consumer.lean';
    const f = fixture([sourcePack({
      [data]: `namespace Types.Nested\n${declaration}\ntheorem usable : True := trivial\nend Types.Nested\n`,
      [consumer]: 'import Submission.Library.Types.Data\nnamespace Types.Nested\ntheorem consumer : True := usable\nend Types.Nested\n',
    })]);
    const manifest = JSON.parse(fs.readFileSync(f.built.file, 'utf8'));
    expect(manifest.modules.find(module => module.file === data).declarations).toContain('Types.Nested.Shared');
    const source = `namespace Types.Nested\n${declaration}\ntheorem target : True := by sorry\nend Types.Nested\n`;
    expect(f.catalog.select({ source, task: 'Types.Nested.usable consumer', environmentDigest: environment.dependencyDigest }).modules)
      .toEqual([]);
    expect(() => f.catalog.select({ source: 'import Submission.Library.Types.Consumer\n' + source, task: '',
      environmentDigest: environment.dependencyDigest })).toThrow('math_library_catalog_declaration_conflict');
  });

  it('recognizes an original structure colliding with an existing library definition', () => {
    const f = fixture(), source = 'namespace Demo\nstructure seed where\n  value : Nat\nend Demo\n' + challenge;
    const selection = f.catalog.select({ source, task: 'Demo.commute', environmentDigest: environment.dependencyDigest });
    expect(selection.modules.some(module => [base, arithmetic].includes(module.file))).toBe(false);
    expect(() => f.catalog.select({ source: 'import Submission.Library.Demo.Arithmetic\n' + source, task: '',
      environmentDigest: environment.dependencyDigest })).toThrow('math_library_catalog_declaration_conflict');
  });

  it('keeps private theorem, definition and type names out of both sides of conflict detection', () => {
    const data = 'Submission/Library/Types/LocalNames.lean';
    const f = fixture([sourcePack({ [data]: 'namespace Types\n' +
      'private theorem hiddenTheorem : True := trivial\nprivate def hiddenDefinition : Nat := 0\n' +
      'private structure HiddenStructure where\n  value : Nat\nprivate inductive HiddenInductive where\n  | only\n' +
      'structure Shared where\n  value : Nat\ntheorem usable : True := trivial\nend Types\n' })]);
    const manifest = JSON.parse(fs.readFileSync(f.built.file, 'utf8'));
    expect(manifest.modules[0].declarations).toEqual(['Types.Shared', 'Types.usable']);
    const source = 'import Submission.Library.Types.LocalNames\nnamespace Types\n' +
      'theorem hiddenTheorem : True := by sorry\ndef hiddenDefinition : Nat := 2\n' +
      'structure HiddenStructure where\n  value : Nat\ninductive HiddenInductive where\n  | only\n' +
      'private structure Shared where\n  other : Nat\nprivate theorem usable : True := by sorry\nend Types\n';
    const selection = f.catalog.select({ source, task: '', environmentDigest: environment.dependencyDigest });
    expect(selection.modules.map(module => module.file)).toEqual([data]);
    expect(f.catalog.materialize(selection)!.modules[0].file).toBe(data);
  });

  it('honors module defaults and public-section visibility for explicit type names', () => {
    const data = 'Submission/Library/Types/Visibility.lean';
    const f = fixture([sourcePack({ [data]: 'module\nnamespace Types\nstructure Hidden where\n  value : Nat\n' +
      'public structure Exported where\n  value : Nat\npublic section\nclass SectionVisible where\n  value : Nat\nend\nend Types\n' })]);
    const manifest = JSON.parse(fs.readFileSync(f.built.file, 'utf8'));
    expect(manifest.modules[0].declarations).toEqual(['Types.Exported', 'Types.SectionVisible']);
    const source = 'module\nimport Submission.Library.Types.Visibility\nnamespace Types\nstructure Exported where\n  value : Nat\nend Types\n';
    expect(f.catalog.select({ source, task: '', environmentDigest: environment.dependencyDigest }).modules.map(module => module.file))
      .toEqual([data]);
    expect(() => f.catalog.select({ source: source.replace('structure Exported', 'public structure Exported'), task: '',
      environmentDigest: environment.dependencyDigest })).toThrow('math_library_catalog_declaration_conflict');
  });

  it('rejects public name collisions across packs while permitting private overlaps', () => {
    const first = 'Submission/Library/Variants/First.lean', second = 'Submission/Library/Variants/Second.lean';
    const source = 'namespace Variants\ntheorem shared : True := trivial\nend Variants\n';
    expect(() => fixture([sourcePack({ [first]: source }), sourcePack({ [second]: source })]))
      .toThrow('math_library_catalog_duplicate_declaration');
    const hidden = source.replace('theorem shared', 'private theorem shared');
    const f = fixture([sourcePack({ [first]: hidden }), sourcePack({ [second]: hidden })]);
    const selection = f.catalog.select({ source: 'import Submission.Library.Variants.First\nimport Submission.Library.Variants.Second\n',
      task: '', environmentDigest: environment.dependencyDigest });
    expect(f.catalog.materialize(selection)!.modules).toHaveLength(2);
  });

  it('accepts a catalog larger than the task installation limit and bounds the selected pack', () => {
    const modules = Array.from({ length: 300 }, (_, index) => ({ file: `Submission/Library/Large/M${index}.lean`,
      source: `namespace Large.M${index}\ntheorem reflexivity (n : Nat) : n = n := rfl\nend Large.M${index}\n`,
      origin: { kind: 'upstream' as const, repository: 'offline-library', commit: 'c'.repeat(40), file: `M${index}.lean` } }));
    const f = fixture([{ schema: LIBRARY_PACK_SCHEMA, modules: modules.slice(0, 200) },
      { schema: LIBRARY_PACK_SCHEMA, modules: modules.slice(200) }]);
    expect(f.catalog.moduleCount).toBe(300);
    const selection = f.catalog.select({ source: 'theorem t (n : Nat) : n = n := by sorry', task: 'Large.M299.reflexivity',
      environmentDigest: environment.dependencyDigest });
    expect(selection.modules.length).toBeLessThanOrEqual(4);
    expect(f.catalog.materialize(selection)!.modules.length).toBe(selection.modules.length);
    expect(() => f.catalog.materialize({ ...selection, modules: modules.map(module => ({ file: module.file, sha256: mathDigest(module.source) })) }))
      .toThrow('math_library_catalog_installation_budget');
  });

  it('covers separate target modules before filling alternatives for one target', () => {
    const f = fixture();
    const selection = f.catalog.select({ source: 'theorem first (a b : Nat) : a + b = b + a := by sorry\n' +
      'theorem second (s : String) : s.reverse.reverse = s := by sorry\n', task: '', rootLimit: 2, environmentDigest: environment.dependencyDigest });
    expect(selection.roots).toContain(arithmetic);
    expect(selection.roots).toContain(other);
  });

  it('prioritizes task names before original goals fill the automatic module quota', () => {
    const files = ['Nat', 'Bool', 'Int', 'String'].map(type => `Submission/Library/Mentioned/${type}Case.lean`);
    const named = 'Submission/Library/Mentioned/Named.lean';
    const f = fixture([sourcePack(Object.fromEntries([
      ...files.map((file, i) => [file, `namespace Mentioned.${['Nat', 'Bool', 'Int', 'String'][i]}Case\n` +
        `theorem reflexivity (x : ${['Nat', 'Bool', 'Int', 'String'][i]}) : x = x := rfl\nend\n`]),
      [named, 'namespace Explicit\ndef payload : Prop := True\ntheorem named_hint : payload := True.intro\nend Explicit\n'],
    ]))]);
    const source = ['Nat', 'Bool', 'Int', 'String'].map((type, i) =>
      `theorem target_${i} (x : ${type}) : x = x := by sorry\n`).join('');
    const original = f.catalog.select({ source, task: '', environmentDigest: environment.dependencyDigest });
    expect(original.roots).toEqual([...files].sort());
    const selection = f.catalog.select({ source, task: 'Use _root_.Explicit.named_hint and Explicit.payload.',
      environmentDigest: environment.dependencyDigest });
    expect(selection.modules.map(module => module.file)).toContain(named);
    expect(selection.roots).toHaveLength(4);
    const limited = f.catalog.select({ source, task: 'Use Explicit.payload and Mentioned.StringCase.reflexivity.',
      rootLimit: 1, environmentDigest: environment.dependencyDigest });
    expect(limited.roots).toEqual([named]);
    const required = f.catalog.select({ source: files.map(file => `import ${file.slice(0, -5).replaceAll('/', '.')}\n`).join('') + source,
      task: 'Use Explicit.named_hint.', rootLimit: 1, environmentDigest: environment.dependencyDigest });
    expect(required.roots).toEqual([...files, named].sort());
  });

  it('locates type-only modules by qualified names using metadata, without fabricating theorem interfaces', () => {
    const data = 'Submission/Library/Types/Data.lean', base = 'Submission/Library/Types/Base.lean';
    const dataSource = 'import Submission.Library.Types.Base\nnamespace Types\nstructure Box where\n  value : Base\n' +
      'class Capable where\n  enabled : Bool\ninductive Flag where\n  | yes\n' +
      'private structure Hidden where\n  value : Nat\nend Types\n';
    const f = fixture([sourcePack({
      [base]: 'namespace Types\nstructure Base where\n  value : Nat\nend Types\n',
      [data]: dataSource,
    })]);
    expect(f.catalog.declarationCount).toBe(0);
    fs.rmSync(path.join(path.dirname(f.built.file), 'objects'), { recursive: true });
    const catalog = readLibraryCatalog(f.built.file, f.built.digest);
    const result = catalog.search([{ query: 'Use _root_.Types.Box, Types.Capable and Types.Flag. Types.Box' }])[0];
    expect(result.hits).toEqual([]);
    expect(result.namedReferences).toEqual(['Types.Box', 'Types.Capable', 'Types.Flag'].map(name => ({
      name, file: data, import: 'import Submission.Library.Types.Data', sourceDigest: mathDigest(dataSource),
    })));
    expect(catalog.search([{ query: 'Types.Hidden Box Wrong.Types.Box Types.Box.child' }])[0].namedReferences).toEqual([]);
    expect(catalog.search([{ query: 'Types.Flag Types.Capable' }], { limit: 1 })[0].namedReferences.map(item => item.name)).toEqual(['Types.Flag']);
    expect(catalog.search([{ query: '', goal: 'Types.Box → Prop' }])[0].namedReferences[0]?.file).toBe(data);
    const selection = catalog.select({ source: '', task: 'Use Types.Box, Types.Capable and Types.Flag.', rootLimit: 1,
      environmentDigest: environment.dependencyDigest });
    expect(selection.roots).toEqual([data]);
    expect(selection.modules.map(module => module.file)).toEqual([base, data]);
  });

  it('selects distinct matching modules before a dense module fills the declaration result limit', () => {
    const hot = 'Submission/Library/Crowding/Hot.lean', fallback = 'Submission/Library/Crowding/Fallback.lean';
    const f = fixture([sourcePack({
      [hot]: 'namespace Crowding.Hot\n' + Array.from({ length: 40 }, (_, i) =>
        `theorem crowd_rare_${i} : True := True.intro\n`).join('') + 'end Crowding.Hot\n',
      [fallback]: 'namespace Crowding.Fallback\ntheorem crowd_fallback : True := True.intro\nend Crowding.Fallback\n',
    })]);
    const result = f.catalog.search([{ query: 'crowd rare' }], { limit: 32 })[0];
    expect(result.total).toBe(41);
    expect(result.hits).toHaveLength(32);
    expect(result.hits.every(hit => hit.file === hot)).toBe(true);
    const selection = f.catalog.select({ source: '', task: 'crowd rare', rootLimit: 2, environmentDigest: environment.dependencyDigest });
    expect(selection.roots).toEqual([fallback, hot]);
    expect(f.catalog.materialize(selection)!.modules.map(module => module.file)).toEqual([fallback, hot]);
  });

  it('does not spend another root slot on a target already covered by an installed dependency', () => {
    const shared = 'Submission/Library/Fairness/Shared.lean', first = 'Submission/Library/Fairness/First.lean',
      last = 'Submission/Library/Fairness/Last.lean';
    const f = fixture([sourcePack({
      [shared]: 'namespace Fairness.Shared\ntheorem nat_case (n : Nat) : n = n := rfl\nend Fairness.Shared\n',
      [first]: 'import Submission.Library.Fairness.Shared\nnamespace Fairness.First\ntheorem bool_case (b : Bool) : b = b := rfl\nend Fairness.First\n',
      [last]: 'namespace Fairness.Last\ntheorem string_case (s : String) : s = s := rfl\nend Fairness.Last\n',
    })]);
    const source = 'theorem first_target (b : Bool) : b = b := by sorry\n' +
      'theorem second_target (n : Nat) : n = n := by sorry\n' +
      'theorem third_target (s : String) : s = s := by sorry\n';
    const selection = f.catalog.select({ source, task: '', rootLimit: 2, environmentDigest: environment.dependencyDigest });
    expect(selection.roots).toEqual([first, last]);
    expect(selection.modules.map(module => module.file)).toEqual([first, last, shared]);
    expect(f.catalog.materialize(selection)!.modules).toHaveLength(3);
  });

  it('tries a fitting module after omitting one dense module whose dependency closure exceeds the budget', () => {
    const hot = 'Submission/Library/Budget/Hot.lean', fallback = 'Submission/Library/Budget/Fallback.lean',
      existing = 'Submission/Library/Budget/Existing.lean';
    const dependencies = Object.fromEntries(Array.from({ length: MAX_LIBRARY_PACK_MODULES - 1 }, (_, i) => [
      `Submission/Library/Budget/Deps/D${i}.lean`,
      `namespace Budget.Dependency${i}\ndef marker : Nat := 0\nend Budget.Dependency${i}\n`,
    ]));
    const imports = Object.keys(dependencies).map(file => `import ${file.slice(0, -5).replaceAll('/', '.')}\n`).join('');
    const f = fixture([sourcePack({ ...dependencies,
      [hot]: imports + 'namespace Budget.Hot\n' + Array.from({ length: 40 }, (_, i) =>
        `theorem crowd_rare_${i} : True := True.intro\n`).join('') + 'end Budget.Hot\n',
    }), sourcePack({
      [fallback]: 'namespace Budget.Fallback\ntheorem crowd_fallback : True := True.intro\nend Budget.Fallback\n',
      [existing]: 'namespace Budget.Existing\ndef marker : Nat := 0\nend Budget.Existing\n',
    })]);
    const selection = f.catalog.select({ source: 'import Submission.Library.Budget.Existing\n', task: 'crowd rare',
      environmentDigest: environment.dependencyDigest });
    expect(selection.omitted).toEqual([{ file: hot, reason: 'installation-budget' }]);
    expect(selection.modules.map(module => module.file)).toEqual([existing, fallback]);
    expect(f.catalog.materialize(selection)!.modules).toHaveLength(2);
    const named = f.catalog.select({ source: 'import Submission.Library.Budget.Existing\n', task: 'Budget.Hot.crowd_rare_0 crowd rare',
      rootLimit: 1, environmentDigest: environment.dependencyDigest });
    expect(named.omitted).toEqual([{ file: hot, reason: 'installation-budget' }]);
    expect(named.modules.map(module => module.file)).toEqual([existing, fallback]);
  });

  it('allows the workbench to use another exact pinned release', () => {
    const f = fixture([pack], 'mathlib');
    expect(() => webLibraryCatalog({ THEOREMOS_LIBRARY_CATALOG: f.built.file })).toThrow('web_library_catalog_pin_missing');
    const catalog = webLibraryCatalog({ THEOREMOS_LIBRARY_CATALOG: f.built.file, THEOREMOS_LIBRARY_CATALOG_SHA256: f.built.digest });
    expect(catalog.identity.id).toBe('example/arithmetic');
    expect(catalog.materialize(catalog.select({ source: challenge, task: '', environmentDigest: mathlib.dependencyDigest }))!.modules
      .some(module => module.file === arithmetic)).toBe(true);
  });

  it('exposes build, metadata search and frozen pack selection through the CLI', () => {
    const f = fixture(), source = path.join(f.root, 'Target.lean'), output = path.join(f.root, 'selected.json');
    fs.writeFileSync(source, challenge);
    const run = (...args: string[]) => spawnSync('bun', [path.resolve('bin/math.ts'), 'library-catalog', ...args], { encoding: 'utf8' });
    const inspected = run('inspect', '--catalog', f.built.file, '--sha256', f.built.digest);
    expect(inspected.status, inspected.stderr).toBe(0);
    expect(JSON.parse(inspected.stdout)).toMatchObject({ id: 'example/arithmetic', modules: 3 });
    const selected = run('select', '--catalog', f.built.file, '--sha256', f.built.digest, '--source', source, '--output', output);
    expect(selected.status, selected.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(output + '.lock.json', 'utf8'))).toMatchObject({ catalogDigest: f.built.digest, revision: 'v1' });
    const selectedPack = JSON.parse(fs.readFileSync(output, 'utf8'));
    expect(selectedPack.modules.some(module => module.file === arithmetic)).toBe(true);
    const newCatalog = path.join(f.root, 'copied-release');
    const built = run('build', '--pack', output, '--id', 'example/copy', '--revision', 'v2', '--environment', 'standard', '--output', newCatalog);
    expect(built.status, built.stderr).toBe(0);
    const searched = run('search', '--catalog', path.join(newCatalog, 'catalog.json'), '--query', 'Demo.commute');
    expect(searched.status, searched.stderr).toBe(0);
    expect(JSON.parse(searched.stdout).hits[0]?.name).toBe('Demo.commute');
  });
});
