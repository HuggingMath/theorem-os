import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { inspectLeanDeclarationRegions, inspectScopedLeanDeclarations } from './leanSource';
import { maskLeanCommentsAndStrings } from './leanSyntax';
import { localModuleFile, mathConstructionImports, mathConstructionImportSpans, mathLocalModuleGraph } from './mathConstructionSources';
import { mathGitBytes, mathGitText } from './mathGit';
import { isAllowedMathProofSource } from './mathProofSourcePolicy';
import { canonicalMathJson, mathDigest, readMathText } from './mathRuntimeIo';
import { assertMathCanonicalPath, repositoryRelativePath } from './paths';

/**
 * A library pack is a set of Lean modules that a bootstrap installs as solver-owned files under
 * Submission/Library. The host freezes their bytes and rechecks them in the destination environment
 * before solving; proofs import them and never edit them. Kernel acceptance of the final target stays
 * the authority: the lexical gate here only rejects trust escapes early.
 */
export const LIBRARY_PACK_SCHEMA = 'theorem-os.library-pack.v1';
export const LIBRARY_PACK_DIRECTORY = 'Submission/Library';
export const MAX_LIBRARY_PACK_MODULES = 256;
export const MAX_LIBRARY_MODULE_BYTES = 4 * 1024 * 1024;
export const MAX_LIBRARY_PACK_BYTES = 16 * 1024 * 1024;

const MODULE_FILE = /^Submission\/Library(?:\/[A-Z][A-Za-z0-9_]*)+\.lean$/u;
export const isLibraryPackFile = (file: string): boolean => MODULE_FILE.test(file) && isAllowedMathProofSource(file);
const moduleName = (file: string) => file.slice(0, -'.lean'.length).replaceAll('/', '.');
const plainName = (name: string) => name.replaceAll('«', '').replaceAll('»', '');

/** Proof-trust escapes after masking comments and strings; the final axiom check still decides acceptance. */
const FORBIDDEN = /(?<![\p{L}\p{M}\p{N}_'])(sorry|sorryAx|admit|native_decide|axiom|unsafe|implemented_by|extern|trustCompiler|ofReduceBool|ofReduceNat|skipKernelTC|addDecl|addAndCompile|run_cmd|run_elab|run_meta|run_tac)(?![\p{L}\p{M}\p{N}_'])|#eval\b/u;
/** The first trust escape in source whose comments and strings are already masked. */
export const libraryForbiddenToken = (masked: string): { index: number; token: string } | undefined => {
  const match = FORBIDDEN.exec(masked);
  return match ? { index: match.index, token: match[0] } : undefined;
};

const hash = z.string().regex(/^[a-f0-9]{64}$/u), oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const relative = z.string().min(1).max(512).refine(value => repositoryRelativePath(value) === value);
const dropped = z.object({ name: z.string().min(1).max(512), reason: z.enum(['original', 'unproved', 'dependent']) }).strict();
const origin = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('run'), runId: z.string().min(1).max(128), commit: oid, file: relative,
    receiptDigest: hash.optional(), environmentDigest: hash.optional(), dropped: z.array(dropped).max(4096).optional() }).strict(),
  z.object({ kind: z.literal('upstream'), repository: z.string().min(1).max(512), commit: oid, file: relative }).strict(),
]);
const packSchema = z.object({
  schema: z.literal(LIBRARY_PACK_SCHEMA),
  modules: z.array(z.object({ file: z.string(), source: z.string(), origin }).strict()).min(1).max(MAX_LIBRARY_PACK_MODULES),
  requires: z.array(z.object({ file: relative, digest: hash }).strict()).max(256).optional(),
}).strict();
export type LibraryPack = z.infer<typeof packSchema>;
export type LibraryPackModule = LibraryPack['modules'][number];

/** Structural validation independent of any destination: paths, sizes, UTF-8, trust gate, Submission imports and cycles. */
export function parseLibraryPack(value: unknown): LibraryPack {
  const parsed = packSchema.safeParse(value);
  if (!parsed.success) throw new Error(`math_library_pack_invalid: ${parsed.error.issues.slice(0, 4)
    .map(issue => `${issue.path.join('.') || 'pack'} ${issue.message}`).join('; ')}`);
  const pack = parsed.data, files = new Set<string>();
  let total = 0;
  for (const module of pack.modules) {
    if (!isLibraryPackFile(module.file)) throw new Error(`math_library_pack_path_invalid: ${module.file}`);
    if (files.has(module.file)) throw new Error(`math_library_pack_duplicate_module: ${module.file}`);
    files.add(module.file);
    const bytes = Buffer.byteLength(module.source);
    total += bytes;
    if (bytes > MAX_LIBRARY_MODULE_BYTES || total > MAX_LIBRARY_PACK_BYTES) throw new Error(`math_library_pack_too_large: ${module.file}`);
    if (module.source.includes('\0') || Buffer.from(module.source, 'utf8').toString('utf8') !== module.source)
      throw new Error(`math_library_pack_source_invalid: ${module.file}`);
    const masked = maskLeanCommentsAndStrings(module.source), forbidden = FORBIDDEN.exec(masked);
    if (forbidden) throw new Error(`math_library_pack_forbidden_token: ${module.file}:` +
      `${masked.slice(0, forbidden.index).split('\n').length} ${forbidden[0]}`);
  }
  const required = new Set<string>();
  for (const item of pack.requires ?? []) {
    if (!isAllowedMathProofSource(item.file) || item.file === 'Submission.lean' || item.file.startsWith('Submission/') || required.has(item.file))
      throw new Error(`math_library_pack_requirement_invalid: ${item.file}`);
    required.add(item.file);
  }
  const modules = new Map(pack.modules.map(module => [moduleName(module.file), module.file]));
  const edges = new Map<string, string[]>();
  for (const module of pack.modules) {
    let imports: string[];
    try { imports = mathConstructionImports(module.source).map(plainName); }
    catch { throw new Error(`math_library_pack_header_invalid: ${module.file}`); }
    // Owned Submission modules are mutable proof work; a frozen library may only import other pack modules.
    const owned = imports.find(name => (name === 'Submission' || name.startsWith('Submission.')) && !modules.has(name));
    if (owned) throw new Error(`math_library_pack_import_outside_pack: ${module.file} imports ${owned}`);
    edges.set(module.file, imports.flatMap(name => modules.has(name) ? [modules.get(name)!] : []));
  }
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (file: string) => {
    if (state.get(file) === 'done') return;
    if (state.get(file) === 'visiting') throw new Error(`math_library_pack_import_cycle: ${file}`);
    state.set(file, 'visiting');
    for (const next of edges.get(file) ?? []) visit(next);
    state.set(file, 'done');
  };
  for (const file of files) visit(file);
  return pack;
}

export const libraryPackDigest = (pack: LibraryPack): string => mathDigest(canonicalMathJson(pack));

export function readLibraryPack(file: string): LibraryPack {
  const absolute = path.resolve(file);
  assertMathCanonicalPath(absolute);
  let value: unknown;
  try { value = JSON.parse(readMathText(absolute, 2 * MAX_LIBRARY_PACK_BYTES + 1024 * 1024)); }
  catch (error) { throw new Error(`math_library_pack_unreadable: ${error instanceof Error ? error.message : String(error)}`); }
  return parseLibraryPack(value);
}

/**
 * Install pack modules as new files of a solver project. Every local module in their import closure must be a
 * pack module or a trusted file whose bytes match the pack requirement. Returns the digests of the installed bytes.
 */
export function installLibraryPack(projectRoot: string, pack: LibraryPack,
  ownership: Readonly<{ trustedFiles: readonly string[]; solverOwnedFiles: readonly string[] }>): Record<string, string> {
  const project = fs.realpathSync(projectRoot);
  for (const item of pack.requires ?? []) {
    const file = path.join(project, item.file);
    if (!ownership.trustedFiles.includes(item.file) || !fs.existsSync(file) ||
        mathDigest(fs.readFileSync(file)) !== item.digest) throw new Error(`math_library_pack_requirement_changed: ${item.file}`);
  }
  const installed: Record<string, string> = {};
  for (const module of pack.modules) {
    if (ownership.trustedFiles.includes(module.file) || ownership.solverOwnedFiles.includes(module.file))
      throw new Error(`math_library_pack_collides: ${module.file}`);
    const destination = path.join(project, module.file);
    assertMathCanonicalPath(destination);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    assertMathCanonicalPath(destination);
    fs.writeFileSync(destination, module.source, { mode: 0o600, flag: 'wx' });
    installed[module.file] = mathDigest(module.source);
  }
  const allowed = new Set([...pack.modules.map(module => module.file), ...(pack.requires ?? []).map(item => item.file)]);
  const outside = mathLocalModuleGraph(project, pack.modules.map(module => module.file)).find(module => !allowed.has(module.file));
  if (outside) throw new Error(`math_library_pack_requirement_missing: ${outside.file}`);
  return installed;
}

const localName = (name: string) => name.split('.').at(-1)!;
const PROOF_GAP = /(?<![\p{L}\p{M}\p{N}_'])(?:sorry|admit)(?![\p{L}\p{M}\p{N}_'])/u;
const IDENTIFIER = /[\p{L}_][\p{L}\p{M}\p{N}_'?!]*(?:\.[\p{L}_][\p{L}\p{M}\p{N}_'?!]*)*/gu;

/** Extend a removal back over attribute lines and a doc comment attached to the declaration. */
function attachedStart(source: string, offset: number): number {
  let start = source.lastIndexOf('\n', offset - 1) + 1, cursor = start;
  while (cursor > 0) {
    const lineStart = source.lastIndexOf('\n', cursor - 2) + 1, line = source.slice(lineStart, cursor - 1).trim();
    if (!line) { cursor = lineStart; continue; }
    if (line.startsWith('@[')) start = cursor = lineStart;
    else if (line.endsWith('-/')) {
      const open = source.lastIndexOf('/--', cursor - 1);
      if (open < 0 || source.slice(open, cursor - 1).indexOf('-/') !== source.slice(open, cursor - 1).trimEnd().length - 2) break;
      start = cursor = source.lastIndexOf('\n', open - 1) + 1;
    } else break;
  }
  return start;
}

/**
 * Remove original problem declarations and, optionally, unproved ones, then every declaration whose text
 * mentions a removed name (lexically, by last component). Lean rechecks whatever remains.
 */
function pruneDeclarations(file: string, source: string, originals: ReadonlySet<string>, dropUnproved: boolean,
  removed: Set<string>): { source: string; dropped: { name: string; reason: 'original' | 'unproved' | 'dependent' }[] } {
  const regions = inspectLeanDeclarationRegions(source), masked = maskLeanCommentsAndStrings(source);
  const reasons = new Map<number, 'original' | 'unproved' | 'dependent'>();
  regions.forEach((region, index) => {
    if (originals.has(localName(region.name))) reasons.set(index, 'original');
    else if (PROOF_GAP.test(masked.slice(region.bodyOffset, region.endOffset))) {
      if (!dropUnproved) throw new Error(`math_library_extract_unproved: ${file} ${region.name}; rerun with --drop-unproved`);
      reasons.set(index, 'unproved');
    }
  });
  for (const index of reasons.keys()) removed.add(localName(regions[index]!.name));
  const mentions = regions.map(region => new Set((masked.slice(region.startOffset, region.endOffset).match(IDENTIFIER) ?? [])
    .flatMap(name => name.split('.')).filter(name => name !== localName(region.name))));
  for (let changed = true; changed;) {
    changed = false;
    regions.forEach((region, index) => {
      if (reasons.has(index) || ![...mentions[index]!].some(name => removed.has(name))) return;
      reasons.set(index, 'dependent'); removed.add(localName(region.name)); changed = true;
    });
  }
  let pruned = source;
  for (const index of [...reasons.keys()].sort((a, b) => b - a))
    pruned = pruned.slice(0, attachedStart(pruned, regions[index]!.startOffset)) + pruned.slice(regions[index]!.endOffset);
  return { source: pruned, dropped: [...reasons].sort(([a], [b]) => a - b).map(([index, reason]) => ({ name: regions[index]!.name, reason })) };
}

type RunStateView = { runId?: unknown; worktree?: unknown; environmentDigest?: unknown; cooperation?: { canonicalCommit?: unknown };
  problem?: { projectRelative?: unknown; ownedFiles?: unknown; trustedFiles?: unknown; receiptDigest?: unknown;
    declarations?: unknown; frozenFiles?: unknown } };
const optionalHash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) ? value : undefined;

/**
 * Copy owned modules of a saved run commit (by default its canonical commit, whose helpers the host integrated)
 * into pack modules under Submission/Library/<into>. Original problem declarations are removed so the pack only
 * adds the run's own theory; imports of other selected files are renamed and trusted local imports become
 * digest requirements. `base` supplies an earlier pack whose frozen modules the selected files import.
 */
export function extractRunLibraryModules(input: { stateFile: string; files: readonly string[]; commit?: string; into?: string;
  dropUnproved?: boolean; base?: LibraryPack;
  /** Keep the problem's own declarations: a library spec run, whose targets are the module's theorems. */
  keepOriginals?: boolean;
  /** Pack file per selected file instead of Submission/Library/<into>/…. */
  modulePaths?: Readonly<Record<string, string>> }): LibraryPack {
  const state = JSON.parse(readMathText(path.resolve(input.stateFile), 64 * 1024 * 1024)) as RunStateView;
  const problem = state.problem;
  if (!problem || typeof problem.projectRelative !== 'string' || !Array.isArray(problem.ownedFiles) ||
      !problem.trustedFiles || typeof problem.trustedFiles !== 'object' || typeof state.worktree !== 'string' ||
      typeof state.runId !== 'string' || !problem.declarations || typeof problem.declarations !== 'object')
    throw new Error('math_library_extract_state_invalid');
  const owned = problem.ownedFiles as string[], trusted = problem.trustedFiles as Record<string, string>;
  const originals = problem.declarations as Record<string, readonly { name: string }[]>;
  const frozen = (problem.frozenFiles ?? {}) as Record<string, string>;
  const commit = input.commit ?? state.cooperation?.canonicalCommit;
  if (typeof commit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit))
    throw new Error('math_library_extract_commit_required: pass --commit when the run has no canonical commit');
  const into = input.into ?? `Run${state.runId.replace(/[^A-Za-z0-9]/gu, '').slice(0, 12)}`;
  if (!/^[A-Z][A-Za-z0-9_]*(?:\/[A-Z][A-Za-z0-9_]*)*$/u.test(into)) throw new Error('math_library_extract_into_invalid');
  const worktree = state.worktree, projectRelative = problem.projectRelative;
  const read = (file: string) => mathGitBytes(worktree, ['show', `${commit}:${path.posix.join(projectRelative, file)}`],
    { maxBuffer: MAX_LIBRARY_MODULE_BYTES + 1, timeout: 30_000, errorMessage: `math_library_extract_source_unavailable: ${file}` }).toString('utf8');
  const selected = [...new Set(input.files)].sort();
  if (!selected.length) throw new Error('math_library_extract_files_required');
  for (const file of selected) {
    if (!owned.includes(file) || !file.endsWith('.lean')) throw new Error(`math_library_extract_not_owned: ${file}`);
    if (Object.hasOwn(frozen, file)) throw new Error(`math_library_extract_frozen: ${file} is already a library module; pass its pack as --base`);
  }
  for (const [file, target] of Object.entries(input.modulePaths ?? {}))
    if (!selected.includes(file) || !isLibraryPackFile(target)) throw new Error(`math_library_extract_module_path_invalid: ${file}`);
  const destination = (file: string) => input.modulePaths?.[file] ??
    `${LIBRARY_PACK_DIRECTORY}/${into}/${file === 'Submission.lean' ? 'Submission.lean' : file.replace(/^Submission\//u, '')}`;
  const renamed = new Map(selected.map(file => [moduleName(file), moduleName(destination(file))]));
  const originalNames = new Set(input.keepOriginals ? [] : Object.entries(originals).filter(([file]) => !Object.hasOwn(frozen, file))
    .flatMap(([, items]) => items.map(item => localName(item.name))));
  const requires = new Map<string, string>(), removed = new Set<string>();
  const require = (file: string): void => {
    if (requires.has(file)) return;
    requires.set(file, trusted[file]!);
    for (const name of mathConstructionImports(read(file))) {
      const next = localModuleFile(name);
      if (Object.hasOwn(trusted, next)) require(next);
    }
  };
  const sources = selected.map(file => {
    const original = read(file);
    let rewritten = original;
    for (const span of mathConstructionImportSpans(original).reverse()) {
      const name = plainName(span.name), target = localModuleFile(span.name);
      if (renamed.has(name)) rewritten = rewritten.slice(0, span.start) + renamed.get(name)! + rewritten.slice(span.end);
      else if (Object.hasOwn(frozen, target)) {
        if (!input.base?.modules.some(module => module.file === target)) throw new Error(`math_library_extract_base_required: ${file} imports ${name}`);
      } else if (owned.includes(target)) throw new Error(`math_library_extract_import_not_selected: ${file} imports ${name}`);
      else if (Object.hasOwn(trusted, target)) require(target);
    }
    return [file, rewritten] as const;
  });
  // A removal in one file can strand dependents in another: repeat until the removed names are stable.
  let pruned: ReturnType<typeof pruneDeclarations>[], size: number;
  do {
    size = removed.size;
    pruned = sources.map(([file, source]) => pruneDeclarations(file, source, originalNames, input.dropUnproved ?? false, removed));
  } while (removed.size !== size);
  const modules: LibraryPackModule[] = sources.map(([file], index) => ({ file: destination(file), source: pruned[index]!.source,
    origin: { kind: 'run', runId: state.runId as string, commit, file,
      receiptDigest: optionalHash(problem.receiptDigest), environmentDigest: optionalHash(state.environmentDigest),
      ...(pruned[index]!.dropped.length ? { dropped: pruned[index]!.dropped } : {}) } }));
  const extracted: LibraryPack = { schema: LIBRARY_PACK_SCHEMA, modules,
    ...(requires.size ? { requires: [...requires].sort(([a], [b]) => a < b ? -1 : 1).map(([file, digest]) => ({ file, digest })) } : {}) };
  return input.base ? mergeLibraryPacks([input.base, extracted]) : parseLibraryPack(extracted);
}

/**
 * Backport files of a Lean repository commit (for example a newer Mathlib checkout) verbatim, license header
 * included, into Submission/Library/<into>/<file>. Imports among the selected files are renamed; every other
 * import must resolve in the destination's pinned packages, which the startup recheck establishes.
 */
export function upstreamLibraryModules(input: { repository: string; commit: string; files: readonly string[]; into?: string;
  base?: LibraryPack }): LibraryPack {
  const repository = fs.realpathSync(path.resolve(input.repository));
  if (!/^[A-Za-z0-9._/-]{1,256}$/u.test(input.commit) || input.commit.startsWith('-')) throw new Error('math_library_upstream_commit_invalid');
  const commit = mathGitText(repository, ['rev-parse', '--verify', '--quiet', `${input.commit}^{commit}`],
    { maxBuffer: 4096, errorMessage: 'math_library_upstream_commit_unavailable' });
  let label = repository;
  try {
    label = mathGitText(repository, ['config', '--get', 'remote.origin.url'], { maxBuffer: 4096 })
      .replace(/^(https?:\/\/)[^/@]*@/u, '$1');
  } catch { /* A local checkout without an origin is identified by its path. */ }
  const into = input.into ?? 'Upstream';
  if (!/^[A-Z][A-Za-z0-9_]*(?:\/[A-Z][A-Za-z0-9_]*)*$/u.test(into)) throw new Error('math_library_upstream_into_invalid');
  const selected = [...new Set(input.files)].sort();
  if (!selected.length) throw new Error('math_library_upstream_files_required');
  for (const file of selected)
    if (repositoryRelativePath(file) !== file || !file.endsWith('.lean')) throw new Error(`math_library_upstream_file_invalid: ${file}`);
  const destination = (file: string) => `${LIBRARY_PACK_DIRECTORY}/${into}/${file}`;
  const renamed = new Map(selected.map(file => [moduleName(file), moduleName(destination(file))]));
  const modules = selected.map((file): LibraryPackModule => {
    const original = mathGitBytes(repository, ['show', `${commit}:${file}`], { maxBuffer: MAX_LIBRARY_MODULE_BYTES + 1,
      timeout: 30_000, errorMessage: `math_library_upstream_source_unavailable: ${file}` }).toString('utf8');
    let source = original;
    for (const span of mathConstructionImportSpans(original).reverse()) {
      const name = plainName(span.name);
      if (renamed.has(name)) source = source.slice(0, span.start) + renamed.get(name)! + source.slice(span.end);
    }
    return { file: destination(file), source, origin: { kind: 'upstream', repository: label.slice(0, 512), commit, file } };
  });
  const pack: LibraryPack = { schema: LIBRARY_PACK_SCHEMA, modules };
  return input.base ? mergeLibraryPacks([input.base, pack]) : parseLibraryPack(pack);
}

/** Union of packs; module files must be distinct and shared requirements must agree. */
export function mergeLibraryPacks(packs: readonly LibraryPack[]): LibraryPack {
  const requires = new Map<string, string>();
  for (const item of packs.flatMap(pack => pack.requires ?? [])) {
    if (requires.has(item.file) && requires.get(item.file) !== item.digest) throw new Error(`math_library_pack_requirement_conflict: ${item.file}`);
    requires.set(item.file, item.digest);
  }
  return parseLibraryPack({ schema: LIBRARY_PACK_SCHEMA, modules: packs.flatMap(pack => pack.modules),
    ...(requires.size ? { requires: [...requires].sort(([a], [b]) => a < b ? -1 : 1).map(([file, digest]) => ({ file, digest })) } : {}) });
}

/** Digest, modules and the imports Lean must resolve outside the pack (pinned packages or trusted requirements). */
export function summarizeLibraryPack(pack: LibraryPack) {
  const local = new Set(pack.modules.map(module => moduleName(module.file)));
  return { digest: libraryPackDigest(pack), requires: pack.requires ?? [],
    modules: pack.modules.map(module => ({ file: module.file, bytes: Buffer.byteLength(module.source), origin: { ...module.origin,
      dropped: module.origin.kind === 'run' ? module.origin.dropped?.length : undefined },
      declarations: inspectLeanDeclarationRegions(module.source).length,
      externalImports: mathConstructionImports(module.source).map(plainName).filter(name => !local.has(name)) })) };
}

const libraryNameCache = new Map<string, ReadonlySet<string>>();
const qualifiedNames = (source: string): ReadonlySet<string> => {
  const key = mathDigest(source);
  let names = libraryNameCache.get(key);
  if (!names) {
    names = new Set(inspectScopedLeanDeclarations(source).map(item => item.qualifiedName));
    libraryNameCache.set(key, names);
    if (libraryNameCache.size > 64) libraryNameCache.delete(libraryNameCache.keys().next().value!);
  }
  return names;
};

/** A non-library owned declaration whose (lexical) qualified name a frozen library module already declares. */
export function libraryDeclarationConflict(frozenSources: Readonly<Record<string, string>>,
  ownedSources: Readonly<Record<string, string>>): { file: string; name: string; libraryFile: string } | undefined {
  const library = Object.entries(frozenSources).map(([file, source]) => [file, qualifiedNames(source)] as const);
  for (const [file, source] of Object.entries(ownedSources)) for (const item of inspectScopedLeanDeclarations(source)) {
    const owner = library.find(([, names]) => names.has(item.qualifiedName));
    if (owner) return { file, name: item.qualifiedName, libraryFile: owner[0] };
  }
  return undefined;
}
