import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mathGitBytes, mathGitText } from '../math/mathGit';
import { readImo2026BootstrapReceipt, verifyImo2026BootstrapReceipt, theoremQualifiedNamesFromSource } from '../math/imo2026Adapter';
import { readLeanEvalBootstrapReceipt } from '../math/leanEvalBootstrap';
import { resolveLeanEvalSubmissionName } from '../math/leanEvalSubmission';
import { canonicalMathJson, mathDigest, readMathJson } from '../math/mathRuntimeIo';
import { assertMathCanonicalPath, isMathPathWithin } from '../math/paths';
import { hashMathFormalSourceDeclaration, inspectLeanDeclarationRegions, inspectLeanDeclarations, inspectScopedLeanDeclarations } from '../math/leanSource';
import { mathConstructionImports, mathLocalModuleBuildOrder } from '../math/mathConstructionSources';
import { isAllowedMathProofSource } from '../math/mathProofSourcePolicy';
import type { MathProblemContract } from '../math/contracts';
import { readLocalExampleReceipt } from '../math/localExample';
import { readLeanTaskReceipt } from '../math/leanTask';
import { DECLARATION_INDEX_FILE } from './declarationIndex';
import { libraryDeclarationConflict } from '../math/libraryPacks';
import { maskLeanComments } from '../math/leanSyntax';

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
        'Keep new helpers; move helper-specific scopes and instances inside their proofs. Added imports may use explicit Mathlib.* modules, frozen local modules already imported by the original owned sources, or other owned modules; avoid import cycles.'
      : `Restore the original name, parameters, type and any frozen proof or definition body${this.declarationName ? ` of ${this.declarationName}` : ''} from the seed commit. Preserve new proof work.`;
  }
}
/** `qualifiedName` is set only when the statement repeats the written name in another namespace. */
export type OriginalDeclaration = Readonly<{ name: string; qualifiedName?: string; header: string; body?: string }>;

/** Regions of `source` holding an original: the same written name and, for a repeated one, the same qualified name. */
export function originalDeclarationRegions(source: string, regions = inspectLeanDeclarationRegions(source)) {
  let qualified: Map<number, string> | undefined;
  const qualifiedName = (offset: number) => (qualified ??= new Map(inspectScopedLeanDeclarations(source)
    .map(item => [item.startOffset, item.qualifiedName]))).get(offset);
  return (original: Pick<OriginalDeclaration, 'name' | 'qualifiedName'>) => regions.filter(region => region.name === original.name &&
    (original.qualifiedName === undefined || qualifiedName(region.startOffset) === original.qualifiedName));
}

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

/** Only explicit modules from the pinned Mathlib package may extend proof imports. */
export function solverMathlibImports(source: string): string[] {
  return mathConstructionImports(source).filter(module => /^Mathlib(?:\.[A-Za-z_][A-Za-z0-9_']*)+$/u.test(module));
}

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
  return mathConstructionImports(source).filter(module => local.has(module) ||
    /^Mathlib(?:\.[A-Za-z_][A-Za-z0-9_']*)+$/u.test(module));
}

/** Read-only instance queries allow simple names or balanced parenthesized types. */
function isInstanceQuery(line: string): boolean {
  const query = /^#synth[ \t]+[\p{L}_][\p{L}\p{M}\p{N}_'.]*(.*)$/u.exec(line);
  if (!query || /["`#;]/u.test(query[1])) return false;
  let depth = 0;
  let bare = '';
  const validBare = () => !bare || /^[\p{L}_][\p{L}\p{M}\p{N}_'.]*$|^[0-9]+$/u.test(bare) &&
    !/^(?:import|public|private|meta|namespace|section|end|theorem|lemma|def|example|abbrev|opaque|instance|inductive|structure|class|axiom|constant|variable|universe|open|export|set_option|attribute|noncomputable|unsafe|syntax|macro|elab|notation|infix|infixl|infixr|prefix|postfix|initialize|builtin_initialize)$/u.test(bare);
  for (const character of query[1]) {
    if (character === '(') { if (!depth && !validBare()) return false; bare = ''; depth++; }
    else if (character === ')') { if (--depth < 0) return false; }
    else if (!depth) {
      if (character === ' ' || character === '\t') { if (!validBare()) return false; bare = ''; }
      else bare += character;
    }
  }
  return depth === 0 && validBare();
}

function sourceContext(source: string, originals: readonly Pick<OriginalDeclaration, 'name' | 'qualifiedName'>[],
  originalImports?: readonly string[], allowedImports = solverMathlibImports(source)): string {
  const addedImports = new Set(originalImports === undefined ? [] :
    allowedImports.filter(module => !originalImports.includes(module)));
  const regions = inspectLeanDeclarationRegions(source), matching = originalDeclarationRegions(source, regions);
  const original = new Set(originals.flatMap(item => matching(item)).map(region => region.startOffset));
  let frozen = '';
  let cursor = 0;
  for (const region of regions) {
    const context = source.slice(cursor, region.startOffset);
    frozen += original.has(region.startOffset) ? context : context.replace(/\bnoncomputable[ \t]+$/u, '');
    if (original.has(region.startOffset)) frozen += `${region.declarationType}\n`;
    cursor = region.endOffset;
  }
  frozen += source.slice(cursor);
  // Read-only name and instance queries leave the original proof context intact.
  return frozen.split('\n').map(line => line.trim()).filter(line => line &&
    !addedImports.has(/^import[ \t]+([^ \t]+)$/u.exec(line)?.[1] ?? '') &&
    !/^#check[ \t]+[\p{L}_][\p{L}\p{M}\p{N}_'.]*$/u.test(line) && !isInstanceQuery(line)).join('\n');
}

/** Ignore comments and spacing outside literals; strings and every effective context command remain bound. */
function contextWithoutComments(context: string): string {
  return maskLeanComments(context).split('\n').map(line => line.trim()
    .replace(/"(?:\\.|[^"\\])*"|[ \t]+/gu, token => token.startsWith('"') ? token : ' '))
    .filter(Boolean).join('\n');
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
  const names = publicObligations?.map(item => item.name) || theoremQualifiedNamesFromSource(receipt.contract.formalStatement);
  if (!names.length) throw new Error('math_problem_targets_missing');
  const targets = names.map(theoremName => {
    const declarationHash = publicObligations?.find(item => item.name === theoremName)?.declarationHash ||
      hashMathFormalSourceDeclaration(receipt.contract.formalStatement, theoremName);
    if (!declarationHash) throw new Error('math_problem_declaration_missing');
    const files = receipt.solverOwnedFiles.filter(relative => relative.endsWith('.lean') &&
      hashMathFormalSourceDeclaration(fs.readFileSync(path.join(receipt.projectRoot, relative), 'utf8'), theoremName) === declarationHash);
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
    const source = originalSource(file), regions = inspectLeanDeclarationRegions(source);
    const kinds = new Map(inspectLeanDeclarations(source).map(item => [item.startOffset, item.kind]));
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
  const contexts = Object.fromEntries(Object.entries(declarations).map(([file, originals]) =>
    [file, sourceContext(originalSource(file), originals)]));
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
    ...('sourceProjectRoot' in receipt ? { sourceRepository: receipt.sourceProjectRoot } : {}) };
  if (receipt.schema === 'theorem-os.lean-task.v1') assertSolverProjectSources(problem, receipt.projectRoot);
  return problem;
}

/** Shared source preflight; diagnostic copies remain advisory, host checks use the frozen state. */
export function assertSolverProjectSources(problem: SolverSourceConstraints, project: string): void {
  let addedLocalImportFile: string | undefined;
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
    const matching = originalDeclarationRegions(source);
    for (const original of originals) {
      const matches = matching(original);
      const current = matches[0];
      if (matches.length !== 1 || current.declarationType !== original.header ||
          (original.body && mathDigest(source.slice(current.bodyOffset, current.endOffset).trim()) !== original.body))
        throw new SolverSourceError(relative, 'math_original_declaration_changed', original.qualifiedName ?? original.name);
    }
    const allowedImports = solverProofImports(problem, source);
    if (allowedImports.some(module => !module.startsWith('Mathlib.') && !problem.sourceImports?.[relative]?.includes(module)))
      addedLocalImportFile = relative;
    const currentContext = sourceContext(source, originals, problem.sourceImports?.[relative], allowedImports);
    if (mathDigest(currentContext) !== problem.sourceStructure[relative]) {
      const originalContext = problem.sourceContexts?.[relative];
      // Old checkpoints keep their exact digest. Only a preimage of that frozen digest can authorize
      // comment-insensitive comparison; an arbitrary replacement context cannot weaken the guard.
      if (originalContext === undefined || mathDigest(originalContext) !== problem.sourceStructure[relative] ||
          contextWithoutComments(currentContext) !== contextWithoutComments(originalContext))
        throw new SolverSourceError(relative, 'math_original_context_changed');
    }
  }
  const conflict = Object.keys(frozenSources).length ? libraryDeclarationConflict(frozenSources, ownedSources) : undefined;
  if (conflict) throw new SolverSourceError(conflict.file, 'math_library_declaration_redeclared', conflict.name);
  if (addedLocalImportFile) {
    try { mathLocalModuleBuildOrder(project, Object.keys(problem.declarations)); }
    catch (error) {
      if (error instanceof Error && error.message === 'math_local_module_import_cycle')
        throw new SolverSourceError(addedLocalImportFile, 'math_local_module_import_cycle');
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
  if (!untracked.has(relative) || !solverScratch(problem, relative)) return false;
  const file = path.join(worktree, relative);
  try {
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
function solverPathsOutsideOwnership(problem: SolverProblem, worktree: string) {
  const untracked = new Set(solverGitPaths(worktree, ['ls-files', '--others', '--exclude-standard', '-z']));
  // Include the index separately: an added file deleted from disk must not enter the checkpoint.
  const changed = new Set([...solverGitPaths(worktree, ['diff', '--name-only', '-z', problem.baseCommit]),
    ...solverGitPaths(worktree, ['diff', '--cached', '--name-only', '-z', problem.baseCommit]), ...untracked]);
  const allowed = new Set([...problem.ownedFiles.map(relative => path.join(problem.projectRelative, relative)),
    'RESEARCH.md', 'DELIVERIES.jsonl', 'COOPERATION.json', 'CONTEXT-MANIFEST.json', DECLARATION_INDEX_FILE]);
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
    if (hashMathFormalSourceDeclaration(fs.readFileSync(file, 'utf8'), target.theoremName) !== target.declarationHash)
      throw new SolverSourceError(target.proofPath, 'math_original_declaration_changed');
  }
}

export function commitSolverSources(problem: SolverProblem, worktree: string): string {
  assertSolverSources(problem, worktree);
  // Host journals change independently of frozen proof commits. Ignore only their allowed root paths.
  const exclude = path.resolve(worktree, git(worktree, ['rev-parse', '--git-path', 'info/exclude']));
  const existing = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8').split('\n') : [];
  const missing = ['/COOPERATION.json', '/CONTEXT-MANIFEST.json', `/${DECLARATION_INDEX_FILE}`, '/DELIVERIES.jsonl',
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
