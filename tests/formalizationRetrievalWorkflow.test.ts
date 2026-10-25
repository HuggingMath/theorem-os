import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertFormalizationEvidence, formalizationDigest, prepareFormalization,
  readFormalizationArtifact, readFormalizationRequest, type FormalizationEvidence } from '../src/math/formalization';
import type { FormalizationPlan } from '../src/math/formalizationPlan';
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

async function fixture(retrieval = true) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'formalization-retrieval-workflow-')));
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
    ...(retrieval ? { retrieval: { workspace, corpusFile } } : {}),
  });
  return { base, root, directory, workspace, source, corpusFile, request };
}

function plan(statement: string): FormalizationPlan {
  return { schema: 'theorem-os.formalization-plan.v1', taskKind: 'prove',
    spans: [{ id: 'source', start: 0, end: statement.length, text: statement }],
    objects: [{ id: 'natural-number', spanIds: ['source'], description: 'Every natural number n.', leanType: 'Nat' }],
    assumptions: [], definitions: [], unresolved: [], conclusions: [{ id: 'zero-identity', spanIds: ['source'],
      mathematics: 'For every natural n, n + 0 = n.', targetNames: ['addition'], assumptionIds: [] }] };
}

function preset(afterOutput?: (role: string, input: any) => void) {
  let sequence = 0;
  const seen: { role: string; input: any; config: MathAgentOptions }[] = [];
  const open = async (config: MathAgentOptions): Promise<MathAgentSession> => {
    const id = ++sequence, role = path.basename(config.workspace);
    return { threadId: 'preset-retrieval-thread-' + id, close: async () => {}, interrupt: async () => {},
      run: async (_message, _id, workspace, onStarted) => {
        onStarted('preset-retrieval-turn-' + id); config.onUsage({ totalTokens: 1 });
        const input = JSON.parse(readMathText(path.join(workspace, 'INPUT.json')));
        seen.push({ role, input, config });
        const output = role.startsWith('plan-') ? plan(input.statement) : role === 'generate' ? candidateFixture(input.statement) :
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

describe('frozen plan retrieval in formalization generation', () => {
  it('assembles plan-derived hints for the generator while keeping every other role independent', async () => {
    const f = await fixture(), agent = preset();
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate });
    expect(result.status, JSON.stringify(result)).toBe('approved');
    expect(result).toMatchObject({ status: 'approved', modelInvoked: false });
    expect(agent.seen.map(item => item.role)).toEqual(['plan-1', 'generate', 'backtranslate', 'compare-reviewer-1', 'compare-reviewer-2']);
    const generated = agent.seen.find(item => item.role === 'generate')!;
    expect(generated.input.retrieval.queries).toEqual([{ query: 'Nat',
      origins: [{ kind: 'object', id: 'natural-number' }], totalMatches: 2, truncated: false, resultCount: 2 }]);
    expect(JSON.stringify(generated.input.retrieval)).toContain(marker);
    expect(generated.input.retrieval).toMatchObject({
      configurationDigest: formalizationDigest(f.request.retrieval), corpusSha256: f.request.retrieval!.corpusSha256,
      planDigest: formalizationDigest(generated.input.plan), environmentDigest: f.request.environmentDigest,
    });
    expect(generated.config.instructions).toContain('INPUT.retrieval');
    for (const item of agent.seen.filter(item => item.role !== 'generate')) {
      expect(item.input).not.toHaveProperty('retrieval');
      expect(JSON.stringify(item.input)).not.toContain(marker);
      expect(item.config.instructions).not.toContain('INPUT.retrieval');
    }
    const evidence = readFormalizationArtifact(path.join(f.directory, 'artifact'));
    expect(evidence.generation.input.retrieval).toEqual(generated.input.retrieval);
    expect(evidence.proofVerified).toBe(false);
    expect(fs.readFileSync(path.join(f.directory, 'retrieval-corpus.json'), 'utf8')).toBe(fs.readFileSync(f.corpusFile, 'utf8'));
    expect(readFormalizationRequest(f.directory)).toEqual(f.request);
  });

  it.each(['configuration', 'corpus', 'plan', 'query', 'query-origin', 'missing'] as const)(
    'rejects %s packet tampering after the generation session hash is rewritten', async field => {
      const f = await fixture(), agent = preset();
      expect(await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate })).toMatchObject({ status: 'approved' });
      const evidence = structuredClone(readFormalizationArtifact(path.join(f.directory, 'artifact')));
      const packet = evidence.generation.input.retrieval!;
      if (field === 'configuration') packet.configurationDigest = 'a'.repeat(64);
      if (field === 'corpus') packet.corpusSha256 = 'a'.repeat(64);
      if (field === 'plan') packet.planDigest = 'a'.repeat(64);
      if (field === 'query') packet.queries[0].query = 'Int';
      if (field === 'query-origin') packet.queries[0].origins[0].id = 'unplanned-object';
      if (field === 'missing') delete evidence.generation.input.retrieval;
      generationSession(evidence).inputDigest = formalizationDigest(evidence.generation.input);
      expect(() => assertFormalizationEvidence(evidence)).toThrow('formalization_retrieval_input_mismatch');
    });

  it('restores the approved artifact without reopening roles or rereading the retrieval workspace', async () => {
    const f = await fixture(), agent = preset();
    expect(await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate })).toMatchObject({ status: 'approved' });
    const digest = formalizationDigest(readFormalizationArtifact(path.join(f.directory, 'artifact')));
    fs.rmSync(f.workspace, { recursive: true });
    fs.rmSync(f.corpusFile);
    fs.rmSync(path.join(f.directory, 'retrieval-corpus.json'));
    let opened = 0;
    const restored = await runFormalization(f.directory, f.root, { openSession: async () => {
      opened++; throw new Error('A completed artifact must not reopen any role.');
    }, elaborate: async () => { throw new Error('A completed artifact must not elaborate again.'); } });
    expect(restored).toMatchObject({ status: 'approved', modelInvoked: false });
    expect(opened).toBe(0);
    expect(formalizationDigest(readFormalizationArtifact(path.join(f.directory, 'artifact')))).toBe(digest);
  });

  it('reuses the deterministic packet after interruption and replanning the same frozen task', async () => {
    const f = await fixture(), controller = new AbortController();
    let interrupted = false;
    const agent = preset(role => {
      if (role === 'generate' && !interrupted) { interrupted = true; controller.abort(); }
    });
    const stopped = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate, signal: controller.signal });
    expect(stopped).toMatchObject({ status: 'stopped', rounds: 1 });
    expect(fs.existsSync(path.join(f.directory, 'artifact'))).toBe(false);
    const first = agent.seen.find(item => item.role === 'generate')!.input.retrieval;
    expect(await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate })).toMatchObject({ status: 'approved', rounds: 2 });
    const generated = agent.seen.filter(item => item.role === 'generate');
    expect(generated).toHaveLength(2);
    expect(generated[1].input.retrieval).toEqual(first);
    expect(formalizationDigest(generated[1].input.retrieval)).toBe(formalizationDigest(first));
    expect(readFormalizationArtifact(path.join(f.directory, 'artifact')).generation.input.retrieval).toEqual(first);
  });

  it.each(['corpus', 'source'] as const)('stops a changed frozen %s before generation without retrying', async field => {
    const f = await fixture();
    const agent = preset(role => {
      if (!role.startsWith('plan-')) return;
      if (field === 'corpus') {
        const file = path.join(f.directory, 'retrieval-corpus.json');
        fs.chmodSync(file, 0o600); fs.appendFileSync(file, '\n');
      } else fs.appendFileSync(f.source, '\ndef changed_after_plan : Nat := 1\n');
    });
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate });
    expect(result).toMatchObject({ status: 'stopped', rounds: 1 });
    expect(result.error).toContain('formalization_retrieval_failed:');
    expect(result.error).toContain(field === 'corpus' ? 'formalization_retrieval_corpus_changed' : 'math_corpus_source_changed');
    expect(agent.seen.map(item => item.role)).toEqual(['plan-1']);
    expect(readFormalizationState(f.directory)!.sessions).toHaveLength(1);
    expect(fs.existsSync(path.join(f.directory, 'artifact'))).toBe(false);
  });

  it('preserves absent retrieval and the prior generator protocol bytes', async () => {
    const f = await fixture(false), agent = preset();
    expect(f.request).not.toHaveProperty('retrieval');
    expect(fs.existsSync(path.join(f.directory, 'retrieval-corpus.json'))).toBe(false);
    expect(await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate })).toMatchObject({ status: 'approved' });
    const generated = agent.seen.find(item => item.role === 'generate')!;
    expect(generated.input).not.toHaveProperty('retrieval');
    // Frozen from the previous kernel-context replay, before retrieval integration.
    expect(mathDigest(generated.config.instructions)).toBe('07254466c8314ec42eddbc5f896763f31d6f34017d1670cb7b79268878876994');
    const evidence = readFormalizationArtifact(path.join(f.directory, 'artifact'));
    expect(evidence.generation.input).not.toHaveProperty('retrieval');
    expect(readFormalizationRequest(f.directory)).toEqual(f.request);
  });
});
