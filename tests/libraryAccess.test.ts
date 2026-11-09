import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { LIBRARY_PACK_SCHEMA, MAX_LIBRARY_PACK_BYTES, MAX_LIBRARY_PACK_MODULES, type LibraryPack } from '../src/math/libraryPacks';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { agentLibrary, LIBRARY_ACCESS_FILE, LIBRARY_REQUEST_FILE, LibraryInstallationRequested,
  requestedLibraryPack, takeLibraryRequest, writeLibraryAccess } from '../src/solver/libraryAccess';
import { readLibraryCatalog, writeLibraryCatalog } from '../src/solver/libraryCatalog';
import { git, readSolverProblem } from '../src/solver/problem';
import { temporaryDirectory } from './helpers/files';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
const foundation = 'Submission/Library/Access/Foundation.lean';
const installed = 'Submission/Library/Access/Installed.lean';
const support = 'Submission/Library/Access/Support.lean';
const requested = 'Submission/Library/Access/Quantified.lean';
const types = 'Submission/Library/Access/Types.lean';
const unrelated = 'Submission/Library/Access/Unrelated.lean';
const sources: Record<string, string> = {
  [foundation]: 'namespace Access.Foundation\ndef seed : Nat := 0\nend Access.Foundation\n',
  [installed]: 'import Submission.Library.Access.Foundation\nnamespace Access\n' +
    'theorem existing (n : Nat) : n + 0 = n := Nat.add_zero n\nend Access\n',
  [support]: 'import Submission.Library.Access.Foundation\nnamespace Access.Support\n' +
    'def value (n : Nat) : Nat := Access.Foundation.seed + n\nend Access.Support\n',
  [requested]: 'import Submission.Library.Access.Support\nnamespace Access\nsection\n' +
    'variable {α : Type} (predicate : α → Prop) (hall : ∀ x, predicate x)\n' +
    ('-- 全部假设与证明上下文必须完整保留 🙂\n'.repeat(120)) +
    'private theorem hidden : True := trivial\n' +
    'theorem all_hold (x : α) : predicate x := hall x\nend\nend Access\n',
  [types]: 'import Submission.Library.Access.Support\nnamespace Access\nstructure Box where\n  value : Nat\nend Access\n',
  [unrelated]: 'namespace Access\ntheorem reverse_twice (xs : List Nat) : xs.reverse.reverse = xs := List.reverse_reverse xs\nend Access\n',
};
const challenge = 'namespace Current\ntheorem target (n : Nat) : n + 0 = n := by sorry\nend Current\n';
const environmentDigest = getLeanTaskEnvironment('standard').dependencyDigest;

function sourcePack(files: Record<string, string>): LibraryPack {
  return { schema: LIBRARY_PACK_SCHEMA, modules: Object.entries(files).map(([file, source]) => ({ file, source,
    origin: { kind: 'upstream', repository: 'offline-access-fixture', commit: 'a'.repeat(40), file: path.basename(file) } })) };
}

function fixture(options: { packs?: LibraryPack[]; frozen?: string[]; frozenPack?: LibraryPack; source?: string } = {}) {
  const root = temporaryDirectory('library-access-'); roots.push(root);
  const packs = options.packs ?? [sourcePack(sources)];
  const built = writeLibraryCatalog(path.join(root, 'release'), {
    id: 'fixture/full-library', revision: 'v1', environment: 'standard', packs,
  });
  const allModules = new Map(packs.flatMap(pack => pack.modules).map(module => [module.file, module]));
  const frozen = options.frozen ?? [foundation, installed];
  const receipt = bootstrapLeanTask(path.join(root, 'workspace'), { source: options.source ?? challenge,
    task: 'Prove the original target.', ...(options.frozenPack || frozen.length ? {
      libraryPack: options.frozenPack ?? { schema: LIBRARY_PACK_SCHEMA, modules: frozen.map(file => allModules.get(file)!) },
    } : {}) });
  const problem = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath);
  const access = { file: built.file, digest: built.digest }, worktree = receipt.workspaceRoot;
  writeLibraryAccess(problem, worktree, access);
  return { root, built, access, receipt, problem, worktree, library: agentLibrary(worktree) };
}

function requestValue(f: ReturnType<typeof fixture>) {
  return JSON.parse(fs.readFileSync(path.join(f.worktree, LIBRARY_REQUEST_FILE), 'utf8'));
}

function frozenState(f: ReturnType<typeof fixture>) {
  const files = [f.receipt.activeProblemPath, path.join(f.worktree, LIBRARY_ACCESS_FILE),
    path.join(f.receipt.projectRoot, 'Submission.lean'),
    ...Object.keys(f.problem.frozenFiles ?? {}).map(file => path.join(f.receipt.projectRoot, file))];
  return { head: git(f.worktree, ['rev-parse', 'HEAD']), frozenFiles: { ...f.problem.frozenFiles },
    files: Object.fromEntries(files.map(file => [file, fs.readFileSync(file, 'utf8')])) };
}

describe('agent access to the complete pinned library', () => {
  it('searches uninstalled declarations and type-only modules using metadata without opening source objects', () => {
    const f = fixture();
    fs.rmSync(path.join(f.root, 'release', 'objects'), { recursive: true });
    const library = agentLibrary(f.worktree);
    expect(library.search('_root_.Access.all_hold').hits[0]).toMatchObject({ name: 'Access.all_hold',
      file: requested, import: 'import Submission.Library.Access.Quantified', sourceDigest: mathDigest(sources[requested]),
      installation: 'not-installed' });
    expect(library.search('Access.existing').hits[0]).toMatchObject({ name: 'Access.existing', installation: 'installed-frozen' });
    expect(library.search('Access.Box').namedReferences).toEqual([expect.objectContaining({ name: 'Access.Box',
      file: types, installation: 'not-installed' })]);
    expect(library.search('', 'forall (x : Nat), x + 0 = x').hits.some(hit => hit.name === 'Access.existing')).toBe(true);
    expect(library.search('Access.hidden').hits.some(hit => hit.name === 'Access.hidden')).toBe(false);
  });

  it('returns exact UTF-8-bounded pages that reconstruct the full module, including section assumptions and proof', () => {
    const f = fixture(), maxBytes = 1800;
    let offset = 0, text = '', pages = 0;
    for (;;) {
      const page = f.library.get('_root_.Access.all_hold', offset, maxBytes);
      expect(Buffer.byteLength(JSON.stringify(page)) + 1).toBeLessThanOrEqual(maxBytes);
      expect(page.declaration).toMatchObject({ name: 'Access.all_hold', file: requested, kind: 'lemma' });
      expect(page.installation).toBe('not-installed');
      expect(page.source.offset).toBe(offset);
      expect(page.source.text).toBe(sources[requested].slice(offset, offset + page.source.text.length));
      expect(page.source.text).not.toMatch(/[\uD800-\uDBFF]$/u);
      text += page.source.text; pages++;
      if (page.source.complete) {
        expect(page.source.nextOffset).toBeNull();
        break;
      }
      expect(page.source.nextOffset).toBeGreaterThan(offset);
      offset = page.source.nextOffset!;
    }
    expect(pages).toBeGreaterThan(1);
    expect(text).toBe(sources[requested]);
    expect(text).toContain('variable {α : Type} (predicate : α → Prop) (hall : ∀ x, predicate x)');
    expect(text).toContain('predicate x := hall x');
    expect(f.library.get('Access.all_hold', text.length, maxBytes).source).toMatchObject({ text: '', complete: true, nextOffset: null });
    expect(f.library.get('Access.Box').declaration.kind).toBe('type');
    expect(f.library.get('Access.Box').source.text).toBe(sources[types]);
  });

  it('rejects invalid source offsets, split surrogate pairs, page budgets and unknown or private declarations', () => {
    const f = fixture(), splitEmoji = sources[requested].indexOf('🙂') + 1;
    for (const offset of [-1, 0.5, Number.NaN, sources[requested].length + 1, splitEmoji])
      expect(() => f.library.get('Access.all_hold', offset)).toThrow('library_source_offset');
    for (const budget of [1023, 32001, 1600.5, Number.NaN])
      expect(() => f.library.get('Access.all_hold', 0, budget)).toThrow('library_source_budget');
    for (const name of ['Access.missing', 'Access.hidden'])
      expect(() => f.library.get(name)).toThrow('math_library_catalog_declaration_missing');
  });

  it('checks source bytes against the pinned catalog before returning them', () => {
    const f = fixture(), object = path.join(f.root, 'release', 'objects', mathDigest(sources[requested]) + '.lean');
    fs.chmodSync(object, 0o600);
    fs.writeFileSync(object, sources[requested].replace('hall x', 'by exact hall x'));
    expect(() => f.library.get('Access.all_hold')).toThrow('math_library_catalog_source_changed');
  });

  it('enforces query and result budgets', () => {
    const f = fixture();
    expect(() => f.library.search(' \n ', ' ')).toThrow('library_search_requires_query_or_goal');
    for (const limit of [0, -1, 33, 1.5, Number.NaN])
      expect(() => f.library.search('Access.all_hold', undefined, limit)).toThrow('library_search_limit');
    expect(f.library.search('Access', undefined, 1).hits.length).toBeLessThanOrEqual(1);
  });

  it('queues a normalized request without changing frozen files, receipt, proof work or HEAD', () => {
    const f = fixture();
    fs.appendFileSync(path.join(f.receipt.projectRoot, 'Submission.lean'), '-- saved agent work\n');
    const before = frozenState(f);
    const result = f.library.request(['_root_.Access.all_hold', 'Access.all_hold', 'Access.Box'], 'Need the quantified result and its data type.');
    const request = requestValue(f);
    expect(result).toMatchObject({ status: 'queued', requestDigest: mathDigest(canonicalMathJson(request)) });
    expect(request).toMatchObject({ catalogDigest: f.access.digest, problemReceiptDigest: f.problem.receiptDigest,
      seedCommit: before.head, names: ['Access.all_hold', 'Access.Box'], reason: 'Need the quantified result and its data type.' });
    expect(frozenState(f)).toEqual(before);
    expect(fs.statSync(path.join(f.worktree, LIBRARY_ACCESS_FILE)).mode & 0o777).toBe(0o400);
    expect(fs.existsSync(path.join(f.receipt.projectRoot, requested))).toBe(false);
    expect(f.library.search('Access.all_hold').hits[0]?.installation).toBe('not-installed');
    const pending = takeLibraryRequest(f.problem, f.worktree, f.access);
    expect(pending).toBeInstanceOf(LibraryInstallationRequested);
    expect(pending?.request).toEqual(request);
    expect(frozenState(f)).toEqual(before);
  });

  it('reports already-installed requests and rejects unknown or private names without writing a queue', () => {
    const f = fixture(), before = frozenState(f), file = path.join(f.worktree, LIBRARY_REQUEST_FILE);
    expect(takeLibraryRequest(f.problem, f.worktree, f.access)).toBeUndefined();
    expect(f.library.request(['Access.existing'], 'Already available.')).toMatchObject({ status: 'already-installed' });
    for (const name of ['Access.missing', 'Access.hidden'])
      expect(() => f.library.request([name], 'Need this declaration.')).toThrow('math_library_catalog_declaration_missing');
    expect(fs.existsSync(file)).toBe(false);
    expect(frozenState(f)).toEqual(before);
  });

  it('rejects malformed or oversized requests before queueing', () => {
    const f = fixture(), before = frozenState(f);
    for (const names of [[], [''], Array.from({ length: 9 }, (_, i) => `Access.name${i}`)])
      expect(() => f.library.request(names, 'Need a reusable declaration.')).toThrow();
    for (const reason of [' ', 'x'.repeat(2001)])
      expect(() => f.library.request(['Access.all_hold'], reason)).toThrow();
    expect(fs.existsSync(path.join(f.worktree, LIBRARY_REQUEST_FILE))).toBe(false);
    expect(frozenState(f)).toEqual(before);
  });
});

describe('host validation of requested frozen continuations', () => {
  it('retains shared modules from the exact seed while extending a catalog pack with their original imports intact', () => {
    const sharedBase = 'Submission/Library/Shared/Base.lean', shared = 'Submission/Library/Shared/Result.lean';
    const sharedSources = {
      [sharedBase]: 'import Submission.Library.Access.Installed\nnamespace Shared\nlemma base : True := by trivial\nend Shared\n',
      [shared]: 'import Submission.Library.Shared.Base\nnamespace Shared\nlemma result : True := by exact base\nend Shared\n-- 原始共享源码 🙂\n',
    };
    const f = fixture({ frozenPack: sourcePack({ [foundation]: sources[foundation], [installed]: sources[installed], ...sharedSources }),
      source: 'module\npublic import Submission.Library.Shared.Result\n' + challenge });
    // A mutable working copy must never become the source of a new frozen problem.
    fs.appendFileSync(path.join(f.receipt.projectRoot, shared), '-- later working copy\n');
    const before = frozenState(f);
    f.library.request(['Access.all_hold'], 'Extend the built-in library without replacing the selected shared library.');
    const result = requestedLibraryPack(f.problem, requestValue(f), f.access, f.worktree);
    expect(result.selection.modules.map(module => module.file)).toEqual([foundation, installed, requested, support].sort());
    expect(result.pack.modules.map(module => module.file).sort()).toEqual([foundation, installed, requested, support, sharedBase, shared].sort());
    for (const [file, source] of Object.entries(sharedSources)) {
      const module = result.pack.modules.find(module => module.file === file)!;
      expect(module.source).toBe(source);
      expect(mathDigest(module.source)).toBe(f.problem.frozenFiles![file]);
      expect(module.origin).toMatchObject({ commit: f.problem.baseCommit, file: path.posix.join(f.problem.projectRelative, file) });
    }
    expect(frozenState(f)).toEqual(before);
  });

  it('rejects a retained shared source whose bytes do not match the trusted frozen identity', () => {
    const shared = 'Submission/Library/Shared/Result.lean';
    const f = fixture({ frozenPack: sourcePack({ [shared]: 'lemma shared : True := by trivial\n' }) });
    f.library.request(['Access.all_hold'], 'Request a new catalog declaration.');
    expect(() => requestedLibraryPack({ ...f.problem, frozenFiles: { [shared]: 'b'.repeat(64) } }, requestValue(f), f.access, f.worktree))
      .toThrow('math_library_request_existing_module_changed');
  });

  it.each([
    'namespace Access\nlemma all_hold : True := by trivial\nend Access\n',
    'namespace Access\nstructure Box where\n  value : Nat\nend Access\n',
  ])('rejects a catalog extension that redeclares a retained shared name: %s', sharedSource => {
    const shared = 'Submission/Library/Shared/Conflicting.lean';
    const f = fixture({ frozenPack: sourcePack({ [shared]: sharedSource }) });
    f.library.request(['Access.all_hold', 'Access.Box'], 'The new catalog modules must not collide with the shared pack.');
    expect(() => requestedLibraryPack(f.problem, requestValue(f), f.access, f.worktree)).toThrow('math_library_catalog_declaration_conflict');
  });

  it('retains the complete old pack, adds the requested dependency closure, and does not select unrelated goal matches', () => {
    const f = fixture(), before = frozenState(f);
    f.library.request(['Access.all_hold'], 'Use the quantified declaration.');
    const result = requestedLibraryPack(f.problem, requestValue(f), f.access, f.worktree);
    expect(result.selection.modules.map(module => module.file)).toEqual([foundation, installed, requested, support].sort());
    expect(result.pack.modules.map(module => module.file)).not.toContain(types);
    expect(result.pack.modules.map(module => module.file)).not.toContain(unrelated);
    for (const module of result.pack.modules) expect(module.source).toBe(sources[module.file]);
    for (const file of Object.keys(f.problem.frozenFiles!))
      expect(mathDigest(result.pack.modules.find(module => module.file === file)!.source)).toBe(f.problem.frozenFiles![file]);
    expect(frozenState(f)).toEqual(before);
    expect(fs.existsSync(path.join(f.receipt.projectRoot, requested))).toBe(false);
  });

  it('allows a request from the published seed after the agent saves a later proof commit', () => {
    const f = fixture(), seed = git(f.worktree, ['rev-parse', 'HEAD']);
    fs.appendFileSync(path.join(f.receipt.projectRoot, 'Submission.lean'), '-- retained later proof work\n');
    git(f.worktree, ['add', '--', path.join(f.problem.projectRelative, 'Submission.lean')]);
    git(f.worktree, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '--no-gpg-sign', '--quiet', '-m', 'Save proof work']);
    const before = frozenState(f);
    expect(before.head).not.toBe(seed);
    f.library.request(['Access.all_hold'], 'Need a new declaration after saving progress.');
    expect(requestValue(f).seedCommit).toBe(seed);
    expect(requestedLibraryPack(f.problem, requestValue(f), f.access, f.worktree).pack.modules.some(module => module.file === requested)).toBe(true);
    expect(frozenState(f)).toEqual(before);
  });

  it('checks module-private lexical conflicts against the same policy as a new bootstrap', () => {
    const original = 'module\nnamespace Access\ntheorem all_hold : True := by trivial\n' +
      'public theorem target : True := by sorry\nend Access\n';
    const f = fixture({ source: original });
    f.library.request(['Access.all_hold'], 'Request the public theorem, whose lexical name still conflicts with the original.');
    expect(() => requestedLibraryPack(f.problem, requestValue(f), f.access, f.worktree))
      .toThrow('math_library_catalog_declaration_conflict');
    expect(f.problem.contract.formalStatement).toBe(original);
  });

  it.each(['module\n', 'prelude\nmodule\n'])('retains original header and explicit imports while adding required files (%s)', header => {
    const original = header + 'public import Submission.Library.Access.Installed\nnamespace Current\n' +
      'public theorem target : True := by sorry\nend Current\n';
    const f = fixture({ source: original });
    f.library.request(['Access.all_hold'], 'Use the public interface with the original header intact.');
    const result = requestedLibraryPack(f.problem, requestValue(f), f.access, f.worktree);
    expect(result.pack.modules.map(module => module.file).sort()).toEqual([foundation, installed, support, requested].sort());
    expect(f.problem.contract.formalStatement).toBe(original);
  });

  it('rejects changed request catalog or receipt identities and a changed catalog pin', () => {
    const f = fixture(), before = frozenState(f);
    f.library.request(['Access.all_hold'], 'Need the quantified declaration.');
    const request = requestValue(f);
    for (const changed of [{ catalogDigest: 'b'.repeat(64) }, { problemReceiptDigest: 'c'.repeat(64) }])
      expect(() => requestedLibraryPack(f.problem, { ...request, ...changed }, f.access, f.worktree))
        .toThrow('math_library_request_identity_changed');
    expect(() => requestedLibraryPack(f.problem, request, { ...f.access, digest: 'd'.repeat(64) }, f.worktree))
      .toThrow('math_library_catalog_changed');
    expect(frozenState(f)).toEqual(before);
    writeLibraryAccess(f.problem, f.worktree, { ...f.access, digest: 'd'.repeat(64) });
    expect(() => agentLibrary(f.worktree)).toThrow('math_library_catalog_changed');
  });

  it('rejects unknown, unrelated or future seed commits without changing current state', () => {
    const f = fixture();
    f.library.request(['Access.all_hold'], 'Need the quantified declaration.');
    const request = requestValue(f), before = frozenState(f), tree = git(f.worktree, ['rev-parse', 'HEAD^{tree}']);
    const commit = (parents: string[]) => git(f.worktree, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost',
      'commit-tree', tree, ...parents, '-m', 'Noncurrent request seed']);
    const seeds = ['0'.repeat(40), commit([]), commit(['-p', before.head])];
    for (const seedCommit of seeds)
      expect(() => requestedLibraryPack(f.problem, { ...request, seedCommit }, f.access, f.worktree)).toThrow('math_git_failed:merge-base');
    expect(frozenState(f)).toEqual(before);
  });

  it('rejects unknown and already-installed names even when requests bypass the agent helper', () => {
    const f = fixture(), before = frozenState(f);
    f.library.request(['Access.all_hold'], 'Need the quantified declaration.');
    const request = requestValue(f);
    expect(() => requestedLibraryPack(f.problem, { ...request, names: ['Access.missing'] }, f.access, f.worktree))
      .toThrow('math_library_catalog_declaration_missing');
    expect(() => requestedLibraryPack(f.problem, { ...request, names: ['Access.existing'] }, f.access, f.worktree))
      .toThrow('math_library_request_already_installed');
    expect(frozenState(f)).toEqual(before);
  });

  it('rejects changed catalog bytes and retains frozen modules absent from the next catalog', () => {
    const f = fixture(), before = frozenState(f);
    f.library.request(['Access.all_hold'], 'Need the quantified declaration.');
    const request = requestValue(f);
    const changed = writeLibraryCatalog(path.join(f.root, 'changed-release'), { id: 'fixture/full-library', revision: 'v2',
      environment: 'standard', packs: [sourcePack({ ...sources, [foundation]: sources[foundation].replace(':= 0', ':= 1') })] });
    expect(() => requestedLibraryPack(f.problem, { ...request, catalogDigest: changed.digest }, { file: changed.file, digest: changed.digest }, f.worktree))
      .toThrow('math_library_request_existing_module_changed');
    const missing = writeLibraryCatalog(path.join(f.root, 'missing-release'), { id: 'fixture/full-library', revision: 'v3',
      environment: 'standard', packs: [sourcePack(Object.fromEntries(Object.entries(sources).filter(([file]) => file !== installed)))] });
    const retained = requestedLibraryPack(f.problem, { ...request, catalogDigest: missing.digest }, { file: missing.file, digest: missing.digest }, f.worktree);
    expect(retained.pack.modules.find(module => module.file === installed)?.source).toBe(sources[installed]);
    expect(frozenState(f)).toEqual(before);
  });

  it('rejects changed newly requested source bytes during materialization', () => {
    const f = fixture(), before = frozenState(f);
    f.library.request(['Access.all_hold'], 'Need the quantified declaration.');
    const object = path.join(f.root, 'release', 'objects', mathDigest(sources[requested]) + '.lean');
    fs.chmodSync(object, 0o600); fs.appendFileSync(object, '-- changed after publication\n');
    expect(() => requestedLibraryPack(f.problem, requestValue(f), f.access, f.worktree)).toThrow('math_library_catalog_source_changed');
    expect(frozenState(f)).toEqual(before);
  });

  it.each([
    'namespace Access\ntheorem all_hold : True := by sorry\nend Access\n',
    'namespace Access.Support\ntheorem value : True := by sorry\nend Access.Support\n',
  ])('rejects requested declarations or dependencies conflicting with an original declaration: %s', source => {
    const f = fixture({ source }), before = frozenState(f);
    f.library.request(['Access.all_hold'], 'Need a quantified declaration.');
    expect(() => requestedLibraryPack(f.problem, requestValue(f), f.access, f.worktree)).toThrow('math_library_catalog_declaration_conflict');
    expect(frozenState(f)).toEqual(before);
  });

  it.each(['catalog', 'shared'] as const)('counts retained %s modules as well as the new dependency closure toward the installation limit', origin => {
    const dependencies = Object.fromEntries(Array.from({ length: MAX_LIBRARY_PACK_MODULES - 2 }, (_, i) => [
      `Submission/Library/AccessBudget/D${i}.lean`, `namespace AccessBudget.D${i}\ndef value : Nat := 0\nend AccessBudget.D${i}\n`,
    ]));
    const entry = 'Submission/Library/AccessBudget/Entry.lean';
    const budgetPack = sourcePack({ ...dependencies, [entry]: Object.keys(dependencies)
      .map(file => `import ${file.slice(0, -5).replaceAll('/', '.')}\n`).join('') +
      'namespace AccessBudget\ntheorem entry : True := trivial\nend AccessBudget\n' });
    const oldPack = sourcePack({ [foundation]: sources[foundation], [installed]: sources[installed] });
    const f = fixture({ packs: origin === 'catalog' ? [oldPack, budgetPack] : [budgetPack], frozenPack: oldPack });
    const before = frozenState(f);
    const catalog = readLibraryCatalog(f.access.file, f.access.digest);
    expect(catalog.select({ source: 'import Submission.Library.AccessBudget.Entry\n', task: '', automatic: false,
      environmentDigest }).modules).toHaveLength(MAX_LIBRARY_PACK_MODULES - 1);
    f.library.request(['AccessBudget.entry'], 'Need all dependencies for this declaration.');
    expect(() => requestedLibraryPack(f.problem, requestValue(f), f.access, f.worktree)).toThrow('math_library_catalog_installation_budget');
    expect(frozenState(f)).toEqual(before);
  });

  it('rejects a combined request exceeding the source byte budget although each input pack fits', () => {
    const padding = 'x'.repeat(Math.ceil(MAX_LIBRARY_PACK_BYTES / 5));
    const modules = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [
      `Submission/Library/AccessBytes/M${i}.lean`,
      `namespace AccessBytes.M${i}\ntheorem ready : True := trivial\nend AccessBytes.M${i}\n/- ${padding} -/\n`,
    ]));
    const entries = Object.entries(modules), f = fixture({ packs: [
      sourcePack({ [foundation]: sources[foundation], [installed]: sources[installed] }),
      sourcePack(Object.fromEntries(entries.slice(0, 4))), sourcePack(Object.fromEntries(entries.slice(4))),
    ] });
    const before = frozenState(f);
    f.library.request(Array.from({ length: 5 }, (_, i) => `AccessBytes.M${i}.ready`), 'Need these five source modules.');
    expect(() => requestedLibraryPack(f.problem, requestValue(f), f.access, f.worktree)).toThrow('math_library_catalog_installation_budget');
    expect(frozenState(f)).toEqual(before);
  }, 30_000);

  it('does not consume or silently accept a malformed queued request', () => {
    const f = fixture(), before = frozenState(f), file = path.join(f.worktree, LIBRARY_REQUEST_FILE);
    fs.writeFileSync(file, '{invalid json');
    expect(() => takeLibraryRequest(f.problem, f.worktree, f.access)).toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe('{invalid json');
    expect(frozenState(f)).toEqual(before);
  });
});
