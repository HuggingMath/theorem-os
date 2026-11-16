import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareMathRuns, comparisonReport } from '../scripts/mathematics/compareMathRuns';
import * as imo from '../src/math/imo2026Adapter';
import * as manifests from '../src/math/mathBuildManifest';
import * as problems from '../src/solver/problem';
import * as inspection from '../src/solver/inspection';
import * as batch from '../scripts/mathematics/runMathBatch';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { configurableSolverModules } from '../src/solver/modules/custom';
import { configuredSolverModules, solverMethodDigest } from '../src/solver/modules';
import type { MathAgentHarnessId } from '../src/runtime/agentSession';
import type { SolverRunState } from '../src/solver/archive';

const roots: string[] = [];
const source = fileURLToPath(new URL('..', import.meta.url));
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function prepare(harness: MathAgentHarnessId, extra: string[] = ['--common-research-skill', 'file']) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'comparison-harness-'))); roots.push(root);
  const repo = path.join(root, 'repo'), profile = path.join(root, 'template');
  fs.mkdirSync(repo); fs.mkdirSync(profile);
  const config = harness === 'codex' ? 'config.toml' : harness === 'claude-code' ? 'settings.json' :
    harness === 'opencode' ? 'opencode.json' : 'cli.json';
  fs.writeFileSync(path.join(profile, config), harness === 'codex' ? 'model = "local-test"\n' : harness === 'cli'
    ? JSON.stringify({ schema: 'theorem-os.cli-harness.v1', executable: process.execPath,
      args: ['--model', '{model}', '--effort', '{effort}'], efforts: ['high'], configurationFiles: ['config/native.json'] })
    : JSON.stringify(harness === 'opencode' ? { provider: { test: { options: { baseURL: 'http://127.0.0.1:9' } } } } : {}));
  if (harness === 'cli') {
    fs.mkdirSync(path.join(profile, 'config'));
    fs.writeFileSync(path.join(profile, 'config/native.json'), '{"native":"fixed"}\n');
  }
  fs.writeFileSync(path.join(profile, 'auth.json'), 'DO-NOT-COPY');
  fs.mkdirSync(path.join(profile, 'sessions')); fs.writeFileSync(path.join(profile, 'sessions/old'), 'old history');
  const task = path.join(root, 'task.md'), build = path.join(root, 'build.json');
  fs.writeFileSync(task, 'Prove all original targets.'); fs.writeFileSync(build, '{}');
  vi.spyOn(manifests, 'readMathBuildManifest').mockReturnValue({} as never);
  vi.spyOn(imo, 'bootstrapImo2026Problem').mockResolvedValue({} as never);
  vi.spyOn(problems, 'readSolverProblem').mockReturnValue({ receiptDigest: mathDigest('receipt') } as never);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const directory = path.join(root, 'comparison');
  await compareMathRuns(['--phase', 'prepare', '--directory', directory, '--repo', repo, '--task-file', task,
    '--build-manifest', build, '--problem', imo.IMO2026_SUPPORTED_PROBLEMS[0], '--repetitions', '1',
    '--model', 'test/model', '--effort', 'high', '--max-total-tokens', '10000', '--harness', harness,
    '--harness-profile', profile, '--harness-executable', process.execPath, ...extra]);
  const plan = JSON.parse(fs.readFileSync(path.join(directory, 'comparison.json'), 'utf8')) as Parameters<typeof comparisonReport>[1];
  return { directory, profile, config, plan };
}

describe('portable comparison harnesses', () => {
  it.each(['codex', 'claude-code', 'opencode', 'cli'] as const)(
    'isolates every %s attempt, preserves method identity and freezes the common Skill', async harness => {
      const { directory, profile, config, plan } = await prepare(harness);
      expect(plan.agentHarness?.id).toBe(harness);
      expect(plan.commonProviderProfile).toBeUndefined();
      expect(new Set(plan.jobs.map(job => job.agentHarness?.profile)).size).toBe(3);
      for (const job of plan.jobs) {
        const binding = job.agentHarness!;
        expect(binding).toEqual({ ...plan.agentHarness, profile: path.join(path.dirname(job.launch), 'harness') });
        expect(fs.readFileSync(path.join(binding.profile, config))).toEqual(fs.readFileSync(path.join(profile, config)));
        expect(fs.existsSync(path.join(binding.profile, 'auth.json'))).toBe(false);
        expect(fs.existsSync(path.join(binding.profile, 'sessions'))).toBe(false);
        if (harness === 'cli') expect(fs.readFileSync(path.join(binding.profile, 'config/native.json'), 'utf8')).toContain('fixed');
        const launch = JSON.parse(fs.readFileSync(job.launch, 'utf8'));
        const argument = (name: string) => launch.args[launch.args.indexOf(name) + 1];
        expect(argument('--harness')).toBe(harness);
        expect(argument('--harness-profile')).toBe(binding.profile);
        expect(argument('--common-research-skill')).toBe('file');
        expect(launch.args.filter((arg: string) => arg === '--research-mode')).toHaveLength(1);
        expect(argument('--research-mode')).toBe(job.arm === 'skill' ? 'skill' : 'legacy');
        const coordination = job.arm === 'cooperative' ? 'cooperative' : 'independent';
        const base = configuredSolverModules('direct', 'plan');
        const modules = harness === 'codex' ? base : { ...base, M1: { ...base.M1, version: base.M1.version + ':' + harness + ':v1' } };
        expect(job.methodDigest).toBe(solverMethodDigest(modules, coordination));
      }
      expect(comparisonReport(directory, plan)).toMatchObject({ agentHarness: plan.agentHarness,
        comparisonKind: 'research-strategy', guidanceComparison: { commonGuidanceFrozen: true, strategyIsolation: true } });
      const run = vi.spyOn(batch, 'runMathBatch').mockResolvedValue(0);
      expect(await compareMathRuns(['--phase', 'run', '--directory', directory])).toBe(0);
      expect(run).toHaveBeenCalledOnce();
    });

  it.each(['template', 'attempt'] as const)('rejects changed %s configuration before starting the batch', async target => {
    const { directory, profile, config, plan } = await prepare('claude-code');
    const run = vi.spyOn(batch, 'runMathBatch').mockResolvedValue(0);
    const selected = target === 'template' ? profile : plan.jobs[1].agentHarness!.profile;
    fs.chmodSync(path.join(selected, config), 0o600); fs.writeFileSync(path.join(selected, config), '{"changed":true}');
    await expect(compareMathRuns(['--phase', 'run', '--directory', directory])).rejects.toThrow('math_harness_identity_changed');
    expect(run).not.toHaveBeenCalled();
  });

  it('does not count a different observed backend under the frozen comparison', async () => {
    const { directory, plan } = await prepare('opencode');
    const states = new Map(plan.jobs.map(job => [job.output, { runId: job.output, phase: 'finished',
      problem: { receiptDigest: job.receiptDigest, targets: [] }, taskDigest: plan.taskDigest,
      buildDigest: plan.buildDigest, environmentDigest: plan.environmentDigest, evaluatorDigest: mathDigest('host-default'),
      methodDigest: job.methodDigest, model: plan.configuration.model, effort: plan.configuration.effort,
      worktree: '/unused', turns: 0, usage: { totalTokens: 0 }, tokenBudget: { maxTotalTokens: 10000 },
      workerCount: job.arm === 'skill' ? 1 : plan.configuration.workers,
      coordination: job.arm === 'cooperative' ? 'cooperative' : 'independent',
      ...(job.researchSkill ? { researchMode: 'skill', researchSkill: job.researchSkill } : {}),
      commonResearchSkill: job.commonResearchSkill, agentHarness: job.agentHarness,
    } as unknown as SolverRunState]));
    vi.spyOn(inspection, 'readRunInspection').mockImplementation(output => ({ stateFile: `${output}.runtime/state.json`,
      state: states.get(output)!, result: undefined, snapshot: undefined }));
    expect(comparisonReport(directory, plan).runs[0].comparisonIdentityMatches).toBe(true);
    states.get(plan.jobs[0].output)!.agentHarness = { ...plan.jobs[0].agentHarness!, id: 'claude-code' };
    expect(comparisonReport(directory, plan).runs[0]).toMatchObject({ accepted: false,
      comparisonIdentityMatches: false, error: 'comparison_harness_identity_mismatch' });
    delete plan.jobs[1].agentHarness;
    expect(() => comparisonReport(directory, plan)).toThrow('comparison_harness_identity_mismatch');
  });

  it('supports module-plan comparisons with the actual portable method digest', async () => {
    const { directory, plan } = await prepare('cli', ['--module-experiment',
      path.join(source, 'examples/components/module-experiment.json')]);
    expect(plan.jobs).toHaveLength(4);
    for (const job of plan.jobs) {
      const modulePlan = JSON.parse(fs.readFileSync(job.modulePlan!, 'utf8'));
      const base = configurableSolverModules(modulePlan, 'cooperative', plan.configuration.workers);
      const modules = { ...base, M1: { ...base.M1, version: base.M1.version + ':cli:v1' } };
      expect(job.methodDigest).toBe(solverMethodDigest(modules, 'cooperative'));
    }
    expect(comparisonReport(directory, plan).comparisonKind).toBe('module-plan');
  });

  it('rejects unsupported native Skill loading and changes to prepared backend flags', async () => {
    await expect(prepare('claude-code', ['--skill-baseline', 'native'])).rejects.toThrow('math_harness_native_skill_loading_unsupported');
    await expect(compareMathRuns(['--phase', 'run', '--directory', '/unused', '--harness', 'cli']))
      .rejects.toThrow('frozen during prepare');
  });
});
