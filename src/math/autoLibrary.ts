import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { inspectLeanDeclarationRegions, inspectLeanDeclarations, inspectScopedLeanDeclarations } from './leanSource';
import { maskLeanCommentsAndStrings } from './leanSyntax';
import { LIBRARY_PACK_SCHEMA, MAX_LIBRARY_MODULE_BYTES, libraryDeclarationConflict, libraryForbiddenToken, mergeLibraryPacks,
  parseLibraryPack, type LibraryPack, type LibraryPackModule } from './libraryPacks';
import { mathGitBytes } from './mathGit';
import { mathConstructionImports, mathConstructionImportSpans } from './mathConstructionSources';
import { canonicalMathJson, mathDigest, readMathText, withMathRuntimeLease, writeMathJsonDurable } from './mathRuntimeIo';
import { assertMathCanonicalPath } from './paths';

/**
 * Auto-library modules are Lean modules the solving system writes for itself before it solves a problem. A planner
 * states definitions and theorems (theorem bodies `sorry`), a solver run proves them, and the host keeps only what
 * Lean accepted without gaps as a frozen library file. Published modules join an append-only pool that any later
 * problem may install. They are not excluded per challenge: every record names the problem that triggered it and
 * what it cost, and a solution that imports one reports it. A record also lists the library files its build could
 * read, and a problem installs it only when all of them are installed there too, so a module never carries a hand
 * module a problem excludes into that problem, not even restated.
 */
export const AUTO_LIBRARY_RECORD_SCHEMA = 'theorem-os.auto-library-record.v1';
export const AUTO_LIBRARY_DIRECTORY = 'Submission/Library/Auto';
export const AUTO_LIBRARY_NAMESPACE = 'TheoremOS.Auto';
/** Planner source limit; the published module adds a provenance header. */
export const MAX_AUTO_LIBRARY_SPEC_BYTES = 128 * 1024;
const MAX_AUTO_LIBRARY_MODULE_BYTES = MAX_AUTO_LIBRARY_SPEC_BYTES + 32 * 1024;
export const AUTO_LIBRARY_NAME = /^[A-Z][A-Za-z0-9]{2,47}$/u;
const NAME = AUTO_LIBRARY_NAME;
export const isAutoLibraryName = (name: unknown): name is string => typeof name === 'string' && NAME.test(name);
export const autoLibraryFile = (name: string) => `${AUTO_LIBRARY_DIRECTORY}/${name}.lean`;
export const autoLibraryModule = (name: string) => `Submission.Library.Auto.${name}`;
export const autoLibraryNamespace = (name: string) => `${AUTO_LIBRARY_NAMESPACE}.${name}`;
const moduleName = (file: string) => file.slice(0, -'.lean'.length).replaceAll('/', '.');
const plainName = (name: string) => name.replaceAll('«', '').replaceAll('»', '');
const lineAt = (source: string, offset: number) => source.slice(0, offset).split('\n').length;

/** Comment text that cannot close or nest the surrounding block comment. */
const commentText = (text: string) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, ' ')
  .replaceAll('-/', '- /').replaceAll('/-', '/ -');

/** A module doc header recording what the module is for and the literature it follows, placed after the imports. */
export function withAutoLibraryHeader(source: string, input: { name: string; summary: string; sources: readonly string[];
  application?: { target: string; use: string; remaining: readonly string[] } }): string {
  const spans = mathConstructionImportSpans(source), at = spans.length ? spans.at(-1)!.end : 0;
  const lineEnd = spans.length ? source.indexOf('\n', at) : -1, insert = spans.length ? (lineEnd < 0 ? source.length : lineEnd + 1) : 0;
  const header = [`/-! # TheoremOS auto-library module \`${input.name}\``, '',
    commentText(input.summary.trim()), '',
    ...(input.application ? ['Planned use for the triggering challenge:',
      '* ' + commentText(input.application.target) + ': ' + commentText(input.application.use),
      ...input.application.remaining.map(item => '* Remaining: ' + commentText(item)), ''] : []),
    ...(input.sources.length ? ['Sources:', ...input.sources.map(item => `* ${commentText(item.trim())}`), ''] : []),
    'Written by the TheoremOS library planner and proved by a TheoremOS solver run before solving the problem',
    'recorded in the pool record. Only declarations Lean accepted with no gaps are kept. -/', ''].join('\n');
  const prefix = source.slice(0, insert);
  return `${prefix}${prefix && !prefix.endsWith('\n') ? '\n' : ''}${spans.length ? '\n' : ''}${header}${source.slice(insert)}`;
}

/** Lines a module may have outside its namespace: imports, opens, options, universes and scope commands. */
const OUTSIDE = /^\s*(?:import\s|open\s|set_option\s|universe\s|variable\s|(?:noncomputable\s+)?section\b|namespace\s|end\b|$)/u;
const DECLARATION_WORD = /(?<![\p{L}\p{M}\p{N}_'.])(?:theorem|lemma|def|abbrev|instance|example|opaque|structure|inductive|class|axiom|export|mutual)(?![\p{L}\p{M}\p{N}_'?!])/u;
const SCOPE = /^\s*(?:(?:noncomputable|public|private|meta)\s+)*(namespace|section|end|mutual)(?![\p{L}\p{M}\p{N}_'?!])\s*(.*)$/u;
/** Syntax and environment extensions that would reach every importer. */
const SYNTAX = /^\s*(?:@\[[^\]]*\]\s*)?(?:(local|scoped)\s+)?(notation\d*|infix[lr]?|prefix|postfix|macro_rules|macro|syntax|elab_rules|elab|declare_syntax_cat|initialize|builtin_initialize|register_\w+|attribute)(?![\p{L}\p{M}\p{N}_'?!])(.*)$/u;
const ALWAYS_REJECTED = new Set(['elab_rules', 'elab', 'declare_syntax_cat', 'initialize', 'builtin_initialize']);
const THEOREM_GAP = /(?<![\p{L}\p{M}\p{N}_'])sorry(?![\p{L}\p{M}\p{N}_'])/gu;

/**
 * Host gate for a planner spec (`allowSorry`: theorem bodies may be `sorry`) or a proved module. Lean, the startup
 * recheck and the final axiom check stay the authority; this rejects trust escapes, declarations outside the module
 * namespace, global syntax or attribute changes, and imports of anything but the pinned packages and library modules.
 */
export function inspectAutoLibrarySource(input: { name: string; source: string; libraryModules: ReadonlySet<string>;
  allowSorry: boolean }): string[] {
  const { name, source } = input, problems: string[] = [];
  if (!isAutoLibraryName(name)) return [`module name must match ${NAME.source}`];
  const limit = input.allowSorry ? MAX_AUTO_LIBRARY_SPEC_BYTES : MAX_AUTO_LIBRARY_MODULE_BYTES;
  if (Buffer.byteLength(source) > limit) return [`source is larger than ${limit} bytes`];
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(source) || Buffer.from(source, 'utf8').toString('utf8') !== source)
    return ['source must be UTF-8 text without control characters'];
  try {
    for (const span of mathConstructionImportSpans(source)) {
      const imported = plainName(span.name);
      if (imported === autoLibraryModule(name)) problems.push(`line ${lineAt(source, span.start)}: the module imports itself`);
      else if (/^(?:Challenge|Submission)(?:\.|$)/u.test(imported) && !input.libraryModules.has(imported))
        problems.push(`line ${lineAt(source, span.start)}: import ${imported} is not an available library module`);
    }
  } catch { problems.push('the import header does not parse'); }
  let masked = maskLeanCommentsAndStrings(source);
  if (input.allowSorry) {
    const kinds = inspectLeanDeclarations(source);
    for (const [index, region] of inspectLeanDeclarationRegions(source).entries()) {
      if (kinds[index]?.kind !== 'theorem') continue;
      masked = masked.slice(0, region.bodyOffset) +
        masked.slice(region.bodyOffset, region.endOffset).replace(THEOREM_GAP, word => ' '.repeat(word.length)) + masked.slice(region.endOffset);
    }
  }
  const forbidden = libraryForbiddenToken(masked);
  if (forbidden) problems.push(`line ${lineAt(masked, forbidden.index)}: ${forbidden.token} is not allowed${forbidden.token === 'sorry' ? ' here' : ''}`);
  if (/(?<![\p{L}\p{M}\p{N}_'])_root_(?![\p{L}\p{M}\p{N}_'])/u.test(masked)) problems.push('`_root_` is not allowed');
  const prefix = autoLibraryNamespace(name), scopes: { namespace: boolean; part: string }[] = [];
  const inside = () => {
    const current = scopes.filter(scope => scope.namespace).map(scope => scope.part).join('.');
    return current === prefix || current.startsWith(`${prefix}.`);
  };
  for (const [index, line] of masked.split('\n').entries()) {
    const at = `line ${index + 1}`, scope = SCOPE.exec(line), syntax = SYNTAX.exec(line);
    if (syntax) {
      const [, modifier, command, rest] = syntax;
      if (ALWAYS_REJECTED.has(command!) || command!.startsWith('register_')) problems.push(`${at}: ${command} is not allowed in a library module`);
      else if (command === 'attribute') {
        const items = /^\s*\[([^\]]*)\]/u.exec(rest!)?.[1]?.split(',') ?? [''];
        if (items.some(item => !/^\s*(?:local|scoped)\s/u.test(item))) problems.push(`${at}: an attribute command must be local or scoped`);
      } else if (!modifier) problems.push(`${at}: ${command} must be local or scoped`);
    }
    if (scope) {
      const [, kind, rest] = scope, written = rest!.trim();
      if (kind === 'mutual') {
        if (!inside()) problems.push(`${at}: mutual blocks must be inside namespace ${prefix}`);
        scopes.push({ namespace: false, part: '' });
        continue;
      }
      if (written && !/^[\p{L}_«][\p{L}\p{M}\p{N}_'?!.«»]*$/u.test(written)) {
        problems.push(`${at}: write ${kind} commands on their own line`);
        continue;
      }
      const parts = written ? plainName(written).split('.') : [''];
      if (kind === 'end') scopes.splice(Math.max(0, scopes.length - parts.length));
      else for (const part of parts) scopes.push({ namespace: kind === 'namespace', part });
      continue;
    }
    // Import lines name modules (`Mathlib.Tactic.Lemma`), not declarations.
    if (!inside() && line.trim() && !/^\s*import\s/u.test(line) && (!OUTSIDE.test(line) || DECLARATION_WORD.test(line)))
      problems.push(`${at}: declarations and commands must be inside namespace ${prefix}`);
  }
  const declarations = inspectScopedLeanDeclarations(source);
  if (!declarations.some(item => item.kind === 'theorem')) problems.push('the module states no theorem or lemma');
  const finals = declarations.map(item => item.qualifiedName.split('.').at(-1)!);
  const repeated = [...new Set(finals.filter((item, index) => finals.indexOf(item) !== index))];
  if (repeated.length) problems.push(`declaration names repeat their final component: ${repeated.slice(0, 8).join(', ')}`);
  return [...new Set(problems)].slice(0, 24);
}

/** Qualified names of the module's theorems, in source order. */
export const autoLibraryTheorems = (source: string): string[] =>
  inspectScopedLeanDeclarations(source).filter(item => item.kind === 'theorem').map(item => item.qualifiedName);

const hash = z.string().regex(/^[a-f0-9]{64}$/u), oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const tokens = z.number().int().nonnegative().nullable();
const recordSchema = z.object({
  schema: z.literal(AUTO_LIBRARY_RECORD_SCHEMA),
  name: z.string().regex(NAME), file: z.string(), source: z.string().min(1).max(MAX_AUTO_LIBRARY_MODULE_BYTES),
  sourceDigest: hash, summary: z.string().min(1).max(2000), sources: z.array(z.string().min(1).max(400)).max(12),
  theorems: z.array(z.string().min(1).max(512)).min(1).max(1024),
  requires: z.array(z.object({ file: z.string().min(1).max(512), digest: hash }).strict()).max(256),
  /** Library files the planner or prover of the build could read, sorted. */
  visible: z.array(z.string().min(1).max(512)).max(4096),
  environment: z.object({ id: z.string().min(1).max(64), digest: hash }).strict(),
  trigger: z.object({ challengeId: z.string().min(1).max(256), challengeDigest: hash, taskDigest: hash }).strict(),
  cost: z.object({ plannerTokens: tokens, proverTokens: tokens, wallMs: z.number().int().nonnegative(),
    rounds: z.number().int().positive() }).strict(),
  planner: z.object({ model: z.string().min(1).max(128), effort: z.string().min(1).max(32) }).strict(),
  prover: z.object({ runId: z.string().min(1).max(128), commit: oid, model: z.string().min(1).max(128),
    receiptDigest: hash.optional(), environmentDigest: hash.optional(),
    dropped: z.array(z.object({ name: z.string().min(1).max(512), reason: z.enum(['unproved', 'dependent']) }).strict()).max(4096) }).strict(),
  buildId: z.string().uuid(), buildDigest: hash, publishedAt: z.string().datetime(),
}).strict().superRefine((record, context) => {
  if (record.file !== autoLibraryFile(record.name)) context.addIssue({ code: 'custom', path: ['file'], message: 'does not match the name' });
  if (record.sourceDigest !== mathDigest(record.source)) context.addIssue({ code: 'custom', path: ['sourceDigest'], message: 'does not match the source' });
  if (record.visible.some((file, index) => index > 0 && record.visible[index - 1]! >= file) || record.visible.includes(record.file))
    context.addIssue({ code: 'custom', path: ['visible'], message: 'must be sorted, unique and exclude the module itself' });
  else if (record.requires.some(item => !record.visible.includes(item.file)))
    context.addIssue({ code: 'custom', path: ['visible'], message: 'must contain every required file' });
});
export type AutoLibraryRecord = z.infer<typeof recordSchema>;

export function parseAutoLibraryRecord(value: unknown): AutoLibraryRecord {
  const parsed = recordSchema.safeParse(value);
  if (!parsed.success) throw new Error(`auto_library_record_invalid: ${parsed.error.issues.slice(0, 4)
    .map(issue => `${issue.path.join('.') || 'record'} ${issue.message}`).join('; ')}`);
  return parsed.data;
}

const poolPaths = (pool: string) => ({ modules: path.join(pool, 'modules'), reservations: path.join(pool, 'reservations'),
  lock: path.join(pool, 'pool.lock') });

/** Published records, oldest first. A corrupt record stops the reader rather than silently shrinking the pool. */
export function readAutoLibraryPool(poolInput: string): AutoLibraryRecord[] {
  const pool = path.resolve(poolInput), directory = poolPaths(pool).modules;
  assertMathCanonicalPath(pool);
  if (!fs.existsSync(directory)) return [];
  const records = fs.readdirSync(directory).filter(file => /^[A-Z][A-Za-z0-9]*\.json$/u.test(file)).map(file => {
    const record = parseAutoLibraryRecord(JSON.parse(readMathText(path.join(directory, file), 2 * MAX_AUTO_LIBRARY_MODULE_BYTES + 1024 * 1024)));
    if (`${record.name}.json` !== file) throw new Error(`auto_library_record_invalid: ${file} names ${record.name}`);
    return record;
  });
  return records.sort((a, b) => a.publishedAt < b.publishedAt ? -1 : a.publishedAt > b.publishedAt ? 1 : a.name < b.name ? -1 : 1);
}

function ensurePool(poolInput: string): string {
  const pool = path.resolve(poolInput);
  assertMathCanonicalPath(pool);
  for (const directory of [pool, poolPaths(pool).modules, poolPaths(pool).reservations]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(pool) !== pool) throw new Error('auto_library_pool_path_invalid');
  return pool;
}

/** Short exclusive pool lock; concurrent builds wait for each other's reservation or publication. */
async function withPoolLock<T>(pool: string, operation: () => T): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await withMathRuntimeLease({ lockPath: poolPaths(pool).lock, flockExecutable: '/usr/bin/flock' }, async () => operation());
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'math_runtime_lease_busy' || attempt >= 200) throw error;
      await new Promise(resolve => setTimeout(resolve, 50 + Math.floor(Math.random() * 100)));
    }
  }
}

/** Names a new module may not use: published ones and other builds' reservations, compared case-insensitively. */
export function takenAutoLibraryNames(poolInput: string, buildId: string): string[] {
  const pool = path.resolve(poolInput), paths = poolPaths(pool), taken = new Set<string>();
  const listed = (directory: string) => fs.existsSync(directory) ? fs.readdirSync(directory).filter(file => /^[A-Z][A-Za-z0-9]*\.json$/u.test(file)) : [];
  for (const file of listed(paths.modules)) taken.add(file.slice(0, -5));
  for (const file of listed(paths.reservations)) {
    let owner: unknown;
    try { owner = (JSON.parse(readMathText(path.join(paths.reservations, file), 4096)) as { buildId?: unknown }).buildId; } catch { owner = undefined; }
    if (owner !== buildId) taken.add(file.slice(0, -5));
  }
  return [...taken].sort();
}

/** Claim a module name for one build. Returns false when the name is published or another build holds it. */
export async function reserveAutoLibraryName(poolInput: string, name: string, buildId: string): Promise<boolean> {
  if (!isAutoLibraryName(name)) return false;
  const pool = ensurePool(poolInput), file = path.join(poolPaths(pool).reservations, `${name}.json`);
  return withPoolLock(pool, () => {
    const lower = name.toLowerCase();
    if (takenAutoLibraryNames(pool, buildId).some(item => item.toLowerCase() === lower)) return false;
    if (!fs.existsSync(file)) writeMathJsonDurable(file, { name, buildId });
    return true;
  });
}

/** Add a record to the pool. Publishing the same record again is a no-op; any other record under the name fails. */
export async function publishAutoLibraryRecord(poolInput: string, value: AutoLibraryRecord): Promise<void> {
  const record = parseAutoLibraryRecord(value), pool = ensurePool(poolInput), paths = poolPaths(pool);
  const file = path.join(paths.modules, `${record.name}.json`), text = canonicalMathJson(record);
  await withPoolLock(pool, () => {
    if (fs.existsSync(file)) {
      if (readMathText(file) === text) return;
      throw new Error(`auto_library_name_taken: ${record.name}`);
    }
    let owner: unknown;
    try { owner = (JSON.parse(readMathText(path.join(paths.reservations, `${record.name}.json`), 4096)) as { buildId?: unknown }).buildId; }
    catch { owner = undefined; }
    if (owner !== record.buildId) throw new Error(`auto_library_reservation_missing: ${record.name}`);
    writeMathJsonDurable(file, record, 0o400);
  });
}

export type AutoLibrarySkip = { name: string;
  reason: 'environment' | 'file_present' | 'requirement_missing' | 'visibility' | 'declaration_conflict' };

/**
 * A destination pack: `base` (the hand library after its exclusions) plus every pool record built for the same
 * environment whose required modules are present with the bytes it was proved against, whose build saw no library
 * file missing here (an excluded hand module, or a pool module skipped here) and whose declarations the challenge
 * does not repeat. Records join in publication order, so a record can require an earlier one.
 */
export function autoLibraryPackFor(input: { base?: LibraryPack; records: readonly AutoLibraryRecord[]; environmentDigest: string;
  challengeSource: string }): { pack?: LibraryPack; included: string[]; skipped: AutoLibrarySkip[] } {
  const installed = new Map((input.base?.modules ?? []).map(module => [module.file, mathDigest(module.source)]));
  const modules: LibraryPackModule[] = [], included: string[] = [], skipped: AutoLibrarySkip[] = [];
  for (const record of input.records) {
    const skip = (reason: AutoLibrarySkip['reason']) => skipped.push({ name: record.name, reason });
    if (record.environment.digest !== input.environmentDigest) { skip('environment'); continue; }
    if (installed.has(record.file)) { skip('file_present'); continue; }
    if (record.requires.some(item => installed.get(item.file) !== item.digest)) { skip('requirement_missing'); continue; }
    if (record.visible.some(file => !installed.has(file))) { skip('visibility'); continue; }
    if (libraryDeclarationConflict({ [record.file]: record.source }, { 'Challenge.lean': input.challengeSource })) { skip('declaration_conflict'); continue; }
    installed.set(record.file, record.sourceDigest);
    included.push(record.name);
    modules.push({ file: record.file, source: record.source, origin: { kind: 'run', runId: record.prover.runId, commit: record.prover.commit,
      file: 'Submission.lean', ...(record.prover.receiptDigest ? { receiptDigest: record.prover.receiptDigest } : {}),
      ...(record.prover.environmentDigest ? { environmentDigest: record.prover.environmentDigest } : {}),
      ...(record.prover.dropped.length ? { dropped: record.prover.dropped } : {}) } });
  }
  if (!modules.length) return { pack: input.base, included, skipped };
  const added: LibraryPack = { schema: LIBRARY_PACK_SCHEMA, modules };
  return { pack: input.base ? mergeLibraryPacks([input.base, added]) : parseLibraryPack(added), included, skipped };
}

type SourceModules = Pick<LibraryPack, 'modules'>;

/** Library modules of `pack` that `source` imports, directly or through other pack modules. */
export function libraryImportClosure(pack: SourceModules | undefined, source: string): string[] {
  const files = new Map((pack?.modules ?? []).map(module => [moduleName(module.file), module])), reached = new Set<string>();
  const imports = (text: string) => { try { return mathConstructionImports(text).map(plainName); } catch { return []; } };
  const queue = imports(source);
  while (queue.length) {
    const module = files.get(queue.shift()!);
    if (!module || reached.has(module.file)) continue;
    reached.add(module.file);
    queue.push(...imports(module.source));
  }
  return [...reached].sort();
}

/**
 * Pool modules a final solution reaches through its imports, with what each cost and which problem triggered it.
 * `mentioned` lists module theorems the solution names (lexically; Lean's elaboration is not replayed).
 */
export function autoLibraryUsage(input: { records: readonly AutoLibraryRecord[]; pack?: SourceModules; source: string }) {
  const reached = new Set(libraryImportClosure(input.pack, input.source));
  const words = new Set(maskLeanCommentsAndStrings(input.source).match(/[\p{L}_][\p{L}\p{M}\p{N}_'?!]*(?:\.[\p{L}_][\p{L}\p{M}\p{N}_'?!]*)*/gu) ?? []);
  const direct = new Set((() => { try { return mathConstructionImports(input.source).map(plainName); } catch { return []; } })());
  return input.records.filter(record => reached.has(record.file)).map(record => ({
    name: record.name, file: record.file, direct: direct.has(autoLibraryModule(record.name)),
    mentioned: record.theorems.filter(theorem => [...words].some(word => word === theorem || theorem.endsWith(`.${word}`))),
    trigger: record.trigger, cost: record.cost,
  }));
}

/**
 * Usage of pool modules by a finished solver run: its checked solution (else the canonical commit) read from the
 * run's worktree, against the library files frozen into the run.
 */
export function autoLibraryRunUsage(input: { records: readonly AutoLibraryRecord[]; stateFile: string }) {
  const state = JSON.parse(readMathText(path.resolve(input.stateFile), 64 * 1024 * 1024)) as { worktree?: unknown;
    check?: { passed?: unknown; commit?: unknown }; cooperation?: { canonicalCommit?: unknown };
    problem?: { projectRelative?: unknown; frozenFiles?: unknown } };
  const commit = state.check?.passed === true ? state.check.commit : state.cooperation?.canonicalCommit;
  if (typeof state.worktree !== 'string' || typeof state.problem?.projectRelative !== 'string' || typeof commit !== 'string' ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit)) throw new Error('auto_library_usage_state_invalid');
  const worktree = state.worktree, project = state.problem.projectRelative;
  const read = (file: string) => mathGitBytes(worktree, ['show', `${commit}:${path.posix.join(project, file)}`],
    { maxBuffer: MAX_LIBRARY_MODULE_BYTES + 1, timeout: 30_000, errorMessage: `auto_library_usage_source_unavailable: ${file}` }).toString('utf8');
  const frozen = Object.keys((state.problem.frozenFiles ?? {}) as Record<string, string>).sort();
  return { commit, checked: state.check?.passed === true,
    modules: autoLibraryUsage({ records: input.records, source: read('Submission.lean'),
      pack: { modules: frozen.map(file => ({ file, source: read(file) })) } }) };
}
