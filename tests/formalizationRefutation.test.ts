import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formalizationFalsificationSchema, formalizationRefutationInput, formalizationRefutationOutputSchema,
  refutationProofRejection, refutationQuery, refutationSentinelHealthy, refutationVerdict } from '../src/math/formalizationRefutation';
import { getFormalizationRoleOutputValidator } from '../src/math/formalizationRoleContract';
import { checkFormalizationRefutations } from '../src/solver/formalizationRefutation';
import { fixtureStatement, syntheticElaboration } from './helpers/formalizationFixture';

const { diagnostics, packages, prepare, dispose, readiness } = vi.hoisted(() => ({
  diagnostics: vi.fn(), packages: vi.fn(), prepare: vi.fn(), dispose: vi.fn(), readiness: vi.fn(),
}));
vi.mock('../src/math/leanDiagnostics', async original => ({
  ...await original<typeof import('../src/math/leanDiagnostics')>(), runLeanDiagnostics: diagnostics,
}));
vi.mock('../src/math/verifier', async original => ({
  ...await original<typeof import('../src/math/verifier')>(), resolveMathematicsLakePackagesCache: packages,
}));
vi.mock('../src/math/mathProofEnvironment', async original => ({
  ...await original<typeof import('../src/math/mathProofEnvironment')>(), prepareMathProofEnvironment: prepare,
}));
vi.mock('../src/math/leanToolchainReadiness', () => ({ checkResolvedLeanToolchainReadiness: readiness }));

const nonce = '0123456789abcdef0123456789abcdef';
const probe = (proof: string, opens: string[] = [], target = 'addition') => ({ target, opens, proof, explanation: 'Counterexample n = 0.' });
const admitted = (proof: string, opens: string[] = []) => refutationProofRejection({ proof, opens });

describe('refutation proof admission', () => {
  it.each(['by intro h; exact absurd (h 0) (by decide)', 'fun h => absurd (h 2 (by norm_num)) (by simp)',
    'by intro h; have := h (Matrix.trace (1 : Matrix (Fin 2) (Fin 2) ℚ)); simp at this',
    'by intro h; have := h 3; omega -- n % 2 = 1', 'by intro h; exact (h ⟨Real.pi, by positivity⟩).elim',
    'by intro h; exact Nat.lt_irrefl _ (h (fun x => x))'])('admits an ordinary checked term: %s', proof => {
    expect(admitted(proof)).toBeUndefined();
  });

  it.each([
    ['by sorry', 'sorry'], ['by intro h; exact sorryAx _ false', 'sorryAx'], ['by admit', 'admit'],
    ['by native_decide', 'native_decide'], ['by intro h; exact Lean.ofReduceBool _ _ rfl', 'Lean'],
    ['by run_tac pure ()', 'run_tac'], ['by_elab pure (Lean.mkConst `True)', 'by_elab'],
    ['by set_option maxHeartbeats 0 in decide', 'set_option'], ['by intro h; trace "x"; simp', 'trace'],
    ['by intro h; exact (unsafeIO (pure ())).elim', 'unsafeIO'], ['by polyrith', 'polyrith'],
    ['by intro h; exact Foo.native_decide', 'native_decide'],
  ])('denies %s', (proof, token) => {
    expect(admitted(proof)).toBe('forbidden token ' + token);
  });

  it('denies characters and elaborators that reach outside a term', () => {
    expect(admitted('by intro h; have := h #[1]; simp')).toContain('the # character');
    expect(admitted('by intro h; exact eval% 1')).toContain('%-suffixed');
    expect(admitted('by intro h; have := h (decl_name%); simp')).toContain('%-suffixed');
    expect(admitted('by intro h; have := h 3; omega -- n%2')).toContain('%-suffixed');
    expect(admitted('by intro h\u0000; simp')).toBe('control character');
    expect(admitted('x'.repeat(16_001))).toBe('proof exceeds 16000 bytes');
  });

  it('validates opens and applies the deny-list to them', () => {
    expect(admitted('by simp', ['Real', 'Finset'])).toBeUndefined();
    expect(admitted('by simp', ['Real Lean'])).toBe('invalid namespace in opens');
    expect(admitted('by simp', ['Lean.Elab'])).toBe('forbidden token Lean');
    expect(admitted('by simp', ['IO'])).toBe('forbidden token IO');
  });
});

describe('refutation query and verdicts', () => {
  it('parses each proof as data, one command per probe after a sentinel', () => {
    const proof = 'by intro h; exact absurd (h 0) (by simp)\n-- "quoted" \\ text';
    const { query, sentinelFile, resultFiles } = refutationQuery('Formalization', [probe(proof, ['Real']), probe('by simp')], nonce);
    expect(sentinelFile).toBe(`.lake/refutation-${nonce}-sentinel.json`);
    expect(resultFiles).toEqual([0, 1].map(index => `.lake/refutation-${nonce}-${index}.json`));
    expect(query.startsWith('import Lean\nimport Formalization\nset_option autoImplicit false\n')).toBe(true);
    expect(query).toContain(`theorem TheoremOSRefutation.sentinel_${nonce} : (1 : Nat) = 0 := by sorry`);
    expect(query).toContain(JSON.stringify(proof));
    expect(query).not.toContain(proof);
    expect(query).toContain('open Real in\nrun_cmd do');
    expect(query.split('\nrun_cmd do\n')).toHaveLength(4);
    expect(query.indexOf('-sentinel.json')).toBeLessThan(query.indexOf('-0.json'));
    expect(query).toContain('Lean.Level.zero');
    expect(query).toContain('Lean.collectAxioms label');
  });

  it('rejects a malformed nonce or module', () => {
    expect(() => refutationQuery('Formalization', [], 'A'.repeat(32))).toThrow('formalization_refutation_nonce_invalid');
    expect(() => refutationQuery('Formalization\nimport X', [], nonce)).toThrow('formalization_refutation_module_invalid');
  });

  it('accepts only a nonce-bound result whose axioms stay in the allowlist', () => {
    const result = (axioms: unknown, index = '0', bound = nonce) => JSON.stringify({ nonce: bound, index, axioms });
    expect(refutationVerdict(undefined, nonce, '0')).toMatchObject({ status: 'not-refuted', reason: expect.stringContaining('no result') });
    expect(refutationVerdict('{', nonce, '0')).toMatchObject({ status: 'not-refuted', reason: 'result file invalid' });
    expect(refutationVerdict(result([], '0', 'f'.repeat(32)), nonce, '0').status).toBe('not-refuted');
    expect(refutationVerdict(result([], '1'), nonce, '0').status).toBe('not-refuted');
    expect(refutationVerdict(result('propext'), nonce, '0').status).toBe('not-refuted');
    expect(refutationVerdict(result(['propext', 'sorryAx']), nonce, '0')).toMatchObject({ status: 'not-refuted',
      reason: 'axioms outside the allowlist: sorryAx' });
    expect(refutationVerdict(result(['Lean.ofReduceBool']), nonce, '0').status).toBe('not-refuted');
    expect(refutationVerdict(result(['propext', 'Classical.choice', 'Quot.sound']), nonce, '0')).toEqual({ status: 'refuted',
      axioms: ['propext', 'Classical.choice', 'Quot.sound'] });
  });

  it('requires the sentinel to be refuted with no axioms', () => {
    const sentinel = (axioms: string[]) => JSON.stringify({ nonce, index: 'sentinel', axioms });
    expect(refutationSentinelHealthy(sentinel([]), nonce)).toBe(true);
    expect(refutationSentinelHealthy(sentinel(['propext']), nonce)).toBe(false);
    expect(refutationSentinelHealthy(sentinel(['sorryAx']), nonce)).toBe(false);
    expect(refutationSentinelHealthy(undefined, nonce)).toBe(false);
  });

  it('gives the refuter the elaborated statement only', () => {
    const elaborated = syntheticElaboration('theorem addition (n : Nat) : n + 0 = n := by simp\n');
    const input = formalizationRefutationInput(elaborated.snapshot, elaborated.snapshotDigest, 'leanprover/lean4:v4.33.0');
    expect(input).toMatchObject({ schema: 'theorem-os.formalization-refutation-input.v1', protocol: 'lean-refutation-v1',
      snapshotDigest: elaborated.snapshotDigest, targets: [{ name: 'addition', type: 'forall (n : Nat), n + 0 = n' }] });
    expect(input.source).toContain(':= by sorry');
    expect(JSON.stringify(input)).not.toContain(fixtureStatement);
  });

  it('bounds the request and output contracts', () => {
    const config = { schema: 'theorem-os.formalization-falsification.v1', protocol: 'lean-refutation-v1', maxSeconds: 600, maxTurnSeconds: 1200 };
    expect(formalizationFalsificationSchema.parse(config)).toEqual(config);
    expect(formalizationFalsificationSchema.safeParse({ ...config, maxSeconds: 0 }).success).toBe(false);
    expect(formalizationFalsificationSchema.safeParse({ ...config, maxTurnSeconds: undefined }).success).toBe(false);
    const output = { snapshotDigest: 'a'.repeat(64), refutations: [probe('by simp')], summary: 'Refuted addition at n = 0.' };
    expect(getFormalizationRoleOutputValidator('refute').parse(output)).toEqual(output);
    expect(formalizationRefutationOutputSchema.safeParse({ ...output, extra: true }).success).toBe(false);
    expect(formalizationRefutationOutputSchema.safeParse({ ...output, refutations: [probe('by simp', [], 'not a name')] }).success).toBe(false);
    expect(formalizationRefutationOutputSchema.safeParse({ ...output,
      refutations: Array.from({ length: 17 }, () => probe('by simp')) }).success).toBe(false);
  });
});

describe('refutation harness', () => {
  let directory: string, timedOut: boolean, report: (index: string) => string[] | undefined;
  beforeEach(() => {
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'formalization-refutation-')));
    packages.mockReset().mockReturnValue(undefined);
    dispose.mockReset().mockResolvedValue(undefined);
    prepare.mockReset().mockResolvedValue({ environmentValue: 'sealed-fixture', dispose, stats: {} });
    readiness.mockReset().mockReturnValue({ status: 'ready', diagnostics: '', fingerprint: 'ready-fixture' });
    timedOut = false; report = index => index === 'sentinel' ? [] : undefined;
    // Synthetic Lean: write the result files that the elaborated probes would write.
    diagnostics.mockReset().mockImplementation(async input => {
      const project = input.projectRoot, query = fs.readFileSync(path.join(project, input.files[0]), 'utf8');
      const bound = /sentinel_([a-f0-9]{32})/u.exec(query)![1]!;
      fs.mkdirSync(path.join(project, '.lake'), { recursive: true });
      for (const [, index] of new Set(query.matchAll(/refutation-[a-f0-9]{32}-([a-z0-9]+)\.json/gu))) {
        const axioms = report(index!);
        if (axioms) fs.writeFileSync(path.join(project, `.lake/refutation-${bound}-${index}.json`),
          JSON.stringify({ nonce: bound, index, axioms }));
      }
      return { exitCode: 1, timedOut, aborted: false, stdout: '', stderr: '', diagnosticArtifacts: [] };
    });
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
  const attempt = () => path.join(directory, 'attempt');
  const check = () => checkFormalizationRefutations(attempt(), 'theorem addition (n : Nat) : n + 0 = n := by simp\n', 'standard',
    [probe('by intro h; exact absurd (h 0) (by decide)'), probe('by intro h; exact absurd (h 1) (by decide)'), probe('by simp')],
    { env: {}, timeoutMs: 30_000 });

  it('checks every probe against the erased candidate and keeps only allowlisted refutations', async () => {
    report = index => ({ sentinel: [], 0: ['propext'], 1: ['propext', 'sorryAx'] } as Record<string, string[]>)[index];
    const result = await check();
    expect(result).toMatchObject({ schema: 'theorem-os.formalization-refutation-check.v1', status: 'checked', timedOut: false });
    expect(result.probes.map(item => item.status)).toEqual(['refuted', 'not-refuted', 'not-refuted']);
    expect(result.probes[1]!.reason).toBe('axioms outside the allowlist: sorryAx');
    expect(result.probes[2]!.reason).toContain('did not elaborate');
    const candidate = fs.readFileSync(path.join(attempt(), 'project/Formalization.lean'), 'utf8');
    expect(candidate).toContain(':= by sorry'); expect(candidate).not.toContain('by simp');
    expect(diagnostics.mock.calls[0]![0]).toMatchObject({ files: ['FormalizationRefutation.lean'] });
    expect(JSON.parse(fs.readFileSync(path.join(attempt(), 'refutation.json'), 'utf8'))).toEqual(result);
  });

  it('reports a timeout before the sentinel as unavailable, never as a refutation', async () => {
    timedOut = true; report = () => undefined;
    const result = await check();
    expect(result.status).toBe('unavailable');
    expect(result.probes.every(item => item.status === 'not-refuted' && item.reason === 'timed out')).toBe(true);
  });

  it('fails loudly when the harness itself did not run or was forged', async () => {
    report = () => undefined;
    await expect(check()).rejects.toThrow('formalization_refutation_harness_failed: sentinel probe missing');
    fs.rmSync(attempt(), { recursive: true, force: true });
    report = index => index === 'sentinel' ? ['sorryAx'] : ['propext'];
    await expect(check()).rejects.toThrow('formalization_refutation_harness_failed: sentinel probe invalid');
  });

  it('needs a fresh directory and a ready toolchain', async () => {
    fs.mkdirSync(attempt());
    await expect(check()).rejects.toThrow('fresh directory');
    fs.rmSync(attempt(), { recursive: true, force: true });
    readiness.mockReturnValue({ status: 'unavailable', diagnostics: 'no lean', fingerprint: '' });
    await expect(check()).rejects.toThrow('formalization_refutation_harness_failed: Lean toolchain unavailable');
    expect(diagnostics).not.toHaveBeenCalled();
  });
});
