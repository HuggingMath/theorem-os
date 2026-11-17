import fs from 'node:fs';
import path from 'node:path';
import { checkResolvedLeanToolchainReadiness } from './leanToolchainReadiness';
import { acquireMathProofEnvironmentLease, MATH_PROOF_ENVIRONMENT_SANDBOX_ENV,
  resolveMathProofEnvironment } from './mathProofEnvironment';
import { resolveMathematicsRuntimeEnvironment } from './mathRuntimeEnvironment';
import { mathDigest } from './mathRuntimeIo';

export type LeanEnvironmentHealthStage = 'project' | 'environment' | 'proof-environment' | 'lease' | 'toolchain';
export type LeanEnvironmentFailure = Readonly<{
  code: string; stage: LeanEnvironmentHealthStage; message: string; recovery: string;
  retry: 'after-environment-repair'; fingerprint: string;
}>;
export type LeanEnvironmentHealth = Readonly<{
  schema: 'theoremos.lean-environment-health.v1'; projectRoot: string;
  status: 'ready' | 'infrastructure-error'; classification: 'success' | 'infrastructure';
  exitCode: 0 | 1; timedOut: false; leanStarted: false;
  proofEnvironment: 'sealed' | 'unbound'; proofEnvironmentIdentity?: string;
  toolchain?: string; error?: LeanEnvironmentFailure;
}>;

const recovery = (stage: LeanEnvironmentHealthStage) => stage === 'proof-environment' || stage === 'lease'
  ? 'The sealed environment or its lease is unavailable in this process namespace. Report this infrastructure fault to the Lead/host. ' +
    'Preserve proof sources; do not infer host liveness from sandbox /proc or repeat compilation against an unchanged mapping. Retry after the host repairs the worker environment.'
  : stage === 'toolchain'
    ? 'Report the pinned Lean toolchain fault to the Lead/host. Preserve proof sources and retry after PATH, ELAN_HOME or the pinned compiler is repaired.'
    : 'Report the project/environment fault to the Lead/host. Preserve proof sources and retry after the path or environment projection is repaired.';

export function leanEnvironmentFailure(stage: LeanEnvironmentHealthStage, error: unknown): LeanEnvironmentFailure {
  const code = `math_lean_${stage.replaceAll('-', '_')}_unavailable`;
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 4000);
  return { code, stage, message, recovery: recovery(stage), retry: 'after-environment-repair',
    fingerprint: mathDigest(JSON.stringify([code, stage, message])) };
}

/** Probe the caller's actual namespace, without compiling sources or publishing proof evidence. */
export async function checkLeanEnvironmentHealth(input: {
  projectRoot: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number;
}): Promise<LeanEnvironmentHealth> {
  let projectRoot = path.resolve(input.projectRoot), stage: LeanEnvironmentHealthStage = 'project';
  let proofEnvironmentIdentity: string | undefined;
  let lease: Awaited<ReturnType<typeof acquireMathProofEnvironmentLease>>;
  const base = () => ({ schema: 'theoremos.lean-environment-health.v1' as const, projectRoot,
    leanStarted: false as const, timedOut: false as const,
    proofEnvironment: proofEnvironmentIdentity ? 'sealed' as const : 'unbound' as const,
    ...(proofEnvironmentIdentity ? { proofEnvironmentIdentity } : {}) });
  try {
    input.signal?.throwIfAborted();
    projectRoot = fs.realpathSync(projectRoot);
    if (!fs.statSync(projectRoot).isDirectory()) throw new Error('Lean project root must be a directory');
    stage = 'environment';
    const env = resolveMathematicsRuntimeEnvironment(input.env ?? process.env);
    stage = 'proof-environment';
    const sealed = resolveMathProofEnvironment(projectRoot, env);
    if (env[MATH_PROOF_ENVIRONMENT_SANDBOX_ENV] && !sealed)
      throw new Error('Isolated worker has a sandbox mapping without a sealed proof environment descriptor');
    proofEnvironmentIdentity = sealed?.identity;
    stage = 'lease';
    lease = await acquireMathProofEnvironmentLease(projectRoot, env, input.signal,
      Number.isFinite(input.timeoutMs) ? Date.now() + input.timeoutMs! : undefined);
    if (sealed && !lease) throw new Error('Sealed proof environment lease is unavailable');
    input.signal?.throwIfAborted();
    stage = 'toolchain';
    const toolchain = checkResolvedLeanToolchainReadiness({ projectRoot, env, timeoutMs: input.timeoutMs ?? Infinity });
    if (toolchain.status !== 'ready') throw new Error(toolchain.diagnostics);
    return { ...base(), status: 'ready', classification: 'success', exitCode: 0,
      ...(toolchain.toolchain ? { toolchain: toolchain.toolchain } : {}) };
  } catch (error) {
    return { ...base(), status: 'infrastructure-error', classification: 'infrastructure', exitCode: 1,
      error: leanEnvironmentFailure(stage, error) };
  } finally { await lease?.release(); }
}
