import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertFormalizationRetrieval,
  prepareFormalizationRetrieval,
  retrieveFormalizationPlan,
  type FormalizationRetrieval,
} from '../src/math/formalizationRetrieval';
import { formalizationPlanSchema, type FormalizationPlan } from '../src/math/formalizationPlan';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { createMathRetrievalCorpus } from '../src/math/mathRetrievalCorpus';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';

const statement = 'Prove that every listed mathematical object satisfies the stated conclusion.';
const pinned = getLeanTaskEnvironment('mathlib');

function object(id: string, leanType: string): FormalizationPlan['objects'][number] {
  return { id, spanIds: ['source'], description: 'Mathematical object ' + id, leanType };
}

function plan(input: Partial<Pick<FormalizationPlan, 'objects' | 'definitions'>> = {}): FormalizationPlan {
  return formalizationPlanSchema.parse({
    schema: 'theorem-os.formalization-plan.v1', taskKind: 'prove',
    spans: [{ id: 'source', start: 0, end: statement.length, text: statement }],
    objects: [], definitions: [], assumptions: [], unresolved: [],
    conclusions: [{ id: 'claim', spanIds: ['source'], mathematics: statement,
      targetNames: ['target'], assumptionIds: [] }],
    ...input,
  });
}

describe('frozen formalization plan retrieval', () => {
  let root: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'formalization-retrieval-')));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  async function fixture(files: Record<string, string> = { 'Main.lean': 'def basic : Nat := 0\n' }) {
    const workspace = path.join(root, 'workspace');
    const runDirectory = path.join(root, 'run');
    fs.mkdirSync(workspace); fs.mkdirSync(runDirectory);
    for (const [name, text] of Object.entries(pinned.files)) fs.writeFileSync(path.join(workspace, name), text);
    const packageRoot = path.join(workspace, '.lake/packages/mathlib');
    fs.mkdirSync(path.join(packageRoot, 'Mathlib'), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'lakefile.toml'), 'name = "mathlib"\n');
    for (const [name, text] of Object.entries(files)) {
      const file = path.join(packageRoot, 'Mathlib', name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
    const corpus = await createMathRetrievalCorpus(workspace, ['mathlib']);
    const corpusFile = path.join(root, 'corpus.json');
    fs.writeFileSync(corpusFile, JSON.stringify(corpus, null, 2) + '\n');
    const prepared = prepareFormalizationRetrieval({ workspace, corpusFile }, 'mathlib');
    fs.writeFileSync(path.join(runDirectory, 'retrieval-corpus.json'), prepared.corpusText);
    return { workspace, runDirectory, packageRoot, corpusFile, corpus, ...prepared };
  }

  it('derives library names and object aliases with their complete plan provenance', async () => {
    const source = [
      'namespace Types',
      'def existing : Real := 0',
      'def natural : Nat := 0',
      'def integer : Int := 0',
      'def rational : Rat := 0',
      'def complex : Complex := 0',
      'end Types',
    ].join('\n');
    const f = await fixture({ 'Main.lean': source });
    const inventory = plan({
      objects: [object('real', '(x : ℝ) → ℝ /- HiddenComment -/'),
        object('same-real', 'Real'), object('numbers', 'ℕ × ℤ × ℚ × ℂ')],
      definitions: [
        { id: 'known', spanIds: ['source'], mathematics: 'Use the installed real definition.',
          implementation: 'existing', leanNames: ['Types.existing'], dependsOn: [], justification: 'Named library definition.' },
        { id: 'local', spanIds: ['source'], mathematics: 'Define a new local meaning.',
          implementation: 'new', leanNames: ['Local.newMeaning'], dependsOn: ['known'], justification: 'New task-specific definition.' },
      ],
    });
    const packet = await retrieveFormalizationPlan(f.runDirectory, f.configuration, inventory);
    expect(packet.queries.map(item => item.query)).toEqual(['Types.existing', 'Real', 'Nat', 'Int', 'Rat', 'Complex']);
    expect(packet.queries[0].origins).toEqual([{ kind: 'definition', id: 'known' }]);
    expect(packet.queries[1].origins).toEqual([{ kind: 'object', id: 'real' }, { kind: 'object', id: 'same-real' }]);
    expect(packet.hints.map(item => item.qualifiedName)).toEqual(expect.arrayContaining([
      'Types.existing', 'Types.natural', 'Types.integer', 'Types.rational', 'Types.complex',
    ]));
    expect(packet.hints.every(item => item.sourceSha256 === mathDigest(source) &&
      item.packageRevision === pinned.mathlibRevision && item.sourceFile === '.lake/packages/mathlib/Mathlib/Main.lean')).toBe(true);
    expect(packet.hints.every(item => !item.sourceHeader.includes(':='))).toBe(true);
    expect(f.configuration.corpusSha256).toBe(mathDigest(f.corpusText));
    expect(f.configuration.environmentDigest).toBe(pinned.dependencyDigest);
    expect(() => assertFormalizationRetrieval(f.configuration, inventory, packet)).not.toThrow();
  });

  it('normalizes sealed package cache hints for a project nested under the workspace', async () => {
    const source = [
      'namespace Cached', 'section', 'variable {α : Type*}', 'variable [Group α]',
      'open scoped BigOperators', 'lemma inherited (x : α) : x = x := by rfl', 'end', 'end Cached',
    ].join('\n');
    const f = await fixture({ 'Algebra/Cached.lean': source });
    const workspace = path.join(root, 'repository');
    const projectSubdirectory = 'nested/project';
    const project = path.join(workspace, projectSubdirectory);
    const packageSourceRoot = path.join(root, 'sealed-packages');
    fs.mkdirSync(path.dirname(project), { recursive: true });
    fs.renameSync(f.workspace, project);
    fs.renameSync(path.join(project, '.lake/packages'), packageSourceRoot);
    const overridesPath = '.lake/package-overrides.json';
    const overrides = JSON.stringify({ schemaVersion: '1.2.0', packages: [{ name: 'mathlib',
      type: 'path', dir: path.join(packageSourceRoot, 'mathlib'), inherited: false }] }) + '\n';
    fs.writeFileSync(path.join(project, overridesPath), overrides);
    const corpus = { ...f.corpus, projectSubdirectory, packageSourceRoot,
      originSha256: f.configuration.corpusSha256,
      environment: [...f.corpus.environment, { path: overridesPath,
        identity: { path: overridesPath, sha256: mathDigest(overrides), bytes: Buffer.byteLength(overrides) } }],
    };
    fs.writeFileSync(f.corpusFile, JSON.stringify(corpus));
    const prepared = prepareFormalizationRetrieval({ workspace, corpusFile: f.corpusFile }, 'mathlib');
    fs.writeFileSync(path.join(f.runDirectory, 'retrieval-corpus.json'), prepared.corpusText);
    const inventory = plan({ objects: [object('group', 'Group')] });
    const packet = await retrieveFormalizationPlan(f.runDirectory, prepared.configuration, inventory);
    expect(prepared.configuration.workspace).toBe(workspace);
    expect(prepared.configuration.environmentDigest).toBe(pinned.dependencyDigest);
    expect(packet.hints).toHaveLength(1);
    expect(packet.hints[0]).toMatchObject({ qualifiedName: 'Cached.inherited', sourceLine: 6,
      sourceFile: '.lake/packages/mathlib/Mathlib/Algebra/Cached.lean',
      sourceModule: 'Mathlib.Algebra.Cached', sourceSha256: mathDigest(source),
      packageName: 'mathlib', packageRevision: pinned.mathlibRevision,
      sourceContext: 'variable {α : Type*}\nvariable [Group α]\nopen scoped BigOperators',
      sourceHeader: 'inherited (x : α) : x = x', contextTruncated: false, headerTruncated: false,
    });
    expect(JSON.stringify(packet)).not.toContain(packageSourceRoot);
    expect(() => assertFormalizationRetrieval(prepared.configuration, inventory, packet)).not.toThrow();
    fs.appendFileSync(path.join(project, overridesPath), '\n');
    await expect(retrieveFormalizationPlan(f.runDirectory, prepared.configuration, inventory))
      .rejects.toThrow('math_corpus_environment_changed');
  });

  it('retrieves every query when a plan needs more than one eight-query batch', async () => {
    const types = Array.from({ length: 19 }, (_, index) => 'Lookup' + String(index).padStart(2, '0'));
    const f = await fixture({ 'Main.lean': types.map((name, index) =>
      `def value${String(index).padStart(2, '0')} : ${name} := default`).join('\n') });
    const inventory = plan({ objects: types.map((name, index) => object('object-' + index, name)) });
    const packet = await retrieveFormalizationPlan(f.runDirectory, f.configuration, inventory);
    expect(packet.queries.map(item => item.query)).toEqual(types);
    expect(packet.queries.every(item => item.resultCount === 1 && item.totalMatches === 1 && !item.truncated)).toBe(true);
    expect(packet.hints).toHaveLength(19);
    expect(packet.hints.map(item => item.occurrences[0].queryIndex)).toEqual(types.map((_, index) => index));
    expect(await retrieveFormalizationPlan(f.runDirectory, f.configuration, inventory)).toEqual(packet);
  });

  it('splits long multibyte identifiers without losing code points or later query parts', async () => {
    const name = '界'.repeat(85) + '𐐀'.repeat(63) + '甲尾';
    const f = await fixture({ 'Main.lean': `def long_type_value : ${name} := default\n` });
    const inventory = plan({ objects: [object('long', name)] });
    const packet = await retrieveFormalizationPlan(f.runDirectory, f.configuration, inventory);
    expect(packet.queries.map(item => item.query).join('')).toBe(name);
    expect(packet.queries).toHaveLength(3);
    for (const { query, resultCount } of packet.queries) {
      expect(Buffer.byteLength(query)).toBeLessThanOrEqual(256);
      expect(Buffer.from(query).toString('utf8')).toBe(query);
      expect(query).not.toContain('\ufffd');
      expect(resultCount).toBe(1);
    }
    expect(packet.hints).toHaveLength(1);
    expect(packet.hints[0].occurrences.map(item => item.queryIndex)).toEqual([0, 1, 2]);
  });

  it('interleaves uneven lists, skips empty lists and deduplicates full declaration identities', async () => {
    const f = await fixture({
      'Main.lean': 'namespace One\ndef a : alpha beta := default\ndef b : alpha := default\ndef c : beta := default\nend One\n',
      'Left.lean': 'namespace Left\ndef same : alpha := default\nend Left\n',
      'Right.lean': 'namespace Right\ndef same : alpha := default\nend Right\n',
    });
    const inventory = plan({ objects: [object('alpha', 'alpha'), object('none', 'missing'), object('beta', 'beta')] });
    const packet = await retrieveFormalizationPlan(f.runDirectory, f.configuration, inventory);
    expect(packet.queries.map(item => item.resultCount)).toEqual([4, 0, 2]);
    expect(packet.hints.map(item => item.qualifiedName)).toEqual(['One.a', 'One.b', 'One.c', 'Left.same', 'Right.same']);
    expect(packet.hints[0].occurrences.map(({ queryIndex, rank }) => ({ queryIndex, rank })))
      .toEqual([{ queryIndex: 0, rank: 1 }, { queryIndex: 2, rank: 1 }]);
    const same = packet.hints.filter(item => item.name === 'same');
    expect(same).toHaveLength(2);
    expect(new Set(same.map(item => item.sourceFile)).size).toBe(2);
    expect(await retrieveFormalizationPlan(f.runDirectory, f.configuration, inventory)).toEqual(packet);
  });

  it('records a valid no-hit lookup and handles plans with no searchable library names', async () => {
    const f = await fixture();
    const missing = await retrieveFormalizationPlan(f.runDirectory, f.configuration,
      plan({ objects: [object('missing', 'CertainlyUninstalledConcept')] }));
    expect(missing.queries).toEqual([{ query: 'CertainlyUninstalledConcept',
      origins: [{ kind: 'object', id: 'missing' }], totalMatches: 0, resultCount: 0, truncated: false }]);
    expect(missing.hints).toEqual([]);
    const empty = await retrieveFormalizationPlan(f.runDirectory, f.configuration,
      plan({ objects: [object('universe', 'Type')] }));
    expect(empty.queries).toEqual([]); expect(empty.hints).toEqual([]);
    fs.appendFileSync(path.join(f.packageRoot, 'Mathlib/Main.lean'), '\ndef changed : Nat := 1\n');
    await expect(retrieveFormalizationPlan(f.runDirectory, f.configuration, plan()))
      .rejects.toThrow('math_corpus_source_changed');
  });

  it('refuses retrieval outside the pinned mathlib environment', async () => {
    const f = await fixture();
    expect(() => prepareFormalizationRetrieval({ workspace: f.workspace, corpusFile: f.corpusFile }, 'standard'))
      .toThrow('formalization_retrieval_requires_mathlib');
    fs.appendFileSync(path.join(f.workspace, 'lean-toolchain'), '\n');
    const changedCorpus = await createMathRetrievalCorpus(f.workspace, ['mathlib']);
    fs.writeFileSync(f.corpusFile, JSON.stringify(changedCorpus));
    expect(() => prepareFormalizationRetrieval({ workspace: f.workspace, corpusFile: f.corpusFile }, 'mathlib'))
      .toThrow('formalization_retrieval_environment_mismatch');
  });

  it.each(['scope', 'revision'])('rejects a corpus with a different %s claim', async change => {
    const f = await fixture();
    const changed = structuredClone(f.corpus);
    if (change === 'scope') changed.scopes = ['mathlib', 'other'];
    else for (const source of changed.sources) source.packageRevision = 'b'.repeat(40);
    fs.writeFileSync(f.corpusFile, JSON.stringify(changed));
    expect(() => prepareFormalizationRetrieval({ workspace: f.workspace, corpusFile: f.corpusFile }, 'mathlib'))
      .toThrow('formalization_retrieval_environment_mismatch');
  });

  it.each(['manifest bytes', 'source bytes', 'environment bytes'])('rejects changed %s after preparation', async change => {
    const f = await fixture();
    if (change === 'manifest bytes') fs.appendFileSync(path.join(f.runDirectory, 'retrieval-corpus.json'), '\n');
    else if (change === 'source bytes') fs.appendFileSync(path.join(f.packageRoot, 'Mathlib/Main.lean'), '\ndef changed : Nat := 1\n');
    else fs.appendFileSync(path.join(f.workspace, 'lean-toolchain'), '\n');
    await expect(retrieveFormalizationPlan(f.runDirectory, f.configuration, plan({ objects: [object('nat', 'Nat')] })))
      .rejects.toThrow(change === 'manifest bytes' ? 'formalization_retrieval_corpus_changed' :
        change === 'source bytes' ? 'math_corpus_source_changed' : 'math_corpus_environment_changed');
  });

  it('rejects changed plan provenance even when the packet plan digest is recomputed', async () => {
    const f = await fixture();
    const original = plan({ objects: [object('nat', 'Nat')] });
    const packet = await retrieveFormalizationPlan(f.runDirectory, f.configuration, original);
    const changed = plan({ objects: [object('different-object', 'Nat')] });
    packet.planDigest = mathDigest(canonicalMathJson(changed));
    expect(() => assertFormalizationRetrieval(f.configuration, changed, packet))
      .toThrow('formalization_retrieval_input_mismatch');
  });

  it.each([
    ['environment', (packet: FormalizationRetrieval) => { packet.environmentDigest = 'f'.repeat(64); }],
    ['corpus', (packet: FormalizationRetrieval) => { packet.corpusSha256 = 'f'.repeat(64); }],
    ['query occurrence', (packet: FormalizationRetrieval) => { packet.hints[0].occurrences[0].queryIndex = 1; }],
    ['duplicate hint', (packet: FormalizationRetrieval) => { packet.hints.push(structuredClone(packet.hints[0])); }],
    ['result count', (packet: FormalizationRetrieval) => { packet.queries[0].resultCount = 0; }],
  ] as const)('rejects changed %s in saved retrieval evidence', async (_name, change) => {
    const f = await fixture();
    const inventory = plan({ objects: [object('nat', 'Nat')] });
    const packet = await retrieveFormalizationPlan(f.runDirectory, f.configuration, inventory);
    change(packet);
    expect(() => assertFormalizationRetrieval(f.configuration, inventory, packet))
      .toThrow('formalization_retrieval_input_mismatch');
  });
});
