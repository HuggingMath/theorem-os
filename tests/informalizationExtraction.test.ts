import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readInformalizationRequest } from '../src/math/informalization';
import { MATH_PROOF_ENVIRONMENT_ENV } from '../src/math/mathProofEnvironment';
import { extractInformalizationOutline } from '../src/solver/informalizationExtraction';
import { informalizationFixture, informalizationGoalsReport, informalizationReport } from './helpers/informalizationFixture';

// Synthetic Lean: the mocked compiler writes the nonce-bound report the query would write.
const { diagnostics, packages, prepare, dispose, readiness, bind, overrides } = vi.hoisted(() => ({
  diagnostics: vi.fn(), packages: vi.fn(), prepare: vi.fn(), dispose: vi.fn(), readiness: vi.fn(), bind: vi.fn(), overrides: vi.fn(),
}));
vi.mock('../src/math/leanToolchainReadiness', () => ({ checkResolvedLeanToolchainReadiness: readiness }));
vi.mock('../src/math/leanDiagnostics', async original => ({
  ...await original<typeof import('../src/math/leanDiagnostics')>(), runLeanDiagnostics: diagnostics,
  bindLeanPackages: bind, prepareLeanDiagnosticOverrides: overrides,
}));
vi.mock('../src/math/verifier', async original => ({
  ...await original<typeof import('../src/math/verifier')>(), resolveMathematicsLakePackagesCache: packages,
}));
vi.mock('../src/math/mathProofEnvironment', async original => ({
  ...await original<typeof import('../src/math/mathProofEnvironment')>(), prepareMathProofEnvironment: prepare,
}));

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const passed = { exitCode: 0, timedOut: false, phases: [], stdout: '', stderr: '' };
type Report = ReturnType<typeof informalizationReport>;
let outcome: (files: readonly string[]) => Record<string, unknown>, report: (nonce: string) => Report | undefined;
let goalsReport: (nonce: string, module: string) => unknown;
let queryBeforeProof: boolean;
const GOALS = /^TheoremOSInformalizationGoals\d+\.lean$/u;

beforeEach(() => {
  outcome = () => passed; report = nonce => informalizationReport(nonce); queryBeforeProof = false;
  goalsReport = (nonce, module) => informalizationGoalsReport(module, nonce);
  packages.mockReset().mockReturnValue(undefined);
  dispose.mockReset().mockResolvedValue(undefined);
  prepare.mockReset().mockResolvedValue({ environmentValue: 'sealed-fixture', dispose, stats: {} });
  readiness.mockReset().mockReturnValue({ status: 'ready', diagnostics: '', fingerprint: 'ready-fixture' });
  bind.mockReset(); overrides.mockReset();
  diagnostics.mockReset().mockImplementation(async (input: { projectRoot: string; files: string[] }) => {
    const query = path.join(input.projectRoot, 'TheoremOSInformalizationQuery.lean');
    fs.mkdirSync(path.join(input.projectRoot, '.lake'), { recursive: true });
    if (GOALS.test(input.files[0]!)) {
      const [, nonce, module, , output] = /#eval tosRun "([a-f0-9]{32})" "([^"]+)" "([^"]+)" "([^"]+)"/u
        .exec(fs.readFileSync(path.join(input.projectRoot, input.files[0]!), 'utf8'))!;
      const value = goalsReport(nonce!, module!);
      if (value) fs.writeFileSync(path.join(input.projectRoot, output!), JSON.stringify(value));
      return outcome(input.files);
    }
    if (input.files[0] !== 'TheoremOSInformalizationQuery.lean') { queryBeforeProof ||= fs.existsSync(query); return outcome(input.files); }
    const nonce = /TheoremOSInformalization_([a-f0-9]{32})/u.exec(fs.readFileSync(query, 'utf8'))![1]!, value = report(nonce);
    if (value) fs.writeFileSync(path.join(input.projectRoot, '.lake', `informalization-${nonce}.json`), JSON.stringify(value));
    return outcome(input.files);
  });
});

function extraction(changes: Parameters<typeof informalizationFixture>[1] = {}) {
  const f = informalizationFixture(roots, changes); f.prepare();
  const { request, sources } = readInformalizationRequest(f.directory), out = path.join(f.directory, 'extraction');
  return { ...f, out, request, sources, extract: (options: Partial<Parameters<typeof extractInformalizationOutline>[3]> = {}) =>
    extractInformalizationOutline(out, request, sources, { timeoutMs: 0, ...options }) };
}
const QUERY = 'TheoremOSInformalizationQuery.lean', GOALS0 = 'TheoremOSInformalizationGoals0.lean', GOALS1 = 'TheoremOSInformalizationGoals1.lean';

describe('informalization extraction harness', () => {
  it('compiles the proof before the query exists, then reads the nonce-bound report', async () => {
    const x = extraction(), outline = await x.extract();
    expect(outline.units.map(unit => unit.name)).toEqual(['lib_fact', 'double', 'double_eq', 'double_add_zero']);
    expect(diagnostics.mock.calls.map(call => call[0].files)).toEqual([['Proof.lean'], [QUERY], [GOALS0], [GOALS1]]);
    expect(queryBeforeProof).toBe(false);
    const project = path.join(x.out, 'project');
    expect(fs.readFileSync(path.join(project, 'Lib.lean'), 'utf8')).toBe(x.sources[0]!.text);
    expect(fs.readFileSync(path.join(project, 'lakefile.toml'), 'utf8')).toContain('name = "Submission"');
    expect(JSON.parse(fs.readFileSync(path.join(x.out, 'outline.json'), 'utf8'))).toEqual(outline);
    for (const stage of ['proof', 'query', 'goals-0', 'goals-1']) expect(fs.existsSync(path.join(x.out, stage + '-diagnostics.json'))).toBe(true);
    expect(outline.goalStates).toEqual({ protocol: 'lean-tactic-goals-v1', status: 'complete' });
    expect(outline.units.map(unit => unit.goals?.tactics.map(tactic => tactic.tactic))).toEqual([[], [], ['unfold double', 'omega'],
      ['rw [lib_fact]', 'exact double_eq n']]);
    expect(prepare).not.toHaveBeenCalled(); expect(bind).not.toHaveBeenCalled();
  });

  it('binds the pinned packages and seals the proof environment for every pass', async () => {
    packages.mockReturnValue('/pinned/packages');
    const x = extraction({ environment: 'mathlib' });
    await x.extract();
    expect(bind).toHaveBeenCalledWith(path.join(x.out, 'project'), '/pinned/packages');
    expect(overrides).toHaveBeenCalledTimes(1);
    expect(diagnostics.mock.calls.map(call => call[0].env[MATH_PROOF_ENVIRONMENT_ENV])).toEqual(Array(4).fill('sealed-fixture'));
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('refuses a Mathlib proof without the pinned package cache', async () => {
    await expect(extraction({ environment: 'mathlib' }).extract()).rejects.toThrow('informalization_lake_packages_unavailable');
    expect(diagnostics).not.toHaveBeenCalled();
  });

  it('names the proof module that does not compile and never writes the query', async () => {
    outcome = () => ({ ...passed, exitCode: 1, phases: [{ file: 'Lib.lean', exitCode: 1 }],
      firstBlocking: { severity: 'error', file: 'Lib.lean', line: 1, column: 0, message: 'type mismatch' } });
    const x = extraction();
    await expect(x.extract()).rejects.toThrow('informalization_proof_does_not_compile: Lib.lean: Lib.lean:1:1: error: type mismatch');
    expect(diagnostics).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(x.out, 'project', QUERY))).toBe(false);
    expect(fs.existsSync(path.join(x.out, 'proof-diagnostics.json'))).toBe(true);
  });

  it('reports a failed query as an extraction failure, not a proof failure', async () => {
    outcome = files => files[0] === QUERY ? { ...passed, exitCode: 1, stderr: 'unknown constant' } : passed;
    await expect(extraction().extract()).rejects.toThrow('informalization_extraction_failed: unknown constant');
  });

  it('maps a Lean timeout and an expired deadline to the extraction timeout', async () => {
    outcome = () => ({ ...passed, exitCode: null, timedOut: true });
    await expect(extraction().extract()).rejects.toThrow('informalization_extraction_timeout');
    outcome = () => passed;
    diagnostics.mockImplementationOnce(async () => { await wait(80); return passed; });
    await expect(extraction().extract({ timeoutMs: 40 })).rejects.toThrow('informalization_extraction_timeout');
  });

  it.each([
    ['no result', () => undefined, 'informalization_extraction_failed: the query wrote no result'],
    ['a report for another nonce', () => informalizationReport('f'.repeat(32)),
      'informalization_extraction_failed: informalization_extraction_report_invalid'],
    ['a target that depends on sorryAx', (nonce: string) => ({ ...informalizationReport(nonce), axioms: ['sorryAx'] }),
      'informalization_proof_incomplete: the target depends on sorryAx'],
  ])('refuses %s', async (_name, value, error) => {
    report = value;
    await expect(extraction().extract()).rejects.toThrow(error);
  });

  it('refuses an unavailable toolchain, an existing directory and a reserved module name', async () => {
    readiness.mockReturnValueOnce({ status: 'unavailable', diagnostics: 'no lean', fingerprint: '' });
    await expect(extraction().extract()).rejects.toThrow('informalization_lean_toolchain_unavailable: no lean');
    expect(diagnostics).not.toHaveBeenCalled();
    const x = extraction(); fs.mkdirSync(x.out);
    await expect(x.extract()).rejects.toThrow('informalization_extraction_directory_exists');
    const y = extraction();
    await expect(extractInformalizationOutline(y.out, y.request, [{ module: 'TheoremOSInformalizationQuery', file: QUERY, text: '' },
      ...y.sources], { timeoutMs: 0 })).rejects.toThrow('informalization_source_name_reserved');
    const z = extraction();
    await expect(extractInformalizationOutline(z.out, z.request, [{ module: 'TheoremOSInformalizationGoals7', file: 'TheoremOSInformalizationGoals7.lean',
      text: '' }, ...z.sources], { timeoutMs: 0 })).rejects.toThrow('informalization_source_name_reserved');
  });
});

describe('informalization goals pass', () => {
  it.each([
    ['a timeout', () => { outcome = files => GOALS.test(files[0]!) ? { ...passed, exitCode: null, timedOut: true } : passed; },
      'informalization_goals_timeout'],
    ['a failed elaboration', () => { outcome = files => GOALS.test(files[0]!) ? { ...passed, exitCode: 137, stderr: 'out of memory' } : passed; },
      'informalization_goals_failed: out of memory'],
    ['no result', () => { goalsReport = () => undefined; }, 'informalization_goals_failed: the query wrote no result'],
    ['a report for another nonce', () => { goalsReport = (_nonce, module) => informalizationGoalsReport(module, 'f'.repeat(32)); },
      'informalization_goals_report_invalid'],
    ['an error report', () => { goalsReport = (nonce, module) => ({ nonce, module, error: 'the proof did not elaborate again: boom' }); },
      'the proof did not elaborate again: boom'],
  ])('keeps the outline without goals after %s', async (_name, arrange, reason) => {
    arrange();
    const x = extraction(), outline = await x.extract();
    expect(outline.units.map(unit => unit.name)).toEqual(['lib_fact', 'double', 'double_eq', 'double_add_zero']);
    expect(outline.units.some(unit => 'goals' in unit)).toBe(false);
    expect(outline.goalStates).toEqual({ protocol: 'lean-tactic-goals-v1', status: 'unavailable', reason: `Lib: ${reason}\nProof: ${reason}` });
    expect(JSON.parse(fs.readFileSync(path.join(x.out, 'outline.json'), 'utf8'))).toEqual(outline);
  });

  it('keeps the goals of the files whose query succeeded', async () => {
    outcome = files => files[0] === GOALS0 ? { ...passed, exitCode: 1, stderr: 'Lib failed' } : passed;
    const outline = await extraction().extract();
    expect(outline.goalStates).toEqual({ protocol: 'lean-tactic-goals-v1', status: 'truncated', reason: 'Lib: informalization_goals_failed: Lib failed' });
    expect(outline.units.map(unit => unit.goals?.tactics.length)).toEqual([undefined, 0, 2, 2]);
  });

  it('skips the goals pass when the deadline leaves less than a second', async () => {
    const outline = await extraction().extract({ timeoutMs: 900 });
    expect(diagnostics.mock.calls.map(call => call[0].files)).toEqual([['Proof.lean'], [QUERY]]);
    expect(outline.goalStates).toMatchObject({ status: 'unavailable', reason: 'Lib: informalization_goals_timeout\nProof: informalization_goals_timeout' });
  });

  it('stops on cancellation instead of degrading', async () => {
    const controller = new AbortController();
    outcome = files => { if (GOALS.test(files[0]!)) controller.abort(new Error('cancelled by user')); return passed; };
    await expect(extraction().extract({ signal: controller.signal })).rejects.toThrow('cancelled by user');
  });
});
