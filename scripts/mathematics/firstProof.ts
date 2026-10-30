#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parseFlags, required } from './arguments';
import { FIRST_PROOF_BATCH, FIRST_PROOF_REPOSITORY_URL, FIRST_PROOF_SOURCE_COMMIT, FIRST_PROOF_AUTOMATIC_EVIDENCE_FILE,
  FIRST_PROOF_PROBLEM_IDS, bootstrapFirstProofProblem, firstProofFormalizationInputDigest,
  firstProofFormalizationManifestSchema, firstProofFormalizationTargets, readFirstProofCatalog,
  readFirstProofFormalization, importFirstProofFormalization, type FirstProofCatalog, type FirstProofProblem } from '../../src/math/firstProof';
import { getLeanTaskEnvironment } from '../../src/math/leanTaskEnvironment';
import { readLeanTaskReceipt } from '../../src/math/leanTask';
import { readMathBuildManifest } from '../../src/math/mathBuildManifest';
import { canonicalMathJson, mathDigest, readMathText, writeMathFrozen } from '../../src/math/mathRuntimeIo';
import { assertMathCanonicalPath, isMathPathWithin } from '../../src/math/paths';
import { readRunInspection } from '../../src/solver/inspection';
import { readSolverProblem } from '../../src/solver/problem';
import { proofReceiptsMatch, type ProofCheck } from '../../src/solver/modules/evidence';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const defaultSources = path.join(root, 'examples/first-proof/batch3');
const defaultFormalizations = path.join(root, 'examples/first-proof/formalizations');
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const problemIdSchema = z.string().refine(value => FIRST_PROOF_PROBLEM_IDS.includes(value));
const caseIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u);
const caseSchema = z.object({
  schema: z.literal('theorem-os.first-proof.case.v1'), dataset: z.literal('first-proof'),
  batch: z.literal(FIRST_PROOF_BATCH), official: z.literal(false),
  repositoryUrl: z.literal(FIRST_PROOF_REPOSITORY_URL), sourceCommit: z.literal(FIRST_PROOF_SOURCE_COMMIT),
  problemId: problemIdSchema, caseId: caseIdSchema, catalogDigest: hash,
  sourceRelativePath: z.string(), problemSourceSha256: hash, sourceGitBlobOid: z.string(),
  formalizationSourceSha256: hash, formalizationDigest: hash, formalizationInputDigest: hash, reviewDigest: hash,
  environment: z.enum(['standard', 'mathlib']), environmentDigest: hash,
  targets: firstProofFormalizationManifestSchema.shape.targets,
  workspaceRoot: z.string(), receiptFile: z.string(), receiptDigest: hash, baseCommit: z.string(),
  taskFile: z.string(), taskDigest: hash, resultFile: z.string(),
  buildManifestRef: z.string(), buildDigest: hash,
}).strict();
export type FirstProofCase = z.infer<typeof caseSchema>;
const json = (file: string) => JSON.parse(readMathText(file, 4_000_000));
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const frozenJson = (file: string, value: unknown) => writeMathFrozen(file, JSON.stringify(value, null, 2) + '\n');

function externalDirectory(directory: string, ...inputRoots: string[]): void {
  assertMathCanonicalPath(directory);
  if ([root, ...inputRoots].some(input => isMathPathWithin(input, directory) || isMathPathWithin(directory, input)))
    throw new Error('Keep First Proof case directories separate from source and formalization directories.');
}

export function firstProofInventory(catalog: FirstProofCatalog, formalizationsRoot: string) {
  const problems = catalog.problems.map(problem => {
    const { source: _source, ...identity } = problem;
    try {
      const formalization = readFirstProofFormalization(formalizationsRoot, problem);
      return { ...identity, status: formalization.status, ready: formalization.status === 'approved',
        ...('missingFiles' in formalization ? { missingFiles: formalization.missingFiles } : {
          formalizationSourceSha256: formalization.sourceSha256, formalizationDigest: formalization.digest,
          inputDigest: formalization.inputDigest, reviewDigest: formalization.manifest.reviewDigest ?? null,
          reviewAuthority: formalization.manifest.review?.authority ?? null,
          automaticEvidenceDigest: formalization.manifest.automation?.evidenceDigest ?? null,
          environment: formalization.manifest.environment, targets: formalization.manifest.targets,
        }) };
    } catch (cause) { return { ...identity, status: 'invalid', ready: false, error: errorText(cause) }; }
  });
  return { schema: 'theorem-os.first-proof.inventory.v1', batch: FIRST_PROOF_BATCH,
    repositoryUrl: catalog.repositoryUrl, sourceCommit: catalog.sourceCommit, catalogDigest: catalog.digest,
    protocol: 'reviewed-formalization-and-independent-lean', official: false, invokesModel: false,
    totalProblems: catalog.problems.length, approvedFormalizations: problems.filter(item => item.ready).length, problems };
}

/** Preserve the entire original, including macros and definitions; runSolver accepts tasks longer than bootstrap's short contract. */
export function firstProofTask(problem: FirstProofProblem, contract: string, targets: string[]): string {
  return `# First Proof Batch 3, problem ${problem.number}\n\n${contract}\n\n`
    + `Original benchmark ID: ${problem.id}\nTargets: ${targets.join(', ')}\n\n`
    + 'The Lean declarations and definitions were reviewed before this case was prepared. '
    + 'Prove every frozen target in generated/problem/Submission.lean. '
    + 'The original TeX below is complete and unchanged.\n\n~~~tex\n' + problem.source + '\n~~~\n';
}

function draftFormalization(flags: ReadonlyMap<string, string>, catalog: FirstProofCatalog, formalizationsRoot: string) {
  required(flags, 'formalizations-root');
  const problemId = problemIdSchema.parse(required(flags, 'problem'));
  const problem = catalog.problems.find(item => item.id === problemId)!;
  const sourceFile = path.resolve(required(flags, 'statement-file'));
  const notesFile = path.resolve(required(flags, 'notes-file'));
  assertMathCanonicalPath(sourceFile); assertMathCanonicalPath(notesFile);
  const source = readMathText(sourceFile, 128 * 1024);
  const notes = firstProofFormalizationManifestSchema.pick({ coverage: true, assumptions: true,
    assumptionsExplanation: true, definitionsExplanation: true }).parse(json(notesFile));
  const environment = z.enum(['standard', 'mathlib']).parse(flags.get('environment') ?? 'mathlib');
  const manifest = firstProofFormalizationManifestSchema.parse({
    schema: 'theorem-os.first-proof.formalization.v1', problemId, problemSourceSha256: problem.sourceSha256,
    sourceSha256: mathDigest(source), environment, environmentDigest: getLeanTaskEnvironment(environment).dependencyDigest,
    targets: firstProofFormalizationTargets(source), ...notes, status: 'unreviewed',
  });
  const directory = path.join(formalizationsRoot, problemId);
  assertMathCanonicalPath(directory);
  if (fs.existsSync(directory)) throw new Error('Formalization directory already exists; preserve its review history or choose a new root.');
  // Check source coverage before creating any output. This is a binding check, never a semantic review.
  const covered = new Set(notes.coverage.flatMap(item => item.targetNames));
  if (notes.coverage.some(item => !problem.source.includes(item.originalText) ||
      item.targetNames.some(name => !manifest.targets.some(target => target.name === name))) ||
      manifest.targets.some(target => !covered.has(target.name))) throw new Error('first_proof_formalization_coverage_invalid');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Drafts remain writable for an actual reviewer; this command cannot approve them.
  fs.writeFileSync(path.join(directory, 'Statement.lean'), source, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(directory, 'formalization.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { directory, problemId, status: 'unreviewed', inputDigest: firstProofFormalizationInputDigest(manifest),
    invokesModel: false, semanticApproval: false };
}

function prepareCase(flags: ReadonlyMap<string, string>, catalog: FirstProofCatalog, sourceRoot: string,
  formalizationsRoot: string, directory: string) {
  const problemId = problemIdSchema.parse(required(flags, 'problem'));
  const caseId = caseIdSchema.parse(flags.get('case') ?? 'attempt-01');
  const problem = catalog.problems.find(item => item.id === problemId)!;
  const formalization = readFirstProofFormalization(formalizationsRoot, problem);
  if (formalization.status === 'missing') throw new Error('first_proof_formalization_missing');
  if (formalization.status !== 'approved') throw new Error('first_proof_formalization_not_approved');
  const buildManifestRef = path.resolve(required(flags, 'build-manifest'));
  readMathBuildManifest(buildManifestRef, root, path.join(root, 'out/main'));
  const buildDigest = mathDigest(readMathText(buildManifestRef));
  const caseDirectory = path.join(directory, 'cases', problemId, caseId);
  assertMathCanonicalPath(caseDirectory);
  if (fs.existsSync(caseDirectory)) throw new Error('First Proof case already exists; use another --case label.');
  const manifestText = readMathText(path.join(formalization.directory, 'formalization.json'), 1024 * 1024);
  if (mathDigest(manifestText) !== formalization.digest) throw new Error('first_proof_formalization_changed');
  const snapshotRoot = path.join(caseDirectory, 'formalization');
  const snapshot = path.join(snapshotRoot, problemId);
  fs.mkdirSync(snapshot, { recursive: true, mode: 0o700 });
  writeMathFrozen(path.join(caseDirectory, 'official-source.tex'), problem.source);
  writeMathFrozen(path.join(snapshot, 'Statement.lean'), formalization.source);
  writeMathFrozen(path.join(snapshot, 'formalization.json'), manifestText);
  if (formalization.manifest.automation) {
    const evidence = readMathText(path.join(formalization.directory, FIRST_PROOF_AUTOMATIC_EVIDENCE_FILE), 16_000_000);
    if (mathDigest(evidence) !== formalization.manifest.automation.evidenceDigest) throw new Error('first_proof_formalization_changed');
    writeMathFrozen(path.join(snapshot, FIRST_PROOF_AUTOMATIC_EVIDENCE_FILE), evidence);
  }
  const receipt = bootstrapFirstProofProblem({ sourceRoot, formalizationsRoot: snapshotRoot, problemId,
    workspaceRoot: path.join(caseDirectory, 'workspace') });
  const taskFile = path.join(caseDirectory, 'task.md');
  const task = firstProofTask(problem, receipt.contract.informalStatement, formalization.theoremNames);
  writeMathFrozen(taskFile, task);
  const plan = caseSchema.parse({ schema: 'theorem-os.first-proof.case.v1', dataset: 'first-proof',
    batch: FIRST_PROOF_BATCH, official: false, repositoryUrl: catalog.repositoryUrl, sourceCommit: catalog.sourceCommit,
    problemId, caseId, catalogDigest: catalog.digest, sourceRelativePath: problem.sourceRelativePath,
    problemSourceSha256: problem.sourceSha256, sourceGitBlobOid: problem.gitBlobOid,
    formalizationSourceSha256: formalization.sourceSha256, formalizationDigest: formalization.digest,
    formalizationInputDigest: formalization.inputDigest, reviewDigest: formalization.manifest.reviewDigest,
    environment: formalization.manifest.environment, environmentDigest: formalization.manifest.environmentDigest,
    targets: formalization.manifest.targets, workspaceRoot: receipt.workspaceRoot, receiptFile: receipt.activeProblemPath,
    receiptDigest: mathDigest(canonicalMathJson(receipt)), baseCommit: receipt.baseCommit,
    taskFile, taskDigest: mathDigest(task), resultFile: path.join(caseDirectory, 'result.json'),
    buildManifestRef, buildDigest,
  });
  frozenJson(path.join(caseDirectory, 'case.json'), plan);
  const runArguments = ['--workspace', plan.workspaceRoot, '--receipt-file', plan.receiptFile,
    '--task-file', plan.taskFile, '--build-manifest', plan.buildManifestRef, '--output', plan.resultFile];
  return { caseFile: path.join(caseDirectory, 'case.json'), problemId, caseId, status: 'prepared',
    invokesModel: false, runArguments, note: 'Choose a model configuration and explicit budget before running.' };
}

function validateCase(caseDirectory: string, catalog: FirstProofCatalog, problem: FirstProofProblem, caseId: string) {
  const plan = caseSchema.parse(json(path.join(caseDirectory, 'case.json')));
  const formalization = readFirstProofFormalization(path.join(caseDirectory, 'formalization'), problem);
  if (formalization.status !== 'approved') throw new Error('first_proof_case_review_invalid');
  const receipt = readLeanTaskReceipt(path.join(caseDirectory, 'workspace/active-problem.json'));
  const expectedTask = firstProofTask(problem, receipt.contract.informalStatement, formalization.theoremNames);
  const reviewLabel = formalization.manifest.review!.authority === 'human' ? 'Human' : 'Model';
  if (plan.problemId !== problem.id || plan.caseId !== caseId || plan.catalogDigest !== catalog.digest ||
      plan.sourceRelativePath !== problem.sourceRelativePath || plan.sourceGitBlobOid !== problem.gitBlobOid ||
      plan.problemSourceSha256 !== problem.sourceSha256 || readMathText(path.join(caseDirectory, 'official-source.tex')) !== problem.source ||
      plan.formalizationDigest !== formalization.digest || plan.formalizationSourceSha256 !== formalization.sourceSha256 ||
      plan.formalizationInputDigest !== formalization.inputDigest || plan.reviewDigest !== formalization.manifest.reviewDigest ||
      plan.environment !== formalization.manifest.environment || plan.environmentDigest !== formalization.manifest.environmentDigest ||
      canonicalMathJson(plan.targets) !== canonicalMathJson(formalization.manifest.targets) ||
      plan.workspaceRoot !== path.join(caseDirectory, 'workspace') || plan.receiptFile !== receipt.activeProblemPath ||
      plan.receiptDigest !== mathDigest(canonicalMathJson(receipt)) || plan.baseCommit !== receipt.baseCommit ||
      receipt.environment !== plan.environment || receipt.environmentDigest !== plan.environmentDigest ||
      receipt.contract.formalStatement !== formalization.source || canonicalMathJson(receipt.publicObligations) !== canonicalMathJson(plan.targets) ||
      !receipt.contract.informalStatement.includes(`Original SHA256: ${problem.sourceSha256}\n`) ||
      !receipt.contract.informalStatement.includes(`Formalization input SHA256: ${formalization.inputDigest}\n`) ||
      !receipt.contract.informalStatement.includes(`${reviewLabel} review SHA256: ${plan.reviewDigest}\n`) ||
      plan.taskFile !== path.join(caseDirectory, 'task.md') || readMathText(plan.taskFile) !== expectedTask || plan.taskDigest !== mathDigest(expectedTask) ||
      plan.resultFile !== path.join(caseDirectory, 'result.json') || plan.buildDigest !== mathDigest(readMathText(plan.buildManifestRef)))
    throw new Error('first_proof_case_identity_mismatch');
  return plan;
}

/** Stored evidence is matched to every fixed target; this read-only report does not rerun Lean. */
function recordedPass(state: ReturnType<typeof readRunInspection>['state'], result?: Record<string, unknown>): boolean {
  const evaluator = result?.evaluator as { status?: string; method?: string; official?: boolean; verification?: ProofCheck } | undefined;
  return state.phase === 'finished' && result?.status === 'evaluated_passed' && result.completion_signal_valid === true &&
    result.solver_ready_receipt_valid === true && state.check?.passed === true && result.solution_commit === state.check.commit &&
    evaluator?.status === 'passed' && evaluator.method === 'host-lean-kernel-all-targets' && evaluator.official === false &&
    evaluator.verification?.passed === true && evaluator.verification.commit === state.check.commit &&
    evaluator.verification.sourceDigest === state.check.sourceDigest && state.problem.targets.length > 0 &&
    proofReceiptsMatch(evaluator.verification.verification, state.check.commit, state.problem.targets.map(target => ({
      proofPath: target.proofPath, theoremName: target.theoremName, expectedSourceDeclarationHash: target.declarationHash,
      statementHash: state.problem.contract.statementHash, leanStatementHash: state.problem.contract.leanStatementHash, claim: 'statement' })));
}

export function summarizeFirstProof(directory: string, catalog: FirstProofCatalog, formalizationsRoot: string) {
  const inventory = firstProofInventory(catalog, formalizationsRoot);
  const runs = catalog.problems.flatMap(problem => {
    const parent = path.join(directory, 'cases', problem.id);
    assertMathCanonicalPath(parent);
    if (!fs.existsSync(parent)) return [];
    return fs.readdirSync(parent).sort().map(caseId => {
      const caseDirectory = path.join(parent, caseId);
      let validCase = false;
      let observedStarted: boolean | null = null, observedAttempted: boolean | null = null;
      let observedFinished: boolean | undefined;
      try {
        caseIdSchema.parse(caseId); assertMathCanonicalPath(caseDirectory);
        const plan = validateCase(caseDirectory, catalog, problem, caseId);
        validCase = true;
        const resultExists = fs.existsSync(plan.resultFile), stateExists = fs.existsSync(`${plan.resultFile}.runtime/state.json`);
        if (!resultExists && !stateExists) return { problemId: problem.id, caseId, status: 'not_started',
          validCase: true, started: false, attempted: false, accepted: false };
        const { state, result } = readRunInspection(plan.resultFile);
        const expectedProblem = readSolverProblem(plan.workspaceRoot, plan.receiptFile);
        if (canonicalMathJson(state.problem) !== canonicalMathJson(expectedProblem) || state.taskDigest !== plan.taskDigest ||
            state.buildDigest !== plan.buildDigest || state.evaluatorDigest !== mathDigest('host-default') ||
            result && result.problemId !== expectedProblem.contract.problemId)
          throw new Error('first_proof_run_identity_mismatch');
        observedStarted = true; observedAttempted = state.turns > 0; observedFinished = state.phase === 'finished';
        const finished = state.phase === 'finished';
        if (finished && !result) throw new Error('first_proof_result_missing');
        if (finished && !['evaluated_passed', 'evaluated_failed', 'runtime_error', 'incomplete', 'limit_reached'].includes(String(result?.status)))
          throw new Error('first_proof_result_status_invalid');
        const attempted = state.turns > 0;
        const accepted = recordedPass(state, result);
        if (accepted && !attempted) throw new Error('first_proof_acceptance_without_attempt');
        if (result?.status === 'evaluated_passed' && !accepted) throw new Error('first_proof_acceptance_evidence_incomplete');
        return { problemId: problem.id, caseId, status: state.phase === 'finished' ? String(result?.status ?? 'missing_result') : state.phase,
          validCase: true, started: true, attempted, accepted, finished, runId: state.runId, turns: state.turns,
          resultFile: plan.resultFile, model: state.model, effort: state.effort, workers: state.workerCount ?? 1 };
      } catch (cause) { return { problemId: problem.id, caseId, status: 'invalid', validCase,
        started: observedStarted, attempted: observedAttempted, finished: observedFinished,
        accepted: false, error: errorText(cause) }; }
    });
  });
  const attempted = runs.filter(run => run.attempted === true), accepted = runs.filter(run => run.accepted);
  const attemptedIds = new Set(attempted.map(run => run.problemId)), acceptedIds = new Set(accepted.map(run => run.problemId));
  const invalid = runs.filter(run => run.status === 'invalid');
  const outcomesComplete = !invalid.length && attempted.every(run => run.finished);
  return { schema: 'theorem-os.first-proof.summary.v1', batch: FIRST_PROOF_BATCH, sourceCommit: catalog.sourceCommit,
    catalogDigest: catalog.digest, evidence: 'recorded-not-replayed', official: false, invokesModel: false,
    interpretation: 'Lean verification of reviewed formalizations with the recorded review authority; no First Proof official expert score.',
    totalProblems: catalog.problems.length, approvedFormalizations: inventory.approvedFormalizations,
    preparedCases: runs.filter(run => run.validCase).length, startedRuns: runs.filter(run => run.started === true).length,
    attemptedRuns: attempted.length, attemptedProblems: attemptedIds.size, acceptedRuns: accepted.length,
    solvedProblems: acceptedIds.size, invalidRecords: invalid.length,
    unknownAttemptRecords: runs.filter(run => run.attempted === null).length,
    attemptSuccessRate: attempted.length && outcomesComplete ? accepted.length / attempted.length : null,
    fullBatchSuccessRate: attemptedIds.size === catalog.problems.length && outcomesComplete ? acceptedIds.size / catalog.problems.length : null,
    problems: inventory.problems.map(problem => ({ ...problem,
      attempted: attemptedIds.has(problem.id), accepted: acceptedIds.has(problem.id) })), runs };
}

export async function firstProof(argv: string[]): Promise<number> {
  const flags = parseFlags(argv, ['phase', 'source-root', 'formalizations-root', 'problem', 'directory', 'case',
    'build-manifest', 'statement-file', 'notes-file', 'artifact', 'environment', 'output']);
  if (flags.has('help')) {
    console.log('Usage: theorem-os first-proof --phase catalog|draft|import|check|prepare|summarize [options]\n'
      + 'Every phase is offline and never calls a model. The fixed dataset is First Proof Batch 3 (10 problems).\n'
      + '--source-root DIR defaults to the bundled official statements; --formalizations-root DIR selects authored Lean material.\n'
      + 'catalog: inventory all ten, including missing and invalid formalizations.\n'
      + 'draft: --problem ID --statement-file FILE --notes-file JSON --formalizations-root DIR [--environment mathlib|standard]; creates UNREVIEWED material.\n'
      + 'import: --problem ID --artifact DIR --formalizations-root DIR; imports complete recorded model formalization evidence, offline.\n'
      + 'check: [--problem ID]; validates source, review, targets and environment bindings; exits 2 if any selected item is blocked.\n'
      + 'prepare: --problem ID --directory CAMPAIGN --build-manifest FILE [--case attempt-01]; requires a bound human approval or complete model review evidence.\n'
      + 'summarize: --directory CAMPAIGN; reads saved cases and S3 evidence, does not replay Lean.\n'
      + '--output FILE exclusively writes a new JSON report. Existing output files are never replaced.\n'
      + 'See examples/first-proof/README.md for review requirements and the separate real-Lean offline fixture.');
    return 0;
  }
  const phase = required(flags, 'phase');
  const phases: Record<string, string[]> = {
    catalog: [], draft: ['problem', 'statement-file', 'notes-file', 'environment'], import: ['problem', 'artifact'], check: ['problem'],
    prepare: ['problem', 'directory', 'case', 'build-manifest'], summarize: ['directory'],
  };
  if (!Object.hasOwn(phases, phase)) throw new Error('Unknown First Proof phase.');
  for (const key of flags.keys()) if (!['phase', 'source-root', 'formalizations-root', 'output', ...phases[phase]].includes(key))
    throw new Error(`--${key} is not valid for --phase ${phase}`);
  const output = flags.has('output') ? path.resolve(required(flags, 'output')) : undefined;
  if (output) {
    assertMathCanonicalPath(output);
    if (fs.existsSync(output)) throw new Error('Report output already exists; choose a new file.');
    if (!fs.statSync(path.dirname(output)).isDirectory()) throw new Error('Report output parent must be an existing directory.');
  }
  const sourceRoot = path.resolve(flags.get('source-root') ?? defaultSources);
  const formalizationsRoot = path.resolve(flags.get('formalizations-root') ?? defaultFormalizations);
  assertMathCanonicalPath(formalizationsRoot);
  const catalog = readFirstProofCatalog(sourceRoot);
  let report: unknown, code = 0;
  if (phase === 'catalog' || phase === 'check') {
    const inventory = firstProofInventory(catalog, formalizationsRoot);
    const selected = flags.has('problem') ? problemIdSchema.parse(required(flags, 'problem')) : undefined;
    report = { ...inventory, ...(selected ? { selectedProblem: selected } : {}) };
    if (phase === 'check' && inventory.problems.some(item => (!selected || selected === item.id) && !item.ready)) code = 2;
  } else if (phase === 'draft') report = draftFormalization(flags, catalog, formalizationsRoot);
  else if (phase === 'import') {
    required(flags, 'formalizations-root');
    const problemId = problemIdSchema.parse(required(flags, 'problem'));
    const imported = importFirstProofFormalization(path.resolve(required(flags, 'artifact')), formalizationsRoot,
      catalog.problems.find(problem => problem.id === problemId)!);
    if (imported.status === 'missing') throw new Error('first_proof_formalization_import_missing');
    report = { directory: imported.directory, problemId, status: imported.status,
      reviewAuthority: imported.manifest.review!.authority, inputDigest: imported.inputDigest,
      evidenceDigest: imported.manifest.automation!.evidenceDigest, invokesModel: false, proofVerified: false };
  }
  else {
    const directory = path.resolve(required(flags, 'directory'));
    externalDirectory(directory, sourceRoot, formalizationsRoot);
    report = phase === 'prepare' ? prepareCase(flags, catalog, sourceRoot, formalizationsRoot, directory)
      : summarizeFirstProof(directory, catalog, formalizationsRoot);
  }
  if (output) frozenJson(output, report);
  console.log(JSON.stringify(report, null, 2));
  return code;
}

if (import.meta.main) firstProof(process.argv.slice(2)).then(code => { process.exitCode = code; }, cause => {
  console.error(errorText(cause)); process.exitCode = 1;
});
