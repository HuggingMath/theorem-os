import path from 'node:path';
import fs from 'node:fs';
import { libraryPackDigest, parseLibraryPack, type LibraryPack } from './libraryPacks';
import { inspectAutoLibrarySource, autoLibraryFile } from './autoLibrary';
import { inspectScopedLeanDeclarations } from './leanSource';
import { z } from 'zod';
import { assertMathCanonicalPath } from './paths';
import { mathDigest, readMathFile, syncMathDirectory } from './mathRuntimeIo';
import { canonicalLibraryJson, libraryUnicodeCompare, parseLibraryJson, validateLibraryRelease,
  type LibraryReleaseArtifacts } from './libraryRelease';
import { effectiveLibraryBindingSchema, libraryTaskPolicySchema, resolveEffectiveLibraryPack, type EffectiveLibraryBinding,
  type EffectiveLibraryPack } from './libraryEffectivePack';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const identitySchema = z.object({ taskId: z.string().min(1).max(512),
  benchmarkCommit: z.string().regex(/^[a-f0-9]{40}$/u).optional() }).strict();
const configSchema = z.object({ schema: z.literal('theorem-os.library-host-config.v1'),
  releaseDirectory: z.string().min(1), manifestSha256: hash, sourceLakeManifest: z.string().min(1),
  autoLibraryDirectory: z.string().min(1).optional(),
  tasks: z.array(identitySchema.extend({ selection: libraryTaskPolicySchema.shape.selection }).strict()).min(1).max(10000),
}).strict();
export type LibraryHostConfig = z.infer<typeof configSchema>;
export type LibraryHostTaskIdentity = z.infer<typeof identitySchema>;
export type LibraryHostTarget = Readonly<{ toolchain: string; lakeManifest: string; runtimeEnvironmentDigest: string }>;

/** This setting belongs to the host process, never task JSON, receipts, or math.env. */
export function libraryHostConfigPath(): string | undefined {
  const value = process.env.THEOREMOS_LIBRARY_HOST_CONFIG;
  if (value !== undefined && (!value.trim() || !path.isAbsolute(value))) throw new Error('library_host_config_path_invalid');
  return value;
}

const packageSchema = z.object({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u), type: z.literal('git'),
  url: z.string().url().startsWith('https://github.com/'), rev: z.string().regex(/^[a-f0-9]{40}$/u),
  subDir: z.null(), configFile: z.enum(['lakefile.lean', 'lakefile.toml']), manifestFile: z.literal('lake-manifest.json'),
  scope: z.string(), inputRev: z.string().min(1), inherited: z.boolean(),
}).strict();
const lockSchema = z.object({ version: z.literal('1.2.0'), packagesDir: z.literal('.lake/packages'),
  lakeDir: z.literal('.lake'), name: z.string().min(1), fixedToolchain: z.boolean().optional(),
  packages: z.array(packageSchema).min(1).max(256),
}).strict();

/** Compare every pinned package. Root names, ordering, input refs and dependency provenance do not affect code identity. */
export function libraryDependencyLockDigest(bytes: Uint8Array): string {
  const lock = lockSchema.parse(parseLibraryJson(bytes));
  if (new Set(lock.packages.map(item => item.name)).size !== lock.packages.length) throw new Error('library_dependency_duplicate');
  const packages = lock.packages.map(({ scope: _scope, inputRev: _inputRev, inherited: _inherited, ...identity }) => identity)
    .sort((a, b) => libraryUnicodeCompare(a.name, b.name));
  return mathDigest(canonicalLibraryJson(packages));
}

function hostFile(file: string, workspace: string, limit: number): Buffer {
  if (!path.isAbsolute(file)) throw new Error('library_host_config_path_invalid');
  assertMathCanonicalPath(file);
  const relative = path.relative(path.resolve(workspace), file);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)))
    throw new Error('library_host_file_in_workspace');
  return readMathFile(file, limit).bytes;
}

/** All configuration paths are absolute and must stay outside the solver workspace. No unmapped fallback. */
export function resolveHostLibrary(task: LibraryHostTaskIdentity, target: LibraryHostTarget, workspace: string,
  configPath = libraryHostConfigPath()): EffectiveLibraryPack | undefined {
  return resolveConfiguredLibrary(task, target, workspace, configPath, false);
}
function resolveConfiguredLibrary(task: LibraryHostTaskIdentity, target: LibraryHostTarget, workspace: string,
  configPath: string | undefined, parentOnly: boolean): EffectiveLibraryPack | undefined {
  if (configPath === undefined) return undefined;
  identitySchema.parse(task);
  const bytes = hostFile(configPath, workspace, 2 * 1024 * 1024);
  const config = configSchema.parse(parseLibraryJson(bytes));
  const keys = config.tasks.map(({ selection: _selection, ...identity }) => canonicalLibraryJson(identity));
  if (new Set(keys).size !== keys.length) throw new Error('library_host_task_duplicate');
  const index = keys.indexOf(canonicalLibraryJson(task));
  const authorization = !parentOnly && config.autoLibraryDirectory && !task.benchmarkCommit
    ? registryFile(config, workspace, 'tasks', path.resolve(workspace)) : undefined;
  const authorizationBytes = authorization ? registryEntryBytes(authorization, workspace) : undefined;
  if (authorizationBytes) {
    const entry = derivedSchema.parse(parseLibraryJson(authorizationBytes));
    if (entry.taskId !== task.taskId || entry.workspace !== path.resolve(workspace)) throw new Error('library_auto_task_changed');
    // Parents must be explicitly mapped: derived authorizations cannot form a recursive chain.
    if (!config.tasks.some(item => item.taskId === entry.parent.taskId && item.benchmarkCommit === entry.parent.benchmarkCommit))
      throw new Error('library_host_task_unmapped');
    const parent = resolveConfiguredLibrary(entry.parent, target, workspace, configPath, true)!;
    if (canonicalLibraryJson(parent.binding) !== canonicalLibraryJson(entry.parentBinding)) throw new Error('library_host_binding_changed');
    return derivedPack(parent, entry);
  }
  if (index < 0) throw new Error('library_host_task_unmapped');
  const limits = { 'pack.json': 40 * 1024 * 1024, 'library.json': 8 * 1024 * 1024,
    'verification.json': 32 * 1024 * 1024, 'declaration-metadata.jsonl': 32 * 1024 * 1024,
    'search-index-manifest.json': 64 * 1024 };
  if (!path.isAbsolute(config.releaseDirectory)) throw new Error('library_host_config_path_invalid');
  const artifacts = Object.fromEntries(Object.entries(limits).map(([name, limit]) =>
    [name, hostFile(path.join(config.releaseDirectory, name), workspace, limit)])) as unknown as LibraryReleaseArtifacts;
  const release = validateLibraryRelease(artifacts, config.manifestSha256);
  const sourceLock = hostFile(config.sourceLakeManifest, workspace, 2 * 1024 * 1024);
  const dependencyLockSha256 = libraryDependencyLockDigest(sourceLock);
  if (mathDigest(sourceLock) !== release.environment.lake_manifest_sha256 ||
      lockSchema.parse(parseLibraryJson(sourceLock)).packages.find(item => item.name === 'mathlib')?.rev !== release.environment.mathlib ||
      target.toolchain !== release.environment.toolchain ||
      dependencyLockSha256 !== libraryDependencyLockDigest(Buffer.from(target.lakeManifest)))
    throw new Error('library_host_dependency_mismatch');
  const effective = resolveEffectiveLibraryPack(artifacts, { schema: 'theorem-os.library-task-policy.v1', taskId: task.taskId,
    manifestSha256: config.manifestSha256, environment: release.environment,
    runtimeEnvironmentDigest: target.runtimeEnvironmentDigest, selection: config.tasks[index]!.selection });
  return { ...effective, binding: { ...effective.binding, hostConfiguration: { sha256: mathDigest(bytes), dependencyLockSha256 } } };
}

/** Re-resolve from the current host setting; a receipt cannot select its own configuration file. */
export function assertHostLibraryCurrent(binding: EffectiveLibraryBinding | undefined, task: LibraryHostTaskIdentity,
  target: LibraryHostTarget, workspace: string): void {
  const effective = resolveHostLibrary(task, target, workspace);
  if ((binding?.hostConfiguration || effective) &&
      canonicalLibraryJson(binding ?? null) !== canonicalLibraryJson(effective?.binding ?? null))
    throw new Error('library_host_binding_changed');
}


const derivedSchema = z.object({ schema: z.literal('theorem-os.auto-library-authorization.v1'),
  taskId: z.string().min(1).max(512), workspace: z.string().min(1), parent: identitySchema,
  parentBinding: effectiveLibraryBindingSchema, pack: z.unknown(), provenanceSha256: hash,
}).strict();

/** The registry is host storage, never mounted in planner/solver workspaces. Entries are immutable. */
function registryFile(config: LibraryHostConfig, workspace: string, kind: 'tasks' | 'records' | 'builds', key: string): string {
  const directory = config.autoLibraryDirectory;
  if (!directory || !path.isAbsolute(directory)) throw new Error('library_auto_registry_required');
  assertMathCanonicalPath(directory);
  for (const [root, child] of [[workspace, directory], [directory, workspace]]) {
    const relative = path.relative(path.resolve(root!), path.resolve(child!));
    if (!relative || relative === '.' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)))
      throw new Error('library_auto_registry_workspace_overlap');
  }
  return path.join(directory, kind, mathDigest(key), 'entry.json');
}
function registryConfig(workspace: string): LibraryHostConfig {
  const configPath = libraryHostConfigPath();
  if (!configPath) throw new Error('library_auto_host_required');
  return configSchema.parse(parseLibraryJson(hostFile(configPath, workspace, 2 * 1024 * 1024)));
}
/** Read valid pre-atomic entries too; two layouts must never disagree about an authorization. */
function registryEntryBytes(file: string, workspace: string): Buffer | undefined {
  const legacy = path.dirname(file) + '.json';
  assertMathCanonicalPath(file); assertMathCanonicalPath(legacy);
  const current = fs.existsSync(file) ? hostFile(file, workspace, 64 * 1024 * 1024) : undefined;
  const previous = fs.existsSync(legacy) ? hostFile(legacy, workspace, 64 * 1024 * 1024) : undefined;
  if (current && previous && !current.equals(previous)) throw new Error('library_auto_authorization_changed');
  return current ?? previous;
}

function writeRegistry(file: string, workspace: string, value: unknown): void {
  assertMathCanonicalPath(file);
  const destination = path.dirname(file), parent = path.dirname(destination), bytes = canonicalLibraryJson(value);
  const compareExisting = () => {
    if (registryEntryBytes(file, workspace)?.toString() !== bytes) throw new Error('library_auto_authorization_changed');
    syncMathDirectory(parent);
  };
  if (registryEntryBytes(file, workspace)) return compareExisting();
  const created = fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (created) {
    for (let directory = parent; ; directory = path.dirname(directory)) {
      syncMathDirectory(directory);
      if (directory === path.dirname(created)) break;
    }
  }
  const temporary = fs.mkdtempSync(path.join(parent, '.pending-'));
  try {
    const descriptor = fs.openSync(path.join(temporary, 'entry.json'), 'wx', 0o400);
    try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    syncMathDirectory(temporary);
    if (registryEntryBytes(file, workspace)) return compareExisting();
    // Renaming a complete nonempty directory is atomic and cannot replace another nonempty entry.
    // Readers always see a single-link regular file; interrupted staging directories are never selected.
    try { fs.renameSync(temporary, destination); }
    catch (cause) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((cause as NodeJS.ErrnoException).code ?? '')) throw cause;
      compareExisting();
    }
    compareExisting();
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

function derivedPack(parent: EffectiveLibraryPack, entry: z.infer<typeof derivedSchema>): EffectiveLibraryPack {
  const pack = entry.pack === null ? null : parseLibraryPack(entry.pack);
  validateAutoComposition(parent, pack);
  const modules = (pack?.modules ?? []).map(item => ({ file: item.file, module: item.file.slice(0, -5).replaceAll('/', '.'),
    sha256: mathDigest(item.source) })).sort((a, b) => libraryUnicodeCompare(a.file, b.file));
  const declarations = (pack?.modules ?? []).flatMap(item => inspectScopedLeanDeclarations(item.source)
    .map(declaration => ({ name: declaration.qualifiedName, module: item.file.slice(0, -5).replaceAll('/', '.') })));
  return { pack, modules, declarations: parent.declarations.filter(item => modules.some(module => module.file === item.installed_file)),
    binding: { ...parent.binding, taskId: entry.taskId, effectivePackDigest: pack ? libraryPackDigest(pack) : mathDigest('null'),
      moduleSetSha256: mathDigest(canonicalLibraryJson(modules)), declarationSetSha256: mathDigest(canonicalLibraryJson(declarations)),
      autoComposition: { parentTaskId: entry.parent.taskId, parentBindingSha256: mathDigest(canonicalLibraryJson(parent.binding)),
        provenanceSha256: entry.provenanceSha256 } } };
}

function validateAutoComposition(parent: EffectiveLibraryPack, pack: LibraryPack | null): void {
  if (pack?.requires?.length) throw new Error('library_auto_external_requirement');
  const originals = new Map((parent.pack?.modules ?? []).map(item => [item.file, item]));
  const libraryModules = new Set((pack?.modules ?? []).map(item => item.file.slice(0, -5).replaceAll('/', '.')));
  for (const item of pack?.modules ?? []) {
    const original = originals.get(item.file);
    if (original) {
      if (canonicalLibraryJson(original) !== canonicalLibraryJson(item)) throw new Error('library_auto_base_changed');
    } else {
      const name = path.basename(item.file, '.lean');
      if (item.file !== autoLibraryFile(name) || item.origin.kind !== 'run' ||
          inspectAutoLibrarySource({ name, source: item.source, libraryModules, allowSorry: false }).length)
        throw new Error('library_auto_addition_invalid');
    }
  }
}

/** Host-only: freeze the exact child pack after the Auto composition gates, never from task input. */
export function authorizeHostAutoTask(input: { parent: LibraryHostTaskIdentity; binding: EffectiveLibraryBinding;
  target: LibraryHostTarget; workspace: string; taskId: string; pack?: LibraryPack; provenance: unknown }): void {
  const parent = resolveConfiguredLibrary(input.parent, input.target, input.workspace, libraryHostConfigPath(), true);
  if (!parent || canonicalLibraryJson(parent.binding) !== canonicalLibraryJson(input.binding)) throw new Error('library_host_binding_changed');
  const config = registryConfig(input.workspace);
  if (input.taskId !== input.parent.taskId && config.tasks.some(item => item.taskId === input.taskId && !item.benchmarkCommit)) throw new Error('library_auto_task_mapping_conflict');
  const entry = derivedSchema.parse({ schema: 'theorem-os.auto-library-authorization.v1', taskId: input.taskId,
    workspace: path.resolve(input.workspace), parent: input.parent, parentBinding: input.binding,
    pack: input.pack ? parseLibraryPack(input.pack) : null, provenanceSha256: mathDigest(canonicalLibraryJson(input.provenance)) });
  validateAutoComposition(parent, entry.pack === null ? null : parseLibraryPack(entry.pack));
  writeRegistry(registryFile(config, input.workspace, 'tasks', entry.workspace), input.workspace, entry);
}

/** Authenticate host-created build requests and verified pool records independently of editable JSON copies. */
export function hostAutoEvidence(kind: 'records' | 'builds', key: string, value: unknown, workspace: string, write = false): boolean {
  const file = registryFile(registryConfig(workspace), workspace, kind, key);
  if (write) writeRegistry(file, workspace, value);
  return registryEntryBytes(file, workspace)?.toString() === canonicalLibraryJson(value);
}
