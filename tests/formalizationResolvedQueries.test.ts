import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertFormalizationRetrieval, prepareFormalizationRetrieval, retrieveFormalizationPlan } from '../src/math/formalizationRetrieval';
import { formalizationPlanSchema, type FormalizationPlan } from '../src/math/formalizationPlan';
import { type LeanLibrarySymbols, lookupLeanLibrarySymbols } from '../src/math/leanLibrarySymbols';
import { leanLibrarySymbolCommands } from '../src/math/leanLibrarySymbolsProgram';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { createMathRetrievalCorpus } from '../src/math/mathRetrievalCorpus';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';

const pinned = getLeanTaskEnvironment('mathlib');
const statement = 'Every listed mathematical object satisfies the stated conclusion.';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function object(id: string, leanType: string): FormalizationPlan['objects'][number] {
  return { id, leanType, spanIds: ['source'], description: 'Synthetic object ' + id };
}

function plan(objects: FormalizationPlan['objects'], definitions: FormalizationPlan['definitions'] = []): FormalizationPlan {
  return formalizationPlanSchema.parse({
    schema: 'theorem-os.formalization-plan.v1', taskKind: 'prove',
    spans: [{ id: 'source', start: 0, end: statement.length, text: statement }],
    objects, definitions, assumptions: [], unresolved: [],
    conclusions: [{ id: 'claim', spanIds: ['source'], mathematics: statement,
      targetNames: ['target'], assumptionIds: [] }],
  });
}

async function fixture(source = 'def basic : Nat := 0\n') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'formalization-resolved-queries-')));
  roots.push(root);
  const workspace = path.join(root, 'workspace'), runDirectory = path.join(root, 'run');
  fs.mkdirSync(workspace); fs.mkdirSync(runDirectory);
  for (const [name, text] of Object.entries(pinned.files)) fs.writeFileSync(path.join(workspace, name), text);
  const packageRoot = path.join(workspace, '.lake/packages/mathlib');
  fs.mkdirSync(path.join(packageRoot, 'Mathlib'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'lakefile.toml'), 'name = "mathlib"\n');
  const sourceFile = path.join(packageRoot, 'Mathlib/Main.lean');
  fs.writeFileSync(sourceFile, source);
  const corpusText = canonicalMathJson(await createMathRetrievalCorpus(workspace, ['mathlib']));
  const corpusFile = path.join(root, 'corpus.json'); fs.writeFileSync(corpusFile, corpusText);
  const prepared = prepareFormalizationRetrieval({ workspace, corpusFile,
    symbolProtocol: 'lean-exact-names-v1', queryProtocol: 'lean-resolved-objects-v1' }, 'mathlib');
  fs.writeFileSync(path.join(runDirectory, 'retrieval-corpus.json'), prepared.corpusText);
  return { root, workspace, runDirectory, sourceFile, corpusFile, ...prepared };
}

// The metadata and source below are synthetic advisory fixtures. No Lean or model is invoked.
function metadata(names: readonly string[], found: readonly string[]): LeanLibrarySymbols {
  const symbols: LeanLibrarySymbols['symbols'] = names.map(name => found.includes(name)
    ? { name, exists: true, module: 'Mathlib.Main', kind: 'definition', class: false,
      structure: false, type: 'Type', fields: [] }
    : { name, exists: false });
  return { schema: 'theorem-os.lean-library-symbols.v1', authority: 'advisory-lean-process',
    environment: 'mathlib', environmentDigest: pinned.dependencyDigest, toolchain: pinned.toolchain,
    mathlibRevision: pinned.mathlibRevision!, querySha256: mathDigest(leanLibrarySymbolCommands(names, 'mathlib')),
    symbolsSha256: mathDigest(canonicalMathJson(symbols)),
    observation: { sourceDigest: mathDigest('synthetic source'), environmentDigest: mathDigest('synthetic environment'),
      toolIdentity: mathDigest('synthetic compiler') }, symbols };
}

function lookupFixture(found: readonly string[], alter?: (result: LeanLibrarySymbols) => void) {
  const calls: string[][] = [];
  const lookup: typeof lookupLeanLibrarySymbols = async (_directory, names, environment) => {
    expect(environment).toBe('mathlib'); calls.push([...names]);
    const result = metadata(names, found); alter?.(result); return result;
  };
  return { calls, lookup };
}

function options(directory: string, lookupSymbols: typeof lookupLeanLibrarySymbols) {
  return { directory: path.join(directory, 'symbol-lookup'), env: {}, timeoutMs: 0, lookupSymbols };
}

const isResolved = (packet: Awaited<ReturnType<typeof retrieveFormalizationPlan>>) => {
  if (packet.schema !== 'theorem-os.formalization-retrieval.v3') throw new Error('Expected resolved-object queries.');
  return packet;
};

describe('environment-resolved formalization object queries', () => {
  it('omits unresolved object names before allocating lexical budgets while retaining real single-letter constants', async () => {
    const parameter = 'argument' + 'a'.repeat(520);
    const source = ['def I : Type := Unit', 'def e : Nat := 0',
      ...Array.from({ length: 15 }, (_, index) => `def hint${index} (${parameter} : Nat) : ResolvedTarget := default`)].join('\n');
    const f = await fixture(source), lookup = lookupFixture(['I', 'e', 'ResolvedTarget']);
    const inventory = plan([object('locals', 'G × K × u × with'), object('constants', 'I × e'),
      object('target', 'ResolvedTarget')]);
    const packet = isResolved(await retrieveFormalizationPlan(f.runDirectory, f.configuration, inventory,
      options(f.runDirectory, lookup.lookup)));
    expect(lookup.calls).toEqual([['G', 'K', 'u', 'with', 'I', 'e', 'ResolvedTarget']]);
    expect(packet.queries.map(item => item.query)).toEqual(['I', 'e', 'ResolvedTarget']);
    expect(packet.omittedObjectQueries).toEqual(['G', 'K', 'u', 'with'].map(name => ({ name,
      origins: [{ kind: 'object', id: 'locals' }], reason: 'not-in-environment' })));
    expect(packet.librarySymbols.symbols.slice(4).every(item => item.exists)).toBe(true);
    const legacy = prepareFormalizationRetrieval({ workspace: f.workspace, corpusFile: f.corpusFile,
      symbolProtocol: 'lean-exact-names-v1' }, 'mathlib');
    const oldPacket = await retrieveFormalizationPlan(f.runDirectory, legacy.configuration, inventory,
      options(f.runDirectory, lookup.lookup));
    const target = packet.queries.find(item => item.query === 'ResolvedTarget')!;
    const oldTarget = oldPacket.queries.find(item => item.query === 'ResolvedTarget')!;
    expect(target.totalMatches).toBe(15); expect(oldTarget.totalMatches).toBe(15);
    expect(target.resultCount).toBeGreaterThan(oldTarget.resultCount);
    expect(() => assertFormalizationRetrieval(f.configuration, inventory, packet)).not.toThrow();
  });

  it('keeps explicit library mappings even when lookup reports missing and retains every exact-name origin', async () => {
    const f = await fixture('def useful_hint : Planned.absent := default\n');
    const lookup = lookupFixture([]);
    const inventory = plan([object('same-name', 'Planned.absent'), object('repeated-name', 'Planned.absent'),
      object('local', 'G')], [{ id: 'mapping', spanIds: ['source'], mathematics: 'Use the planned installed definition.',
      implementation: 'existing', leanNames: ['Planned.absent'], dependsOn: [], justification: 'Explicit plan mapping.' }]);
    const packet = isResolved(await retrieveFormalizationPlan(f.runDirectory, f.configuration, inventory,
      options(f.runDirectory, lookup.lookup)));
    expect(lookup.calls).toEqual([['Planned.absent', 'G']]);
    expect(packet.queries).toEqual([expect.objectContaining({ query: 'Planned.absent', origins: [
      { kind: 'definition', id: 'mapping' }, { kind: 'object', id: 'same-name' },
      { kind: 'object', id: 'repeated-name' }] })]);
    expect(packet.hints.map(item => item.qualifiedName)).toEqual(['useful_hint']);
    expect(packet.omittedObjectQueries).toEqual([{ name: 'G', origins: [{ kind: 'object', id: 'local' }],
      reason: 'not-in-environment' }]);
    expect(packet.librarySymbols.symbols).toEqual([{ name: 'Planned.absent', exists: false }, { name: 'G', exists: false }]);
  });

  it('resolves exact case before lexical case folding so omitted names do not contaminate surviving origins', async () => {
    const f = await fixture('def typed_hint : Foo := default\n'), lookup = lookupFixture(['Foo']);
    const inventory = plan([object('upper', 'Foo'), object('lower', 'foo'), object('same-upper', 'Foo')]);
    const packet = isResolved(await retrieveFormalizationPlan(f.runDirectory, f.configuration, inventory,
      options(f.runDirectory, lookup.lookup)));
    expect(lookup.calls).toEqual([['Foo', 'foo']]);
    expect(packet.queries).toEqual([expect.objectContaining({ query: 'Foo',
      origins: [{ kind: 'object', id: 'upper' }, { kind: 'object', id: 'same-upper' }] })]);
    expect(packet.omittedObjectQueries).toEqual([{ name: 'foo', origins: [{ kind: 'object', id: 'lower' }],
      reason: 'not-in-environment' }]);
    const changed = structuredClone(packet);
    changed.queries[0].origins.push({ kind: 'object', id: 'lower' });
    expect(() => assertFormalizationRetrieval(f.configuration, inventory, changed)).toThrow();
  });

  it('looks up whole multibyte names and filters missing names before splitting a shared long prefix', async () => {
    const shared = 'Shared.' + 'α'.repeat(160), found = shared + '.Known', missing = shared + '.Missing';
    const f = await fixture(`def typed_hint : ${found} := default\n`), lookup = lookupFixture([found]);
    const inventory = plan([object('known', found), object('missing', missing)]);
    const packet = isResolved(await retrieveFormalizationPlan(f.runDirectory, f.configuration, inventory,
      options(f.runDirectory, lookup.lookup)));
    expect(lookup.calls).toEqual([[found, missing]]);
    expect(packet.librarySymbolQueries.map(item => item.name)).toEqual([found, missing]);
    expect(packet.queries.length).toBeGreaterThan(1);
    expect(packet.queries.map(item => item.query).join('')).toBe(found);
    expect(packet.queries.every(item => Buffer.byteLength(item.query) <= 256 && !item.query.includes('�') &&
      canonicalMathJson(item.origins) === canonicalMathJson([{ kind: 'object', id: 'known' }]))).toBe(true);
    expect(packet.omittedObjectQueries).toEqual([{ name: missing, origins: [{ kind: 'object', id: 'missing' }],
      reason: 'not-in-environment' }]);
    expect(packet.hints.map(item => item.qualifiedName)).toEqual(['typed_hint']);
  });

  it('looks up and searches every surviving name beyond one eight-query batch', async () => {
    const names = Array.from({ length: 19 }, (_, index) => 'Lookup' + String(index).padStart(2, '0'));
    const f = await fixture(names.map((name, index) => `def hint${index} : ${name} := default`).join('\n'));
    const lookup = lookupFixture(names), inventory = plan(names.map((name, index) => object('object-' + index, name)));
    const packet = isResolved(await retrieveFormalizationPlan(f.runDirectory, f.configuration, inventory,
      options(f.runDirectory, lookup.lookup)));
    expect(lookup.calls).toEqual([names]);
    expect(packet.queries.map(item => item.query)).toEqual(names);
    expect(packet.queries.every(item => item.totalMatches === 1 && item.resultCount === 1 && !item.truncated)).toBe(true);
    expect(packet.hints).toHaveLength(19); expect(packet.omittedObjectQueries).toEqual([]);
  });

  it.each(['corpus', 'source'] as const)('validates frozen %s bytes before any metadata lookup', async changed => {
    const f = await fixture(), lookup = lookupFixture(['Nat']), inventory = plan([object('number', 'Nat')]);
    if (changed === 'corpus') fs.appendFileSync(path.join(f.runDirectory, 'retrieval-corpus.json'), '\n');
    else fs.appendFileSync(f.sourceFile, '\ndef modified : Nat := 1\n');
    await expect(retrieveFormalizationPlan(f.runDirectory, f.configuration, inventory,
      options(f.runDirectory, lookup.lookup))).rejects.toThrow(changed === 'corpus'
      ? 'formalization_retrieval_corpus_changed' : 'math_corpus_source_changed');
    expect(lookup.calls).toEqual([]);
  });

  it.each(['compiler', 'environment'] as const)('propagates a %s lookup failure without returning lexical-only hints', async failure => {
    const f = await fixture(), inventory = plan([object('number', 'Nat')]); let calls = 0;
    const lookup: typeof lookupLeanLibrarySymbols = async (_directory, names) => {
      calls++;
      if (failure === 'compiler') throw new Error('synthetic_metadata_compiler_failed');
      const result = metadata(names, ['Nat']); result.environmentDigest = 'f'.repeat(64); return result;
    };
    await expect(retrieveFormalizationPlan(f.runDirectory, f.configuration, inventory,
      options(f.runDirectory, lookup))).rejects.toThrow(failure === 'compiler'
      ? 'synthetic_metadata_compiler_failed' : 'lean_library_symbols_environment_changed');
    expect(calls).toBe(1);
  });
});
