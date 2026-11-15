import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareMathRuns, comparisonReport } from '../scripts/mathematics/compareMathRuns';
import * as imoAdapter from '../src/math/imo2026Adapter';
import * as buildManifest from '../src/math/mathBuildManifest';
import * as solverProblem from '../src/solver/problem';
import * as inspection from '../src/solver/inspection';
import * as batch from '../scripts/mathematics/runMathBatch';
import * as skills from '../src/runtime/codexSkills';
import * as sub2api from '../src/runtime/sub2api';
import * as deepseek from '../src/runtime/deepseek';
import { mathDigest } from '../src/math/mathRuntimeIo';
import type { SolverRunState } from '../src/solver/archive';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

async function prepare(loading: 'native' | 'file' = 'native', common = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'comparison-skill-test-'))); roots.push(root);
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  const task = path.join(root, 'task.md'), build = path.join(root, 'build.json');
  fs.writeFileSync(task, 'Prove the same fixed problem.'); fs.writeFileSync(build, '{}');
  vi.spyOn(buildManifest, 'readMathBuildManifest').mockReturnValue({} as never);
  vi.spyOn(imoAdapter, 'bootstrapImo2026Problem').mockResolvedValue({} as never);
  vi.spyOn(solverProblem, 'readSolverProblem').mockReturnValue({ receiptDigest: mathDigest('receipt') } as never);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  if (common) {
    vi.spyOn(deepseek, 'selectedDeepSeekProfile').mockReturnValue(undefined);
    vi.spyOn(sub2api, 'selectedSub2apiProfile').mockReturnValue({ profile: '/frozen-existing-profile', digest: mathDigest('same-provider') });
  }
  const directory = path.join(root, 'comparison');
  await compareMathRuns(['--phase', 'prepare', '--directory', directory, '--repo', repo, '--task-file', task,
    '--build-manifest', build, '--problem', imoAdapter.IMO2026_SUPPORTED_PROBLEMS[0], '--repetitions', '2',
    '--max-total-tokens', '10000', common ? '--common-research-skill' : '--skill-baseline', loading]);
  const plan = JSON.parse(fs.readFileSync(path.join(directory, 'comparison.json'), 'utf8')) as Parameters<typeof comparisonReport>[1];
  return { directory, plan };
}

function observedStates(plan: Parameters<typeof comparisonReport>[1]) {
  const states = new Map(plan.jobs.map(job => [job.output, { schema: 'deepscientist.math.solver.v1', runId: job.output,
    phase: 'finished', problem: { receiptDigest: job.receiptDigest, targets: [] }, taskDigest: plan.taskDigest,
    buildDigest: plan.buildDigest, environmentDigest: plan.environmentDigest, evaluatorDigest: mathDigest('host-default'),
    methodDigest: job.methodDigest, model: plan.configuration.model, effort: plan.configuration.effort,
    worktree: '/unused', turns: 0, usage: { totalTokens: 0 }, tokenBudget: { maxTotalTokens: 10000 },
    workerCount: job.arm === 'skill' ? 1 : plan.configuration.workers,
    coordination: job.arm === 'cooperative' ? 'cooperative' : 'independent',
    ...(job.researchSkill ? { researchMode: 'skill', researchSkill: job.researchSkill } : {}),
    ...(job.commonResearchSkill ? { commonResearchSkill: job.commonResearchSkill } : {}),
    ...(plan.commonProviderProfile ? { providerProfile: plan.commonProviderProfile.profile,
      providerProfileDigest: plan.commonProviderProfile.digest } : {}),
  } as unknown as SolverRunState]));
  vi.spyOn(inspection, 'readRunInspection').mockImplementation(output => ({ stateFile: `${output}.runtime/state.json`,
    state: states.get(output)!, result: undefined, snapshot: undefined }));
  return states;
}

describe('optional skill baseline comparison', () => {
  it.each(['native', 'file'] as const)('freezes %s skill identity in the plan, jobs and launch while sharing the total allowance', async loading => {
    const { directory, plan } = await prepare(loading);
    expect(plan.skillBaseline).toMatchObject({ name: 'theoremos-research', loading, digest: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(plan.jobs.map(job => job.arm)).toEqual(['skill', 'independent', 'cooperative', 'independent', 'cooperative', 'skill']);
    for (const job of plan.jobs) {
      const launch = JSON.parse(fs.readFileSync(job.launch, 'utf8'));
      const argument = (name: string) => launch.args[launch.args.indexOf(name) + 1];
      expect(argument('--max-total-tokens')).toBe('10000');
      if (job.arm === 'skill') {
        expect(job.researchSkill).toEqual(plan.skillBaseline); expect(launch.researchSkill).toEqual(plan.skillBaseline);
        expect(argument('--research-mode')).toBe('skill'); expect(argument('--skill-loading')).toBe(loading);
        expect(argument('--workers')).toBe('1'); expect(argument('--coordination')).toBe('independent');
      } else {
        expect(job.researchSkill).toBeUndefined(); expect(launch.researchSkill).toBeUndefined();
        expect(launch.args).not.toContain('--research-mode'); expect(argument('--workers')).toBe('4');
      }
    }
    const report = comparisonReport(directory, plan);
    expect(report).toMatchObject({ comparisonKind: 'system-mode', skillBaseline: plan.skillBaseline,
      guidanceComparison: { commonGuidanceFrozen: false, strategyIsolation: false } });
    expect(report.totals.map(row => row.arm)).toEqual(['skill', 'independent', 'cooperative']);
    expect(report.totals.every(row => row.planned === 2 && row.accepted === 0)).toBe(true);
  });

  it('rejects module/scheduler combinations and post-prepare flag changes before touching a model', async () => {
    await expect(compareMathRuns(['--phase', 'prepare', '--directory', '/unused', '--skill-baseline', 'native',
      '--module-experiment', '/unused.json'])).rejects.toThrow('no --module-experiment');
    await expect(compareMathRuns(['--phase', 'prepare', '--directory', '/unused', '--skill-baseline', 'file',
      '--scheduler', 'critical-path'])).rejects.toThrow('--scheduler plan');
    await expect(compareMathRuns(['--phase', 'prepare', '--directory', '/unused', '--skill-baseline', 'typo']))
      .rejects.toThrow('invalid --skill-baseline');
    await expect(compareMathRuns(['--phase', 'run', '--directory', '/unused', '--skill-baseline', 'native']))
      .rejects.toThrow('frozen during prepare');
  });

  it('does not count a legacy or changed skill result under the frozen skill treatment', async () => {
    const { directory, plan } = await prepare(), states = observedStates(plan), skillJob = plan.jobs[0];
    expect(comparisonReport(directory, plan).runs[0].comparisonIdentityMatches).toBe(true);
    const state = states.get(skillJob.output)!; state.researchSkill = { ...state.researchSkill!, digest: mathDigest('changed-skill') };
    expect(comparisonReport(directory, plan).runs[0]).toMatchObject({ accepted: false, comparisonIdentityMatches: false,
      error: 'comparison_skill_identity_mismatch' });
    state.researchSkill = skillJob.researchSkill; delete state.researchMode;
    expect(comparisonReport(directory, plan).runs[0]).toMatchObject({ accepted: false,
      error: 'comparison_skill_identity_mismatch' });
    state.researchMode = 'skill'; state.workerCount = 4;
    expect(comparisonReport(directory, plan).runs[0]).toMatchObject({ accepted: false,
      error: 'comparison_run_identity_mismatch' });
  });

  it('rejects a changed project skill before starting the saved batch', async () => {
    const { directory, plan } = await prepare(), skill = plan.skillBaseline!;
    const run = vi.spyOn(batch, 'runMathBatch').mockResolvedValue(0);
    vi.spyOn(skills, 'readMathAgentSkill').mockReturnValue({ ...skill, path: '/unused/SKILL.md', digest: mathDigest('new-skill') });
    await expect(compareMathRuns(['--phase', 'run', '--directory', directory])).rejects.toThrow('comparison_skill_changed');
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects an edited plan that silently omits the skill treatment identity', async () => {
    const { directory, plan } = await prepare(); delete plan.jobs[0].researchSkill;
    expect(() => comparisonReport(directory, plan)).toThrow('comparison_skill_plan_identity_mismatch');
  });
});

describe('common skill research strategy comparison', () => {
  it.each(['native', 'file'] as const)('freezes common %s mathematics and provider identity for every arm', async loading => {
    const { directory, plan } = await prepare(loading, true);
    expect(plan.commonResearchSkill).toEqual(plan.skillBaseline);
    for (const job of plan.jobs) {
      expect(job.commonResearchSkill).toEqual(plan.commonResearchSkill);
      const launch = JSON.parse(fs.readFileSync(job.launch, 'utf8'));
      expect(launch.commonResearchSkill).toEqual(plan.commonResearchSkill);
      expect(launch.codexHome).toBe(plan.commonProviderProfile!.profile);
      expect(launch.args[launch.args.indexOf('--common-research-skill') + 1]).toBe(loading);
      expect(launch.args[launch.args.indexOf('--max-total-tokens') + 1]).toBe('10000');
      expect(launch.args[launch.args.indexOf('--model') + 1]).toBe(plan.configuration.model);
      expect(launch.args[launch.args.indexOf('--effort') + 1]).toBe(plan.configuration.effort);
    }
    const report = comparisonReport(directory, plan);
    expect(report).toMatchObject({ comparisonKind: 'research-strategy', commonResearchSkill: plan.skillBaseline,
      guidanceComparison: { commonGuidanceFrozen: true, strategyIsolation: true, protocolDifferencesCounted: true } });
    expect(report.runs).toHaveLength(6);
    expect(report.runs.every(run => run.totalTokens === null && !run.accepted)).toBe(true);
    expect(report.totals.every(total => total.planned === 2 && total.accepted === 0 && total.missingTokenRuns === 2)).toBe(true);
  });

  it('keeps missing usage and mismatched guidance, provider and budget attempts in the denominator', async () => {
    const { directory, plan } = await prepare('file', true), states = observedStates(plan);
    const first = states.get(plan.jobs[0].output)!;
    first.turns = 1; first.usage = undefined;
    first.usageAccounting = { startedTurns: 1, reportedTurns: 0, pending: false, incomplete: true };
    let report = comparisonReport(directory, plan);
    expect(report.runs[0]).toMatchObject({ totalTokens: null, usageComplete: false, accepted: false });
    const independent = states.get(plan.jobs[1].output)!;
    independent.commonResearchSkill = undefined;
    const cooperative = states.get(plan.jobs[2].output)!;
    cooperative.providerProfileDigest = mathDigest('different-provider');
    states.get(plan.jobs[3].output)!.tokenBudget!.maxTotalTokens = 20000;
    report = comparisonReport(directory, plan);
    expect(report.runs[1].error).toBe('comparison_common_guidance_identity_mismatch');
    expect(report.runs[2].error).toBe('comparison_common_provider_identity_mismatch');
    expect(report.runs[3].error).toBe('comparison_token_budget_mismatch');
    expect(report.runs).toHaveLength(6);
    expect(report.totals.reduce((total, row) => total + row.planned, 0)).toBe(6);
    expect(report.totals.reduce((total, row) => total + row.accepted, 0)).toBe(0);
  });

  it('rejects changed common plan or provider before executing any comparison job', async () => {
    const { directory, plan } = await prepare('native', true);
    const run = vi.spyOn(batch, 'runMathBatch').mockResolvedValue(0);
    vi.mocked(sub2api.selectedSub2apiProfile).mockReturnValue({ profile: '/frozen-existing-profile', digest: mathDigest('changed') });
    await expect(compareMathRuns(['--phase', 'run', '--directory', directory])).rejects.toThrow('comparison_common_provider_changed');
    expect(run).not.toHaveBeenCalled();
    plan.jobs[1].commonResearchSkill = undefined;
    expect(() => comparisonReport(directory, plan)).toThrow('comparison_common_guidance_identity_mismatch');
    await expect(compareMathRuns(['--phase', 'report', '--directory', directory, '--common-research-skill', 'file']))
      .rejects.toThrow('frozen during prepare');
  });

  it('rejects mismatched skill loading before creating a comparison', async () => {
    await expect(compareMathRuns(['--phase', 'prepare', '--directory', '/unused', '--common-research-skill', 'file',
      '--skill-baseline', 'native'])).rejects.toThrow('must match --skill-baseline');
  });
});
