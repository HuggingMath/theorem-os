import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formalize } from '../scripts/mathematics/formalize';
import { formalizationDigest, readFormalizationRequest } from '../src/math/formalization';
import { readFirstProofCatalog } from '../src/math/firstProof';
import { readMathBuildManifest } from '../src/math/mathBuildManifest';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { createMathRetrievalCorpus } from '../src/math/mathRetrievalCorpus';

// Build identity is tested separately by mathBuildManifest tests. These CLI tests use a disposable
// stand-in, create no providers or Lean processes, and never claim semantic or benchmark success.
vi.mock('../src/math/mathBuildManifest', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/mathBuildManifest')>(),
  readMathBuildManifest: vi.fn((file: string) => JSON.parse(fs.readFileSync(file, 'utf8'))),
}));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'formalize-cli-offline-')));
  roots.push(base);
  const taskFile = path.join(base, 'original.txt'), manifest = path.join(base, 'stand-in-build.json');
  fs.writeFileSync(taskFile, 'For every natural number n, n + 0 = n.\n');
  fs.writeFileSync(manifest, '{\n  "testOnly": true\n}\n');
  const directory = path.join(base, 'request');
  const args = ['--phase', 'prepare', '--directory', directory, '--problem', 'natural_add_zero',
    '--task-file', taskFile, '--build-manifest', manifest];
  return { base, taskFile, manifest, directory, args };
}
async function retrievalFixture(f: ReturnType<typeof fixture>) {
  const workspace = path.join(f.base, 'library'), corpusFile = path.join(f.base, 'library.json');
  const config = getLeanTaskEnvironment('mathlib');
  fs.mkdirSync(workspace);
  for (const [name, text] of Object.entries(config.files)) fs.writeFileSync(path.join(workspace, name), text);
  const packageRoot = path.join(workspace, '.lake/packages/mathlib'); fs.mkdirSync(path.join(packageRoot, 'Mathlib'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'lakefile.lean'), 'import Lake\nopen Lake DSL\npackage mathlib\nlean_lib Mathlib\n');
  fs.writeFileSync(path.join(packageRoot, 'Mathlib/Natural.lean'), 'lemma add_zero (n : Nat) : n + 0 = n := by sorry\n');
  const corpus = JSON.stringify(await createMathRetrievalCorpus(workspace, ['mathlib'])); fs.writeFileSync(corpusFile, corpus);
  return { workspace, corpusFile, config, corpus, flags: ['--retrieval-workspace', workspace, '--retrieval-corpus', corpusFile] };
}
async function invoke(args: string[]) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const code = await formalize(args);
    const output = String(log.mock.calls.at(-1)?.[0]);
    return { code, output, report: args.includes('--help') ? undefined : JSON.parse(output) };
  } finally { log.mockRestore(); }
}

describe('formalize offline CLI', () => {
  it('prepares an immutable request without a model, preserving the complete original and default unlimited execution', async () => {
    const f = fixture();
    const original = 'Prove every assertion below.\n' + 'A long informal problem statement.\n'.repeat(400);
    fs.writeFileSync(f.taskFile, original);
    const result = await invoke(f.args);
    expect(result.code).toBe(0);
    expect(result.report).toMatchObject({ phase: 'prepare', status: 'prepared', modelInvoked: false, proofVerified: false,
      request: { problemId: 'natural_add_zero', environment: 'mathlib', execution: 'model', model: 'deepseek-flash', effort: 'max',
        maxRounds: 0, maxRunSeconds: 0, maxTurnSeconds: 0, maxCompileSeconds: 0, maxTotalTokens: 0,
        workflow: { maxPlanningRounds: 0 } } });
    const request = readFormalizationRequest(f.directory);
    expect(request.schema).toBe('theorem-os.formalization-request.v3');
    expect(request.contextProtocol).toBe('kernel-v2');
    expect(request.workflow.reviewers).toHaveLength(2);
    expect(request.statement).toBe(original);
    expect(request.buildDigest).toBe(mathDigest(fs.readFileSync(f.manifest)));
    expect(result.report.requestDigest).toBe(formalizationDigest(request));
    expect(result.output).not.toContain(original);
    expect(fs.statSync(path.join(f.directory, 'request.json')).mode & 0o222).toBe(0);
    expect(fs.readdirSync(f.directory)).toEqual(['request.json']);
    expect(readMathBuildManifest).toHaveBeenCalledWith(f.manifest, root, path.join(root, 'out/main'));
    fs.writeFileSync(f.taskFile, 'Later author edits must not rewrite the frozen request.\n');
    expect(readFormalizationRequest(f.directory).statement).toBe(original);
  });

  it('freezes explicitly chosen model, profile, environment and budgets without running them', async () => {
    const f = fixture();
    const result = await invoke([...f.args, '--environment', 'standard', '--model', 'offline-model-label', '--effort', 'medium',
      '--profile', path.join(f.base, 'unused-profile'), '--codex', '/unused/codex', '--max-rounds', '2',
      '--max-run-seconds', '60', '--max-turn-seconds', '20', '--max-compile-seconds', '10', '--max-total-tokens', '8000']);
    expect(result.report.request).toMatchObject({ environment: 'standard', model: 'offline-model-label', effort: 'medium',
      profile: path.join(f.base, 'unused-profile'), executable: '/unused/codex', maxRounds: 2,
      maxRunSeconds: 60, maxTurnSeconds: 20, maxCompileSeconds: 10, maxTotalTokens: 8000 });
    expect(fs.readdirSync(f.directory)).toEqual(['request.json']);
  });

  it('freezes an opt-in matching Mathlib corpus offline and preserves the snapshot on inspect', async () => {
    const f = fixture(), { workspace, corpusFile, config, corpus, flags } = await retrievalFixture(f);
    const prepared = await invoke([...f.args, ...flags]);
    expect(prepared.report.request.retrieval).toMatchObject({ schema: 'theorem-os.formalization-retrieval-config.v1',
      workspace, corpusSha256: mathDigest(corpus), sourceFiles: 1,
      toolchain: config.toolchain, mathlibRevision: config.mathlibRevision, environmentDigest: config.dependencyDigest });
    expect(prepared.report.request.retrieval).not.toHaveProperty('symbolProtocol');
    expect(prepared.report.request.retrieval).not.toHaveProperty('queryProtocol');
    expect(prepared.report.modelInvoked).toBe(false);
    const copied = path.join(f.directory, 'retrieval-corpus.json');
    expect(fs.readFileSync(copied, 'utf8')).toBe(corpus);
    expect(fs.statSync(copied).mode & 0o222).toBe(0);
    fs.writeFileSync(corpusFile, '{}');
    const inspected = await invoke(['--phase', 'inspect', '--directory', f.directory]);
    expect(inspected.report.request.retrieval).toEqual(prepared.report.request.retrieval);
    expect(fs.readdirSync(f.directory)).toEqual(['request.json', 'retrieval-corpus.json']);
  });

  it('freezes explicit exact-name symbol lookup without opening Lean or a model during preparation or inspection', async () => {
    const f = fixture(), { workspace, corpusFile, config, corpus, flags } = await retrievalFixture(f);
    const prepared = await invoke([...f.args, ...flags, '--retrieval-symbols', 'lean-exact-names-v1']);
    expect(prepared.code).toBe(0);
    expect(prepared.report).toMatchObject({ phase: 'prepare', modelInvoked: false, proofVerified: false,
      request: { retrieval: { schema: 'theorem-os.formalization-retrieval-config.v2', symbolProtocol: 'lean-exact-names-v1',
        workspace, corpusSha256: mathDigest(corpus), sourceFiles: 1, toolchain: config.toolchain,
        mathlibRevision: config.mathlibRevision, environmentDigest: config.dependencyDigest } } });
    const request = readFormalizationRequest(f.directory);
    expect(request.retrieval).toEqual(prepared.report.request.retrieval);
    expect(request.retrieval).not.toHaveProperty('queryProtocol');
    expect(fs.statSync(path.join(f.directory, 'request.json')).mode & 0o222).toBe(0);
    expect(fs.readFileSync(path.join(f.directory, 'retrieval-corpus.json'), 'utf8')).toBe(corpus);
    fs.writeFileSync(corpusFile, '{}');
    const inspected = await invoke(['--phase', 'inspect', '--directory', f.directory]);
    expect(inspected.report).toMatchObject({ phase: 'inspect', modelInvoked: false,
      request: { retrieval: prepared.report.request.retrieval }, state: { present: false } });
    expect(fs.readdirSync(f.directory)).toEqual(['request.json', 'retrieval-corpus.json']);
  });

  it('freezes resolved-object source queries only when explicitly requested, without running Lean or a model', async () => {
    const f = fixture(), { workspace, corpusFile, config, corpus, flags } = await retrievalFixture(f);
    const prepared = await invoke([...f.args, ...flags, '--retrieval-symbols', 'lean-exact-names-v1',
      '--retrieval-queries', 'lean-resolved-objects-v1']);
    expect(prepared.code).toBe(0);
    expect(prepared.report).toMatchObject({ phase: 'prepare', modelInvoked: false, proofVerified: false,
      request: { retrieval: { schema: 'theorem-os.formalization-retrieval-config.v3', symbolProtocol: 'lean-exact-names-v1',
        queryProtocol: 'lean-resolved-objects-v1', workspace, corpusSha256: mathDigest(corpus), sourceFiles: 1,
        toolchain: config.toolchain, mathlibRevision: config.mathlibRevision, environmentDigest: config.dependencyDigest } } });
    const request = readFormalizationRequest(f.directory);
    expect(request.retrieval).toEqual(prepared.report.request.retrieval);
    expect(fs.statSync(path.join(f.directory, 'request.json')).mode & 0o222).toBe(0);
    expect(fs.readFileSync(path.join(f.directory, 'retrieval-corpus.json'), 'utf8')).toBe(corpus);
    fs.writeFileSync(corpusFile, '{}');
    const inspected = await invoke(['--phase', 'inspect', '--directory', f.directory]);
    expect(inspected.report).toMatchObject({ phase: 'inspect', modelInvoked: false,
      request: { retrieval: prepared.report.request.retrieval }, state: { present: false } });
    expect(fs.readdirSync(f.directory)).toEqual(['request.json', 'retrieval-corpus.json']);
  });

  it('requires exact-name lookup for resolved-object queries and rejects an unknown protocol before creating output', async () => {
    const f = fixture();
    await expect(invoke([...f.args, '--retrieval-workspace', f.base, '--retrieval-corpus', '/unused',
      '--retrieval-queries', 'lean-resolved-objects-v1'])).rejects.toThrow(/requires.*retrieval-symbols/);
    await expect(invoke([...f.args, '--retrieval-symbols', 'lean-exact-names-v1', '--retrieval-queries', 'lean-resolved-objects-v1']))
      .rejects.toThrow(/requires.*retrieval-workspace.*retrieval-corpus/);
    await expect(invoke([...f.args, '--retrieval-workspace', f.base, '--retrieval-corpus', '/unused',
      '--retrieval-symbols', 'lean-exact-names-v1', '--retrieval-queries', 'unknown']))
      .rejects.toThrow('--retrieval-queries must be lean-resolved-objects-v1');
    await expect(invoke(['--phase', 'run', '--directory', f.directory, '--retrieval-queries', 'lean-resolved-objects-v1']))
      .rejects.toThrow('not valid');
    expect(fs.existsSync(f.directory)).toBe(false);
  });

  it('requires corpus configuration for symbol lookup and rejects an unknown protocol before creating output', async () => {
    const f = fixture();
    await expect(invoke([...f.args, '--retrieval-symbols', 'lean-exact-names-v1']))
      .rejects.toThrow(/requires.*retrieval-workspace.*retrieval-corpus/i);
    await expect(invoke([...f.args, '--retrieval-workspace', f.base, '--retrieval-corpus', '/unused', '--retrieval-symbols', 'unknown']))
      .rejects.toThrow('--retrieval-symbols must be lean-exact-names-v1');
    await expect(invoke(['--phase', 'run', '--directory', f.directory, '--retrieval-symbols', 'lean-exact-names-v1']))
      .rejects.toThrow('not valid');
    expect(fs.existsSync(f.directory)).toBe(false);
  });

  it('requires paired retrieval flags and rejects retrieval for standard Lean before creating output', async () => {
    const f = fixture();
    await expect(invoke([...f.args, '--retrieval-workspace', f.base])).rejects.toThrow('required together');
    await expect(invoke([...f.args, '--retrieval-corpus', '/unused'])).rejects.toThrow('required together');
    await expect(invoke([...f.args, '--environment', 'standard', '--retrieval-workspace', f.base, '--retrieval-corpus', '/unused']))
      .rejects.toThrow('formalization_retrieval_requires_mathlib');
    await expect(invoke(['--phase', 'run', '--directory', f.directory, '--retrieval-workspace', f.base]))
      .rejects.toThrow('not valid');
    expect(fs.existsSync(f.directory)).toBe(false);
  });

  it('accepts explicit zero for every execution limit and does not replace it with a finite default', async () => {
    const f = fixture();
    await invoke([...f.args, '--max-rounds', '0', '--max-planning-rounds', '0', '--max-run-seconds', '0',
      '--max-turn-seconds', '0', '--max-compile-seconds', '0', '--max-total-tokens', '0']);
    expect(readFormalizationRequest(f.directory)).toMatchObject({ maxRounds: 0, maxRunSeconds: 0,
      maxTurnSeconds: 0, maxCompileSeconds: 0, maxTotalTokens: 0, workflow: { maxPlanningRounds: 0 } });
  });

  it('accepts safe explicit limits above the former arbitrary upper bounds', async () => {
    const f = fixture();
    await invoke([...f.args, '--max-rounds', '21', '--max-planning-rounds', '6', '--max-run-seconds', '86401',
      '--max-turn-seconds', '3601', '--max-compile-seconds', '3601', '--max-total-tokens', '9007199254740991']);
    expect(readFormalizationRequest(f.directory)).toMatchObject({ maxRounds: 21, maxRunSeconds: 86401,
      maxTurnSeconds: 3601, maxCompileSeconds: 3601, maxTotalTokens: Number.MAX_SAFE_INTEGER,
      workflow: { maxPlanningRounds: 6 } });
  });

  it('takes pinned First Proof TeX directly and retains a complete long problem', async () => {
    const f = fixture(), catalog = readFirstProofCatalog(path.join(root, 'examples/first-proof/batch3'));
    const problem = catalog.problems[2];
    expect(problem.source.length).toBeGreaterThan(8_000);
    await invoke(['--phase', 'prepare', '--directory', f.directory, '--first-proof-problem', problem.id, '--build-manifest', f.manifest]);
    expect(readFormalizationRequest(f.directory)).toMatchObject({ problemId: problem.id,
      statement: problem.source, statementSha256: problem.sourceSha256 });
    expect(fs.existsSync(path.join(f.directory, 'artifact'))).toBe(false);
  });

  it('freezes separate review configurations and an optional reference without exposing its text', async () => {
    const f = fixture(), configFile = path.join(f.base, 'review-config.json'), referenceFile = path.join(f.base, 'reference.lean'),
      pairsFile = path.join(f.base, 'pairs.json');
    const role = (model: string) => ({ model, effort: 'high', profile: path.join(f.base, model), executable: '/unused/codex' });
    fs.writeFileSync(configFile, JSON.stringify({ planner: role('planner-model'), backtranslator: role('bt-model'),
      reviewers: [{ ...role('judge-a'), id: 'a' }, { ...role('judge-b'), id: 'b' }] }));
    fs.writeFileSync(referenceFile, 'theorem gold (n : Nat) : n + 0 = n := by sorry\n');
    fs.writeFileSync(pairsFile, JSON.stringify([{ candidateTarget: 'addition', referenceTarget: 'gold' }]));
    const result = await invoke([...f.args, '--review-config', configFile, '--max-planning-rounds', '3',
      '--reference-file', referenceFile, '--reference-pairs', pairsFile, '--reference-provenance', 'Synthetic test source.', '--max-reference-seconds', '10']);
    const request = readFormalizationRequest(f.directory);
    expect(request.workflow).toMatchObject({ planner: { model: 'planner-model' }, backtranslator: { model: 'bt-model' },
      reviewers: [{ id: 'a', model: 'judge-a' }, { id: 'b', model: 'judge-b' }], maxPlanningRounds: 3,
      reference: { source: fs.readFileSync(referenceFile, 'utf8'), maxSeconds: 10 } });
    expect(result.output).not.toContain('theorem gold');
    expect(fs.readdirSync(f.directory)).toEqual(['request.json']);
  });

  it.each([undefined, '0'])('keeps optional reference comparison unlimited with --max-reference-seconds %s', async maxSeconds => {
    const f = fixture(), referenceFile = path.join(f.base, 'reference.lean'), pairsFile = path.join(f.base, 'pairs.json');
    fs.writeFileSync(referenceFile, 'theorem gold (n : Nat) : n + 0 = n := by sorry\n');
    fs.writeFileSync(pairsFile, JSON.stringify([{ candidateTarget: 'addition', referenceTarget: 'gold' }]));
    await invoke([...f.args, '--reference-file', referenceFile, '--reference-pairs', pairsFile,
      '--reference-provenance', 'Synthetic fixture only.', ...(maxSeconds === undefined ? [] : ['--max-reference-seconds', maxSeconds])]);
    expect(readFormalizationRequest(f.directory).workflow.reference.maxSeconds).toBe(0);
  });

  it('rejects incomplete reference configuration and duplicate reviewer identities without creating output', async () => {
    const f = fixture();
    await expect(invoke([...f.args, '--reference-file', '/unused'])).rejects.toThrow('required together');
    await expect(invoke([...f.args, '--max-reference-seconds', '5'])).rejects.toThrow('requires --reference-file');
    const configFile = path.join(f.base, 'bad-reviewers.json');
    const role = { model: 'x', effort: 'none', profile: '/unused', executable: '/unused' };
    fs.writeFileSync(configFile, JSON.stringify({ planner: role, backtranslator: role,
      reviewers: [{ ...role, id: 'same' }, { ...role, id: 'same' }] }));
    await expect(invoke([...f.args, '--review-config', configFile])).rejects.toThrow('formalization_reviewer_id_duplicate');
    expect(fs.existsSync(f.directory)).toBe(false);
  });

  it('inspects without creating a run, revealing source text or attaching unvalidated approval', async () => {
    const f = fixture(); await invoke(f.args);
    const request = readFormalizationRequest(f.directory);
    let result = await invoke(['--phase', 'inspect', '--directory', f.directory]);
    expect(result.report).toMatchObject({ phase: 'inspect', modelInvoked: false, state: { present: false },
      artifact: { status: 'missing', valid: false } });
    expect(result.output).not.toContain(request.statement.trim());
    fs.writeFileSync(path.join(f.directory, 'state.json'), JSON.stringify({ requestDigest: formalizationDigest(request),
      status: 'running', rounds: 1, elapsedMs: 100, sessions: [{ privateContent: 'should not appear' }],
      feedback: 'not part of the bounded summary' }));
    result = await invoke(['--phase', 'inspect', '--directory', f.directory]);
    expect(result.report.state).toMatchObject({ present: true, status: 'running', rounds: 1, elapsedMs: 100, sessionCount: 1 });
    expect(result.output).not.toContain('privateContent');
    expect(result.output).not.toContain('not part of the bounded summary');
    expect(fs.existsSync(path.join(f.directory, 'workspace'))).toBe(false);
  });

  it('reports an invalid stored artifact as invalid and rejects state belonging to another request', async () => {
    const f = fixture(); await invoke(f.args);
    const artifact = path.join(f.directory, 'artifact'); fs.mkdirSync(artifact);
    fs.writeFileSync(path.join(artifact, 'evidence.json'), '{}');
    const result = await invoke(['--phase', 'inspect', '--directory', f.directory]);
    expect(result.code).toBe(2); expect(result.report.artifact).toMatchObject({ status: 'invalid', valid: false });
    fs.writeFileSync(path.join(f.directory, 'state.json'), JSON.stringify({ requestDigest: '0'.repeat(64) }));
    await expect(invoke(['--phase', 'inspect', '--directory', f.directory])).rejects.toThrow('formalization_state_request_mismatch');
  });

  it('does not overwrite existing material or permit output through repository paths or symlinks', async () => {
    const f = fixture(); await invoke(f.args);
    const before = fs.readFileSync(path.join(f.directory, 'request.json'), 'utf8');
    await expect(invoke(f.args)).rejects.toThrow('formalization_directory_exists');
    expect(fs.readFileSync(path.join(f.directory, 'request.json'), 'utf8')).toBe(before);
    const linked = path.join(f.base, 'linked'); fs.symlinkSync(f.directory, linked);
    await expect(invoke(['--phase', 'inspect', '--directory', linked])).rejects.toThrow('math_path_invalid');
    await expect(invoke(['--phase', 'prepare', '--directory', path.join(linked, 'child'), '--problem', 'test',
      '--task-file', f.taskFile, '--build-manifest', f.manifest])).rejects.toThrow('math_path_invalid');
    await expect(invoke(['--phase', 'prepare', '--directory', path.join(root, 'unused-formalization-output')]))
      .rejects.toThrow('outside the source repository');
  });

  it.each(['-1', '1.5', '1e1', '9007199254740993'])('rejects invalid rounds %s before creating output', async rounds => {
    const f = fixture();
    await expect(invoke([...f.args, '--max-rounds', rounds])).rejects.toThrow();
    expect(fs.existsSync(f.directory)).toBe(false);
  });

  it.each(['max-planning-rounds', 'max-run-seconds', 'max-turn-seconds', 'max-compile-seconds', 'max-total-tokens'])(
    'rejects a negative --%s before creating output', async flag => {
      const f = fixture();
      await expect(invoke([...f.args, '--' + flag + '=-1'])).rejects.toThrow('must be an integer');
      expect(fs.existsSync(f.directory)).toBe(false);
    });

  it('rejects ambiguous inputs, invalid phase options and missing build identity without creating output', async () => {
    const f = fixture();
    await expect(invoke([...f.args, '--first-proof-problem', 'first_proof_batch3_01'])).rejects.toThrow('mutually exclusive');
    await expect(invoke([...f.args, '--source-root', '/unused'])).rejects.toThrow('--source-root requires');
    await expect(invoke([...f.args, '--problem', 'duplicate'])).rejects.toThrow('Duplicate argument');
    await expect(invoke([...f.args, '--environment', 'other'])).rejects.toThrow('--environment');
    await expect(invoke(f.args.slice(0, -2))).rejects.toThrow('--build-manifest is required');
    await expect(invoke(['--phase', 'run', '--directory', f.directory, '--model', 'override'])).rejects.toThrow('not valid');
    await expect(invoke(['--phase', 'inspect', '--directory', f.directory, '--task-file', f.taskFile])).rejects.toThrow('not valid');
    await expect(invoke(['--phase', 'replay', '--directory', f.directory, '--max-rounds', '2'])).rejects.toThrow('not valid');
    await expect(invoke(['--phase', 'unknown', '--directory', f.directory])).rejects.toThrow('Unknown formalization phase');
    expect(fs.existsSync(f.directory)).toBe(false);
  });

  it('rejects a replay request on the model run path and refuses to reuse a replay directory', async () => {
    const f = fixture(); await invoke(f.args);
    const file = path.join(f.directory, 'request.json');
    const request = readFormalizationRequest(f.directory);
    fs.chmodSync(file, 0o600); fs.writeFileSync(file, JSON.stringify({ ...request, execution: 'replay' }));
    await expect(invoke(['--phase', 'run', '--directory', f.directory])).rejects.toThrow('formalization_run_requires_model_request');
    await expect(invoke(['--phase', 'replay', '--directory', f.directory, '--build-manifest', f.manifest]))
      .rejects.toThrow('formalization_directory_exists');
    expect(fs.readdirSync(f.directory)).toEqual(['request.json']);
  });

  it('prints useful help without requiring inputs or loading a model', async () => {
    const result = await invoke(['--help']);
    expect(result.code).toBe(0);
    expect(result.output).toContain('prepare|run|inspect|replay');
    expect(result.output).toContain('independent statement review');
    expect(result.output).toContain('--retrieval-symbols lean-exact-names-v1');
    expect(result.output).toContain('--retrieval-queries lean-resolved-objects-v1');
    expect(result.output).toContain('docs/formalization.md');
  });
});
