import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mathGitBytes, mathGitText } from '../math/mathGit';
import { readImo2026BootstrapReceipt, verifyImo2026BootstrapReceipt, theoremQualifiedNamesFromSource } from '../math/imo2026Adapter';
import { readLeanEvalBootstrapReceipt } from '../math/leanEvalBootstrap';
import { resolveLeanEvalSubmissionName } from '../math/leanEvalSubmission';
import { canonicalMathJson, mathDigest, readMathJson } from '../math/mathRuntimeIo';
import { assertMathCanonicalPath, isMathPathWithin } from '../math/paths';
import { hashMathFormalSourceDeclaration, inspectLeanDeclarationRegions, inspectLeanDeclarations, inspectLegacyLeanWhereSource,
  inspectScopedLeanDeclarations } from '../math/leanSource';
import { mathConstructionImports, mathLocalModuleBuildOrder } from '../math/mathConstructionSources';
import { isAllowedMathProofSource } from '../math/mathProofSourcePolicy';
import type { MathProblemContract } from '../math/contracts';
import { readLocalExampleReceipt } from '../math/localExample';
import { readLeanTaskReceipt } from '../math/leanTask';
import { DECLARATION_INDEX_FILE } from './declarationIndex';
import { libraryDeclarationConflict } from '../math/libraryPacks';
import { maskLeanComments } from '../math/leanSyntax';
import type { EffectiveLibraryBinding } from '../math/libraryEffectivePack';
import type { LibraryHostTaskIdentity } from '../math/libraryHostConfig';
import { isSolverMathlibImport, originalDeclarationRegions, solverSourceContext as sourceContext } from './sourceContext';
import { assertMathAgentSkillsCurrent, type MathAgentSkill } from '../runtime/agentSkills';
export { originalDeclarationRegions, solverMathlibImports } from './sourceContext';

// Host-only metadata permissions are scoped to this exact problem object and checkout.
// Loading an archive or running legacy mode does not grant a new editable source path.
const researchSkills = new WeakMap<SolverProblem, Map<string, MathAgentSkill>>();
export function pinSolverResearchSkill(problem: SolverProblem, worktree: string, skill: MathAgentSkill): void {
  if (skill.name !== 'theoremos-research' || skill.path !== path.join(worktree, '.agents/skills/theoremos-research/SKILL.md'))
    throw new Error('math_research_skill_path_changed');
  assertMathAgentSkillsCurrent([skill]);
  if (!researchSkills.has(problem)) researchSkills.set(problem, new Map());
  researchSkills.get(problem)!.set(worktree, skill);
}

export function committedSource(worktree: string, commit: string, file: string): string {
  // Matches the Lean-Eval per-file limit so generated certificate modules remain readable.
  return mathGitBytes(worktree, ['show', `${commit}:${file}`],
    { timeout: 30_000, maxBuffer: 16 * 1024 * 1024, errorMessage: 'math_task_source_unavailable' }).toString('utf8');
}

export type ProofTarget = Readonly<{ proofPath: string; theoremName: string; declarationHash: string }>;
export class SolverSourceError extends Error {
  constructor(readonly proofPath: string, reason: 'math_original_declaration_changed' | 'math_original_context_changed' | 'math_local_module_import_cycle' |
    'math_library_module_changed' | 'math_library_declaration_redeclared', readonly declarationName?: string) {
    super(reason);
  }
  get recovery(): string {
    if (this.message === 'math_local_module_import_cycle')
      return 'Remove the added local import that creates a cycle. Owned modules may import frozen dependencies and each other, but a module cannot import one that imports it. Preserve the saved proof work.';
    if (this.message === 'math_library_module_changed')
      return 'This Submission/Library module is a frozen host library: restore its exact bytes from the seed commit with git show. Import it and add new helpers in another owned file.';
    if (this.message === 'math_library_declaration_redeclared')
      return `${this.declarationName ?? 'This declaration'} is already declared by a frozen Submission/Library module. Remove or rename the copy and use the library declaration by importing its module.`;
    return this.message === 'math_original_context_changed'
      ? 'Restore the original imports, namespace/section placement, variables, opens, scopes and options from the seed commit. ' +
        'Keep new helpers; move helper-specific scopes and instances inside their proofs. Added imports may use Mathlib or any pinned Mathlib.* module, frozen local modules already imported by the original owned sources, or other owned modules; avoid import cycles.'
      : `Restore the original name, parameters, type and any frozen proof or definition body${this.declarationName ? ` of ${this.declarationName}` : ''} from the seed commit. Preserve new proof work.`;
  }
}
/** `qualifiedName` is set only when the statement repeats the written name in another namespace. */
export type OriginalDeclaration = Readonly<{ name: string; qualifiedName?: string; header: string; body?: string }>;


export type SolverProblem = Readonly<{
  kind: 'imo2026' | 'lean-eval' | 'example' | 'lean-task';
  workspace: string;
  projectRelative: string;
  baseCommit: string;
  receiptDigest: string;
  contract: MathProblemContract;
  targets: readonly ProofTarget[];
  trustedFiles: Readonly<Record<string, string>>;
  ownedFiles: readonly string[];
  activeProblemPath: string;
  sourceRepository?: string;
  declarations: Readonly<Record<string, readonly OriginalDeclaration[]>>;
  sourceStructure: Readonly<Record<string, string>>;
  /** Original context text bound by sourceStructure; permits inert comments without changing legacy identities. */
  sourceContexts?: Readonly<Record<string, string>>;
  sourceImports?: Readonly<Record<string, readonly string[]>>;
  /** Owned library-pack modules whose bytes are frozen (file → digest); proofs import them and never edit them. */
  frozenFiles?: Readonly<Record<string, string>>;
  libraryBinding?: EffectiveLibraryBinding;
  libraryHostTask?: LibraryHostTaskIdentity;
}>;

export function git(root: string, args: string[]): string {
  return mathGitText(root, args, { timeout: 30_000, maxBuffer: 1024 * 1024, errorMessage: `math_git_failed:${args[0]}` });
}

/** Journals guide research but never become inputs to a projected proof. */
export function commitSolverProjection(problem: SolverProblem, worktree: string, message: string): string {
  git(worktree, ['rm', '--quiet', '--force', '--ignore-unmatch', '--', 'RESEARCH.md']);
  git(worktree, ['add', '--', ...problem.ownedFiles.map(file => path.join(problem.projectRelative, file))]);
  git(worktree, ['-c', 'user.name=DeepScientist Math', '-c', 'user.email=math@localhost', 'commit',
    '--allow-empty', '--no-gpg-sign', '--quiet', '-m', message]);
  return git(worktree, ['rev-parse', 'HEAD']);
}

export type SolverSourceConstraints = Pick<SolverProblem, 'trustedFiles' | 'declarations' | 'sourceStructure' | 'sourceContexts' | 'sourceImports' | 'frozenFiles'>;

/** The fields every host writer copies into .lake/source-constraints.json for check-lean. */
export const solverSourceConstraints = (problem: SolverSourceConstraints, declarations = problem.declarations): SolverSourceConstraints => ({
  trustedFiles: problem.trustedFiles, declarations, sourceStructure: problem.sourceStructure, sourceImports: problem.sourceImports,
  ...(problem.sourceContexts ? { sourceContexts: problem.sourceContexts } : {}),
  ...(problem.frozenFiles ? { frozenFiles: problem.frozenFiles } : {}) });

/** Reuse public frozen modules already exposed to the original solver sources, and owned modules
 *  (certificate slots, helpers); assertSolverProjectSources rejects any resulting import cycle. */
export function solverProofImports(problem: SolverSourceConstraints, source: string): string[] {
  const local = new Set(Object.values(problem.sourceImports ?? {}).flat().filter(module => {
    const file = module.replaceAll('.', '/') + '.lean';
    return isAllowedMathProofSource(file) && Object.hasOwn(problem.trustedFiles, file);
  }));
  for (const file of Object.keys(problem.declarations))
    if (isAllowedMathProofSource(file) && /^[A-Z][A-Za-z0-9_]*(?:\/[A-Z][A-Za-z0-9_]*)*\.lean$/u.test(file))
      local.add(file.slice(0, -'.lean'.length).replaceAll('/', '.'));
  return mathConstructionImports(source).filter(module => local.has(module) || isSolverMathlibImport(module));
}

/** Ignore comments and spacing outside literals; strings and every effective context command remain bound. */
function contextWithoutComments(context: string): string {
  return maskLeanComments(context).split('\n').map(line => line.trim()
    .replace(/"(?:\\.|[^"\\])*"|[ \t]+/gu, token => token.startsWith('"') ? token : ' '))
    .filter(Boolean).join('\n');
}

function sourceDeclarationHashMatches(source: string, name: string, expected: string): boolean {
  if (hashMathFormalSourceDeclaration(source, name) === expected) return true;
  return inspectLegacyLeanWhereSource(source).declarations.some(item =>
    (item.name === name || item.name.split('.').at(-1) === name.split('.').at(-1)) &&
    mathDigest(item.declarationType) === expected);
}

export function readSolverProblem(workspacePath: string, receiptFile: string): SolverProblem {
  const workspace = fs.realpathSync(workspacePath);
  assertMathCanonicalPath(workspace);
  const raw = readMathJson(receiptFile) as { schema?: string; receipt?: unknown };
  const value = raw.schema === 'deepscientist.mathematics.lean-eval-held-out-bootstrap.v1' ? raw.receipt : raw;
  const receipt = (value as { schema?: string }).schema === 'theorem-os.local-example.v1'
    ? readLocalExampleReceipt(receiptFile)
    : (value as { schema?: string }).schema === 'theorem-os.lean-task.v1'
    ? readLeanTaskReceipt(receiptFile)
    : (value as { schema?: string }).schema === 'deepscientist.mathematics.imo2026-bootstrap-receipt.v1'
    ? readImo2026BootstrapReceipt(receiptFile)
    : readLeanEvalBootstrapReceipt((value as { activeProblemPath: string }).activeProblemPath);
  if (receipt.schema === 'deepscientist.mathematics.imo2026-bootstrap-receipt.v1') verifyImo2026BootstrapReceipt(receipt);
  if (fs.realpathSync(receipt.workspaceRoot) !== workspace) throw new Error('math_problem_workspace_mismatch');
  assertMathCanonicalPath(receipt.projectRoot);
  if (!isMathPathWithin(workspace, receipt.projectRoot) || workspace === receipt.projectRoot)
    throw new Error('math_problem_project_outside_workspace');
  const projectRelative = path.relative(workspace, receipt.projectRoot);
  const trustedFiles = Object.fromEntries(receipt.trustedFiles.map(relative => {
    const target = path.resolve(receipt.projectRoot, relative);
    assertMathCanonicalPath(target);
    if (!isMathPathWithin(receipt.projectRoot, target) || !fs.statSync(target).isFile()) throw new Error('math_problem_trusted_path');
    return [relative, mathDigest(fs.readFileSync(target))];
  }));
  const publicObligations = 'publicObligations' in receipt ? receipt.publicObligations : undefined;
  // readLeanTaskReceipt already verified the stored index against the seed. Equal
  // headers are common across versions and must select today's body boundaries.
  const legacyWhere = receipt.schema === 'theorem-os.lean-task.v1' &&
    canonicalMathJson(receipt.declarations) !== canonicalMathJson(inspectScopedLeanDeclarations(receipt.contract.formalStatement)
      .map(item => ({ name: item.qualifiedName, kind: item.kind, declarationHash: mathDigest(item.declarationType) })));
  const sourceRegions = (source: string) => legacyWhere ? inspectLegacyLeanWhereSource(source).regions
    : inspectLeanDeclarationRegions(source);
  const names = publicObligations?.map(item => item.name) || theoremQualifiedNamesFromSource(receipt.contract.formalStatement);
  if (!names.length) throw new Error('math_problem_targets_missing');
  const targets = names.map(theoremName => {
    const declarationHash = publicObligations?.find(item => item.name === theoremName)?.declarationHash ||
      hashMathFormalSourceDeclaration(receipt.contract.formalStatement, theoremName);
    if (!declarationHash) throw new Error('math_problem_declaration_missing');
    const files = receipt.solverOwnedFiles.filter(relative => relative.endsWith('.lean') &&
      sourceDeclarationHashMatches(fs.readFileSync(path.join(receipt.projectRoot, relative), 'utf8'), theoremName, declarationHash));
    if (files.length !== 1) throw new Error('math_problem_target_file_ambiguous');
    const candidateName = publicObligations && receipt.schema !== 'theorem-os.local-example.v1' && receipt.schema !== 'theorem-os.lean-task.v1' ? resolveLeanEvalSubmissionName(theoremName,
      fs.readFileSync(path.join(receipt.projectRoot, files[0]!), 'utf8')) : theoremName;
    return { theoremName: candidateName, declarationHash, proofPath: files[0]! };
  });
  const targetNames = new Set(targets.map(target => target.theoremName.split('.').at(-1)));
  const originalSource = (file: string) => receipt.schema === 'theorem-os.lean-task.v1'
    ? committedSource(workspace, receipt.baseCommit, path.join(projectRelative, file))
    : fs.readFileSync(path.join(receipt.projectRoot, file), 'utf8');
  // Library-pack modules keep the exact bytes the bootstrap recorded.
  const libraryPack = 'libraryPack' in receipt ? receipt.libraryPack : undefined;
  const declarations = Object.fromEntries(receipt.solverOwnedFiles.filter(file => file.endsWith('.lean')).map(file => {
    const source = originalSource(file), regions = sourceRegions(source);
    const kinds = new Map((legacyWhere ? inspectLegacyLeanWhereSource(source).declarations : inspectLeanDeclarations(source))
      .map(item => [item.startOffset, item.kind]));
    // Frozen library modules are compared as whole files, never by declaration.
    const written = new Map<string, number>();
    if (!libraryPack || !Object.hasOwn(libraryPack.files, file))
      for (const item of regions) written.set(item.name, (written.get(item.name) ?? 0) + 1);
    const repeated = (name: string) => (written.get(name) ?? 0) > 1;
    const qualified = regions.some(item => repeated(item.name)) ?
      new Map(inspectScopedLeanDeclarations(source).map(item => [item.startOffset, item.qualifiedName])) : undefined;
    return [file, regions.map((item): OriginalDeclaration => ({ name: item.name,
      ...(repeated(item.name) ? { qualifiedName: qualified!.get(item.startOffset)! } : {}), header: item.declarationType,
      ...(kinds.get(item.startOffset) !== 'theorem' && !targetNames.has(item.name.split('.').at(-1))
        ? { body: mathDigest(source.slice(item.bodyOffset, item.endOffset).trim()) } : {}) }))];
  }));
  const contexts = Object.fromEntries(Object.entries(declarations).map(([file, originals]) => {
    const source = originalSource(file);
    return [file, sourceContext(source, originals, undefined, undefined, sourceRegions(source))];
  }));
  const structures = Object.fromEntries(Object.entries(contexts).map(([file, context]) => [file, mathDigest(context)]));
  const sourceImports = Object.fromEntries(Object.keys(declarations).map(file =>
    [file, mathConstructionImports(originalSource(file))]));
  const frozenFiles = libraryPack && Object.fromEntries(Object.entries(libraryPack.files).map(([file, digest]) => {
    const target = path.join(receipt.projectRoot, file);
    assertMathCanonicalPath(target);
    if (!receipt.solverOwnedFiles.includes(file) || mathDigest(fs.readFileSync(target)) !== digest) throw new Error('math_library_pack_changed');
    return [file, digest];
  }));
  const problem: SolverProblem = { kind: receipt.schema === 'theorem-os.local-example.v1' ? 'example' : receipt.schema === 'theorem-os.lean-task.v1'
    ? 'lean-task' : receipt.schema.includes('imo2026') ? 'imo2026' : 'lean-eval', workspace, projectRelative,
    baseCommit: receipt.schema === 'theorem-os.lean-task.v1' ? receipt.baseCommit : git(workspace, ['rev-parse', 'HEAD']),
    receiptDigest: mathDigest(canonicalMathJson(receipt)),
    contract: receipt.contract, targets, trustedFiles, ownedFiles: receipt.solverOwnedFiles,
    declarations, sourceStructure: structures, sourceContexts: contexts, sourceImports, activeProblemPath: receipt.activeProblemPath,
    ...(frozenFiles ? { frozenFiles } : {}),
    ...('libraryBinding' in receipt && receipt.libraryBinding ? { libraryBinding: receipt.libraryBinding,
      libraryHostTask: { taskId: receipt.libraryBinding.taskId,
        ...('benchmarkCommit' in receipt ? { benchmarkCommit: receipt.benchmarkCommit } : {}) } } : {}),
    ...('sourceProjectRoot' in receipt ? { sourceRepository: receipt.sourceProjectRoot } : {}) };
  if (receipt.schema === 'theorem-os.lean-task.v1') assertSolverProjectSources(problem, receipt.projectRoot);
  return problem;
}

/** Shared source preflight; diagnostic copies remain advisory, host checks use the frozen state. */
export function assertSolverProjectSources(problem: SolverSourceConstraints, project: string): void {
  let addedImportFile: string | undefined;
  for (const [relative, digest] of Object.entries(problem.trustedFiles)) {
    const target = path.join(project, relative);
    assertMathCanonicalPath(target);
    if (mathDigest(fs.readFileSync(target)) !== digest) throw new Error('math_trusted_source_changed');
  }
  const frozen = problem.frozenFiles ?? {}, frozenSources: Record<string, string> = {}, ownedSources: Record<string, string> = {};
  for (const [relative, digest] of Object.entries(frozen)) {
    const file = path.join(project, relative);
    assertMathCanonicalPath(file);
    const bytes = fs.existsSync(file) && fs.lstatSync(file).isFile() ? fs.readFileSync(file) : undefined;
    if (!bytes || mathDigest(bytes) !== digest) throw new SolverSourceError(relative, 'math_library_module_changed');
    frozenSources[relative] = bytes.toString('utf8');
  }
  for (const [relative, originals] of Object.entries(problem.declarations)) {
    if (Object.hasOwn(frozen, relative)) continue;
    const file = path.join(project, relative);
    assertMathCanonicalPath(file);
    const source = fs.readFileSync(file, 'utf8');
    ownedSources[relative] = source;
    const allowedImports = solverProofImports(problem, source);
    if (allowedImports.some(module => !problem.sourceImports?.[relative]?.includes(module)))
      addedImportFile = relative;
    const changedDeclaration = (regions: ReturnType<typeof inspectLeanDeclarationRegions>) => {
      const matching = originalDeclarationRegions(source, regions);
      return originals.find(original => {
        const matches = matching(original), current = matches[0];
        return matches.length !== 1 || current.declarationType !== original.header ||
          Boolean(original.body && mathDigest(source.slice(current.bodyOffset, current.endOffset).trim()) !== original.body);
      });
    };
    const contextMatches = (regions: ReturnType<typeof inspectLeanDeclarationRegions>) => {
      const currentContext = sourceContext(source, originals, problem.sourceImports?.[relative], allowedImports, regions);
      if (mathDigest(currentContext) === problem.sourceStructure[relative]) return true;
      const originalContext = problem.sourceContexts?.[relative];
      // Old checkpoints keep their exact digest. Only a preimage of that frozen digest can authorize
      // comment-insensitive comparison; an arbitrary replacement context cannot weaken the guard.
      return originalContext !== undefined && mathDigest(originalContext) === problem.sourceStructure[relative] &&
        contextWithoutComments(currentContext) === contextWithoutComments(originalContext);
    };
    const regions = inspectLeanDeclarationRegions(source), changed = changedDeclaration(regions);
    if (changed || !contextMatches(regions)) {
      // An existing checkpoint can bind pre-fix where boundaries. Its complete
      // declarations, bodies and frozen context must all agree with that view.
      const legacyRegions = inspectLegacyLeanWhereSource(source).regions;
      const legacyChanged = changedDeclaration(legacyRegions);
      if (!legacyChanged && contextMatches(legacyRegions)) continue;
      if (changed && legacyChanged)
        throw new SolverSourceError(relative, 'math_original_declaration_changed', changed.qualifiedName ?? changed.name);
      throw new SolverSourceError(relative, 'math_original_context_changed');
    }
  }
  const conflict = Object.keys(frozenSources).length ? libraryDeclarationConflict(frozenSources, ownedSources) : undefined;
  if (conflict) throw new SolverSourceError(conflict.file, 'math_library_declaration_redeclared', conflict.name);
  if (addedImportFile) {
    // Only project-local modules enter this graph, including any local module named like a package import.
    try { mathLocalModuleBuildOrder(project, Object.keys(problem.declarations)); }
    catch (error) {
      if (error instanceof Error && error.message === 'math_local_module_import_cycle')
        throw new SolverSourceError(addedImportFile, 'math_local_module_import_cycle');
      throw error;
    }
  }
}

/** Scratch remains advisory in the worker, never in a proof checkpoint. Only untracked
 *  regular files at explicit scratch roots qualify; staged/tracked paths still fail ownership. */
const solverScratch = (problem: SolverProblem, relative: string) => {
  if (/(^|\/)Probe[^/]*\.lean$/u.test(relative)) return true;
  const roots = ['', problem.projectRelative === '.' ? '' : `${problem.projectRelative}/`];
  return roots.some(root => {
    if (!relative.startsWith(root)) return false;
    const top = relative.slice(root.length).split('/')[0]!;
    return top === '.scratch' || top === 'scratch' || top === '.probe' || /^scratch_/u.test(top);
  });
};
function isUntrackedSolverScratch(problem: SolverProblem, worktree: string, relative: string,
  untracked: ReadonlySet<string>): boolean {
  // This exact host skill projection is never committed as proof source. Its full identity
  // is checked independently before dispatch and after writer shutdown in skill mode.
  const skill = researchSkills.get(problem)?.get(worktree);
  const projectedSkill = Boolean(skill && relative.startsWith('.agents/skills/theoremos-research/'));
  if (!untracked.has(relative) || !solverScratch(problem, relative) && !projectedSkill) return false;
  const file = path.join(worktree, relative);
  try {
    if (projectedSkill) assertMathAgentSkillsCurrent([skill!]);
    assertMathCanonicalPath(file);
    return fs.lstatSync(file).isFile();
  } catch { return false; }
}
const solverGitPaths = (worktree: string, args: string[]): string[] => mathGitBytes(worktree, args,
  { timeout: 30_000, maxBuffer: 1024 * 1024, errorMessage: `math_git_failed:${args[0]}` }).toString('utf8').split('\0').filter(Boolean);

/**
 * Advisory progress inside the worker's own scratch roots: numerical probes, search scripts and
 * command output live there while a research assignment is still being explored, so a scheduling
 * clock that only reads committed notes reports no progress for genuine work. Reading scratch can
 * never accept anything; this digest is scheduling evidence only and is bounded so a large probe
 * output cannot turn the checkpoint into a bulk read.
 */
export function solverScratchDigest(problem: SolverProblem, worktree: string): string | undefined {
  try {
    const untracked = new Set(solverGitPaths(worktree, ['ls-files', '--others', '--exclude-standard', '-z']));
    const scratch = [...untracked].filter(relative => solverScratch(problem, relative)).sort().slice(0, 256);
    if (!scratch.length) return undefined;
    let budget = 4 * 1024 * 1024;
    const entries: [string, string][] = [];
    for (const relative of scratch) {
      const file = path.join(worktree, relative);
      try {
        assertMathCanonicalPath(file);
        const stat = fs.lstatSync(file);
        if (!stat.isFile()) { entries.push([relative, 'non-file']); continue; }
        if (stat.size > budget) { entries.push([relative, `large:${stat.size}`]); continue; }
        budget -= stat.size;
        entries.push([relative, mathDigest(fs.readFileSync(file))]);
      } catch { continue; }
    }
    return entries.length ? mathDigest(canonicalMathJson(entries)) : undefined;
  } catch { return undefined; }
}

/** Changed paths outside the owned sources, journals and advisory scratch roots. */
export function solverPathsOutsideOwnership(problem: SolverProblem, worktree: string) {
  const untracked = new Set(solverGitPaths(worktree, ['ls-files', '--others', '--exclude-standard', '-z']));
  // Include the index separately: an added file deleted from disk must not enter the checkpoint.
  const changed = new Set([...solverGitPaths(worktree, ['diff', '--name-only', '-z', problem.baseCommit]),
    ...solverGitPaths(worktree, ['diff', '--cached', '--name-only', '-z', problem.baseCommit]), ...untracked]);
  const allowed = new Set([...problem.ownedFiles.map(relative => path.join(problem.projectRelative, relative)),
    'RESEARCH.md', 'DELIVERIES.jsonl', 'COOPERATION.json', 'CONTEXT-MANIFEST.json', DECLARATION_INDEX_FILE,
    'LIBRARY.json', 'LIBRARY_REQUEST.json']);
  // A worker's own redirect of a Lean or script diagnostic is not proof content and is not committed.
  const diagnosticLog = (relative: string) => !relative.includes('/') && /\.log$/u.test(relative);
  const outside = [...changed].filter(relative => !allowed.has(relative) && !/^DELIVERIES-[a-f0-9]{64}\.jsonl$/u.test(relative) &&
    !isUntrackedSolverScratch(problem, worktree, relative, untracked) &&
    !(diagnosticLog(relative) && !git(worktree, ['ls-files', '--', relative])));
  return { outside, untracked };
}

/**
 * A stray untracked regular file is never committed or projected into a check, so it should not stop
 * the worker. Move it under the repository scratch root instead; staged, tracked, linked and
 * non-regular paths are left for assertSolverSources to reject. Call only while no writer is active.
 */
export function quarantineSolverStrayFiles(problem: SolverProblem, worktree: string, at = Date.now()): string[] {
  const { outside, untracked } = solverPathsOutsideOwnership(problem, worktree);
  const moved: string[] = [];
  const root = path.join(worktree, '.scratch', 'quarantine', String(at));
  for (const relative of outside) {
    if (!untracked.has(relative)) continue;
    const file = path.join(worktree, relative), target = path.join(root, relative);
    try {
      assertMathCanonicalPath(file);
      if (!fs.lstatSync(file).isFile()) continue;
      // Check before creating directories so a linked scratch root cannot redirect them outside the worktree.
      assertMathCanonicalPath(target);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      assertMathCanonicalPath(target);
      if (fs.existsSync(target)) continue;
      fs.renameSync(file, target); moved.push(relative);
    } catch { /* Leave it in place; the ownership check reports it. */ }
  }
  return moved;
}

export function assertSolverSources(problem: SolverProblem, worktree: string): void {
  const project = path.join(worktree, problem.projectRelative);
  assertSolverProjectSources(problem, project);
  git(worktree, ['merge-base', '--is-ancestor', problem.baseCommit, 'HEAD']);
  if (solverPathsOutsideOwnership(problem, worktree).outside.length) throw new Error('math_source_outside_ownership');
  for (const target of problem.targets) {
    const file = path.join(project, target.proofPath);
    if (!sourceDeclarationHashMatches(fs.readFileSync(file, 'utf8'), target.theoremName, target.declarationHash))
      throw new SolverSourceError(target.proofPath, 'math_original_declaration_changed');
  }
}

export function commitSolverSources(problem: SolverProblem, worktree: string): string {
  assertSolverSources(problem, worktree);
  // Host journals change independently of frozen proof commits. Ignore only their allowed root paths.
  const exclude = path.resolve(worktree, git(worktree, ['rev-parse', '--git-path', 'info/exclude']));
  const existing = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8').split('\n') : [];
  const missing = ['/COOPERATION.json', '/CONTEXT-MANIFEST.json', `/${DECLARATION_INDEX_FILE}`, '/DELIVERIES.jsonl',
    '/LIBRARY.json', '/LIBRARY_REQUEST.json',
    `/DELIVERIES-${'[a-f0-9]'.repeat(64)}.jsonl`]
    .filter(rule => !existing.includes(rule));
  if (missing.length) {
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, `\n${missing.join('\n')}\n`);
  }
  const files = problem.ownedFiles.map(relative => path.join(problem.projectRelative, relative));
  // Restoring a draft may remove tracked notes; commit that absence as well as additions and edits.
  if (fs.existsSync(path.join(worktree, 'RESEARCH.md')) || git(worktree, ['ls-files', '--', 'RESEARCH.md'])) files.push('RESEARCH.md');
  git(worktree, ['add', '--', ...files]);
  if (git(worktree, ['diff', '--cached', '--name-only']))
    git(worktree, ['-c', 'user.name=DeepScientist Math', '-c', 'user.email=math@localhost', 'commit', '--no-gpg-sign', '--quiet', '-m', 'Checkpoint mathematical proof']);
  return git(worktree, ['rev-parse', 'HEAD']);
}

/** Use a disposable checkout of a fixed commit and release it on every exit path. */
export async function withSolverWorktree<T>(worktree: string, commit: string, run: (checkout: string) => Promise<T>): Promise<T> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'math-check-'));
  const checkout = path.join(directory, 'worktree');
  let added = false;
  try {
    git(worktree, ['worktree', 'add', '--quiet', '--detach', checkout, commit]); added = true;
    return await run(checkout);
  } finally {
    try { if (added) git(worktree, ['worktree', 'remove', '--force', checkout]); }
    finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
}
