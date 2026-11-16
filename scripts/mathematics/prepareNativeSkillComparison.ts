#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlags, required } from './arguments';
import { bootstrapLeanTask } from '../../src/math/leanTask';
import { readMathBuildManifest } from '../../src/math/mathBuildManifest';
import { mathDigest, writeMathJsonDurable } from '../../src/math/mathRuntimeIo';
import { projectMathematicsRuntimeEnvironment } from '../../src/math/mathRuntimeEnvironment';
import { prepareSolverRuntimeEnvironment } from '../../src/solver/environment';
import { readSolverProblem } from '../../src/solver/problem';
import { researchSkillIdentity } from '../../src/solver/researchSkill';
import { readMathAgentSkill } from '../../src/runtime/agentSkills';
import { nativeComparisonHarness, nativeComparisonRoot as root, nativeComparisonSource, nativeComparisonTask,
  nativeSkillLaunch, type NativeSkillJob } from './nativeSkillComparison';

/** Offline preparation for exactly one independent core-Lean fixture and two single-writer executors. */
export function prepareNativeSkillComparison(argv: string[]): number {
  const flags = parseFlags(argv, ['directory', 'build-manifest', 'profile', 'codex', 'max-total-tokens']);
  if (flags.has('help')) {
    console.log('Usage: bun scripts/mathematics/prepareNativeSkillComparison.ts --directory NEW_DIR --build-manifest FILE --profile DIR [--codex FILE] [--max-total-tokens 10000]\n'
      + 'Prepares native-skill and runtime-skill cold starts, without model calls. Both use deepseek-flash/high, the same native skill/profile/resources, one writer, no child agents and no solve time limit.');
    return 0;
  }
  if (process.env.THEOREMOS_LIBRARY_HOST_CONFIG) throw new Error('native_comparison_requires_unmodified_core_fixture');
  const maxTotalTokens = Number(flags.get('max-total-tokens') ?? '10000');
  if (!Number.isSafeInteger(maxTotalTokens) || maxTotalTokens < 1) throw new Error('invalid --max-total-tokens');
  const directory = path.resolve(required(flags, 'directory')), build = fs.realpathSync(required(flags, 'build-manifest'));
  if (directory === root || directory.startsWith(root + path.sep)) throw new Error('native_comparison_directory_must_be_external');
  readMathBuildManifest(build, root, path.join(root, 'out/main'));
  const profile = fs.realpathSync(required(flags, 'profile'));
  const provider = nativeComparisonHarness(flags.get('codex') ?? 'codex', profile);
  const skill = researchSkillIdentity(readMathAgentSkill(path.join(root, 'skills/theoremos-research/SKILL.md'), 'native'));
  fs.mkdirSync(path.dirname(directory), { recursive: true }); fs.mkdirSync(directory, { mode: 0o700 });
  const taskFile = path.join(directory, 'task.md'), environmentFile = path.join(directory, 'environment.json');
  fs.writeFileSync(taskFile, nativeComparisonTask, { flag: 'wx', mode: 0o400 });
  fs.writeFileSync(path.join(directory, 'source.lean'), nativeComparisonSource, { flag: 'wx', mode: 0o400 });
  const initial = prepareSolverRuntimeEnvironment();
  writeMathJsonDurable(environmentFile, projectMathematicsRuntimeEnvironment({ ...initial.environment,
    DEEPSCIENTIST_MATH_ENV_FILE: environmentFile }), 0o400);
  const prepared = prepareSolverRuntimeEnvironment({ ...process.env, DEEPSCIENTIST_MATH_ENV_FILE: environmentFile });
  const jobs = (['native-skill', 'runtime-skill'] as const).map(arm => {
    const jobRoot = path.join(directory, arm); fs.mkdirSync(jobRoot, { mode: 0o700 });
    const workspace = path.join(jobRoot, 'workspace'), output = path.join(jobRoot, 'result.json');
    bootstrapLeanTask(workspace, { source: nativeComparisonSource, task: nativeComparisonTask, environment: 'standard' });
    const problem = readSolverProblem(workspace, path.join(workspace, 'active-problem.json'));
    const contract: NativeSkillJob = { schema: 'theorem-os.native-skill-job.v1', arm, root, workspace, output, build,
      buildDigest: mathDigest(fs.readFileSync(build)), taskFile, taskDigest: mathDigest(nativeComparisonTask),
      sourceDigest: mathDigest(nativeComparisonSource), receiptDigest: problem.receiptDigest, initialCommit: problem.baseCommit,
      environmentFile, environmentFileDigest: mathDigest(fs.readFileSync(environmentFile)), environmentDigest: prepared.environmentDigest,
      ...provider, model: 'deepseek-flash', effort: 'high', skill: skill as NativeSkillJob['skill'],
      maxTotalTokens, runSeconds: 0, turnSeconds: 0, writers: 1, nativeChildren: false,
      enforcement: 'provider-observed-upstream-request-limit', acceptance: 'host-lean-kernel-all-targets' };
    const file = path.join(jobRoot, 'contract.json'); writeMathJsonDurable(file, contract, 0o400);
    const contractDigest = mathDigest(fs.readFileSync(file));
    const launch = path.join(jobRoot, 'launch.json');
    writeMathJsonDurable(launch, nativeSkillLaunch(contract, file, contractDigest), 0o400);
    return { arm, contract: file, contractDigest, launch, launchDigest: mathDigest(fs.readFileSync(launch)), workspace, output };
  });
  writeMathJsonDurable(path.join(directory, 'comparison.json'), {
    schema: 'theorem-os.native-skill-comparison.v1', status: 'prepared', invokesModel: false, modelBenefitMeasured: false,
    baseline: 'native-app-server-single-task-with-shared-adapter-not-default-codex-exec',
    scope: 'cold-start-only', taskDigest: mathDigest(nativeComparisonTask), sourceDigest: mathDigest(nativeComparisonSource),
    model: 'deepseek-flash', effort: 'high', skill, ...provider, environmentDigest: prepared.environmentDigest,
    maxTotalTokens, runSeconds: 0, writers: 1, nativeChildren: false, jobs,
  }, 0o400);
  console.log(JSON.stringify({ directory, invokesModel: false, jobs: jobs.length, status: 'prepared' }));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = prepareNativeSkillComparison(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : 'native_comparison_prepare_failed'); process.exitCode = 1; }
}
