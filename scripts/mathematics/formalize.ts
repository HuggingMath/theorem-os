#!/usr/bin/env bun
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlags, required } from './arguments';
import { withWorkflowHarness, workflowHarnessFlags } from './workflowHarness';
import { assertWorkflowSessionSupported } from '../../src/solver/workflowSession';
import { readFirstProofCatalog } from '../../src/math/firstProof';
import { formalizationDigest, prepareFormalization, readFormalizationArtifact,
  readFormalizationRequest, type FormalizationRequest } from '../../src/math/formalization';
import { readMathBuildManifest } from '../../src/math/mathBuildManifest';
import { mathDigest, readMathText } from '../../src/math/mathRuntimeIo';
import { assertMathCanonicalPath, isMathPathWithin } from '../../src/math/paths';
import { leanStatementContextProtocolSchema } from '../../src/math/leanStatementSemantic';
import { defaultFormalizationWorkflow, formalizationReviewConfigurationSchema } from '../../src/math/formalizationWorkflow';
import { formalizationReport } from '../../apps/web/formalizationReport';
import { writeStaticReport } from '../../apps/web/staticReport';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const configurationFlags = ['problem', 'task-file', 'first-proof-problem', 'source-root', 'build-manifest',
  'environment', 'model', 'effort', 'profile', 'codex', ...workflowHarnessFlags, 'max-rounds', 'max-run-seconds', 'max-turn-seconds',
  'max-compile-seconds', 'max-total-tokens', 'review-mode', 'review-config', 'max-planning-rounds',
  'reference-file', 'reference-pairs', 'reference-provenance', 'max-reference-seconds',
  'retrieval-workspace', 'retrieval-corpus', 'retrieval-symbols', 'retrieval-queries',
  'exemplar-corpus', 'exemplar-count', 'exemplar-exclude', 'context-protocol',
  'compatibility-names', 'compatibility-provenance'] as const;

function externalDirectory(value: string): string {
  const directory = path.resolve(value);
  assertMathCanonicalPath(directory);
  if (isMathPathWithin(root, directory) || isMathPathWithin(directory, root))
    throw new Error('Keep formalization directories outside the source repository.');
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

function requestSummary(request: FormalizationRequest) {
  return { schema: request.schema, problemId: request.problemId, statementSha256: request.statementSha256,
    statementBytes: Buffer.byteLength(request.statement, 'utf8'), environment: request.environment,
    environmentDigest: request.environmentDigest, execution: request.execution, model: request.model,
    effort: request.effort, profile: request.profile, executable: request.executable, ...(request.agentHarness ? { agentHarness: request.agentHarness } : {}),
    buildManifestRef: request.buildManifestRef, buildDigest: request.buildDigest,
    maxRounds: request.maxRounds, maxRunSeconds: request.maxRunSeconds, maxTurnSeconds: request.maxTurnSeconds,
    maxCompileSeconds: request.maxCompileSeconds, maxTotalTokens: request.maxTotalTokens,
    ...(request.contextProtocol ? { contextProtocol: request.contextProtocol } : {}),
    ...(request.reviewMode ? { reviewMode: request.reviewMode } : {}),
    ...(request.fidelityPolicy ? { fidelityPolicy: request.fidelityPolicy } : {}),
    ...(request.retrieval ? { retrieval: request.retrieval } : {}),
    ...(request.exemplars ? { exemplars: { algorithm: request.exemplars.algorithm, corpusSha256: request.exemplars.corpusSha256,
      corpusSize: request.exemplars.corpusSize, excludedIds: request.exemplars.excludedIds,
      items: request.exemplars.items.map(item => ({ id: item.id, score: item.score })) } } : {}),
    ...(request.compatibility ? { compatibility: request.compatibility } : {}),
    ...(request.workflow ? { workflow: { ...request.workflow,
      ...(request.workflow.reference ? { reference: { sourceSha256: request.workflow.reference.sourceSha256,
        pairs: request.workflow.reference.pairs, provenance: request.workflow.reference.provenance,
        maxSeconds: request.workflow.reference.maxSeconds } } : {}) } } : {}) };
}

function prepare(flags: ReadonlyMap<string, string>, directory: string) {
  if (fs.existsSync(directory)) throw new Error('formalization_directory_exists');
  let problemId: string, statement: string;
  if (flags.has('first-proof-problem')) {
    if (flags.has('problem') || flags.has('task-file'))
      throw new Error('--first-proof-problem is mutually exclusive with --problem and --task-file');
    const sourceRoot = path.resolve(flags.has('source-root') ? required(flags, 'source-root') : path.join(root, 'examples/first-proof/batch3'));
    const catalog = readFirstProofCatalog(sourceRoot);
    problemId = required(flags, 'first-proof-problem');
    const problem = catalog.problems.find(item => item.id === problemId);
    if (!problem) throw new Error('Unknown First Proof problem ID.');
    statement = problem.source;
  } else {
    if (flags.has('source-root')) throw new Error('--source-root requires --first-proof-problem');
    problemId = required(flags, 'problem');
    const taskFile = path.resolve(required(flags, 'task-file'));
    assertMathCanonicalPath(taskFile);
    statement = readMathText(taskFile, 256 * 1024);
  }
  const environment = flags.get('environment') ?? 'mathlib';
  if (environment !== 'mathlib' && environment !== 'standard') throw new Error('--environment must be mathlib or standard');
  if (flags.has('retrieval-workspace') !== flags.has('retrieval-corpus'))
    throw new Error('--retrieval-workspace and --retrieval-corpus are required together');
  if (flags.has('retrieval-symbols') && !flags.has('retrieval-workspace'))
    throw new Error('--retrieval-symbols requires --retrieval-workspace and --retrieval-corpus');
  if (flags.has('retrieval-queries') && !flags.has('retrieval-symbols'))
    throw new Error('--retrieval-queries requires --retrieval-symbols lean-exact-names-v1');
  const symbolProtocol = flags.has('retrieval-symbols') ? required(flags, 'retrieval-symbols') : undefined;
  if (symbolProtocol !== undefined && symbolProtocol !== 'lean-exact-names-v1')
    throw new Error('--retrieval-symbols must be lean-exact-names-v1');
  const queryProtocol = flags.has('retrieval-queries') ? required(flags, 'retrieval-queries') : undefined;
  if (queryProtocol !== undefined && queryProtocol !== 'lean-resolved-objects-v1')
    throw new Error('--retrieval-queries must be lean-resolved-objects-v1');
  const retrieval = flags.has('retrieval-workspace') ? {
    workspace: path.resolve(required(flags, 'retrieval-workspace')), corpusFile: path.resolve(required(flags, 'retrieval-corpus')),
    ...(symbolProtocol ? { symbolProtocol: 'lean-exact-names-v1' as const } : {}),
    ...(queryProtocol ? { queryProtocol: 'lean-resolved-objects-v1' as const } : {}) } : undefined;
  if (!flags.has('exemplar-corpus') && (flags.has('exemplar-count') || flags.has('exemplar-exclude')))
    throw new Error('--exemplar-count and --exemplar-exclude require --exemplar-corpus');
  const contextProtocol = flags.has('context-protocol') ?
    leanStatementContextProtocolSchema.parse(required(flags, 'context-protocol')) : undefined;
  const exemplars = flags.has('exemplar-corpus') ? { corpusFile: path.resolve(required(flags, 'exemplar-corpus')),
    count: integerFlag(flags, 'exemplar-count', 8),
    excludeIds: flags.has('exemplar-exclude') ? required(flags, 'exemplar-exclude').split(',').filter(Boolean) : [] } : undefined;
  if (flags.has('compatibility-names') !== flags.has('compatibility-provenance'))
    throw new Error('--compatibility-names and --compatibility-provenance are required together');
  const compatibility = flags.has('compatibility-names') ? { namesFile: path.resolve(required(flags, 'compatibility-names')),
    provenance: required(flags, 'compatibility-provenance') } : undefined;
  const author = withWorkflowHarness(flags, {
    model: flags.has('model') ? required(flags, 'model') : 'deepseek-flash',
    effort: flags.has('effort') ? required(flags, 'effort') : 'high',
    profile: path.resolve(flags.has('profile') ? required(flags, 'profile') :
      process.env.CODEX_HOME || path.join(os.homedir(), '.config/deepscientist/math-sol-codex')),
    executable: flags.has('codex') ? required(flags, 'codex') : process.env.DEEPSCIENTIST_MATH_CODEX_EXECUTABLE || 'codex' }, { environment });
  const reviewOptions = ['review-config', 'max-planning-rounds', 'reference-file', 'retrieval-workspace', 'exemplar-corpus', 'first-proof-problem'];
  const reviewMode = flags.get('review-mode') ?? (reviewOptions.some(name => flags.has(name)) ? 'independent' : 'direct');
  if (reviewMode !== 'direct' && reviewMode !== 'independent') throw new Error('--review-mode must be direct or independent');
  if (reviewMode === 'direct' && reviewOptions.some(name => flags.has(name)))
    throw new Error('Planning, review, retrieval and First Proof options require --review-mode independent');
  const workflow = defaultFormalizationWorkflow(author);
  workflow.reviewScheduling = 'parallel';
  workflow.maxPlanningRounds = integerFlag(flags, 'max-planning-rounds', 0);
  if (flags.has('review-config')) {
    const file = path.resolve(required(flags, 'review-config')); assertMathCanonicalPath(file);
    const config = formalizationReviewConfigurationSchema.parse(JSON.parse(readMathText(file, 256 * 1024)));
    for (const role of [config.planner, config.backtranslator, ...config.reviewers]) {
      role.profile = path.resolve(role.profile); assertWorkflowSessionSupported(role, { environment });
    }
    Object.assign(workflow, config);
  }
  if (flags.has('reference-file') !== flags.has('reference-pairs'))
    throw new Error('--reference-file and --reference-pairs are required together');
  if (flags.has('reference-file')) {
    const file = path.resolve(required(flags, 'reference-file')), pairsFile = path.resolve(required(flags, 'reference-pairs'));
    assertMathCanonicalPath(file); assertMathCanonicalPath(pairsFile);
    const source = readMathText(file, 128 * 1024);
    workflow.reference = { source, sourceSha256: mathDigest(source), pairs: JSON.parse(readMathText(pairsFile, 64 * 1024)),
      provenance: required(flags, 'reference-provenance'),
      maxSeconds: integerFlag(flags, 'max-reference-seconds', 0) };
  } else {
    if (flags.has('max-reference-seconds')) throw new Error('--max-reference-seconds requires --reference-file');
    if (flags.has('reference-provenance')) throw new Error('--reference-provenance requires --reference-file');
  }
  const request = prepareFormalization(directory, { problemId, statement, environment, execution: 'model', ...author,
    ...(reviewMode === 'direct' ? { reviewMode: 'direct' as const } : { workflow, fidelityPolicy: 'task-preserving-v2' as const }),
    ...(retrieval ? { retrieval } : {}),
    ...(exemplars ? { exemplars } : {}),
    ...(contextProtocol ? { contextProtocol } : {}),
    ...(compatibility ? { compatibility } : {}),
    buildManifestRef: buildManifest(required(flags, 'build-manifest')),
    maxRounds: integerFlag(flags, 'max-rounds', 0), maxRunSeconds: integerFlag(flags, 'max-run-seconds', 0),
    maxTurnSeconds: integerFlag(flags, 'max-turn-seconds', 0), maxCompileSeconds: integerFlag(flags, 'max-compile-seconds', 0),
    maxTotalTokens: integerFlag(flags, 'max-total-tokens', 0) });
  return { schema: 'theorem-os.formalization-cli.v1', phase: 'prepare', status: 'prepared', directory,
    modelInvoked: false, proofVerified: false, requestDigest: formalizationDigest(request), request: requestSummary(request) };
}

function inspect(directory: string) {
  const request = readFormalizationRequest(directory), requestDigest = formalizationDigest(request);
  const stateFile = path.join(directory, 'state.json');
  let state: Record<string, unknown> = { present: false };
  assertMathCanonicalPath(stateFile);
  if (fs.existsSync(stateFile)) {
    const stored: unknown = JSON.parse(readMathText(stateFile, 4_000_000));
    if (!stored || typeof stored !== 'object' || Array.isArray(stored) ||
        (stored as Record<string, unknown>).requestDigest !== requestDigest)
      throw new Error('formalization_state_request_mismatch');
    const record = stored as Record<string, unknown>;
    state = { present: true, ...Object.fromEntries(['status', 'rounds', 'elapsedMs', 'error', 'unsupportedTaskKind'].flatMap(key =>
      typeof record[key] === 'string' || typeof record[key] === 'number' ? [[key, record[key]]] : [])),
    sessionCount: Array.isArray(record.sessions) ? record.sessions.length : 0 };
  }
  const artifactDirectory = path.join(directory, 'artifact');
  assertMathCanonicalPath(artifactDirectory);
  let artifact: Record<string, unknown> = { status: 'missing', valid: false };
  if (fs.existsSync(artifactDirectory)) {
    try {
      const evidence = readFormalizationArtifact(artifactDirectory);
      if (evidence.requestDigest !== requestDigest) throw new Error('formalization_artifact_request_mismatch');
      artifact = { status: 'approved', valid: true, directory: artifactDirectory, authority: evidence.authority,
        execution: evidence.execution, modelInvoked: evidence.modelInvoked, proofVerified: evidence.proofVerified,
        sourceSha256: evidence.sourceSha256, snapshotDigest: evidence.snapshotDigest,
        targets: evidence.targets.map(item => item.name), approvedAt: evidence.approvedAt,
        ...(evidence.workflow ? { reviewAgreement: evidence.workflow.reviewAgreement,
          distinctModelConfigurations: evidence.workflow.distinctModelConfigurations,
          reviewers: evidence.workflow.reviews.map(item => item.reviewerId),
          profileDigest: evidence.workflow.profileDigest,
          referenceStatus: evidence.workflow.reference?.status ?? 'not-requested',
          planDigest: evidence.workflow.plan.digest, selectedCandidateRound: evidence.round } : {}) };
      if (evidence.generation.input.retrieval) {
        const retrieval = evidence.generation.input.retrieval;
        artifact.retrieval = { corpusSha256: retrieval.corpusSha256, algorithm: retrieval.algorithm,
          queries: retrieval.queries.length, hints: retrieval.hints.length,
          ...(retrieval.schema !== 'theorem-os.formalization-retrieval.v1' ? {
            librarySymbols: { queried: retrieval.librarySymbols.symbols.length,
              found: retrieval.librarySymbols.symbols.filter(symbol => symbol.exists).length,
              missing: retrieval.librarySymbols.symbols.filter(symbol => !symbol.exists).length } } : {}),
          ...(retrieval.schema === 'theorem-os.formalization-retrieval.v3' ? {
            omittedObjectQueries: retrieval.omittedObjectQueries.length } : {}) };
      }
    } catch (cause) { artifact = { status: 'invalid', valid: false, error: errorText(cause) }; }
  }
  return { schema: 'theorem-os.formalization-cli.v1', phase: 'inspect', directory,
    modelInvoked: false, requestDigest, request: requestSummary(request), state, artifact };
}

/** The approved statement beside the original problem and its reviews, as one offline HTML page. */
function writeReport(directory: string, output: string) {
  const request = readFormalizationRequest(directory), requestDigest = formalizationDigest(request);
  const artifactDirectory = path.join(directory, 'artifact');
  assertMathCanonicalPath(artifactDirectory);
  if (!fs.existsSync(artifactDirectory)) throw new Error('formalization_artifact_missing');
  const evidence = readFormalizationArtifact(artifactDirectory);
  if (evidence.requestDigest !== requestDigest) throw new Error('formalization_artifact_request_mismatch');
  const data = formalizationReport(evidence), file = writeStaticReport(root, output, { page: 'formalization', data });
  return { schema: 'theorem-os.formalization-cli.v1', phase: 'report', directory, modelInvoked: false, requestDigest,
    output: file, bytes: fs.statSync(file).size, targets: data.targets.map(item => item.name),
    correspondences: data.correspondences.length,
    locatedCorrespondences: data.correspondences.filter(item => item.lean.length).length };
}

export async function formalize(argv: string[]): Promise<number> {
  const flags = parseFlags(argv, ['phase', 'directory', 'output', ...configurationFlags]);
  if (flags.has('help')) {
    console.log('Usage: theorem-os formalize --phase prepare|run|inspect|replay|report --directory DIR [options]\n'
      + 'prepare (offline): --problem ID --task-file FILE --build-manifest FILE\n'
      + '  or --first-proof-problem first_proof_batch3_01 [--source-root DIR] --build-manifest FILE\n'
      + '  [--environment mathlib|standard] [--model deepseek-flash] [--effort high] [--profile DIR] [--codex FILE] [--harness codex|claude-code|opencode|cli --harness-profile DIR --harness-executable FILE]\n'
      + '  [--max-rounds 0] [--max-run-seconds 0] [--max-turn-seconds 0] [--max-compile-seconds 0] [--max-total-tokens 0]\n'
      + '  [--review-mode direct|independent] (default: direct generation and Lean compilation, without model review)\n'
      + '  [--review-config FILE] [--max-planning-rounds 0] (opt in to independent planning, backtranslation and review)\n'
      + '  [--retrieval-workspace DIR --retrieval-corpus FILE] (offline opt-in: frozen matching Mathlib declarations for generation)\n'
      + '  [--retrieval-symbols lean-exact-names-v1] (with retrieval: query exact Lean types and direct structure fields)\n'
      + '  [--retrieval-queries lean-resolved-objects-v1] (with symbols: search resolved object names and all explicit plan mappings)\n'
      + '  [--context-protocol kernel-v2|kernel-v3] (kernel-v3 records imported-library overflow instead of failing the round)\n'
      + '  [--exemplar-corpus FILE] [--exemplar-count 8] [--exemplar-exclude ID,...] (frozen nearest NL/Lean pairs for planning and generation)\n'
      + '  [--compatibility-names FILE --compatibility-provenance TEXT] (frozen declaration list of an older evaluation library; written names it lacks are compile feedback)\n'
      + '  Execution limits default to 0 (unlimited); a positive safe integer sets an explicit limit.\n'
      + '  [--reference-file FILE --reference-pairs FILE --reference-provenance TEXT] [--max-reference-seconds 0]\n'
      + 'run: use the frozen request; starts or resumes generation and Lean elaboration, plus review only when configured.\n'
      + 'inspect (offline): read a bounded summary and validate the approved artifact; never starts or resumes a run.\n'
      + 'replay (no model): --build-manifest FILE; new directory only, preset tutorial candidate checked by real Lean.\n'
      + 'report (offline): --output FILE.html; the approved statement beside the original problem and what its reviewers matched,\n'
      + '  as one self-contained page (needs bun run build:web).\n'
      + 'All directories must be outside the source repository. Existing requests are never overwritten.\n'
      + 'Direct requests produce compiler-checked v4 artifacts marked semanticReview=not-performed. Legacy reviewed requests remain readable.\n'
      + 'New requests freeze kernel-v3 complete local semantics with bounded imported-library expansion; saved requests retain their context protocol.\n'
      + 'Independent mode retains task-preserving fidelity checks and parallel reviewers; review/retrieval/First Proof options select it explicitly.\n'
      + 'Statement compilation is distinct from semantic review and proof acceptance. See docs/formalization.md.');
    return 0;
  }
  const phase = required(flags, 'phase');
  const phases: Record<string, readonly string[]> = { prepare: configurationFlags, run: [], inspect: [], replay: ['build-manifest'],
    report: ['output'] };
  if (!Object.hasOwn(phases, phase)) throw new Error('Unknown formalization phase.');
  for (const name of flags.keys()) if (!['phase', 'directory', ...phases[phase]!].includes(name))
    throw new Error(`--${name} is not valid for --phase ${phase}`);
  const directory = externalDirectory(required(flags, 'directory'));
  let report: unknown, code = 0;
  if (phase === 'prepare') report = prepare(flags, directory);
  else if (phase === 'report') report = writeReport(directory, required(flags, 'output'));
  else if (phase === 'inspect') {
    const result = inspect(directory);
    report = result; if (result.artifact.status === 'invalid') code = 2;
  } else if (phase === 'replay') {
    if (fs.existsSync(directory)) throw new Error('formalization_directory_exists');
    const manifest = buildManifest(required(flags, 'build-manifest'));
    const { replayFormalization } = await import('../../src/solver/formalization');
    report = await replayFormalization(directory, root, manifest);
    if ((report as { status: string }).status !== 'approved') code = 2;
  } else {
    const request = readFormalizationRequest(directory);
    if (request.execution !== 'model') throw new Error('formalization_run_requires_model_request');
    const manifest = buildManifest(request.buildManifestRef);
    if (mathDigest(readMathText(manifest, 8_000_000)) !== request.buildDigest)
      throw new Error('formalization_build_changed');
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
    try {
      const { runFormalization } = await import('../../src/solver/formalization');
      const result = await runFormalization(directory, root, { signal: controller.signal });
      report = result; if (result.status !== 'approved') code = 2;
    } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
  }
  console.log(JSON.stringify(report, null, 2));
  return code;
}

export { formalize as main };

if (import.meta.main) formalize(process.argv.slice(2)).then(code => { process.exitCode = code; }, cause => {
  console.error(errorText(cause)); process.exitCode = 1;
});
