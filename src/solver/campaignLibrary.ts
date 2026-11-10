import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { bootstrapLeanTask, readLeanTaskReceipt } from '../math/leanTask';
import { getLeanTaskEnvironment } from '../math/leanTaskEnvironment';
import { LIBRARY_PACK_SCHEMA, readLibraryPack, type LibraryPack, type LibraryPackModule } from '../math/libraryPacks';
import { canonicalMathJson, mathDigest, readMathText, withMathRuntimeLease, writeMathFrozen, writeMathJsonDurable } from '../math/mathRuntimeIo';
import { assertMathCanonicalPath, isMathPathWithin } from '../math/paths';
import { readSolverRunState } from './archive';
import { requestedLibraryPack, type LibraryAccess } from './libraryAccess';
import { readLibraryCatalog, writeLibraryCatalog } from './libraryCatalog';
import { committedSource, readSolverProblem } from './problem';

const hash = z.string().regex(/^[a-f0-9]{64}$/u), commit = z.string().regex(/^[a-f0-9]{40,64}$/u);
const releaseSchema = z.object({ schema: z.literal('theorem-os.library-release.v1'),
  repository: z.string().min(1), commit, toolchain: z.string().min(1), mathlib: z.string().optional(),
  modules: z.array(z.object({ file: z.string(), sha256: hash }).passthrough()).min(1),
}).passthrough();
const readJson = (file: string, maxBytes = 32_000_000) => JSON.parse(readMathText(file, maxBytes));
const same = (left: unknown, right: unknown) => canonicalMathJson(left) === canonicalMathJson(right);
function claim(directory: string, filename: string, identity: unknown) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); assertMathCanonicalPath(directory);
  const file = path.join(directory, filename), text = JSON.stringify(identity, null, 2) + '\n';
  if (fs.existsSync(file)) {
    if (!same(readJson(file), identity)) throw new Error('math_campaign_library_preparation_input_changed');
  } else {
    if (fs.readdirSync(directory).length) throw new Error('math_campaign_library_unclaimed_destination');
    writeMathJsonDurable(file, identity, 0o400);
  }
  return text;
}

/** A campaign catalog is a pinned release for the actual task environment, never a renamed incompatible catalog. */
export function prepareCampaignLibraryCatalog(input: { workspace: string; releaseDirectories: readonly string[]; directory: string }) {
  const workspace = path.resolve(input.workspace), directory = path.resolve(input.directory);
  assertMathCanonicalPath(workspace); assertMathCanonicalPath(directory);
  if (!input.releaseDirectories.length) throw new Error('math_campaign_library_release_missing');
  const receipt = readLeanTaskReceipt(path.join(workspace, 'active-problem.json'));
  const problem = readSolverProblem(workspace, receipt.activeProblemPath);
  const environment = getLeanTaskEnvironment(receipt.environment ?? 'standard');
  const modules = new Map<string, LibraryPackModule>(), packs: LibraryPack[] = [];
  const releases = input.releaseDirectories.map(value => {
    const root = path.resolve(value); assertMathCanonicalPath(root);
    const metadataFile = path.join(root, 'library.json'), packFile = path.join(root, 'pack.json');
    const metadataText = readMathText(metadataFile, 16_000_000), release = releaseSchema.parse(JSON.parse(metadataText));
    const pack = readLibraryPack(packFile);
    if (pack.requires?.length) throw new Error('math_library_catalog_external_requirement');
    if (release.toolchain !== environment.toolchain || (release.mathlib ?? null) !== (environment.mathlibRevision ?? null))
      throw new Error('math_campaign_library_release_environment_changed');
    if (new Set(release.modules.map(module => module.file)).size !== release.modules.length ||
        release.modules.length !== pack.modules.length || pack.modules.some(module =>
          release.modules.find(item => item.file === module.file)?.sha256 !== mathDigest(module.source) ||
          module.origin.kind !== 'upstream' || module.origin.repository !== release.repository || module.origin.commit !== release.commit))
      throw new Error('math_campaign_library_release_content_changed');
    for (const module of pack.modules) {
      const previous = modules.get(module.file);
      if (previous && previous.source !== module.source) throw new Error(`math_campaign_library_release_conflict: ${module.file}`);
      modules.set(module.file, previous ?? module);
    }
    packs.push({ schema: LIBRARY_PACK_SCHEMA, modules: pack.modules.map(module => modules.get(module.file)!) });
    return { directory: root, manifestDigest: mathDigest(metadataText), packDigest: mathDigest(canonicalMathJson(pack)), commit: release.commit };
  });
  // Existing modules remain immutable across an installation. A release may add interfaces, not replace the run's inputs.
  const retained: LibraryPackModule[] = [];
  for (const [file, digest] of Object.entries(problem.frozenFiles ?? {})) {
    const source = committedSource(workspace, problem.baseCommit, `${problem.projectRelative}/${file}`);
    if (mathDigest(source) !== digest) throw new Error('math_library_request_existing_module_changed');
    const released = modules.get(file);
    const module = released?.source === source ? released : { file, source,
      origin: { kind: 'upstream' as const, repository: workspace, commit: problem.baseCommit, file: `${problem.projectRelative}/${file}` } };
    modules.set(file, module); retained.push(module);
  }
  const identity = { schema: 'theorem-os.campaign-library-catalog.v1', problemReceiptDigest: problem.receiptDigest,
    environmentDigest: environment.dependencyDigest, releases,
    modules: [...modules.values()].sort((a, b) => a.file.localeCompare(b.file)).map(module => [module.file, mathDigest(module.source)]) };
  const inputDigest = mathDigest(canonicalMathJson(identity)), releaseDirectory = path.join(directory, 'release');
  const file = path.join(releaseDirectory, 'catalog.json');
  const receiptFile = path.join(directory, 'campaign-catalog.json');
  claim(directory, 'catalog-input.json', { inputDigest, identity });
  if (fs.existsSync(receiptFile)) {
    const previous = readJson(receiptFile);
    if (previous.schema !== identity.schema || previous.inputDigest !== inputDigest || !same(previous.identity, identity) ||
        previous.file !== file || !hash.safeParse(previous.digest).success ||
        previous.environment !== environment.id || previous.environmentDigest !== environment.dependencyDigest ||
        previous.toolchain !== environment.toolchain || previous.proofAcceptance !== 'not-assessed')
      throw new Error('math_campaign_library_catalog_input_changed');
    const catalog = readLibraryCatalog(file, previous.digest);
    if (previous.id !== 'theorem-os/campaign' || catalog.identity.id !== previous.id ||
        previous.revision !== inputDigest || catalog.identity.revision !== inputDigest ||
        previous.modules !== catalog.moduleCount || previous.declarations !== catalog.declarationCount || catalog.moduleCount !== modules.size)
      throw new Error('math_campaign_library_catalog_input_changed');
    for (const name of catalog.moduleFiles) if (!same(catalog.readModule(name), modules.get(name)))
      throw new Error('math_campaign_library_catalog_input_changed');
    return previous;
  }
  // A killed writer may leave a partial object store. It is not an installation and is never exposed by a catalog receipt.
  if (fs.existsSync(releaseDirectory)) fs.renameSync(releaseDirectory, `${releaseDirectory}.incomplete.${randomUUID()}`);
  const catalog = writeLibraryCatalog(releaseDirectory, { id: 'theorem-os/campaign', revision: inputDigest,
    environment: environment.id, packs,
    ...(retained.length ? { retainedPack: { schema: LIBRARY_PACK_SCHEMA, modules: retained } } : {}) });
  const report = { schema: 'theorem-os.campaign-library-catalog.v1', ...catalog, inputDigest, identity,
    environment: environment.id, environmentDigest: environment.dependencyDigest, toolchain: environment.toolchain,
    proofAcceptance: 'not-assessed' as const };
  writeMathJsonDurable(receiptFile, report, 0o400);
  return report;
}

const transitionSchema = z.object({ schema: z.literal('theorem-os.campaign-library-continuation.v1'),
  inputDigest: hash, sourceRunId: z.string().min(1), sourceState: z.string(), sourceStateDigest: hash,
  sourceResultDigest: hash, requestDigest: hash, sourceOutput: z.string(), originalWorkspace: z.string(),
  originalTaskDigest: hash, originalTargetsDigest: hash, originalProblemReceiptDigest: hash, problemReceiptDigest: hash,
  workspace: z.string(), activeProblemPath: z.string(), taskFile: z.string(), output: z.string(),
  continuationSourceRun: z.string(), catalog: z.object({ file: z.string(), digest: hash }).strict(),
  libraryCatalog: z.object({ file: z.string(), digest: hash }).strict(),
  selection: z.unknown(), requestedNames: z.array(z.string()), transitionFile: z.string(),
  proofAcceptance: z.literal('not-assessed'),
}).strict();
export type CampaignLibraryContinuation = z.infer<typeof transitionSchema>;

/** Prepare a fresh frozen receipt only. The existing solver continuation path replays and independently rechecks old work. */
export async function prepareCampaignLibraryContinuation(input: {
  run: string; taskFile: string; catalog: LibraryAccess; directory: string; signal?: AbortSignal;
}): Promise<CampaignLibraryContinuation> {
  const run = path.resolve(input.run), runtime = run + '.runtime', stateFile = path.join(runtime, 'state.json');
  const directory = path.resolve(input.directory), catalog: LibraryAccess = { file: path.resolve(input.catalog.file), digest: input.catalog.digest };
  for (const file of [run, runtime, stateFile, directory, input.taskFile, catalog.file]) assertMathCanonicalPath(file);
  if (isMathPathWithin(runtime, directory) || isMathPathWithin(directory, runtime))
    throw new Error('math_campaign_library_destination_overlaps_source');
  return withMathRuntimeLease({ lockPath: path.join(runtime, 'run.lock'), flockExecutable: '/usr/bin/flock', signal: input.signal }, async lease => {
    const rawText = readMathText(run, 16_000_000), raw = JSON.parse(rawText);
    const stateText = readMathText(stateFile, 64_000_000), state = readSolverRunState(stateFile);
    const taskText = readMathText(input.taskFile, 16_000_000);
    const problem = readSolverProblem(state.problem.workspace, state.problem.activeProblemPath);
    if (raw.status !== 'library_requested' || raw.runId !== state.runId || state.phase !== 'finished' ||
        !state.solveStartedAt || !state.solveFinishedAt || !state.cooperation?.canonicalCommit || !state.workers?.length ||
        state.problem.receiptDigest !== problem.receiptDigest || state.taskDigest !== mathDigest(taskText) ||
        state.libraryCatalogDigest !== catalog.digest)
      throw new Error('math_campaign_library_request_run_identity_changed');
    if ([state, ...state.workers].some(worker => worker.writerStopUnconfirmed)) throw new Error('math_campaign_library_writer_not_stopped');
    if (state.worktree !== path.join(runtime, 'worktree') || state.workers.some(worker => !isMathPathWithin(runtime, worker.worktree)))
      throw new Error('math_campaign_library_request_worktree_changed');
    const value = raw.libraryRequest;
    if (!value || typeof value.worktree !== 'string' || !state.workers.some(worker => worker.worktree === value.worktree))
      throw new Error('math_campaign_library_request_worker_changed');
    const release = readLibraryCatalog(catalog.file, catalog.digest);
    const oldReceipt = readLeanTaskReceipt(problem.activeProblemPath);
    if (release.identity.environmentDigest !== oldReceipt.environmentDigest) throw new Error('math_library_catalog_environment_changed');
    const next = requestedLibraryPack(problem, value.request, catalog, value.worktree);
    const sourceStateDigest = mathDigest(stateText), sourceResultDigest = mathDigest(rawText);
    const requestDigest = mathDigest(canonicalMathJson(next.request));
    const inputDigest = mathDigest(canonicalMathJson({ sourceStateDigest, sourceResultDigest, requestDigest, catalog, taskDigest: state.taskDigest }));
    const workspace = path.join(directory, 'workspace'), taskFile = path.join(directory, 'task.md');
    const output = path.join(directory, 'result.json'), transitionFile = path.join(directory, 'library-continuation.json');
    const verify = (report: CampaignLibraryContinuation) => {
      if (report.inputDigest !== inputDigest || report.sourceRunId !== state.runId || report.workspace !== workspace ||
          report.sourceState !== stateFile || report.sourceStateDigest !== sourceStateDigest ||
          report.sourceResultDigest !== sourceResultDigest || report.requestDigest !== requestDigest ||
          report.activeProblemPath !== path.join(workspace, 'active-problem.json') || report.taskFile !== taskFile ||
          report.output !== output || report.continuationSourceRun !== run || report.transitionFile !== transitionFile ||
          report.sourceOutput !== run || report.originalWorkspace !== problem.workspace || report.originalTaskDigest !== state.taskDigest ||
          report.originalProblemReceiptDigest !== problem.receiptDigest ||
          report.originalTargetsDigest !== mathDigest(canonicalMathJson(problem.targets)) ||
          !same(report.catalog, catalog) || !same(report.libraryCatalog, catalog) || !same(report.selection, next.selection) ||
          !same(report.requestedNames, next.request.names) || mathDigest(readMathText(taskFile, 16_000_000)) !== state.taskDigest)
        throw new Error('math_campaign_library_continuation_changed');
      const continued = readSolverProblem(workspace, report.activeProblemPath);
      if (continued.receiptDigest !== report.problemReceiptDigest || !same(continued.contract, problem.contract) ||
          !same(continued.targets, problem.targets) || !same(continued.trustedFiles, problem.trustedFiles) ||
          !same(continued.frozenFiles, Object.fromEntries(next.pack.modules.map(module => [module.file, mathDigest(module.source)]))))
        throw new Error('math_campaign_library_original_changed');
      lease.assertHeld();
      return report;
    };
    if (fs.existsSync(transitionFile)) return verify(transitionSchema.parse(readJson(transitionFile)));
    claim(directory, 'transition-input.json', { inputDigest, sourceStateDigest, sourceResultDigest, requestDigest, sourceRunId: state.runId });
    if (fs.existsSync(output) || fs.existsSync(output + '.runtime')) throw new Error('math_campaign_library_destination_already_started');
    // Only an owned, matching preparation may quarantine a half-created workspace; the old run is never touched.
    if (fs.existsSync(workspace) && !fs.existsSync(path.join(workspace, 'active-problem.json')))
      fs.renameSync(workspace, `${workspace}.incomplete.${randomUUID()}`);
    const definitions = new Set(oldReceipt.declarations.filter(declaration => declaration.kind !== 'theorem').map(declaration => declaration.name));
    const receipt = fs.existsSync(workspace) ? readLeanTaskReceipt(path.join(workspace, 'active-problem.json')) : bootstrapLeanTask(workspace, { source: problem.contract.formalStatement,
      task: problem.contract.informalStatement, environment: oldReceipt.environment,
      definitionTargets: oldReceipt.publicObligations.filter(item => definitions.has(item.name)).map(item => item.name), libraryPack: next.pack });
    if (fs.existsSync(taskFile)) {
      if (readMathText(taskFile, 16_000_000) !== taskText) throw new Error('math_campaign_library_task_changed');
    } else writeMathFrozen(taskFile, taskText);
    const report = transitionSchema.parse({ schema: 'theorem-os.campaign-library-continuation.v1', inputDigest,
      sourceRunId: state.runId, sourceState: stateFile, sourceStateDigest, sourceResultDigest, requestDigest,
      sourceOutput: run, originalWorkspace: problem.workspace, originalTaskDigest: state.taskDigest,
      originalTargetsDigest: mathDigest(canonicalMathJson(problem.targets)), originalProblemReceiptDigest: problem.receiptDigest,
      problemReceiptDigest: readSolverProblem(workspace, receipt.activeProblemPath).receiptDigest,
      workspace, activeProblemPath: receipt.activeProblemPath, taskFile, output, continuationSourceRun: run,
      catalog, libraryCatalog: catalog, selection: next.selection, requestedNames: next.request.names, transitionFile,
      proofAcceptance: 'not-assessed' });
    verify(report);
    // Publish only after all new identities and original obligations have been read back.
    writeMathJsonDurable(transitionFile, report, 0o400);
    return report;
  });
}
