#!/usr/bin/env bun
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlags, required } from './arguments';
import { informalizationDigest, prepareInformalization, readInformalizationArtifact, readInformalizationRequest,
  type InformalizationRequest } from '../../src/math/informalization';
import { readMathBuildManifest } from '../../src/math/mathBuildManifest';
import { mathDigest, readMathText } from '../../src/math/mathRuntimeIo';
import { assertMathCanonicalPath, isMathPathWithin } from '../../src/math/paths';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const configurationFlags = ['proof-file', 'project-root', 'target', 'proof-id', 'environment', 'statement-file', 'language',
  'model', 'effort', 'profile', 'codex', 'auditors', 'max-rounds-per-batch', 'max-units-per-batch', 'max-batch-source-bytes',
  'max-run-seconds', 'max-turn-seconds', 'max-compile-seconds', 'max-total-tokens', 'build-manifest'] as const;

function externalDirectory(value: string): string {
  const directory = path.resolve(value);
  assertMathCanonicalPath(directory);
  if (isMathPathWithin(root, directory) || isMathPathWithin(directory, root))
    throw new Error('Keep informalization directories outside the source repository.');
  return directory;
}

function integerFlag(flags: ReadonlyMap<string, string>, name: string, fallback: number): number {
  if (!flags.has(name)) return fallback;
  const value = required(flags, name);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error(`--${name} must be an integer`);
  return Number(value);
}

function buildManifest(value: string): string {
  const file = path.resolve(value);
  readMathBuildManifest(file, root, path.join(root, 'out/main'));
  return file;
}

const requestSummary = (request: InformalizationRequest) => ({
  schema: request.schema, protocol: request.protocol, proofId: request.proofId, target: request.target,
  environment: request.environment, toolchain: request.toolchain, mathlibRevision: request.mathlibRevision,
  rootModule: request.rootModule, sources: request.sources.map(item => ({ origin: item.origin, sha256: item.sha256, bytes: item.bytes })),
  statementSha256: request.statementSha256, language: request.language, writer: request.writer,
  auditors: request.auditors, batching: request.batching, maxRoundsPerBatch: request.maxRoundsPerBatch,
  maxRunSeconds: request.maxRunSeconds, maxTurnSeconds: request.maxTurnSeconds, maxCompileSeconds: request.maxCompileSeconds,
  maxTotalTokens: request.maxTotalTokens, buildManifestRef: request.buildManifestRef, buildDigest: request.buildDigest });

function prepare(flags: ReadonlyMap<string, string>, directory: string) {
  if (fs.existsSync(directory)) throw new Error('informalization_directory_exists');
  const proofFile = path.resolve(required(flags, 'proof-file'));
  const target = required(flags, 'target');
  const environment = flags.get('environment') ?? 'mathlib';
  if (environment !== 'mathlib' && environment !== 'standard') throw new Error('--environment must be mathlib or standard');
  const language = flags.get('language') ?? 'zh';
  if (language !== 'zh' && language !== 'en') throw new Error('--language must be zh or en');
  let statement: string | null = null;
  if (flags.has('statement-file')) {
    const file = path.resolve(required(flags, 'statement-file')); assertMathCanonicalPath(file);
    statement = readMathText(file, 256 * 1024);
  }
  const writer = {
    model: flags.has('model') ? required(flags, 'model') : 'deepseek-flash',
    effort: flags.has('effort') ? required(flags, 'effort') : 'max',
    profile: path.resolve(flags.has('profile') ? required(flags, 'profile') :
      process.env.CODEX_HOME || path.join(os.homedir(), '.config/deepscientist/math-sol-codex')),
    executable: flags.has('codex') ? required(flags, 'codex') : process.env.DEEPSCIENTIST_MATH_CODEX_EXECUTABLE || 'codex' };
  const auditorCount = integerFlag(flags, 'auditors', 2);
  if (auditorCount < 1 || auditorCount > 5) throw new Error('--auditors must be between 1 and 5');
  const request = prepareInformalization(directory, {
    proofId: flags.get('proof-id') ?? target.replace(/[^A-Za-z0-9_-]+/gu, '_').slice(0, 128),
    proofFile, projectRoot: path.resolve(flags.get('project-root') ?? path.dirname(proofFile)),
    target, environment, statement, language, writer,
    auditors: Array.from({ length: auditorCount }, (_, index) => ({ ...writer, id: `auditor-${index + 1}` })),
    batching: { maxUnits: integerFlag(flags, 'max-units-per-batch', 12), maxSourceBytes: integerFlag(flags, 'max-batch-source-bytes', 60_000) },
    maxRoundsPerBatch: integerFlag(flags, 'max-rounds-per-batch', 6), maxRunSeconds: integerFlag(flags, 'max-run-seconds', 0),
    maxTurnSeconds: integerFlag(flags, 'max-turn-seconds', 0), maxCompileSeconds: integerFlag(flags, 'max-compile-seconds', 0),
    maxTotalTokens: integerFlag(flags, 'max-total-tokens', 0), buildManifestRef: buildManifest(required(flags, 'build-manifest')),
  });
  return { schema: 'theorem-os.informalization-cli.v1', phase: 'prepare', status: 'prepared', directory, modelInvoked: false,
    requestDigest: informalizationDigest(request), request: requestSummary(request) };
}
function inspect(directory: string) {
  const { request } = readInformalizationRequest(directory), requestDigest = informalizationDigest(request);
  const stateFile = path.join(directory, 'state.json');
  let state: Record<string, unknown> = { present: false };
  assertMathCanonicalPath(stateFile);
  if (fs.existsSync(stateFile)) {
    const stored: unknown = JSON.parse(readMathText(stateFile, 64_000_000));
    if (!stored || typeof stored !== 'object' || Array.isArray(stored) || (stored as Record<string, unknown>).requestDigest !== requestDigest)
      throw new Error('informalization_state_request_mismatch');
    const record = stored as Record<string, unknown>, batches = Array.isArray(record.batches) ? record.batches as Record<string, unknown>[] : [];
    state = { present: true, ...Object.fromEntries(['status', 'elapsedMs', 'error'].flatMap(key =>
      typeof record[key] === 'string' || typeof record[key] === 'number' ? [[key, record[key]]] : [])),
    batches: batches.map(batch => ({ index: batch.index, status: batch.status, rounds: batch.rounds,
      declarations: Array.isArray(batch.declarations) ? batch.declarations.length : 0 })),
    sessionCount: Array.isArray(record.sessions) ? record.sessions.length : 0 };
  }
  const artifactDirectory = path.join(directory, 'artifact');
  assertMathCanonicalPath(artifactDirectory);
  let artifact: Record<string, unknown> = { status: 'missing', valid: false };
  if (fs.existsSync(artifactDirectory)) {
    try {
      const evidence = readInformalizationArtifact(artifactDirectory);
      if (evidence.requestDigest !== requestDigest) throw new Error('informalization_artifact_request_mismatch');
      artifact = { status: 'approved', valid: true, directory: artifactDirectory, proof: path.join(artifactDirectory, 'proof.md'),
        authority: evidence.authority, humanReviewed: evidence.humanReviewed, proofCompiledByHost: evidence.proofCompiledByHost,
        target: evidence.target, axioms: evidence.outline.axioms, metrics: evidence.metrics,
        proofMarkdownSha256: evidence.proofMarkdownSha256 };
    } catch (cause) { artifact = { status: 'invalid', valid: false, error: errorText(cause) }; }
  }
  return { schema: 'theorem-os.informalization-cli.v1', phase: 'inspect', directory, modelInvoked: false,
    requestDigest, request: requestSummary(request), state, artifact };
}

export async function informalize(argv: string[]): Promise<number> {
  const flags = parseFlags(argv, ['phase', 'directory', ...configurationFlags]);
  if (flags.has('help')) {
    console.log('Usage: theorem-os informalize --phase prepare|run|inspect --directory DIR [options]\n'
      + 'prepare (offline): --proof-file FILE --target NAME --build-manifest FILE\n'
      + '  [--project-root DIR] (default: the proof file directory; its local imports are frozen too)\n'
      + '  [--proof-id ID] [--environment mathlib|standard] [--statement-file FILE] (writer vocabulary only; auditors never see it)\n'
      + '  [--language zh|en] [--model deepseek-flash] [--effort max] [--profile DIR] [--codex FILE] [--auditors 2]\n'
      + '  [--max-rounds-per-batch 6] [--max-units-per-batch 12] [--max-batch-source-bytes 60000]\n'
      + '  [--max-run-seconds 0] [--max-turn-seconds 0] [--max-compile-seconds 0] [--max-total-tokens 0] (0 = unlimited)\n'
      + 'run: compile the frozen proof in the pinned environment, extract its declarations, then write and audit the explanation batch by batch.\n'
      + 'inspect (offline): read a bounded summary and validate the approved artifact; never starts or resumes a run.\n'
      + 'The artifact is artifact/proof.md with artifact/informalization.json. The prose is model-written and model-audited, not human-reviewed.\n'
      + 'All directories must be outside the source repository. See docs/informalization.md.');
    return 0;
  }
  const phase = required(flags, 'phase');
  const phases: Record<string, readonly string[]> = { prepare: configurationFlags, run: [], inspect: [] };
  if (!Object.hasOwn(phases, phase)) throw new Error('Unknown informalization phase.');
  for (const name of flags.keys()) if (!['phase', 'directory', ...phases[phase]!].includes(name))
    throw new Error(`--${name} is not valid for --phase ${phase}`);
  const directory = externalDirectory(required(flags, 'directory'));
  let report: unknown, code = 0;
  if (phase === 'prepare') report = prepare(flags, directory);
  else if (phase === 'inspect') {
    const result = inspect(directory);
    report = result; if (result.artifact.status === 'invalid') code = 2;
  } else {
    const { request } = readInformalizationRequest(directory);
    const manifest = buildManifest(request.buildManifestRef);
    if (mathDigest(readMathText(manifest, 8_000_000)) !== request.buildDigest) throw new Error('informalization_build_changed');
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
    try {
      const { runInformalization } = await import('../../src/solver/informalization');
      const result = await runInformalization(directory, root, { signal: controller.signal });
      report = result; if (result.status !== 'approved') code = 2;
    } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
  }
  console.log(JSON.stringify(report, null, 2));
  return code;
}

export { informalize as main };

if (import.meta.main) informalize(process.argv.slice(2)).then(code => { process.exitCode = code; }, cause => {
  console.error(errorText(cause)); process.exitCode = 1;
});
