import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertFormalizationEvidence, formalizationDigest, prepareFormalization,
  readFormalizationArtifact, readFormalizationRequest, type FormalizationEvidence } from '../src/math/formalization';
import type { FormalizationPlan } from '../src/math/formalizationPlan';
import { type LeanLibrarySymbols, lookupLeanLibrarySymbols } from '../src/math/leanLibrarySymbols';
import { leanLibrarySymbolCommands } from '../src/math/leanLibrarySymbolsProgram';
import { defaultFormalizationWorkflow } from '../src/math/formalizationWorkflow';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { createMathRetrievalCorpus } from '../src/math/mathRetrievalCorpus';
import { canonicalMathJson, mathDigest, readMathText } from '../src/math/mathRuntimeIo';
import type { MathAgentOptions, MathAgentSession } from '../src/runtime/codexSession';
import { readFormalizationState, runFormalization } from '../src/solver/formalization';
import { buildFixture, candidateFixture, fixtureStatement, semanticReviewFixture,
  syntheticElaboration } from './helpers/formalizationFixture';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const author = { model: 'preset-retrieval-author', effort: 'none', profile: '/preset-only', executable: '/no-model' };
const marker = 'retrievalOnlyMarker';
const symbolMarker = 'ConnectedSpace.toPreconnectedSpace';
const longName = 'LongNamespace.' + '界'.repeat(100);
const definedNames = ['ConnectedSpace', 'SetLike.coe', 'Function.Injective', 'Field', 'field', longName];
const expectedNames = [...definedNames, 'Nat', 'Real'];
const pinned = getLeanTaskEnvironment('mathlib');

async function fixture(protocol: 'symbols' | 'resolved' | 'legacy' | 'absent' = 'symbols') {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'formalization-library-symbols-workflow-')));
  roots.push(base);
  const { root, manifest } = buildFixture(base), directory = path.join(base, 'run');
  const workspace = path.join(base, 'installed-library'), configuration = getLeanTaskEnvironment('mathlib');
  const source = path.join(workspace, '.lake/packages/mathlib/Mathlib/Data/Nat/Basic.lean');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  for (const [name, text] of Object.entries(configuration.files)) fs.writeFileSync(path.join(workspace, name), text);
  fs.writeFileSync(path.join(workspace, '.lake/packages/mathlib/lakefile.lean'),
    'import Lake\nopen Lake DSL\npackage mathlib\n');
  fs.writeFileSync(source, 'namespace Fixture\n' +
    `def ${marker} (n : Nat) : Nat := n\n` +
    'theorem addition_lookup (n : Nat) : n + 0 = n := by rfl\nend Fixture\n');
  const corpusFile = path.join(base, 'corpus.json');
  fs.writeFileSync(corpusFile, canonicalMathJson(await createMathRetrievalCorpus(workspace, ['mathlib'])));
  const request = prepareFormalization(directory, {
    problemId: 'synthetic_addition', statement: fixtureStatement, environment: 'mathlib', execution: 'replay',
    ...author, workflow: defaultFormalizationWorkflow(author), buildManifestRef: manifest,
    maxRounds: 2, maxRunSeconds: 0, maxTurnSeconds: 0, maxCompileSeconds: 0, maxTotalTokens: 0,
    ...(protocol !== 'absent' ? { retrieval: { workspace, corpusFile,
      ...(protocol === 'symbols' || protocol === 'resolved' ? { symbolProtocol: 'lean-exact-names-v1' as const } : {}),
      ...(protocol === 'resolved' ? { queryProtocol: 'lean-resolved-objects-v1' as const } : {}) } } : {}),
  });
  return { base, root, directory, workspace, source, corpusFile, request };
}

function plan(statement: string): FormalizationPlan {
  return { schema: 'theorem-os.formalization-plan.v1', taskKind: 'prove',
    spans: [{ id: 'source', start: 0, end: statement.length, text: statement }],
    objects: [
      { id: 'natural-number', spanIds: ['source'], description: 'Every natural number n.', leanType: 'Nat' },
      { id: 'space', spanIds: ['source'], description: 'Symbol-query contract fixture.',
        leanType: '(X : Type*) → ConnectedSpace X × ℝ /- Hidden.Comment -/' },
      { id: 'same-space', spanIds: ['source'], description: 'Repeated exact-name provenance.', leanType: 'ConnectedSpace' },
    ],
    assumptions: [], definitions: definedNames.map((name, index) => ({ id: 'library-' + index,
      spanIds: ['source'], mathematics: 'Exercise the installed-name query contract for ' + name,
      implementation: 'existing' as const, leanNames: [name], dependsOn: [], justification: 'Synthetic library lookup fixture.' })),
    unresolved: [], conclusions: [{ id: 'zero-identity', spanIds: ['source'],
      mathematics: 'For every natural n, n + 0 = n.', targetNames: ['addition'], assumptionIds: [] }] };
}

function preset(afterOutput?: (role: string, input: any) => void, makePlan = plan) {
  let sequence = 0;
  const seen: { role: string; input: any; config: MathAgentOptions }[] = [];
  const open = async (config: MathAgentOptions): Promise<MathAgentSession> => {
    const id = ++sequence, role = path.basename(config.workspace);
    return { threadId: 'preset-retrieval-thread-' + id, close: async () => {}, interrupt: async () => {},
      run: async (_message, _id, workspace, onStarted) => {
        onStarted('preset-retrieval-turn-' + id); config.onUsage({ totalTokens: 1 });
        const input = JSON.parse(readMathText(path.join(workspace, 'INPUT.json')));
        seen.push({ role, input, config });
        const output = role.startsWith('plan-') ? makePlan(input.statement) : role === 'generate' ? candidateFixture(input.statement) :
          role === 'backtranslate' ? { snapshotDigest: input.snapshotDigest, mathematics: 'The natural zero identity.',
            assumptions: [], definitions: [], targets: input.targets.map((target: { name: string }) =>
              ({ name: target.name, mathematics: 'For every natural n, n + 0 = n.' })) } : semanticReviewFixture(input);
        fs.writeFileSync(path.join(workspace, 'OUTPUT.json'), canonicalMathJson(output));
        afterOutput?.(role, input);
        return 'completed';
      } };
  };
  return { open, seen };
}

const elaborate: NonNullable<Parameters<typeof runFormalization>[2]>['elaborate'] =
  async (_directory, source, environment, options) => {
    const result = syntheticElaboration(source, environment, options), diagnostics = result.compilation.diagnostics;
    // The shared helper models standard Lean. Mathlib additionally records its
    // installed package override, so bind a disposable synthetic receipt here.
    diagnostics.latest.configuration.find(item => item.file === '.lake/package-overrides.json')!.digest =
      mathDigest('synthetic installed Mathlib override');
    const sourceDigest = mathDigest(JSON.stringify([diagnostics.latest.configuration.map(item => item.digest ?? ''),
      diagnostics.latest.sourceFiles.map(item => [item.file, item.digest])]));
    diagnostics.sourceDigest = sourceDigest; diagnostics.latest.sourceDigest = sourceDigest;
    for (const [index, record] of diagnostics.artifactRecords.entries()) {
      const artifact = JSON.parse(record.text); artifact.sourceDigest = sourceDigest;
      record.text = canonicalMathJson(artifact); record.digest = mathDigest(record.text);
      const reference = diagnostics.diagnosticArtifacts[index];
      reference.sourceDigest = sourceDigest; reference.digest = record.digest;
      reference.path = 'compilation-artifacts/' + record.digest + '.json';
    }
    return result;
  };
const generationSession = (evidence: FormalizationEvidence) => evidence.sessions.find(session => session.role === 'generate')!;


// These fixtures exercise saved advisory metadata, never actual library observations.
function symbolsFor(names: readonly string[], environment: Parameters<typeof lookupLeanLibrarySymbols>[2]): LeanLibrarySymbols {
  const constant = (name: string, module: string, type: string, kind: 'inductive' | 'definition' = 'definition') =>
    ({ name, exists: true as const, module, kind, class: false, structure: false, type, fields: [] });
  const symbols: LeanLibrarySymbols['symbols'] = names.map(name => {
    if (name === 'ConnectedSpace') return { name, exists: true, module: 'Mathlib.Topology.Connected.Basic',
      kind: 'inductive', class: true, structure: true, type: '(X : Type u) → [TopologicalSpace X] → Prop',
      fields: [{ name: 'ConnectedSpace.toPreconnectedSpace', type: '(X : Type u) → [TopologicalSpace X] → ConnectedSpace X → PreconnectedSpace X' },
        { name: 'ConnectedSpace.toNonempty', type: '(X : Type u) → [TopologicalSpace X] → ConnectedSpace X → Nonempty X' }] };
    if (name === 'Field') return { name, exists: true, module: 'Mathlib.Algebra.Field.Defs', kind: 'inductive',
      class: true, structure: true, type: '(K : Type u) → Type u',
      fields: [{ name: 'Field.toDivisionRing', type: '(K : Type u) → Field K → DivisionRing K' }] };
    if (name === 'SetLike.coe') return constant(name, 'Mathlib.Data.SetLike.Basic', '(α : Sort u) → (β : Sort v) → SetLike α β → α → Set β');
    if (name === 'Function.Injective') return constant(name, 'Init.Prelude', '(f : α → β) → Prop');
    if (name === 'Nat') return constant(name, 'Init.Prelude', 'Type', 'inductive');
    if (name === 'Real') return constant(name, 'Mathlib.Data.Real.Basic', 'Type', 'inductive');
    return { name, exists: false };
  });
  const config = getLeanTaskEnvironment(environment);
  return { schema: 'theorem-os.lean-library-symbols.v1', authority: 'advisory-lean-process', environment: 'mathlib',
    environmentDigest: config.dependencyDigest, toolchain: config.toolchain, mathlibRevision: config.mathlibRevision!,
    querySha256: mathDigest(leanLibrarySymbolCommands(names, environment)), symbolsSha256: mathDigest(canonicalMathJson(symbols)),
    observation: { sourceDigest: mathDigest('synthetic symbols source'), environmentDigest: mathDigest('synthetic sealed environment'),
      toolIdentity: mathDigest('synthetic compiler identity') }, symbols };
}

function lookupFixture(afterLookup?: (result: LeanLibrarySymbols) => void) {
  const calls: { directory: string; names: string[]; environment: Parameters<typeof lookupLeanLibrarySymbols>[2];
    options: Parameters<typeof lookupLeanLibrarySymbols>[3] }[] = [];
  const lookup: typeof lookupLeanLibrarySymbols = async (directory, names, environment, options) => {
    calls.push({ directory, names: [...names], environment, options });
    const result = symbolsFor(names, environment); afterLookup?.(result); return result;
  };
  return { lookup, calls };
}

const packetOf = (evidence: FormalizationEvidence) => {
  const packet = evidence.generation.input.retrieval!;
  if (packet.schema !== 'theorem-os.formalization-retrieval.v2') throw new Error('Expected symbol retrieval protocol.');
  return packet;
};

describe('Lean exact-name metadata in formalization generation', () => {
  it('gives only the generator class parents, generated names and core names as advisory metadata', async () => {
    const f = await fixture(), agent = preset(), lookup = lookupFixture();
    expect(f.request.retrieval).toMatchObject({ schema: 'theorem-os.formalization-retrieval-config.v2',
      symbolProtocol: 'lean-exact-names-v1', environmentDigest: pinned.dependencyDigest });
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate, lookupSymbols: lookup.lookup });
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'approved', modelInvoked: false });
    expect(lookup.calls).toHaveLength(1);
    expect(lookup.calls[0]).toMatchObject({ names: expectedNames, environment: 'mathlib', options: { timeoutMs: 0 } });
    expect(lookup.calls[0].options.signal).toBeInstanceOf(AbortSignal);
    const generated = agent.seen.find(item => item.role === 'generate')!;
    const packet = generated.input.retrieval;
    expect(packet).toMatchObject({ schema: 'theorem-os.formalization-retrieval.v2', algorithm: 'installed-plan-lexical-symbols-v1',
      configurationDigest: formalizationDigest(f.request.retrieval), corpusSha256: f.request.retrieval!.corpusSha256,
      planDigest: formalizationDigest(generated.input.plan), environmentDigest: pinned.dependencyDigest });
    expect(packet.librarySymbols).toEqual(symbolsFor(expectedNames, 'mathlib'));
    expect(packet.librarySymbols.symbols.find((item: any) => item.name === 'ConnectedSpace').fields)
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: 'ConnectedSpace.toPreconnectedSpace' }),
        expect.objectContaining({ name: 'ConnectedSpace.toNonempty' })]));
    expect(packet.librarySymbols.symbols.find((item: any) => item.name === 'Function.Injective').module).toBe('Init.Prelude');
    expect(packet.librarySymbols.symbols.find((item: any) => item.name === 'SetLike.coe').exists).toBe(true);
    expect(generated.config.instructions).toContain('INPUT.retrieval');
    for (const item of agent.seen.filter(item => item.role !== 'generate')) {
      expect(item.input).not.toHaveProperty('retrieval');
      expect(JSON.stringify(item.input)).not.toContain(symbolMarker);
      expect(item.config.instructions).not.toContain('INPUT.retrieval');
    }
    const evidence = readFormalizationArtifact(path.join(f.directory, 'artifact'));
    expect(evidence.generation.input.retrieval).toEqual(packet);
    expect(evidence.proofVerified).toBe(false);
    expect(() => assertFormalizationEvidence(evidence)).not.toThrow();
    expect(readFormalizationRequest(f.directory)).toEqual(f.request);
  });

  it('keeps exact-name case, complete identifiers, first occurrence order and all plan origins', async () => {
    const f = await fixture(), agent = preset(), lookup = lookupFixture();
    expect(await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate, lookupSymbols: lookup.lookup }))
      .toMatchObject({ status: 'approved' });
    const packet = packetOf(readFormalizationArtifact(path.join(f.directory, 'artifact')));
    expect(packet.librarySymbolQueries.map(item => item.name)).toEqual(expectedNames);
    expect(packet.librarySymbolQueries[0]).toEqual({ name: 'ConnectedSpace', origins: [
      { kind: 'definition', id: 'library-0' }, { kind: 'object', id: 'space' }, { kind: 'object', id: 'same-space' }] });
    expect(packet.librarySymbolQueries[4]).toEqual({ name: 'field', origins: [{ kind: 'definition', id: 'library-4' }] });
    expect(packet.librarySymbolQueries[5].name).toBe(longName);
    expect(Buffer.byteLength(packet.librarySymbolQueries[5].name)).toBeGreaterThan(256);
    expect(packet.queries.some(item => item.query === longName)).toBe(false);
    expect(packet.librarySymbols.symbols.filter(item => !item.exists)).toEqual([
      { name: 'field', exists: false }, { name: longName, exists: false }]);
    expect(JSON.stringify(packet.librarySymbolQueries)).not.toContain('Hidden.Comment');
    expect(packet.librarySymbols.symbols.map(item => item.name)).not.toContain('X');
  });

  it.each(['query order', 'query case', 'query origin', 'query missing', 'symbol order', 'symbol name',
    'symbol digest', 'query program', 'environment', 'toolchain', 'protocol data'] as const)(
    'rejects rewritten %s after the generation session hash is recomputed', async change => {
      const f = await fixture(), agent = preset(), lookup = lookupFixture();
      expect(await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate, lookupSymbols: lookup.lookup }))
        .toMatchObject({ status: 'approved' });
      const evidence = structuredClone(readFormalizationArtifact(path.join(f.directory, 'artifact'))), packet = packetOf(evidence);
      if (change === 'query order') packet.librarySymbolQueries.reverse();
      if (change === 'query case') packet.librarySymbolQueries[3].name = 'FIELD';
      if (change === 'query origin') packet.librarySymbolQueries[0].origins[0].id = 'unplanned-origin';
      if (change === 'query missing') packet.librarySymbolQueries.pop();
      if (change === 'symbol order') packet.librarySymbols.symbols.reverse();
      if (change === 'symbol name') packet.librarySymbols.symbols[0].name = 'PreconnectedSpace';
      if (change === 'symbol digest') packet.librarySymbols.symbolsSha256 = 'f'.repeat(64);
      if (change === 'query program') packet.librarySymbols.querySha256 = 'f'.repeat(64);
      if (change === 'environment') packet.librarySymbols.environmentDigest = 'f'.repeat(64);
      if (change === 'toolchain') packet.librarySymbols.toolchain += '-changed';
      if (change === 'protocol data') delete (packet as any).librarySymbols;
      if (change === 'symbol order' || change === 'symbol name')
        packet.librarySymbols.symbolsSha256 = mathDigest(canonicalMathJson(packet.librarySymbols.symbols));
      generationSession(evidence).inputDigest = formalizationDigest(evidence.generation.input);
      expect(() => assertFormalizationEvidence(evidence)).toThrow();
    });

  it('stops an infrastructure lookup failure before generation without retrying or weakening it to missing names', async () => {
    const f = await fixture(), agent = preset(); let calls = 0;
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate,
      lookupSymbols: async () => { calls++; throw new Error('lean_library_symbols_fixture_compiler_failed'); } });
    expect(result).toMatchObject({ status: 'stopped', rounds: 1, modelInvoked: false });
    expect(result.error).toContain('formalization_retrieval_failed:');
    expect(result.error).toContain('lean_library_symbols_fixture_compiler_failed');
    expect(calls).toBe(1);
    expect(agent.seen.map(item => item.role)).toEqual(['plan-1']);
    expect(readFormalizationState(f.directory)!.sessions).toHaveLength(1);
    expect(fs.existsSync(path.join(f.directory, 'artifact'))).toBe(false);
  });

  it('rejects metadata from a different environment before opening the generator', async () => {
    const f = await fixture(), agent = preset();
    const lookup = lookupFixture(value => { value.environmentDigest = 'f'.repeat(64); });
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate, lookupSymbols: lookup.lookup });
    expect(result).toMatchObject({ status: 'stopped', rounds: 1 });
    expect(result.error).toContain('formalization_retrieval_failed:');
    expect(lookup.calls).toHaveLength(1);
    expect(agent.seen.map(item => item.role)).toEqual(['plan-1']);
  });

  it.each(['corpus', 'source'] as const)('validates frozen %s bytes before invoking Lean metadata lookup', async field => {
    const f = await fixture(), lookup = lookupFixture();
    const agent = preset(role => {
      if (!role.startsWith('plan-')) return;
      if (field === 'corpus') {
        const file = path.join(f.directory, 'retrieval-corpus.json');
        fs.chmodSync(file, 0o600); fs.appendFileSync(file, '\n');
      } else fs.appendFileSync(f.source, '\ndef changed_after_plan : Nat := 1\n');
    });
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate, lookupSymbols: lookup.lookup });
    expect(result).toMatchObject({ status: 'stopped', rounds: 1 });
    expect(result.error).toContain(field === 'corpus' ? 'formalization_retrieval_corpus_changed' : 'math_corpus_source_changed');
    expect(lookup.calls).toHaveLength(0);
    expect(agent.seen.map(item => item.role)).toEqual(['plan-1']);
  });

  it('restores a completed artifact without lookup, corpus, compiler or new role sessions', async () => {
    const f = await fixture(), agent = preset(), lookup = lookupFixture();
    expect(await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate, lookupSymbols: lookup.lookup }))
      .toMatchObject({ status: 'approved' });
    const digest = formalizationDigest(readFormalizationArtifact(path.join(f.directory, 'artifact')));
    fs.rmSync(f.workspace, { recursive: true }); fs.rmSync(f.corpusFile); fs.rmSync(path.join(f.directory, 'retrieval-corpus.json'));
    const restored = await runFormalization(f.directory, f.root, {
      openSession: async () => { throw new Error('Completed artifacts must not reopen roles.'); },
      elaborate: async () => { throw new Error('Completed artifacts must not elaborate again.'); },
      lookupSymbols: async () => { throw new Error('Completed artifacts must not query Lean again.'); },
    });
    expect(restored).toMatchObject({ status: 'approved', modelInvoked: false });
    expect(formalizationDigest(readFormalizationArtifact(path.join(f.directory, 'artifact')))).toBe(digest);
  });

  it('reuses the exact query and advisory packet on interruption while reviewers remain independent', async () => {
    const f = await fixture(), controller = new AbortController(), lookup = lookupFixture(); let interrupted = false;
    const agent = preset(role => { if (role === 'generate' && !interrupted) { interrupted = true; controller.abort(); } });
    expect(await runFormalization(f.directory, f.root,
      { openSession: agent.open, elaborate, lookupSymbols: lookup.lookup, signal: controller.signal }))
      .toMatchObject({ status: 'stopped', rounds: 1 });
    const first = agent.seen.find(item => item.role === 'generate')!.input.retrieval;
    expect(await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate, lookupSymbols: lookup.lookup }))
      .toMatchObject({ status: 'approved', rounds: 1 });
    expect(lookup.calls).toHaveLength(1);
    expect(lookup.calls.map(item => item.names)).toEqual([expectedNames]);
    expect(agent.seen.filter(item => item.role.startsWith('plan-'))).toHaveLength(1);
    expect(agent.seen.filter(item => item.role === 'generate').map(item => item.input.retrieval)).toEqual([first, first]);
    expect(readFormalizationArtifact(path.join(f.directory, 'artifact')).generation.input.retrieval).toEqual(first);
    for (const item of agent.seen.filter(item => item.role !== 'generate')) {
      expect(item.input).not.toHaveProperty('retrieval'); expect(JSON.stringify(item.input)).not.toContain(symbolMarker);
    }
  });

  it.each(['legacy', 'absent'] as const)('preserves %s requests without invoking the new lookup dependency', async protocol => {
    const f = await fixture(protocol), agent = preset(); let calls = 0;
    expect(await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate,
      lookupSymbols: async () => { calls++; throw new Error('Legacy requests must not query symbols.'); } }))
      .toMatchObject({ status: 'approved' });
    expect(calls).toBe(0);
    const generated = agent.seen.find(item => item.role === 'generate')!;
    if (protocol === 'legacy') {
      expect(f.request.retrieval).toMatchObject({ schema: 'theorem-os.formalization-retrieval-config.v1' });
      expect(f.request.retrieval).not.toHaveProperty('symbolProtocol');
      expect(generated.input.retrieval.schema).toBe('theorem-os.formalization-retrieval.v1');
      expect(generated.input.retrieval).not.toHaveProperty('librarySymbols');
      expect(generated.input.retrieval).not.toHaveProperty('librarySymbolQueries');
    } else {
      expect(f.request).not.toHaveProperty('retrieval'); expect(generated.input).not.toHaveProperty('retrieval');
      // Clean 17f964c already includes e9f7a14's same-directory atomic-output
      // guidance; adding the direct lookup tool must preserve these bytes.
      expect(generated.config.instructions).not.toContain('/opt/formalization/library-api.py');
      expect(mathDigest(generated.config.instructions)).toBe('3faf193a9f5736f8d525bac1f5098745ce5d4b66eec52233a18c81e3ed0a4211');
    }
  });
});


const resolvedDefinedNames = ['ConnectedSpace', 'SetLike.coe', 'Function.Injective', 'Field', 'Missing.Planned'];
const objectNoise = ['u', 'with', 'field', 'LocalMissing', 'v', 'α', 'H'];
const resolvedExpectedNames = [...resolvedDefinedNames, 'Nat', 'Real', ...objectNoise];

function resolvedPlan(statement: string): FormalizationPlan {
  const result = plan(statement);
  result.definitions = resolvedDefinedNames.map((name, index) => ({ id: 'library-' + index,
    spanIds: ['source'], mathematics: 'Exercise the installed-name query contract for ' + name,
    implementation: 'existing', leanNames: [name], dependsOn: [], justification: 'Synthetic library lookup fixture.' }));
  result.objects.push({ id: 'unresolved-type-text', spanIds: ['source'], description: 'A type sketch containing local notation and prose.',
    leanType: '(G : Type u) → Field G with field Missing.Planned LocalMissing u v α H' });
  return result;
}

const resolvedPacketOf = (evidence: FormalizationEvidence) => {
  const packet = evidence.generation.input.retrieval!;
  if (packet.schema !== 'theorem-os.formalization-retrieval.v3') throw new Error('Expected resolved-object retrieval protocol.');
  return packet;
};

describe('Lean-resolved object queries in formalization generation', () => {
  it('suppresses absent object names while retaining planned missing names and generator-only class/core metadata', async () => {
    const f = await fixture('resolved'), agent = preset(undefined, resolvedPlan), lookup = lookupFixture();
    expect(f.request.retrieval).toMatchObject({ schema: 'theorem-os.formalization-retrieval-config.v3',
      symbolProtocol: 'lean-exact-names-v1', queryProtocol: 'lean-resolved-objects-v1' });
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate, lookupSymbols: lookup.lookup });
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'approved', modelInvoked: false });
    expect(lookup.calls).toHaveLength(1);
    expect(lookup.calls[0].names).toEqual(resolvedExpectedNames);
    const evidence = readFormalizationArtifact(path.join(f.directory, 'artifact')), packet = resolvedPacketOf(evidence);
    expect(packet.algorithm).toBe('installed-plan-resolved-objects-v1');
    expect(packet.queries.map(item => item.query)).toEqual([...resolvedDefinedNames, 'Nat', 'Real']);
    expect(packet.librarySymbolQueries.map(item => item.name)).toEqual(resolvedExpectedNames);
    expect(packet.librarySymbols.symbols).toEqual(symbolsFor(resolvedExpectedNames, 'mathlib').symbols);
    expect(packet.omittedObjectQueries).toEqual(objectNoise.map(name => ({ name,
      origins: [{ kind: 'object', id: 'unresolved-type-text' }], reason: 'not-in-environment' })));
    expect(packet.queries.find(item => item.query === 'Field')!.origins).toEqual([
      { kind: 'definition', id: 'library-3' }, { kind: 'object', id: 'unresolved-type-text' }]);
    expect(packet.queries.find(item => item.query === 'Missing.Planned')!.origins).toEqual([
      { kind: 'definition', id: 'library-4' }, { kind: 'object', id: 'unresolved-type-text' }]);
    expect(packet.omittedObjectQueries.some(item => item.name === 'Missing.Planned')).toBe(false);
    const connected = packet.librarySymbols.symbols.find(item => item.name === 'ConnectedSpace')!;
    expect(connected.exists && connected.fields.some(field => field.name === symbolMarker)).toBe(true);
    const injective = packet.librarySymbols.symbols.find(item => item.name === 'Function.Injective')!;
    expect(injective.exists && injective.module).toBe('Init.Prelude');
    for (const item of agent.seen.filter(item => item.role !== 'generate')) {
      expect(item.input).not.toHaveProperty('retrieval');
      expect(JSON.stringify(item.input)).not.toContain(symbolMarker);
      expect(item.config.instructions).not.toContain('INPUT.retrieval');
    }
    expect(() => assertFormalizationEvidence(evidence)).not.toThrow();
    expect(evidence.proofVerified).toBe(false);
  });

  it('rejects changed lexical selection, omission provenance and metadata decisions after outer hashes are rewritten', async () => {
    const f = await fixture('resolved'), agent = preset(undefined, resolvedPlan), lookup = lookupFixture();
    expect(await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate, lookupSymbols: lookup.lookup }))
      .toMatchObject({ status: 'approved' });
    const original = readFormalizationArtifact(path.join(f.directory, 'artifact'));
    for (const mutation of ['query', 'omission missing', 'omission origin', 'omission case', 'metadata decision'] as const) {
      const evidence = structuredClone(original), packet = resolvedPacketOf(evidence);
      if (mutation === 'query') packet.queries.push({ query: 'u', origins: [{ kind: 'object', id: 'unresolved-type-text' }],
        totalMatches: 0, resultCount: 0, truncated: false });
      if (mutation === 'omission missing') packet.omittedObjectQueries.pop();
      if (mutation === 'omission origin') packet.omittedObjectQueries[0].origins[0].id = 'unplanned-object';
      if (mutation === 'omission case') packet.omittedObjectQueries[2].name = 'FIELD';
      if (mutation === 'metadata decision') {
        const index = packet.librarySymbols.symbols.findIndex(item => item.name === 'LocalMissing');
        packet.librarySymbols.symbols[index] = { name: 'LocalMissing', exists: true, module: 'Fixture',
          kind: 'definition', class: false, structure: false, type: 'Type', fields: [] };
        packet.librarySymbols.symbolsSha256 = mathDigest(canonicalMathJson(packet.librarySymbols.symbols));
      }
      generationSession(evidence).inputDigest = formalizationDigest(evidence.generation.input);
      expect(() => assertFormalizationEvidence(evidence), mutation).toThrow();
    }
  });

  it('stops a Lean lookup failure before lexical generation without retrying', async () => {
    const f = await fixture('resolved'), agent = preset(undefined, resolvedPlan); let calls = 0;
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate,
      lookupSymbols: async () => { calls++; throw new Error('lean_resolved_object_fixture_lookup_failed'); } });
    expect(result).toMatchObject({ status: 'stopped', rounds: 1, modelInvoked: false });
    expect(result.error).toContain('formalization_retrieval_failed:');
    expect(result.error).toContain('lean_resolved_object_fixture_lookup_failed');
    expect(calls).toBe(1);
    expect(agent.seen.map(item => item.role)).toEqual(['plan-1']);
    expect(readFormalizationState(f.directory)!.sessions).toHaveLength(1);
  });

  it('checks frozen corpus and source bytes before querying Lean in the resolved protocol', async () => {
    for (const changed of ['corpus', 'source'] as const) {
      const f = await fixture('resolved'), lookup = lookupFixture();
      const agent = preset(role => {
        if (!role.startsWith('plan-')) return;
        if (changed === 'corpus') {
          const file = path.join(f.directory, 'retrieval-corpus.json');
          fs.chmodSync(file, 0o600); fs.appendFileSync(file, '\n');
        } else fs.appendFileSync(f.source, '\ndef changed_after_plan : Nat := 1\n');
      }, resolvedPlan);
      const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate, lookupSymbols: lookup.lookup });
      expect(result).toMatchObject({ status: 'stopped', rounds: 1 });
      expect(result.error).toContain(changed === 'corpus' ? 'formalization_retrieval_corpus_changed' : 'math_corpus_source_changed');
      expect(lookup.calls).toHaveLength(0);
      expect(agent.seen.map(item => item.role)).toEqual(['plan-1']);
    }
  });

  it('restores a completed resolved artifact without reopening lookup, corpus, compiler or roles', async () => {
    const f = await fixture('resolved'), agent = preset(undefined, resolvedPlan), lookup = lookupFixture();
    expect(await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate, lookupSymbols: lookup.lookup }))
      .toMatchObject({ status: 'approved' });
    const digest = formalizationDigest(readFormalizationArtifact(path.join(f.directory, 'artifact')));
    fs.rmSync(f.workspace, { recursive: true }); fs.rmSync(f.corpusFile); fs.rmSync(path.join(f.directory, 'retrieval-corpus.json'));
    expect(await runFormalization(f.directory, f.root, {
      openSession: async () => { throw new Error('Completed artifacts must not reopen roles.'); },
      elaborate: async () => { throw new Error('Completed artifacts must not elaborate again.'); },
      lookupSymbols: async () => { throw new Error('Completed artifacts must not query Lean again.'); },
    })).toMatchObject({ status: 'approved', modelInvoked: false });
    expect(formalizationDigest(readFormalizationArtifact(path.join(f.directory, 'artifact')))).toBe(digest);
  });

  it('reuses the exact metadata lookup and resolved query packet when resuming an interrupted round', async () => {
    const f = await fixture('resolved'), controller = new AbortController(), lookup = lookupFixture(); let interrupted = false;
    const agent = preset(role => { if (role === 'generate' && !interrupted) { interrupted = true; controller.abort(); } }, resolvedPlan);
    expect(await runFormalization(f.directory, f.root,
      { openSession: agent.open, elaborate, lookupSymbols: lookup.lookup, signal: controller.signal }))
      .toMatchObject({ status: 'stopped', rounds: 1 });
    const first = agent.seen.find(item => item.role === 'generate')!.input.retrieval;
    expect(await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate, lookupSymbols: lookup.lookup }))
      .toMatchObject({ status: 'approved', rounds: 1 });
    expect(lookup.calls.map(item => item.names)).toEqual([resolvedExpectedNames]);
    expect(agent.seen.filter(item => item.role.startsWith('plan-'))).toHaveLength(1);
    expect(agent.seen.filter(item => item.role === 'generate').map(item => item.input.retrieval)).toEqual([first, first]);
    expect(readFormalizationArtifact(path.join(f.directory, 'artifact')).generation.input.retrieval).toEqual(first);
    for (const item of agent.seen.filter(item => item.role !== 'generate')) {
      expect(item.input).not.toHaveProperty('retrieval');
      expect(JSON.stringify(item.input)).not.toContain(symbolMarker);
    }
  });
});
