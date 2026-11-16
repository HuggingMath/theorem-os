import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateFormalization } from '../scripts/mathematics/evaluateFormalization';
import { prepareFormalizationEvaluation, readFormalizationEvaluationBundle, formalizationEvaluationInputDigest,
  formalizationEvaluationLeanSource, type FormalizationEvaluationReviewerInput } from '../src/math/formalizationEvaluation';
import type { FormalizationSemanticReview } from '../src/math/formalizationReview';
import type { MathAgentOptions, MathAgentSession } from '../src/runtime/codexSession';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { readMathBuildManifest } from '../src/math/mathBuildManifest';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { resolveReviewEnvironment } from '../src/math/formalizationReviewV2';
import * as reviewRunner from '../src/solver/formalizationReview';

const production = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../src/runtime/codexSession', () => ({ createCodexMathSession: production.open }));
// Native build validation has its own tests. Model-branch tests use a disposable stand-in
// and synthetic sessions with synthetic receipts, never an executable, provider or compiler.
vi.mock('../src/math/mathBuildManifest', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/mathBuildManifest')>(),
  readMathBuildManifest: vi.fn((file: string) => JSON.parse(fs.readFileSync(file, 'utf8'))),
}));

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roots: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  production.open.mockReset();
  production.open.mockImplementation(async () => { throw new Error('test_forbids_real_model_session'); });
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value) + '\n');
function preset(input: FormalizationEvaluationReviewerInput, verdict?: FormalizationSemanticReview['verdict']): FormalizationSemanticReview {
  verdict ??= input.candidate.includes(': True') ? 'changes_requested' :
    input.candidate.includes('proposed_unknown') ? 'unknown' : 'approved';
  return { schema: 'theorem-os.formalization-semantic-review.v1', caseId: input.caseId,
    inputDigest: formalizationEvaluationInputDigest(input), verdict,
    summary: 'Handwritten CLI fixture; no mathematical reviewer or model was run.',
    checks: { domains: 'faithful', assumptions: 'faithful', definitions: 'faithful',
      conclusions: verdict === 'approved' ? 'faithful' : verdict === 'changes_requested' ? 'mismatch' : 'uncertain' } };
}
function fixture(count = 3) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'formalization-review-cli-'))); roots.push(base);
  const source = path.join(base, 'PRIVATE_LABEL_SOURCE.jsonl'), bundle = path.join(base, 'bundle');
  const rows = [
    { id: 'PRIVATE_POSITIVE', candidate: 'theorem proposed (n : Nat) : n + 0 = n := by sorry\n', label: 'correct' },
    { id: 'PRIVATE_NEGATIVE', candidate: 'theorem proposed_wrong (n : Nat) : True := by sorry\n', label: 'incorrect' },
    { id: 'PRIVATE_UNCERTAIN', candidate: 'theorem proposed_unknown (n : Nat) : 0 + n = n := by sorry\n', label: 'correct' },
  ].slice(0, count).map(row => ({ ...row, original: 'For every natural number n, prove n + 0 = n.',
    header: 'import Std\n', sourceFamily: 'PRIVATE_FAMILY', split: 'test', kind: 'synthetic',
    labelProvenance: 'Handwritten CLI fixture only.', reference: 'PRIVATE_REFERENCE_CANARY' }));
  fs.writeFileSync(source, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  prepareFormalizationEvaluation({ directory: bundle, inputFile: source, format: 'normalized',
    provenance: { name: 'Disposable CLI preset', kind: 'synthetic-fixture',
      labelProvenance: 'Handwritten protocol tests, not reviewer capability measurements.', sourceToolchain: 'leanprover/lean4:v4.8.0' } });
  const prepared = readFormalizationEvaluationBundle(bundle);
  const inputs = [...prepared.inputs.values()].sort((a, b) => a.caseId.localeCompare(b.caseId));
  const replay = path.join(base, 'replay.json');
  write(replay, { schema: 'theorem-os.formalization-review-replay.v1', bundleDigest: prepared.bundleDigest, outputs: inputs.map(input => preset(input)) });
  const run = path.join(base, 'run'), common = ['--phase', 'review', '--directory', bundle, '--run-directory', run];
  return { base, bundle, prepared, inputs, replay, run, common,
    replayArgs: [...common, '--execution', 'replay', '--replay', replay] };
}
async function invoke(args: string[]) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const code = await evaluateFormalization(args), output = String(log.mock.calls.at(-1)?.[0]);
    return { code, output, report: args.includes('--help') ? undefined : JSON.parse(output) };
  } finally { log.mockRestore(); }
}
function modelFixture(count = 2) {
  const f = fixture(count), profile = path.join(f.base, 'disposable-profile'), build = path.join(f.base, 'stand-in-build.json');
  fs.mkdirSync(profile); fs.writeFileSync(path.join(profile, 'config.toml'), 'model = "offline-fixture"\n');
  write(build, { testOnly: true, buildId: 'synthetic-no-model-no-compiler' });
  return { ...f, profile, build, modelArgs: [...f.common, '--execution', 'model', '--build-manifest', build, '--profile', profile, '--protocol', 'v1'] };
}
type Behavior = (input: FormalizationEvaluationReviewerInput, options: MathAgentOptions, visit: number) => string | Promise<string>;
function syntheticModel(behavior?: Behavior) {
  const seen: { input: FormalizationEvaluationReviewerInput; options: MathAgentOptions; closed: boolean }[] = [];
  production.open.mockImplementation(async (options: MathAgentOptions): Promise<MathAgentSession> => {
    const inputFile = path.join(options.workspace, 'INPUT.json'), input = read(inputFile) as FormalizationEvaluationReviewerInput;
    const entry = { input, options, closed: false }; seen.push(entry);
    const environment = options.readIsolation!.environment, config = getLeanTaskEnvironment(environment);
    return { threadId: 'synthetic-cli-thread-' + randomUUID(),
      isolationReceipt: { schema: 'theorem-os.formalization-sandbox.v2', backend: 'bwrap',
        workspace: '/workspace', profile: '/profile', providerId: 'sub2api', namespaces: ['user', 'mount', 'pid', 'ipc', 'uts', 'net'],
        network: 'role-model-relay-only', credentials: 'host-only', input: 'read-only', canary: 'passed',
        toolchain: config.toolchain, environmentDigest: config.dependencyDigest,
        inputSha256: mathDigest(fs.readFileSync(inputFile)),
        roleInstructionsSha256: mathDigest(fs.readFileSync(path.join(options.workspace, 'ROLE.md'))),
        outputSchemaSha256: mathDigest(fs.readFileSync(path.join(options.workspace, 'OUTPUT.schema.json'))),
        executableSha256: '1'.repeat(64), profileDigest: '2'.repeat(64),
        packages: environment === 'standard' ? { kind: 'none' } :
          { kind: 'sealed', root: '/opt/lean-packages', identity: 'synthetic-package-identity' } },
      interrupt: async () => {}, close: async () => { entry.closed = true; },
      run: async (_message, _messageId, workspace, onStarted) => {
        onStarted('synthetic-cli-turn-' + randomUUID());
        if (behavior) return behavior(input, options, seen.length);
        const value = preset(input); options.completedOutput!.validate(value);
        write(path.join(workspace, 'OUTPUT.json'), value); return 'submitted';
      } };
  });
  return seen;
}

describe('direct semantic review CLI with disposable offline evidence', () => {
  it('freezes a production harness separately from presets and inherits it on resume', async () => {
    const f = modelFixture(1), seen = syntheticModel(), executable = path.join(f.base, 'native');
    fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const first = await invoke([...f.modelArgs, '--harness', 'codex', '--harness-executable', executable]);
    expect(first.report).toMatchObject({ adapter: 'codex', modelInvoked: true });
    expect(read(path.join(f.run, 'request.json')).configuration.agentHarness).toMatchObject({ id: 'codex', executable });
    const second = await invoke(f.modelArgs);
    expect(second.code).toBe(0); expect(seen).toHaveLength(1);
    fs.appendFileSync(executable, '# changed\n');
    await expect(invoke(f.modelArgs)).rejects.toThrow('math_harness_identity_changed');
    expect(seen).toHaveLength(1);
  });

  it('replays strict blind outputs, scores presets honestly and resumes completed unknown receipts without new attempts', async () => {
    const f = fixture(), output = path.join(f.base, 'review-result.json');
    const reviewed = await invoke([...f.replayArgs, '--output', output]);
    expect(reviewed.code).toBe(0);
    expect(reviewed.report).toMatchObject({ status: 'complete', execution: 'replay', modelInvoked: false,
      completedCases: 3, unknownCases: 1, compilationObserved: false, timeoutMs: 0 });
    expect(read(output)).toEqual(reviewed.report);
    expect(fs.statSync(output).mode & 0o222).toBe(0);
    expect(read(path.join(f.run, 'request.json')).configuration).toMatchObject({ execution: 'replay', environment: 'mathlib' });
    const scored = await invoke(['--phase', 'score', '--directory', f.bundle, '--decisions', reviewed.report.decisionsFile]);
    expect(scored.code).toBe(0);
    expect(scored.report).toMatchObject({ modelInvoked: false, modelAccuracyMeasuredByThisCommand: false,
      measurement: { target: 'upstream-label-agreement' }, semanticTruthCertified: false,
      generationAccuracyMeasured: false, originalTheoremProofAcceptanceMeasured: false,
      interpretation: 'preset-verdict-fixture-not-model-accuracy', decisionOrigin: { kind: 'preset' },
      splits: { test: { cases: 3, positives: 2, negatives: 1, approvals: 1, rejections: 1, unknown: 1, compileUnknown: 3,
        trueAcceptances: 1, trueRejections: 1, coverage: { numerator: 2, denominator: 3 },
        upstreamLabelAgreement: { numerator: 2, denominator: 3, rate: 2 / 3 },
        upstreamLabelAgreementAmongDecided: { numerator: 2, denominator: 2, rate: 1 } } } });
    const state = fs.readFileSync(path.join(f.run, 'state.json'), 'utf8');
    const receipts = f.inputs.map(input => fs.readFileSync(path.join(f.run, 'receipts', input.caseId + '.json'), 'utf8'));
    const resumed = await invoke(f.replayArgs);
    expect(resumed.code).toBe(0); expect(resumed.report).toMatchObject({ attempts: 3, completedCases: 3, unknownCases: 1 });
    expect(fs.readFileSync(path.join(f.run, 'state.json'), 'utf8')).toBe(state);
    expect(f.inputs.map(input => fs.readFileSync(path.join(f.run, 'receipts', input.caseId + '.json'), 'utf8'))).toEqual(receipts);
    expect(production.open).not.toHaveBeenCalled(); expect(readMathBuildManifest).not.toHaveBeenCalled();
  });

  it('returns 2 for missing replay output and preserves unknown in the full score denominator', async () => {
    const f = fixture(2), saved = read(f.replay); saved.outputs = saved.outputs.slice(0, 1); write(f.replay, saved);
    const result = await invoke([...f.replayArgs, '--environment', 'standard']);
    expect(result.code).toBe(2);
    expect(result.report).toMatchObject({ status: 'partial', totalCases: 2, completedCases: 1, failedOrPendingCases: 1, unknownCases: 1 });
    const scored = await invoke(['--phase', 'score', '--directory', f.bundle, '--decisions', result.report.decisionsFile]);
    expect(scored.report.splits.test).toMatchObject({ cases: 2, recordedDecisions: 2, missingDecisions: 0, unknown: 1, compileUnknown: 2 });
    expect(read(path.join(f.run, 'request.json')).configuration.environment).toBe('standard');
    expect(production.open).not.toHaveBeenCalled();
  });

  it('resumes only a failed case with a fresh synthetic thread, preserving already completed receipts', async () => {
    const f = modelFixture(), failedId = f.inputs[0].caseId; let failed = false;
    const seen = syntheticModel((input, options) => {
      if (input.caseId === failedId && !failed) { failed = true; throw new Error('synthetic_transport_failure'); }
      write(path.join(options.workspace, 'OUTPUT.json'), preset(input)); return 'submitted';
    });
    const first = await invoke(f.modelArgs);
    expect(first.code).toBe(2); expect(first.report).toMatchObject({ status: 'partial', completedCases: 1 });
    const completedId = f.inputs[1].caseId, receipt = fs.readFileSync(path.join(f.run, 'receipts', completedId + '.json'), 'utf8');
    const second = await invoke(f.modelArgs);
    expect(second.code).toBe(0); expect(second.report).toMatchObject({ status: 'complete', completedCases: 2, attempts: 3 });
    expect(seen.map(entry => entry.input.caseId)).toEqual([...f.inputs.map(input => input.caseId), failedId]);
    expect(new Set(seen.map(entry => entry.options.workspace)).size).toBe(3);
    expect(seen.every(entry => entry.closed)).toBe(true);
    expect(fs.readFileSync(path.join(f.run, 'receipts', completedId + '.json'), 'utf8')).toBe(receipt);
  });

  it('preserves explicit v1 model defaults without reading a real profile or launching an executable', async () => {
    const f = modelFixture(1); vi.stubEnv('CODEX_HOME', f.profile);
    vi.stubEnv('DEEPSCIENTIST_MATH_CODEX_EXECUTABLE', '/never-executed/fixture-codex');
    const seen = syntheticModel();
    const result = await invoke([...f.common, '--execution', 'model', '--build-manifest', f.build, '--protocol', 'v1']);
    expect(result.code).toBe(0);
    expect(seen[0].options).toMatchObject({ model: 'deepseek-flash', effort: 'max', profile: f.profile,
      executable: '/never-executed/fixture-codex', readIsolation: { environment: 'mathlib' } });
    expect(seen[0].options.turnTimeoutMs === undefined || seen[0].options.turnTimeoutMs === 0).toBe(true);
    expect(read(path.join(f.run, 'request.json')).configuration).not.toHaveProperty('contextProtocol');
    expect(readMathBuildManifest).toHaveBeenCalledWith(f.build, repository, path.join(repository, 'out/main'));
  });

  it('forwards explicit model configuration and standard environment to the isolated session contract', async () => {
    const f = modelFixture(1), seen = syntheticModel();
    const result = await invoke([...f.modelArgs, '--environment', 'standard', '--model', 'synthetic-model',
      '--effort', 'medium', '--codex', '/never-executed/synthetic-codex']);
    expect(result.code).toBe(0);
    expect(seen[0].options).toMatchObject({ model: 'synthetic-model', effort: 'medium', profile: f.profile,
      executable: '/never-executed/synthetic-codex', readIsolation: { environment: 'standard' } });
    expect(Object.keys(seen[0].input).sort()).toEqual(['candidate', 'caseId', 'header', 'original', 'schema']);
    expect(JSON.stringify(seen[0].input)).not.toContain('PRIVATE_');
  });

  it.each(['SIGINT', 'SIGTERM'] as const)('checkpoints %s as stopped/unknown, returns 130 and removes CLI listeners', async signal => {
    const f = modelFixture(), before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const seen = syntheticModel(() => { process.emit(signal); return 'interrupted'; });
    const result = await invoke(f.modelArgs);
    expect(result.code).toBe(130);
    expect(result.report).toMatchObject({ status: 'stopped', completedCases: 0, unknownCases: 2, attempts: 1 });
    expect(read(path.join(f.run, 'state.json'))).toMatchObject({ status: 'stopped', attempts: [{ status: 'interrupted' }] });
    expect(read(result.report.decisionsFile).decisions).toEqual(expect.arrayContaining(f.inputs.map(input =>
      expect.objectContaining({ caseId: input.caseId, verdict: 'unknown', compileStatus: 'unknown' }))));
    expect(seen).toHaveLength(1); expect(seen[0].closed).toBe(true);
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
  });

  it.each([
    { args: [], error: '--execution is required' },
    { args: ['--execution', 'auto'], error: '--execution must be replay or model' },
    { args: ['--execution', 'replay'], error: '--replay is required' },
    { args: ['--execution', 'model'], error: '--build-manifest is required' },
  ])('requires an explicit valid execution and its inputs: $error', async ({ args, error }) => {
    const f = fixture(1);
    await expect(invoke([...f.common, ...args])).rejects.toThrow(error);
    expect(fs.existsSync(f.run)).toBe(false); expect(production.open).not.toHaveBeenCalled();
  });

  it.each(['model', 'effort', 'profile', 'codex', 'build-manifest'])('rejects replay mixed with --%s before starting', async flag => {
    const f = fixture(1);
    await expect(invoke([...f.replayArgs, '--' + flag, 'unused'])).rejects.toThrow('not valid for --execution replay');
    expect(fs.existsSync(f.run)).toBe(false); expect(production.open).not.toHaveBeenCalled();
  });

  it('rejects model/replay mixing, missing run-directory, wrong environment and phase-specific flags', async () => {
    const f = modelFixture(1);
    await expect(invoke([...f.modelArgs, '--replay', f.replay])).rejects.toThrow('not valid for --execution model');
    await expect(invoke([...f.common.slice(0, -2), '--execution', 'replay', '--replay', f.replay])).rejects.toThrow('--run-directory is required');
    await expect(invoke([...f.replayArgs, '--environment', 'other'])).rejects.toThrow('--environment');
    for (const phase of ['prepare', 'score']) await expect(invoke(['--phase', phase, '--directory', f.bundle,
      '--execution', 'model', '--build-manifest', f.build])).rejects.toThrow('not valid for --phase ' + phase);
    expect(fs.existsSync(f.run)).toBe(false); expect(production.open).not.toHaveBeenCalled();
  });

  it.each(['bundle', 'case', 'input', 'duplicate'] as const)('rejects a replay with the wrong %s identity without creating a run', async changed => {
    const f = fixture(1), value = read(f.replay);
    if (changed === 'bundle') value.bundleDigest = 'f'.repeat(64);
    else if (changed === 'case') value.outputs[0].caseId = 'case_' + 'f'.repeat(64);
    else if (changed === 'input') value.outputs[0].inputDigest = 'f'.repeat(64);
    else value.outputs.push(value.outputs[0]);
    write(f.replay, value);
    await expect(invoke(f.replayArgs)).rejects.toThrow('formalization_review_');
    expect(fs.existsSync(f.run)).toBe(false); expect(production.open).not.toHaveBeenCalled();
  });

  it('refuses internal output paths and existing output files before starting review', async () => {
    const f = fixture(1), existing = path.join(f.base, 'existing.json'); fs.writeFileSync(existing, 'retain existing bytes');
    for (const output of [path.join(repository, 'review-output.json'), path.join(f.bundle, 'score.json'), path.join(f.run, 'report.json')]) {
      await expect(invoke([...f.replayArgs, '--output', output])).rejects.toThrow('formalization_eval_report_must_be_external');
    }
    await expect(invoke([...f.replayArgs, '--output', existing])).rejects.toThrow('formalization_eval_report_exists');
    expect(fs.readFileSync(existing, 'utf8')).toBe('retain existing bytes');
    expect(fs.existsSync(f.run)).toBe(false); expect(production.open).not.toHaveBeenCalled();
  });

  it('does not replay a completed run when its requested output path is already taken', async () => {
    const f = fixture(1), output = path.join(f.base, 'result.json');
    await invoke([...f.replayArgs, '--output', output]);
    const before = fs.readFileSync(path.join(f.run, 'state.json'), 'utf8');
    await expect(invoke([...f.replayArgs, '--output', output])).rejects.toThrow('formalization_eval_report_exists');
    expect(fs.readFileSync(path.join(f.run, 'state.json'), 'utf8')).toBe(before);
    expect(production.open).not.toHaveBeenCalled();
  });

  it('documents explicit model invocation, direct review and the offline prepare/score boundary', async () => {
    const result = await invoke(['--help']);
    expect(result.code).toBe(0);
    for (const text of ['prepare|review|score', '--execution replay|model', '--replay', '--build-manifest',
      'Direct semantic review', 'no model, Lean compiler, provider or credentials', 'heldOut always excludes validation',
      'kernel-v3', 'missing required observations remain unknown'])
      expect(result.output).toContain(text);
    expect(production.open).not.toHaveBeenCalled(); expect(readMathBuildManifest).not.toHaveBeenCalled();
  });

  it.each([false, true])('defaults a new model run to kernel-v3 with explicit review v2=%s without launching a model', async explicit => {
    const f = modelFixture(1);
    const run = vi.spyOn(reviewRunner, 'runFormalizationReview').mockResolvedValue({ status: 'complete' } as any);
    await invoke([...f.common, '--execution', 'model', '--build-manifest', f.build, '--profile', f.profile,
      ...(explicit ? ['--protocol', 'v2'] : [])]);
    expect(run).toHaveBeenCalledWith(f.bundle, f.run, expect.objectContaining({
      protocol: 'v2', contextProtocol: 'kernel-v3', execution: 'model', environment: 'auto', model: 'deepseek-flash', effort: 'max',
    }), expect.any(Object));
    expect(production.open).not.toHaveBeenCalled();
    expect(readMathBuildManifest).not.toHaveBeenCalled();
  });

  it.each([undefined, 'kernel-v1', 'kernel-v2'] as const)('preserves saved v2 model context protocol %s with default and explicit protocol flags', async contextProtocol => {
    const f = modelFixture(1), file = path.join(f.run, 'request.json');
    fs.mkdirSync(f.run);
    write(file, { schema: 'theorem-os.formalization-review-run.v2',
      configuration: { protocol: 'v2', ...(contextProtocol === undefined ? {} : { contextProtocol }) } });
    const requestText = fs.readFileSync(file, 'utf8');
    const run = vi.spyOn(reviewRunner, 'runFormalizationReview').mockResolvedValue({ status: 'complete' } as any);
    const args = [...f.common, '--execution', 'model', '--build-manifest', f.build, '--profile', f.profile];
    for (const protocolArgs of [[], ['--protocol', 'v2']]) {
      await invoke([...args, ...protocolArgs]);
      const config = run.mock.calls.at(-1)![2];
      expect(config).toMatchObject({ protocol: 'v2', execution: 'model' });
      if (contextProtocol === undefined) expect(config).not.toHaveProperty('contextProtocol');
      else expect(config).toHaveProperty('contextProtocol', contextProtocol);
      expect(fs.readFileSync(file, 'utf8')).toBe(requestText);
    }
    expect(run).toHaveBeenCalledTimes(2);
    expect(production.open).not.toHaveBeenCalled(); expect(readMathBuildManifest).not.toHaveBeenCalled();
  });

  it('replays v2 observations with unknowns honestly and resumes the frozen v2 protocol without a flag', async () => {
    const f = fixture(1), environment = resolveReviewEnvironment({ sourceToolchain: 'leanprover/lean4:v4.8.0' }, 'auto');
    const replay = path.join(f.base, 'v2-replay.json');
    write(replay, { schema: 'theorem-os.formalization-review-replay.v2', bundleDigest: f.prepared.bundleDigest,
      observations: f.inputs.map(input => ({ schema: 'theorem-os.formalization-review-observation.v2',
        caseId: input.caseId, inputDigest: formalizationEvaluationInputDigest(input),
        sourceSha256: mathDigest(formalizationEvaluationLeanSource(input)), environment,
        status: 'unavailable', snapshot: null, snapshotDigest: null, diagnostics: 'Synthetic unavailable fixture; no compiler was invoked.' })), roles: [] });
    const args = [...f.common, '--execution', 'replay', '--replay', replay];
    const first = await invoke([...args, '--protocol', 'v2']);
    expect(first).toMatchObject({ code: 0, report: { schema: 'theorem-os.formalization-review-run-result.v2',
      modelInvoked: false, completedCases: 1, unknownCases: 1, attempts: 0, compilationObserved: false,
      environment: { environment: 'mathlib-4.8', compatibility: 'matched' },
      statementObservations: { authority: 'preset', unavailable: 1 } } });
    const receipt = fs.readFileSync(path.join(f.run, 'receipts', f.inputs[0].caseId + '.json'), 'utf8');
    const resumed = await invoke(args);
    expect(resumed).toMatchObject({ code: 0, report: { attempts: 0, completedCases: 1, unknownCases: 1 } });
    expect(fs.readFileSync(path.join(f.run, 'receipts', f.inputs[0].caseId + '.json'), 'utf8')).toBe(receipt);
    const scored = await invoke(['--phase', 'score', '--directory', f.bundle, '--decisions', resumed.report.decisionsFile]);
    expect(scored.report).toMatchObject({ modelInvoked: false, interpretation: 'preset-verdict-fixture-not-model-accuracy',
      splits: { test: { cases: 1, unknown: 1, compileUnknown: 1 } } });
    expect(production.open).not.toHaveBeenCalled(); expect(readMathBuildManifest).not.toHaveBeenCalled();
  });

  it('retains a frozen v1 model request when resuming without --protocol', async () => {
    const f = modelFixture(1), seen = syntheticModel();
    await invoke(f.modelArgs);
    const request = fs.readFileSync(path.join(f.run, 'request.json'), 'utf8');
    const result = await invoke(f.modelArgs.slice(0, -2));
    expect(result).toMatchObject({ code: 0, report: { schema: 'theorem-os.formalization-review-run-result.v1', completedCases: 1 } });
    expect(fs.readFileSync(path.join(f.run, 'request.json'), 'utf8')).toBe(request);
    expect(seen).toHaveLength(1);
  });

  it('rejects unsupported protocol/environment combinations before starting', async () => {
    const f = fixture(1);
    await expect(invoke([...f.replayArgs, '--protocol', 'v3'])).rejects.toThrow('--protocol');
    await expect(invoke([...f.replayArgs, '--protocol', 'v1', '--environment', 'mathlib-4.8'])).rejects.toThrow('--environment');
    await expect(invoke([...f.replayArgs, '--protocol', 'v2'])).rejects.toThrow();
    expect(fs.existsSync(f.run)).toBe(false); expect(production.open).not.toHaveBeenCalled();
  });
});
