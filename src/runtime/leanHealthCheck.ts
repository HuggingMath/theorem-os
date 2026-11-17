import { runMathProcess } from '../math/mathProcess';
import fs from 'node:fs';
import { leanEnvironmentFailure, type LeanEnvironmentHealth } from '../math/leanEnvironmentHealth';
import { MATH_PROOF_ENVIRONMENT_ENV, MATH_PROOF_ENVIRONMENT_SANDBOX_ENV } from '../math/mathProofEnvironment';
import type { MathAgentOptions } from './agentSession';
import { prepareHarnessProcess } from './harnessProcess';

export class LeanEnvironmentHealthCheckError extends Error {
  readonly diagnostic;
  constructor(readonly health: LeanEnvironmentHealth) {
    const failure = health.error;
    super(`${failure?.code ?? 'math_lean_environment_unavailable'}: ${failure?.message ?? 'Lean environment health probe failed'}. ${failure?.recovery ?? ''}`);
    this.name = 'LeanEnvironmentHealthCheckError';
    this.diagnostic = failure;
  }
}

/** A disposable process uses the native writer's exact OS isolation inputs, without starting its RPC or model. */
export async function runHarnessLeanHealthCheck(options: Pick<MathAgentOptions,
  'workspace' | 'profile' | 'environment' | 'hiddenRoots' | 'isolatedWorkspaceParent' | 'isolateProcess' | 'proofProjectRoot' | 'leanHealthCheck' | 'signal'>): Promise<LeanEnvironmentHealth | undefined> {
  if (!options.leanHealthCheck) return undefined;
  if (!options.isolateProcess) throw new Error('math_lean_health_check_requires_process_isolation');
  const launch = prepareHarnessProcess(options, options.leanHealthCheck.executable, options.leanHealthCheck.arguments);
  const result = await runMathProcess(launch.command, launch.args, {
    cwd: options.workspace, env: launch.env, timeoutMs: Infinity, signal: options.signal,
    outputCapture: 'head', outputLimit: 32_000,
  });
  options.signal?.throwIfAborted();
  let health: LeanEnvironmentHealth | undefined;
  try {
    const parsed = JSON.parse(result.stdout) as Partial<LeanEnvironmentHealth>;
    if (parsed.schema === 'theoremos.lean-environment-health.v1' && typeof parsed.projectRoot === 'string' &&
        parsed.leanStarted === false && parsed.timedOut === false &&
        (parsed.proofEnvironment === 'sealed' || parsed.proofEnvironment === 'unbound') &&
        (parsed.status === 'ready' && parsed.exitCode === 0 && parsed.classification === 'success' ||
         parsed.status === 'infrastructure-error' && parsed.exitCode === 1 && parsed.classification === 'infrastructure' &&
         parsed.error && typeof parsed.error.code === 'string' && typeof parsed.error.message === 'string' &&
         typeof parsed.error.recovery === 'string' && typeof parsed.error.fingerprint === 'string'))
      health = parsed as LeanEnvironmentHealth;
  } catch { /* Invalid output is a failed infrastructure probe, never proof or readiness evidence. */ }
  const sealedExpected = launch.env[MATH_PROOF_ENVIRONMENT_ENV] !== undefined || launch.env[MATH_PROOF_ENVIRONMENT_SANDBOX_ENV] !== undefined;
  const wrongProject = health?.status === 'ready' && options.proofProjectRoot !== undefined &&
    health.projectRoot !== fs.realpathSync(options.proofProjectRoot);
  const missingSealedBinding = health?.status === 'ready' && sealedExpected && health.proofEnvironment !== 'sealed';
  const wrongBinding = wrongProject || missingSealedBinding;
  if (result.exitCode === 0 && !result.aborted && !result.timedOut && result.started && health?.status === 'ready' && !wrongBinding) return health;
  if (!health || health.status === 'ready') health = {
    schema: 'theoremos.lean-environment-health.v1', projectRoot: options.workspace,
    status: 'infrastructure-error', classification: 'infrastructure', exitCode: 1, timedOut: false,
    leanStarted: false, proofEnvironment: 'unbound', error: leanEnvironmentFailure(wrongBinding ? 'proof-environment' : 'environment',
      new Error(wrongProject ? 'Health probe did not verify the configured proof project' :
        missingSealedBinding ? 'Health probe did not verify the supplied sealed environment binding' :
        `Isolated health probe did not establish readiness (exit=${result.exitCode ?? 'none'}): ` +
        (result.errorMessage ?? result.stderr ?? '').slice(0, 4000))),
  };
  throw new LeanEnvironmentHealthCheckError(health);
}
