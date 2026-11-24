import path from 'node:path';
import { z } from 'zod';
import { inspectScopedLeanDeclarations } from '../math/leanSource';
import { isSimpleLeanName, maskLeanComments } from '../math/leanSyntax';
import { mathDigest } from '../math/mathRuntimeIo';
import { importAgentTeamCommit } from './agentTeamWorkspace';
import { applyTaskChanges, createTaskSourceProjector, taskChanges, type DeclarationChange } from './cooperativeProof';
import type { DeclarationArtifactIdentity } from './declarationArtifacts';
import { checkProjectedDeclarations } from './modules/evidence';
import { assertSolverSources, committedSource, commitSolverSources, git, solverProofImports,
  SolverSourceError, withSolverWorktree } from './problem';
import { proofReuseEnvironment } from './proofReuse';
import { solverSourceContext } from './sourceContext';
import { allowedKnowledgeFile, locateKnowledgeDeclaration } from './theoremKnowledge';
import type { CooperativeTask } from './tasks';

const leanName = z.string().min(1).max(1000).refine(isSimpleLeanName);
const leanFile = z.string().refine(value => value.endsWith('.lean') && allowedKnowledgeFile(value));
const commitHash = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
export const helperNominationsSchema = z.array(z.object({
  file: leanFile, name: leanName, type: z.string().trim().min(1).max(12_000).optional(),
  kind: z.literal('definition').optional(),
}).strict()).min(1).max(32);
export type HelperNomination = z.infer<typeof helperNominationsSchema>[number];
export const landedHelperSchema = z.object({
  file: leanFile, qualifiedName: leanName, commit: commitHash, type: z.string().min(1).max(1000),
  kind: z.literal('definition').optional(),
}).strict();
export type LandedHelper = z.infer<typeof landedHelperSchema>;

export class IncrementalHelperRejection extends Error {
  constructor(reason: string, details?: string, options?: ErrorOptions) {
    super(`math_incremental_helper_${reason}${details ? ': ' + details : ''}`, options);
    this.name = 'IncrementalHelperRejection';
  }
}

type VerifiedHelpersInput = {
  state: DeclarationArtifactIdentity;
  sourceWorktree: string; sourceCommit: string; seedCommit: string;
  worktree: string; expectedCommit: string;
  declarations: readonly HelperNomination[];
  env: NodeJS.ProcessEnv; signal: AbortSignal; timeoutMs?: number;
  assertCurrent?: () => void;
  allowHelper?: (helper: HelperNomination) => boolean;
};
type VerifiedHelpers = { commit: string; helpers: LandedHelper[]; declarations: Array<HelperNomination & { type: string }>;
  changes: DeclarationChange[];
  imports: { file: string; module: string }[] };
const id = (file: string, name: string) => file + '\0' + name;
const allowedAxioms = new Set(['propext', 'Classical.choice', 'Quot.sound']);
const reject = (reason: string, details?: string): never => { throw new IncrementalHelperRejection(reason, details); };

function sourceContract(check: () => void) {
  try { check(); }
  catch (error) {
    if (error instanceof SolverSourceError || error instanceof Error &&
        /^(?:math_trusted_source_changed|math_source_outside_ownership)$/u.test(error.message))
      throw new IncrementalHelperRejection('source_rejected', error.message, { cause: error });
    throw error;
  }
}

function rejectKnownSourceError(error: unknown): never {
  if (error instanceof Error && /^(?:math_task_|math_knowledge_declaration_missing_or_ambiguous)/u.test(error.message))
    throw new IncrementalHelperRejection('source_rejected', error.message, { cause: error });
  throw error;
}

/** Stage a checked canonical descendant without writing either worker's live checkout. */
export async function landVerifiedHelpers(input: VerifiedHelpersInput): Promise<VerifiedHelpers> {
  const { state, worktree, sourceWorktree, sourceCommit, seedCommit, expectedCommit, signal } = input;
  const { problem } = state;
  const nominations = helperNominationsSchema.safeParse(input.declarations);
  if (!nominations.success) return reject('invalid_nomination', nominations.error.message);
  const current = () => { signal.throwIfAborted(); input.assertCurrent?.(); };
  current();
  for (const commit of [sourceCommit, seedCommit, expectedCommit]) commitHash.parse(commit);
  git(sourceWorktree, ['merge-base', '--is-ancestor', seedCommit, sourceCommit]);
  git(worktree, ['merge-base', '--is-ancestor', problem.baseCommit, expectedCommit]);
  // Native team peers can have a separate Git repository. Fetch the authorized
  // snapshot without changing the target repository's working tree or branches.
  try { git(worktree, ['cat-file', '-e', sourceCommit + '^{commit}']); }
  catch { importAgentTeamCommit(sourceWorktree, worktree, sourceCommit); }

  const selection = await withSolverWorktree(worktree, sourceCommit, async snapshot => {
    sourceContract(() => assertSolverSources(problem, snapshot));
    const base = new Map<string, string>(), sources = new Map<string, string>();
    const canonical = new Map<string, string>();
    for (const file of problem.ownedFiles.filter(file => file.endsWith('.lean'))) {
      const relative = path.join(problem.projectRelative, file);
      base.set(file, committedSource(snapshot, problem.baseCommit, relative));
      sources.set(file, committedSource(snapshot, sourceCommit, relative));
      canonical.set(file, committedSource(worktree, expectedCommit, relative));
    }
    const originals = new Set([...base].flatMap(([file, source]) => inspectScopedLeanDeclarations(source)
      .map(declaration => id(file, declaration.qualifiedName))));
    const names = new Map([...canonical].map(([file, source]) => [file, new Set(inspectScopedLeanDeclarations(source)
      .map(declaration => declaration.qualifiedName))]));
    const locate = (name: string, source: string) => {
      try { return locateKnowledgeDeclaration(source, name); }
      catch (error) { return rejectKnownSourceError(error); }
    };
    const task = ({ file, name, type, kind }: HelperNomination): CooperativeTask => ({
      id: 'standalone-helper', kind: 'lemma', objective: `Check standalone helper ${name}`, proofPath: file, theoremName: name,
      type, dependsOn: [], revision: 0, ...(kind === 'definition' ? { declaration: 'definition' as const } : {}),
    });
    const selected = new Map<string, HelperNomination>();
    const add = (declaration: HelperNomination, nominated: boolean) => {
      const source = sources.get(declaration.file);
      if (source === undefined || Object.hasOwn(problem.frozenFiles ?? {}, declaration.file))
        return reject('outside_ownership', declaration.file);
      const located = locate(declaration.name, source);
      const key = id(declaration.file, located.qualifiedName);
      if (originals.has(key)) return reject('original_declaration', located.qualifiedName);
      if (located.kind !== 'theorem' && (located.kind !== 'definition' ||
          !/^(?:def|abbrev)\s/u.test(source.slice(located.startOffset, located.bodyOffset))))
        return reject('unsupported_declaration', located.qualifiedName);
      const normalized = { ...declaration, name: located.qualifiedName,
        ...(located.kind === 'definition' ? { kind: 'definition' as const } : {}) };
      if (input.allowHelper?.(normalized) === false) return reject('outside_scope', normalized.name);
      if (selected.has(key) && nominated) return reject('duplicate_nomination', normalized.name);
      if (!selected.has(key)) selected.set(key, normalized);
      return normalized;
    };
    const project = createTaskSourceProjector(problem, snapshot, sourceCommit);
    const roots = nominations.data.map(declaration => add(declaration, true));
    const closures = new Map<string, ReturnType<typeof project.helperClosure>>();
    const closureFor = (declaration: HelperNomination) => {
      try { return project.helperClosure(task(declaration)); }
      catch (error) { return rejectKnownSourceError(error); }
    };
    for (const root of roots) {
      const closure = closureFor(root);
      closures.set(id(root.file, root.name), closure);
      for (const dependency of closure) {
        const key = id(dependency.file, dependency.name);
        if (originals.has(key) || selected.has(key)) continue;
        if (dependency.file !== root.file) {
          if (names.get(dependency.file)?.has(dependency.name)) continue;
          return reject('dependency_outside_file', dependency.name);
        }
        const included = add(dependency, false);
        closures.set(key, closureFor(included));
      }
    }
    let patches: DeclarationChange[];
    try { patches = taskChanges(problem, snapshot, sourceCommit, undefined, { seedCommit: problem.baseCommit }); }
    catch (error) { return rejectKnownSourceError(error); }
    const changes: DeclarationChange[] = [];
    const added: HelperNomination[] = [];
    const files = new Set<string>();
    const ordered = [...selected.values()].sort((a, b) => a.file.localeCompare(b.file) ||
      locate(a.name, sources.get(a.file)!).startOffset - locate(b.name, sources.get(b.file)!).startOffset);
    for (const declaration of ordered) {
      const { file, name } = declaration;
      const source = sources.get(file)!, candidate = locate(name, source);
      const patch = patches.find(change => change.file === file && change.before === undefined &&
        (change.name === candidate.name || change.name === name));
      if (!patch) return reject('missing_addition', name);
      if (names.get(file)!.has(name)) {
        const retained = canonical.get(file)!, existing = locate(name, retained);
        const line = retained.lastIndexOf('\n', existing.startOffset - 1) + 1;
        if (retained.slice(line, existing.endOffset).trimEnd() + '\n' !== patch.after)
          return reject('conflicting_definition', name);
        continue;
      }
      // Where the original context and dependencies permit, make the helper visible to
      // the first original target in its scope, even when a worker appended it later.
      const retained = canonical.get(file)!;
      const context = (text: string, offset: number) => solverSourceContext(maskLeanComments(text.slice(0, offset)), [],
        problem.sourceImports?.[file], solverProofImports(problem, text));
      const required = new Set((closures.get(id(file, name)) ?? []).filter(ref => ref.file === file && ref.name !== name).map(ref => ref.name));
      const precedingInputs = [...required].filter(ref => names.get(file)!.has(ref))
        .map(ref => locate(ref, retained).endOffset);
      const first = inspectScopedLeanDeclarations(retained).find(target => problem.targets.some(original =>
        original.proofPath === file && original.theoremName === target.qualifiedName) &&
        precedingInputs.every(end => end <= target.startOffset) &&
        context(retained, target.startOffset) === context(source, candidate.startOffset));
      changes.push(first ? { file, name: patch.name, after: patch.after, beforeName: first.name } : patch);
      added.push(declaration); files.add(file);
    }
    const imports = [...files].flatMap(file => {
      const retained = new Set(solverProofImports(problem, canonical.get(file)!));
      return solverProofImports(problem, sources.get(file)!).filter(module => !retained.has(module)).map(module => ({ file, module }));
    });
    return { changes, imports, added, ordered };
  });
  current();
  return withSolverWorktree(worktree, expectedCommit, async staging => {
    sourceContract(() => {
      assertSolverSources(problem, staging);
      try { applyTaskChanges(problem, staging, selection.changes, selection.imports); }
      catch (error) { return rejectKnownSourceError(error); }
    });
    const commit = selection.changes.length ? commitSolverSources(problem, staging) : expectedCommit;
    const environment = proofReuseEnvironment(path.join(worktree, problem.projectRelative), input.env);
    const checked = new Map<string, string>();
    // Check the staged canonical bytes. A tactic can select a different lemma or instance
    // when a source projection removes original goals, so projected evidence cannot bind this merge.
    for (let offset = 0; offset < selection.ordered.length; offset += 64) {
      current();
      const batch = selection.ordered.slice(offset, offset + 64);
      const expectedTypes: Record<string, string> = Object.create(null);
      for (const declaration of batch) if (declaration.type) expectedTypes[declaration.name] = declaration.type;
      const verification = await checkProjectedDeclarations(problem, staging, worktree, commit,
        batch.map(({ file, name }) => ({ proofPath: file, theoremName: name, digest: mathDigest(id(file, name)),
          missingError: 'math_incremental_helper_source_missing' })),
        { env: environment.env, signal, timeoutMs: input.timeoutMs ?? Infinity, checkDeclarationsInDraft: true,
          ...(Object.keys(expectedTypes).length ? { expectedDeclarationTypes: expectedTypes } : {}),
          prepareLocalDependencies: true }).catch(error => {
        if (error instanceof Error && error.message === 'math_incremental_helper_source_missing')
          return reject('source_rejected', error.message);
        throw error;
      });
      for (const [index, declaration] of batch.entries()) {
        const result = verification.verification.results[index];
        if (result?.status !== 'kernel_verified' || result.verifier !== 'lean-kernel' || result.cleanupError || result.sorryCount !== 0 ||
            result.admitCount !== 0 || !result.axioms.every(axiom => allowedAxioms.has(axiom)) || !result.elaboratedDeclarationType)
          return reject('kernel_rejected', `${declaration.name}: ${result?.error ?? verification.verification.status}`);
        checked.set(id(declaration.file, declaration.name), result.elaboratedDeclarationType);
      }
      if (!verification.passed) return reject('kernel_rejected', verification.verification.status);
    }
    current();
    const declarations = selection.added.map(declaration => ({
      ...declaration, type: checked.get(id(declaration.file, declaration.name))!,
    }));
    const helpers = declarations.map(({ file, name, type, kind }) => landedHelperSchema.parse({
      file, qualifiedName: name, type: type.replace(/\s+/gu, ' ').slice(0, 1000), commit, ...(kind ? { kind } : {}),
    }));
    return { commit, helpers, declarations, changes: selection.changes, imports: selection.imports };
  });
}
