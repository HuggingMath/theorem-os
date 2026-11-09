#!/usr/bin/env bun
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlags, required } from './arguments';
import { autoLibraryLiveUsage, autoLibraryPackFor, autoLibraryRunUsage, readAutoLibraryPool } from '../../src/math/autoLibrary';
import { getLeanTaskEnvironment, type LeanTaskEnvironment } from '../../src/math/leanTaskEnvironment';
import { autoLibraryHostTarget, resolveAutoLibraryBase } from '../../src/math/autoLibraryHost';
import { authorizeHostAutoTask, hostAutoEvidence, libraryHostConfigPath, resolveHostLibrary } from '../../src/math/libraryHostConfig';
import { canonicalLibraryJson } from '../../src/math/libraryRelease';
import { LEAN_TASK_SOURCE_MAX_BYTES, leanTaskId } from '../../src/math/leanTask';
import { readLibraryPack, summarizeLibraryPack } from '../../src/math/libraryPacks';
import { readMathBuildManifest } from '../../src/math/mathBuildManifest';
import { mathDigest, readMathText, writeMathJsonDurable } from '../../src/math/mathRuntimeIo';
import { assertMathCanonicalPath, isMathPathWithin } from '../../src/math/paths';
import { inspectAutoLibraryBuild, prepareAutoLibraryBuild, readAutoLibraryRequest, runAutoLibraryBuild } from '../../src/solver/autoLibrary';
import { captureAutoLibraryDemand, readAutoLibraryDemand } from '../../src/solver/autoLibraryDemand';
import { readSolverRunState } from '../../src/solver/archive';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const prepareFlags = ['challenge-file', 'task-file', 'challenge-id', 'environment', 'pool', 'base-pack', 'build-manifest',
  'model', 'effort', 'profile', 'codex', 'prover-model', 'prover-effort', 'workers', 'coordination', 'max-modules', 'max-rounds',
  'max-run-seconds', 'max-total-tokens', 'planner-turn-seconds', 'prover-max-run-seconds', 'prover-max-turns',
  'prover-max-turn-seconds', 'prover-max-total-tokens', 'prepare-timeout-seconds', 'demand-file', 'definition-targets'] as const;

function externalPath(value: string): string {
  const resolved = path.resolve(value);
  assertMathCanonicalPath(resolved);
  if (isMathPathWithin(root, resolved) || isMathPathWithin(resolved, root)) throw new Error('Keep auto-library directories outside the source repository.');
  return resolved;
}
function integerFlag(flags: ReadonlyMap<string, string>, name: string, fallback: number): number {
  if (!flags.has(name)) return fallback;
  const value = required(flags, name);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`--${name} must be an integer`);
  return Number(value);
}
const readFile = (value: string, limit: number) => {
  const file = path.resolve(value); assertMathCanonicalPath(file);
  return readMathText(file, limit);
};

function prepare(flags: ReadonlyMap<string, string>, directory: string) {
  const buildManifestRef = path.resolve(required(flags, 'build-manifest'));
  readMathBuildManifest(buildManifestRef, root, path.join(root, 'out/main'));
  const codex = flags.get('codex') ?? process.env.DEEPSCIENTIST_MATH_CODEX_EXECUTABLE ?? 'codex';
  const coordination = flags.get('coordination') ?? 'cooperative';
  if (coordination !== 'cooperative' && coordination !== 'independent') throw new Error('--coordination must be cooperative or independent');
  const request = prepareAutoLibraryBuild(directory, root, {
    challengeId: required(flags, 'challenge-id'), challengeSource: readFile(required(flags, 'challenge-file'), LEAN_TASK_SOURCE_MAX_BYTES),
    task: flags.has('task-file') ? readFile(required(flags, 'task-file'), 64 * 1024).trim() : '',
    environment: flags.get('environment') ?? 'mathlib', pool: externalPath(required(flags, 'pool')), buildManifestRef,
    planner: { model: flags.get('model') ?? 'deepseek-flash', effort: flags.get('effort') ?? 'max', executable: codex,
      profile: path.resolve(flags.get('profile') ?? (process.env.CODEX_HOME || path.join(os.homedir(), '.config/deepscientist/math-sol-codex'))) },
    prover: { model: flags.get('prover-model') ?? flags.get('model') ?? 'deepseek-flash', effort: flags.get('prover-effort') ?? flags.get('effort') ?? 'max',
      executable: codex, workers: integerFlag(flags, 'workers', 4), coordination,
      maxRunSeconds: integerFlag(flags, 'prover-max-run-seconds', 3600), maxTurns: integerFlag(flags, 'prover-max-turns', 200),
      maxTurnSeconds: integerFlag(flags, 'prover-max-turn-seconds', 180), maxTotalTokens: integerFlag(flags, 'prover-max-total-tokens', 0),
      prepareTimeoutSeconds: integerFlag(flags, 'prepare-timeout-seconds', 1800) },
    maxModules: integerFlag(flags, 'max-modules', 1), maxRounds: integerFlag(flags, 'max-rounds', 3),
    maxRunSeconds: integerFlag(flags, 'max-run-seconds', 7200), maxTotalTokens: integerFlag(flags, 'max-total-tokens', 0),
    plannerTurnSeconds: integerFlag(flags, 'planner-turn-seconds', 1800),
    ...(flags.has('base-pack') ? { basePack: readLibraryPack(required(flags, 'base-pack')) } : {}),
    ...(flags.has('demand-file') ? { demand: readAutoLibraryDemand(required(flags, 'demand-file')) } : {}),
    ...(flags.has('definition-targets') ? { definitionTargets: flags.get('definition-targets')!.split(',').map(name => name.trim()) } : {}),
  });
  return { schema: 'theorem-os.auto-library-cli.v1', phase: 'prepare', directory, modelInvoked: false, buildId: request.buildId,
    challengeId: request.challengeId, environment: request.environment, pool: request.pool, basePackDigest: request.basePackDigest };
}

/** The destination pack of one challenge: the hand pack plus every installable pool module. */
function pack(flags: ReadonlyMap<string, string>) {
  const environment = getLeanTaskEnvironment((flags.get('environment') ?? 'mathlib') as LeanTaskEnvironment);
  const output = path.resolve(required(flags, 'output')); assertMathCanonicalPath(output);
  if (fs.existsSync(output)) throw new Error('--output exists; choose a new file');
  const workspace = flags.has('workspace') ? externalPath(required(flags, 'workspace')) : path.dirname(output);
  if (libraryHostConfigPath() && flags.has('base-pack')) throw new Error('library_host_sources_conflict');
  if (libraryHostConfigPath() && !flags.has('workspace')) throw new Error('--workspace is required for host-authorized Auto packs');
  const effective = libraryHostConfigPath() ? resolveAutoLibraryBase(required(flags, 'challenge-id'), environment.id, workspace) : undefined;
  const base = flags.has('base-pack') ? readLibraryPack(required(flags, 'base-pack')) : undefined;
  const source = readFile(required(flags, 'challenge-file'), LEAN_TASK_SOURCE_MAX_BYTES);
  const records = readAutoLibraryPool(externalPath(required(flags, 'pool')));
  const result = autoLibraryPackFor({ ...(effective ? { effective,
    authenticated: (record) => hostAutoEvidence('records', mathDigest(canonicalLibraryJson(record)), record, workspace) } : { base }),
    records, environmentDigest: environment.dependencyDigest, challengeSource: source });
  let libraryBinding;
  if (effective) {
    authorizeHostAutoTask({ parent: { taskId: required(flags, 'challenge-id') }, binding: effective.binding,
      target: autoLibraryHostTarget(environment.id), workspace, taskId: leanTaskId(source), pack: result.pack,
      provenance: records.filter(record => result.included.includes(record.name)).map(record => mathDigest(canonicalLibraryJson(record))) });
    libraryBinding = resolveHostLibrary({ taskId: leanTaskId(source) }, autoLibraryHostTarget(environment.id), workspace)!.binding;
    writeMathJsonDurable(output, { schema: 'theorem-os.auto-library-selection.v1', libraryBinding, pack: result.pack ?? null }, 0o400);
  } else if (result.pack) writeMathJsonDurable(output, result.pack, 0o400);
  return { schema: 'theorem-os.auto-library-cli.v1', phase: 'pack', modelInvoked: false, output: result.pack || effective ? output : null,
    ...(libraryBinding ? { libraryBinding, workspace } : {}),
    included: result.included, skipped: result.skipped, ...(result.pack ? { pack: summarizeLibraryPack(result.pack) } : {}) };
}

export async function autoLibrary(argv: string[]): Promise<number> {
  const flags = parseFlags(argv, ['phase', 'directory', 'pool', 'challenge-file', 'base-pack', 'environment', 'output', 'run',
    'delivery', 'live', 'workspace', ...prepareFlags]);
  if (flags.has('help')) {
    console.log('Usage: theorem-os auto-library --phase prepare|demand|run|inspect|pack|usage|replay [options]\n'
      + 'prepare (offline): --directory DIR --challenge-id ID --challenge-file Challenge.lean --pool DIR --build-manifest FILE\n'
      + '  [--task-file FILE] [--environment mathlib|standard|mathlib-4.8|openai-math] [--base-pack PACK.json] (the hand library after its exclusions)\n'
      + '  [--demand-file FILE] (a frozen source-bound gap from the demand phase)\n'
      + '  [--definition-targets Qualified.name,Other.name] (original definitions to solve)\n'
      + '  [--model deepseek-flash --effort max] (planner) [--prover-model M --prover-effort E] [--profile DIR] [--codex FILE]\n'
      + '  [--workers 4] [--coordination cooperative|independent] [--max-modules 1] [--max-rounds 3]\n'
      + '  [--max-run-seconds 7200] [--max-total-tokens 0] [--planner-turn-seconds 1800]\n'
      + '  [--prover-max-run-seconds 3600] [--prover-max-turns 200] [--prover-max-turn-seconds 180] [--prover-max-total-tokens 0]\n'
      + '  [--prepare-timeout-seconds 1800] (0 = unlimited for run, token and turn limits)\n'
      + 'demand (offline): --run RESULT.json|state.json --delivery ID --output NEW_FILE\n'
      + '  capture the selected current public gap and its typed lemma requests with their source identities.\n'
      + 'run --directory DIR: plan, check, prove, extract, recheck and publish modules; resumable. Calls the planner and solver models.\n'
      + 'inspect --directory DIR (offline): the saved build state.\n'
      + 'pack (offline): --pool DIR --challenge-file FILE --output PACK.json [--base-pack PACK.json] [--environment mathlib]\n'
      + '  the pack a challenge installs: the hand pack plus pool modules whose requirements and environment match.\n'
      + 'usage (offline): --pool DIR --run RESULT.json|state.json [--live true]\n'
      + '  report pool modules the run\'s solution imports; --live true also inspects current worker sources.\n'
      + 'replay --directory NEW_DIR (offline): preset planner and solver outputs checked with real Lean v4.33.0; no model calls.\n'
      + 'Host-configured Auto requires autoLibraryDirectory; pack also requires --challenge-id ID --workspace NEW_DIR.\n'
      + 'Pool modules must match the base binding and every visible source digest; legacy records cannot enter a configured build.');
    return 0;
  }
  const phase = required(flags, 'phase');
  const allowed: Record<string, readonly string[]> = { prepare: ['directory', ...prepareFlags], run: ['directory'], inspect: ['directory'],
    demand: ['run', 'delivery', 'output'],
    pack: ['pool', 'challenge-file', 'base-pack', 'environment', 'output', 'challenge-id', 'workspace'], usage: ['pool', 'run', 'live'], replay: ['directory'] };
  if (!Object.hasOwn(allowed, phase)) throw new Error('Unknown auto-library phase.');
  for (const name of flags.keys()) if (name !== 'phase' && !allowed[phase]!.includes(name)) throw new Error(`--${name} is not valid for --phase ${phase}`);
  let report: unknown, code = 0;
  if (phase === 'demand') {
    const run = path.resolve(required(flags, 'run'));
    const stateFile = run.endsWith('state.json') ? run : path.join(`${run}.runtime`, 'state.json');
    const demand = captureAutoLibraryDemand(readSolverRunState(stateFile), required(flags, 'delivery'));
    const output = externalPath(required(flags, 'output'));
    if (fs.existsSync(output)) throw new Error('auto_library_demand_output_exists');
    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
    writeMathJsonDurable(output, demand, 0o400);
    report = { schema: 'theorem-os.auto-library-cli.v1', phase, modelInvoked: false, output, demand };
  } else if (phase === 'prepare') report = prepare(flags, externalPath(required(flags, 'directory')));
  else if (phase === 'inspect') report = inspectAutoLibraryBuild(externalPath(required(flags, 'directory')));
  else if (phase === 'pack') report = pack(flags);
  else if (phase === 'usage') {
    const live = flags.get('live');
    if (live !== undefined && live !== 'true' && live !== 'false') throw new Error('--live must be true or false');
    const run = path.resolve(required(flags, 'run'));
    const stateFile = run.endsWith('state.json') ? run : path.join(`${run}.runtime`, 'state.json');
    const input = { records: readAutoLibraryPool(externalPath(required(flags, 'pool'))), stateFile };
    report = { schema: 'theorem-os.auto-library-cli.v1', phase, modelInvoked: false,
      ...(live === 'true' ? autoLibraryLiveUsage(input) : autoLibraryRunUsage(input)) };
  } else if (phase === 'replay') {
    const { replayAutoLibrary } = await import('./autoLibraryReplay');
    report = await replayAutoLibrary(externalPath(required(flags, 'directory')), root);
  } else {
    const directory = externalPath(required(flags, 'directory'));
    readAutoLibraryRequest(directory);
    const controller = new AbortController(), interrupt = () => controller.abort();
    process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
    try {
      const result = await runAutoLibraryBuild(directory, root, { signal: controller.signal,
        onEvent: event => console.error(JSON.stringify({ ...event, at: Date.now() })) });
      report = result; code = result.status === 'built' || result.status === 'none' ? 0 : 2;
    } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
  }
  console.log(JSON.stringify(report, null, 2));
  return code;
}

export { autoLibrary as main };

if (import.meta.main) autoLibrary(process.argv.slice(2)).then(code => { process.exitCode = code; }, cause => {
  console.error(errorText(cause)); process.exitCode = 1;
});
