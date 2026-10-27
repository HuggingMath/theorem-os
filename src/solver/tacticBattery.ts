import fs from 'node:fs';
import path from 'node:path';
import { mathConstructionImports, mathLocalModuleBuildOrder } from '../math/mathConstructionSources';
import { inspectLeanDeclarationRegions, inspectLeanSource, inspectScopedLeanDeclarations } from '../math/leanSource';
import { maskLeanCommentsAndStrings } from '../math/leanSyntax';
import { checkLeanType } from '../math/leanTypeDiagnostics';
import { declarationStartWithDoc } from './cooperativeProof';
import { commitSolverSources, committedSource, withSolverWorktree, type SolverProblem } from './problem';
import { isDefinitionTask, type CooperativeTask } from './tasks';
import { familyAssemblyProof } from './taskFamilies';

/** Bounds the advisory stage, including environment import; the ordinary task check keeps its own timeout. */
export const TACTIC_BATTERY_TIMEOUT_MS = 120_000;

// Every closing alternative must fail unless it closes the goal; `first` then tries the next one.
const CORE_TACTICS = ['rfl', 'trivial', 'omega', '(simp; done)', '(intros; simp_all; done)', 'decide'];
const MATHLIB_TACTICS = ['(intros; norm_num; done)', '(intros; linarith)', '(intros; positivity)', '(intros; ring_nf; done)',
  'tauto', '(intros; aesop; done)'];

/** The battery is fixed bytes; a project without Mathlib cannot parse its tactic names. */
export function tacticBatteryProof(mathlib: boolean): string {
  return `by first | ${[...CORE_TACTICS, ...(mathlib ? MATHLIB_TACTICS : [])].join(' | ')}`;
}

// Each alternative must close `False` from the introduced hypotheses alone.
const CORE_CONTRADICTIONS = ['contradiction', 'omega', '(simp_all; done)'];
const MATHLIB_CONTRADICTIONS = ['linarith', '(norm_num at *; done)', 'tauto', '(aesop; done)'];

/**
 * Proves the type only by deriving `False` from its introduced hypotheses. A type whose conclusion is
 * already `False` asks for a refutation, so the guard keeps that from being reported as vacuous.
 */
export function vacuityProbeProof(mathlib: boolean): string {
  return 'by intros; (fail_if_success guard_target =ₛ False); exfalso; first | ' +
    [...CORE_CONTRADICTIONS, ...(mathlib ? MATHLIB_CONTRADICTIONS : [])].join(' | ');
}

function importsMathlib(projectRoot: string, file: string): boolean {
  try {
    return mathLocalModuleBuildOrder(projectRoot, file).some(module => mathConstructionImports(
      fs.readFileSync(path.join(projectRoot, module.file), 'utf8')).some(name => name === 'Mathlib' || name === 'Mathlib.Tactic'));
  } catch { return false; }
}

/**
 * Place the battery as the assigned theorem: fill an existing `sorry` body, or insert a new theorem before
 * the preflight anchor so it shares that anchor's namespace and open scopes. Ambiguous placements return undefined.
 */
export function tacticBatterySource(problem: SolverProblem, source: string, task: CooperativeTask, anchorName: string,
  proof: string): string | undefined {
  const requested = task.theoremName!.replace(/^_root_\./u, ''), leaf = requested.split('.').at(-1)!;
  if (Object.values(problem.declarations).some(items => items.some(item => item.name.split('.').at(-1) === leaf))) return;
  const declarations = inspectScopedLeanDeclarations(source), regions = inspectLeanDeclarationRegions(source);
  const same = declarations.filter(item => item.name.split('.').at(-1) === leaf);
  let candidate: string;
  if (same.length) {
    if (same.length > 1 || same[0].kind !== 'theorem' || same[0].qualifiedName !== requested) return;
    const region = regions.find(item => item.startOffset === same[0].startOffset)!;
    const body = inspectLeanSource(source.slice(region.bodyOffset, region.endOffset));
    if (!body.sorryCount && !body.admitCount) return;
    const separator = source.slice(region.bodyOffset, region.endOffset).match(/\n\s*$/u)?.[0] ?? '\n';
    candidate = source.slice(0, region.bodyOffset) + ` ${proof}` + separator + source.slice(region.endOffset);
  } else {
    const anchor = declarations.find(item => item.qualifiedName === anchorName);
    if (!anchor) return;
    const name = !anchor.namespace ? requested : requested.startsWith(`${anchor.namespace}.`) ?
      requested.slice(anchor.namespace.length + 1) : undefined;
    if (!name) return;
    const offset = declarationStartWithDoc(source, anchor.startOffset);
    // Attributes, modifiers and `... in` commands bind to the anchor; inserting between them and it would capture them.
    const previous = maskLeanCommentsAndStrings(source.slice(0, offset)).trimEnd().split('\n').at(-1) ?? '';
    const prefix = source.slice(offset, anchor.startOffset).replace(/^\s*\/--[\s\S]*?-\/\s*/u, '');
    if (/^\s*@\[|\]\s*$|^\s*(?:(?:private|protected|public|noncomputable|nonrec|unsafe|partial|meta)\s*)+$|\bin\s*$/u.test(previous) ||
        prefix.trim()) return;
    const indentation = source.slice(source.lastIndexOf('\n', anchor.startOffset - 1) + 1, anchor.startOffset).match(/^\s*/u)![0];
    candidate = source.slice(0, offset) + `${indentation}theorem ${name} : ${task.type}\n${indentation}  := ${proof}\n\n` +
      source.slice(offset);
  }
  const inserted = inspectScopedLeanDeclarations(candidate).filter(item => item.name.split('.').at(-1) === leaf);
  return inserted.length === 1 && inserted[0].kind === 'theorem' && inserted[0].qualifiedName === requested ? candidate : undefined;
}

export type TacticBatteryResult = { status: 'closed' | 'failed' | 'skipped' | 'unavailable'; reason: string; commit?: string;
  artifact?: { path: string; digest: string }; evidence: 'advisory-tactic-battery'; proofAcceptance: 'not-accepted';
  /** Set on a closed result whose hypotheses alone derive `False`; absent when the probe did not run or was inconclusive. */
  vacuous?: true };

/**
 * Try a fixed tactic battery against an elaborated closed helper type before a model turn. Stage one is a
 * proof-erased advisory check; only a closed result is written as a commit for the ordinary task proof check.
 * A closed type is then probed for contradictory hypotheses, since automation closes those without using the claim.
 */
export async function closeTaskByTactics(input: { problem: SolverProblem; task: CooperativeTask; worktree: string;
  seedCommit: string; context: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs: number }): Promise<TacticBatteryResult> {
  const base = { evidence: 'advisory-tactic-battery' as const, proofAcceptance: 'not-accepted' as const };
  const { problem, task } = input;
  if (task.kind !== 'lemma' || isDefinitionTask(task) || !task.type?.trim() || !task.proofPath || !task.theoremName)
    return { ...base, status: 'skipped', reason: 'not-typed-lemma' };
  const project = path.join(input.worktree, problem.projectRelative);
  const mathlib = importsMathlib(project, task.proofPath);
  const proof = tacticBatteryProof(mathlib), started = Date.now();
  let edited: string | undefined;
  try {
    edited = tacticBatterySource(problem, committedSource(input.worktree, input.seedCommit,
      `${problem.projectRelative}/${task.proofPath}`), task, input.context, proof);
  } catch { /* An unreadable seed source has no placement. */ }
  if (!edited) return { ...base, status: 'skipped', reason: 'placement-unavailable' };
  let checked;
  try {
    checked = await checkLeanType({ projectRoot: project, file: task.proofPath, context: input.context, type: task.type,
      expression: proof, env: input.env, signal: input.signal, timeoutMs: input.timeoutMs });
  } catch { return { ...base, status: 'unavailable', reason: input.signal?.aborted ? 'aborted' : 'check-unavailable' }; }
  if (checked.status !== 'elaborated' || checked.constants?.includes('sorryAx'))
    return { ...base, status: checked.timedOut ? 'unavailable' : 'failed', reason: checked.timedOut ? 'timed-out' : 'battery-did-not-close',
      artifact: checked.artifact };
  let commit: string;
  try {
    // A disposable checkout keeps the idle worker worktree at its seed; worktrees share the object store.
    commit = await withSolverWorktree(input.worktree, input.seedCommit, async checkout => {
      fs.writeFileSync(path.join(checkout, problem.projectRelative, task.proofPath!), edited);
      return commitSolverSources(problem, checkout);
    });
  } catch { return { ...base, status: 'unavailable', reason: 'candidate-commit-unavailable', artifact: checked.artifact }; }
  const vacuous = await contradictoryHypotheses(project, task, input, mathlib, input.timeoutMs - (Date.now() - started));
  return { ...base, status: 'closed', reason: 'battery-closed-erased-type', commit, artifact: checked.artifact,
    ...(vacuous ? { vacuous } : {}) };
}

export type FamilyAssemblyResult = { status: 'committed' | 'skipped' | 'unavailable'; reason: string; commit?: string;
  evidence: 'host-family-assembly'; proofAcceptance: 'not-accepted' };

/**
 * Write the family task's case-split proof over its member lemmas as a commit for the ordinary task check. No Lean
 * runs here: the members it names may not exist yet, and the check binds unproved members as explicit hypotheses.
 */
export async function assembleFamilyTask(input: { problem: SolverProblem; task: CooperativeTask; worktree: string;
  seedCommit: string; context: string }): Promise<FamilyAssemblyResult> {
  const base = { evidence: 'host-family-assembly' as const, proofAcceptance: 'not-accepted' as const };
  const { problem, task } = input;
  if (task.kind !== 'lemma' || !task.family || !task.proofPath || !task.theoremName) return { ...base, status: 'skipped', reason: 'not-family' };
  let edited: string | undefined;
  try {
    edited = tacticBatterySource(problem, committedSource(input.worktree, input.seedCommit,
      `${problem.projectRelative}/${task.proofPath}`), task, input.context, familyAssemblyProof(task.theoremName, task.family));
  } catch { /* An unreadable seed source has no placement. */ }
  if (!edited) return { ...base, status: 'skipped', reason: 'placement-unavailable' };
  try {
    const commit = await withSolverWorktree(input.worktree, input.seedCommit, async checkout => {
      fs.writeFileSync(path.join(checkout, problem.projectRelative, task.proofPath!), edited);
      return commitSolverSources(problem, checkout);
    });
    return { ...base, status: 'committed', reason: 'family-assembled', commit };
  } catch { return { ...base, status: 'unavailable', reason: 'candidate-commit-unavailable' }; }
}

/** Advisory only: a failed, timed-out or unavailable probe reports nothing rather than non-vacuity. */
async function contradictoryHypotheses(project: string, task: CooperativeTask, input: { context: string; env: NodeJS.ProcessEnv;
  signal?: AbortSignal }, mathlib: boolean, timeoutMs: number): Promise<true | undefined> {
  if (timeoutMs <= 0 || input.signal?.aborted) return;
  try {
    const probe = await checkLeanType({ projectRoot: project, file: task.proofPath!, context: input.context, type: task.type!,
      expression: vacuityProbeProof(mathlib), env: input.env, signal: input.signal, timeoutMs });
    return probe.status === 'elaborated' && probe.constants !== undefined && !probe.constants.includes('sorryAx') ? true : undefined;
  } catch { return; }
}
