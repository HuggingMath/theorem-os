import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { mathGitBytes } from '../../src/math/mathGit';
import { canonicalMathJson, mathDigest, readMathText, withMathRuntimeLease, writeMathFrozen,
  writeMathJsonDurable } from '../../src/math/mathRuntimeIo';
import { assertMathCanonicalPath } from '../../src/math/paths';
import type { SolverRunState } from '../../src/solver/archive';
import { buildRunInspection, exportRunPlan, readRunInspection } from '../../src/solver/inspection';
import { queuePlanApproval } from '../../src/solver/humanEdit';
import { planApprovalInputSchema } from '../../src/solver/planApproval';
import { readHumanGuidance } from '../../src/solver/humanGuidance';
import { taskVersion, type TaskRecord } from '../../src/solver/tasks';
import { allowedKnowledgeFile, buildTheoremKnowledge, validateTheoremKnowledge, type TheoremKnowledgeBase } from '../../src/solver/theoremKnowledge';
import { importKnowledgeRuns } from '../../src/solver/theoremKnowledgeRuns';
import { proofReceiptsMatch, type ProofCheck } from '../../src/solver/modules/evidence';
import type { WebCheckReceipt, WebCommandResult, WebLibraryRestart, WebObservation, WebTaskSource } from './collaboration';
import { retiredResearchCoordinationCode, type WorkerMessage } from './shared';
import { projectWebDeclarationArtifacts } from './declarationArtifacts';
import { projectWebNativeTeam } from './nativeTeamObservation';
import { maxWorkerObservationBytes, standaloneObservationFrame, type WorkerObservationFrame } from './observationSources';

export const webActiveRunFile = '/work/active-run.json';
const libraryRestartSchema = z.object({ previousSolverRunId: z.string().min(1).max(128),
  round: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
type LibraryRestart = Omit<WebLibraryRestart, 'solverRunId'>;
const activeRunSchema = z.object({ schema: z.literal('theorem-os.web-active-run.v1'),
  webRunId: z.string().min(1).max(128), directory: z.string().min(1), output: z.string().min(1),
  libraryRestart: libraryRestartSchema.optional() }).strict();
type ActiveRun = { webRunId: string; directory: string; output: string; libraryRestart?: LibraryRestart };
const metaSchema = z.object({ schema: z.literal('theorem-os.web-bridge.v1'), webRunId: z.string(), solverRunId: z.string(),
  libraryRound: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  sequence: z.number().int().nonnegative(), contentDigest: z.string(),
  // Older worker metadata may include the observation references once used by guidance writes.
  observations: z.unknown().optional(),
  catalogKey: z.string().optional(), catalogDigest: z.string().optional(),
}).strict();
type BridgeMeta = z.infer<typeof metaSchema>;
const maxSourceBytes = 4 * 1024 * 1024, maxSourcesBytes = 6 * 1024 * 1024, maxChecksBytes = 2 * 1024 * 1024;
const oid = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const childOf = (directory: string, file: string) => path.isAbsolute(file) && file.startsWith(directory + path.sep);
const relativePath = (file: string) => file && !path.isAbsolute(file) && !file.includes('\\') &&
  file.split('/').every(part => part && part !== '.' && part !== '..');

export function writeWebActiveRun(input: ActiveRun, file = webActiveRunFile): void {
  const directory = fs.realpathSync(input.directory), output = path.resolve(input.output);
  if (!childOf(directory, output)) throw new Error('web_bridge_output_outside_run');
  writeMathJsonDurable(file, activeRunSchema.parse({ schema: 'theorem-os.web-active-run.v1',
    webRunId: input.webRunId, directory, output, libraryRestart: input.libraryRestart }));
}

function readActiveRun(file: string): ActiveRun {
  const value = activeRunSchema.parse(JSON.parse(readMathText(file, 8_192))) as ActiveRun;
  if (path.resolve(value.directory) !== value.directory || fs.realpathSync(value.directory) !== value.directory ||
      !childOf(value.directory, value.output)) throw new Error('web_bridge_active_run_invalid');
  return value;
}

export function freezeWebKnowledge(directory: string, catalog?: unknown): string | undefined {
  if (!catalog) return;
  const base = validateTheoremKnowledge(catalog), file = path.join(directory, 'input-knowledge.json');
  writeMathFrozen(file, canonicalMathJson(base) + '\n');
  return file;
}

function bridgeMeta(file: string, webRunId: string, solverRunId: string, restart?: LibraryRestart): BridgeMeta | undefined {
  if (!fs.existsSync(file)) return;
  const value = metaSchema.parse(JSON.parse(readMathText(file, 32 * 1024)));
  if (value.webRunId !== webRunId || (value.solverRunId === solverRunId
    ? restart && restart.round !== (value.libraryRound ?? 0)
    : !restart || restart.previousSolverRunId !== value.solverRunId || restart.round !== (value.libraryRound ?? 0) + 1))
    throw new Error('web_bridge_run_identity_changed');
  return value;
}

function runRoots(state: SolverRunState, directory: string): string[] {
  return [...new Set([state.worktree, state.problem.workspace, ...(state.workers ?? []).map(worker => worker.worktree)])]
    .filter(root => {
      try { if (!childOf(directory, root)) return false; assertMathCanonicalPath(root); return fs.realpathSync(root) === root; }
      catch { return false; }
    });
}

/** Read immutable Git blobs from host-selected owned files, never user-supplied paths or mutable worktree bytes. */
function committedOwnedSources(state: SolverRunState, roots: readonly string[], commit: string): { files: Record<string, string>; digest: string } {
  const problem = state.problem;
  if (!oid.test(commit) || !relativePath(problem.projectRelative) || !problem.ownedFiles.length ||
      problem.ownedFiles.some(file => !allowedKnowledgeFile(file) || !file.endsWith('.lean')))
    throw new Error('web_bridge_source_selection_invalid');
  for (const root of roots) {
    try {
      mathGitBytes(root, ['merge-base', '--is-ancestor', problem.baseCommit, commit],
        { maxBuffer: 8_192, timeout: 3_000, errorMessage: 'web_bridge_source_outside_problem' });
      const files: Record<string, string> = {};
      for (const file of problem.ownedFiles) {
        const full = `${problem.projectRelative}/${file}`;
        const tree = mathGitBytes(root, ['ls-tree', '-z', commit, '--', full],
          { maxBuffer: 8_192, timeout: 3_000 }).toString('utf8');
        if (!new RegExp('^100(?:644|755) blob [a-f0-9]+\\t' + full.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') + '\\0$', 'u').test(tree))
          throw new Error('web_bridge_source_not_regular_file');
        files[file] = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(mathGitBytes(root, ['show', `${commit}:${full}`],
          { maxBuffer: maxSourceBytes, timeout: 3_000, errorMessage: 'web_bridge_source_unavailable' }));
      }
      return { files, digest: mathDigest(canonicalMathJson(problem.ownedFiles.map(file => [file, mathDigest(files[file])]))) };
    } catch { /* A peer's committed object may only exist in another run-owned worktree. */ }
  }
  throw new Error('web_bridge_source_unavailable');
}

function sourceProjection(state: SolverRunState, directory: string) {
  const sources: WebTaskSource[] = [], checks: WebCheckReceipt[] = [];
  let sourceBytes = 0, checkBytes = 0, sourcePartial = false, checkPartial = false;
  const sourceIds = new Set<string>(), checkIds = new Set<string>();
  const sourceTexts = new Set<string>();
  const roots = runRoots(state, directory), snapshots = new Map<string, ReturnType<typeof committedOwnedSources>>();
  const snapshot = (commit: string) => {
    let value = snapshots.get(commit);
    if (!value) { value = committedOwnedSources(state, roots, commit); snapshots.set(commit, value); }
    return value;
  };
  const addSource = (node: Pick<TaskRecord, 'task'>, commit: string, expectedDigest?: string) => {
    const version = taskVersion(node.task), key = canonicalMathJson([node.task.id, version, commit]);
    if (sourceIds.has(key)) return;
    try {
      const selected = snapshot(commit), file = node.task.proofPath;
      if (!file || !Object.hasOwn(selected.files, file) || expectedDigest && selected.digest !== expectedDigest)
        throw new Error('web_bridge_source_identity_mismatch');
      const source = selected.files[file], dependencySources = Object.entries(selected.files)
        .filter(([dependency]) => dependency !== file && dependency.endsWith('.lean'))
        .map(([file, source]) => ({ file, source }));
      const newTexts = [...new Set([source, ...dependencySources.map(dependency => dependency.source)])]
        .filter(text => !sourceTexts.has(text));
      const bytes = newTexts.reduce((sum, text) => sum + Buffer.byteLength(text), 0);
      if (sourceBytes + bytes > maxSourcesBytes) { sourcePartial = true; return; }
      sources.push({ taskId: node.task.id, taskVersion: version, commit, sourceDigest: selected.digest,
        environmentDigest: state.environmentDigest, file, source, scope: 'owned-file',
        ...(dependencySources.length ? { dependencySources } : {}) });
      for (const text of newTexts) sourceTexts.add(text);
      sourceBytes += bytes; sourceIds.add(key);
    } catch { sourcePartial = true; }
  };
  const addProof = (node: Pick<TaskRecord, 'task'>, proof: ProofCheck, original?: SolverRunState['problem']['targets'][number]) => {
    const version = taskVersion(node.task);
    if ('taskDigest' in proof && proof.taskDigest !== version) { sourcePartial = true; checkPartial = true; return; }
    addSource(node, proof.commit, proof.sourceDigest);
    for (const receipt of proof.verification.results) {
      if (receipt.proofPath !== node.task.proofPath || receipt.theoremName !== node.task.theoremName) continue;
      const id = receipt.receiptId || `observation-${mathDigest(canonicalMathJson(receipt))}`;
      const key = canonicalMathJson([node.task.id, version, proof.commit, id, proof.verification.checkedAt, original ? proof.passed : null]);
      if (checkIds.has(key)) continue;
      // The original-problem check can pass one target while failing the batch.
      const passed = original ? proofReceiptsMatch({ ...proof.verification, status: receipt.status, results: [receipt] }, proof.commit, [{
        proofPath: original.proofPath, theoremName: original.theoremName, expectedSourceDeclarationHash: original.declarationHash,
        statementHash: state.problem.contract.statementHash, leanStatementHash: state.problem.contract.leanStatementHash, claim: 'statement',
      }]) : proof.passed;
      const record = { ...receipt, passed,
        ...(original ? { originalProblemPassed: proof.passed } : {}),
        ...('conditions' in proof ? { conditions: proof.conditions ?? [] } : {}),
        ...('references' in proof ? { references: proof.references } : {}),
        verification: { schema: proof.verification.schema, status: proof.verification.status,
          targetCommit: proof.verification.targetCommit, startedAt: proof.verification.startedAt,
          checkedAt: proof.verification.checkedAt, durationMs: proof.verification.durationMs },
        evidence: 'recorded-not-replayed', acceptance: 'not-assessed' };
      const bytes = Buffer.byteLength(canonicalMathJson(record));
      if (checkBytes + bytes > maxChecksBytes) { checkPartial = true; continue; }
      checks.push({ id, taskId: node.task.id, taskVersion: version, commit: proof.commit, sourceDigest: proof.sourceDigest,
        environmentDigest: state.environmentDigest, record });
      checkBytes += bytes; checkIds.add(key);
    }
  };
  for (const node of [...(state.cooperation?.tasks ?? []), ...(state.cooperation?.history ?? [])]) {
    if (!['lemma', 'goal'].includes(node.task.kind)) continue;
    let hasProof = false;
    for (const proof of [node.proof, node.integratedCheck]) if (proof) { addProof(node, proof); hasProof = true; }
    if (hasProof || !state.cooperation?.tasks.includes(node as TaskRecord)) continue;
    const current = node as TaskRecord;
    let commit = state.cooperation?.canonicalCommit;
    if (current.assignment && current.assignment.taskDigest === taskVersion(current.task)) {
      const worker = state.workers?.find(item => item.id === current.assignment!.workerId);
      if (worker && roots.includes(worker.worktree)) {
        try { commit = mathGitBytes(worker.worktree, ['rev-parse', 'HEAD'], { maxBuffer: 128, timeout: 3_000 }).toString('utf8').trim(); }
        catch { sourcePartial = true; }
      }
    }
    if (commit) addSource(node, commit); else sourcePartial = true;
  }
  const wholeChecks = [state.check, ...(state.workers ?? []).map(worker => worker.check)]
    // Cooperative workers also retain their most recent task-scoped proof in check.
    .filter((proof): proof is ProofCheck => proof !== undefined && !('taskDigest' in proof));
  for (const [index, target] of state.problem.targets.entries()) {
    const node = state.cooperation?.tasks.find(item => item.task.kind === 'goal' &&
      item.task.proofPath === target.proofPath && item.task.theoremName === target.theoremName);
    // Direct and independent runs use the same frozen target identity as their knowledge evidence.
    const task = node?.task ?? { id: `original_goal_${index + 1}`, kind: 'goal' as const,
      objective: `Prove ${target.theoremName}`, revision: 0, dependsOn: [], ...target };
    let found = false;
    for (const proof of wholeChecks) {
      if (proof.verification.results.some(receipt => receipt.proofPath === target.proofPath && receipt.theoremName === target.theoremName)) {
        addProof({ task }, proof, target);
        found = true;
      } else checkPartial = true;
    }
    if (!node && !found) sourcePartial = true;
  }
  return { sources, checks, coverage: { sources: sourcePartial ? 'partial' as const : 'recorded' as const,
    checks: checkPartial ? 'partial' as const : 'recorded' as const } };
}

const catalogKey = (state: SolverRunState, declarations: ReturnType<typeof projectWebDeclarationArtifacts>) => mathDigest(canonicalMathJson({
  records: [...(state.cooperation?.tasks ?? []), ...(state.cooperation?.history ?? [])].map(node =>
    ({ task: node.task, proof: node.proof, integratedCheck: node.integratedCheck, finding: node.finding })),
  deliveries: state.cooperation?.deliveries,
  declarations,
}));

export function createWebWorkerBridge(options: {
  webRunId: string; output: string; directory: string; apiKey?: string;
  /** The host authorizes one transition; directory stays fixed while output points at the new round. */
  libraryRestart?: LibraryRestart;
  onMessage?(message: WorkerMessage, frame?: WorkerObservationFrame): void;
}) {
  const directory = fs.realpathSync(options.directory), metaFile = path.join(directory, 'web-bridge.json');
  if (!childOf(directory, path.resolve(options.output))) throw new Error('web_bridge_output_outside_run');
  if (options.libraryRestart && (!Number.isSafeInteger(options.libraryRestart.round) || options.libraryRestart.round < 1 ||
      !options.libraryRestart.previousSolverRunId)) throw new Error('web_bridge_run_identity_changed');
  // Each new bridge starts with a self-contained frame. Retain only the previous frame's digests.
  let emittedSources = new Set<string>();
  let captured = false;
  async function capture(input: { includeCatalog?: boolean; force?: boolean; waitMs?: number } = {}) {
    const messages: WorkerMessage[] = [];
    const result = await withMathRuntimeLease({ lockPath: path.join(directory, 'web-bridge.lock'), flockExecutable: '/usr/bin/flock',
      waitMs: input.waitMs }, async lease => {
      const stored = readRunInspection(options.output), { state, stateFile } = stored;
      if (options.libraryRestart?.previousSolverRunId === state.runId) throw new Error('web_bridge_run_identity_changed');
      const { agentTeam, ...report } = buildRunInspection(state, stored.result);
      const teamSources = new Map<string, ReturnType<typeof committedOwnedSources>>();
      const nativeTeam = agentTeam && projectWebNativeTeam(state, directory, agentTeam, (archive, commit) => {
        const key = archive + '\0' + commit, cached = teamSources.get(key);
        if (cached) return cached;
        const snapshot = committedOwnedSources(state, [archive], commit);
        const source = options.apiKey ? { ...snapshot,
          files: Object.fromEntries(Object.entries(snapshot.files).filter(([, text]) => !text.includes(options.apiKey!))) } : snapshot;
        teamSources.set(key, source);
        return source;
      });
      const inspection = { ...report, ...(nativeTeam ? { nativeTeam } : agentTeam ? { agentTeam } : {}) };
      const previous = bridgeMeta(metaFile, options.webRunId, state.runId, options.libraryRestart);
      const restarted = Boolean(previous && previous.solverRunId !== state.runId);
      const projection = sourceProjection(state, directory);
      const declarations = projectWebDeclarationArtifacts(stateFile, state);
      const history = state.cooperation?.history?.length ? buildRunInspection({ ...state,
        cooperation: { ...state.cooperation, tasks: state.cooperation.history.map(node => ({ status: 'pending', attempts: 0, ...node })) as TaskRecord[] } }).tasks : [];
      let plan: ReturnType<typeof exportRunPlan> | null = null;
      if (state.cooperation?.planVersion && state.cooperation.tasks.length) plan = exportRunPlan(state);
      const payload = { inspection, snapshot: inspection.snapshot, plan, ...projection, declarations,
        guidance: readHumanGuidance(stateFile, state.runId), deliveries: state.cooperation?.deliveries ?? [], history };
      let observation: WebObservation = { schema: 'theorem-os.web-observation.v1', webRunId: options.webRunId,
        solverRunId: state.runId, sequence: 0, observedAt: new Date().toISOString(), evidence: 'recorded-not-replayed',
        acceptance: 'not-assessed', ...payload };
      let frame = standaloneObservationFrame(observation);
      const contentDigest = mathDigest(canonicalMathJson({ ...frame.observation, observedAt: '' }));
      const changed = restarted || previous?.contentDigest !== contentDigest;
      const sequence = (previous?.sequence ?? 0) + Number(changed);
      const libraryRestart = previous && options.libraryRestart && { ...options.libraryRestart, solverRunId: state.runId };
      // Capture through docker exec can commit the new metadata before the streaming worker does.
      const announceRestart = libraryRestart && options.onMessage && !captured;
      if (announceRestart) messages.push({ type: 'library_restart', ...libraryRestart });
      observation.sequence = sequence;
      frame.observation.sequence = sequence;
      let frameJson = JSON.stringify(frame);
      const secret = options.apiKey && JSON.stringify(options.apiKey).slice(1, -1);
      if (secret && frameJson.includes(secret)) {
        observation = JSON.parse(JSON.stringify(observation).replaceAll(secret, '[REDACTED]'));
        observation.coverage.sources = 'partial'; observation.coverage.checks = 'partial';
        frame = standaloneObservationFrame(observation);
        frameJson = JSON.stringify(frame);
      }
      if (Buffer.byteLength(frameJson) > maxWorkerObservationBytes) throw new Error('web_observation_too_large');
      const meta: BridgeMeta = { schema: 'theorem-os.web-bridge.v1', webRunId: options.webRunId, solverRunId: state.runId,
        libraryRound: options.libraryRestart?.round ?? previous?.libraryRound ?? 0,
        sequence, contentDigest,
        ...(previous?.catalogKey ? { catalogKey: previous.catalogKey } : {}),
        ...(previous?.catalogDigest ? { catalogDigest: previous.catalogDigest } : {}) };
      let catalog: TheoremKnowledgeBase | undefined;
      const key = catalogKey(state, declarations), catalogFile = path.join(directory, 'web-catalog.json');
      if (restarted || key !== previous?.catalogKey) {
        try {
          const imported = importKnowledgeRuns([stateFile], { includeFindings: true });
          if (buildRunInspection(readRunInspection(options.output).state).snapshot.stateDigest !== inspection.snapshot.stateDigest)
            throw new Error('web_catalog_state_changed');
          const base = fs.existsSync(catalogFile) ? validateTheoremKnowledge(JSON.parse(readMathText(catalogFile, maxWorkerObservationBytes))) : undefined;
          const candidate = buildTheoremKnowledge(imported.candidates, base, imported.findings);
          const text = canonicalMathJson(candidate);
          if (options.apiKey && text.includes(options.apiKey)) throw new Error('web_catalog_secret_redacted');
          if (Buffer.byteLength(text) > maxWorkerObservationBytes) throw new Error('web_catalog_too_large');
          const digest = mathDigest(text);
          if (digest !== previous?.catalogDigest) { writeMathJsonDurable(catalogFile, candidate); catalog = candidate; }
          meta.catalogKey = key; meta.catalogDigest = digest;
          if (imported.skipped.length) messages.push({ type: 'progress', event: 'knowledge_capture_partial',
            message: `知识归档保留已匹配来源的记录；${imported.skipped.length} 条记录暂未导入：${[...new Set(imported.skipped.map(item => item.reason))].slice(0, 4).join('、')}。历史记录均须重新复核。` });
        } catch (error) {
          messages.push({ type: 'progress', event: 'knowledge_capture_partial',
            message: `知识归档尚未完整捕获：${error instanceof Error ? error.message : 'web_catalog_unavailable'}。已有证明状态不变，未用空知识库替代。` });
        }
      }
      if (input.includeCatalog && !catalog && fs.existsSync(catalogFile)) {
        catalog = validateTheoremKnowledge(JSON.parse(readMathText(catalogFile, maxWorkerObservationBytes)));
      }
      lease.assertHeld();
      if (!previous || canonicalMathJson(previous) !== canonicalMathJson(meta)) writeMathJsonDurable(metaFile, meta);
      captured = true;
      if (changed || input.force || announceRestart) messages.push({ type: 'observation', observation });
      if (catalog) messages.push({ type: 'catalog', catalog });
      return { frame, result: { observation, ...(catalog ? { catalog } : {}), ...(libraryRestart ? { libraryRestart } : {}) } };
    });
    for (const message of messages) {
      if (!options.onMessage) break;
      if (message.type !== 'observation') { options.onMessage(message); continue; }
      const blobs = Object.entries(result.frame.sourceBlobs);
      const sourceBlobs = Object.fromEntries(blobs.filter(([digest]) => !emittedSources.has(digest)));
      options.onMessage(message, { ...result.frame, sourceBlobs });
      emittedSources = new Set(blobs.map(([digest]) => digest));
    }
    return result.result;
  }
  return { capture };
}

const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('plan-approval'), approval: planApprovalInputSchema }).strict(),
  z.object({ type: z.literal('capture') }).strict(),
]);

export async function handleWebWorkerCommand(value: unknown, options: { activeRunFile?: string } = {}): Promise<WebCommandResult> {
  if (value && typeof value === 'object' && 'type' in value &&
      ['edit-preview', 'edit', 'guidance', 'guidance-withdraw'].includes(String(value.type)))
    throw new Error(retiredResearchCoordinationCode);
  const command = commandSchema.parse(value);
  const active = readActiveRun(options.activeRunFile ?? webActiveRunFile);
  if (command.type === 'capture') return { id: 'capture', status: 'captured',
    ...await createWebWorkerBridge(active).capture({ includeCatalog: true, force: true, waitMs: 5_000 }) };
  try { return { ...await queuePlanApproval(active.output, command.approval) }; }
  catch (error) {
    // Each of these is decided from the saved checkpoint before anything is written.
    const reason = error instanceof Error ? error.message : '';
    if (['math_plan_approval_invalid', 'math_plan_approval_id_conflict', 'math_plan_approval_not_required',
      'math_plan_approval_run_inactive', 'math_plan_approval_already_approved', 'math_plan_approval_plan_unavailable',
      'math_plan_approval_version_conflict', 'math_plan_approval_limit'].includes(reason))
      return { id: command.approval.id, status: 'rejected', reason, planVersion: command.approval.planVersion };
    throw error;
  }
}
