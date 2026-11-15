import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { compareMathRuns, comparisonReport } from '../scripts/mathematics/compareMathRuns';
import * as buildManifest from '../src/math/mathBuildManifest';
import { readLeanTaskReceipt } from '../src/math/leanTask';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { projectMathematicsRuntimeEnvironment } from '../src/math/mathRuntimeEnvironment';
import * as solverProblem from '../src/solver/problem';
import * as inspection from '../src/solver/inspection';
import * as batch from '../scripts/mathematics/runMathBatch';
import * as sub2api from '../src/runtime/sub2api';
import * as deepseek from '../src/runtime/deepseek';
import type { SolverRunState } from '../src/solver/archive';

const roots: string[] = [];
const source = 'namespace Diagnostic\ntheorem main (n : Nat) : n + 0 = n := by\n  sorry\nend Diagnostic\n';
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function prepare() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'comparison-lean-task-test-'))); roots.push(root);
  const input = path.join(root, 'input.lean'), task = path.join(root, 'task.md'), build = path.join(root, 'build.json');
  fs.writeFileSync(input, source); fs.writeFileSync(task, 'Prove every original target in the supplied Lean statement.');
  fs.writeFileSync(build, '{}');
  vi.spyOn(buildManifest, 'readMathBuildManifest').mockReturnValue({} as never);
  vi.spyOn(deepseek, 'selectedDeepSeekProfile').mockReturnValue(undefined);
  vi.spyOn(sub2api, 'selectedSub2apiProfile').mockReturnValue({ profile: '/frozen-existing-profile', digest: mathDigest('same-provider') });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const directory = path.join(root, 'comparison');
  const args = ['--phase', 'prepare', '--directory', directory, '--dataset', 'lean-task', '--source-file', input,
    '--problem', 'diagnostic_nat_identity', '--task-file', task, '--build-manifest', build,
    '--repetitions', '1', '--workers', '2', '--model', 'deepseek-flash', '--effort', 'high',
    '--common-research-skill', 'native', '--max-total-tokens', '6000', '--max-run-seconds', '120',
    '--max-turn-seconds', '120', '--max-turns', '0', '--evaluator-timeout-seconds', '120'];
  expect(await compareMathRuns(args)).toBe(0);
  const plan = JSON.parse(fs.readFileSync(path.join(directory, 'comparison.json'), 'utf8')) as Parameters<typeof comparisonReport>[1];
  return { directory, input, plan, args };
}

function observedStates(plan: Parameters<typeof comparisonReport>[1]) {
  const states = new Map(plan.jobs.map(job => {
    const workspace = path.join(path.dirname(job.launch), 'workspace');
    return [job.output, { schema: 'deepscientist.math.solver.v1', runId: job.output, phase: 'finished',
      problem: solverProblem.readSolverProblem(workspace, path.join(workspace, 'active-problem.json')),
      taskDigest: plan.taskDigest, buildDigest: plan.buildDigest, environmentDigest: plan.environmentDigest,
      evaluatorDigest: mathDigest('host-default'), methodDigest: job.methodDigest,
      model: plan.configuration.model, effort: plan.configuration.effort, worktree: workspace,
      turns: 0, tokenBudget: { maxTotalTokens: 6000 }, workerCount: job.arm === 'skill' ? 1 : plan.configuration.workers,
      coordination: job.arm === 'cooperative' ? 'cooperative' : 'independent',
      ...(job.researchSkill ? { researchMode: 'skill', researchSkill: job.researchSkill } : {}),
      commonResearchSkill: job.commonResearchSkill, providerProfile: plan.commonProviderProfile!.profile,
      providerProfileDigest: plan.commonProviderProfile!.digest } as unknown as SolverRunState] as const;
  }));
  vi.spyOn(inspection, 'readRunInspection').mockImplementation(output => ({ stateFile: `${output}.runtime/state.json`,
    state: states.get(output)!, result: undefined, snapshot: undefined }));
  return states;
}

describe('isolated Lean task comparisons', () => {
  it('matches prepared resource identity in actual batch children without starting a model', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'comparison-env-probe-'))); roots.push(root);
    const toolsRoot = path.join(root, 'tools'), envFile = path.join(root, 'environment.json');
    fs.mkdirSync(path.join(toolsRoot, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(toolsRoot, 'bin/fixture-math'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const manifest = JSON.stringify({ schema: 'theorem-os.math-tools.v1', tools: [{
      name: 'fixture', version: '1', purpose: 'Disposable test tool', commands: ['fixture-math'],
    }] });
    fs.writeFileSync(path.join(toolsRoot, 'manifest.json'), manifest);
    fs.writeFileSync(envFile, JSON.stringify(projectMathematicsRuntimeEnvironment({ PATH: process.env.PATH,
      DEEPSCIENTIST_MATH_ENV_FILE: envFile, DEEPSCIENTIST_MATH_TOOLS_ROOT: toolsRoot })));
    vi.stubEnv('DEEPSCIENTIST_MATH_ENV_FILE', envFile);
    const { directory, plan } = await prepare();
    const probe = path.join(root, 'environment-probe.cjs');
    await build({ stdin: { contents: `import fs from 'node:fs';
      import { prepareSolverRuntimeEnvironment } from ${JSON.stringify(path.resolve('src/solver/environment.ts'))};
      const prepared = prepareSolverRuntimeEnvironment();
      fs.writeFileSync(process.argv[process.argv.indexOf('--output') + 1], JSON.stringify({
        environmentDigest: prepared.environmentDigest, toolsDigest: prepared.mathTools?.digest, modelStarted: false }));`,
      resolveDir: process.cwd() }, outfile: probe, bundle: true, platform: 'node', format: 'cjs', target: 'node22',
      loader: { '.py': 'text', '.lean': 'text' } });
    const probeLaunches = plan.jobs.map(job => {
      const file = path.join(path.dirname(job.launch), 'environment-probe-launch.json');
      fs.writeFileSync(file, JSON.stringify({ args: [process.execPath, probe, '--workspace',
        path.join(path.dirname(job.launch), 'workspace'), '--output', path.join(path.dirname(job.launch), 'environment-probe.json')] }));
      return file;
    });
    expect(await batch.runMathBatch(['--output', path.join(directory, 'environment-probe-batch.json'),
      '--concurrency', '1', ...probeLaunches.flatMap(file => ['--launch', file])])).toBe(0);
    for (const job of plan.jobs) expect(JSON.parse(fs.readFileSync(
      path.join(path.dirname(job.launch), 'environment-probe.json'), 'utf8'))).toEqual({
      environmentDigest: plan.environmentDigest, toolsDigest: mathDigest(manifest), modelStarted: false });
    // A resource change after prepare still prevents admission before the batch starts.
    fs.appendFileSync(path.join(toolsRoot, 'manifest.json'), '\n');
    const start = vi.spyOn(batch, 'runMathBatch');
    await expect(compareMathRuns(['--phase', 'run', '--directory', directory])).rejects.toThrow('comparison_environment_changed');
    expect(start).not.toHaveBeenCalled();
  });

  it('freezes the same unresolved source, standard environment, guidance and total allowance for three arms', async () => {
    const { directory, plan } = await prepare(), environment = getLeanTaskEnvironment('standard');
    expect(plan).toMatchObject({ dataset: 'lean-task', sourceCommitKind: 'input-sha256', sourceCommit: mathDigest(source),
      leanTask: { sourceRelativePath: 'source.lean', sourceSha256: mathDigest(source), environment: 'standard',
        toolchain: environment.toolchain, environmentDigest: environment.dependencyDigest },
      configuration: { workers: 2, repetitions: 1, model: 'deepseek-flash', effort: 'high', maxTotalTokens: 6000, maxRunSeconds: 120 } });
    expect(plan.sourceProblem).toBeUndefined();
    expect(fs.readFileSync(path.join(directory, 'source.lean'), 'utf8')).toBe(source);
    expect(fs.statSync(path.join(directory, 'source.lean')).mode & 0o777).toBe(0o400);
    expect(plan.jobs.map(job => job.arm)).toEqual(['skill', 'independent', 'cooperative']);
    for (const job of plan.jobs) {
      const launch = JSON.parse(fs.readFileSync(job.launch, 'utf8'));
      const argument = (name: string) => launch.args[launch.args.indexOf(name) + 1];
      const workspace = argument('--workspace'), receipt = readLeanTaskReceipt(path.join(workspace, 'active-problem.json'));
      expect(receipt).toMatchObject({ environment: 'standard', toolchain: environment.toolchain,
        environmentDigest: environment.dependencyDigest, contract: { formalStatement: source } });
      expect(fs.readFileSync(path.join(workspace, 'generated/problem/Submission.lean'), 'utf8')).toBe(source);
      expect(fs.readFileSync(path.join(workspace, 'generated/problem/Challenge.lean'), 'utf8')).toBe(source);
      expect(argument('--workers')).toBe(job.arm === 'skill' ? '1' : '2');
      expect(argument('--common-research-skill')).toBe('native');
      expect(argument('--max-total-tokens')).toBe('6000');
      expect(argument('--max-run-seconds')).toBe('120');
      expect(argument('--model')).toBe('deepseek-flash'); expect(argument('--effort')).toBe('high');
      expect(launch.commonResearchSkill).toEqual(plan.commonResearchSkill);
    }
  });

  it('retains every planned missing attempt and unavailable usage in the report', async () => {
    const { directory, plan } = await prepare(), report = comparisonReport(directory, plan);
    expect(report).toMatchObject({ dataset: 'lean-task', sourceCommitKind: 'input-sha256', comparisonKind: 'research-strategy' });
    expect(report.runs).toHaveLength(3);
    expect(report.runs.every(row => !row.accepted && row.status === 'missing' && row.totalTokens === null)).toBe(true);
    expect(report.totals.every(row => row.planned === 1 && row.accepted === 0 && row.missingTokenRuns === 1)).toBe(true);
  });

  it('uses the frozen snapshot after the original input changes and rejects snapshot edits before dispatch', async () => {
    const { directory, input, plan } = await prepare();
    fs.writeFileSync(input, source + '-- original input changed after prepare\n');
    expect(comparisonReport(directory, plan).runs).toHaveLength(3);
    const run = vi.spyOn(batch, 'runMathBatch').mockResolvedValue(0);
    expect(await compareMathRuns(['--phase', 'run', '--directory', directory])).toBe(0);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0]).toEqual([...plan.jobs.flatMap(job => ['--launch', job.launch]),
      '--concurrency', '1', '--output', path.join(directory, 'batch.json')]);
    run.mockClear();
    await expect(compareMathRuns(['--phase', 'run', '--directory', directory, '--source-file', input]))
      .rejects.toThrow('--source-file is frozen during prepare');
    fs.chmodSync(path.join(directory, 'source.lean'), 0o600);
    fs.writeFileSync(path.join(directory, 'source.lean'), source + '-- changed snapshot\n');
    await expect(compareMathRuns(['--phase', 'run', '--directory', directory])).rejects.toThrow('comparison_lean_task_source_changed');
    expect(() => comparisonReport(directory, plan)).toThrow('comparison_lean_task_source_changed');
    expect(run).not.toHaveBeenCalled();
  });

  it('does not count results or dispatch seeds with changed original sources', async () => {
    const { directory, plan } = await prepare(), states = observedStates(plan);
    expect(comparisonReport(directory, plan).runs.every(row => row.comparisonIdentityMatches)).toBe(true);
    const state = states.get(plan.jobs[0].output)!;
    states.set(plan.jobs[0].output, { ...state, problem: { ...state.problem,
      contract: { ...state.problem.contract, formalStatement: source + '-- changed source\n' } } });
    expect(comparisonReport(directory, plan).runs[0]).toMatchObject({ accepted: false, comparisonIdentityMatches: false,
      error: 'comparison_lean_task_source_identity_mismatch', totalTokens: null });
    const run = vi.spyOn(batch, 'runMathBatch').mockResolvedValue(0);
    const read = vi.spyOn(solverProblem, 'readSolverProblem');
    read.mockReturnValue(states.get(plan.jobs[0].output)!.problem);
    await expect(compareMathRuns(['--phase', 'run', '--directory', directory]))
      .rejects.toThrow('comparison_lean_task_source_identity_mismatch');
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects dataset metadata that misrepresents a Lean input as a source commit or different environment', async () => {
    const { directory, plan } = await prepare();
    const missingKind = { ...plan, sourceCommitKind: undefined };
    expect(() => comparisonReport(directory, missingKind)).toThrow('comparison_lean_task_source_identity_mismatch');
    const environmentChanged = { ...plan, leanTask: { ...plan.leanTask!, environmentDigest: mathDigest('other-environment') } };
    expect(() => comparisonReport(directory, environmentChanged)).toThrow('comparison_lean_task_source_identity_mismatch');
    const wrongDataset = { ...plan, dataset: 'putnambench' as const };
    expect(() => comparisonReport(directory, wrongDataset)).toThrow('comparison_putnam_source_identity_mismatch');
    const unlabelled = { ...plan, dataset: undefined };
    expect(() => comparisonReport(directory, unlabelled)).toThrow('comparison_dataset_invalid');
  });
});
