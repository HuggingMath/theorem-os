import fs from 'node:fs';
import path from 'node:path';
import { canonicalMathJson, mathDigest } from '../math/mathRuntimeIo';
import { isSimpleLeanName, maskLeanComments, maskLeanCommentsAndStrings } from '../math/leanSyntax';
import { mathConstructionImports, mathConstructionImportSpans } from '../math/mathConstructionSources';
import { hashMathFormalSourceDeclaration, inspectLeanDeclarationRegions, inspectLeanProjectionDeclarations, inspectScopedLeanDeclarations,
  leanDeclarationContextCommands, leanDeclarationKeys, repeatedLeanLocalNames } from '../math/leanSource';
import { assertSolverSources, committedSource, commitSolverProjection, git, originalDeclarationRegions, solverProofImports,
  withSolverWorktree, type SolverProblem } from './problem';
import { attributeProofEvidence, checkProjectedDeclarations, type ProofCheck } from './modules/evidence';
import { assumableLemma, isDefinitionTask, taskVersion, type CooperativeTask, type TaskAssignment, type TaskRecord } from './tasks';
import { captureProofReferences, type ProofReferences } from './proofReferences';
import { hasDeterministicLeanFailure, proofReuseEnvironment } from './proofReuse';
import { TaskProofCache, type TaskVerificationArtifact } from './taskProofCache';
import { formalVerificationToolIdentity, type MathematicsVerifierBatchItem } from '../math/verifier';
import { hasTaskConnectionCheck } from './taskConnections';
import { compactTaskSources } from './taskProjection';
import { projectionDependencyHintId, type ProjectionDeclaration, type ProjectionDependencyHint } from './projectionDependencyHints';
import { assertTaskTypeContract } from './taskTypeContract';
import { inspectProjectionNotations, type ProjectionNotation } from './projectionNotation';
import { conditionalExpectedType, conditionalProjection } from './conditionalProjection';

export { TaskProofCache } from './taskProofCache';

/** Source observations only order/recover checks; callers must separately establish fresh acceptance.
 * Possible source context is not a plan edge or an unambiguous dependency hint. */
export function projectedGoalInputs(project: ReturnType<typeof createTaskSourceProjector>, task: CooperativeTask,
  tasks: readonly TaskRecord[], conditions: readonly CooperativeTask[] = []): TaskRecord[] {
  const found = new Set<TaskRecord>(), visited = new Set<string>(), pending = [task];
  for (const current of pending) {
    if (visited.has(current.id)) continue;
    visited.add(current.id);
    const inputs = current === task ? conditions : [];
    const roots = [...project.dependencyHints(current, [], inputs)
      .filter(hint => hint.root.removedBecause === 'excluded-original-target').map(hint => hint.root),
      ...project.possibleContextGoals(current, [], inputs)];
    for (const root of roots) {
      const matches = tasks.filter(node => node.task.kind === 'goal' && node.task.id !== task.id &&
        node.task.proofPath === root.file && node.task.theoremName?.replace(/^_root_\./u, '') === root.name);
      if (matches.length !== 1 || found.has(matches[0])) continue;
      found.add(matches[0]); pending.push(matches[0].task);
    }
  }
  return [...found];
}

/** `afterName` moves an existing declaration after that sibling, or inserts a new one after it. */
export type DeclarationChange = { file: string; name: string; before?: string; after: string; beforeName?: string; afterName?: string; tail?: string };
export type TaskProjectionReuse = Readonly<{ schema: 'theorem-os.task-projection-reuse.v1'; projectionCommit: string;
  checkedProjectionCommit: string; projectionTree: string; inputDigest: string }>;
export type TaskProof = ProofCheck & { taskDigest: string; seedCommit: string; changes: DeclarationChange[];
  /** Host-attributed projection choice; restored or modified records cannot authorize it. */
  projectionMode?: 'compact';
  imports?: { file: string; module: string }[];
  projectionReuse?: TaskProjectionReuse;
  /** Set by the host after checking the exact projection and its receipts. */
  projection?: Readonly<{ environmentDigest: string; problemReceiptDigest: string; sourceDigest: string }>;
  /** Source-bound reasons a projection removed a potential dependency; advisory, never a proof receipt. */
  projectionDependencyHints?: readonly ProjectionDependencyHint[];
  conditions?: NonNullable<TaskAssignment['dependencies']>; references?: ProofReferences };
export type TaskProofRequest = { task: CooperativeTask; assignment: TaskAssignment; retainedGoals: readonly string[];
  conditions?: readonly CooperativeTask[] };
const attributedProofs = new WeakMap<TaskProof, string>();
const reusedProjections = new WeakMap<TaskProof, string>();

/** Only unchanged task views attributed by this process may suppress a batch fallback. */
export const isAttributedTaskProof = (proof: TaskProof): boolean =>
  attributedProofs.get(proof) === mathDigest(canonicalMathJson(proof));

/** A restored, cloned or edited proof cannot authorize a receipt from another commit. */
export function trustedTaskProjectionReuse(proof: TaskProof): TaskProjectionReuse | undefined {
  try {
    if (proof.projectionReuse && reusedProjections.get(proof) === mathDigest(canonicalMathJson(proof))) return proof.projectionReuse;
  } catch { /* Invalid caller data cannot restore process-local trust. */ }
  return undefined;
}

const local = (name: string) => name.split('.').at(-1)!;
/** Regions with the identity a DeclarationChange records: the written name, or the qualified name of a repeated final component. */
const keyedRegions = (source: string) => {
  const keys = leanDeclarationKeys(source);
  return inspectLeanDeclarationRegions(source).map(region => ({ ...region, key: keys.get(region.startOffset)! }));
};

export { committedSource } from './problem';

export function ownedSourceDigest(problem: SolverProblem, worktree: string, commit: string): string {
  return mathDigest(canonicalMathJson(problem.ownedFiles.map(file =>
    [file, mathDigest(committedSource(worktree, commit, `${problem.projectRelative}/${file}`))])));
}

/** Omit helper artifacts outside a task's visible scope while preserving every original declaration. */
export function omitTaskHelpers(problem: SolverProblem, file: string, source: string, names: readonly string[]): string {
  const originals = new Set((problem.declarations[file] ?? []).map(item => item.name));
  const hidden = new Set(names.map(local));
  const regions = inspectLeanDeclarationRegions(source);
  for (const [index, region] of [...regions.entries()].reverse()) if (hidden.has(local(region.name)) && !originals.has(region.name)) {
    const start = declarationStartWithDoc(source, region.startOffset, index ? regions[index - 1]!.endOffset : 0);
    source = source.slice(0, start) + source.slice(region.endOffset);
  }
  return source;
}

/** Freeze edits while preserving original goals, helper statements, and definition bodies. */
export function taskChanges(problem: SolverProblem, worktree: string, sourceCommit: string,
  task: CooperativeTask | undefined, assignment: Pick<TaskAssignment, 'seedCommit'>): DeclarationChange[] {
  // This only computes edits; callers still validate source availability and the frozen statement.
  if (sourceCommit === assignment.seedCommit && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(sourceCommit)) return [];
  const changes: DeclarationChange[] = [];
  for (const file of problem.ownedFiles) {
    const read = (commit: string) => committedSource(worktree, commit, `${problem.projectRelative}/${file}`);
    const before = read(assignment.seedCommit), after = read(sourceCommit);
    if (before === after) continue;
    if (task && (['research', 'sketch'].includes(task.kind) || !file.endsWith('.lean'))) throw new Error('math_task_source_outside_scope');
    if (Object.hasOwn(problem.frozenFiles ?? {}, file))
      throw new Error(`math_library_module_changed\nFile: ${problem.projectRelative}/${file}\n` +
        `This Submission/Library module is a frozen host library. Restore it with git show ${assignment.seedCommit}:${problem.projectRelative}/${file}, import it and add new helpers in another owned file.`);
    const originals = keyedRegions(before), updated = keyedRegions(after);
    // Only the statement's own repeated final components may repeat; each copy keeps its qualified identity.
    if (new Set(updated.map(region => region.key)).size !== updated.length ||
        repeatedLeanLocalNames(updated.map(region => region.name)) !==
          repeatedLeanLocalNames((problem.declarations[file] ?? []).map(item => item.name)))
      throw new Error('math_task_ambiguous_declaration');
    const text = (source: string, region: typeof originals[number]) => {
      const line = source.lastIndexOf('\n', region.startOffset - 1) + 1;
      return source.slice(line, region.endOffset).trimEnd() + '\n';
    };
    const statement = originalDeclarationRegions(before, originals);
    const fromStatement = new Set((problem.declarations[file] ?? []).flatMap(item => statement(item)).map(region => region.startOffset));
    for (const region of originals) {
      const current = updated.find(item => item.key === region.key);
      if (!current) throw new Error('math_task_existing_declaration_removed');
      const oldText = text(before, region), newText = text(after, current);
      if (oldText === newText) continue;
      const assigned = file === task?.proofPath && local(region.name) === local(task.theoremName!);
      const proofRepair = !fromStatement.has(region.startOffset) &&
        /^(?:theorem|lemma)\s/u.test(before.slice(region.startOffset, region.bodyOffset)) &&
        /^(?:theorem|lemma)\s/u.test(after.slice(current.startOffset, current.bodyOffset)) &&
        region.declarationType === current.declarationType;
      if (task && !assigned && !proofRepair)
        throw new Error(`math_task_existing_declaration_changed\nFile: ${problem.projectRelative}/${file}\nDeclaration: ${region.key}\n` +
          `Restore this declaration's exact name, parameters, proof and namespace/section placement from git show ${assignment.seedCommit}:${problem.projectRelative}/${file}. ` +
          'Proof-only repairs to solver-created lemmas are allowed; preserve their statements. Add a differently named helper if different parameters are needed. Do not reset the worktree.');
      changes.push({ file, name: region.key, before: oldText, after: newText });
    }
    const kept = new Set(originals.map(original => original.key));
    const inherited = updated.filter(region => kept.has(region.key));
    if (inherited.some((region, index) => region.key !== originals[index].key)) {
      // Replay declaration order as well as proof edits; Lean cannot reference a later theorem.
      for (let index = 1; index < inherited.length; index++) {
        const region = inherited[index], previous = inherited[index - 1];
        if (canonicalMathJson(leanDeclarationContextCommands(after, region.key)) !==
            canonicalMathJson(leanDeclarationContextCommands(after, previous.key))) continue;
        changes.push({ file, name: region.key, before: text(before, originals.find(item => item.key === region.key)!),
          after: text(after, region), afterName: previous.key });
      }
    }
    const contexts = new Map<string, string>();
    const context = (name: string) => contexts.get(name) ??
      contexts.set(name, canonicalMathJson(leanDeclarationContextCommands(after, name))).get(name)!;
    for (const region of updated.filter(item => !kept.has(item.key))) {
      const next = updated.find(item => item.startOffset > region.startOffset && kept.has(item.key));
      // An anchor in another namespace/section block would rename the helper; follow its nearest same-scope sibling instead.
      const previous = next && context(next.key) !== context(region.key) ?
        updated.findLast(item => item.startOffset < region.startOffset && context(item.key) === context(region.key)) : undefined;
      if (previous) { changes.push({ file, name: region.key, after: text(after, region), afterName: previous.key }); continue; }
      changes.push({ file, name: region.key, after: text(after, region), beforeName: next?.key,
        tail: next ? undefined : originals.length ? before.slice(originals.at(-1)!.endOffset) : after.slice(updated.at(-1)!.endOffset) });
    }
  }
  return changes;
}

/** Deterministic proof projection shared by the checker and the host receipt boundary. One immutable canonical snapshot
 * shares source reads and declaration indexes across its targets. */
export function createTaskSourceProjector(problem: SolverProblem, worktree: string, sourceCommit: string,
  options: { compact?: boolean; preserved?: readonly { file: string; name: string }[] } = {}) {
  problem = structuredClone(problem);
  if (!/^[a-f0-9]{40,64}$/u.test(sourceCommit)) sourceCommit = git(worktree, ['rev-parse', sourceCommit + '^{commit}']);
  const sourceSnapshot = new Map(problem.ownedFiles.map(file => [file,
    committedSource(worktree, sourceCommit, `${problem.projectRelative}/${file}`)]));
  const regions = new Map([...sourceSnapshot].filter(([file]) => file.endsWith('.lean'))
    .map(([file, source]) => [file, inspectLeanProjectionDeclarations(source)]));
  const key = (file: string, name: string) => `${file}\0${name}`;
  const sourceReferences = (source: string, baseOffset = 0) => {
    const clean = maskLeanCommentsAndStrings(source);
    return [...clean.matchAll(/[\p{L}_][\p{L}\p{M}\p{N}_'?!]*(?:\.[\p{L}_][\p{L}\p{M}\p{N}_'?!]*)*/gu)]
      .map(match => ({ name: match[0], offset: baseOffset + match.index, receiverField: clean[match.index - 1] === '.' }));
  };
  const identifiers = (source: string) => sourceReferences(source).map(reference => reference.name);
  const declarations = [...sourceSnapshot].filter(([file]) => file.endsWith('.lean')).flatMap(([file, source]) => {
    return regions.get(file)!.map(region => {
      const declaration = region;
      const header = source.slice(region.startOffset, region.bodyOffset);
      // Only declaration parameters bind throughout the remaining declaration.
      // A parameter is not in scope in its own type, and `(value : Type)` in
      // the result is a type ascription rather than another parameter.
      const clean = maskLeanCommentsAndStrings(header);
      const bound: { name: string; offset: number; scope: number }[] = [];
      let cursor = declaration.parametersOffset - region.startOffset;
      while (cursor < clean.length) {
        if (/\s/u.test(clean[cursor]!)) { cursor++; continue; }
        if (clean[cursor] === ':') break;
        const start = cursor, opening = '([{⦃'.indexOf(clean[cursor]!);
        if (opening < 0) {
          const name = /^[\p{L}_][\p{L}\p{M}\p{N}_'?!]*/u.exec(clean.slice(cursor));
          if (name) {
            cursor += name[0].length;
            bound.push({ name: name[0], offset: region.startOffset + start, scope: region.startOffset + cursor });
          } else cursor++;
          continue;
        }
        const stack = [')]}⦄'[opening]];
        for (cursor++; cursor < clean.length && stack.length; cursor++) {
          const nested = '([{⦃'.indexOf(clean[cursor]!);
          if (nested >= 0) stack.push(')]}⦄'[nested]);
          else if (clean[cursor] === stack.at(-1)) stack.pop();
        }
        // Universe levels are not term parameters; an anonymous instance supplies a type, not names.
        if (clean[start - 1] === '.') continue;
        const names = /^\s*([\p{L}_][\p{L}\p{M}\p{N}_'?!]*(?:\s+[\p{L}_][\p{L}\p{M}\p{N}_'?!]*)*)\s*(?::|$)/u
          .exec(clean.slice(start + 1, cursor - 1));
        if (opening === 1 && !names?.[0].endsWith(':')) continue;
        if (names) for (const name of names[1]!.matchAll(/[\p{L}_][\p{L}\p{M}\p{N}_'?!]*/gu)) bound.push({
          name: name[0], offset: region.startOffset + start + 1 + names[0].indexOf(names[1]!) + name.index,
          scope: region.startOffset + cursor,
        });
      }
      return { ...declaration, name: declaration.name ?? '', qualifiedName: declaration.qualifiedName ?? '',
        bodyOffset: region.bodyOffset, endOffset: region.endOffset, file,
        id: key(file, declaration.qualifiedName ?? `@${region.startOffset}`),
        theorem: /^(?:theorem|lemma)\s/u.test(header), instance: /^instance\b/u.test(header),
        resultOffset: region.startOffset + cursor + 1, parameters: clean.slice(declaration.parametersOffset - region.startOffset, cursor),
        resultType: clean.slice(cursor + 1).replace(/(?::=|\bwhere)\s*$/u, ''),
        bound, notation: undefined as ProjectionNotation | undefined,
        references: sourceReferences(source.slice(region.startOffset, region.endOffset), region.startOffset) };
    });
  });
  const notations = new Map([...sourceSnapshot].filter(([file]) => file.endsWith('.lean'))
    .map(([file, source]) => [file, inspectProjectionNotations(source, regions.get(file)!)]));
  for (const [file, entries] of notations)
    for (const notation of entries) declarations.push({
      ...notation, name: '', qualifiedName: '', declarationType: '', file, parametersOffset: notation.bodyOffset,
      id: key(file, `@notation:${notation.startOffset}`), theorem: false, notation,
      instance: false, resultOffset: notation.bodyOffset, parameters: '', resultType: '',
      bound: notation.bound.map(name => ({ name, offset: notation.startOffset, scope: notation.bodyOffset })),
      references: sourceReferences(sourceSnapshot.get(file)!.slice(notation.bodyOffset, notation.endOffset), notation.bodyOffset),
    });
  const byOffset = new Map(declarations.map(item => [`${item.file}\0${item.startOffset}`, item]));
  const byId = new Map(declarations.map(item => [item.id, item]));
  const notationDeclarations = declarations.filter(item => item.notation);
  const notationById = new Map(notationDeclarations.map(item => [item.id, item.notation!]));
  const masked = new Map([...sourceSnapshot].filter(([file]) => file.endsWith('.lean')).map(([file, source]) => {
    const text = maskLeanComments(source);
    return [file, { text, regions: inspectLeanProjectionDeclarations(text) }] as const;
  }));
  const visible = new Map([...sourceSnapshot.keys()].map(file => {
    const files = new Set([file]);
    for (const current of files) for (const module of mathConstructionImports(sourceSnapshot.get(current)!)) {
      const imported = module.replaceAll('.', '/') + '.lean';
      if (sourceSnapshot.has(imported)) files.add(imported);
    }
    return [file, files] as const;
  }));
  // Resolve an `open` where it occurs, rather than reinterpreting a parent's open in a child namespace.
  // This index concerns owned dependencies only; imported constants still undergo the normal Lean check.
  const namespaces = new Map([...visible].map(([file, files]) => [file, new Set(declarations
    .filter(item => files.has(item.file)).flatMap(item => {
      const parts = (item.qualifiedName || item.namespace).split('.');
      return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join('.'));
    }))]));
  type OpenBinding = { namespace: string; excluded?: string[]; aliases?: { from: string; to: string }[] };
  const restrictedOpens = new Map<string, Map<number, {
    startOffset: number; endOffset: number; local: boolean; name: string; mode: string;
    namespaces: string[]; excluded?: string[]; aliases?: { from: string; to: string }[];
  }>>();
  const openedNames = (open: OpenBinding, name: string): string[] => open.aliases
    ? open.aliases.filter(alias => name === alias.to || name.startsWith(alias.to + '.'))
      .map(alias => `${open.namespace}.${alias.from}${name.slice(alias.to.length)}`)
    : open.excluded?.includes(name) ? [] : [`${open.namespace}.${name}`];
  const openedBindings = new Map(declarations.map(declaration => {
    const resolved: OpenBinding[] = [], known = namespaces.get(declaration.file)!;
    for (const open of declaration.opens) {
      const selected = /^(\S+)\s*\(([^()]*)\)\s*$/u.exec(open.command);
      const restricted = /^(\S+)\s+(hiding|renaming)\s+(.+)$/u.exec(open.command);
      const names = selected || restricted ? [(selected ?? restricted)![1]!] : open.command.split(/\s+/u);
      if (!names.every(isSimpleLeanName)) continue;
      let excluded: string[] | undefined, aliases: OpenBinding['aliases'];
      if (selected) {
        const members = selected[2]!.trim().split(/\s+/u);
        if (!members.every(isSimpleLeanName)) continue;
        aliases = members.map(name => ({ from: name, to: name }));
      } else if (restricted?.[2] === 'hiding') {
        excluded = restricted[3]!.trim().split(/\s+/u);
        if (!excluded.every(isSimpleLeanName)) continue;
      } else if (restricted) {
        const renamed = restricted[3]!.split(',').map(pair => pair.trim().split(/\s*(?:→|->)\s*/u));
        if (!renamed.every(pair => pair.length === 2 && pair.every(isSimpleLeanName))) continue;
        aliases = renamed.map(([from, to]) => ({ from: from!, to: to! }));
      }
      const start = resolved.length;
      for (const name of names) {
        const parts = open.namespace.split('.').filter(Boolean);
        const scoped = name.startsWith('_root_.') ? [name.slice(7)] : Array.from({ length: parts.length + 1 },
          (_, index) => [...parts.slice(0, parts.length - index), name].join('.'));
        const nearest = scoped.find(candidate => known.has(candidate));
        const opened = name.startsWith('_root_.') ? [] : resolved.filter(item => !item.aliases)
          .flatMap(item => openedNames(item, name)).filter(candidate => known.has(candidate));
        for (const namespace of new Set([...(nearest ? [nearest] : []), ...opened]))
          resolved.push({ namespace, excluded, aliases });
      }
      if (selected || restricted) {
        if (!restrictedOpens.has(declaration.file)) restrictedOpens.set(declaration.file, new Map());
        restrictedOpens.get(declaration.file)!.set(open.startOffset, { ...open, name: names[0]!,
          mode: selected ? 'selected' : restricted![2]!, namespaces: resolved.slice(start).map(item => item.namespace),
          excluded, aliases });
      }
    }
    return [declaration, resolved] as const;
  }));
  const frozenModules = new Map(declarations.filter(item => item.name && Object.hasOwn(problem.frozenFiles ?? {}, item.file))
    .map(item => [item.qualifiedName, item.file.slice(0, -'.lean'.length).replaceAll('/', '.')]));
  const notationGroupsCache = new Map<typeof declarations[number], string[][]>();
  const originals = new Map<string, string>();
  const conditionalInputs = (conditions: readonly CooperativeTask[]) => conditions.map(dependency => ({
    theoremName: (declarations.find(item => item.file === dependency.proofPath &&
      (item.qualifiedName === dependency.theoremName || !dependency.theoremName!.includes('.') && item.name === dependency.theoremName))
      ?.qualifiedName ?? dependency.theoremName!).replace(/^_root_\./u, ''), type: dependency.type!,
  }));
  const project = (task: CooperativeTask, retainedGoals: readonly string[], conditions: readonly CooperativeTask[] = [],
    observe?: (hints: readonly ProjectionDependencyHint[], context: readonly ProjectionDeclaration[]) => void): Map<string, string> => {
    assertTaskTypeContract(task);
    conditions.forEach(assertTaskTypeContract);
    const inputs = conditionalInputs(conditions);
    // These binders are host-generated: an older candidate may not import the frozen modules
    // named by their closed types. Resolve only pinned declarations; mutable helpers remain
    // explicit inputs, and the candidate's original source identity stays unchanged.
    const conditionModules = new Set<string>();
    for (const dependency of conditions) for (const reference of identifiers(dependency.type!)) {
      const parts = reference.replace(/^_root_\./u, '').split('.');
      for (let length = parts.length; length > 1; length--) {
        const module = frozenModules.get(parts.slice(0, length).join('.'));
        if (module) { conditionModules.add(module); break; }
      }
    }
    const declaration = sourceSnapshot.get(task.proofPath!) ?? '';
    const matches = (regions.get(task.proofPath!) ?? []).filter(region => region.name && local(region.name) === local(task.theoremName!));
    const location = `\nFile: ${problem.projectRelative}/${task.proofPath}\nTarget: ${task.theoremName}\n`;
    if (!matches.length) throw new Error('math_task_missing_declaration' + location +
      'The assigned theorem is absent. Save it with the requested name and type, or report supporting results and the remaining gap as progress. No Lean proof check has started.');
    if (matches.length > 1) throw new Error('math_task_ambiguous_declaration' + location +
      'Multiple declarations share this target name. Give supporting helpers distinct names and preserve one exact assigned theorem.');
    const originalTarget = task.kind === 'goal' ? problem.targets.find(target =>
      target.proofPath === task.proofPath && target.theoremName === task.theoremName) : undefined;
    if (originalTarget && !originals.has(task.proofPath!)) originals.set(task.proofPath!,
      committedSource(worktree, problem.baseCommit, `${problem.projectRelative}/${task.proofPath}`));
    const originalSource = originalTarget ? originals.get(task.proofPath!) : undefined;
    const originalDeclaration = originalSource ? inspectScopedLeanDeclarations(originalSource)
      .find(item => item.qualifiedName === task.theoremName) : undefined;
    const originalDefinition = Boolean(originalSource && originalDeclaration && /^def\s/u.test(originalSource.slice(originalDeclaration.startOffset)));
    const header = declaration.slice(matches[0].startOffset, matches[0].bodyOffset);
    // Only an exact frozen original goal may deliver a definition body; helper targets remain propositions
    // unless the plan explicitly marks the helper as a new definition.
    const definitionMatches = originalTarget && originalDeclaration && originalDefinition && /^def\s/u.test(header) &&
      inspectScopedLeanDeclarations(declaration).some(item => item.startOffset === matches[0].startOffset &&
        item.qualifiedName === task.theoremName && item.declarationType === originalDeclaration.declarationType) &&
      hashMathFormalSourceDeclaration(declaration, task.theoremName!) === originalTarget.declarationHash;
    if (isDefinitionTask(task) ? !/^(?:def|abbrev)\s/u.test(header) : originalDefinition ? !definitionMatches : !/^(?:theorem|lemma)\s/u.test(header))
      throw new Error((isDefinitionTask(task) ? 'math_task_requires_definition' : 'math_task_requires_theorem') + location +
        (isDefinitionTask(task) ? 'This task introduces a definition. Save one def with the requested name and type and a complete body, without sorry.' :
          'Helper targets must be theorems or lemmas. A goal may fill its exact frozen original def, preserving its declaration kind, name, parameters and type.'));
    if (task.kind === 'lemma' && Object.values(problem.declarations).some(items => items.some(item => local(item.name) === local(task.theoremName!))))
      throw new Error('math_task_helper_is_original_declaration');
    const sources = new Map(sourceSnapshot);
    const targetKey = (file: string, name: string) => key(file, declarations.find(item => item.file === file &&
      (item.qualifiedName === name || !name.includes('.') && item.name === name))?.qualifiedName ?? name);
    const target = targetKey(task.proofPath!, task.theoremName!);
    const keep = new Set([target, ...problem.targets
      .filter(target => retainedGoals.includes(target.theoremName)).map(target => targetKey(target.proofPath, target.theoremName))]);
    const assumptions = new Map(conditions.map(dependency => [targetKey(dependency.proofPath!, dependency.theoremName!), dependency]));
    const removed = new Set([...problem.targets.map(target => targetKey(target.proofPath, target.theoremName)),
      ...assumptions.keys()].filter(id => !keep.has(id)));
    const removalRoots = observe ? new Map<string, ProjectionDependencyHint['root']['removedBecause']>([...removed].map(id => [id,
      assumptions.has(id) ? 'assumed-input' as const : 'excluded-original-target' as const])) : undefined;
    const bindings = new Map<string, { file: string; id: string }[]>();
    for (const binding of [...declarations.filter(item => item.name).map(item => ({ file: item.file,
      name: item.qualifiedName, id: item.id })),
      ...[...assumptions].map(([id, dependency]) => ({ id, file: dependency.proofPath!, name: id.slice(id.indexOf('\0') + 1) }))]) {
      bindings.set(binding.name, [...(bindings.get(binding.name) ?? []), binding]);
    }
    const visibleBindings = (declaration: typeof declarations[number], candidates: readonly { file: string; id: string }[]) => {
      const visibleCandidates = candidates.filter(item => {
        if (!visible.get(declaration.file)!.has(item.file)) return false;
        const notation = notationById.get(item.id);
        return !notation || (item.file === declaration.file
          ? notation.startOffset < declaration.startOffset && declaration.startOffset < notation.scopeEnd
          : !notation.local && !notation.scoped);
      });
      const own = visibleCandidates.filter(item => item.file === declaration.file);
      return [...new Set((own.length ? own : visibleCandidates).map(item => item.id))];
    };
    const scopedReferences = (declaration: typeof declarations[number], name: string) => {
      if (name.startsWith('_root_.')) return visibleBindings(declaration, bindings.get(name.slice(7)) ?? []);
      // Enclosing namespaces shadow opened names. An exact qualified root name wins too;
      // an atomic root name may instead be ambiguous with constants introduced by `open`.
      const namespace = declaration.namespace.split('.').filter(Boolean);
      const names = Array.from({ length: namespace.length },
        (_, index) => [...namespace.slice(0, namespace.length - index), name].join('.'));
      for (const qualified of names) {
        const candidates = visibleBindings(declaration, bindings.get(qualified) ?? []);
        if (candidates.length) return candidates;
      }
      const exact = visibleBindings(declaration, bindings.get(name) ?? []);
      if (name.includes('.') && exact.length) return exact;
      return [...new Set([...exact, ...openedBindings.get(declaration)!.flatMap(open =>
        openedNames(open, name).flatMap(qualified => visibleBindings(declaration, bindings.get(qualified) ?? [])))])];
    };
    const fields = new Map<string, { file: string; id: string }[]>();
    for (const [name, candidates] of bindings) fields.set(local(name), [...(fields.get(local(name)) ?? []), ...candidates]);
    // Dot notation can reference an owned declaration through a receiver or as a prefix of a chain:
    // `trace.finiteIdeal.topologicalClosure` and `existsWitness.choose` both carry dependencies.
    // Candidate groups are conservative for removal; only a unique group may become an advisory hint.
    const isBound = (declaration: typeof declarations[number], name: string, offset: number) =>
      declaration.bound.some(binding => binding.name === name && (binding.offset === offset || binding.scope <= offset));
    const resolveReferenceGroups = (declaration: typeof declarations[number],
      { name, offset, receiverField }: ReturnType<typeof sourceReferences>[number]): string[][] => {
      if (!receiverField && !name.includes('.') && isBound(declaration, name, offset)) return [];
      const parts = name.split('.'), groups: string[][] = [];
      let prefixLength = 0;
      for (let length = receiverField ? 0 : parts.length; length > 0; length--) {
        const prefix = parts.slice(0, length).join('.');
        if (length === 1 && isBound(declaration, prefix, offset)) continue;
        const candidates = scopedReferences(declaration, prefix);
        if (candidates.length) { groups.push(candidates); prefixLength = length; break; }
      }
      // A compound receiver such as `(f i).method` leaves `method` as a separate token.
      // It is still a field selected by the receiver type, even if a local has the same name.
      if (!name.startsWith('_root_.')) for (const field of parts.slice(receiverField ? 0 : prefixLength || 1)) {
        // The receiver's type, rather than this declaration's namespace or file, selects a method.
        // Without elaboration, every visible owned method sharing the field is a possible dependency.
        const candidates = [...new Set((fields.get(field) ?? [])
          .filter(item => visible.get(declaration.file)!.has(item.file)).map(item => item.id))];
        if (candidates.length) groups.push(candidates);
      }
      return groups;
    };
    // Removal propagation revisits these same immutable references on each pass. Resolve once
    // within this projection; assumptions and retained inputs may differ on the next request.
    const referenceGroupsCache = new Map<typeof declarations[number], Map<ReturnType<typeof sourceReferences>[number], string[][]>>();
    const referenceGroups = (declaration: typeof declarations[number], reference: ReturnType<typeof sourceReferences>[number]) => {
      let cache = referenceGroupsCache.get(declaration);
      if (!cache) { cache = new Map(); referenceGroupsCache.set(declaration, cache); }
      let groups = cache.get(reference);
      if (!groups) { groups = resolveReferenceGroups(declaration, reference); cache.set(reference, groups); }
      return groups;
    };
    // Notation literals are parser tokens, not namespace-qualified constants. Resolve them
    // separately so global aliases and symbolic notation carry the same source dependencies.
    const notationGroups = (declaration: typeof declarations[number]) => {
      if (!notationDeclarations.length) return [];
      let groups = notationGroupsCache.get(declaration);
      if (groups) return groups;
      const text = maskLeanCommentsAndStrings(sourceSnapshot.get(declaration.file)!
        .slice(declaration.notation ? declaration.bodyOffset : declaration.startOffset, declaration.endOffset));
      // Match whole symbol runs: a `+` notation is not a reference in `++`.
      const symbols = new Set([...text.matchAll(/[^\s\p{L}\p{M}\p{N}_'".?!()[\]{},;⟨⟩⦃⦄]+/gu)].map(match => match[0]));
      const byToken = new Map<string, string[]>();
      for (const candidate of notationDeclarations) {
        if (!visibleBindings(declaration, [candidate]).length) continue;
        for (const token of candidate.notation!.tokens) {
          const used = isSimpleLeanName(token) ? declaration.references.some(reference =>
            reference.name === token && !reference.receiverField) : symbols.has(token);
          if (used) byToken.set(token, [...(byToken.get(token) ?? []), candidate.id]);
        }
      }
      groups = [...byToken.values()].map(ids => [...new Set(ids)]);
      notationGroupsCache.set(declaration, groups);
      return groups;
    };
    // Instance synthesis can depend on a provider without spelling its declaration name.
    // These conservative provider groups only remove orphan wrappers; they never become
    // unambiguous hints or authorize retaining an unchecked original goal.
    const instances = declarations.filter(item => item.instance).map(item => {
      const head = /^\s*([\p{L}_][\p{L}\p{M}\p{N}_'?!]*(?:\.[\p{L}_][\p{L}\p{M}\p{N}_'?!]*)*)/u.exec(item.resultType)?.[1];
      const resultReferences = sourceReferences(item.resultType, item.resultOffset);
      const contextNames = resultReferences.filter(reference => !isBound(item, reference.name.split('.')[0]!, reference.offset))
        .map(reference => local(reference.name));
      const subjects = new Set(resultReferences
        .flatMap(reference => referenceGroups(item, reference)).flat().filter(id => {
          const subject = byId.get(id); return subject && !subject.theorem && !subject.instance && !subject.notation;
        }));
      return { item, head, subjects, contextNames };
    }).filter(provider => provider.head);
    const implicitGroupsCache = new Map<typeof declarations[number], string[][]>();
    const implicitGroups = (item: typeof declarations[number]) => {
      let groups = implicitGroupsCache.get(item);
      if (groups) return groups;
      groups = [];
      if (item.instance && item.references.some(reference => ['inferInstance', 'infer_instance'].includes(reference.name)) &&
          !item.references.some(reference => ['letI', 'haveI'].includes(reference.name))) {
        const providers = instances.filter(provider => provider.item.file === item.file &&
          provider.item.namespace === item.namespace && provider.item.startOffset < item.startOffset);
        const inputs = [item], seen = new Set([item.id]), names = new Set<string>();
        for (const input of inputs) for (const reference of input.references) {
          if (isBound(input, reference.name.split('.')[0]!, reference.offset)) continue;
          names.add(reference.name);
          for (const id of referenceGroups(input, reference).flat()) {
            const dependency = byId.get(id);
            if (dependency && !dependency.theorem && !dependency.instance && !dependency.notation && !seen.has(id)) {
              seen.add(id); inputs.push(dependency);
            }
          }
        }
        // Generic instances expose prerequisite classes in their binders, e.g.
        // pointwise probability supplies CountableProbability from FirstProbability.
        const expanded = new Set<string>();
        for (;;) {
          const next = providers.filter(provider => names.has(provider.head!) && !expanded.has(provider.item.id));
          if (!next.length) break;
          for (const provider of next) {
            expanded.add(provider.item.id);
            for (const name of identifiers(provider.item.parameters)) names.add(name);
          }
        }
        const signature = (head: string, subjects: ReadonlySet<string>) => canonicalMathJson([head, [...subjects].sort()]);
        const supplied = new Set<string>();
        for (const match of item.parameters.matchAll(/\[([^\]]*)\]/gu)) {
          const references = sourceReferences(match[1]!, item.parametersOffset + match.index + 1);
          const subjects = new Set(references.flatMap(reference => referenceGroups(item, reference)).flat().filter(id => {
            const subject = byId.get(id); return subject && !subject.theorem && !subject.instance && !subject.notation;
          }));
          for (const provider of providers) if (references.some(reference => reference.name === provider.head))
            supplied.add(signature(provider.head!, subjects));
        }
        const bySubject = new Map<string, string[]>();
        for (const provider of providers) if (names.has(provider.head!) && !supplied.has(signature(provider.head!, provider.subjects)) &&
            [...provider.subjects].every(id => seen.has(id))) {
          const key = signature(provider.head!, provider.subjects);
          bySubject.set(key, [...(bySubject.get(key) ?? []), provider.item.id]);
        }
        groups = [...bySubject.values()];
      }
      implicitGroupsCache.set(item, groups);
      return groups;
    };
    // Body substitution must match an actual name, not replace `receiver.field` with a bare assumption:
    // Lean decides the receiver argument's position, which source-only dependency lookup cannot infer.
    const referenceKey = (declaration: typeof declarations[number], name: string, offset: number) => {
      if (!name.includes('.') && isBound(declaration, name, offset)) return;
      const candidates = scopedReferences(declaration, name);
      return candidates.length === 1 ? candidates[0] : undefined;
    };
    for (const item of declarations) if (item.theorem && !keep.has(item.id) &&
        item.references.some(({ name }) => name === 'sorry' || name === 'admit')) {
      removed.add(item.id);
      if (removalRoots && !removalRoots.has(item.id)) removalRoots.set(item.id, 'draft-declaration');
    }
    // Keep the syntax used by a retained target even if its input was excluded. Removing
    // it could turn an identifier in the target's type into a new autoImplicit parameter.
    const requiredNotations = new Set<string>(), syntaxConsumers = declarations.filter(item => keep.has(item.id));
    const visitedSyntax = new Set(syntaxConsumers.map(item => item.id));
    const syntaxDependencies = observe ? new Map<string, Set<string>>() : undefined;
    const conditionalContext = observe ? new Set<string>() : undefined;
    for (const consumer of syntaxConsumers) {
      const conditionTypes = consumer.id === target ? conditions.map(input => input.type ?? '').join('\n') : '';
      // Host assumptions precede the original parameters. A same-named parameter
      // therefore cannot shadow a source constant in an injected assumption's type.
      const conditionReferences = conditionTypes ? sourceReferences(conditionTypes)
        .map(reference => ({ ...reference, offset: consumer.parametersOffset })) : [];
      const references = conditionReferences.length ? [...consumer.references, ...conditionReferences] : consumer.references;
      if (conditionalContext) for (const reference of conditionReferences)
        for (const group of referenceGroups(consumer, reference)) for (const id of group) conditionalContext.add(id);
      const dependencies = new Set<string>();
      for (const reference of references) for (const group of referenceGroups(consumer, reference))
        for (const id of group) {
          dependencies.add(id);
          if (!visitedSyntax.has(id)) {
            const dependency = byId.get(id);
            if (dependency) { visitedSyntax.add(id); syntaxConsumers.push(dependency); }
          }
        }
      const text = maskLeanCommentsAndStrings(sourceSnapshot.get(consumer.file)!
        .slice(consumer.notation ? consumer.bodyOffset : consumer.startOffset, consumer.endOffset) + '\n' + conditionTypes);
      for (const candidate of notationDeclarations) if (
          visibleBindings(consumer, [candidate]).length && candidate.notation.tokens.some(token =>
            isSimpleLeanName(token) ? references.some(reference => reference.name === token) : text.includes(token))) {
        dependencies.add(candidate.id);
        requiredNotations.add(candidate.id);
        if (!visitedSyntax.has(candidate.id)) { visitedSyntax.add(candidate.id); syntaxConsumers.push(candidate); }
      }
      syntaxDependencies?.set(consumer.id, dependencies);
    }
    // Source lookup cannot rule out imported providers or tactic-local synthesis.
    // Only prune implicit wrappers outside the retained target's possible class context.
    const requiredInstanceHeads = new Set(syntaxConsumers.flatMap(item => item.references.map(reference => local(reference.name))));
    // Removing or parameterizing a theorem also invalidates unrelated saved wrappers that call it.
    const changed = new Set([...removed, ...(conditions.length ? [target] : [])]);
    for (;;) {
      const changedInstance = instances.some(provider => changed.has(provider.item.id));
      const affected = declarations.filter(item => !keep.has(item.id) && !removed.has(item.id) &&
        (item.references.some(reference => referenceGroups(item, reference).some(candidates => item.notation
          ? candidates.every(reference => changed.has(reference)) : candidates.some(reference => changed.has(reference)))) ||
          notationGroups(item).some(candidates => item.notation
            ? candidates.every(reference => changed.has(reference)) : candidates.some(reference => changed.has(reference))) ||
          changedInstance && !visitedSyntax.has(item.id) &&
            !instances.some(provider => provider.item === item && provider.contextNames.some(name => requiredInstanceHeads.has(name))) &&
            implicitGroups(item).some(candidates => candidates.every(reference => changed.has(reference)))));
      if (!affected.length) break;
      for (const item of affected) { removed.add(item.id); changed.add(item.id); }
    }
    if (observe) {
      const counts = new Map<string, number>();
      for (const item of declarations) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
      const unique = new Map(declarations.filter(item => (item.name || item.notation) && counts.get(item.id) === 1)
        .map(item => [item.id, item]));
      const consumer = unique.get(target), requested = task.theoremName?.replace(/^_root_\./u, '');
      const describe = (item: typeof declarations[number]): ProjectionDeclaration => ({ file: item.file,
        name: item.qualifiedName, declarationDigest: mathDigest(sourceSnapshot.get(item.file)!.slice(item.startOffset, item.endOffset)) });
      const localBindings = (item: typeof declarations[number]) => new Set([
        ...maskLeanCommentsAndStrings(sourceSnapshot.get(item.file)!.slice(item.startOffset, item.endOffset))
          .matchAll(/(?:\b(?:let|letI|have|haveI|fun|intro|intros|rintro|obtain|rcases|case|rename_i)\b|∀|∃)\s+([^:=\n]*)(?:[:=\n]|$)/gu),
      ].flatMap(match => identifiers(match[1]!)));
      const hints: ProjectionDependencyHint[] = [];
      // The projection's name reader is advisory. Only exact, unique owned declarations may become a hint;
      // Lean still decides their actual dependency and accepts every repaired task independently.
      if (consumer && consumer.qualifiedName === requested) {
        const pending = [[consumer.id]], visited = new Set<string>();
        for (const route of pending) {
          const current = unique.get(route.at(-1)!)!;
          if (visited.has(current.id)) continue;
          visited.add(current.id);
          const reason = removalRoots!.get(current.id);
          if (route.length > 1 && reason) {
            const root = { ...describe(current), removedBecause: reason };
            const content: Omit<ProjectionDependencyHint, 'id'> = {
              authority: 'unambiguous-source-reference', proofAcceptance: 'not-assessed',
              problemReceiptDigest: problem.receiptDigest, sourceCommit,
              sourceDigest: mathDigest(canonicalMathJson([...sourceSnapshot].map(([file, source]) => [file, mathDigest(source)]))),
              consumer: { taskId: task.id, taskDigest: taskVersion(task), declaration: describe(consumer) },
              path: route.map(id => unique.get(id)!).filter(item => item.name).map(describe), root };
            hints.push({ id: projectionDependencyHintId(content), ...content });
            continue;
          }
          // Closed task and condition types supply qualified references even when the source
          // header uses a short name that the projector treats as possibly bound.
          const names = current === consumer ? [...current.references,
            ...[task, ...conditions].flatMap(input => identifiers(input.type ?? '').filter(name => name.includes('.')))
              .map(name => ({ name, offset: current.bodyOffset, receiverField: false }))] : current.references;
          const bound = localBindings(current), seen = new Set<string>();
          for (const reference of names) {
            const { name, receiverField } = reference;
            const lookup = `${name}\0${receiverField}\0${isBound(current, name.split('.')[0]!, reference.offset)}`;
            if (seen.has(lookup)) continue;
            seen.add(lookup);
            if (!receiverField && !name.includes('.') && bound.has(name)) continue;
            for (const candidates of referenceGroups(current, reference)) {
              const reference = candidates.length === 1 ? candidates[0] : undefined;
              if (reference && reference !== target && removed.has(reference) && unique.has(reference) && !route.includes(reference))
                pending.push([...route, reference]);
            }
          }
          for (const candidates of notationGroups(current)) {
            const id = candidates.length === 1 ? candidates[0] : undefined;
            const notation = id && notationById.get(id);
            // Multi-token and externally activated scoped syntax remain conservative.
            // Source hints cannot establish which overloaded parser branch Lean selected.
            if (id && notation?.tokens.length === 1 && (!notation.scoped ||
                current.namespace === notation.namespace || current.namespace.startsWith(notation.namespace + '.')) &&
                removed.has(id) && unique.has(id) && !route.includes(id)) pending.push([...route, id]);
          }
        }
      }
      // Required syntax and injected assumption types need their source context even
      // when source lookup cannot establish an unambiguous dependency.
      const context: ProjectionDeclaration[] = [], pendingContext = [...requiredNotations, ...conditionalContext!], visitedContext = new Set<string>();
      for (const id of pendingContext) {
        if (visitedContext.has(id)) continue;
        visitedContext.add(id);
        const item = unique.get(id);
        if (!item) continue;
        const reason = removalRoots!.get(id);
        if (reason) {
          if (reason === 'excluded-original-target' && item.name) context.push(describe(item));
          continue;
        }
        pendingContext.push(...syntaxDependencies!.get(id) ?? []);
      }
      observe(hints, context);
      // Hint callers consume only observations. Building and compacting acceptance sources here
      // repeats every owned-file edit for each transitive original input, then discards the result.
      return sources;
    }
    for (const file of problem.ownedFiles) {
      let source = sources.get(file)!;
      if (!file.endsWith('.lean')) continue;
      let conditionalPrelude: string | undefined;
      // Doc comments require a following declaration, which this projection may remove.
      source = masked.get(file)!.text;
      // A notation quotation is checked even when no retained theorem uses it. Drop the
      // complete command when its owned inputs were excluded, keeping edit offsets stable.
      for (const notation of notations.get(file) ?? []) if (removed.has(key(file, `@notation:${notation.startOffset}`)) &&
          !requiredNotations.has(key(file, `@notation:${notation.startOffset}`))) {
        const { startOffset, endOffset } = notation;
        source = source.slice(0, startOffset) + source.slice(startOffset, endOffset).replace(/[^\r\n]/gu, ' ') + source.slice(endOffset);
      }
      // Restricted opens require their named members to exist. Remove references to declarations
      // actually excluded by this projection, while keeping offsets stable for declaration edits below.
      for (const open of restrictedOpens.get(file)?.values() ?? []) {
        const excluded = (member: string) => {
          const candidates = open.namespaces.flatMap(namespace => bindings.get(`${namespace}.${member}`) ?? [])
            .filter(item => visible.get(file)!.has(item.file));
          return candidates.length > 0 && candidates.every(item => removed.has(item.id));
        };
        let replacement: string;
        if (open.mode === 'hiding') {
          const members = open.excluded!.filter(member => !excluded(member));
          if (members.length === open.excluded!.length) continue;
          replacement = `open ${open.name}${members.length ? ' hiding ' + members.join(' ') : ''}`;
        } else {
          const aliases = open.aliases!.filter(alias => !excluded(alias.from));
          if (aliases.length === open.aliases!.length) continue;
          replacement = !aliases.length ? '' : open.mode === 'selected'
            ? `open ${open.name} (${aliases.map(alias => alias.from).join(' ')})`
            : `open ${open.name} renaming ${aliases.map(alias => `${alias.from}→${alias.to}`).join(',')}`;
        }
        if (replacement && open.local) replacement += ' in';
        source = source.slice(0, open.startOffset) + replacement.padEnd(open.endOffset - open.startOffset) + source.slice(open.endOffset);
      }
      const fileRegions = masked.get(file)!.regions;
      for (const [index, region] of [...fileRegions.entries()].reverse()) {
        const declaration = byOffset.get(`${file}\0${region.startOffset}`)!;
        if (conditions.length && declaration.id === target) {
          const header = source.slice(region.startOffset, region.bodyOffset - 2);
          const name = (originalDefinition ? /^def\s+[^\s(\[{:]+/u : /^(?:theorem|lemma)\s+[^\s(\[{:]+/u).exec(header);
          if (!name || source.slice(region.bodyOffset - 2, region.bodyOffset) !== ':=') throw new Error('math_task_conditional_header_unsupported');
          let body = source.slice(region.bodyOffset, region.endOffset);
          // Keep original lookup identities while the helper elaborates polymorphic dependencies.
          for (const reference of sourceReferences(body, region.bodyOffset).reverse()) {
            if (reference.receiverField) continue;
            const dependency = conditions.find(item => item.theoremName === reference.name) ??
              assumptions.get(referenceKey(declaration, reference.name, reference.offset) ?? '');
            const index = reference.offset - region.bodyOffset;
            if (dependency) body = body.slice(0, index) + '_root_.' + inputs[conditions.indexOf(dependency)]!.theoremName +
              body.slice(index + reference.name.length);
          }
          const projected = conditionalProjection({ theoremName: declaration.qualifiedName, writtenName: region.name,
            declaration: header + ':=' + body, dependencies: inputs });
          conditionalPrelude = projected.prelude;
          source = source.slice(0, region.startOffset) + projected.source + source.slice(region.endOffset);
        } else if (removed.has(declaration.id)) {
          // A prefix left behind would bind to the following command, often the closing `end`.
          const start = declarationStartWithDoc(source, region.startOffset, index ? fileRegions[index - 1]!.endOffset : 0);
          source = source.slice(0, start) + source.slice(region.endOffset);
        }
      }
      if (file === task.proofPath && conditionModules.size) {
        const existing = new Set(mathConstructionImports(source));
        const modules = solverProofImports(problem, [...conditionModules].sort().map(module => `import ${module}\n`).join(''))
          .filter(module => !existing.has(module));
        source = modules.map(module => `import ${module}\n`).join('') + source;
      }
      if (conditionalPrelude) {
        const imports = mathConstructionImportSpans(source);
        const headerEnd = imports.at(-1)?.end ??
          /^(?:\s*(?:module|prelude)\b)*\s*/u.exec(maskLeanCommentsAndStrings(source))![0].length;
        const lean = imports.some(item => item.name === 'Lean') ? '' : 'import Lean\n';
        source = source.slice(0, headerEnd) + '\n' + lean + conditionalPrelude + '\n' + source.slice(headerEnd);
      }
      sources.set(file, source);
    }
    return options.compact ? compactTaskSources(problem, sources, task, retainedGoals, options.preserved) : sources;
  };
  const observations = new Map<string, { hints: readonly ProjectionDependencyHint[]; context: readonly ProjectionDeclaration[] }>();
  const observe = (task: CooperativeTask, retainedGoals: readonly string[], conditions: readonly CooperativeTask[]) => {
    const key = canonicalMathJson({ task, retainedGoals, conditions });
    let value = observations.get(key);
    if (!value) {
      project(task, retainedGoals, conditions, (hints, context) => { value = { hints, context }; });
      observations.set(key, value!);
    }
    return value!;
  };
  return Object.assign((task: CooperativeTask, retainedGoals: readonly string[], conditions: readonly CooperativeTask[] = []) =>
    project(task, retainedGoals, conditions), {
    /** Cache source observations for this immutable snapshot, never proof acceptance. */
    dependencyHints(task: CooperativeTask, retainedGoals: readonly string[], conditions: readonly CooperativeTask[] = []): readonly ProjectionDependencyHint[] {
      // Failed-proof metadata and other consumers may edit their copy of a hint.
      return structuredClone(observe(task, retainedGoals, conditions).hints);
    },
    /** Possible source context only. The host must freshly accept each input before retaining it. */
    possibleContextGoals(task: CooperativeTask, retainedGoals: readonly string[], conditions: readonly CooperativeTask[] = []): readonly ProjectionDeclaration[] {
      return structuredClone(observe(task, retainedGoals, conditions).context);
    },
    expectedType(task: CooperativeTask, conditions: readonly CooperativeTask[]): string | undefined {
      return task.kind === 'lemma' ? conditions.length
        ? conditionalExpectedType(task.theoremName!, task.type!, conditionalInputs(conditions)) : task.type : undefined;
    },
  });
}

/** Isolate one exact helper or original goal; incomplete unrelated original goals are removed. */
export async function checkTaskProof(problem: SolverProblem, worktree: string, sourceCommit: string,
  task: CooperativeTask, assignment: TaskAssignment, retainedGoals: readonly string[], env: NodeJS.ProcessEnv,
  signal: AbortSignal, timeoutMs = 180_000, conditions: readonly CooperativeTask[] = [],
  environmentDigest = mathDigest(canonicalMathJson(env)), cache?: TaskProofCache): Promise<TaskProof> {
  return (await checkTaskProofs(problem, worktree, sourceCommit, [{ task, assignment, retainedGoals, conditions }],
    env, signal, timeoutMs, environmentDigest, cache))[0]!;
}

/** Identical source projections share a kernel run, with a separate receipt for every target. */
export async function checkTaskProofs(problem: SolverProblem, worktree: string, sourceCommit: string,
  requests: readonly TaskProofRequest[], env: NodeJS.ProcessEnv, signal: AbortSignal, timeoutMs = 180_000,
  environmentDigest = mathDigest(canonicalMathJson(env)), cache?: TaskProofCache): Promise<TaskProof[]> {
  // Keep multi-target checks on their shared full projection. Single-target checks can
  // omit unrelated plain helpers without fragmenting the existing 32-target batches.
  const proofs = await checkTaskProofsWithProjection(problem, worktree, sourceCommit, requests, env, signal,
    timeoutMs, environmentDigest, cache, requests.length === 1);
  // Automatic tactics may discover declarations absent from their source text.
  // Retry only Lean elaboration failures; forbidden-axiom and draft-source
  // rejections cannot be repaired by restoring unrelated helpers.
  if (proofs.some(proof => proof.projectionMode === 'compact' && !proof.passed &&
      hasDeterministicLeanFailure(proof.verification) && proof.verification.results.some(result =>
        result.status === 'failed' && (!result.error || /^Lean exited with status 1\.?$/u.test(result.error.trim())))))
    return checkTaskProofsWithProjection(problem, worktree, sourceCommit, requests, env, signal,
      timeoutMs, environmentDigest, cache, false);
  return proofs;
}

async function checkTaskProofsWithProjection(problem: SolverProblem, worktree: string, sourceCommit: string,
  requests: readonly TaskProofRequest[], env: NodeJS.ProcessEnv, signal: AbortSignal, timeoutMs: number,
  environmentDigest: string, cache: TaskProofCache | undefined, compact: boolean): Promise<TaskProof[]> {
  signal.throwIfAborted();
  if (!requests.length) return [];
  for (const { task, conditions = [] } of requests) {
    assertTaskTypeContract(task);
    conditions.forEach(assertTaskTypeContract);
  }
  problem = structuredClone(problem);
  requests = structuredClone(requests);
  sourceCommit = git(worktree, ['rev-parse', `${sourceCommit}^{commit}`]);
  return withSolverWorktree(worktree, sourceCommit, async checkout => {
    assertSolverSources(problem, checkout);
    const projectSources = createTaskSourceProjector(problem, checkout, sourceCommit);
    const prepared = requests.map(({ task, assignment, retainedGoals, conditions = [] }) => {
      const connection = hasTaskConnectionCheck(task, assignment);
      if (assignment.connectionCheck && (!connection || assignment.connectionCheck.environmentDigest !== environmentDigest ||
          assignment.connectionCheck.problemReceiptDigest !== problem.receiptDigest))
        throw new Error('math_task_condition_version_invalid');
      if (conditions.some(dependency => !(task.conditional || connection) || !assumableLemma(dependency) ||
          (connection && !(assignment.connectionCheck!.assumedInputs ?? assignment.connectionCheck!.inputs).some(input => input.taskId === dependency.id &&
            input.taskDigest === taskVersion(dependency))) ||
          !assignment.dependencies?.some(version => version.taskId === dependency.id && version.taskDigest === taskVersion(dependency))))
        throw new Error('math_task_condition_version_invalid');
      const changes = taskChanges(problem, checkout, sourceCommit, task, assignment);
      // Assumed children are supplied by their own checked deliveries, never by this parent's draft.
      const assumed = new Set(conditions.flatMap(dependency => inspectScopedLeanDeclarations(
        committedSource(worktree, sourceCommit, `${problem.projectRelative}/${dependency.proofPath}`))
        .filter(declaration => declaration.qualifiedName === dependency.theoremName ||
          !dependency.theoremName!.includes('.') && declaration.name === dependency.theoremName)
        .map(declaration => `${dependency.proofPath}\0${declaration.name}`)));
      const sources = projectSources(task, retainedGoals, conditions);
      const imports = problem.ownedFiles.filter(file => file.endsWith('.lean')).flatMap(file => {
        const before = solverProofImports(problem, committedSource(worktree, assignment.seedCommit, `${problem.projectRelative}/${file}`));
        return solverProofImports(problem, sources.get(file)!)
          .filter(module => !before.includes(module)).map(module => ({ file, module }));
      });
      return { task, assignment, retainedGoals, conditions, imports, changes: changes.filter(change => !assumed.has(`${change.file}\0${change.name}`)),
        taskDigest: taskVersion(task), sources,
        expectedType: projectSources.expectedType(task, conditions) };
    });
    const fullSources = prepared[0]!.sources;
    if (prepared.some(item => canonicalMathJson([...item.sources]) !== canonicalMathJson([...fullSources])))
      throw new Error('math_task_batch_projection_mismatch');
    // Every declaration changed by this delivery remains checked. Only inherited helpers
    // may be omitted; an unused new sibling must not enter canonical without elaboration.
    const sources = compact ? compactTaskSources(problem, fullSources, prepared[0]!.task, prepared[0]!.retainedGoals,
      prepared.flatMap(item => item.changes)) : fullSources;
    const compacted = compact && canonicalMathJson([...sources]) !== canonicalMathJson([...fullSources]);
    const project = path.join(checkout, problem.projectRelative);
    for (const [file, source] of sources) fs.writeFileSync(path.join(project, file), source);
    const commit = commitSolverProjection(problem, checkout, `Check cooperative tasks ${requests.map(item => item.task.id).join(', ')}`);
    const execution = { prepareLocalDependencies: problem.kind === 'lean-eval', collectDeclarationReferences: true,
      ...(prepared.length === 1 ? { expectedDeclarationType: prepared[0]!.expectedType } : {
        expectedDeclarationTypes: Object.fromEntries(prepared.filter(item => item.expectedType !== undefined)
          .map(item => [item.task.theoremName!, item.expectedType!])) }) };
    const targets = prepared.map(({ task, taskDigest }) => ({ proofPath: task.proofPath!, theoremName: task.theoremName!,
      digest: taskDigest, missingError: 'math_task_missing_declaration' }));
    const sourceProject = path.join(worktree, problem.projectRelative);
    const environment = cache ? proofReuseEnvironment(sourceProject, env) : undefined;
    const tools = environment && formalVerificationToolIdentity(project, environment.env);
    const assertStableEnvironment = () => {
      signal.throwIfAborted();
      if (!environment) return;
      const after = proofReuseEnvironment(sourceProject, env);
      if (after.reusable !== environment.reusable || after.digest !== environment.digest ||
          canonicalMathJson(after.env) !== canonicalMathJson(environment.env) ||
          formalVerificationToolIdentity(project, after.env) !== tools) throw new Error('math_verifier_unavailable');
    };
    const run = async () => {
      try {
        return await checkProjectedDeclarations(problem, checkout, worktree, commit, targets,
          { env: environment?.env ?? env, signal, timeoutMs, ...execution });
      } finally { assertStableEnvironment(); }
    };
    let attributions: Awaited<ReturnType<typeof checkProjectedDeclarations>>['attributions'];
    let projectionReuse: TaskProjectionReuse | undefined;
    if (cache && environment?.reusable && tools) {
      const projectionTree = git(checkout, ['rev-parse', `${commit}^{tree}`]);
      const items: MathematicsVerifierBatchItem[] = targets.map(target => ({ proofPath: target.proofPath,
        theoremName: target.theoremName, statementHash: target.digest, leanStatementHash: target.digest, claim: 'statement',
        expectedSourceDeclarationHash: hashMathFormalSourceDeclaration(sources.get(target.proofPath)!, target.theoremName) }));
      const inputDigest = mathDigest(canonicalMathJson({
        repository: git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
        projectionTree, problem, targets: items, environment: environment.digest, tools, environmentDigest,
        execution: { ...execution, timeoutMs: timeoutMs === Infinity ? 'unlimited' : timeoutMs,
          batchTimeoutMs: timeoutMs === Infinity ? 'unlimited' : 'default',
          trustedLakePackagesRoots: (environment.env.DEEPSCIENTIST_MATH_TRUSTED_CACHE_ROOTS || '').split(path.delimiter).filter(Boolean) },
        requests: prepared.map(({ taskDigest, assignment, retainedGoals, conditions }) => {
          const { seedCommit: _seed, basisDigest: _basis, ...connection } = assignment.connectionCheck ?? {};
          return { taskDigest, dependencies: assignment.dependencies ?? [], retainedGoals,
            connectionCheck: assignment.connectionCheck ? connection : undefined, conditions: conditions.map(taskVersion) };
        }),
      }));
      const valid = ({ projectionCommit, verification }: TaskVerificationArtifact) => {
        try {
          if (git(worktree, ['rev-parse', `${projectionCommit}^{tree}`]) !== projectionTree) return false;
          return attributeProofEvidence(verification, projectionCommit, items).every(attribution =>
            !attribution.verification.results.some(result => result.cleanupError) &&
            (attribution.passed || attribution.attributable && hasDeterministicLeanFailure(attribution.verification)));
        } catch { return false; }
      };
      let artifact: TaskVerificationArtifact;
      try {
        artifact = await cache.check(inputDigest, signal, valid, async () => {
          const checked = await run();
          return { projectionCommit: commit, verification: checked.verification };
        });
      } finally { assertStableEnvironment(); }
      attributions = attributeProofEvidence(artifact.verification, artifact.projectionCommit, items);
      if (artifact.projectionCommit !== commit) projectionReuse = {
        schema: 'theorem-os.task-projection-reuse.v1', projectionCommit: commit,
        checkedProjectionCommit: artifact.projectionCommit, projectionTree, inputDigest,
      };
    } else attributions = (await run()).attributions;
    const sourceDigest = ownedSourceDigest(problem, checkout, sourceCommit);
    return prepared.map(({ task, assignment, taskDigest, changes, imports, retainedGoals, conditions }, index) => {
      const { passed, verification, attributable } = attributions[index]!;
      const result = verification.results[0];
      const references = passed && !conditions.length && result?.declarationReferences ? captureProofReferences(problem, checkout, sourceCommit,
        { name: task.theoremName!, file: task.proofPath! }, result.declarationReferences, environmentDigest) : undefined;
      const projectionDependencyHints = !passed ? projectSources.dependencyHints(task, retainedGoals, conditions) : [];
      const proof: TaskProof = { commit: sourceCommit, sourceDigest, passed, verification,
        taskDigest, seedCommit: assignment.seedCommit, changes, ...(imports.length ? { imports } : {}),
        ...(compacted ? { projectionMode: 'compact' as const } : {}),
        ...(projectionReuse ? { projectionReuse: { ...projectionReuse } } : {}),
        ...(projectionDependencyHints.length ? { projectionDependencyHints } : {}),
        ...(references ? { references } : {}),
        ...(conditions.length ? { conditions: conditions.map(dependency => ({ taskId: dependency.id, taskDigest: taskVersion(dependency) })) } : {}) };
      if (attributable) attributedProofs.set(proof, mathDigest(canonicalMathJson(proof)));
      if (projectionReuse) reusedProjections.set(proof, mathDigest(canonicalMathJson(proof)));
      return proof;
    });
  });
}

// Attribute lines and `omit/include/open/... in` commands bind to the next command, which is `end NS` once their declaration is removed.
const modifiers = /^(?:private|protected|public|noncomputable|nonrec|unsafe|partial|meta)(?:\s+(?:private|protected|public|noncomputable|nonrec|unsafe|partial|meta))*$/u;
const inPrefix = /^(?:(?:local|scoped|private|public)\s+)*(?:omit|include|open|set_option|variable|attribute|unseal|notation|macro|syntax)\b[\s\S]*\sin$/u;
function attributes(command: string): boolean {
  let depth = 0;
  for (let index = 0; index < command.length; index++) {
    if (depth) depth += command[index] === '[' ? 1 : command[index] === ']' ? -1 : 0;
    else if (command.startsWith('@[', index)) { depth = 1; index++; }
    else if (!/\s/u.test(command[index])) return false;
  }
  return !depth;
}

/** Move an attached document comment, attribute lines and `... in` prefix commands with their declaration
 * without changing archived patch text. The result never precedes `floor`, the previous declaration's end. */
export function declarationStartWithDoc(source: string, startOffset: number, floor?: number): number {
  const lineStart = source.lastIndexOf('\n', startOffset - 1) + 1;
  const low = Math.min(lineStart, floor ?? Math.max(0, ...inspectLeanDeclarationRegions(source)
    .filter(region => region.endOffset <= lineStart).map(region => region.endOffset)));
  const masked = maskLeanComments(source.slice(low)), at = (offset: number) => offset - low;
  const indentation = startOffset - lineStart - source.slice(lineStart, startOffset).trimStart().length;
  let start = lineStart;
  for (;;) {
    const doc = docCommentStart(source, start);
    if (doc >= low && doc < start) { start = doc; continue; }
    // Walk over blank, comment and continuation lines to the head of the previous command.
    let head = start;
    while (head > low) {
      const line = at(head) < 2 ? low : masked.lastIndexOf('\n', at(head) - 2) + 1 + low;
      const text = masked.slice(at(line), at(head)).replace(/\r?\n$/u, '');
      head = line;
      if (text.trim() && text.length - text.trimStart().length <= indentation) break;
    }
    const command = masked.slice(at(head), at(start)).trim();
    if (head >= start || !command || !attributes(command) && !modifiers.test(command) && !inPrefix.test(command)) return start;
    start = head;
  }
}

function docCommentStart(source: string, lineStart: number): number {
  let cursor = lineStart;
  while (cursor > 0 && /\s/u.test(source[cursor - 1])) cursor--;
  if (source.slice(cursor - 2, cursor) !== '-/') return lineStart;
  cursor -= 2;
  let depth = 1;
  while (cursor > 0) {
    const pair = source.slice(cursor - 2, cursor);
    if (pair === '-/') { depth++; cursor -= 2; }
    else if (pair === '/-') {
      cursor -= 2;
      if (--depth === 0) {
        const commentLine = source.lastIndexOf('\n', cursor - 1) + 1;
        return source.startsWith('/--', cursor) && !source.slice(commentLine, cursor).trim() ? commentLine : lineStart;
      }
    } else cursor--;
  }
  return lineStart;
}

/** Discharge saved assumptions against declarations that may have arrived after the old insertion anchor. */
function orderConditionalChanges(source: string, file: string, changes: readonly DeclarationChange[],
  conditions: readonly CooperativeTask[]): string {
  const names = new Set(changes.filter(change => change.file === file).map(change => change.name)), keys = leanDeclarationKeys(source);
  const ordered = inspectScopedLeanDeclarations(source).filter(declaration => names.has(keys.get(declaration.startOffset)!));
  const previous = new Map<string, string>();
  for (const original of ordered) {
    const declarations = inspectScopedLeanDeclarations(source), regions = inspectLeanDeclarationRegions(source);
    const declaration = declarations.find(item => item.qualifiedName === original.qualifiedName)!;
    const region = regions.find(item => item.startOffset === declaration.startOffset)!;
    const context = canonicalMathJson(leanDeclarationContextCommands(source, declaration.qualifiedName));
    const text = source.slice(region.startOffset, region.endOffset);
    const references = new Set([...maskLeanCommentsAndStrings(text).matchAll(/[\p{L}_][\p{L}\p{M}\p{N}_'?!]*(?:\.[\p{L}_][\p{L}\p{M}\p{N}_'?!]*)*/gu)]
      .map(match => match[0].replace(/^_root_\./u, '')));
    const inputs = conditions.filter(input => input.proofPath === file &&
      (references.has(input.theoremName!) || references.has(local(input.theoremName!))));
    const candidates = declarations.filter(item => item.qualifiedName === previous.get(context) || inputs.some(input =>
      item.qualifiedName === input.theoremName || !input.theoremName!.includes('.') && item.name === input.theoremName));
    const anchor = candidates.filter(item => item.startOffset > declaration.startOffset)
      .toSorted((a, b) => b.startOffset - a.startOffset)[0];
    previous.set(context, declaration.qualifiedName);
    if (!anchor) continue;
    const anchorRegion = regions.find(item => item.startOffset === anchor.startOffset)!;
    // Scope equality alone omits variable/notation/attribute commands. Only cross declarations
    // and comments; other context changes require an explicit source repair from the worker.
    let between = source.slice(region.endOffset, anchorRegion.endOffset);
    for (const crossed of regions.filter(item => item.startOffset >= region.endOffset && item.endOffset <= anchorRegion.endOffset).reverse()) {
      const start = declarationStartWithDoc(source, crossed.startOffset) - region.endOffset, end = crossed.endOffset - region.endOffset;
      between = between.slice(0, start) + between.slice(end);
    }
    if (canonicalMathJson(leanDeclarationContextCommands(source, anchor.qualifiedName)) !== context || maskLeanComments(between).trim())
      throw new Error('math_task_integration_missing_context\nA conditional consumer precedes its checked input across context commands. ' +
        'Move the consumer and its supporting helpers after that input while preserving the frozen source context.');
    const start = declarationStartWithDoc(source, region.startOffset);
    const moved = source.slice(start, region.endOffset);
    source = source.slice(0, start) + source.slice(region.endOffset, anchorRegion.endOffset) + moved + source.slice(anchorRegion.endOffset);
  }
  return source;
}

/** Merge disjoint declaration edits, including helpers sharing a file, without overwriting peer work. */
export function applyTaskChanges(problem: SolverProblem, worktree: string, changes: readonly DeclarationChange[],
  imports: NonNullable<TaskProof['imports']> = [], conditions: readonly CooperativeTask[] = [],
  delivery?: Pick<TaskProof, 'commit' | 'seedCommit'>): void {
  if (delivery && !conditions.length) {
    const sources = problem.ownedFiles.map(file => ({ file,
      before: committedSource(worktree, delivery.seedCommit, `${problem.projectRelative}/${file}`),
      after: committedSource(worktree, delivery.commit, `${problem.projectRelative}/${file}`) }));
    const exactSeed = sources.every(({ file, before }) =>
      fs.readFileSync(path.join(worktree, problem.projectRelative, file), 'utf8') === before);
    const expectedImports = sources.filter(({ file }) => file.endsWith('.lean')).flatMap(({ file, before, after }) =>
      solverProofImports(problem, after).filter(module => !solverProofImports(problem, before).includes(module))
        .map(module => ({ file, module })));
    // A byte-preserving copy is safe only for the complete authorized patch on its unchanged seed.
    // Concurrent edits and discharged assumptions continue through the original declaration merger.
    if (exactSeed && canonicalMathJson(taskChanges(problem, worktree, delivery.commit, undefined, delivery)) === canonicalMathJson(changes) &&
        canonicalMathJson(expectedImports) === canonicalMathJson(imports)) {
      for (const { file, after } of sources) fs.writeFileSync(path.join(worktree, problem.projectRelative, file), after);
      assertSolverSources(problem, worktree);
      return;
    }
  }
  const files = new Map<string, string>();
  for (const change of changes) {
    if (!problem.ownedFiles.includes(change.file)) throw new Error('math_task_source_outside_scope');
    let source = files.get(change.file) ?? fs.readFileSync(path.join(worktree, problem.projectRelative, change.file), 'utf8');
    const regions = keyedRegions(source);
    const named = (items: typeof regions, name: string) =>
      items.find(region => region.key === name) ?? items.find(region => region.name === name);
    const existing = named(regions, change.name);
    if (existing) {
      const start = source.lastIndexOf('\n', existing.startOffset - 1) + 1;
      const actual = source.slice(start, existing.endOffset).trimEnd() + '\n';
      if (actual !== change.after && (!change.before || actual !== change.before)) throw new Error('math_task_integration_conflict');
      if (change.afterName && change.before) {
        const anchor = named(regions, change.afterName);
        if (!anchor || canonicalMathJson(leanDeclarationContextCommands(source, change.name)) !==
            canonicalMathJson(leanDeclarationContextCommands(source, change.afterName)))
          throw new Error('math_task_integration_missing_context');
        const moveStart = declarationStartWithDoc(source, existing.startOffset);
        const documentation = source.slice(moveStart, start);
        if (actual === change.after && anchor.endOffset === moveStart) continue;
        source = source.slice(0, moveStart) + source.slice(existing.endOffset);
        const offset = named(keyedRegions(source), change.afterName)!.endOffset;
        source = source.slice(0, offset) + documentation + change.after + source.slice(offset);
      } else {
        if (actual === change.after) continue;
        source = source.slice(0, start) + change.after + source.slice(existing.endOffset);
      }
    } else {
      if (change.before) throw new Error('math_task_integration_missing_declaration');
      const anchor = change.beforeName && named(regions, change.beforeName);
      const sibling = change.afterName && named(regions, change.afterName);
      const offset = anchor ? declarationStartWithDoc(source, anchor.startOffset) : sibling ? sibling.endOffset :
        change.tail !== undefined && source.endsWith(change.tail) ? source.length - change.tail.length : -1;
      if (offset < 0) throw new Error('math_task_integration_missing_context');
      const separator = sibling && offset > 0 && source[offset - 1] !== '\n' ? '\n' : '';
      source = source.slice(0, offset) + separator + change.after + source.slice(offset);
    }
    files.set(change.file, source);
  }
  for (const { file, module } of imports) {
    if (!problem.ownedFiles.includes(file) || !solverProofImports(problem, `import ${module}\n`).includes(module))
      throw new Error('math_task_source_outside_scope');
    const source = files.get(file) ?? fs.readFileSync(path.join(worktree, problem.projectRelative, file), 'utf8');
    if (!solverProofImports(problem, source).includes(module)) files.set(file, `import ${module}\n` + source);
  }
  for (const [file, source] of files) fs.writeFileSync(path.join(worktree, problem.projectRelative, file),
    conditions.length && file.endsWith('.lean') ? orderConditionalChanges(source, file, changes, conditions) : source);
  assertSolverSources(problem, worktree);
}
