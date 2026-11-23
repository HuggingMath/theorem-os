import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { mathGitBytes } from '../../src/math/mathGit';
import { canonicalMathJson, mathDigest, readMathText, withMathRuntimeLease, writeMathFrozen,
  writeMathJsonDurable } from '../../src/math/mathRuntimeIo';
import { assertMathCanonicalPath } from '../../src/math/paths';
import type { SolverRunState } from '../../src/solver/archive';
import { buildRunInspection, exportRunPlan, readRunInspection } from '../../src/solver/inspection';
import { queuePlanApproval, queueRunEdit } from '../../src/solver/humanEdit';
import { planApprovalInputSchema } from '../../src/solver/planApproval';
import { humanGuidanceInputSchema, queueHumanGuidance, readHumanGuidance, withdrawHumanGuidance } from '../../src/solver/humanGuidance';
import { parseCooperationPlan, taskGroup, taskVersion, type TaskRecord } from '../../src/solver/tasks';
import { allowedKnowledgeFile, buildTheoremKnowledge, validateTheoremKnowledge, type TheoremKnowledgeBase } from '../../src/solver/theoremKnowledge';
import { importKnowledgeRuns } from '../../src/solver/theoremKnowledgeRuns';
import type { ProofCheck } from '../../src/solver/modules/evidence';
import type { WebCheckReceipt, WebCommand, WebCommandResult, WebObservation, WebTaskSource } from './collaboration';
import type { WorkerMessage } from './shared';
import { projectWebDeclarationArtifacts } from './declarationArtifacts';
import { projectWebNativeTeam } from './nativeTeamObservation';

export const webActiveRunFile = '/work/active-run.json';
const activeRunSchema = z.object({ schema: z.literal('theorem-os.web-active-run.v1'),
  webRunId: z.string().min(1).max(128), directory: z.string().min(1), output: z.string().min(1) }).strict();
type ActiveRun = z.infer<typeof activeRunSchema>;
const metaSchema = z.object({ schema: z.literal('theorem-os.web-bridge.v1'), webRunId: z.string(), solverRunId: z.string(),
  libraryRound: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  sequence: z.number().int().nonnegative(), contentDigest: z.string(),
  observations: z.array(z.object({ sequence: z.number().int().nonnegative(), stateDigest: z.string() })),
  catalogKey: z.string().optional(), catalogDigest: z.string().optional(),
}).strict();
type BridgeMeta = z.infer<typeof metaSchema>;
const maxSourceBytes = 4 * 1024 * 1024, maxSourcesBytes = 6 * 1024 * 1024, maxChecksBytes = 2 * 1024 * 1024;
const maxMessageBytes = 15 * 1024 * 1024;
const oid = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const childOf = (directory: string, file: string) => path.isAbsolute(file) && file.startsWith(directory + path.sep);
const relativePath = (file: string) => file && !path.isAbsolute(file) && !file.includes('\\') &&
  file.split('/').every(part => part && part !== '.' && part !== '..');

export function writeWebActiveRun(input: { webRunId: string; directory: string; output: string }, file = webActiveRunFile): void {
  const directory = fs.realpathSync(input.directory), output = path.resolve(input.output);
  if (!childOf(directory, output)) throw new Error('web_bridge_output_outside_run');
  writeMathJsonDurable(file, { schema: 'theorem-os.web-active-run.v1', webRunId: input.webRunId, directory, output });
}

function readActiveRun(file: string): ActiveRun {
  const value = activeRunSchema.parse(JSON.parse(readMathText(file, 8_192)));
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

type LibraryRestart = { previousSolverRunId: string; round: number };
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
      const bytes = Buffer.byteLength(source) + dependencySources.reduce((sum, dependency) => sum + Buffer.byteLength(dependency.source), 0);
      if (sourceBytes + bytes > maxSourcesBytes) { sourcePartial = true; return; }
      sources.push({ taskId: node.task.id, taskVersion: version, commit, sourceDigest: selected.digest,
        environmentDigest: state.environmentDigest, file, source, scope: 'owned-file',
        ...(dependencySources.length ? { dependencySources } : {}) });
      sourceBytes += bytes; sourceIds.add(key);
    } catch { sourcePartial = true; }
  };
  const addProof = (node: Pick<TaskRecord, 'task'>, proof: ProofCheck) => {
    const version = taskVersion(node.task);
    if ('taskDigest' in proof && proof.taskDigest !== version) { sourcePartial = true; checkPartial = true; return; }
    addSource(node, proof.commit, proof.sourceDigest);
    for (const receipt of proof.verification.results) {
      const id = receipt.receiptId || `observation-${mathDigest(canonicalMathJson(receipt))}`;
      const key = canonicalMathJson([node.task.id, version, proof.commit, id]);
      if (checkIds.has(key)) continue;
      const record = { ...receipt, passed: proof.passed,
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
  if (state.check) for (const node of state.cooperation?.tasks ?? []) if (node.task.kind === 'goal' &&
      state.check.verification.results.some(receipt => receipt.proofPath === node.task.proofPath && receipt.theoremName === node.task.theoremName))
    addProof(node, state.check);
  if (!state.cooperation?.tasks.length && state.problem.targets.length) sourcePartial = true;
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
  onMessage?(message: WorkerMessage): void;
}) {
  const directory = fs.realpathSync(options.directory), metaFile = path.join(directory, 'web-bridge.json');
  if (!childOf(directory, path.resolve(options.output))) throw new Error('web_bridge_output_outside_run');
  if (options.libraryRestart && (!Number.isSafeInteger(options.libraryRestart.round) || options.libraryRestart.round < 1 ||
      !options.libraryRestart.previousSolverRunId)) throw new Error('web_bridge_run_identity_changed');
  async function capture(input: { includeCatalog?: boolean; force?: boolean } = {}) {
    const messages: WorkerMessage[] = [];
    const result = await withMathRuntimeLease({ lockPath: path.join(directory, 'web-bridge.lock'), flockExecutable: '/usr/bin/flock' }, async lease => {
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
      const contentDigest = mathDigest(canonicalMathJson(payload));
      const changed = restarted || previous?.contentDigest !== contentDigest;
      const sequence = (previous?.sequence ?? 0) + Number(changed);
      if (restarted) messages.push({ type: 'library_restart', previousSolverRunId: previous!.solverRunId,
        solverRunId: state.runId, round: options.libraryRestart!.round });
      let observation: WebObservation = { schema: 'theorem-os.web-observation.v1', webRunId: options.webRunId,
        solverRunId: state.runId, sequence, observedAt: new Date().toISOString(), evidence: 'recorded-not-replayed',
        acceptance: 'not-assessed', ...payload };
      if (options.apiKey && canonicalMathJson(observation).includes(options.apiKey)) {
        observation = JSON.parse(JSON.stringify(observation).replaceAll(JSON.stringify(options.apiKey).slice(1, -1), '[REDACTED]'));
        observation.coverage.sources = 'partial'; observation.coverage.checks = 'partial';
      }
      if (Buffer.byteLength(canonicalMathJson(observation)) > maxMessageBytes) throw new Error('web_observation_too_large');
      const meta: BridgeMeta = { schema: 'theorem-os.web-bridge.v1', webRunId: options.webRunId, solverRunId: state.runId,
        libraryRound: options.libraryRestart?.round ?? previous?.libraryRound ?? 0,
        sequence, contentDigest, observations: [...(restarted ? [] : previous?.observations ?? []),
          ...(changed ? [{ sequence, stateDigest: inspection.snapshot.stateDigest }] : [])].slice(-64),
        ...(previous?.catalogKey ? { catalogKey: previous.catalogKey } : {}),
        ...(previous?.catalogDigest ? { catalogDigest: previous.catalogDigest } : {}) };
      let catalog: TheoremKnowledgeBase | undefined;
      const key = catalogKey(state, declarations), catalogFile = path.join(directory, 'web-catalog.json');
      if (restarted || key !== previous?.catalogKey) {
        try {
          const imported = importKnowledgeRuns([stateFile], { includeFindings: true });
          if (buildRunInspection(readRunInspection(options.output).state).snapshot.stateDigest !== inspection.snapshot.stateDigest)
            throw new Error('web_catalog_state_changed');
          const base = fs.existsSync(catalogFile) ? validateTheoremKnowledge(JSON.parse(readMathText(catalogFile, maxMessageBytes))) : undefined;
          const candidate = buildTheoremKnowledge(imported.candidates, base, imported.findings);
          const text = canonicalMathJson(candidate);
          if (options.apiKey && text.includes(options.apiKey)) throw new Error('web_catalog_secret_redacted');
          if (Buffer.byteLength(text) > maxMessageBytes) throw new Error('web_catalog_too_large');
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
        catalog = validateTheoremKnowledge(JSON.parse(readMathText(catalogFile, maxMessageBytes)));
      }
      lease.assertHeld(); writeMathJsonDurable(metaFile, meta);
      if (changed || input.force) messages.push({ type: 'observation', observation });
      if (catalog) messages.push({ type: 'catalog', catalog });
      return { observation, ...(catalog ? { catalog } : {}) };
    });
    for (const message of messages) options.onMessage?.(message);
    return result;
  }
  return { capture };
}

function previewEdit(state: SolverRunState, proposal: unknown) {
  const proposed = parseCooperationPlan(state.problem, proposal), previous = new Map(state.cooperation?.tasks.map(node => [node.task.id, node.task]) ?? []);
  const changes: { taskId: string; fields: string[] }[] = [];
  const oldGroups = new Map(state.cooperation?.groups?.map(record => [record.group.id, record.group]) ?? []);
  const affected = new Set<string>(), mathematical = new Set<string>();
  for (const task of proposed.tasks) {
    const before = previous.get(task.id), fields: string[] = [];
    if (!before) fields.push('added');
    else for (const key of new Set([...Object.keys(before), ...Object.keys(task)])) {
      if (canonicalMathJson((before as Record<string, unknown>)[key] ?? null) !== canonicalMathJson((task as Record<string, unknown>)[key] ?? null)) fields.push(key);
    }
    const group = proposed.groups.find(item => item.id === taskGroup(task)), oldGroup = oldGroups.get(taskGroup(task));
    if (group && oldGroup) for (const key of new Set([...Object.keys(group), ...Object.keys(oldGroup)])) {
      if (canonicalMathJson((group as Record<string, unknown>)[key] ?? null) !== canonicalMathJson((oldGroup as Record<string, unknown>)[key] ?? null)) fields.push(`group.${key}`);
    }
    if (fields.length) { changes.push({ taskId: task.id, fields }); affected.add(task.id); }
    if (!before || taskVersion(before) !== taskVersion(task) || fields.some(field => ['group.objective', 'group.revision'].includes(field))) mathematical.add(task.id);
  }
  for (const id of previous.keys()) if (!proposed.tasks.some(task => task.id === id)) { changes.push({ taskId: id, fields: ['removed'] }); affected.add(id); mathematical.add(id); }
  if (canonicalMathJson(state.cooperation?.proofRoutes ?? []) !== canonicalMathJson(proposed.proofRoutes ?? [])) {
    for (const route of [...(state.cooperation?.proofRoutes ?? []), ...(proposed.proofRoutes ?? [])]) {
      affected.add(route.targetTaskId); mathematical.add(route.targetTaskId);
      const existing = changes.find(change => change.taskId === route.targetTaskId);
      if (existing) { if (!existing.fields.includes('proofRoutes')) existing.fields.push('proofRoutes'); }
      else changes.push({ taskId: route.targetTaskId, fields: ['proofRoutes'] });
    }
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const task of proposed.tasks) if (!mathematical.has(task.id) && task.dependsOn.some(id => mathematical.has(id))) {
      mathematical.add(task.id); affected.add(task.id); changed = true;
    }
  }
  return { affectedTaskIds: [...affected], changes };
}

const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('edit-preview'), proposal: z.record(z.unknown()) }).strict(),
  z.object({ type: z.literal('edit'), proposal: z.record(z.unknown()) }).strict(),
  z.object({ type: z.literal('guidance'), guidance: humanGuidanceInputSchema }).strict(),
  z.object({ type: z.literal('guidance-withdraw'), id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/u),
    guidanceId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/u) }).strict(),
  z.object({ type: z.literal('plan-approval'), approval: planApprovalInputSchema }).strict(),
  z.object({ type: z.literal('capture') }).strict(),
]);

export async function handleWebWorkerCommand(value: unknown, options: { activeRunFile?: string } = {}): Promise<WebCommandResult> {
  const command = commandSchema.parse(value) as WebCommand;
  const active = readActiveRun(options.activeRunFile ?? webActiveRunFile);
  const bridge = createWebWorkerBridge({ webRunId: active.webRunId, directory: active.directory, output: active.output });
  if (command.type === 'capture') return { id: 'capture', status: 'captured', ...await bridge.capture({ includeCatalog: true, force: true }) };
  const { state, stateFile } = readRunInspection(active.output);
  if (command.type === 'guidance') {
    try {
      const previous = bridgeMeta(path.join(active.directory, 'web-bridge.json'), active.webRunId, state.runId);
      const alreadyQueued = readHumanGuidance(stateFile, state.runId).some(record => record.id === command.guidance.id);
      if (!alreadyQueued && !previous?.observations.some(item => item.sequence === command.guidance.observationRef.sequence &&
          item.stateDigest === command.guidance.observationRef.stateDigest)) throw new Error('web_guidance_observation_unknown');
      const guidance = await queueHumanGuidance(active.output, command.guidance);
      return { id: guidance.id, status: guidance.status, guidance };
    } catch (error) {
      // These validations finish before the queue write. Transport and persistence failures remain uncertain.
      const reason = error instanceof Error ? error.message : '';
      if (['web_guidance_observation_unknown', 'math_guidance_invalid', 'math_guidance_id_conflict',
        'math_guidance_run_inactive', 'math_guidance_task_superseded', 'math_guidance_worker_missing',
        'math_guidance_lead_missing', 'math_guidance_limit', 'math_guidance_candidate_environment_changed',
        'math_guidance_candidate_file_mismatch', 'math_guidance_candidate_base_mismatch'].includes(reason))
        return { id: command.guidance.id, status: 'rejected', reason };
      throw error;
    }
  }
  if (command.type === 'guidance-withdraw') {
    try {
      const guidance = await withdrawHumanGuidance(active.output, command.guidanceId);
      // A fresh observation carries the settled note so readers see it at once; the withdrawal itself is already durable.
      const observation = await bridge.capture({ force: true }).then(result => result.observation, () => undefined);
      return { id: command.id, status: 'withdrawn', guidance, ...(observation ? { observation } : {}) };
    } catch (error) {
      // Decided under the delivery lock before anything is written.
      const reason = error instanceof Error ? error.message : '';
      if (['math_guidance_invalid', 'math_guidance_unknown', 'math_guidance_already_delivered', 'math_guidance_already_failed'].includes(reason)) {
        // A note delivered first should read as delivered now, not after the next periodic capture.
        const observation = await bridge.capture({ force: true }).then(result => result.observation, () => undefined);
        return { id: command.id, status: 'rejected', reason, ...(observation ? { observation } : {}) };
      }
      throw error;
    }
  }
  if (command.type === 'plan-approval') {
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
  let impact: ReturnType<typeof previewEdit>;
  try { impact = previewEdit(state, command.proposal); }
  catch (error) {
    // The pure preview rejects invalid plans before the edit queue is opened. Queue failures stay uncertain.
    const reason = error instanceof Error ? error.message : '';
    if (/^math_plan_[a-z_]+(?::|$)/u.test(reason))
      return { id: command.proposal.id, status: 'rejected', reason, baseVersion: command.proposal.baseVersion };
    throw error;
  }
  const result = await queueRunEdit(active.output, command.proposal, command.type === 'edit-preview');
  return { ...result, baseVersion: command.proposal.baseVersion, ...impact, commandDigest: mathDigest(canonicalMathJson(command.proposal)) };
}
