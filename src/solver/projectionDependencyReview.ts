import { inspectLeanDeclarationRegions, inspectScopedLeanDeclarations } from '../math/leanSource';
import { mathDigest } from '../math/mathRuntimeIo';
import { createTaskSourceProjector } from './cooperativeProof';
import { committedSource, git, type SolverProblem } from './problem';
import { proofReferencesUnchanged } from './proofReferences';
import { projectionDependencyConnections, type ProjectionDependencyConnection, type ProjectionDependencyHint } from './projectionDependencyHints';
import { freshlyAccepted, taskVersion, type CooperativeTask, type TaskRecord } from './tasks';

/** Bind a failed projection's observations to current source and host-accepted dependencies, without accepting a proof. */
export function reviewProjectionDependencies(input: {
  problem: SolverProblem; worktree: string; canonicalCommit?: string; environmentDigest: string;
  tasks: readonly TaskRecord[]; consumerTaskIds: readonly string[];
  retainedGoals: (task: CooperativeTask) => readonly string[];
}): ProjectionDependencyConnection[] {
  if (!input.canonicalCommit || !input.consumerTaskIds.length) return [];
  let canonical: string;
  try { canonical = git(input.worktree, ['rev-parse', `${input.canonicalCommit}^{commit}`]); }
  catch { return []; }
  const consumers = new Set(input.consumerTaskIds), sources = new Map<string, string>();
  const source = (commit: string, file: string) => {
    const key = commit + '\0' + file;
    if (!sources.has(key)) sources.set(key, committedSource(input.worktree, commit, `${input.problem.projectRelative}/${file}`));
    return sources.get(key)!;
  };
  const rootDigest = (commit: string, root: ProjectionDependencyHint['root']) => {
    if (!input.problem.ownedFiles.includes(root.file)) return;
    const text = source(commit, root.file), matches = inspectScopedLeanDeclarations(text).filter(item => item.qualifiedName === root.name);
    if (matches.length !== 1) return;
    const region = inspectLeanDeclarationRegions(text).find(item => item.startOffset === matches[0]!.startOffset);
    return region ? mathDigest(text.slice(region.startOffset, region.endOffset)) : undefined;
  };
  const projectors = new Map<string, ReturnType<typeof createTaskSourceProjector>>();
  const connections: ProjectionDependencyConnection[] = [];
  for (const node of input.tasks) {
    const proof = node.proof;
    if (!consumers.has(node.task.id) || proof?.passed !== false || proof.taskDigest !== taskVersion(node.task) ||
        !['lemma', 'goal'].includes(node.task.kind) || proof.conditions?.length || node.pendingValidation) continue;
    const environment = proof.projection?.environmentDigest ?? proof.references?.environmentDigest ?? node.assignment?.researchBasis?.environmentDigest;
    if (environment && environment !== input.environmentDigest) continue;
    try {
      const commit = git(input.worktree, ['rev-parse', `${proof.commit}^{commit}`]);
      let projector = projectors.get(commit);
      if (!projector) { projector = createTaskSourceProjector(input.problem, input.worktree, commit); projectors.set(commit, projector); }
      // Regeneration also supports older checkpoints and prevents restored observations from changing projector identity.
      const generated = projector.dependencyHints(node.task, input.retainedGoals(node.task));
      const recorded = proof.projectionDependencyHints;
      const hints = generated.filter(hint => hint.sourceDigest === proof.sourceDigest &&
        (!recorded || recorded.some(item => item?.id === hint.id)));
      connections.push(...projectionDependencyConnections(hints, {
        problemReceiptDigest: input.problem.receiptDigest, sourceCommit: commit, sourceDigest: proof.sourceDigest,
        consumer: node.task, tasks: input.tasks,
        isFreshlyAccepted: (dependency, root) => {
          const accepted = dependency.integratedCheck, references = accepted?.references;
          return freshlyAccepted(dependency, taskVersion(dependency.task)) && !dependency.pendingValidation &&
            Boolean(accepted && references && references.scope !== 'statement' &&
              references.root.file === root.file && references.root.name === root.name &&
              references.sourceCommit === accepted.commit && references.environmentDigest === input.environmentDigest &&
              rootDigest(canonical, root) === root.declarationDigest &&
              rootDigest(accepted.commit, root) === root.declarationDigest &&
              proofReferencesUnchanged(input.problem, input.worktree, canonical, references, input.environmentDigest));
        },
      }));
    } catch { /* An unavailable historical source is not an executable dependency suggestion. */ }
  }
  return connections;
}
