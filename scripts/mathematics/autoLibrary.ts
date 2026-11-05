#!/usr/bin/env bun
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlags, required } from './arguments';
import { autoLibraryPackFor, autoLibraryRunUsage, readAutoLibraryPool } from '../../src/math/autoLibrary';
import { getLeanTaskEnvironment, type LeanTaskEnvironment } from '../../src/math/leanTaskEnvironment';
import { readLibraryPack, summarizeLibraryPack } from '../../src/math/libraryPacks';
import { readMathBuildManifest } from '../../src/math/mathBuildManifest';
import { readMathText, writeMathJsonDurable } from '../../src/math/mathRuntimeIo';
import { assertMathCanonicalPath, isMathPathWithin } from '../../src/math/paths';
import { inspectAutoLibraryBuild, prepareAutoLibraryBuild, readAutoLibraryRequest, runAutoLibraryBuild } from '../../src/solver/autoLibrary';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const prepareFlags = ['challenge-file', 'task-file', 'challenge-id', 'environment', 'pool', 'base-pack', 'build-manifest',
  'model', 'effort', 'profile', 'codex', 'prover-model', 'prover-effort', 'workers', 'coordination', 'max-modules', 'max-rounds',
  'max-run-seconds', 'max-total-tokens', 'planner-turn-seconds', 'prover-max-run-seconds', 'prover-max-turns',
  'prover-max-turn-seconds', 'prover-max-total-tokens', 'prepare-timeout-seconds'] as const;

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
  const coordination = flags.get('coordination') ?? 'independent';
  if (coordination !== 'cooperative' && coordination !== 'independent') throw new Error('--coordination must be cooperative or independent');
  const request = prepareAutoLibraryBuild(directory, root, {
    challengeId: required(flags, 'challenge-id'), challengeSource: readFile(required(flags, 'challenge-file'), 1024 * 1024),
    task: flags.has('task-file') ? readFile(required(flags, 'task-file'), 64 * 1024).trim() : '',
    environment: flags.get('environment') ?? 'mathlib', pool: externalPath(required(flags, 'pool')), buildManifestRef,
    planner: { model: flags.get('model') ?? 'deepseek-flash', effort: flags.get('effort') ?? 'max', executable: codex,
      profile: path.resolve(flags.get('profile') ?? (process.env.CODEX_HOME || path.join(os.homedir(), '.config/deepscientist/math-sol-codex'))) },
    prover: { model: flags.get('prover-model') ?? flags.get('model') ?? 'deepseek-flash', effort: flags.get('prover-effort') ?? flags.get('effort') ?? 'max',
      executable: codex, workers: integerFlag(flags, 'workers', 1), coordination,
      maxRunSeconds: integerFlag(flags, 'prover-max-run-seconds', 3600), maxTurns: integerFlag(flags, 'prover-max-turns', 200),
      maxTurnSeconds: integerFlag(flags, 'prover-max-turn-seconds', 180), maxTotalTokens: integerFlag(flags, 'prover-max-total-tokens', 0),
      prepareTimeoutSeconds: integerFlag(flags, 'prepare-timeout-seconds', 1800) },
    maxModules: integerFlag(flags, 'max-modules', 1), maxRounds: integerFlag(flags, 'max-rounds', 3),
    maxRunSeconds: integerFlag(flags, 'max-run-seconds', 7200), maxTotalTokens: integerFlag(flags, 'max-total-tokens', 0),
    plannerTurnSeconds: integerFlag(flags, 'planner-turn-seconds', 1800),
    ...(flags.has('base-pack') ? { basePack: readLibraryPack(required(flags, 'base-pack')) } : {}),
  });
  return { schema: 'theorem-os.auto-library-cli.v1', phase: 'prepare', directory, modelInvoked: false, buildId: request.buildId,
    challengeId: request.challengeId, environment: request.environment, pool: request.pool, basePackDigest: request.basePackDigest };
}

/** The destination pack of one challenge: the hand pack plus every installable pool module. */
function pack(flags: ReadonlyMap<string, string>) {
  const environment = getLeanTaskEnvironment((flags.get('environment') ?? 'mathlib') as LeanTaskEnvironment);
  const base = flags.has('base-pack') ? readLibraryPack(required(flags, 'base-pack')) : undefined;
  const result = autoLibraryPackFor({ base, records: readAutoLibraryPool(externalPath(required(flags, 'pool'))),
    environmentDigest: environment.dependencyDigest, challengeSource: readFile(required(flags, 'challenge-file'), 1024 * 1024) });
  const output = path.resolve(required(flags, 'output')); assertMathCanonicalPath(output);
  if (fs.existsSync(output)) throw new Error('--output exists; choose a new file');
  if (result.pack) writeMathJsonDurable(output, result.pack, 0o400);
  return { schema: 'theorem-os.auto-library-cli.v1', phase: 'pack', modelInvoked: false, output: result.pack ? output : null,
    included: result.included, skipped: result.skipped, ...(result.pack ? { pack: summarizeLibraryPack(result.pack) } : {}) };
}

export async function autoLibrary(argv: string[]): Promise<number> {
  const flags = parseFlags(argv, ['phase', 'directory', 'pool', 'challenge-file', 'base-pack', 'environment', 'output', 'run', ...prepareFlags]);
  if (flags.has('help')) {
    console.log('Usage: theorem-os auto-library --phase prepare|run|inspect|pack|usage|replay [options]\n'
      + 'prepare (offline): --directory DIR --challenge-id ID --challenge-file Challenge.lean --pool DIR --build-manifest FILE\n'
      + '  [--task-file FILE] [--environment mathlib|standard] [--base-pack PACK.json] (the hand library after its exclusions)\n'
      + '  [--model deepseek-flash --effort max] (planner) [--prover-model M --prover-effort E] [--profile DIR] [--codex FILE]\n'
      + '  [--workers 1] [--coordination independent|cooperative] [--max-modules 1] [--max-rounds 3]\n'
      + '  [--max-run-seconds 7200] [--max-total-tokens 0] [--planner-turn-seconds 1800]\n'
      + '  [--prover-max-run-seconds 3600] [--prover-max-turns 200] [--prover-max-turn-seconds 180] [--prover-max-total-tokens 0]\n'
      + '  [--prepare-timeout-seconds 1800] (0 = unlimited for run, token and turn limits)\n'
      + 'run --directory DIR: plan, check, prove, extract, recheck and publish modules; resumable. Calls the planner and solver models.\n'
      + 'inspect --directory DIR (offline): the saved build state.\n'
      + 'pack (offline): --pool DIR --challenge-file FILE --output PACK.json [--base-pack PACK.json] [--environment mathlib]\n'
      + '  the pack a challenge installs: the hand pack plus pool modules whose requirements and environment match.\n'
      + 'usage (offline): --pool DIR --run RESULT.json|state.json: pool modules the run\'s solution imports, with trigger and cost.\n'
      + 'replay --directory NEW_DIR (offline): preset planner and solver outputs checked with real Lean v4.33.0; no model calls.\n'
      + 'Pool modules are not excluded per challenge; each record names the problem that triggered it and what it cost.');
    return 0;
  }
  const phase = required(flags, 'phase');
  const allowed: Record<string, readonly string[]> = { prepare: ['directory', ...prepareFlags], run: ['directory'], inspect: ['directory'],
    pack: ['pool', 'challenge-file', 'base-pack', 'environment', 'output'], usage: ['pool', 'run'], replay: ['directory'] };
  if (!Object.hasOwn(allowed, phase)) throw new Error('Unknown auto-library phase.');
  for (const name of flags.keys()) if (name !== 'phase' && !allowed[phase]!.includes(name)) throw new Error(`--${name} is not valid for --phase ${phase}`);
  let report: unknown, code = 0;
  if (phase === 'prepare') report = prepare(flags, externalPath(required(flags, 'directory')));
  else if (phase === 'inspect') report = inspectAutoLibraryBuild(externalPath(required(flags, 'directory')));
  else if (phase === 'pack') report = pack(flags);
  else if (phase === 'usage') {
    const run = path.resolve(required(flags, 'run'));
    const stateFile = run.endsWith('state.json') ? run : path.join(`${run}.runtime`, 'state.json');
    report = { schema: 'theorem-os.auto-library-cli.v1', phase, modelInvoked: false,
      ...autoLibraryRunUsage({ records: readAutoLibraryPool(externalPath(required(flags, 'pool'))), stateFile }) };
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
