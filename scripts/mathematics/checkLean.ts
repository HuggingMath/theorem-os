#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { runLeanDiagnostics } from '../../src/math/leanDiagnostics';
import { checkLeanType } from '../../src/math/leanTypeDiagnostics';
import { readMathJson } from '../../src/math/mathRuntimeIo';
import { assertSolverProjectSources, SolverSourceError, type SolverSourceConstraints } from '../../src/solver/problem';
import { currentWorkerProject, WorkerProjectArgumentError } from '../../src/solver/workerProject';
import { checkLeanEnvironmentHealth, leanEnvironmentFailure } from '../../src/math/leanEnvironmentHealth';
import { assertMathConstructionSources } from '../../src/math/mathConstructionSources';
import { teamEvidenceRefSchema } from '../../src/solver/agentTeamEvidenceRef';

let stage: 'usage' | 'project' | 'source' | 'diagnostics' = 'usage';
let project: string | undefined;
let compilationAttempted = false;
const publish = (result: unknown, exitCode: number) => {
  console.log(JSON.stringify(result));
  process.exitCode = exitCode;
};
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === 'check-lean') args.shift();
  const { values } = parseArgs({ args, options: {
    workspace: { type: 'string' }, worktree: { type: 'string' }, file: { type: 'string', multiple: true },
    type: { type: 'string' }, context: { type: 'string' }, expression: { type: 'string' },
    candidate: { type: 'string' },
    'timeout-seconds': { type: 'string', default: '0' }, health: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) console.log('Usage: theorem-os check-lean (--workspace DIR | --worktree ROOT) --file FILE [--file FILE --timeout-seconds N]\n'
    + '--worktree is the worker root containing .scratch/worker-project.json; --workspace is the Lean project directory.\n'
    + '--file is relative to the Lean project, e.g. Submission.lean, without a generated/problem/ prefix.\n'
    + 'Optional: --type TYPE --context DECLARATION elaborates one closed type in a proof-erased snapshot of the single --file context.\n'
    + 'Add --expression TERM to check one selected closed application against that type. Local theorem bodies are erased; this is advisory sufficiency, not proof acceptance.\n'
    + 'Use --health instead of --file to verify the current namespace, sealed lease and pinned compiler without compiling sources.\n'
    + 'Use --candidate REF to record which peer result a saved single-file probe tests. REF is message:ID, research:ID or delivery:ID.\n'
    + 'Checks saved sources against pinned packages. Timeout 0 waits until completion. Diagnostics and type elaboration are advisory, not proof acceptance.');
  else {
    const timeout = Number(values['timeout-seconds']);
    if (Boolean(values.workspace) === Boolean(values.worktree) || (!values.health && !values.file?.length) || !Number.isSafeInteger(timeout) || timeout < 0)
      throw new Error('Exactly one of --workspace/--worktree, --file (or --health) and a nonnegative --timeout-seconds are required');
    if (values.health && (values.file?.length || values.type !== undefined || values.context !== undefined || values.expression !== undefined))
      throw new Error('--health checks the environment only; omit --file, --type, --context and --expression');
    if ((values.type !== undefined || values.context !== undefined) && (!values.type || !values.context || values.file?.length !== 1))
      throw new Error('--type requires --context and exactly one --file');
    if (values.expression !== undefined && !values.type) throw new Error('--expression requires --type and --context');
    if (values.candidate !== undefined && (values.file?.length !== 1 || values.type !== undefined ||
        !teamEvidenceRefSchema.safeParse(values.candidate).success))
      throw new Error('--candidate requires a team evidence reference and one saved --file probe');
    stage = 'project';
    project = values.workspace ? fs.realpathSync(values.workspace) : currentWorkerProject(values.worktree!);
    stage = 'source';
    const constraints = path.join(project, '.lake/source-constraints.json');
    if (!values.health && fs.existsSync(constraints)) assertSolverProjectSources(readMathJson(constraints) as SolverSourceConstraints, project);
    if (!values.health) assertMathConstructionSources(project, values.file!);
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once('SIGINT', abort); process.once('SIGTERM', abort);
    let result;
    const shared = { projectRoot: project, timeoutMs: timeout === 0 ? Infinity : timeout * 1000,
      signal: controller.signal, onProgress: (file: string) => {
        compilationAttempted = true;
        console.error(JSON.stringify({ event: 'lean_check_started', file }));
      } };
    try {
      const health = await checkLeanEnvironmentHealth(shared);
      if (values.health || health.status !== 'ready') return publish(health, health.exitCode);
      stage = 'diagnostics';
      result = values.type ? await checkLeanType({ ...shared, file: values.file![0], type: values.type, context: values.context!, expression: values.expression }) :
        await runLeanDiagnostics({ ...shared, files: values.file! });
    } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
    const startupFailed = !result.timedOut && !result.aborted && 'started' in result && result.started === false;
    publish({ ...result, classification: result.timedOut ? 'timeout' : result.aborted ? 'cancelled' :
      result.exitCode === 0 ? 'success' : startupFailed ? 'infrastructure' : 'lean',
      ...(values.candidate && { candidate: { ref: values.candidate, file: values.file![0] } }),
      ...(startupFailed ? { status: 'infrastructure-error', leanStarted: false,
        error: leanEnvironmentFailure('toolchain', new Error(result.stderr || 'Lean compiler process did not start')) } : {}) },
    result.timedOut ? 124 : result.exitCode ?? 1);
  }
}
void main().catch(async error => {
  if (error instanceof WorkerProjectArgumentError) return publish({ status: 'usage-error', classification: 'usage',
    exitCode: 1, timedOut: false, leanStarted: false,
    error: { code: error.code, message: error.message,
      recovery: `Use check-lean --worktree ${quote(error.worktreeRoot)} --file 'OWNED_FILE.lean', or ` +
        `check-lean --workspace ${quote(error.projectRoot)} --file 'OWNED_FILE.lean'. ` +
        'File paths are relative to the Lean project, without its prefix.' } }, 1);
  if (stage === 'diagnostics' && project) {
    const health = await checkLeanEnvironmentHealth({ projectRoot: project });
    if (health.status !== 'ready') return publish({ ...health, leanStarted: compilationAttempted ? null : false }, 1);
  }
  const message = error instanceof Error ? error.message : 'math_diagnostics_failed';
  if (stage === 'project') return publish({ status: 'infrastructure-error', classification: 'infrastructure',
    exitCode: 1, timedOut: false, leanStarted: false, error: leanEnvironmentFailure('project', error) }, 1);
  publish({ status: stage === 'usage' ? 'usage-error' : error instanceof SolverSourceError || stage === 'source' ? 'source-error' : 'diagnostics-error',
    classification: stage === 'usage' ? 'usage' : error instanceof SolverSourceError || stage === 'source' ? 'source' : 'tooling',
    exitCode: 1, timedOut: false, leanStarted: compilationAttempted ? null : false,
    error: { code: error instanceof SolverSourceError ? error.message : 'math_diagnostics_failed', message,
      ...(stage === 'source' && project ? { recovery: `Inspect the requested saved sources and their imports in ${quote(project)}. ` +
        '--file paths are relative to this Lean project; do not repeat the project directory prefix. ' +
        `For example: check-lean --workspace ${quote(project)} --file 'Submission.lean'.` } : {}),
      ...(error instanceof SolverSourceError ? { file: error.proofPath, recovery: error.recovery } : {}) } }, 1);
});
