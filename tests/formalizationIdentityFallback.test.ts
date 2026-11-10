import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertFormalizationReferenceResult, formalizationReferenceFiles,
  type FormalizationReferenceInput } from '../src/math/formalizationReference';
import { compareFormalizationReference } from '../src/solver/formalizationReference';

// These doubles only produce unavailable receipts; completed Lean evidence is
// exercised by the separate opt-in native suite.
const calls = vi.hoisted(() => ({ diagnostics: vi.fn(), readiness: vi.fn(), packages: vi.fn(),
  prepare: vi.fn(), dispose: vi.fn(), bind: vi.fn(), overrides: vi.fn() }));
vi.mock('../src/math/leanDiagnostics', () => ({ runLeanDiagnostics: calls.diagnostics,
  bindLeanPackages: calls.bind, prepareLeanDiagnosticOverrides: calls.overrides }));
vi.mock('../src/math/leanToolchainReadiness', () => ({ checkResolvedLeanToolchainReadiness: calls.readiness }));
vi.mock('../src/math/verifier', () => ({ resolveMathematicsLakePackagesCache: calls.packages }));
vi.mock('../src/math/mathProofEnvironment', () => ({ MATH_PROOF_ENVIRONMENT_ENV: 'DEEPSCIENTIST_MATH_PROOF_ENVIRONMENT',
  prepareMathProofEnvironment: calls.prepare }));
vi.mock('../src/math/mathRuntimeEnvironment', () => ({ resolveMathematicsRuntimeEnvironment: (env: NodeJS.ProcessEnv) => env }));

const source = 'theorem target (p q : Prop) (h : p) : q := by proof_must_not_execute\n';
const input: FormalizationReferenceInput = { candidateSource: source, referenceSource: source,
  environment: 'standard', purpose: 'task-fidelity-v2', pairs: [{ candidateTarget: 'target', referenceTarget: 'target' }] };
const failure = { exitCode: 1, timedOut: false, aborted: false };

describe('strict identity fallback shares the total execution budget', () => {
  let root: string;
  beforeEach(() => {
    vi.clearAllMocks();
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'identity-fallback-')));
    calls.readiness.mockReturnValue({ status: 'ready' });
    calls.packages.mockReturnValue(undefined);
    calls.diagnostics.mockResolvedValue(failure);
    calls.prepare.mockResolvedValue({ environmentValue: 'test-only-environment', dispose: calls.dispose });
    calls.dispose.mockResolvedValue(undefined);
  });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

  it('uses only the remaining budget for a complete fallback after a failed fast attempt', async () => {
    let now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    calls.diagnostics.mockImplementationOnce(async () => { now += 80; return failure; });
    const directory = path.join(root, 'comparison');
    const result = await compareFormalizationReference(directory, input, { env: {}, timeoutMs: 100 });
    expect(calls.diagnostics.mock.calls.map(([request]) => request.timeoutMs)).toEqual([100, 20]);
    expect(calls.diagnostics.mock.calls.map(([request]) => path.basename(path.dirname(request.projectRoot))))
      .toEqual(['identity', 'correspondence']);
    expect(result).toMatchObject({ schema: 'theoremos.formalization-reference.v6',
      method: 'cardinality-correspondence-v7', check: 'unavailable', status: 'not-established' });
    expect(result.files).toEqual(Object.entries(formalizationReferenceFiles(input))
      .map(([file, text]) => expect.objectContaining({ file, text })));
    expect(JSON.parse(fs.readFileSync(path.join(directory, 'identity/comparison.json'), 'utf8')))
      .toMatchObject({ schema: 'theoremos.formalization-reference.v7', check: 'unavailable' });
    expect(JSON.parse(fs.readFileSync(path.join(directory, 'comparison.json'), 'utf8'))).toEqual(result);
    expect(() => assertFormalizationReferenceResult(input, result)).not.toThrow();
  });

  it('does not reset an exhausted fast deadline to launch the full query', async () => {
    let now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    calls.diagnostics.mockImplementationOnce(async () => { now += 100; return { ...failure, timedOut: true }; });
    const result = await compareFormalizationReference(path.join(root, 'comparison'), input, { env: {}, timeoutMs: 100 });
    expect(calls.diagnostics).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ schema: 'theoremos.formalization-reference.v7', check: 'unavailable',
      status: 'not-established', reason: 'formalization_reference_timeout' });
    expect(fs.existsSync(path.join(root, 'comparison/correspondence'))).toBe(false);
    expect(() => assertFormalizationReferenceResult(input, result)).not.toThrow();
  });

  it.each(['caller', 'diagnostics'] as const)('does not retry cancellation reported by %s', async origin => {
    const controller = new AbortController();
    calls.diagnostics.mockImplementationOnce(async () => {
      if (origin === 'caller') controller.abort();
      return { ...failure, aborted: true };
    });
    const result = await compareFormalizationReference(path.join(root, 'comparison'), input,
      { env: {}, signal: controller.signal, timeoutMs: 0 });
    expect(calls.diagnostics).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ check: 'unavailable', status: 'not-established', reason: 'formalization_reference_aborted' });
    expect(fs.existsSync(path.join(root, 'comparison/correspondence'))).toBe(false);
  });

  it('reuses one checked dependency lease across the two independently captured projects', async () => {
    calls.packages.mockReturnValue('/test-only-authorized-packages');
    const result = await compareFormalizationReference(path.join(root, 'comparison'), { ...input, environment: 'mathlib' },
      { env: {}, timeoutMs: 10000, proofEnvironmentCacheRoot: '/test-only-private-cache' });
    expect(result).toMatchObject({ schema: 'theoremos.formalization-reference.v6', check: 'unavailable' });
    expect(calls.prepare).toHaveBeenCalledOnce();
    expect(calls.prepare.mock.calls[0][2]).toMatchObject({ cacheRoot: '/test-only-private-cache' });
    expect(calls.bind).toHaveBeenCalledTimes(2);
    expect(calls.overrides).toHaveBeenCalledTimes(2);
    expect(calls.diagnostics.mock.calls.every(([request]) =>
      request.env.DEEPSCIENTIST_MATH_PROOF_ENVIRONMENT === 'test-only-environment')).toBe(true);
    expect(calls.dispose).toHaveBeenCalledOnce();
  });
});
