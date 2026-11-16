import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { readMathBuildManifest } from '../math/mathBuildManifest';
import { bindLeanPackages } from '../math/leanDiagnostics';
import { MATH_PROOF_ENVIRONMENT_ENV, MATH_PROOF_ENVIRONMENT_SANDBOX_ENV, prepareMathProofEnvironment } from '../math/mathProofEnvironment';
import { DEFAULT_MATH_PROOF_ENVIRONMENT_CACHE_ROOT } from '../math/mathProofEnvironmentCache';
import { canonicalMathJson, mathDigest, readMathFile, readMathJson, withMathRuntimeLease, writeMathJsonDurable } from '../math/mathRuntimeIo';
import { resolveMathematicsRuntimeEnvironment } from '../math/mathRuntimeEnvironment';
import { assertMathCanonicalPath } from '../math/paths';
import { resolveMathematicsLakePackagesCache } from '../math/verifier';
import { readSolverRunState, writeSolverRunState, type SolverRunState } from './archive';
import { freezeContinuationInput, MAX_CONTINUATION_ATTACHMENT_BYTES, readContinuationContents, type ContinuationManifest } from './continuationInput';
import { captureContinuationTaskDrafts, continuationOwnershipExtension, continuationSourcePolicyDigest,
  type ContinuationSeedReport, type seedSolverContinuation } from './continuationSeed';
import { checkDeclarationArtifacts, readDeclarationArtifacts, writeDeclarationArtifacts } from './declarationArtifacts';
import { readRunInspection } from './inspection';
import { assertSolverSources, committedSource, commitSolverSources, git, pinSolverResearchSkill, readSolverProblem, withSolverWorktree } from './problem';
import { isDefinitionTask, type TaskRecord } from './tasks';
import type { ProofCheck } from './modules/evidence';
import type { TaskProof } from './cooperativeProof';
import { readMathAgentSkill } from '../runtime/agentSkills';
import { RESEARCH_SKILL_DIRECTORY, researchSkillIdentity } from './researchSkill';

const hash = z.string().regex(/^[a-f0-9]{64}$/u), oid = z.string().regex(/^[a-f0-9]{40,64}$/u);
const documentSchema = z.object({ id: z.string(), kind: z.enum(['proof-source', 'research-notes', 'diagnostics', 'reference']),
  text: z.string(), provenance: z.object({ source: z.string(), runId: z.string(),
    evidence: z.enum(['unverified', 'recorded-not-replayed']), commit: oid.optional() }).strict() }).strict();
const sourceSchema = z.object({ schema: z.literal('theorem-os.single-continuation-source.v1'),
  taskDigest: hash, problemReceiptDigest: hash, sourcePolicyDigest: hash,
  destination: z.object({ runId: z.string(), stateFile: z.string(), configurationDigest: hash }).strict(),
  source: z.object({ runId: z.string(), stateFile: z.string(), stateDigest: hash, canonicalCommit: oid,
    environmentDigest: z.string(), capturedAt: z.number().int().nonnegative() }).strict(),
  canonicalSources: z.record(z.string()), canonicalNotes: z.string().nullable(), documents: z.array(documentSchema),
  declarations: z.array(z.object({ id: z.string(), file: z.string(), name: z.string(), type: z.string(),
    description: z.string().optional(), premises: z.array(z.string()).optional() }).strict()),
}).strict();
type SingleSource = z.infer<typeof sourceSchema>;
type Options = Parameters<typeof seedSolverContinuation>[0];
type SingleSeedReport = ContinuationSeedReport & { declarationFailures?: { id: string; name: string; error: string }[] };

const configurationDigest = (state: SolverRunState) => mathDigest(canonicalMathJson({ runId: state.runId,
  taskDigest: state.taskDigest, buildDigest: state.buildDigest, environmentDigest: state.environmentDigest,
  methodDigest: state.methodDigest, model: state.model, effort: state.effort, providerProfileDigest: state.providerProfileDigest,
  researchMode: state.researchMode, researchSkill: state.researchSkill, commonResearchSkill: state.commonResearchSkill,
  researchDelegation: state.researchDelegation, workerCount: state.workerCount, coordination: state.coordination }));
const textFile = (file: string) => {
  assertMathCanonicalPath(file);
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readMathFile(file, 16_000_000).bytes);
};
const notesAt = (worktree: string, commit: string) => git(worktree, ['ls-tree', '--format=%(objectname)', commit, '--', 'RESEARCH.md'])
  ? committedSource(worktree, commit, 'RESEARCH.md') : null;

function assertPrepared(state: SolverRunState, stateFile: string, seeded: boolean) {
  if (state.phase !== 'prepared' || state.turns !== 0 || state.solveStartedAt !== undefined || state.solveFinishedAt !== undefined ||
      state.threadId || state.previousThreadIds?.length || state.workers?.length || (state.workerCount ?? 1) !== 1 ||
      state.cooperation || state.coordination !== 'independent' || state.researchMode !== 'skill' ||
      state.check || state.candidate || state.winningWorker || state.writerStopUnconfirmed ||
      state.lastActivity || state.lastFailure || state.lastContextManifest || state.failures?.length ||
      state.usage || state.usageBeforeThread || state.usageAccounting || state.requestUsageAccounting ||
      Object.values(state.dispatchCounts ?? {}).some(value => value !== 0) ||
      state.worktree !== path.join(path.dirname(stateFile), 'worktree') || !seeded && state.continuationDigest)
    throw new Error('math_continuation_seed_requires_fresh_prepared_run');
  const directory = path.dirname(stateFile); assertMathCanonicalPath(directory); assertMathCanonicalPath(state.worktree);
  const stat = fs.statSync(directory);
  if (stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid()) throw new Error('math_state_directory_not_private');
  if (continuationSourcePolicyDigest(readSolverProblem(state.problem.workspace, state.problem.activeProblemPath)) !==
      continuationSourcePolicyDigest(state.problem)) throw new Error('math_continuation_seed_source_policy_changed');
}

function captureSource(sourceStateFile: string, stateFile: string, state: SolverRunState): SingleSource {
  const archivedBytes = readMathFile(sourceStateFile).bytes, archived = readSolverRunState(sourceStateFile);
  if (mathDigest(readMathFile(sourceStateFile).bytes) !== mathDigest(archivedBytes))
    throw new Error('math_continuation_seed_source_changed');
  const sameProblem = archived.problem.receiptDigest === state.problem.receiptDigest &&
    continuationSourcePolicyDigest(archived.problem) === continuationSourcePolicyDigest(state.problem);
  const added = sameProblem ? undefined : continuationOwnershipExtension(archived.problem, state.problem);
  if (archived.runId === state.runId || archived.taskDigest !== state.taskDigest || !sameProblem && !added)
    throw new Error('math_continuation_seed_identity_changed');
  const sourceDirectory = path.dirname(sourceStateFile);
  if (archived.worktree !== path.join(sourceDirectory, 'worktree')) throw new Error('math_continuation_seed_repository_changed');
  assertMathCanonicalPath(archived.worktree);
  const canonicalCommit = archived.cooperation?.canonicalCommit ?? git(archived.worktree, ['rev-parse', 'HEAD']);
  const canonicalSources = Object.fromEntries(state.problem.ownedFiles.map(file => [file,
    added?.includes(file) ? committedSource(state.worktree, state.problem.baseCommit, `${state.problem.projectRelative}/${file}`)
      : committedSource(archived.worktree, canonicalCommit, `${state.problem.projectRelative}/${file}`)]));
  for (const [file, expected] of Object.entries(state.problem.trustedFiles))
    if (mathDigest(committedSource(archived.worktree, canonicalCommit, `${state.problem.projectRelative}/${file}`)) !== expected)
      throw new Error('math_continuation_seed_source_policy_changed');
  const provenance = { source: sourceStateFile, runId: archived.runId, evidence: 'recorded-not-replayed' as const, commit: canonicalCommit };
  const documents: SingleSource['documents'] = [{ id: 'seed-history', kind: 'diagnostics', text: archivedBytes.toString('utf8'), provenance },
    { id: 'seed-recovery-guide', kind: 'research-notes', provenance,
      text: 'A new single-researcher run starts from these fixed source bytes. No historical thread, task, owner, pause, usage counter or proof flag is execution authority. The old state and worker drafts are advisory history; source-run costs remain in seed-history and are not erased or attributed to new work.\n' +
        'Canonical sources are pinned to their recorded commit. Worker drafts are individually stable reads, not a globally atomic observation. Drafts and suspended task snapshots remain separate and must not overwrite canonical proofs. Historical claims require a fresh check in this run; failed and conditional helpers stay advisory.\n' }];
  const workers = archived.workers?.length ? archived.workers : [{ id: 'solver', role: 'lead', worktree: archived.worktree }];
  for (const [index, worker] of workers.entries()) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/u.test(worker.id) ||
        worker.worktree !== path.join(sourceDirectory, index ? `worktree-${index + 1}` : 'worktree'))
      throw new Error('math_continuation_seed_worker_path_changed');
    assertMathCanonicalPath(worker.worktree);
    const before = git(worker.worktree, ['rev-parse', 'HEAD']);
    const sources = Object.fromEntries(archived.problem.ownedFiles.map(file => [file,
      textFile(path.join(worker.worktree, archived.problem.projectRelative, file))]));
    const notesFile = path.join(worker.worktree, 'RESEARCH.md');
    const notes = fs.lstatSync(notesFile, { throwIfNoEntry: false }) ? textFile(notesFile) : null;
    const after = git(worker.worktree, ['rev-parse', 'HEAD']);
    if (before !== after) throw new Error('math_continuation_seed_source_changed');
    documents.push({ id: `draft-${worker.id}`, kind: 'proof-source', provenance: { ...provenance, commit: before },
      text: canonicalMathJson({ id: worker.id, role: worker.role, headBefore: before, headAfter: after, sources, notes }) });
  }
  // Capture suspended task snapshots by commit, independently of whichever draft currently occupies a worker.
  if (archived.cooperation) for (const [index, draft] of captureContinuationTaskDrafts(archived, sourceStateFile).entries())
    documents.push({ id: `seed-task-draft-${index + 1}`, kind: 'proof-source', text: canonicalMathJson(draft),
      provenance: { ...provenance, commit: draft.commit } });
  if (archived.continuationDigest) {
    const old = readContinuationContents(path.join(sourceDirectory, 'continuation.json'), archived.continuationDigest,
      { taskDigest: archived.taskDigest, problemReceiptDigest: archived.problem.receiptDigest });
    for (const [index, attachment] of old.snapshot.manifest.attachments.entries()) documents.push({
      id: `previous-${index + 1}`, kind: attachment.kind, text: old.contents.get(attachment.sha256)!,
      provenance: { source: `${sourceStateFile}#${attachment.id}`, runId: attachment.provenance.runId ?? archived.runId,
        evidence: attachment.provenance.evidence, ...(attachment.provenance.commit ? { commit: attachment.provenance.commit } : {}) } });
  }
  const candidates = new Map<string, SingleSource['declarations'][number]>();
  const add = (node: { task: TaskRecord['task']; proof?: TaskProof; integratedCheck?: ProofCheck }) => {
    const task = node.task, proof = [node.integratedCheck, node.proof].find(proof => proof?.passed && !(proof as TaskProof).conditions?.length);
    if (task.kind !== 'lemma' || isDefinitionTask(task) || task.conditional || !proof ||
        !task.proofPath || !task.theoremName || !task.type) return;
    const key = canonicalMathJson([task.proofPath, task.theoremName, task.type]);
    if (!candidates.has(key)) candidates.set(key, { id: task.id, file: task.proofPath, name: task.theoremName,
      type: task.type, description: task.objective, premises: task.premises ? [...task.premises] : undefined });
  };
  for (const node of archived.cooperation?.tasks ?? []) add(node);
  for (const node of archived.cooperation?.history ?? []) add(node);
  const proofCommits = new Set<string>();
  for (const node of [...archived.cooperation?.tasks ?? [], ...archived.cooperation?.history ?? []])
    for (const proof of [node.proof, node.integratedCheck]) if (proof?.commit) proofCommits.add(proof.commit);
  // A helper or conditional proof can have left canonical code. Retain its exact old
  // source even when its declaration cannot be rechecked in the new canonical candidate.
  for (const [index, commit] of [...proofCommits].entries()) {
    let contents: { sources?: Record<string, string>; notes?: string | null; captureError?: string };
    try {
      if (!oid.safeParse(commit).success) throw new Error('math_continuation_seed_commit_invalid');
      contents = { sources: Object.fromEntries(archived.problem.ownedFiles.map(file => [file,
        committedSource(archived.worktree, commit, `${archived.problem.projectRelative}/${file}`)])),
        notes: notesAt(archived.worktree, commit) };
    } catch (error) { contents = { captureError: error instanceof Error ? error.message : 'math_task_source_unavailable' }; }
    documents.push({ id: `seed-proof-snapshot-${index + 1}`, kind: 'proof-source', text: canonicalMathJson({ commit, ...contents }),
      provenance: { ...provenance, ...(oid.safeParse(commit).success ? { commit } : { commit: undefined }) } });
  }
  const declarations = readDeclarationArtifacts(sourceDirectory, archived);
  if (declarations.length) {
    documents.push({ id: 'seed-declaration-artifacts', kind: 'proof-source', provenance,
      text: canonicalMathJson(declarations.map(artifact => ({ artifact,
        sources: Object.fromEntries(archived.problem.ownedFiles.map(file => [file,
          committedSource(archived.worktree, artifact.proof.commit, `${archived.problem.projectRelative}/${file}`)])) }))) });
    for (const artifact of declarations) {
      const declaration = artifact.declaration, key = canonicalMathJson([declaration.file, declaration.name, declaration.type]);
      if (!candidates.has(key)) candidates.set(key, { id: artifact.id, ...declaration });
    }
  }
  return sourceSchema.parse({ schema: 'theorem-os.single-continuation-source.v1', taskDigest: state.taskDigest,
    problemReceiptDigest: state.problem.receiptDigest, sourcePolicyDigest: continuationSourcePolicyDigest(state.problem),
    destination: { runId: state.runId, stateFile, configurationDigest: configurationDigest(state) },
    source: { runId: archived.runId, stateFile: sourceStateFile, stateDigest: mathDigest(archivedBytes), canonicalCommit,
      environmentDigest: archived.environmentDigest, capturedAt: Date.now() }, canonicalSources,
    canonicalNotes: notesAt(archived.worktree, canonicalCommit), documents,
    declarations: [...candidates.values()].map((declaration, index, all) => all.findIndex(item => item.id === declaration.id) === index
      ? declaration : { ...declaration, id: `${declaration.id}-${mathDigest(canonicalMathJson(declaration)).slice(0, 16)}` }) });
}

function freezeSource(source: SingleSource, directory: string) {
  let documents = [{ id: 'seed-canonical', kind: 'proof-source' as const,
    text: canonicalMathJson({ sources: source.canonicalSources, notes: source.canonicalNotes }),
    provenance: { source: source.source.stateFile, runId: source.source.runId, evidence: 'recorded-not-replayed' as const,
      commit: source.source.canonicalCommit } }, ...source.documents];
  // Repeated migrations can exceed the existing 32-attachment manifest limit.
  // Keep the primary documents addressable; bundle overflow by kind with exact
  // text lengths and provenance so no old body needs to be discarded or rewritten.
  if (documents.length > 32) {
    const compact = documents.slice(0, 8), pending = documents.slice(8);
    for (const kind of ['proof-source', 'research-notes', 'diagnostics', 'reference'] as const) {
      let text = '';
      const flush = () => {
        if (!text) return;
        compact.push({ id: `seed-archive-${compact.length + 1}`, kind, text, provenance: {
          source: source.source.stateFile, runId: source.source.runId, evidence: 'recorded-not-replayed',
          commit: source.source.canonicalCommit } }); text = '';
      };
      for (const document of pending.filter(item => item.kind === kind)) {
        const entry = canonicalMathJson({ schema: 'theorem-os.continuation-text-record.v1', id: document.id,
          kind: document.kind, provenance: document.provenance, textLength: document.text.length,
          textBytes: Buffer.byteLength(document.text), textSha256: mathDigest(document.text) }) + '\n' + document.text + '\n';
        if (Buffer.byteLength(text) + Buffer.byteLength(entry) > MAX_CONTINUATION_ATTACHMENT_BYTES) flush();
        if (Buffer.byteLength(entry) > MAX_CONTINUATION_ATTACHMENT_BYTES) compact.push(document);
        else text += entry;
      }
      flush();
    }
    documents = compact;
  }
  const manifest: ContinuationManifest = { schema: 'theorem-os.continuation-snapshot.v1', taskDigest: source.taskDigest,
    problemReceiptDigest: source.problemReceiptDigest, attachments: documents.map(item => {
      const sha256 = mathDigest(item.text);
      return { id: item.id, kind: item.kind, path: `${item.id}.json`, bytes: Buffer.byteLength(item.text), sha256,
        provenance: { ...item.provenance, evidence: item.provenance.evidence ?? 'recorded-not-replayed' }, contentPath: `continuation/${sha256}.txt` };
    }) };
  return freezeContinuationInput({ manifest, digest: mathDigest(canonicalMathJson(manifest)),
    contents: new Map(documents.map(item => [mathDigest(item.text), item.text])) }, directory);
}

/** Import artifacts into a new idle single run; historical scheduling state is never recreated. */
export async function seedSingleSolverContinuation(options: Options): Promise<ContinuationSeedReport> {
  const stateFile = readRunInspection(options.run).stateFile, directory = path.dirname(stateFile);
  const sourceStateFile = path.basename(path.resolve(options.sourceRun)) === 'state.json'
    ? path.resolve(options.sourceRun) : `${path.resolve(options.sourceRun)}.runtime/state.json`;
  assertMathCanonicalPath(sourceStateFile);
  if (sourceStateFile === stateFile) throw new Error('math_continuation_seed_identity_changed');
  const seed = async (lease: NonNullable<Options['lease']>) => {
    const state = readSolverRunState(stateFile), sourceFile = path.join(directory, 'continuation-single-source.json');
    const reportFile = path.join(directory, 'continuation-seed.json'), seeded = fs.existsSync(sourceFile);
    assertPrepared(state, stateFile, seeded);
    if (!state.researchSkill) throw new Error('math_research_skill_identity_missing');
    const skill = readMathAgentSkill(path.join(state.worktree, RESEARCH_SKILL_DIRECTORY, 'SKILL.md'), state.researchSkill.loading);
    if (canonicalMathJson(researchSkillIdentity(skill)) !== canonicalMathJson(state.researchSkill))
      throw new Error('math_research_skill_changed');
    pinSolverResearchSkill(state.problem, state.worktree, skill);
    const buildFile = fs.realpathSync(options.buildManifest);
    readMathBuildManifest(buildFile, options.root, path.join(options.root, 'out', 'main'));
    if (mathDigest(readMathFile(buildFile).bytes) !== state.buildDigest) throw new Error('math_continuation_seed_build_changed');
    let source: SingleSource;
    if (seeded) {
      assertMathCanonicalPath(sourceFile);
      if ((fs.lstatSync(sourceFile).mode & 0o777) !== 0o400) throw new Error('math_continuation_seed_source_not_frozen');
      source = sourceSchema.parse(readMathJson(sourceFile));
    } else source = captureSource(sourceStateFile, stateFile, state);
    if (source.taskDigest !== state.taskDigest || source.problemReceiptDigest !== state.problem.receiptDigest ||
        source.sourcePolicyDigest !== continuationSourcePolicyDigest(state.problem) || source.source.stateFile !== sourceStateFile ||
        source.destination.runId !== state.runId || source.destination.stateFile !== stateFile ||
        source.destination.configurationDigest !== configurationDigest(state) ||
        canonicalMathJson(Object.keys(source.canonicalSources).sort()) !== canonicalMathJson([...state.problem.ownedFiles].sort()))
      throw new Error('math_continuation_seed_identity_changed');
    const previous = seeded && fs.existsSync(reportFile) ? readMathJson(reportFile) as Partial<ContinuationSeedReport> : undefined;
    const head = git(state.worktree, ['rev-parse', 'HEAD']);
    const notesFile = path.join(state.worktree, 'RESEARCH.md');
    const actualNotes = fs.lstatSync(notesFile, { throwIfNoEntry: false }) ? textFile(notesFile) : null;
    if (![state.problem.baseCommit, previous?.canonicalCommit].includes(head) ||
        git(state.worktree, ['status', '--porcelain', '--untracked-files=no']) ||
        actualNotes !== notesAt(state.worktree, head) || !seeded && actualNotes !== null)
      throw new Error('math_continuation_seed_destination_changed');
    lease.assertHeld(); if (!seeded) writeMathJsonDurable(sourceFile, source, 0o400);
    const report: SingleSeedReport = { schema: 'theorem-os.continuation-seed.v1', sourceRunId: source.source.runId,
      runId: state.runId, sourceStateFile, stateFile, sourceDigest: mathDigest(canonicalMathJson(source)), stage: 'frozen',
      candidates: source.declarations.map(item => item.id), checked: [], failed: [], evidence: 'advisory-sources-require-recheck' };
    const saveReport = () => { lease.assertHeld(); writeMathJsonDurable(reportFile, report); };
    const emit = (event: string, details: Record<string, unknown> = {}) => options.onProgress?.(event, details);
    let proofEnvironment: Awaited<ReturnType<typeof prepareMathProofEnvironment>> | undefined;
    try {
      const snapshot = freezeSource(source, directory); report.snapshotDigest = snapshot.digest;
      if (state.continuationDigest && state.continuationDigest !== snapshot.digest) throw new Error('math_continuation_seed_destination_changed');
      saveReport();
      const canonical = previous?.canonicalCommit ?? await withSolverWorktree(state.worktree, state.problem.baseCommit, async checkout => {
        for (const [file, text] of Object.entries(source.canonicalSources)) {
          const target = path.join(checkout, state.problem.projectRelative, file); assertMathCanonicalPath(target);
          fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text);
        }
        if (source.canonicalNotes !== null) fs.writeFileSync(path.join(checkout, 'RESEARCH.md'), source.canonicalNotes);
        assertSolverSources(state.problem, checkout);
        const commit = commitSolverSources(state.problem, checkout);
        git(state.worktree, ['update-ref', `refs/math/${state.runId}/continuation/source`, commit]); return commit;
      });
      for (const [file, text] of Object.entries(source.canonicalSources))
        if (committedSource(state.worktree, canonical, `${state.problem.projectRelative}/${file}`) !== text)
          throw new Error('math_continuation_seed_destination_changed');
      if (notesAt(state.worktree, canonical) !== source.canonicalNotes) throw new Error('math_continuation_seed_destination_changed');
      report.canonicalCommit = canonical; report.stage = 'installing'; saveReport();
      state.continuationDigest = snapshot.digest; writeSolverRunState(stateFile, state);
      lease.signal.throwIfAborted(); git(state.worktree, ['reset', '--hard', canonical]); assertSolverSources(state.problem, state.worktree);
      report.sourcesInstalled = true; saveReport();
      emit('continuation_seed_installed', { sourceRunId: source.source.runId, runId: state.runId,
        candidates: source.declarations.length, snapshotDigest: snapshot.digest, researchMode: 'skill', acceptance: 'not-assessed' });
      if (source.declarations.length) {
        const environmentFile = path.join(directory, 'environment-solver.json'); assertMathCanonicalPath(environmentFile);
        if ((fs.lstatSync(environmentFile).mode & 0o777) !== 0o400) throw new Error('math_continuation_seed_environment_not_frozen');
        const staticEnv = { ...(options.preparedEnvironment ?? resolveMathematicsRuntimeEnvironment({ DEEPSCIENTIST_MATH_ENV_FILE: environmentFile })) };
        if (!options.preparedEnvironment) { delete staticEnv[MATH_PROOF_ENVIRONMENT_ENV]; delete staticEnv[MATH_PROOF_ENVIRONMENT_SANDBOX_ENV]; }
        const project = path.join(state.worktree, state.problem.projectRelative), packages = resolveMathematicsLakePackagesCache(project, staticEnv);
        if (packages) bindLeanPackages(project, packages);
        else {
          const manifestFile = path.join(project, 'lake-manifest.json');
          const manifest = fs.existsSync(manifestFile) ? readMathJson(manifestFile) as { packages?: unknown } : undefined;
          if (Array.isArray(manifest?.packages) && manifest.packages.length) throw new Error('math_lake_packages_unavailable');
        }
        const timeoutMs = options.timeoutMs ?? Infinity;
        if (packages && !options.preparedEnvironment) proofEnvironment = await prepareMathProofEnvironment(project, packages,
          { env: staticEnv, signal: lease.signal, deadlineAt: Number.isFinite(timeoutMs) ? Date.now() + timeoutMs : undefined,
            cacheRoot: DEFAULT_MATH_PROOF_ENVIRONMENT_CACHE_ROOT, onProgress: phase => emit('continuation_seed_proof_environment', { phase }) });
        const env = proofEnvironment ? { ...staticEnv, [MATH_PROOF_ENVIRONMENT_ENV]: proofEnvironment.environmentValue } : staticEnv;
        report.stage = 'checking'; saveReport();
        const assertWriterStopped = () => { lease.assertHeld(); assertPrepared(state, stateFile, true); };
        for (const declaration of source.declarations) {
          lease.signal.throwIfAborted();
          const { id, ...submission } = declaration;
          try {
            const artifacts = await checkDeclarationArtifacts({ state, worktree: state.worktree, commit: canonical,
              declarations: [submission], env, signal: lease.signal, timeoutMs, assertWriterStopped });
            assertWriterStopped(); writeDeclarationArtifacts(directory, state, artifacts);
            report.checked.push(id); report.evidence = 'fresh-helper-receipts';
            emit('continuation_seed_declaration_checked', { id, name: declaration.name, passed: true });
          } catch (error) {
            const message = error instanceof Error ? error.message : '';
            if (!message.startsWith('math_declaration_artifact_check_failed:') &&
                !['math_knowledge_declaration_missing_or_ambiguous', 'math_task_missing_declaration',
                  'math_declaration_artifact_requires_theorem'].includes(message)) throw error;
            assertWriterStopped(); report.failed.push(id);
            (report.declarationFailures ??= []).push({ id, name: declaration.name, error: message });
            emit('continuation_seed_declaration_checked', { id, name: declaration.name, passed: false, error: message });
          }
          saveReport();
        }
      }
      assertPrepared(state, stateFile, true); writeSolverRunState(stateFile, state);
      report.stage = 'complete'; saveReport(); options.onSeeded?.(state, []); return report;
    } catch (error) {
      report.stage = 'interrupted'; report.error = error instanceof Error ? error.message : 'math_continuation_seed_failed';
      lease.assertOwned(); writeMathJsonDurable(reportFile, report); throw error;
    } finally { await proofEnvironment?.dispose(); }
  };
  return options.lease ? seed(options.lease) : withMathRuntimeLease({ lockPath: path.join(directory, 'run.lock'),
    flockExecutable: '/usr/bin/flock', signal: options.signal }, seed);
}
