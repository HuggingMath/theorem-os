import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { canonicalMathProblemStatementPayloads, type MathProblemContract } from './contracts';
import { canonicalMathJson, mathDigest, readMathJson, writeMathJsonDurable } from './mathRuntimeIo';
import { inspectScopedLeanDeclarations } from './leanSource';
import { maskLeanCommentsAndStrings } from './leanSyntax';
import { getLeanTaskEnvironment, type LeanTaskEnvironment } from './leanTaskEnvironment';
import { installLibraryPack, isLibraryPackFile, libraryDeclarationConflict, libraryPackDigest, MAX_LIBRARY_MODULE_BYTES,
  parseLibraryPack, type LibraryPack } from './libraryPacks';
import { mathConstructionImports } from './mathConstructionSources';
import { mathGitBytes, mathGitText } from './mathGit';
import { assertMathCanonicalPath } from './paths';

export const LEAN_TASK_SOURCE_MAX_BYTES = 1024 * 1024;
/** Declarations, and so definition targets, per statement. */
export const LEAN_TASK_DECLARATIONS_MAX = 1024;
export const LEAN_TASK_DESCRIPTION_MAX_LENGTH = 8_000;
const projectRelative = 'generated/problem';
const schema = 'theorem-os.lean-task.v1' as const;
const seedPrefix = 'TheoremOS Lean task seed\n\n';
const hash = z.string().regex(/^[0-9a-f]{64}$/u);
const inputSchema = z.object({
  source: z.string().min(1).max(LEAN_TASK_SOURCE_MAX_BYTES),
  task: z.string().trim().min(1).max(LEAN_TASK_DESCRIPTION_MAX_LENGTH),
  environment: z.enum(['standard', 'mathlib']).optional(),
  libraryPack: z.unknown().optional(),
}).strict();
const libraryPackSchema = z.object({ digest: hash, files: z.record(z.string(), hash) }).strict();
const declarationSchema = z.object({
  name: z.string().min(1), kind: z.enum(['theorem', 'definition', 'instance']), declarationHash: hash,
}).strict();
const obligationSchema = z.object({ name: z.string().min(1), declarationHash: hash }).strict();
const receiptSchema = z.object({
  schema: z.literal(schema), kind: z.literal('lean-task'),
  workspaceRoot: z.string(), projectRoot: z.string(), activeProblemPath: z.string(),
  baseCommit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u), toolchain: z.string().min(1),
  environment: inputSchema.shape.environment, environmentDigest: hash.optional(),
  contract: z.record(z.unknown()), trustedFiles: z.array(z.string()), solverOwnedFiles: z.array(z.string()),
  publicObligations: z.array(obligationSchema), declarations: z.array(declarationSchema),
  libraryPack: libraryPackSchema.optional(),
}).strict();
const seedSchema = z.object({
  schema: z.literal('theorem-os.lean-task-seed.v1'), task: inputSchema.shape.task, sourceHash: hash,
  environment: inputSchema.shape.environment, environmentDigest: hash.optional(),
  libraryPack: libraryPackSchema.optional(),
}).strict();

export type LeanTaskReceipt = Omit<z.infer<typeof receiptSchema>, 'contract'> & { contract: MathProblemContract };
export type LeanTaskInput = { source: string; task: string; environment?: LeanTaskEnvironment;
  /** Frozen Submission/Library modules (see libraryPacks.ts) installed beside Submission.lean. */
  libraryPack?: LibraryPack };

function inspectInput(input: LeanTaskInput) {
  const parsed = inputSchema.parse(input);
  if (Buffer.byteLength(parsed.source, 'utf8') > LEAN_TASK_SOURCE_MAX_BYTES ||
      Buffer.from(parsed.source + parsed.task, 'utf8').toString('utf8') !== parsed.source + parsed.task ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(parsed.source + parsed.task))
    throw new Error('lean_task_input_invalid');
  const declarations = inspectScopedLeanDeclarations(parsed.source);
  if (declarations.length > LEAN_TASK_DECLARATIONS_MAX) throw new Error('lean_task_declarations_limit');
  // Declarations repeating a final name component are identified by qualified name (leanDeclarationKeys);
  // targets are still found by their final component, which must therefore be unique.
  if (new Set(declarations.map(item => item.qualifiedName)).size !== declarations.length)
    throw new Error('lean_task_declaration_names_ambiguous');
  const targets = declarations.filter(item => item.kind === 'theorem');
  if (!targets.length) throw new Error('lean_task_targets_missing');
  const local = (name: string) => name.split('.').at(-1)!;
  const repeated = new Set(declarations.map(item => local(item.name)).filter((name, index, names) => names.indexOf(name) !== index));
  const target = targets.find(item => repeated.has(local(item.name)));
  if (target) throw new Error(`lean_task_target_name_ambiguous: ${target.qualifiedName}`);
  const targetOffsets = new Set(targets.map(item => item.startOffset));
  const keywords = maskLeanCommentsAndStrings(parsed.source).matchAll(
    /(?<![\p{L}\p{M}\p{N}_'.?!])(?:theorem|lemma)(?![\p{L}\p{M}\p{N}_'.?!])/gu);
  for (const keyword of keywords) if (!targetOffsets.has(keyword.index)) throw new Error('lean_task_declaration_invalid');
  return { ...parsed,
    declarations: declarations.map(item => ({ name: item.qualifiedName, kind: item.kind,
      declarationHash: mathDigest(item.declarationType) })),
    publicObligations: targets.map(item => ({ name: item.qualifiedName, declarationHash: mathDigest(item.declarationType) })),
  };
}

/**
 * A task pack builds on the pinned packages only: Challenge.lean is the untrusted statement and Submission.lean
 * is proof work, so neither may be imported, and no pack declaration may share a name with the statement's.
 */
function inspectLibraryPack(value: unknown, source: string): LibraryPack {
  const pack = parseLibraryPack(value);
  if (pack.requires?.length) throw new Error('lean_task_library_pack_requirement_invalid');
  const local = new Set(pack.modules.map(module => module.file.slice(0, -'.lean'.length).replaceAll('/', '.')));
  for (const module of pack.modules) {
    const outside = mathConstructionImports(module.source).map(name => name.replaceAll('«', '').replaceAll('»', ''))
      .find(name => !local.has(name) && (name === 'Challenge' || name.startsWith('Challenge.') ||
        name === 'Submission' || name.startsWith('Submission.')));
    if (outside) throw new Error(`lean_task_library_pack_import_invalid: ${module.file} imports ${outside}`);
  }
  const conflict = libraryDeclarationConflict(Object.fromEntries(pack.modules.map(module => [module.file, module.source])),
    { 'Submission.lean': source });
  if (conflict) throw new Error(`lean_task_library_pack_declaration_conflict: ${conflict.name}`);
  return pack;
}

function trustedSources(source: string, environment: LeanTaskEnvironment): Record<string, string> {
  return {
    'Challenge.lean': source,
    ...getLeanTaskEnvironment(environment).files,
  };
}

function contractFor(source: string, task: string): MathProblemContract {
  const payloads = canonicalMathProblemStatementPayloads({ informalStatement: task, formalStatement: source, assumptions: [] });
  return { problemId: `lean-task-${mathDigest(payloads.lean).slice(0, 16)}`, informalStatement: task,
    formalStatement: source, assumptions: [], knownTraps: ['Preserve the original declarations and frozen project inputs.'],
    acceptanceCriteria: ['Every original target passes independent Lean kernel verification without sorry or unapproved axioms.'],
    officialVerificationCommand: 'User-provided Lean task: independent host verification, not an official benchmark.',
    statementHash: mathDigest(payloads.informal), leanStatementHash: mathDigest(payloads.lean) };
}

const gitText = (workspace: string, args: string[]) => mathGitText(workspace, ['--no-replace-objects', ...args],
  { timeout: 30_000, maxBuffer: 1024 * 1024, errorMessage: 'lean_task_seed_unavailable' });

function assertRegularFile(file: string): void {
  assertMathCanonicalPath(file);
  if (!fs.lstatSync(file).isFile()) throw new Error('lean_task_path_invalid');
}

/** Prepare untrusted text without running Lean, Lake, a model, or a source-provided command. */
export function bootstrapLeanTask(workspace: string, input: LeanTaskInput): LeanTaskReceipt {
  const inspected = inspectInput(input);
  const environment = getLeanTaskEnvironment(inspected.environment ?? 'standard');
  const libraryPack = inspected.libraryPack === undefined ? undefined : inspectLibraryPack(inspected.libraryPack, inspected.source);
  workspace = path.resolve(workspace);
  assertMathCanonicalPath(workspace);
  if (fs.existsSync(workspace)) throw new Error('Lean task workspace already exists; use a new directory.');
  const projectRoot = path.join(workspace, projectRelative);
  fs.mkdirSync(projectRoot, { recursive: true, mode: 0o700 });
  const sources = trustedSources(inspected.source, environment.id);
  for (const [relative, contents] of Object.entries({ ...sources, 'Submission.lean': inspected.source }))
    fs.writeFileSync(path.join(projectRoot, relative), contents, { flag: 'wx', mode: 0o600 });
  const libraryFiles = libraryPack && installLibraryPack(projectRoot, libraryPack,
    { trustedFiles: Object.keys(sources), solverOwnedFiles: ['Submission.lean'] });
  const library = libraryPack && libraryFiles ? { digest: libraryPackDigest(libraryPack), files: libraryFiles } : undefined;
  gitText(workspace, ['init', '--quiet']);
  gitText(workspace, ['add', '--', 'generated']);
  const message = seedPrefix + canonicalMathJson({ schema: 'theorem-os.lean-task-seed.v1', task: inspected.task,
    sourceHash: mathDigest(inspected.source), environment: environment.id, environmentDigest: environment.dependencyDigest,
    ...(library ? { libraryPack: library } : {}) });
  gitText(workspace, ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=TheoremOS', '-c', 'user.email=theoremos@localhost',
    'commit', '--no-gpg-sign', '--quiet', '--cleanup=verbatim', '-m', message]);
  fs.appendFileSync(path.join(workspace, '.git/info/exclude'), '\n/active-problem.json\n**/.lake/\n');
  const receipt: LeanTaskReceipt = { schema, kind: 'lean-task', workspaceRoot: workspace, projectRoot,
    activeProblemPath: path.join(workspace, 'active-problem.json'), baseCommit: gitText(workspace, ['rev-parse', 'HEAD']),
    toolchain: environment.toolchain, environment: environment.id, environmentDigest: environment.dependencyDigest,
    contract: contractFor(inspected.source, inspected.task),
    trustedFiles: Object.keys(sources), solverOwnedFiles: ['Submission.lean', ...Object.keys(library?.files ?? {}).sort()],
    publicObligations: inspected.publicObligations, declarations: inspected.declarations,
    ...(library ? { libraryPack: library } : {}) };
  writeMathJsonDurable(receipt.activeProblemPath, receipt);
  return receipt;
}

/** The initial Git tree and seed message remain authoritative when a receipt is edited. */
export function readLeanTaskReceipt(file: string): LeanTaskReceipt {
  file = path.resolve(file);
  assertRegularFile(file);
  // The receipt repeats the source in its contract beside one declaration record per declaration.
  if (fs.statSync(file).size > 4 * LEAN_TASK_SOURCE_MAX_BYTES) throw new Error('lean_task_receipt_invalid');
  const parsed = receiptSchema.parse(readMathJson(file));
  const workspace = path.dirname(file);
  assertMathCanonicalPath(workspace);
  const projectRoot = path.join(workspace, projectRelative);
  assertMathCanonicalPath(projectRoot);
  assertMathCanonicalPath(path.join(workspace, '.git'));
  if (!fs.lstatSync(path.join(workspace, '.git')).isDirectory() ||
      parsed.workspaceRoot !== workspace || parsed.projectRoot !== projectRoot || parsed.activeProblemPath !== file ||
      file !== path.join(workspace, 'active-problem.json') || gitText(workspace, ['rev-parse', '--show-toplevel']) !== workspace ||
      gitText(workspace, ['rev-list', '--max-parents=0', 'HEAD']) !== parsed.baseCommit)
    throw new Error('lean_task_identity_changed');
  const message = gitText(workspace, ['show', '-s', '--format=%B', parsed.baseCommit]);
  if (!message.startsWith(seedPrefix)) throw new Error('lean_task_seed_invalid');
  const seed = seedSchema.parse(JSON.parse(message.slice(seedPrefix.length)));
  const environment = getLeanTaskEnvironment(seed.environment ?? 'standard');
  // Receipts prepared before environment selection existed retain the exact
  // standard-library inputs; only a seed can opt into a dependency environment.
  const legacy = seed.environment === undefined && seed.environmentDigest === undefined &&
    parsed.environment === undefined && parsed.environmentDigest === undefined;
  if (parsed.toolchain !== environment.toolchain || (!legacy &&
      (seed.environment !== environment.id || parsed.environment !== seed.environment ||
        seed.environmentDigest !== environment.dependencyDigest || parsed.environmentDigest !== seed.environmentDigest)))
    throw new Error('lean_task_environment_changed');
  const libraryFiles = Object.keys(seed.libraryPack?.files ?? {}).sort();
  if (canonicalMathJson(parsed.libraryPack ?? null) !== canonicalMathJson(seed.libraryPack ?? null) ||
      (seed.libraryPack && (!libraryFiles.length || libraryFiles.some(file => !isLibraryPackFile(file)))))
    throw new Error('lean_task_identity_changed');
  const entries = gitText(workspace, ['ls-tree', '-r', '-z', parsed.baseCommit]).split('\0').filter(Boolean);
  const expectedFiles = [...Object.keys(trustedSources('', environment.id)), 'Submission.lean', ...libraryFiles].map(relative => `${projectRelative}/${relative}`).sort();
  const actualFiles = entries.map(entry => {
    const match = /^100644 blob (?:[0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/u.exec(entry);
    if (!match) throw new Error('lean_task_seed_invalid');
    return match[1]!;
  }).sort();
  if (canonicalMathJson(actualFiles) !== canonicalMathJson(expectedFiles)) throw new Error('lean_task_seed_invalid');
  const blobBytes = (relative: string, maxBuffer = LEAN_TASK_SOURCE_MAX_BYTES + 1) => mathGitBytes(workspace,
    ['--no-replace-objects', 'cat-file', 'blob', `${parsed.baseCommit}:${projectRelative}/${relative}`],
    { timeout: 30_000, maxBuffer, errorMessage: 'lean_task_seed_unavailable' });
  const blob = (relative: string) => blobBytes(relative).toString('utf8');
  const source = blob('Challenge.lean');
  if (mathDigest(source) !== seed.sourceHash) throw new Error('lean_task_seed_invalid');
  const inspected = inspectInput({ source, task: seed.task, environment: environment.id });
  const sources = trustedSources(source, environment.id);
  if (canonicalMathJson(parsed.contract) !== canonicalMathJson(contractFor(source, inspected.task)) ||
      canonicalMathJson(parsed.publicObligations) !== canonicalMathJson(inspected.publicObligations) ||
      canonicalMathJson(parsed.declarations) !== canonicalMathJson(inspected.declarations) ||
      canonicalMathJson(parsed.trustedFiles) !== canonicalMathJson(Object.keys(sources)) ||
      canonicalMathJson(parsed.solverOwnedFiles) !== canonicalMathJson(['Submission.lean', ...libraryFiles]) ||
      blob('Submission.lean') !== source ||
      libraryFiles.some(file => mathDigest(blobBytes(file, MAX_LIBRARY_MODULE_BYTES + 1)) !== seed.libraryPack!.files[file]))
    throw new Error('lean_task_identity_changed');
  for (const [relative, contents] of Object.entries(sources)) {
    const target = path.join(projectRoot, relative);
    assertRegularFile(target);
    if (blob(relative) !== contents || fs.readFileSync(target, 'utf8') !== contents)
      throw new Error(`lean_task_protected_file_changed:${relative}`);
  }
  for (const file of ['Submission.lean', ...libraryFiles]) assertRegularFile(path.join(projectRoot, file));
  return parsed as LeanTaskReceipt;
}
