import { canonicalMathJson, mathDigest } from '../math/mathRuntimeIo';
import { taskGroup, taskVersion, type CooperativeTask, type TaskRecord } from './tasks';

export type ProjectionDeclaration = Readonly<{ file: string; name: string; declarationDigest: string }>;
export type ProjectionDependencyHint = Readonly<{
  id: string;
  authority: 'unambiguous-source-reference';
  proofAcceptance: 'not-assessed';
  problemReceiptDigest: string;
  sourceCommit: string;
  sourceDigest: string;
  consumer: Readonly<{ taskId: string; taskDigest: string; declaration: ProjectionDeclaration }>;
  /** The exact owned declarations from the consumer to a root removed by this projection. */
  path: readonly ProjectionDeclaration[];
  root: ProjectionDeclaration & Readonly<{ removedBecause: 'excluded-original-target' | 'assumed-input' | 'draft-declaration' }>;
}>;

export type ProjectionDependencyConnection = Readonly<{
  consumer: Readonly<{ taskId: string; taskDigest: string }>;
  dependency: Readonly<{ taskId: string; taskDigest: string }>;
  hint: ProjectionDependencyHint;
}>;

export function projectionDependencyHintId(hint: Omit<ProjectionDependencyHint, 'id'>): string {
  return mathDigest(canonicalMathJson(hint));
}

/** A source observation suggests a plan edge only; the normal task and Lean checks still decide its validity. */
export function projectionDependencyConnections(hints: readonly ProjectionDependencyHint[], input: {
  problemReceiptDigest: string; sourceCommit: string; sourceDigest: string;
  consumer: CooperativeTask; tasks: readonly TaskRecord[];
  /** The caller must check current host acceptance and the exact root declaration bytes in this snapshot. */
  isFreshlyAccepted: (node: TaskRecord, root: ProjectionDependencyHint['root']) => boolean;
}): ProjectionDependencyConnection[] {
  const consumerDigest = taskVersion(input.consumer), consumer = input.tasks.filter(node => node.task.id === input.consumer.id);
  if (consumer.length !== 1 || taskVersion(consumer[0]!.task) !== consumerDigest ||
      !['lemma', 'goal'].includes(input.consumer.kind)) return [];
  const seen = new Set<string>();
  return hints.flatMap(hint => {
    if (!hint || !hint.consumer || !hint.root || !Array.isArray(hint.path) ||
        hint.path.some(item => !item || typeof item.file !== 'string' || typeof item.name !== 'string' ||
          typeof item.declarationDigest !== 'string')) return [];
    const { id, ...content } = hint;
    if (id !== projectionDependencyHintId(content) || hint.authority !== 'unambiguous-source-reference' ||
        hint.proofAcceptance !== 'not-assessed' || hint.problemReceiptDigest !== input.problemReceiptDigest ||
        hint.sourceCommit !== input.sourceCommit || hint.sourceDigest !== input.sourceDigest ||
        hint.consumer.taskId !== input.consumer.id || hint.consumer.taskDigest !== consumerDigest ||
        hint.consumer.declaration.file !== input.consumer.proofPath ||
        hint.consumer.declaration.name !== input.consumer.theoremName?.replace(/^_root_\./u, '') ||
        hint.root.removedBecause !== 'excluded-original-target' || hint.path.length < 2 ||
        canonicalMathJson(hint.path[0]) !== canonicalMathJson(hint.consumer.declaration) ||
        canonicalMathJson(hint.path.at(-1)) !== canonicalMathJson({ file: hint.root.file, name: hint.root.name,
          declarationDigest: hint.root.declarationDigest })) return [];
    // Qualified names and file identities must identify one current task, not a same-named task in another scope.
    const matches = input.tasks.filter(node => ['lemma', 'goal'].includes(node.task.kind) &&
      node.task.proofPath === hint.root.file && node.task.theoremName?.replace(/^_root_\./u, '') === hint.root.name);
    const node = matches.length === 1 ? matches[0] : undefined;
    if (!node || node.task.id === input.consumer.id || input.consumer.dependsOn.includes(node.task.id) ||
        node.task.sharing === 'group' && taskGroup(node.task) !== taskGroup(input.consumer) ||
        !input.isFreshlyAccepted(node, hint.root) || seen.has(node.task.id)) return [];
    seen.add(node.task.id);
    return [{ consumer: { taskId: input.consumer.id, taskDigest: consumerDigest },
      dependency: { taskId: node.task.id, taskDigest: taskVersion(node.task) }, hint }];
  });
}
