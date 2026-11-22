import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { informalize } from '../scripts/mathematics/informalize';
import { formalizationDigest, readFormalizationArtifact } from '../src/math/formalization';
import { INFORMALIZATION_ALIGNMENT, INFORMALIZATION_EXPLANATION_POLICY, informalizationDigest, readInformalizationRequest } from '../src/math/informalization';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { ADDITION_PROOF, approvedFormalization } from './helpers/approvedFormalizationFixture';
import { fixtureStatement } from './helpers/formalizationFixture';
import { LIB_SOURCE, PROOF_SOURCE, informalizationFixture } from './helpers/informalizationFixture';
import { workflowHarnessFixture } from './helpers/workflowHarnessFixture';

// Build identity is tested by mathBuildManifest tests; these offline CLI tests use the fixture's stand-in build and open no model.
vi.mock('../src/math/mathBuildManifest', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/mathBuildManifest')>(),
  readMathBuildManifest: vi.fn((file: string) => JSON.parse(fs.readFileSync(file, 'utf8'))),
}));
const forbidden = vi.hoisted(() => ({ model: vi.fn(async () => { throw new Error('model_must_not_open'); }) }));
vi.mock('../src/runtime/codexSession', async original =>
  ({ ...await original<typeof import('../src/runtime/codexSession')>(), createCodexMathSession: forbidden.model }));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  expect(forbidden.model).not.toHaveBeenCalled();
});
function fixture() {
  const f = informalizationFixture(roots);
  const args = ['--phase', 'prepare', '--directory', f.directory, '--proof-file', path.join(f.project, 'Proof.lean'),
    '--target', 'double_add_zero', '--environment', 'standard', '--build-manifest', f.preparation.buildManifestRef];
  return { ...f, args };
}
async function invoke(args: string[]) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const code = await informalize(args);
    const output = String(log.mock.calls.at(-1)?.[0]);
    return { code, output, report: args.includes('--help') ? undefined : JSON.parse(output) };
  } finally { log.mockRestore(); }
}

describe('informalize offline CLI', () => {
  it.each(['claude-code', 'opencode', 'cli'] as const)('freezes %s for the sealed explanation writer and auditors', async harness => {
    const f = fixture(), selected = workflowHarnessFixture(f.base, harness);
    expect((await invoke([...f.args, ...selected.flags])).code).toBe(0);
    const { request } = readInformalizationRequest(f.directory);
    expect(request.writer.agentHarness).toMatchObject(selected.binding);
    for (const role of request.auditors) expect(role.agentHarness).toEqual(request.writer.agentHarness);
  });

  it('rejects a generic CLI without sealed projection before copying proof sources', async () => {
    const f = fixture(), selected = workflowHarnessFixture(f.base, 'cli', false);
    await expect(invoke([...f.args, ...selected.flags])).rejects.toThrow('math_cli_sealed_role_configuration_required');
    expect(fs.existsSync(f.directory)).toBe(false);
  });

  it('freezes an explicit Codex binding for the writer and each auditor', async () => {
    const f = fixture(), profile = path.join(f.base, 'profile'), executable = path.join(f.base, 'native');
    fs.mkdirSync(profile); fs.writeFileSync(path.join(profile, 'config.toml'), 'model = "fixture"\n');
    fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    expect((await invoke([...f.args, '--harness', 'codex', '--harness-profile', profile, '--harness-executable', executable])).code).toBe(0);
    const { request } = readInformalizationRequest(f.directory);
    expect(request.writer.agentHarness).toMatchObject({ id: 'codex', executable, profile });
    for (const role of request.auditors) expect(role.agentHarness).toEqual(request.writer.agentHarness);
  });

  it('prepares a frozen request with the documented defaults and inspects it without a model', async () => {
    const f = fixture(), profile = path.join(f.base, 'codex-home');
    vi.stubEnv('CODEX_HOME', profile); vi.stubEnv('DEEPSCIENTIST_MATH_CODEX_EXECUTABLE', '');
    const prepared = await invoke(f.args);
    const { request } = readInformalizationRequest(f.directory);
    const writer = { model: 'deepseek-flash', effort: 'max', profile, executable: 'codex' };
    expect(prepared).toMatchObject({ code: 0, report: { phase: 'prepare', status: 'prepared', modelInvoked: false,
      requestDigest: informalizationDigest(request), request: { proofId: 'double_add_zero', target: 'double_add_zero',
        environment: 'standard', rootModule: 'Proof', language: 'zh', statementSha256: null, alignment: INFORMALIZATION_ALIGNMENT,
        explanationPolicy: INFORMALIZATION_EXPLANATION_POLICY, writer,
        auditors: [{ ...writer, id: 'auditor-1' }, { ...writer, id: 'auditor-2' }],
        batching: { maxUnits: 12, maxSourceBytes: 60_000 }, maxRoundsPerBatch: 6,
        maxRunSeconds: 0, maxTurnSeconds: 0, maxCompileSeconds: 0, maxTotalTokens: 0,
        buildManifestRef: f.preparation.buildManifestRef, buildDigest: mathDigest(fs.readFileSync(f.preparation.buildManifestRef, 'utf8')),
        sources: [{ origin: 'Lib.lean', sha256: mathDigest(LIB_SOURCE), bytes: Buffer.byteLength(LIB_SOURCE) },
          { origin: 'Proof.lean', sha256: mathDigest(PROOF_SOURCE), bytes: Buffer.byteLength(PROOF_SOURCE) }] } } });
    expect(fs.readdirSync(f.directory).toSorted()).toEqual(['request.json', 'sources']);
    expect(await invoke(['--phase', 'inspect', '--directory', f.directory])).toMatchObject({ code: 0, report: { phase: 'inspect',
      modelInvoked: false, requestDigest: informalizationDigest(request), state: { present: false },
      artifact: { status: 'missing', valid: false } } });
    expect(fs.readdirSync(f.directory).toSorted()).toEqual(['request.json', 'sources']);
  });

  it('records explicit options and hashes the statement without echoing it', async () => {
    const f = fixture(), statement = path.join(f.base, 'statement.txt');
    fs.writeFileSync(statement, 'Show that double (n + 0) is 2n.\n');
    const { report } = await invoke([...f.args, '--statement-file', statement, '--language', 'en', '--proof-id', 'custom-id',
      '--model', 'other-model', '--effort', 'high', '--profile', path.join(f.base, 'profile'), '--codex', '/opt/codex',
      '--auditors', '3', '--max-rounds-per-batch', '2', '--max-units-per-batch', '5', '--max-batch-source-bytes', '1000',
      '--max-run-seconds', '60', '--max-turn-seconds', '30', '--max-compile-seconds', '20', '--max-total-tokens', '9000',
      '--project-root', f.project]);
    expect(report.request).toMatchObject({ proofId: 'custom-id', language: 'en',
      statementSha256: mathDigest('Show that double (n + 0) is 2n.\n'),
      writer: { model: 'other-model', effort: 'high', profile: path.join(f.base, 'profile'), executable: '/opt/codex' },
      batching: { maxUnits: 5, maxSourceBytes: 1000 }, maxRoundsPerBatch: 2, maxRunSeconds: 60, maxTurnSeconds: 30,
      maxCompileSeconds: 20, maxTotalTokens: 9000 });
    expect(report.request.auditors.map((auditor: { id: string }) => auditor.id)).toEqual(['auditor-1', 'auditor-2', 'auditor-3']);
    expect(JSON.stringify(report)).not.toContain('Show that double');
    expect(readInformalizationRequest(f.directory).request.statement).toBe('Show that double (n + 0) is 2n.\n');
  });

  it.each([['auditors', '0'], ['auditors', '6'], ['auditors', '1.5'], ['max-rounds-per-batch', '-1'],
    ['max-units-per-batch', '1e1'], ['max-batch-source-bytes', '9007199254740993'], ['max-total-tokens', '-1']])(
    'rejects --%s %s before creating output', async (flag, value) => {
      const f = fixture();
      await expect(invoke([...f.args, '--' + flag + '=' + value])).rejects.toThrow(/must be|between/u);
      expect(fs.existsSync(f.directory)).toBe(false);
    });

  it('rejects invalid inputs, phase options and output paths without creating output', async () => {
    const f = fixture();
    await expect(invoke(f.args.map(arg => arg === 'standard' ? 'other' : arg))).rejects.toThrow('--environment must be');
    await expect(invoke([...f.args, '--language', 'fr'])).rejects.toThrow('--language must be');
    await expect(invoke([...f.args, '--target', 'again'])).rejects.toThrow('Duplicate argument');
    await expect(invoke(f.args.slice(0, -2))).rejects.toThrow('--build-manifest is required');
    await expect(invoke(['--phase', 'run', '--directory', f.directory, '--model', 'override'])).rejects.toThrow('not valid for --phase run');
    await expect(invoke(['--phase', 'inspect', '--directory', f.directory, '--target', 'x'])).rejects.toThrow('not valid for --phase inspect');
    await expect(invoke(['--phase', 'unknown', '--directory', f.directory])).rejects.toThrow('Unknown informalization phase');
    await expect(invoke(['--phase', 'prepare', '--directory', path.join(root, 'unused-informalization-output')]))
      .rejects.toThrow('outside the source repository');
    expect(fs.existsSync(f.directory)).toBe(false);
    expect(fs.existsSync(path.join(root, 'unused-informalization-output'))).toBe(false);
  });

  it('never overwrites a request and refuses symlinked directories', async () => {
    const f = fixture(); await invoke(f.args);
    const before = fs.readFileSync(path.join(f.directory, 'request.json'), 'utf8');
    await expect(invoke(f.args)).rejects.toThrow('informalization_directory_exists');
    expect(fs.readFileSync(path.join(f.directory, 'request.json'), 'utf8')).toBe(before);
    const linked = path.join(f.base, 'linked'); fs.symlinkSync(f.directory, linked);
    await expect(invoke(['--phase', 'inspect', '--directory', linked])).rejects.toThrow('math_path_invalid');
    await expect(invoke(['--phase', 'run', '--directory', linked])).rejects.toThrow('math_path_invalid');
  });

  it('refuses a state written for another request and a run whose build changed', async () => {
    const f = fixture(); await invoke(f.args);
    fs.writeFileSync(path.join(f.directory, 'state.json'), JSON.stringify({ requestDigest: 'f'.repeat(64), status: 'running' }));
    await expect(invoke(['--phase', 'inspect', '--directory', f.directory])).rejects.toThrow('informalization_state_request_mismatch');
    fs.rmSync(path.join(f.directory, 'state.json'));
    fs.chmodSync(f.preparation.buildManifestRef, 0o600); fs.appendFileSync(f.preparation.buildManifestRef, '\n');
    await expect(invoke(['--phase', 'run', '--directory', f.directory])).rejects.toThrow('informalization_build_changed');
    expect(fs.readdirSync(f.directory).toSorted()).toEqual(['request.json', 'sources']);
  });

  it('binds a formalization given as its run or its artifact, and opts out of phrase alignment on request', async () => {
    const run = await approvedFormalization(roots), evidence = readFormalizationArtifact(path.join(run, 'artifact'));
    for (const given of [run, path.join(run, 'artifact')]) {
      const f = informalizationFixture(roots, {}, { 'Proof.lean': ADDITION_PROOF });
      const { report } = await invoke(['--phase', 'prepare', '--directory', f.directory, '--proof-file', path.join(f.project, 'Proof.lean'),
        '--target', 'addition', '--environment', 'standard', '--build-manifest', f.preparation.buildManifestRef, '--formalization', given]);
      expect(report.request).toMatchObject({ target: 'addition', statementSha256: mathDigest(fixtureStatement), alignment: INFORMALIZATION_ALIGNMENT,
        formalization: { problemId: 'synthetic_addition', evidenceSha256: formalizationDigest(evidence) } });
      expect(JSON.stringify(report)).not.toContain(fixtureStatement);
      expect(fs.readdirSync(f.directory).toSorted()).toEqual(['formalization', 'request.json', 'sources']);
    }
    const f = fixture();
    expect((await invoke([...f.args, '--alignment', 'none'])).report.request.alignment).toBe('none');
    expect(readInformalizationRequest(f.directory).request).not.toHaveProperty('alignment');
  });

  it('can prepare the legacy explanation contract and inspect existing requests without adding a policy', async () => {
    const f = fixture();
    const prepared = await invoke([...f.args, '--explanation-policy', 'none']);
    const { request } = readInformalizationRequest(f.directory);
    expect(request).not.toHaveProperty('explanationPolicy');
    expect(prepared.report.request).not.toHaveProperty('explanationPolicy');
    const before = fs.readFileSync(path.join(f.directory, 'request.json'), 'utf8');
    const inspected = await invoke(['--phase', 'inspect', '--directory', f.directory]);
    expect(inspected.report.request).not.toHaveProperty('explanationPolicy');
    expect(inspected.report.requestDigest).toBe(informalizationDigest(request));
    expect(fs.readFileSync(path.join(f.directory, 'request.json'), 'utf8')).toBe(before);
  });

  it('refuses a statement beside a formalization, an unknown alignment and a directory without an approved artifact', async () => {
    const f = fixture(), statement = path.join(f.base, 'statement.txt');
    fs.writeFileSync(statement, 'Show that double (n + 0) is 2n.\n');
    await expect(invoke([...f.args, '--statement-file', statement, '--formalization', f.base]))
      .rejects.toThrow('--statement-file and --formalization are exclusive');
    for (const old of ['lean-phrase-alignment-v1', 'lean-phrase-alignment-v3'])
      await expect(invoke([...f.args, '--alignment', old])).rejects.toThrow('--alignment must be lean-phrase-alignment-v2 or none');
    await expect(invoke([...f.args, '--formalization', f.base])).rejects.toThrow('--formalization must name an approved formalization run or its artifact');
    await expect(invoke([...f.args, '--explanation-policy', 'unknown'])).rejects.toThrow('--explanation-policy must be mathematical-steps-v1, mathematical-steps-v2, none');
    expect(fs.existsSync(f.directory)).toBe(false);
  });

  it('prints help without inputs', async () => {
    const result = await invoke(['--help']);
    expect(result.code).toBe(0);
    for (const text of ['prepare|run|inspect|report', '--max-rounds-per-batch 6', '--max-units-per-batch 12', '--auditors 2',
      'auditors never see it', '--formalization DIR', 'excludes --statement-file', '--alignment lean-phrase-alignment-v2|none',
      '--explanation-policy mathematical-steps-v1|mathematical-steps-v2|none',
      'report (offline): --output FILE.html', 'not human-reviewed', 'docs/informalization.md']) expect(result.output).toContain(text);
  });
});
