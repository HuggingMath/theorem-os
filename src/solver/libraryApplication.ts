import fs from 'node:fs';
import path from 'node:path';
import { mathConstructionImportSpans } from '../math/mathConstructionSources';
import { inspectLeanDeclarationRegions, inspectLeanSource, inspectScopedLeanDeclarations } from '../math/leanSource';
import { maskLeanCommentsAndStrings } from '../math/leanSyntax';
import type { KnowledgeContextSnapshot } from './knowledgeContext';
import { installedLibraryRetrievals } from './installedLibraryContext';
import { committedSource, commitSolverSources, git, withSolverWorktree, type SolverProblem } from './problem';
import { checkTaskProof, type TaskProof } from './cooperativeProof';
import { knowledgeReferenceCoverage } from './knowledgeUsage';
import { tacticBatterySource } from './tacticBattery';
import { isDefinitionTask, taskVersion, type CooperativeTask } from './tasks';

export const LIBRARY_APPLICATION_TIMEOUT_MS = 30_000;
const MAX_CANDIDATES = 12;
export type LibraryApplicationCandidate = { name: string; file: string };
export type LibraryApplicationResult = {
  status: 'candidate' | 'skipped' | 'unavailable'; reason: string; commit?: string;
  candidates: LibraryApplicationCandidate[];
};

/** Every alternative must apply a selected theorem; premise automation cannot prove the target on its own. */
export function libraryApplicationProof(candidates: readonly LibraryApplicationCandidate[]): string {
  const references = candidates.map(({ name }) => `_root_.${name.replace(/^_root_\./u, '')}`);
  return 'by first | ' + references.map((reference, index) => {
    const applications = [
      (premises: string) => `apply ${reference} <;> ${premises}`,
      ...['mp', 'mpr'].map(direction => (premises: string) =>
        `apply Iff.${direction}; (apply ${reference} <;> ${premises}); ${premises}`),
      (premises: string) => `apply Eq.symm; apply ${reference} <;> ${premises}`,
      (premises: string) => `rw [${reference}] <;> ${premises}`,
      // Expose implicit parameters and instance goals before resolving them from local premises.
      (premises: string) => `refine' @${reference} .. <;> ${premises}`,
    ];
    const alternatives = [`(solve | exact ${reference})`, ...applications.map((application, mode) =>
      `(solve | intros; ${application(`(first | assumption | rfl${mode === 0 ? ' | trivial' : ''})`)})`)];
    const auxiliaries = references.filter((_, other) => other !== index).map(auxiliary =>
      `(solve | apply ${auxiliary} <;> first | assumption | rfl)`);
    if (auxiliaries.length) alternatives.push(...applications.map(application =>
      `(solve | intros; ${application(`(first | assumption | rfl | ${auxiliaries.join(' | ')})`)})`));
    return '(first | ' + alternatives.join(' | ') + ')';
  }).join(' | ');
}

/** Preserve module/prelude headers and existing imports; only selected frozen modules are added. */
function withLibraryImports(source: string, candidates: readonly LibraryApplicationCandidate[]): string {
  const spans = mathConstructionImportSpans(source), present = new Set(spans.map(span => span.name));
  const modules = [...new Set(candidates.map(item => item.file.slice(0, -5).replaceAll('/', '.')))]
    .filter(module => !present.has(module));
  if (!modules.length) return source;
  const lineEnd = spans.length ? source.indexOf('\n', spans.at(-1)!.end) : -1;
  const offset = spans.length ? lineEnd < 0 ? source.length : lineEnd + 1 :
    maskLeanCommentsAndStrings(source).match(/^\s*(?:(?:module|prelude)\b\s*)*/u)![0].length;
  const prefix = source.slice(0, offset);
  return prefix + (prefix && !prefix.endsWith('\n') ? '\n' : '') + modules.map(module => `import ${module}\n`).join('') +
    source.slice(offset);
}

/** Prepare an actual import/application for the ordinary task checker, without editing the idle worker. */
export async function prepareLibraryApplication(input: {
  problem: SolverProblem; task: CooperativeTask; library: KnowledgeContextSnapshot; environmentDigest: string;
  worktree: string; seedCommit: string; context?: string; taskText?: string;
}): Promise<LibraryApplicationResult> {
  const { problem, task, library } = input;
  const skipped = (reason: string): LibraryApplicationResult => ({ status: 'skipped', reason, candidates: [] });
  if (!['goal', 'lemma'].includes(task.kind) || isDefinitionTask(task) || !task.proofPath || !task.theoremName)
    return skipped('not-theorem-task');
  const entries = new Map(library.base.entries.map(entry => [entry.id, entry]));
  const retrievals = installedLibraryRetrievals({ problem, library, taskText: input.taskText, forApplication: true,
    action: { kind: 'task', task, assignment: { taskId: task.id, taskDigest: taskVersion(task), workerId: 'host', seedCommit: input.seedCommit } },
    environmentDigest: input.environmentDigest });
  const candidates: LibraryApplicationCandidate[] = [], selected = new Set<string>();
  // Presentation has only three rows. Try the full relevance-selected pool; raw hits
  // remain diagnostics. Older retrievals retain their existing bounded fallback.
  for (const id of retrievals.flatMap(retrieval => [...(retrieval.relevantCandidateIds ?? retrieval.searchCandidateIds ?? []), ...retrieval.candidateIds])) {
    const entry = entries.get(id), pinned = entry && problem.frozenFiles?.[entry.file];
    if (entry?.kind !== 'lemma' || !pinned || pinned !== library.base.contexts[entry.contextDigest]?.[entry.file]) continue;
    const key = `${entry.file}:${entry.name}`;
    if (selected.has(key)) continue;
    selected.add(key); candidates.push({ name: entry.name, file: entry.file });
    if (candidates.length === MAX_CANDIDATES) break;
  }
  if (!candidates.length) return skipped('no-matching-installed-theorem');
  let source: string, edited: string | undefined;
  try {
    source = committedSource(input.worktree, input.seedCommit, path.posix.join(problem.projectRelative, task.proofPath));
    const proof = libraryApplicationProof(candidates);
    if (task.kind === 'lemma') {
      const requested = task.theoremName.replace(/^_root_\./u, ''), namespace = requested.split('.').slice(0, -1).join('.');
      const declarations = inspectScopedLeanDeclarations(source);
      const anchor = input.context ?? declarations.find(item => item.qualifiedName === requested)?.qualifiedName ??
        declarations.find(item => item.namespace === namespace && problem.targets.some(target =>
          target.proofPath === task.proofPath && target.theoremName === item.qualifiedName))?.qualifiedName ??
        declarations.find(item => item.namespace === namespace)?.qualifiedName;
      if (anchor) edited = tacticBatterySource(problem, source, task, anchor, proof);
    } else {
      const matches = inspectScopedLeanDeclarations(source).filter(item => item.qualifiedName === task.theoremName!.replace(/^_root_\./u, ''));
      if (matches.length === 1 && matches[0].kind === 'theorem') {
        const region = inspectLeanDeclarationRegions(source).find(item => item.startOffset === matches[0].startOffset)!;
        const body = inspectLeanSource(source.slice(region.bodyOffset, region.endOffset));
        if (body.sorryCount || body.admitCount) edited = source.slice(0, region.bodyOffset) + ` ${proof}\n` + source.slice(region.endOffset);
      }
    }
    if (edited) edited = withLibraryImports(edited, candidates);
  } catch { return { status: 'unavailable', reason: 'source-context-unavailable', candidates }; }
  if (!edited) return { status: 'skipped', reason: 'placement-unavailable', candidates };
  try {
    const commit = await withSolverWorktree(input.worktree, input.seedCommit, async checkout => {
      fs.writeFileSync(path.join(checkout, problem.projectRelative, task.proofPath!), edited);
      return commitSolverSources(problem, checkout);
    });
    return { status: 'candidate', reason: 'installed-theorem-application-prepared', candidates, commit };
  } catch { return { status: 'unavailable', reason: 'candidate-commit-unavailable', candidates }; }
}

/** The single-worker Web path has no cooperative task graph; check its frozen targets before opening a model. */
export async function applyOriginalLibraryTasks(input: {
  problem: SolverProblem; library: KnowledgeContextSnapshot; environmentDigest: string; worktree: string; workerId: string;
  env: NodeJS.ProcessEnv; signal: AbortSignal; timeoutMs: number; taskText?: string;
  prepare: typeof prepareLibraryApplication; check: typeof checkTaskProof;
  emit: (event: string, details: Record<string, unknown>) => void;
  onProof: (task: CooperativeTask, proof: TaskProof) => void;
}): Promise<number> {
  const started = Date.now(), timeoutMs = Math.min(input.timeoutMs, LIBRARY_APPLICATION_TIMEOUT_MS);
  let closed = 0;
  for (const [index, target] of input.problem.targets.entries()) {
    if (input.signal.aborted || Date.now() - started >= timeoutMs) break;
    const task: CooperativeTask = { ...target, id: `original_goal_${index + 1}`, kind: 'goal', revision: 0, dependsOn: [],
      objective: `Prove ${target.theoremName}` };
    const seedCommit = commitSolverSources(input.problem, input.worktree);
    const application = await input.prepare({ ...input, task, seedCommit });
    let proof: TaskProof | undefined, checkError: string | undefined;
    if (application.status === 'candidate' && application.commit && !input.signal.aborted && Date.now() - started < timeoutMs) {
      try {
        proof = await input.check(input.problem, input.worktree, application.commit, task,
          { taskId: task.id, taskDigest: taskVersion(task), workerId: input.workerId, seedCommit },
          [], input.env, input.signal, timeoutMs - (Date.now() - started), [], input.environmentDigest);
      } catch (error) { checkError = String(error instanceof Error ? error.message : error).slice(0, 1000); }
    }
    const references = proof && knowledgeReferenceCoverage(task, proof);
    input.emit('task_library_application', { taskId: task.id, taskDigest: taskVersion(task), workerId: input.workerId,
      seedCommit, libraryDigest: input.library.digest, candidates: application.candidates,
      status: application.status, reason: application.reason,
      ...(checkError ? { checkError } : {}), ...(application.commit ? { commit: application.commit } : {}),
      ...(references ? { referenceCoverage: references.coverage, usedDeclarations: application.candidates.filter(candidate =>
        references.references?.some(reference => reference.name === candidate.name && reference.file === candidate.file)) } : {}),
      ...(proof ? { passed: proof.passed, verificationStatus: proof.verification.status,
        receiptIds: proof.verification.results.map(result => result.receiptId) } : {}) });
    if (!proof?.passed || input.signal.aborted || git(input.worktree, ['rev-parse', 'HEAD']) !== seedCommit) continue;
    // The candidate is a direct child of this idle worker's exact seed. A fast-forward preserves its checked commit.
    git(input.worktree, ['merge', '--ff-only', '--no-edit', application.commit!]);
    closed++;
    input.onProof(task, proof);
  }
  return closed;
}
