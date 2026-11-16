import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { mathDigest, canonicalMathJson, readMathText } from '../../src/math/mathRuntimeIo';
import { readMathBuildManifest } from '../../src/math/mathBuildManifest';
import { prepareSolverRuntimeEnvironment } from '../../src/solver/environment';
import { readSolverProblem, git } from '../../src/solver/problem';
import { readMathAgentSkill } from '../../src/runtime/agentSkills';
import { researchSkillIdentity } from '../../src/solver/researchSkill';
import { bindResearchHarness, assertResearchHarnessCurrent } from '../../src/runtime/researchHarness';
import type { ResearchHarnessIdentity } from '../../src/runtime/researchHarness';
import { selectedSub2apiProfile } from '../../src/runtime/sub2api';
import { proofReceiptsMatch, type ProofCheck } from '../../src/solver/modules/evidence';

export const nativeComparisonRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const nativeComparisonSource = 'theorem comparison_add_zero (n : Nat) : n + 0 = n := by sorry\n' +
  'theorem comparison_keep (p : Prop) (h : p) : p := by sorry\n';
export const nativeComparisonTask = 'Prove every original target in the supplied core Lean statement. Preserve all original types and hypotheses.\n';
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const contractSchema = z.object({
  schema: z.literal('theorem-os.native-skill-job.v1'),
  arm: z.enum(['native-skill', 'runtime-skill']), root: z.string(), workspace: z.string(), output: z.string(),
  build: z.string(), buildDigest: hash, taskFile: z.string(), taskDigest: hash,
  sourceDigest: hash, receiptDigest: hash, initialCommit: z.string(), environmentFile: z.string(),
  environmentFileDigest: hash, environmentDigest: hash,
  harness: z.object({ id: z.literal('codex'), executable: z.string(), executableDigest: hash,
    profile: z.string(), configurationDigest: hash }).strict(),
  providerProfileDigest: hash, model: z.literal('deepseek-flash'), effort: z.literal('high'),
  skill: z.object({ name: z.literal('theoremos-research'), digest: hash, loading: z.literal('native') }).strict(),
  maxTotalTokens: z.number().int().positive().safe(), runSeconds: z.literal(0), turnSeconds: z.literal(0),
  writers: z.literal(1), nativeChildren: z.literal(false),
  enforcement: z.literal('provider-observed-upstream-request-limit'),
  acceptance: z.literal('host-lean-kernel-all-targets'),
}).strict();
export type NativeSkillJob = {
  schema: 'theorem-os.native-skill-job.v1'; arm: 'native-skill' | 'runtime-skill';
  root: string; workspace: string; output: string; build: string; buildDigest: string;
  taskFile: string; taskDigest: string; sourceDigest: string; receiptDigest: string; initialCommit: string;
  environmentFile: string; environmentFileDigest: string; environmentDigest: string;
  harness: ResearchHarnessIdentity & { id: 'codex' }; providerProfileDigest: string;
  model: 'deepseek-flash'; effort: 'high'; skill: { name: 'theoremos-research'; digest: string; loading: 'native' };
  maxTotalTokens: number; runSeconds: 0; turnSeconds: 0; writers: 1; nativeChildren: false;
  enforcement: 'provider-observed-upstream-request-limit'; acceptance: 'host-lean-kernel-all-targets';
};

export function nativeSkillLaunch(job: NativeSkillJob, file: string, digest: string) {
  return { cwd: job.root, envFile: job.environmentFile, codexHome: job.harness.profile,
    args: [process.execPath, path.join(job.root, 'scripts/mathematics/runNativeSkillBaseline.ts'), '--contract', file,
      '--contract-sha256', digest, '--workspace', job.workspace, '--output', job.output] };
}

/** Both executors recheck the exact launch inputs before opening any model session. */
export function readNativeSkillJob(file: string, digest: string, workspace: string, output: string,
  phase: 'launch' | 'report' = 'launch') {
  if (mathDigest(fs.readFileSync(file)) !== digest) throw new Error('native_comparison_contract_changed');
  const job = contractSchema.parse(JSON.parse(readMathText(file))) as NativeSkillJob;
  if (job.root !== nativeComparisonRoot || job.workspace !== fs.realpathSync(workspace) || job.output !== path.resolve(output))
    throw new Error('native_comparison_paths_changed');
  if (process.env.THEOREMOS_LIBRARY_HOST_CONFIG) throw new Error('native_comparison_requires_unmodified_core_fixture');
  const launchFile = path.join(path.dirname(file), 'launch.json');
  const comparisonFile = path.join(path.dirname(path.dirname(file)), 'comparison.json');
  const comparison = JSON.parse(readMathText(comparisonFile)) as { jobs: { arm: string; contract: string; contractDigest: string; launch: string; launchDigest: string; workspace: string; output: string }[] };
  const planned = comparison.jobs.find(item => item.arm === job.arm);
  if (!planned || planned.contract !== file || planned.contractDigest !== digest || planned.launch !== launchFile ||
      planned.workspace !== job.workspace || planned.output !== job.output || planned.launchDigest !== mathDigest(fs.readFileSync(launchFile)))
    throw new Error('native_comparison_launch_changed');
  if (canonicalMathJson(JSON.parse(readMathText(launchFile))) !== canonicalMathJson(nativeSkillLaunch(job, file, digest)))
    throw new Error('native_comparison_launch_changed');
  readMathBuildManifest(job.build, job.root, path.join(job.root, 'out/main'));
  if (mathDigest(fs.readFileSync(job.build)) !== job.buildDigest || mathDigest(readMathText(job.taskFile)) !== job.taskDigest ||
      mathDigest(fs.readFileSync(job.environmentFile)) !== job.environmentFileDigest)
    throw new Error('native_comparison_inputs_changed');
  const prepared = prepareSolverRuntimeEnvironment({ ...process.env, DEEPSCIENTIST_MATH_ENV_FILE: job.environmentFile });
  if (prepared.environmentDigest !== job.environmentDigest) throw new Error('native_comparison_environment_changed');
  assertResearchHarnessCurrent(job.harness, process.env, job.model);
  if (selectedSub2apiProfile(job.harness.profile)?.digest !== job.providerProfileDigest)
    throw new Error('native_comparison_provider_changed');
  const skill = readMathAgentSkill(path.join(job.root, 'skills/theoremos-research/SKILL.md'), job.skill.loading);
  if (canonicalMathJson(researchSkillIdentity(skill)) !== canonicalMathJson(job.skill))
    throw new Error('native_comparison_skill_changed');
  const problem = readSolverProblem(job.workspace, path.join(job.workspace, 'active-problem.json'));
  if (problem.receiptDigest !== job.receiptDigest || problem.baseCommit !== job.initialCommit ||
      mathDigest(problem.contract.formalStatement) !== job.sourceDigest ||
      phase === 'launch' && (git(job.workspace, ['rev-parse', 'HEAD']) !== job.initialCommit ||
      git(job.workspace, ['status', '--porcelain', '--untracked-files=no'])))
    throw new Error('native_comparison_problem_changed');
  return { job, prepared, problem, launchDigest: mathDigest(fs.readFileSync(launchFile)),
    comparisonDigest: mathDigest(fs.readFileSync(comparisonFile)) };
}

export function nativeComparisonHarness(executable: string, profile: string) {
  const provider = selectedSub2apiProfile(profile);
  if (!provider) throw new Error('native_comparison_requires_existing_sub2api_profile');
  return { harness: { ...bindResearchHarness('codex', executable, fs.realpathSync(profile)), id: 'codex' as const }, providerProfileDigest: provider.digest };
}

export function runtimeSkillArguments(job: NativeSkillJob): string[] {
  return [path.join(job.root, 'bin/math.ts'), 'run', '--workspace', job.workspace, '--task-file', job.taskFile,
    '--output', job.output, '--build-manifest', job.build, '--model', job.model, '--effort', job.effort,
    '--harness', 'codex', '--harness-executable', job.harness.executable, '--harness-profile', job.harness.profile,
    '--research-mode', 'skill', '--skill-loading', job.skill.loading, '--common-research-skill', job.skill.loading,
    '--workers', '1', '--coordination', 'independent', '--method', 'direct', '--scheduler', 'plan',
    '--max-turns', '0', '--max-run-seconds', '0', '--max-turn-seconds', '0',
    '--max-total-tokens', String(job.maxTotalTokens), '--proof-timeout-seconds', '0', '--evaluator-timeout-seconds', '0'];
}

/** Acceptance compares every frozen target and the independently checked final source, not a model message. */
export function nativeComparisonAccepted(problem: ReturnType<typeof readSolverProblem>, check: ProofCheck | undefined,
  evaluation: Record<string, unknown> | undefined): boolean {
  const final = evaluation?.verification as ProofCheck | undefined;
  return Boolean(check?.passed && evaluation?.status === 'passed' && evaluation.method === 'host-lean-kernel-all-targets' &&
    evaluation.official === false && final?.passed && final.commit === check.commit && final.sourceDigest === check.sourceDigest &&
    problem.targets.length && proofReceiptsMatch(final.verification, check.commit, problem.targets.map(target => ({
      proofPath: target.proofPath, theoremName: target.theoremName, expectedSourceDeclarationHash: target.declarationHash,
      statementHash: problem.contract.statementHash, leanStatementHash: problem.contract.leanStatementHash, claim: 'statement' }))));
}
